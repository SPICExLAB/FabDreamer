"""
Geometry Analyzer for Fabrication

Analyzes SVG paths to detect:
- Floating/isolated parts (not connected to boundary)
- Thin areas that may break
- Connectivity between parts

Uses shapely for polygon operations and svgpathtools for SVG parsing.
"""

import logging
import re
import math
from typing import List, Dict, Any, Tuple, Optional, Set
from dataclasses import dataclass, field
from enum import Enum

import numpy as np
from shapely.geometry import Polygon, MultiPolygon, LineString, Point, box
from shapely.ops import unary_union
from shapely.validation import make_valid

logger = logging.getLogger(__name__)


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class PartGeometry:
    """Represents a part's geometry for analysis."""
    part_id: str
    name: str
    polygon: Optional[Polygon] = None
    multi_polygon: Optional[MultiPolygon] = None
    bbox: Tuple[float, float, float, float] = (
        0, 0, 0, 0)  # minx, miny, maxx, maxy
    area: float = 0.0
    is_valid: bool = False
    parse_error: Optional[str] = None


@dataclass
class ConnectivityResult:
    """Result of connectivity analysis for a part."""
    part_id: str
    part_name: str
    is_floating: bool
    is_connected_to_boundary: bool
    connected_to_parts: List[str] = field(default_factory=list)
    nearest_anchor: Optional[str] = None  # "boundary" or part_id
    distance_to_nearest: float = 0.0
    recommended_fix: str = "none"  # "add_bridge", "add_tabs", "none"
    fix_points: List[Tuple[float, float]] = field(
        default_factory=list)  # Points where bridges could connect


@dataclass
class BridgeSpec:
    """Specification for a connecting bridge."""
    from_part_id: str
    to_part_id: str  # or "boundary"
    from_point: Tuple[float, float]
    to_point: Tuple[float, float]
    width_mm: float
    bridge_polygon: Optional[Polygon] = None


class IssueType(Enum):
    FLOATING = "floating"
    THIN_AREA = "thin_area"
    WEAK_CONNECTION = "weak_connection"
    DISCONNECTED = "disconnected"


@dataclass
class FabricationIssue:
    """A fabrication issue detected in the design."""
    issue_type: IssueType
    severity: str  # "error", "warning", "info"
    part_id: str
    part_name: str
    message: str
    details: Dict[str, Any] = field(default_factory=dict)
    suggested_fixes: List[str] = field(default_factory=list)


# =============================================================================
# Segment Transform
# =============================================================================

def apply_segment_transform(
    geom,
    segment: Dict[str, Any],
    editing_width: float,
    editing_height: float,
    canvas_size: float = 1024,
):
    """
    Apply a segment's user transform (drag/scale/rotate) to a Shapely geometry.

    Frontend segments store:
      - svg paths in the original 1024-coord position
      - x, y in editing-canvas coords
      - scaleX, scaleY = defaultScale * userScale
      - originalX/Y/Width/Height in 1024 coords
      - rotation in degrees

    This function reproduces the same affine transform that
    ``buildSvgTransformString`` (Frontend/src/utils/transformUtils.js) applies,
    but on Shapely geometries so the backend analysis sees the correct layout.
    """
    from shapely.affinity import translate, scale, rotate as shapely_rotate

    orig_x = segment.get("originalX", 0)
    orig_y = segment.get("originalY", 0)
    orig_w = segment.get("originalWidth", 0)
    orig_h = segment.get("originalHeight", 0)
    seg_x = segment.get("x", 0)
    seg_y = segment.get("y", 0)
    seg_scale_x = segment.get("scaleX")
    seg_scale_y = segment.get("scaleY")
    seg_rotation = segment.get("rotation", 0)

    default_scale_x = editing_width / canvas_size if editing_width > 0 else 1
    default_scale_y = editing_height / canvas_size if editing_height > 0 else 1

    if seg_scale_x is None:
        seg_scale_x = default_scale_x
    if seg_scale_y is None:
        seg_scale_y = default_scale_y

    user_scale_x = seg_scale_x / default_scale_x if default_scale_x else 1
    user_scale_y = seg_scale_y / default_scale_y if default_scale_y else 1

    current_x = seg_x / default_scale_x  # position in 1024 coords
    current_y = seg_y / default_scale_y

    orig_cx = orig_x + orig_w / 2
    orig_cy = orig_y + orig_h / 2

    has_user_scale = abs(user_scale_x - 1) > 0.001 or abs(user_scale_y - 1) > 0.001

    if seg_rotation != 0 or has_user_scale:
        if has_user_scale:
            geom = scale(geom, xfact=user_scale_x, yfact=user_scale_y,
                         origin=(orig_cx, orig_cy))
        if seg_rotation != 0:
            geom = shapely_rotate(geom, seg_rotation, origin=(orig_cx, orig_cy))

        rad = math.radians(seg_rotation)
        cos_r = math.cos(rad)
        sin_r = math.sin(rad)
        dx = orig_x - orig_cx
        dy = orig_y - orig_cy
        scaled_dx = dx * user_scale_x
        scaled_dy = dy * user_scale_y
        transformed_corner_x = orig_cx + scaled_dx * cos_r - scaled_dy * sin_r
        transformed_corner_y = orig_cy + scaled_dx * sin_r + scaled_dy * cos_r

        tx = current_x - transformed_corner_x
        ty = current_y - transformed_corner_y
        geom = translate(geom, xoff=tx, yoff=ty)
    else:
        delta_x = current_x - orig_x
        delta_y = current_y - orig_y
        if abs(delta_x) > 0.001 or abs(delta_y) > 0.001:
            geom = translate(geom, xoff=delta_x, yoff=delta_y)

    return geom


# =============================================================================
# SVG Path Parsing
# =============================================================================

def _split_subpaths(d: str) -> List[str]:
    """Split a multi-subpath SVG path ``d`` into individual subpath strings.

    E.g., ``"M 0,0 L 10,0 Z M 2,2 L 8,2 Z"`` →
    ``["M 0,0 L 10,0 Z", "M 2,2 L 8,2 Z"]``
    """
    if not d:
        return []
    # Split on 'M'/'m' while keeping the delimiter
    parts = re.split(r'(?=[Mm])', d)
    return [p.strip() for p in parts if p.strip()]


def _subpaths_to_polygons_with_holes(subpath_polys: List[Polygon]) -> List[Polygon]:
    """Detect containment among polygons and construct Polygons with holes.

    If a smaller polygon is fully contained within a larger one, treat the
    smaller polygon as a hole of the larger one.  Uncontained polygons are
    returned as-is.
    """
    if len(subpath_polys) <= 1:
        return subpath_polys

    # Sort by area descending — larger polygons first
    sorted_polys = sorted(subpath_polys, key=lambda p: p.area, reverse=True)
    used_as_hole = set()
    result = []

    for i, outer in enumerate(sorted_polys):
        if i in used_as_hole:
            continue
        holes = []
        for j in range(i + 1, len(sorted_polys)):
            if j in used_as_hole:
                continue
            inner = sorted_polys[j]
            if outer.contains(inner):
                holes.append(inner.exterior.coords)
                used_as_hole.add(j)
        if holes:
            poly = Polygon(outer.exterior.coords, holes)
            if not poly.is_valid:
                poly = make_valid(poly)
            result.append(poly)
        else:
            result.append(outer)

    # Add any polygons that weren't used as holes and weren't processed as outers
    for j in range(len(sorted_polys)):
        if j not in used_as_hole and sorted_polys[j] not in result:
            result.append(sorted_polys[j])

    return result


