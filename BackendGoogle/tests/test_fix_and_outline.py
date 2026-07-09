"""
Fix bridge segmentation artifacts, then test outline approaches.

1. Fill external mask (drop SAM2's artificial holes)
2. Re-extract bridge from original image using fixed mask
3. Generate outline SVG and visualize
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
from PIL import Image
import cv2
from utils.svg_converter import mask_to_svg

SESSION_DIR = Path(__file__).parent / "9f4c778e-8395-4685-ad3a-5800258a347c"
OUTPUT_DIR = Path(__file__).parent / "fix_and_outline_output"


def fix_mask(mask_path):
    """Fill external contours only — drops all internal holes from SAM2."""
    mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    h, w = mask.shape

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros((h, w), dtype=np.uint8)
    cv2.drawContours(filled, contours, -1, 255, -1)

    # Count before/after
    orig_contours, orig_h = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    orig_holes = sum(1 for i in range(len(orig_contours)) if orig_h[0][i][3] != -1) if orig_h is not None else 0

    new_contours, new_h = cv2.findContours(filled, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    new_holes = sum(1 for i in range(len(new_contours)) if new_h[0][i][3] != -1) if new_h is not None else 0

    print(f"  Mask: {len(orig_contours)} contours ({orig_holes} holes) → {len(new_contours)} contours ({new_holes} holes)")
    return filled


def re_extract(original_path, fixed_mask):
    """Re-extract element from original image using fixed mask."""
    original = Image.open(original_path).convert('RGBA')
    arr = np.array(original)

    # Apply fixed mask as alpha
    output = arr.copy()
    output[:, :, 3] = np.minimum(arr[:, :, 3], fixed_mask)

    return output


def generate_outline_and_visualize(mask, name, output_dir):
    """Generate outline SVG and render visualization."""
    h, w = mask.shape

    # Use the project's mask_to_svg
    import io
    mask_pil = Image.fromarray(mask, mode='L')
    buf = io.BytesIO()
    mask_pil.save(buf, format='PNG')
    mask_bytes = buf.getvalue()

    svg_str = mask_to_svg(mask_bytes, simplify_tolerance=2.0)
    svg_path = output_dir / f"outline_{name}.svg"
    svg_path.write_text(svg_str)

    # Count paths
    path_count = svg_str.count('<path')
    print(f"  SVG: {path_count} paths, {len(svg_str)} chars → {svg_path.name}")

    # Visualize: draw contours on extracted image
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

    vis = np.ones((h, w, 3), dtype=np.uint8) * 255
    for i, cnt in enumerate(contours):
        is_outer = hierarchy[0][i][3] == -1 if hierarchy is not None else True
        color = (0, 0, 200) if is_outer else (200, 0, 0)
        cv2.drawContours(vis, contours, i, color, 2)

    cv2.imwrite(str(output_dir / f"outline_vis_{name}.png"), vis)

    return svg_str


def main():
    OUTPUT_DIR.mkdir(exist_ok=True)

    original_img = SESSION_DIR / "layer_1" / "00_input.png"
    mask_path = SESSION_DIR / "layer_1" / "mask_center-bridge.png"
    extracted_path = SESSION_DIR / "layer_1" / "extracted_center-bridge.png"

    # Step 1: Fix the mask
    print("=== Step 1: Fix mask ===")
    fixed_mask = fix_mask(mask_path)
    cv2.imwrite(str(OUTPUT_DIR / "fixed_mask.png"), fixed_mask)

    # Step 2: Re-extract bridge
    print("\n=== Step 2: Re-extract bridge ===")
    fixed_extracted = re_extract(extracted_path, fixed_mask)
    Image.fromarray(fixed_extracted).save(OUTPUT_DIR / "fixed_extracted.png")
    print(f"  Saved fixed_extracted.png")

    # Step 3: Generate outlines — original vs fixed
    print("\n=== Step 3: Generate outlines ===")
    original_mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)

    print("  Original mask:")
    generate_outline_and_visualize(original_mask, "original", OUTPUT_DIR)

    print("  Fixed mask:")
    generate_outline_and_visualize(fixed_mask, "fixed", OUTPUT_DIR)

    # Test different min_hole_area_ratio values on original mask
    print("\n=== Step 4: Hole area filter sweep (original mask) ===")
    import io
    orig_mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    mask_pil = Image.fromarray(orig_mask, mode='L')
    buf = io.BytesIO()
    mask_pil.save(buf, format='PNG')
    mask_bytes = buf.getvalue()

    for ratio in [0.0, 0.00005, 0.0001, 0.0005, 0.001]:
        svg_str = mask_to_svg(mask_bytes, simplify_tolerance=2.0, min_hole_area_ratio=ratio)
        path_count = svg_str.count('<path')
        evenodd_count = svg_str.count('evenodd')
        # Count M commands (each M = a sub-path = outer or hole)
        m_count = svg_str.count('M ')
        label = f"ratio_{ratio}"
        (OUTPUT_DIR / f"outline_{label}.svg").write_text(svg_str)
        print(f"  ratio={ratio}: {path_count} path elements, {m_count} sub-paths (outer+holes), evenodd={evenodd_count}")

    print(f"\nDone! Check {OUTPUT_DIR}/")


if __name__ == "__main__":
    main()
