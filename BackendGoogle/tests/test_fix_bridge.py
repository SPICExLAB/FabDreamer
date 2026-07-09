"""
Fix bridge outline using Gemini image editing.

1. Send extracted bridge PNG to Gemini to fill internal gaps
2. Derive clean mask from the fixed image
3. Generate outline SVG from the clean mask

Usage:
    cd BackendGoogle/Test
    python test_fix_bridge.py
"""

import sys
import asyncio
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
from PIL import Image
import cv2
from dotenv import load_dotenv
from google import genai
from google.genai import types

# Load .env from BackendGoogle
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

SESSION_DIR = Path(__file__).parent / "9f4c778e-8395-4685-ad3a-5800258a347c"
OUTPUT_DIR = Path(__file__).parent / "fix_bridge_output"


def fix_with_morphology(mask_path, output_dir):
    """Try morphological close to fill small gaps (no API needed)."""
    mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    h, w = mask.shape

    # Morphological close fills small holes
    for kernel_size in [5, 15, 25]:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
        closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        cv2.imwrite(str(output_dir / f"morph_close_k{kernel_size}.png"), closed)

        # Count contours
        contours, hierarchy = cv2.findContours(closed, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
        holes = sum(1 for i in range(len(contours)) if hierarchy[0][i][3] != -1) if hierarchy is not None else 0
        print(f"  morph close k={kernel_size}: {len(contours)} contours, {holes} holes")

    return closed


def fix_with_convex_hull(mask_path, output_dir):
    """Use convex hull of the mask — fills all internal gaps."""
    mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    h, w = mask.shape

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    hull_mask = np.zeros((h, w), dtype=np.uint8)
    for cnt in contours:
        hull = cv2.convexHull(cnt)
        cv2.drawContours(hull_mask, [hull], -1, 255, -1)

    cv2.imwrite(str(output_dir / "convex_hull.png"), hull_mask)

    contours2, hierarchy2 = cv2.findContours(hull_mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    holes = sum(1 for i in range(len(contours2)) if hierarchy2[0][i][3] != -1) if hierarchy2 is not None else 0
    print(f"  convex hull: {len(contours2)} contours, {holes} holes")

    return hull_mask


def fix_with_fill_external(mask_path, output_dir):
    """Fill mask: keep only external contour, discard all holes."""
    mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    h, w = mask.shape

    # Find only external contours
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    filled = np.zeros((h, w), dtype=np.uint8)
    cv2.drawContours(filled, contours, -1, 255, -1)

    cv2.imwrite(str(output_dir / "fill_external.png"), filled)

    # Verify
    contours2, hierarchy2 = cv2.findContours(filled, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    holes = sum(1 for i in range(len(contours2)) if hierarchy2[0][i][3] != -1) if hierarchy2 is not None else 0
    print(f"  fill external: {len(contours2)} contours, {holes} holes")

    return filled


async def fix_with_gemini(extracted_path, mask_path, output_dir):
    """Use Gemini to redraw the bridge as a solid silhouette."""
    import os

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("  GEMINI_API_KEY not set, skipping")
        return None

    client = genai.Client(api_key=api_key)

    # Load extracted image
    img_data = extracted_path.read_bytes()

    prompt = """This is an extracted element from an image (bridge on transparent background).
I need you to redraw ONLY the silhouette/outline of this bridge as a SOLID filled shape.
- Fill in ALL internal gaps (between railings, planks, support beams)
- The result should be a SOLID bridge shape with NO holes or gaps
- Keep the EXACT same outer boundary/silhouette
- Draw it as a solid white shape on a bright green (#00FF00) background
- Match the exact position and size of the original bridge"""

    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash-image",
            contents=[
                types.Content(
                    role="user",
                    parts=[
                        types.Part.from_text(text=prompt),
                        types.Part.from_bytes(data=img_data, mime_type="image/png"),
                    ]
                )
            ],
            config=types.GenerateContentConfig(
                temperature=0.5,
                max_output_tokens=8192,
                response_modalities=["IMAGE", "TEXT"],
            )
        )

        # Extract image
        if response.candidates and response.candidates[0].content:
            for part in response.candidates[0].content.parts:
                if part.inline_data is not None:
                    img_bytes = part.inline_data.data
                    out_path = output_dir / "gemini_fixed.png"
                    out_path.write_bytes(img_bytes)
                    print(f"  Gemini result saved: {out_path}")

                    # Convert to mask (white on green bg → binary mask)
                    img = Image.open(out_path).convert('RGB')
                    arr = np.array(img)
                    # Detect non-green pixels as the shape
                    green_mask = (arr[:, :, 1] > 200) & (arr[:, :, 0] < 100) & (arr[:, :, 2] < 100)
                    shape_mask = (~green_mask).astype(np.uint8) * 255
                    cv2.imwrite(str(output_dir / "gemini_mask.png"), shape_mask)

                    contours, hierarchy = cv2.findContours(shape_mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
                    holes = sum(1 for i in range(len(contours)) if hierarchy[0][i][3] != -1) if hierarchy is not None else 0
                    print(f"  Gemini mask: {len(contours)} contours, {holes} holes")

                    return shape_mask
                elif hasattr(part, 'text') and part.text:
                    print(f"  Gemini text response: {part.text[:200]}")

        print("  No image in Gemini response")
    except Exception as e:
        print(f"  Gemini error: {e}")

    return None


def generate_outline_svg(mask, output_path, simplify_tolerance=2.0):
    """Generate outline SVG from mask (external contours only, no holes)."""
    _, binary = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)
    h, w = binary.shape

    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    svg_parts = [
        f'<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',
    ]

    for cnt in contours:
        simplified = cv2.approxPolyDP(cnt, simplify_tolerance, True)
        if len(simplified) < 3:
            continue
        points = simplified.reshape(-1, 2)
        d = f"M {points[0][0]},{points[0][1]}"
        for p in points[1:]:
            d += f" L {p[0]},{p[1]}"
        d += " Z"
        svg_parts.append(f'  <path d="{d}" fill="white" stroke="none"/>')

    svg_parts.append('</svg>')
    svg_str = '\n'.join(svg_parts)

    output_path.write_text(svg_str)
    print(f"  SVG saved: {output_path} ({len(contours)} paths)")
    return svg_str


async def main():
    OUTPUT_DIR.mkdir(exist_ok=True)

    mask_path = SESSION_DIR / "layer_1" / "mask_center-bridge.png"
    extracted_path = SESSION_DIR / "layer_1" / "extracted_center-bridge.png"

    print("=== Method 1: Morphological close ===")
    morph_mask = fix_with_morphology(mask_path, OUTPUT_DIR)

    print("\n=== Method 2: Convex hull ===")
    hull_mask = fix_with_convex_hull(mask_path, OUTPUT_DIR)

    print("\n=== Method 3: Fill external contours (drop all holes) ===")
    ext_mask = fix_with_fill_external(mask_path, OUTPUT_DIR)

    print("\n=== Method 4: Gemini image fix ===")
    gemini_mask = await fix_with_gemini(extracted_path, mask_path, OUTPUT_DIR)

    # Generate outline SVGs for each method
    print("\n=== Generating outline SVGs ===")
    generate_outline_svg(morph_mask, OUTPUT_DIR / "outline_morph.svg")
    generate_outline_svg(hull_mask, OUTPUT_DIR / "outline_hull.svg")
    generate_outline_svg(ext_mask, OUTPUT_DIR / "outline_external.svg")
    if gemini_mask is not None:
        generate_outline_svg(gemini_mask, OUTPUT_DIR / "outline_gemini.svg")

    # Visualize all masks side by side
    original = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    print(f"\nOriginal mask: {original.shape}")
    print("\nDone! Check {OUTPUT_DIR} for results.")


if __name__ == "__main__":
    asyncio.run(main())