def parse_svg_to_polygons(svg_string: str) -> List[Polygon]:
    """
    Parse SVG string and extract all path polygons.

    Handles:
    - M/L/Z path commands (move, line, close)
    - Multiple paths in one SVG
    - Multi-subpath paths with hole detection (M...Z M...Z)
    - Bezier curves (approximated as line segments)

    Args:
        svg_string: SVG content as string

    Returns:
        List of Shapely Polygon objects (with holes where detected)
    """
    if not svg_string or not svg_string.strip():
        return []

    polygons = []

    try:
        from svgpathtools import parse_path
        from xml.etree import ElementTree as ET

        try:
            root = ET.fromstring(svg_string)
        except ET.ParseError as e:
            logger.warning(f"SVG parse error: {e}")
            return _parse_simple_svg_paths(svg_string)

        namespaces = {'svg': 'http://www.w3.org/2000/svg'}
        path_elements = root.findall(
            './/path', namespaces) or root.findall('.//path')
        if not path_elements:
            path_elements = root.findall('.//{http://www.w3.org/2000/svg}path')

        for path_elem in path_elements:
            d = path_elem.get('d')
            if not d:
                continue

            # Split into subpaths and parse each independently
            subpaths = _split_subpaths(d)
            subpath_polys = []

            for sub_d in subpaths:
                poly = None
                try:
                    path = parse_path(sub_d)
                    points = _path_to_points(path, num_samples=50)
                    if len(points) >= 3:
                        poly = Polygon(points)
                except Exception:
                    # Fallback to simple parser for this subpath
                    points = _parse_simple_path(sub_d)
                    if len(points) >= 3:
                        poly = Polygon(points)

                if poly is not None:
                    if not poly.is_valid:
                        poly = make_valid(poly)
                    if poly.area > 0:
                        subpath_polys.append(poly)

            # Detect holes (smaller contained polygons) and build proper Polygons
            if subpath_polys:
                result_polys = _subpaths_to_polygons_with_holes(subpath_polys)
                polygons.extend(result_polys)

    except ImportError:
        logger.warning("svgpathtools not available, using simple parser")
        return _parse_simple_svg_paths(svg_string)
    except Exception as e:
        logger.warning(f"SVG parsing error: {e}, using simple parser")
        return _parse_simple_svg_paths(svg_string)

    return polygons


def _path_to_points(path, num_samples: int = 50) -> List[Tuple[float, float]]:
    """Convert svgpathtools Path to list of points."""
    points = []

    if len(path) == 0:
        return points

    # Sample points along the path
    for i in range(num_samples):
        t = i / num_samples
        try:
            point = path.point(t)
            points.append((point.real, point.imag))
        except:
            pass

    return points


def _parse_simple_svg_paths(svg_string: str) -> List[Polygon]:
    """Simple regex-based SVG path parser for M/L/Z commands."""
    polygons = []

    # Find all path d attributes
    d_pattern = r'd="([^"]+)"'
    matches = re.findall(d_pattern, svg_string)

    for d in matches:
        subpaths = _split_subpaths(d)
        subpath_polys = []
        for sub_d in subpaths:
            points = _parse_simple_path(sub_d)
            if len(points) >= 3:
                try:
                    poly = Polygon(points)
                    if not poly.is_valid:
                        poly = make_valid(poly)
                    if poly.area > 0:
                        subpath_polys.append(poly)
                except:
                    pass
        if subpath_polys:
            polygons.extend(_subpaths_to_polygons_with_holes(subpath_polys))

    return polygons


def _parse_simple_path(d: str) -> List[Tuple[float, float]]:
    """Parse simple SVG path (M, L, Z commands only)."""
    points = []

    # Normalize path string
    d = d.replace(',', ' ')
    d = re.sub(r'([MLZHVCSQTAmlzhvcsqta])', r' \1 ', d)
    tokens = d.split()

    current_x, current_y = 0.0, 0.0
    start_x, start_y = 0.0, 0.0
    i = 0

    while i < len(tokens):
        cmd = tokens[i]

        if cmd in ('M', 'm'):  # Move
            relative = cmd == 'm'
            i += 1
            while i < len(tokens) and tokens[i] not in 'MLZHVCSQTAmlzhvcsqta':
                try:
                    x = float(tokens[i])
                    y = float(tokens[i + 1]) if i + 1 < len(tokens) else 0
                    if relative:
                        x += current_x
                        y += current_y
                    current_x, current_y = x, y
                    start_x, start_y = x, y
                    points.append((x, y))
                    i += 2
                except (ValueError, IndexError):
                    i += 1

        elif cmd in ('L', 'l'):  # Line
            relative = cmd == 'l'
            i += 1
            while i < len(tokens) and tokens[i] not in 'MLZHVCSQTAmlzhvcsqta':
                try:
                    x = float(tokens[i])
                    y = float(tokens[i + 1]) if i + 1 < len(tokens) else 0
                    if relative:
                        x += current_x
                        y += current_y
                    current_x, current_y = x, y
                    points.append((x, y))
                    i += 2
                except (ValueError, IndexError):
                    i += 1

        elif cmd in ('H', 'h'):  # Horizontal line
            relative = cmd == 'h'
            i += 1
            try:
                x = float(tokens[i])
                if relative:
                    x += current_x
                current_x = x
                points.append((current_x, current_y))
                i += 1
            except (ValueError, IndexError):
                i += 1

        elif cmd in ('V', 'v'):  # Vertical line
            relative = cmd == 'v'
            i += 1
            try:
                y = float(tokens[i])
                if relative:
                    y += current_y
                current_y = y
                points.append((current_x, current_y))
                i += 1
            except (ValueError, IndexError):
                i += 1

        elif cmd in ('Z', 'z'):  # Close path
            if points and (start_x, start_y) != points[-1]:
                points.append((start_x, start_y))
            i += 1

        else:
            # Skip unknown commands
            i += 1

    return points


# =============================================================================
# Connectivity Analysis
# =============================================================================

