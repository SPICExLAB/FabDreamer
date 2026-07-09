"""
Test outline SVG quality from masks.

The outline SVG defines the cut path for laser cutting.
For elements like bridges with many small gaps (between railings),
the outline has too many tiny holes making the piece fragile/messy.

Usage:
    cd BackendGoogle/Test
    python test_outline.py
"""

import sys
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent.parent))

import numpy as np
from PIL import Image, ImageDraw
from pathlib import Path
import cv2
import re


def analyze_outline(mask_path, output_dir):
    """Analyze the outline SVG from a mask."""
    name = mask_path.stem.replace('mask_', '')

    # Load mask
    mask = Image.open(mask_path).convert('L')
    mask_array = np.array(mask)
    height, width = mask_array.shape

    # Threshold
    _, binary = cv2.threshold(mask_array, 127, 255, cv2.THRESH_BINARY)

    # Find contours with hierarchy
    contours, hierarchy = cv2.findContours(binary, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

    if not contours or hierarchy is None:
        print(f"  {name}: no contours found")
        return

    h = hierarchy[0]

    # Analyze contour sizes
    outer_count = 0
    hole_count = 0
    tiny_holes = 0  # holes < 1% of image area
    small_holes = 0  # holes < 5% of image area
    image_area = width * height

    for i in range(len(contours)):
        area = cv2.contourArea(contours[i])
        is_outer = h[i][3] == -1

        if is_outer:
            outer_count += 1
        else:
            hole_count += 1
            area_pct = area / image_area * 100
            if area_pct < 0.1:
                tiny_holes += 1
            elif area_pct < 1.0:
                small_holes += 1

    print(f"  {name}: {len(contours)} contours ({outer_count} outer, {hole_count} holes, "
          f"{tiny_holes} tiny(<0.1%), {small_holes} small(<1%))")

    # Visualize: draw contours on white background
    # Original outline (all contours)
    vis_all = np.ones((height, width, 3), dtype=np.uint8) * 255
    for i in range(len(contours)):
        color = (0, 0, 255) if h[i][3] == -1 else (255, 0, 0)  # Blue=outer, Red=holes
        cv2.drawContours(vis_all, contours, i, color, 1)
    Image.fromarray(vis_all).save(output_dir / f"outline_{name}_all.png")

    # Filtered: remove tiny holes (area < min_hole_area)
    for min_area_pct in [0.1, 0.5, 1.0]:
        min_area = image_area * min_area_pct / 100

        vis = np.ones((height, width, 3), dtype=np.uint8) * 255
        kept_holes = 0
        removed_holes = 0

        for i in range(len(contours)):
            area = cv2.contourArea(contours[i])
            is_outer = h[i][3] == -1

            if is_outer:
                cv2.drawContours(vis, contours, i, (0, 0, 255), 1)
            elif area >= min_area:
                cv2.drawContours(vis, contours, i, (255, 0, 0), 1)
                kept_holes += 1
            else:
                removed_holes += 1

        Image.fromarray(vis).save(output_dir / f"outline_{name}_min{min_area_pct}pct.png")
        print(f"    filter {min_area_pct}%: kept {kept_holes} holes, removed {removed_holes}")

    # Also generate the filled shape visualizations
    for min_area_pct in [0, 0.1, 0.5, 1.0]:
        min_area = image_area * min_area_pct / 100

        # Build filled mask with holes above threshold
        filled = np.zeros((height, width), dtype=np.uint8)

        # Draw outer contours filled
        for i in range(len(contours)):
            if h[i][3] == -1:
                cv2.drawContours(filled, contours, i, 255, -1)

        # Cut out holes above threshold
        for i in range(len(contours)):
            if h[i][3] != -1:
                area = cv2.contourArea(contours[i])
                if area >= min_area:
                    cv2.drawContours(filled, contours, i, 0, -1)

        # Load extracted image and composite
        extracted_path = mask_path.parent / mask_path.name.replace('mask_', 'extracted_')
        if extracted_path.exists():
            ext = Image.open(extracted_path).convert('RGBA')
            ext_arr = np.array(ext)

            # Create visualization: extracted image masked by the filtered outline
            vis_rgba = ext_arr.copy()
            vis_rgba[:, :, 3] = np.minimum(vis_rgba[:, :, 3], filled)

            label = "original" if min_area_pct == 0 else f"min{min_area_pct}pct"
            Image.fromarray(vis_rgba).save(output_dir / f"filled_{name}_{label}.png")


def main():
    test_dir = Path(__file__).parent
    session_dir = test_dir / "9f4c778e-8395-4685-ad3a-5800258a347c"

    if not session_dir.exists():
        print(f"Session dir not found: {session_dir}")
        return

    output_dir = test_dir / "outline_output"
    output_dir.mkdir(exist_ok=True)

    # Focus on bridge and house
    targets = [
        session_dir / "layer_1" / "mask_center-bridge.png",
        session_dir / "layer_2" / "mask_middle-left-house.png",
    ]

    for mask_path in targets:
        if mask_path.exists():
            print(f"\n=== {mask_path.stem} ===")
            analyze_outline(mask_path, output_dir)
        else:
            print(f"Not found: {mask_path}")

    # Also process all masks
    print("\n\n=== All elements ===")
    for layer_dir in sorted(session_dir.glob("layer_*")):
        for mask_path in sorted(layer_dir.glob("mask_*.png")):
            print(f"\n  {mask_path.parent.name}/{mask_path.stem}")
            analyze_outline(mask_path, output_dir)


if __name__ == "__main__":
    main()
