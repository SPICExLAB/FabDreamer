"""
SVG Conversion Utilities

Converts PNG masks to SVG paths.
Replaces autotrace CLI dependency.
"""

import io
import logging
from typing import Optional, List, Tuple
import numpy as np
from PIL import Image
import cv2

logger = logging.getLogger(__name__)

# Single source of truth for cut-line generation parameters.
# All call sites should rely on these defaults so every segment's outline
# is produced with identical settings (tools/cutline_harness.py measures them).
DEFAULT_SIMPLIFY_TOLERANCE = 1.5
DEFAULT_MIN_HOLE_AREA_RATIO = 0.00005       # only dust-sized pinholes are filled —
                                            # real design holes (railing gaps etc.) must survive
DEFAULT_MIN_COMPONENT_AREA_RATIO = 0.00005  # dust below 0.005% of image area is dropped
_MIN_AREA_FLOOR_PX = 48                     # absolute floor for both filters, in pixels
DEFAULT_SMOOTH_ITERATIONS = 2               # Chaikin corner-cutting passes
_MORPH_KERNEL = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))


def _clean_binary_mask(
    binary: np.ndarray,
    min_component_area_ratio: float,
    min_hole_area_ratio: float,
) -> np.ndarray:
    """Denoise a binary mask before contour extraction.

    Morphological open+close kills 1-2px speckles and seals hairline cracks,
    then connected-component filtering drops sub-threshold fragments (always
    keeping the largest so an element never vanishes entirely) and fills
    sub-threshold holes. Fully deterministic.
    """
    h, w = binary.shape
    image_area = h * w

    original_fg = cv2.countNonZero(binary)
    cleaned = cv2.morphologyEx(binary, cv2.MORPH_OPEN, _MORPH_KERNEL)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, _MORPH_KERNEL)
    # Thin shapes can be mostly erased by the opening — degrade gracefully:
    # first to close-only, then to the raw mask (filtering below still applies).
    if original_fg > 0 and cv2.countNonZero(cleaned) < 0.5 * original_fg:
        cleaned = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, _MORPH_KERNEL)
        if cv2.countNonZero(cleaned) < 0.5 * original_fg:
            cleaned = binary.copy()

    # Drop dust-sized foreground fragments (keep the largest unconditionally).
    # The threshold targets speckle noise only — legitimate small design pieces
    # survive; Stage 3's floating-part detection is responsible for those.
    num, labels, stats, _ = cv2.connectedComponentsWithStats(cleaned, connectivity=8)
    if num > 2:
        min_component_area = max(_MIN_AREA_FLOOR_PX,
                                 image_area * min_component_area_ratio)
        areas = stats[1:, cv2.CC_STAT_AREA]
        keep = areas >= min_component_area
        keep[int(np.argmax(areas))] = True
        keep_full = np.concatenate([[False], keep])
        cleaned = np.where(keep_full[labels], 255, 0).astype(np.uint8)

    # Fill dust-sized holes: background components that don't touch the image
    # border. The threshold must stay small — larger holes are design intent
    # (e.g. gaps between bridge railings) and must remain cut paths.
    min_hole_area = max(_MIN_AREA_FLOOR_PX, image_area * min_hole_area_ratio)
    inv = (cleaned == 0).astype(np.uint8)
    num_bg, labels_bg, stats_bg, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    for i in range(1, num_bg):
        x, y, bw, bh, area = (int(stats_bg[i, j]) for j in range(5))
        touches_border = x == 0 or y == 0 or x + bw >= w or y + bh >= h
        if not touches_border and area < min_hole_area:
            cleaned[labels_bg == i] = 255

    return cleaned


def _chaikin_smooth(points: np.ndarray, iterations: int) -> np.ndarray:
    """Chaikin corner-cutting for closed polygons — removes pixel staircase."""
    pts = points.astype(np.float32)
    for _ in range(iterations):
        rolled = np.roll(pts, -1, axis=0)
        q = 0.75 * pts + 0.25 * rolled
        r = 0.25 * pts + 0.75 * rolled
        merged = np.empty((len(pts) * 2, 2), dtype=np.float32)
        merged[0::2] = q
        merged[1::2] = r
        pts = merged
    return pts