class ConnectivityAnalyzer:
    """Analyzes connectivity between parts in a layer."""

    def __init__(self, canvas_width: float = 1024, canvas_height: float = 1024):
        self.canvas_width = canvas_width
        self.canvas_height = canvas_height
        self.parts: Dict[str, PartGeometry] = {}
        self.boundary_polygon: Optional[Polygon] = None

    def add_part(
        self,
        part_id: str,
        name: str,
        svg: str,
        bbox: List[float] = None,
        segment: Dict[str, Any] = None,
        editing_width: float = 0,
        editing_height: float = 0,
    ):
        """Add a part to the analyzer.

        If *segment* and editing dimensions are provided, the parsed polygons
        are transformed from the segment's local SVG position to their actual
        canvas position using the segment's drag/scale/rotation data.
        """
        polygons = parse_svg_to_polygons(svg)

        if not polygons:
            self.parts[part_id] = PartGeometry(
                part_id=part_id,
                name=name,
                is_valid=False,
                parse_error="No valid polygons found in SVG"
            )
            return

        # Apply segment transform if editing dimensions are available.
        # Skip for segments that already have world-space coords (e.g. frame-union).
        if segment and editing_width > 0 and editing_height > 0 and not segment.get("skipTransform"):
            polygons = [
                apply_segment_transform(p, segment, editing_width, editing_height)
                for p in polygons
            ]

        # Combine all polygons into one
        if len(polygons) == 1:
            combined = polygons[0]
        else:
            combined = unary_union(polygons)

        if isinstance(combined, MultiPolygon):
            geom = PartGeometry(
                part_id=part_id,
                name=name,
                multi_polygon=combined,
                bbox=combined.bounds,
                area=combined.area,
                is_valid=True
            )
        else:
            geom = PartGeometry(
                part_id=part_id,
                name=name,
                polygon=combined,
                bbox=combined.bounds,
                area=combined.area,
                is_valid=True
            )

        self.parts[part_id] = geom

    def set_boundary(
        self,
        boundary_svg: str = None,
        margin: float = 5,
        segment: Dict[str, Any] = None,
        editing_width: float = 0,
        editing_height: float = 0,
        layer_data: Dict[str, Any] = None,
    ):
        """
        Set the outer boundary for connectivity analysis.

        Priority:
        1. Frame segment SVG (boundary_svg) — custom shape frame
        2. Outer frame (layer_data.isFrameActive) — square/ellipse border
        3. Canvas edge — material sheet boundary

        When *segment* and editing dimensions are given the boundary polygon
        is transformed to match the frame segment's actual canvas position.
        """
        if boundary_svg:
            polys = parse_svg_to_polygons(boundary_svg)
            if polys:
                if segment and editing_width > 0 and editing_height > 0:
                    polys = [
                        apply_segment_transform(p, segment, editing_width, editing_height)
                        for p in polys
                    ]
                outer_shape = unary_union(polys) if len(polys) > 1 else polys[0]

                # For a custom frame segment, the boundary must be the RING
                # (border strip), not the entire filled shape.  Parts inside
                # the frame must physically touch this ring to be non-floating.
                # When frameUnion.js zeroes borderPercent, the original value is
                # saved as _originalBorderPercent — use that for ring computation.
                border_percent = (segment or {}).get("borderPercent", 10)
                if border_percent == 0:
                    border_percent = (segment or {}).get("_originalBorderPercent", 10)
                if border_percent and border_percent > 0 and not outer_shape.is_empty:
                    bounds = outer_shape.bounds  # (minx, miny, maxx, maxy)
                    char_dim = min(bounds[2] - bounds[0], bounds[3] - bounds[1])
                    inset = (border_percent / 100) * char_dim
                    inner_shape = outer_shape.buffer(-inset, join_style=2)
                    if not inner_shape.is_empty:
                        ring = outer_shape.difference(inner_shape)
                        logger.info(f"[set_boundary] Frame ring: outer area={outer_shape.area:.0f}, inner area={inner_shape.area:.0f}, ring area={ring.area:.0f}")
                        self.boundary_polygon = ring
                        return

                self.boundary_polygon = outer_shape
                return

        # Check for outer frame (layer-level isFrameActive)
        if layer_data and layer_data.get("isFrameActive"):
            cw = self.canvas_width
            ch = self.canvas_height
            raw_stroke = layer_data.get("frameStrokeWidth", 50)
            # frameStrokeWidth is stored in editing-canvas pixels.
            # Scale to 1024 coords to match the frontend:
            #   strokeWidth = frameStrokeWidth * (sourceSize / editingWidth)
            scale_factor = (cw / editing_width) if editing_width > 0 else 1
            stroke_width = raw_stroke * scale_factor
            frame_shape = layer_data.get("frameShape", "squareOutline")
            is_square = "square" in frame_shape

            if is_square:
                outer_shape = box(0, 0, cw, ch)
                inner_shape = box(stroke_width, stroke_width,
                                  cw - stroke_width, ch - stroke_width)
            else:
                # Ellipse approximation
                from shapely.geometry import Point
                cx, cy = cw / 2, ch / 2
                outer_shape = Point(cx, cy).buffer(cw / 2, resolution=64)
                inner_r = (cw - 2 * stroke_width) / 2
                inner_shape = Point(cx, cy).buffer(inner_r, resolution=64)

            ring = outer_shape.difference(inner_shape)
            if not ring.is_empty:
                logger.info(f"[set_boundary] Outer frame ring: stroke={stroke_width}, shape={frame_shape}, ring area={ring.area:.0f}")
                self.boundary_polygon = ring
                return

        # No explicit frame — use the canvas edge as the material sheet boundary.
        # A thin ring along the canvas perimeter represents the sheet edge.
        outer = box(-margin, -margin,
                    self.canvas_width + margin, self.canvas_height + margin)
        inner = box(0, 0, self.canvas_width, self.canvas_height)
        self.boundary_polygon = outer.difference(inner)

    def _get_polygon(self, part: PartGeometry) -> Optional[Polygon]:
        """Get the polygon for a part (handles MultiPolygon)."""
        if part.polygon:
            return part.polygon
        if part.multi_polygon:
            # Return the largest polygon
            largest = max(part.multi_polygon.geoms, key=lambda p: p.area)
            return largest
        return None

    def _parts_touch(self, part1: PartGeometry, part2: PartGeometry, tolerance: float = 2.0) -> bool:
        """Check if two parts touch or are very close."""
        poly1 = self._get_polygon(part1)
        poly2 = self._get_polygon(part2)

        if not poly1 or not poly2:
            return False

        # Check direct intersection or touching
        if poly1.intersects(poly2) or poly1.touches(poly2):
            return True

        # Check if they're within tolerance distance
        distance = poly1.distance(poly2)
        return distance <= tolerance

    def _part_touches_boundary(self, part: PartGeometry, tolerance: float = 2.0) -> bool:
        """Check if a part touches the boundary."""
        if not self.boundary_polygon:
            return False

        poly = self._get_polygon(part)
        if not poly:
            return False

        # Check direct intersection
        if poly.intersects(self.boundary_polygon):
            return True

        # Check within tolerance
        distance = poly.distance(self.boundary_polygon)
        return distance <= tolerance

    def _find_nearest_point_to_boundary(self, part: PartGeometry) -> Tuple[Tuple[float, float], float]:
        """Find the nearest point on a part to the boundary."""
        poly = self._get_polygon(part)
        if not poly or not self.boundary_polygon:
            return ((0, 0), float('inf'))

        # Get nearest points between part and boundary
        from shapely.ops import nearest_points

        p1, p2 = nearest_points(poly, self.boundary_polygon)
        distance = poly.distance(self.boundary_polygon)

        return ((p1.x, p1.y), distance)

    def _find_nearest_point_to_part(
        self,
        source: PartGeometry,
        target: PartGeometry
    ) -> Tuple[Tuple[float, float], Tuple[float, float], float]:
        """Find nearest points between two parts."""
        poly1 = self._get_polygon(source)
        poly2 = self._get_polygon(target)

        if not poly1 or not poly2:
            return ((0, 0), (0, 0), float('inf'))

        from shapely.ops import nearest_points

        p1, p2 = nearest_points(poly1, poly2)
        distance = poly1.distance(poly2)

        return ((p1.x, p1.y), (p2.x, p2.y), distance)

    def analyze_connectivity(self, tolerance: float = 2.0) -> List[ConnectivityResult]:
        """
        Analyze connectivity of all parts.

        Uses BFS/flood-fill from the boundary to find all connected parts.
        Parts not reachable from the boundary are floating.

        Args:
            tolerance: Distance tolerance for considering parts as touching

        Returns:
            List of ConnectivityResult for each part
        """
        if not self.boundary_polygon:
            self.set_boundary()

        results = []

        # First pass: find which parts directly touch the boundary
        boundary_connected: Set[str] = set()
        for part_id, part in self.parts.items():
            if part.is_valid and self._part_touches_boundary(part, tolerance):
                boundary_connected.add(part_id)

        # Build adjacency graph
        adjacency: Dict[str, Set[str]] = {p_id: set() for p_id in self.parts}
        part_ids = list(self.parts.keys())

        for i, p1_id in enumerate(part_ids):
            p1 = self.parts[p1_id]
            if not p1.is_valid:
                continue
            for p2_id in part_ids[i+1:]:
                p2 = self.parts[p2_id]
                if not p2.is_valid:
                    continue
                if self._parts_touch(p1, p2, tolerance):
                    adjacency[p1_id].add(p2_id)
                    adjacency[p2_id].add(p1_id)

        # BFS from boundary-connected parts to find all reachable parts
        all_connected: Set[str] = set(boundary_connected)
        queue = list(boundary_connected)

        while queue:
            current = queue.pop(0)
            for neighbor in adjacency[current]:
                if neighbor not in all_connected:
                    all_connected.add(neighbor)
                    queue.append(neighbor)

        # Generate results for each part
        for part_id, part in self.parts.items():
            if not part.is_valid:
                results.append(ConnectivityResult(
                    part_id=part_id,
                    part_name=part.name,
                    is_floating=True,
                    is_connected_to_boundary=False,
                    recommended_fix="none",
                ))
                continue

            is_floating = part_id not in all_connected
            is_boundary_connected = part_id in boundary_connected
            connected_parts = list(adjacency[part_id])

            # Find nearest anchor for floating parts
            nearest_anchor = None
            distance_to_nearest = float('inf')
            fix_points = []

            if is_floating:
                # Find nearest connected part or boundary
                point_to_boundary, dist_to_boundary = self._find_nearest_point_to_boundary(
                    part)
                nearest_anchor = "boundary"
                distance_to_nearest = dist_to_boundary
                fix_points.append(point_to_boundary)

                # Check if any connected (non-floating) part is closer
                for other_id in all_connected:
                    other = self.parts[other_id]
                    if not other.is_valid:
                        continue
                    p1, p2, dist = self._find_nearest_point_to_part(
                        part, other)
                    if dist < distance_to_nearest:
                        distance_to_nearest = dist
                        nearest_anchor = other_id
                        fix_points = [p1, p2]

            # Determine recommended fix — always use bridge
            recommended_fix = "none"
            if is_floating:
                recommended_fix = "add_bridge"

            results.append(ConnectivityResult(
                part_id=part_id,
                part_name=part.name,
                is_floating=is_floating,
                is_connected_to_boundary=is_boundary_connected,
                connected_to_parts=connected_parts,
                nearest_anchor=nearest_anchor,
                distance_to_nearest=distance_to_nearest,
                recommended_fix=recommended_fix,
                fix_points=fix_points
            ))

        return results

    def find_floating_parts(self, tolerance: float = 2.0) -> List[ConnectivityResult]:
        """Find only the floating parts."""
        all_results = self.analyze_connectivity(tolerance)
        return [r for r in all_results if r.is_floating]


# =============================================================================
# Bridge Generation
# =============================================================================

def generate_bridge_polygon(
    from_point: Tuple[float, float],
    to_point: Tuple[float, float],
    width: float = 2.0,
    overshoot: float = 0,
) -> Polygon:
    """
    Generate a rectangular bridge polygon connecting two points.

    The bridge extends *overshoot* units beyond each endpoint so the
    rectangle penetrates into both the floating part and the boundary,
    producing a clean overlap with no gaps in the SVG output.

    Args:
        from_point: Starting point (x, y) — on the floating part surface
        to_point: Ending point (x, y) — on the boundary surface
        width: Width of the bridge
        overshoot: Extra length beyond each endpoint to overlap into shapes.
                   Defaults to 0 (caller should set based on bridge width).

    Returns:
        Shapely Polygon representing the bridge
    """
    x1, y1 = from_point
    x2, y2 = to_point

    # Calculate direction vector
    dx = x2 - x1
    dy = y2 - y1
    length = math.sqrt(dx*dx + dy*dy)

    if length < 0.001:
        # Points are too close, return a small circle
        return Point(x1, y1).buffer(width / 2)

    # Normalize direction
    dx /= length
    dy /= length

    # Extend endpoints by overshoot so the bridge penetrates into both shapes
    x1 -= dx * overshoot
    y1 -= dy * overshoot
    x2 += dx * overshoot
    y2 += dy * overshoot

    # Perpendicular vector
    px = -dy * (width / 2)
    py = dx * (width / 2)

    # Create rectangle corners
    corners = [
        (x1 + px, y1 + py),
        (x1 - px, y1 - py),
        (x2 - px, y2 - py),
        (x2 + px, y2 + py),
    ]

    return Polygon(corners)


def generate_tab_positions(
    part_polygon: Polygon,
    boundary_polygon: Polygon,
    num_tabs: int = 2,
    min_spacing: float = 20.0
) -> List[Tuple[Tuple[float, float], Tuple[float, float]]]:
    """
    Generate positions for tabs connecting a part to the boundary.

    Tries to space tabs evenly around the part's perimeter.

    Args:
        part_polygon: The floating part's polygon
        boundary_polygon: The outer boundary polygon
        num_tabs: Number of tabs to generate
        min_spacing: Minimum spacing between tabs

    Returns:
        List of (part_point, boundary_point) tuples for each tab
    """
    from shapely.ops import nearest_points

    tabs = []

    # Get the boundary of the part
    part_boundary = part_polygon.exterior
    perimeter = part_boundary.length

    if num_tabs < 1:
        return tabs

    # Space tabs evenly along perimeter
    spacing = perimeter / num_tabs

    for i in range(num_tabs):
        # Get point along perimeter
        distance_along = i * spacing + spacing / 2
        fraction = distance_along / perimeter

        # Get point on part boundary
        part_point = part_boundary.interpolate(fraction, normalized=True)

        # Find nearest point on outer boundary
        _, boundary_point = nearest_points(
            Point(part_point.x, part_point.y), boundary_polygon)

        tabs.append(
            ((part_point.x, part_point.y), (boundary_point.x, boundary_point.y))
        )

    return tabs


def _ring_to_svg(coords, precision: int = 2) -> str:
    """Convert a coordinate ring to an SVG sub-path (M...L...Z)."""
    if not coords:
        return ""
    parts = [f"M {round(coords[0][0], precision)},{round(coords[0][1], precision)}"]
    for x, y in coords[1:]:
        parts.append(f"L {round(x, precision)},{round(y, precision)}")
    parts.append("Z")
    return " ".join(parts)