def _binary_to_svg(
    binary: np.ndarray,
    width: int,
    height: int,
    simplify_tolerance: float,
    smooth_iterations: int = DEFAULT_SMOOTH_ITERATIONS,
) -> str:
    """Shared contour→SVG core: smooth, simplify, emit evenodd fill paths."""
    contours, hierarchy = cv2.findContours(binary, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        logger.warning("No contours found in mask")
        return _empty_svg(width, height)

    simplified_contours = []
    valid_indices = []
    for i, contour in enumerate(contours):
        pts = contour.reshape(-1, 2).astype(np.float32)
        if len(pts) >= 3 and smooth_iterations > 0:
            pts = _chaikin_smooth(pts, smooth_iterations)
        simplified = cv2.approxPolyDP(pts.reshape(-1, 1, 2), simplify_tolerance, True)
        if len(simplified) >= 3:
            simplified_contours.append(np.rint(simplified).astype(np.int32))
            valid_indices.append(i)

    remapped_hierarchy = _remap_hierarchy(hierarchy, valid_indices)
    return _generate_svg(simplified_contours, width, height, remapped_hierarchy)


def png_to_svg(
    image_data: bytes,
    simplify_tolerance: float = DEFAULT_SIMPLIFY_TOLERANCE,
    background_color: Tuple[int, int, int] = (0, 255, 0),
    bg_tolerance: int = 40,
    min_hole_area_ratio: float = DEFAULT_MIN_HOLE_AREA_RATIO,
    min_component_area_ratio: float = DEFAULT_MIN_COMPONENT_AREA_RATIO,
    smooth_iterations: int = DEFAULT_SMOOTH_ITERATIONS,
) -> str:
    """Convert an extracted-entity PNG to an SVG cut outline.

    Prefers the alpha channel when present (exact), otherwise removes the
    background color by Euclidean RGB distance — much more stable on
    anti-aliased edges than per-channel comparison.

    Args:
        image_data: PNG image bytes (entity on colored background or RGBA)
        simplify_tolerance: Douglas-Peucker simplification tolerance
        background_color: RGB tuple of background color to remove
        bg_tolerance: Euclidean RGB distance below which a pixel is background
        min_hole_area_ratio: holes smaller than this fraction of image area are filled
        min_component_area_ratio: fragments smaller than this fraction are dropped
        smooth_iterations: Chaikin smoothing passes (0 disables)

    Returns:
        SVG string
    """
    image = Image.open(io.BytesIO(image_data)).convert('RGBA')
    img_array = np.array(image)
    width, height = image.size

    alpha = img_array[:, :, 3]
    if int(alpha.min()) < 250:
        # Meaningful alpha channel — use it directly
        binary = ((alpha > 128) * 255).astype(np.uint8)
    else:
        rgb = img_array[:, :, :3].astype(np.float32)
        bg = np.array(background_color, dtype=np.float32)
        dist = np.linalg.norm(rgb - bg, axis=2)
        binary = ((dist > bg_tolerance) * 255).astype(np.uint8)

    cleaned = _clean_binary_mask(binary, min_component_area_ratio, min_hole_area_ratio)
    if cv2.countNonZero(cleaned) == 0:
        logger.warning("No foreground found in image")
        return _empty_svg(width, height)

    return _binary_to_svg(cleaned, width, height, simplify_tolerance, smooth_iterations)


def mask_to_svg(
    mask_data: bytes,
    simplify_tolerance: float = DEFAULT_SIMPLIFY_TOLERANCE,
    min_hole_area_ratio: float = DEFAULT_MIN_HOLE_AREA_RATIO,
    min_component_area_ratio: float = DEFAULT_MIN_COMPONENT_AREA_RATIO,
    smooth_iterations: int = DEFAULT_SMOOTH_ITERATIONS,
) -> str:
    """Convert binary mask to SVG cut outline.

    The mask is denoised first (morphology + fragment/hole filtering in
    _clean_binary_mask) so SAM2 speckle never becomes a cut path, then the
    contours are Chaikin-smoothed and simplified.

    Args:
        mask_data: Binary mask PNG bytes (white = shape)
        simplify_tolerance: Douglas-Peucker simplification tolerance
        min_hole_area_ratio: holes smaller than this fraction of image area are filled
        min_component_area_ratio: fragments smaller than this fraction are dropped
            (the largest fragment is always kept)
        smooth_iterations: Chaikin smoothing passes (0 disables)

    Returns:
        SVG string
    """
    mask = Image.open(io.BytesIO(mask_data)).convert('L')
    mask_array = np.array(mask)
    height, width = mask_array.shape

    _, binary = cv2.threshold(mask_array, 127, 255, cv2.THRESH_BINARY)

    cleaned = _clean_binary_mask(binary, min_component_area_ratio, min_hole_area_ratio)
    if cv2.countNonZero(cleaned) == 0:
        logger.warning("No foreground found in mask")
        return _empty_svg(width, height)

    return _binary_to_svg(cleaned, width, height, simplify_tolerance, smooth_iterations)


def _remap_hierarchy(hierarchy: Optional[np.ndarray], valid_indices: List[int]) -> Optional[np.ndarray]:
    """Remap hierarchy indices after filtering contours.

    Args:
        hierarchy: Original cv2 hierarchy [next, prev, child, parent]
        valid_indices: List of original indices that were kept

    Returns:
        Remapped hierarchy with updated indices
    """
    if hierarchy is None or len(valid_indices) == 0:
        return None

    # Create mapping from old index to new index
    old_to_new = {old_idx: new_idx for new_idx, old_idx in enumerate(valid_indices)}

    # Create new hierarchy array
    new_hierarchy = np.zeros((1, len(valid_indices), 4), dtype=np.int32)

    for new_idx, old_idx in enumerate(valid_indices):
        old_h = hierarchy[0][old_idx]
        # Remap each hierarchy value (next, prev, child, parent)
        new_h = [-1, -1, -1, -1]
        for j, val in enumerate(old_h):
            if val in old_to_new:
                new_h[j] = old_to_new[val]
            # else stays -1 (no valid mapping)
        new_hierarchy[0][new_idx] = new_h

    return new_hierarchy


def _generate_svg(
    contours: List[np.ndarray],
    width: int,
    height: int,
    hierarchy: Optional[np.ndarray] = None
) -> str:
    """Generate SVG from contours with proper hole handling.

    Uses cv2 hierarchy to identify outer contours and their holes.
    Combines them into single paths with fill-rule="evenodd" for proper cutouts.

    Hierarchy structure: [Next, Previous, First_Child, Parent]
    - Parent == -1 means top-level (outer) contour
    - Parent >= 0 means hole inside that parent contour

    Args:
        contours: List of contour arrays
        width: Image width
        height: Image height
        hierarchy: Contour hierarchy from cv2.findContours

    Returns:
        SVG string
    """
    # SVG header
    svg_parts = [
        f'<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">',
    ]

    if hierarchy is None or len(contours) == 0:
        # No hierarchy info - just output all contours as separate paths
        for contour in contours:
            path_d = _contour_to_path(contour)
            if path_d:
                svg_parts.append(
                    f'  <path d="{path_d}" fill="white" stroke="none"/>'
                )
    else:
        # Use hierarchy to properly handle holes
        # hierarchy[0][i] = [next, prev, child, parent]
        h = hierarchy[0]

        # Find all outer contours (parent == -1)
        outer_indices = [i for i in range(len(contours)) if h[i][3] == -1]

        for outer_idx in outer_indices:
            # Start with outer contour path
            outer_path = _contour_to_path(contours[outer_idx])
            if not outer_path:
                continue

            # Find all direct children (holes) of this outer contour
            hole_paths = []
            child_idx = h[outer_idx][2]  # First child index

            while child_idx != -1:
                child_contour = contours[child_idx]
                child_path = _contour_to_path(child_contour)
                if child_path:
                    hole_paths.append(child_path)
                child_idx = h[child_idx][0]  # Next sibling

            # Combine outer path with hole paths using fill-rule="evenodd"
            # With evenodd, overlapping regions toggle fill state
            if hole_paths:
                combined_path = outer_path + " " + " ".join(hole_paths)
                svg_parts.append(
                    f'  <path d="{combined_path}" fill="white" stroke="none" fill-rule="evenodd"/>'
                )
            else:
                svg_parts.append(
                    f'  <path d="{outer_path}" fill="white" stroke="none"/>'
                )

    svg_parts.append('</svg>')

    return '\n'.join(svg_parts)


def _contour_to_path(contour: np.ndarray) -> str:
    """Convert OpenCV contour to SVG path data.

    Args:
        contour: OpenCV contour array

    Returns:
        SVG path d attribute string
    """
    if len(contour) < 3:
        return ""

    # Flatten contour points
    points = contour.reshape(-1, 2)

    # Start path
    path_parts = [f"M {points[0][0]},{points[0][1]}"]

    # Add line segments
    for point in points[1:]:
        path_parts.append(f"L {point[0]},{point[1]}")

    # Close path
    path_parts.append("Z")

    return " ".join(path_parts)


def _empty_svg(width: int, height: int) -> str:
    """Generate empty SVG placeholder."""
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <!-- No contours found -->
</svg>'''


def svg_to_png(svg_content: str, output_path: Optional[str] = None) -> bytes:
    """Convert SVG to PNG.

    Args:
        svg_content: SVG string
        output_path: Optional path to save PNG

    Returns:
        PNG bytes
    """
    try:
        import cairosvg

        png_data = cairosvg.svg2png(bytestring=svg_content.encode('utf-8'))

        if output_path:
            with open(output_path, 'wb') as f:
                f.write(png_data)

        return png_data
    except ImportError:
        logger.error("cairosvg not installed, cannot convert SVG to PNG")
        raise
    except Exception as e:
        logger.error(f"SVG to PNG conversion failed: {e}")
        raise


def extracted_to_trace_svg(
    extracted_data: bytes,
    simplify_tolerance: float = 1.5,
    canny_low: int = 50,
    canny_high: int = 150,
    min_contour_points: int = 10
) -> str:
    """Convert extracted PNG to trace SVG using Canny edge detection.

    This traces internal details (like duck eye outlines) as black stroke paths
    for laser engraving in "trace" mode.

    Args:
        extracted_data: Extracted PNG bytes (with transparency)
        simplify_tolerance: Douglas-Peucker simplification tolerance
        canny_low: Canny edge detection low threshold
        canny_high: Canny edge detection high threshold
        min_contour_points: Minimum points for a valid contour

    Returns:
        SVG string with black stroke paths for internal details
    """
    # Load image with alpha channel
    image = Image.open(io.BytesIO(extracted_data)).convert('RGBA')
    img_array = np.array(image)
    height, width = img_array.shape[:2]

    # Create mask from alpha channel (non-transparent areas)
    alpha = img_array[:, :, 3]
    mask = (alpha > 128).astype(np.uint8) * 255

    # Convert to grayscale for edge detection
    rgb = img_array[:, :, :3]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

    # Apply Canny edge detection
    edges = cv2.Canny(gray, canny_low, canny_high)

    # Mask edges to only include non-transparent areas
    edges = cv2.bitwise_and(edges, edges, mask=mask)

    # Find contours of the edges
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

    if not contours:
        logger.warning("No internal edges found in extracted image")
        return _empty_svg(width, height)

    # SVG header
    svg_parts = [
        f'<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">',
    ]

    # Add paths for each edge contour
    valid_contours = 0
    for contour in contours:
        if len(contour) < min_contour_points:
            continue

        # Simplify contour
        simplified = cv2.approxPolyDP(contour, simplify_tolerance, False)
        if len(simplified) < 3:
            continue

        path_d = _contour_to_path_open(simplified)
        if path_d:
            # Black stroke for engrave lines (no fill)
            svg_parts.append(
                f'  <path d="{path_d}" fill="none" stroke="black" stroke-width="1"/>'
            )
            valid_contours += 1

    svg_parts.append('</svg>')

    logger.info(f"Generated trace SVG with {valid_contours} edge contours")
    return '\n'.join(svg_parts)


def _contour_to_path_open(contour: np.ndarray) -> str:
    """Convert OpenCV contour to SVG path data (open path, not closed).

    Args:
        contour: OpenCV contour array

    Returns:
        SVG path d attribute string (without Z to keep path open)
    """
    if len(contour) < 2:
        return ""

    # Flatten contour points
    points = contour.reshape(-1, 2)

    # Start path
    path_parts = [f"M {points[0][0]},{points[0][1]}"]

    # Add line segments
    for point in points[1:]:
        path_parts.append(f"L {point[0]},{point[1]}")

    # Don't close path (no Z) - keeps it as a stroke line
    return " ".join(path_parts)


def optimize_svg(svg_content: str) -> str:
    """Optimize SVG by removing unnecessary whitespace and attributes.

    Args:
        svg_content: Original SVG string

    Returns:
        Optimized SVG string
    """
    import re

    # Remove comments
    svg_content = re.sub(r'<!--.*?-->', '', svg_content, flags=re.DOTALL)

    # Remove extra whitespace
    svg_content = re.sub(r'\s+', ' ', svg_content)
    svg_content = re.sub(r'>\s+<', '><', svg_content)

    # Remove empty groups
    svg_content = re.sub(r'<g\s*>\s*</g>', '', svg_content)

    return svg_content.strip()