def polygon_to_svg_path(polygon, precision: int = 2) -> str:
    """
    Convert a Shapely Polygon or MultiPolygon to SVG path d attribute.
    Handles interior holes and multiple polygons.

    Args:
        polygon: Shapely Polygon or MultiPolygon
        precision: Decimal precision for coordinates

    Returns:
        SVG path d attribute string
    """
    if polygon.is_empty:
        return ""

    # Handle MultiPolygon by combining all sub-polygons
    if isinstance(polygon, MultiPolygon):
        sub_paths = []
        for poly in polygon.geoms:
            p = polygon_to_svg_path(poly, precision)
            if p:
                sub_paths.append(p)
        return " ".join(sub_paths)

    # Single Polygon — exterior + holes
    coords = list(polygon.exterior.coords)
    if not coords:
        return ""

    path = _ring_to_svg(coords, precision)

    # Add interior holes
    for interior in polygon.interiors:
        hole_coords = list(interior.coords)
        if hole_coords:
            path += " " + _ring_to_svg(hole_coords, precision)

    return path


# =============================================================================
# High-Level Analysis Functions
# =============================================================================

def _find_frame_segment(segments: List[Dict]) -> Optional[Dict]:
    """Return the first frame segment in *segments*, or None.

    Skips synthetic ``frame-union-*`` segments created by the frontend's
    one-time boolean union (frameUnion.js).  Those are merged outlines,
    not actual frame segments.
    """
    for seg in segments:
        seg_id = seg.get("id", "")
        if seg_id.startswith("frame-union-"):
            continue
        if seg.get("isFrame") or "frame" in seg.get("name", "").lower():
            return seg
    return None


def analyze_layer_for_fabrication(
    layer_data: Dict[str, Any],
    canvas_width: float = 1024,
    canvas_height: float = 1024,
    tolerance: float = 2.0,
    editing_width: float = 0,
    editing_height: float = 0,
) -> Dict[str, Any]:
    """
    Analyze a complete layer for fabrication issues.

    Args:
        layer_data: Layer dict with segments
        canvas_width: Canvas width in pixels
        canvas_height: Canvas height in pixels
        tolerance: Distance tolerance for connectivity
        editing_width: Frontend editing canvas width (for transform)
        editing_height: Frontend editing canvas height (for transform)

    Returns:
        Analysis results with issues and recommendations
    """
    analyzer = ConnectivityAnalyzer(canvas_width, canvas_height)

    segments = layer_data.get("segments", [])

    # Find frame segment first — it defines the boundary, not a part
    frame_seg = _find_frame_segment(segments)
    frame_seg_id = frame_seg.get("id") if frame_seg else None
    # A layer has a frame if it has a segment frame OR a layer-level outer frame
    # frameDisabled is a rendering flag (frame merged into bridge) — still use for analysis
    has_frame = frame_seg is not None or layer_data.get("isFrameActive", False) or layer_data.get("frameDisabled", False)

    # Add non-frame parts (with user transforms applied).
    # Skip synthetic frame-union segments — they are rendering artifacts
    # from the frontend's one-time boolean union, not real physical parts.
    # But keep segment-union-* — these are real merged physical parts.
    for seg in segments:
        seg_id = seg.get("id", "unknown")
        if seg_id == frame_seg_id:
            continue  # frame segment is the boundary, not a part
        if seg_id.startswith("frame-union-"):
            continue  # synthetic frame-union rendering artifact
        # If the frame was disabled (merged into a segment via bridge),
        # that segment's SVG now contains the frame ring geometry.
        # Skip it — it's part of the boundary, not a separate floating part.
        if (layer_data.get("frameDisabled") and seg.get("skipTransform")
                and seg.get("skipClip") and not seg_id.startswith("segment-union-")
                and not seg.get("_originalSvg")):
            continue
        # If svg is null but _originalSvg exists, this segment was merged
        # into either a frame-union or segment-union. Skip the individual —
        # the union segment represents the physical part.
        if not seg.get("svg") and seg.get("_originalSvg"):
            continue
        seg_name = seg.get("name", seg_id)
        seg_svg = seg.get("svg") or seg.get("_bridgedSvg") or seg.get("_originalSvg", "")
        seg_bbox = seg.get("bbox", [])

        if seg_svg:
            analyzer.add_part(
                seg_id, seg_name, seg_svg, seg_bbox,
                segment=seg,
                editing_width=editing_width,
                editing_height=editing_height,
            )

    # Skip floating detection when no frame — everything is "floating" from
    # a fake canvas-edge boundary, which is meaningless.
    connectivity_results = []
    issues = []
    floating_parts = []

    if has_frame:
        analyzer.set_boundary(
            frame_seg.get("svg") if frame_seg else None,
            segment=frame_seg,
            editing_width=editing_width,
            editing_height=editing_height,
            layer_data=layer_data,
        )

        # Analyze connectivity
        connectivity_results = analyzer.analyze_connectivity(tolerance)

        for result in connectivity_results:
            if result.is_floating:
                floating_parts.append({
                    "part_id": result.part_id,
                    "part_name": result.part_name,
                    "nearest_anchor": result.nearest_anchor,
                    "distance": result.distance_to_nearest,
                    "recommended_fix": result.recommended_fix,
                    "fix_points": result.fix_points
                })

                issues.append(FabricationIssue(
                    issue_type=IssueType.FLOATING,
                    severity="error",
                    part_id=result.part_id,
                    part_name=result.part_name,
                    message=f"'{result.part_name}' is floating and will fall out after cutting",
                    details={
                        "nearest_anchor": result.nearest_anchor,
                        "distance": result.distance_to_nearest,
                    },
                    suggested_fixes=[result.recommended_fix]
                ))
    else:
        logger.info("Layer %s has no frame — skipping floating detection",
                     layer_data.get("id"))

    return {
        "layer_id": layer_data.get("id"),
        "layer_name": layer_data.get("name"),
        "total_parts": len(segments),
        "valid_parts": sum(1 for p in analyzer.parts.values() if p.is_valid),
        "floating_parts_count": len(floating_parts),
        "floating_parts": floating_parts,
        "connectivity": [
            {
                "part_id": r.part_id,
                "part_name": r.part_name,
                "is_floating": r.is_floating,
                "is_connected_to_boundary": r.is_connected_to_boundary,
                "connected_to": r.connected_to_parts,
                "nearest_anchor": r.nearest_anchor,
                "distance": r.distance_to_nearest,
            }
            for r in connectivity_results
        ],
        "issues": [
            {
                "type": issue.issue_type.value,
                "severity": issue.severity,
                "part_id": issue.part_id,
                "part_name": issue.part_name,
                "message": issue.message,
                "details": issue.details,
                "suggested_fixes": issue.suggested_fixes,
            }
            for issue in issues
        ],
        "has_frame": has_frame,
        "is_fabrication_ready": len(floating_parts) == 0
    }


def generate_fix_svg(
    fix_type: str,
    layer_data: Dict[str, Any],
    fix_params: Dict[str, Any],
    canvas_width: float = 1024,
    canvas_height: float = 1024,
    editing_width: float = 0,
    editing_height: float = 0,
    fabrication_scale: float = 1.0,
    board_size_mm: float = 304.8,
) -> Dict[str, Any]:
    """
    Generate SVG for a fix (bridge or tabs).

    Args:
        fix_type: "add_bridge" or "add_tabs"
        layer_data: Layer data with segments
        fix_params: Parameters for the fix
        editing_width: Frontend editing canvas width (for transform)
        editing_height: Frontend editing canvas height (for transform)
        fabrication_scale: User's fabrication scale (e.g. 0.5 = half size)
        board_size_mm: Physical size of the canvas at scale 1.0 (default 304.8mm)

    Returns:
        Dict with fix SVG and modified layer SVG
    """
    analyzer = ConnectivityAnalyzer(canvas_width, canvas_height)

    segments = layer_data.get("segments", [])
    frame_seg = _find_frame_segment(segments)
    frame_seg_id = frame_seg.get("id") if frame_seg else None

    # Add non-frame parts (with user transforms applied).
    # Skip synthetic frame-union segments — not real physical parts.
    for seg in segments:
        seg_id = seg.get("id", "unknown")
        if seg_id == frame_seg_id:
            continue
        if seg_id.startswith("frame-union-"):
            continue  # synthetic segment, not a real part
        seg_name = seg.get("name", seg_id)
        seg_svg = seg.get("svg") or seg.get("_originalSvg", "")
        if seg_svg:
            analyzer.add_part(
                seg_id, seg_name, seg_svg,
                segment=seg,
                editing_width=editing_width,
                editing_height=editing_height,
            )

    # Use frame segment as boundary if present (with transforms)
    frame_seg = _find_frame_segment(segments)
    analyzer.set_boundary(
        frame_seg.get("svg") if frame_seg else None,
        segment=frame_seg,
        editing_width=editing_width,
        editing_height=editing_height,
        layer_data=layer_data,
    )

    # Convert mm inputs to SVG coordinate units.
    # board_size_mm = physical size of the 1024-unit canvas at scale 1.0 (~104.4mm).
    # fabrication_scale adjusts for user scaling: at 0.5x, the design is
    # physically half-size, so 1mm physical = more SVG units (stricter check).
    effective_board_mm = board_size_mm * fabrication_scale
    svg_units_per_mm = canvas_width / effective_board_mm

    if fix_type == "add_bridge":
        from_part_id = fix_params.get("from_part_id")
        to_part_id = fix_params.get("to_part_id")  # Can be "boundary"
        width_mm = fix_params.get("bridge_width_mm", 2.0)
        width = float(width_mm) * svg_units_per_mm

        from_part = analyzer.parts.get(from_part_id)
        if not from_part or not from_part.is_valid:
            # Fuzzy fallback: Gemini sometimes appends suffixes like "(svg)"
            # or truncates long IDs.  Try prefix/substring match.
            cleaned = from_part_id.split("(")[0].strip()
            for pid, pgeom in analyzer.parts.items():
                if pid == cleaned or pid.startswith(cleaned) or cleaned.startswith(pid):
                    logger.info(f"[generate_fix_svg] Fuzzy matched '{from_part_id}' → '{pid}'")
                    from_part = pgeom
                    from_part_id = pid
                    break
        if not from_part or not from_part.is_valid:
            logger.error(
                f"[generate_fix_svg] Part '{from_part_id}' not found. "
                f"Available parts: {list(analyzer.parts.keys())}. "
                f"Segments: {[(s.get('id'), bool(s.get('svg')), s.get('isFrame')) for s in segments]}"
            )
            return {"error": f"Part not found: {from_part_id}"}

        # Get connection points — use explicit user-drawn points if provided
        explicit_from = fix_params.get("from_point")
        explicit_to = fix_params.get("to_point")

        # Resolve "auto" to_part_id from to_point coordinates
        if to_part_id == "auto" and explicit_to:
            from shapely.geometry import Point as ShapelyPoint
            to_pt = ShapelyPoint(explicit_to[0], explicit_to[1])
            best_dist = float('inf')
            best_id = "boundary"
            # Check all parts (except from_part)
            for pid, pgeom in analyzer.parts.items():
                if pid == from_part_id:
                    continue
                poly = analyzer._get_polygon(pgeom)
                if poly:
                    d = to_pt.distance(poly)
                    if d < best_dist:
                        best_dist = d
                        best_id = pid
            # Check boundary
            if analyzer.boundary_polygon:
                bd = to_pt.distance(analyzer.boundary_polygon)
                if bd < best_dist:
                    best_dist = bd
                    best_id = "boundary"
            to_part_id = best_id
            logger.info(f"[generate_fix_svg] Auto-resolved to_part_id: {to_part_id} (dist={best_dist:.1f})")

        if explicit_from and explicit_to:
            # User drew the bridge manually — use their coordinates directly
            point1 = tuple(explicit_from)
            point2 = tuple(explicit_to)
            logger.info(f"[generate_fix_svg] Using explicit bridge points: {point1} → {point2}")
        elif to_part_id == "boundary":
            point1, _ = analyzer._find_nearest_point_to_boundary(from_part)
            from shapely.ops import nearest_points
            from_poly = analyzer._get_polygon(from_part)
            _, boundary_pt = nearest_points(
                from_poly, analyzer.boundary_polygon)
            point2 = (boundary_pt.x, boundary_pt.y)
        else:
            to_part = analyzer.parts.get(to_part_id)
            if not to_part or not to_part.is_valid:
                cleaned = to_part_id.split("(")[0].strip()
                for pid, pgeom in analyzer.parts.items():
                    if pid == cleaned or pid.startswith(cleaned) or cleaned.startswith(pid):
                        logger.info(f"[generate_fix_svg] Fuzzy matched to_part '{to_part_id}' → '{pid}'")
                        to_part = pgeom
                        to_part_id = pid
                        break
            if not to_part or not to_part.is_valid:
                return {"error": f"Part not found: {to_part_id}"}
            point1, point2, _ = analyzer._find_nearest_point_to_part(
                from_part, to_part)

        # Generate bridge polygon — overshoot well beyond bridge width so ends
        # penetrate deeply into both the floating part and the boundary shape,
        # producing overlapping geometry with no visual gaps.
        # Large overshoot (3× width, min 15 SVG units) prevents precision gaps.
        overshoot = max(width * 3, 15.0)
        bridge_poly = generate_bridge_polygon(point1, point2, width, overshoot=overshoot)

        # Clip bridge to the outer frame edge so it doesn't extend outside the cut area.
        # Note: analyzer.boundary_polygon is the frame RING (solid border strip).
        # We need to clip to the full area enclosed by the outer edge, not just the ring,
        # so the bridge can cross the open inner space between the floating part and the ring.
        if analyzer.boundary_polygon and not analyzer.boundary_polygon.is_empty:
            # Get the outer boundary of the ring (convex hull or bounds)
            outer_boundary = analyzer.boundary_polygon
            # If it's a ring (has interior holes or is a union of shapes), use its
            # convex hull or buffer to get the full enclosed area
            if hasattr(outer_boundary, 'convex_hull'):
                clip_area = outer_boundary.convex_hull
            else:
                clip_area = outer_boundary
            clipped = bridge_poly.intersection(clip_area)
            if not clipped.is_empty and clipped.area > 0:
                bridge_poly = make_valid(clipped)
                logger.info(f"[bridge] Clipped bridge to outer frame edge, area: {bridge_poly.area:.0f}")

        # Bridge-only mode: return just the bridge polygon as a new segment.
        # No merging, no frame union — the bridge is a standalone cut path.
        if fix_params.get("bridge_only"):
            bridge_path = polygon_to_svg_path(bridge_poly)
            bridge_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{canvas_width}" height="{canvas_height}" viewBox="0 0 {canvas_width} {canvas_height}">
  <path d="{bridge_path}" fill="rgb(59,130,246)"/>
</svg>'''
            logger.info(f"[bridge] bridge_only mode: returning bridge polygon as new segment")
            return {
                "success": True,
                "bridge_svg": bridge_svg,
                "bridge_path": bridge_path,
                "bridge_only": True,
                "from_part": from_part_id,
                "to_part": to_part_id,
                "layer_id": layer_data.get("id"),
            }

        # Boolean union: merge bridge into the floating part's polygon
        from_poly = analyzer._get_polygon(from_part)
        logger.info(f"[bridge] from_poly type={type(from_poly).__name__} area={from_poly.area:.0f} valid={from_poly.is_valid}")
        logger.info(f"[bridge] bridge_poly area={bridge_poly.area:.0f} valid={bridge_poly.is_valid}")
        logger.info(f"[bridge] intersects={from_poly.intersects(bridge_poly)} overlap_area={from_poly.intersection(bridge_poly).area:.1f}")
        merged_poly = make_valid(from_poly.union(bridge_poly))

        # If union produced a MultiPolygon (bridge barely missed overlapping),
        # keep all parts — polygon_to_svg_path handles MultiPolygon.
        if isinstance(merged_poly, MultiPolygon):
            logger.warning(f"[bridge] merged is MultiPolygon with {len(merged_poly.geoms)} parts "
                           f"(bridge may not overlap part — consider increasing overshoot). "
                           f"Areas: {[f'{g.area:.0f}' for g in merged_poly.geoms]}")
        else:
            logger.info(f"[bridge] merged type={type(merged_poly).__name__} area={merged_poly.area:.0f} "
                        f"exterior_coords={len(list(merged_poly.exterior.coords))} "
                        f"holes={len(list(merged_poly.interiors))}")
        merged_path = polygon_to_svg_path(merged_poly)
        logger.info(f"[bridge] merged_path length={len(merged_path)} first200={merged_path[:200]}")

        merged_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{canvas_width}" height="{canvas_height}" viewBox="0 0 {canvas_width} {canvas_height}">
  <path d="{merged_path}" fill="rgb(156,163,175)"/>
</svg>'''

        # Union strategy depends on connection target:
        # - Bridge to boundary: triple union (from + bridge + frame ring) → one piece
        # - Bridge to another part: union both parts + bridge → one piece, frame untouched
        combined_svg = merged_svg  # fallback
        combined_path_str = merged_path  # fallback
        boundary_disabled = False
        to_segment_id = None  # ID of target segment to also replace

        skip_boundary_union = fix_params.get("skip_boundary_union", False)

        if to_part_id == "boundary":
            # Check if a frame-union already handles the frame ring rendering.
            # If so, skip the triple union — the frontend merges the bridge into
            # the frame-union segment client-side (applySvgUpdates lines 372-414).
            has_frame_union = any(
                seg.get("id", "").startswith("frame-union-") for seg in segments
            )

            if skip_boundary_union:
                logger.info("[bridge] skip_boundary_union=True, using part+bridge only")
            elif has_frame_union:
                # Frame-union handles frame rendering. Just use part+bridge.
                logger.info("[bridge] frame-union exists, skipping boundary union")
            elif analyzer.boundary_polygon and not analyzer.boundary_polygon.is_empty:
                # Triple union: from_part + bridge + frame ring → one connected piece.
                # Eliminates internal edges where bridge meets frame.
                combined_poly = make_valid(merged_poly.union(analyzer.boundary_polygon))
                combined_path = polygon_to_svg_path(combined_poly)
                logger.info(f"[bridge] combined (part+bridge+frame) type={type(combined_poly).__name__} "
                             f"area={combined_poly.area:.0f} "
                             f"holes={len(list(combined_poly.interiors)) if hasattr(combined_poly, 'interiors') else 'N/A'}")

                if combined_path:
                    combined_path_str = combined_path
                    combined_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{canvas_width}" height="{canvas_height}" viewBox="0 0 {canvas_width} {canvas_height}">
  <path d="{combined_path}" fill="rgb(156,163,175)" />
</svg>'''
                    boundary_disabled = True  # Frame ring is now part of the segment
        else:
            # Part-to-part bridge: union from_part + bridge + to_part → one piece.
            # Frame ring stays separate.
            to_part_obj = analyzer.parts.get(to_part_id)
            to_poly = analyzer._get_polygon(to_part_obj) if to_part_obj else None
            if to_poly:
                combined_poly = make_valid(merged_poly.union(to_poly))
                combined_path = polygon_to_svg_path(combined_poly)
                logger.info(f"[bridge] combined (part+bridge+part) type={type(combined_poly).__name__} "
                             f"area={combined_poly.area:.0f}")

                if combined_path:
                    combined_path_str = combined_path
                    combined_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{canvas_width}" height="{canvas_height}" viewBox="0 0 {canvas_width} {canvas_height}">
  <path d="{combined_path}" fill="rgb(156,163,175)" />
</svg>'''
                    to_segment_id = to_part_id  # Tell frontend to also replace target segment

        bridge_svg_path = polygon_to_svg_path(bridge_poly)

        result = {
            "success": True,
            "fix_type": "add_bridge",
            "from_part": from_part_id,
            "to_part": to_part_id,
            "segment_id": from_part_id,
            "merged_svg": combined_svg,
            "merged_path": combined_path_str,
            "bridge_svg": combined_svg,
            "bridge_path": bridge_svg_path,
            "connection_points": [point1, point2],
            "width_mm": float(width_mm),
            "width_svg_units": width,
            "boundary_disabled": boundary_disabled,
            "to_segment_id": to_segment_id,
        }

        return result

    elif fix_type == "add_tabs":
        part_id = fix_params.get("part_id")
        num_tabs = fix_params.get("num_tabs", 2)
        tab_width_mm = fix_params.get("tab_width_mm", 1.5)
        tab_width = float(tab_width_mm) * svg_units_per_mm

        part = analyzer.parts.get(part_id)
        if not part or not part.is_valid:
            return {"error": f"Part not found: {part_id}"}

        part_poly = analyzer._get_polygon(part)

        logger.info(f"[generate_fix_svg] Tab generation for part '{part_id}':")
        logger.info(f"  Part bounds: {part_poly.bounds if part_poly else 'None'}")
        logger.info(f"  Boundary bounds: {analyzer.boundary_polygon.bounds if analyzer.boundary_polygon else 'None'}")
        logger.info(f"  Boundary type: {analyzer.boundary_polygon.geom_type if analyzer.boundary_polygon else 'None'}")
        if analyzer.boundary_polygon and hasattr(analyzer.boundary_polygon, 'interiors'):
            logger.info(f"  Boundary holes: {len(list(analyzer.boundary_polygon.interiors))}")
        logger.info(f"  Tab width (SVG units): {tab_width:.1f}, num_tabs: {num_tabs}")

        # Generate tab positions
        tab_positions = generate_tab_positions(
            part_poly,
            analyzer.boundary_polygon,
            num_tabs
        )
        logger.info(f"  Tab positions: {tab_positions}")

        # Generate tab polygons — each tab as a separate <path> element
        # so SVG parsers treat them as independent shapes
        tab_paths = []
        path_elements = []
        for from_pt, to_pt in tab_positions:
            tab_poly = generate_bridge_polygon(from_pt, to_pt, tab_width, overshoot=max(tab_width, 5.0))
            path_d = polygon_to_svg_path(tab_poly)
            tab_paths.append(path_d)
            path_elements.append(
                f'  <path d="{path_d}" fill="rgb(156,163,175)" />')

        tabs_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{canvas_width}" height="{canvas_height}" viewBox="0 0 {canvas_width} {canvas_height}">
{chr(10).join(path_elements)}
</svg>'''

        return {
            "success": True,
            "fix_type": "add_tabs",
            "part_id": part_id,
            "num_tabs": num_tabs,
            "tab_width_mm": float(tab_width_mm),
            "tab_width_svg_units": tab_width,
            "tabs_svg": tabs_svg,
            "tab_paths": tab_paths,
            "tab_positions": tab_positions
        }

    return {"error": f"Unknown fix type: {fix_type}"}


# =============================================================================
# Thin Area Detection
# =============================================================================

def detect_thin_areas(
    polygon: Polygon,
    min_width_mm: float = 1.0,
    canvas_width: float = 1024,
    board_size_mm: float = 304.8,
    fabrication_scale: float = 1.0,
) -> List[Dict[str, Any]]:
    """
    Detect thin/narrow regions of a polygon using negative buffer (erosion).

    The approach: erode the polygon inward by half the minimum width. Regions
    narrower than min_width will disappear. By comparing the original polygon
    with the eroded version, we identify the thin areas.

    Args:
        polygon: Shapely Polygon to analyze
        min_width_mm: Minimum acceptable width in millimeters
        canvas_width: Canvas size in SVG units
        board_size_mm: Physical board size in mm (for unit conversion)
        fabrication_scale: User's fabrication scale (affects physical size)

    Returns:
        List of thin area dicts with location, width estimate, and geometry
    """
    effective_board_mm = board_size_mm * fabrication_scale
    svg_units_per_mm = canvas_width / effective_board_mm
    erosion_distance = (min_width_mm / 2) * svg_units_per_mm

    if not polygon.is_valid:
        polygon = make_valid(polygon)
    if polygon.is_empty or polygon.area < 1:
        return []

    eroded = polygon.buffer(-erosion_distance, join_style=3)

    if eroded.is_empty:
        centroid = polygon.centroid
        return [{
            "type": "entire_part_too_thin",
            "location": (centroid.x, centroid.y),
            "estimated_width_mm": _estimate_min_width(polygon, svg_units_per_mm),
            "area_fraction": 1.0,
            "severity": "error",
        }]

    thin_regions = polygon.difference(
        eroded.buffer(erosion_distance, join_style=3))

    if thin_regions.is_empty or thin_regions.area < 1:
        return []

    thin_areas = []
    area_fraction = thin_regions.area / polygon.area

    if area_fraction < 0.05:
        return []

    regions = (
        list(thin_regions.geoms)
        if hasattr(thin_regions, "geoms")
        else [thin_regions]
    )

    for region in regions:
        if region.area < 1:
            continue
        centroid = region.centroid
        local_fraction = region.area / polygon.area

        thin_areas.append({
            "type": "thin_area",
            "location": (centroid.x, centroid.y),
            "estimated_width_mm": min_width_mm,
            "area_fraction": round(local_fraction, 3),
            "severity": "warning" if local_fraction < 0.2 else "error",
            "bbox": region.bounds,
        })

    return thin_areas


def _estimate_min_width(polygon: Polygon, svg_units_per_mm: float) -> float:
    """Estimate minimum width of a polygon via binary search on negative buffer."""
    lo, hi = 0.0, 50.0 * svg_units_per_mm
    for _ in range(20):
        mid = (lo + hi) / 2
        eroded = polygon.buffer(-mid, join_style=3)
        if eroded.is_empty:
            hi = mid
        else:
            lo = mid
    return round((lo * 2) / svg_units_per_mm, 2)


def analyze_thin_areas_for_layer(
    layer_data: Dict[str, Any],
    min_width_mm: float = 1.0,
    canvas_width: float = 1024,
    board_size_mm: float = 304.8,
    editing_width: float = 0,
    editing_height: float = 0,
    fabrication_scale: float = 1.0,
) -> List[Dict[str, Any]]:
    """
    Analyze all segments in a layer for thin areas.

    Returns list of issues with part_id, part_name, and thin area details.
    """
    results = []
    analyzer = ConnectivityAnalyzer(canvas_width, canvas_width)

    for seg in layer_data.get("segments", []):
        seg_id = seg.get("id", "unknown")
        if seg_id.startswith("frame-union-") or seg_id.startswith("segment-union-"):
            continue  # synthetic segments, skip
        seg_name = seg.get("name", seg_id)
        # Fall back to _originalSvg for frame-unioned segments — thin features
        # still exist even though the segment is connected to the frame
        seg_svg = seg.get("svg") or seg.get("_originalSvg", "")
        if not seg_svg:
            continue

        analyzer.add_part(
            seg_id, seg_name, seg_svg,
            segment=seg,
            editing_width=editing_width,
            editing_height=editing_height,
        )

    for part_id, part in analyzer.parts.items():
        if not part.is_valid:
            continue

        poly = analyzer._get_polygon(part)
        if not poly:
            continue

        thin_areas = detect_thin_areas(
            poly, min_width_mm, canvas_width, board_size_mm,
            fabrication_scale=fabrication_scale,
        )

        for ta in thin_areas:
            results.append({
                "part_id": part_id,
                "part_name": part.name,
                **ta,
            })

    return results


# =============================================================================
# DXF Export
# =============================================================================

def export_layer_to_dxf(
    layer_data: Dict[str, Any],
    canvas_width: float = 1024,
    board_size_mm: float = 304.8,
) -> bytes:
    """
    Export a layer's SVG paths to DXF format for laser cutting.

    Cut paths go to the 'CUT' layer (red), engrave paths go to 'ENGRAVE' (black).

    Args:
        layer_data: Layer data with segments
        canvas_width: SVG canvas size
        board_size_mm: Physical board size in mm

    Returns:
        DXF file content as bytes
    """
    import ezdxf

    doc = ezdxf.new("R2010")
    msp = doc.modelspace()

    cut_layer = doc.layers.add("CUT", color=1)  # red
    engrave_layer = doc.layers.add("ENGRAVE", color=7)  # white/black

    scale = board_size_mm / canvas_width

    for seg in layer_data.get("segments", []):
        svg = seg.get("svg", "")
        if not svg:
            continue

        polygons = parse_svg_to_polygons(svg)
        for poly in polygons:
            _add_polygon_to_dxf(msp, poly, scale, canvas_width, "CUT")

        svg_trace = seg.get("svg_trace", "")
        if svg_trace and seg.get("engraveStyle") == "traced":
            trace_polys = parse_svg_to_polygons(svg_trace)
            for poly in trace_polys:
                _add_polygon_to_dxf(msp, poly, scale, canvas_width, "ENGRAVE")

    from io import StringIO
    text_stream = StringIO()
    doc.write(text_stream)
    return text_stream.getvalue().encode("utf-8")


def _add_polygon_to_dxf(
    msp, polygon: Polygon, scale: float, canvas_height: float, layer_name: str
):
    """Add a Shapely polygon to DXF modelspace as LWPOLYLINE."""
    if polygon.is_empty:
        return

    coords = list(polygon.exterior.coords)
    if len(coords) < 3:
        return

    dxf_points = [(x * scale, (canvas_height - y) * scale) for x, y in coords]

    msp.add_lwpolyline(
        dxf_points,
        close=True,
        dxfattribs={"layer": layer_name},
    )
