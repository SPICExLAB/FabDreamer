#!/usr/bin/env python3
"""
Test: Rough Mask Generation for SAM2 Guidance

Tests whether Gemini-generated rough masks can improve SAM2 segmentation.

Flow:
1. Load test image
2. Gemini analyzes layers → element names + descriptions
3. Gemini detects bounding boxes + point prompts
4. For each element: Gemini generates rough mask (outline/silhouette)
5. Save all intermediates for visual inspection
6. Optionally test SAM2 with vs without rough mask

Output:
  test_outline_output/
    00_original.png
    01_analysis.json              - Layer analysis result
    02_detections.json            - Bounding box detections
    elements/
      {name}/
        01_bbox.png               - Image with bbox drawn
        02_rough_mask.png         - Gemini rough mask (white silhouette)
        03_rough_mask_binary.png  - Cleaned binary mask
        04_sam2_without.png       - SAM2 mask WITHOUT rough mask (baseline)
        05_sam2_with.png          - SAM2 mask WITH rough mask (test)
        06_comparison.png         - Side-by-side comparison

Usage:
  # Rough mask only (no SAM2 needed):
  python tests/test_rough_mask.py --image path/to/image.png

  # Full test with SAM2 comparison:
  python tests/test_rough_mask.py --image path/to/image.png --sam2-url http://localhost:8666

  # Use existing analysis (skip Gemini analysis step):
  python tests/test_rough_mask.py --image path/to/image.png --analysis path/to/analysis.json
"""

import asyncio
import argparse
import base64
import json
import os
import sys
import io
import re
import time
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import numpy as np

# Add parent dir to path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from dotenv import load_dotenv
load_dotenv()

from google import genai
from google.genai import types
from config.models import VISION_PRIMARY, VISION_FALLBACK, IMAGE_PRIMARY, IMAGE_FALLBACK
from prompts.prompts import (
    LAYER_ANALYSIS_PROMPT,
    BATCH_DETECTION_PROMPT,
    ROUGH_MASK_PROMPT,
)

# Outline points prompt — asks vision model to trace element boundary as polygon
OUTLINE_POINTS_PROMPT = """You are an API. Return ONLY a JSON object. No conversational text.

Look at this image. I need you to trace the OUTLINE of the element "{element_name}" with polygon points.

Element description: {element_description}
Approximate bounding box (y_min, x_min, y_max, x_max normalized 0-1000): {box}

TASK: Return 20-40 points [y, x] that trace the BOUNDARY of "{element_name}" in clockwise order.
- Start from the topmost point and go clockwise
- Points should follow the ACTUAL EDGE of the element as closely as possible
- Include enough points to capture the shape — more points on complex/curved edges, fewer on straight edges
- For elements touching the image edge, trace along the image edge too
- Paint ONLY "{element_name}", not neighboring objects that happen to overlap the bounding box

All coordinates normalized 0-1000.

Return JSON:
{{
  "label": "{element_name}",
  "outline_points": [[y1,x1], [y2,x2], ...]
}}"""

OUTPUT_DIR = Path("test_outline_output")


def sanitize(name: str) -> str:
    return re.sub(r'[^\w\-]', '_', name.lower().strip())


def draw_bbox(image_data: bytes, box: list, label: str = "") -> bytes:
    """Draw bounding box on image. box is [y_min, x_min, y_max, x_max] normalized 0-1000."""
    img = Image.open(io.BytesIO(image_data)).convert('RGB')
    draw = ImageDraw.Draw(img)
    w, h = img.size
    y_min, x_min, y_max, x_max = box
    coords = [x_min * w / 1000, y_min * h / 1000, x_max * w / 1000, y_max * h / 1000]
    draw.rectangle(coords, outline='red', width=3)
    if label:
        draw.text((coords[0], coords[1] - 15), label, fill='red')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def draw_points(image_data: bytes, positive_points: list, negative_points: list, box: list) -> bytes:
    """Draw point prompts on image."""
    img = Image.open(io.BytesIO(image_data)).convert('RGB')
    draw = ImageDraw.Draw(img)
    w, h = img.size

    # Draw bbox
    y_min, x_min, y_max, x_max = box
    coords = [x_min * w / 1000, y_min * h / 1000, x_max * w / 1000, y_max * h / 1000]
    draw.rectangle(coords, outline='red', width=2)

    # Draw positive points (green)
    for pt in (positive_points or []):
        y, x = pt
        px, py = x * w / 1000, y * h / 1000
        draw.ellipse([px - 5, py - 5, px + 5, py + 5], fill='green', outline='white')

    # Draw negative points (red)
    for pt in (negative_points or []):
        y, x = pt
        px, py = x * w / 1000, y * h / 1000
        draw.ellipse([px - 5, py - 5, px + 5, py + 5], fill='red', outline='white')

    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def make_binary_mask(rough_mask_bytes: bytes, image_data: bytes, box: list) -> bytes:
    """Convert Gemini rough mask to clean binary mask (similar to diff_mask_extract)."""
    original = Image.open(io.BytesIO(image_data)).convert('RGB')
    rough = Image.open(io.BytesIO(rough_mask_bytes)).convert('RGB')
    w, h = original.size

    if rough.size != original.size:
        rough = rough.resize(original.size, Image.Resampling.LANCZOS)

    orig_np = np.array(original)
    rough_np = np.array(rough)

    rough_gray = np.mean(rough_np, axis=2)
    diff = np.abs(rough_np.astype(int) - orig_np.astype(int))
    diff_sum = diff.sum(axis=2)

    # Detect mask type
    black_pixels = np.sum(
        (rough_np[:, :, 0] < 20) & (rough_np[:, :, 1] < 20) & (rough_np[:, :, 2] < 20)
    )
    black_ratio = black_pixels / (rough_np.shape[0] * rough_np.shape[1])

    if black_ratio > 0.3:
        # TRUE_BINARY: white on black background
        is_element = (rough_gray > 200) & (diff_sum > 50)
        mask_type = "TRUE_BINARY"
    else:
        # OVERLAY: white painted over original
        is_element = (rough_gray > 200) & (diff_sum > 100)
        mask_type = "OVERLAY"

    # Apply bounding box
    y_min, x_min, y_max, x_max = box
    px_x_min, px_x_max = int(x_min / 1000 * w), int(x_max / 1000 * w)
    px_y_min, px_y_max = int(y_min / 1000 * h), int(y_max / 1000 * h)
    box_mask = np.zeros_like(is_element)
    box_mask[px_y_min:px_y_max, px_x_min:px_x_max] = True
    is_element = is_element & box_mask

    binary = (is_element * 255).astype(np.uint8)
    coverage = np.sum(binary > 128) / binary.size

    print(f"    Mask type: {mask_type}, coverage: {coverage:.1%}")

    mask_img = Image.fromarray(binary, mode='L')
    buf = io.BytesIO()
    mask_img.save(buf, format='PNG')
    return buf.getvalue()


def make_programmatic_mask(box: list, positive_points: list, negative_points: list,
                           image_width: int, image_height: int) -> bytes:
    """Generate a rough mask programmatically from detection data (no API call).

    Strategy: Create filled ellipse from bbox, then use convex hull of positive points
    to refine the shape.
    """
    import cv2

    mask = np.zeros((image_height, image_width), dtype=np.uint8)

    y_min, x_min, y_max, x_max = box
    px_x_min = int(x_min / 1000 * image_width)
    px_x_max = int(x_max / 1000 * image_width)
    px_y_min = int(y_min / 1000 * image_height)
    px_y_max = int(y_max / 1000 * image_height)

    # Method 1: Filled ellipse inscribed in bbox (good for organic shapes)
    center_x = (px_x_min + px_x_max) // 2
    center_y = (px_y_min + px_y_max) // 2
    axis_x = (px_x_max - px_x_min) // 2
    axis_y = (px_y_max - px_y_min) // 2
    cv2.ellipse(mask, (center_x, center_y), (axis_x, axis_y), 0, 0, 360, 255, -1)

    # Method 2: If we have 3+ positive points, make convex hull and blend
    if positive_points and len(positive_points) >= 3:
        pts = []
        for pt in positive_points:
            y, x = pt
            px = int(x / 1000 * image_width)
            py = int(y / 1000 * image_height)
            pts.append([px, py])
        pts = np.array(pts, dtype=np.int32)

        # Expand convex hull outward by 20% of bbox size
        hull = cv2.convexHull(pts)
        hull_center = hull.mean(axis=0)
        expanded = ((hull - hull_center) * 1.4 + hull_center).astype(np.int32)

        hull_mask = np.zeros_like(mask)
        cv2.fillConvexPoly(hull_mask, expanded, 255)

        # Union of ellipse and expanded hull
        mask = np.maximum(mask, hull_mask)

    # Gaussian blur for smooth edges
    mask = cv2.GaussianBlur(mask, (15, 15), 0)
    _, mask = cv2.threshold(mask, 50, 255, cv2.THRESH_BINARY)

    coverage = np.sum(mask > 128) / mask.size
    print(f"    Programmatic mask: coverage={coverage:.1%}")

    mask_img = Image.fromarray(mask, mode='L')
    buf = io.BytesIO()
    mask_img.save(buf, format='PNG')
    return buf.getvalue()


def rasterize_polygon(outline_points: list, image_width: int, image_height: int) -> bytes:
    """Convert outline points (normalized 0-1000) to a binary mask image."""
    mask = Image.new('L', (image_width, image_height), 0)
    draw = ImageDraw.Draw(mask)

    # Convert [y, x] normalized to pixel (x, y) for PIL
    pixel_coords = []
    for pt in outline_points:
        y_norm, x_norm = pt
        px = int(x_norm / 1000 * image_width)
        py = int(y_norm / 1000 * image_height)
        pixel_coords.append((px, py))

    if len(pixel_coords) >= 3:
        draw.polygon(pixel_coords, fill=255)

    buf = io.BytesIO()
    mask.save(buf, format='PNG')
    return buf.getvalue()


def draw_outline_points(image_data: bytes, outline_points: list, label: str = "") -> bytes:
    """Draw outline points and polygon on image for visualization."""
    img = Image.open(io.BytesIO(image_data)).convert('RGB')
    draw = ImageDraw.Draw(img)
    w, h = img.size

    # Convert to pixel coords
    pixel_coords = []
    for pt in outline_points:
        y_norm, x_norm = pt
        px = int(x_norm / 1000 * w)
        py = int(y_norm / 1000 * h)
        pixel_coords.append((px, py))

    # Draw polygon outline
    if len(pixel_coords) >= 3:
        draw.polygon(pixel_coords, outline='lime', fill=None)
        # Close the polygon
        for i in range(len(pixel_coords)):
            p1 = pixel_coords[i]
            p2 = pixel_coords[(i + 1) % len(pixel_coords)]
            draw.line([p1, p2], fill='lime', width=2)

    # Draw points
    for i, (px, py) in enumerate(pixel_coords):
        r = 4
        draw.ellipse([px - r, py - r, px + r, py + r], fill='yellow', outline='red')
        # Number every 5th point
        if i % 5 == 0:
            draw.text((px + 5, py - 5), str(i), fill='yellow')

    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


class RoughMaskTester:
    def __init__(self, sam2_url=None):
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise ValueError("GEMINI_API_KEY not set in .env")
        self.client = genai.Client(api_key=api_key)
        self.sam2_url = sam2_url

    def _call_vision(self, contents, config):
        """Call vision model with fallback."""
        for model in [VISION_PRIMARY, VISION_FALLBACK]:
            try:
                response = self.client.models.generate_content(
                    model=model, contents=contents, config=config
                )
                print(f"  Vision call OK with {model}")
                return response
            except Exception as e:
                if model == VISION_PRIMARY:
                    print(f"  {model} failed: {e}, trying fallback...")
                else:
                    raise

    def analyze_layers(self, image_data: bytes) -> dict:
        """Step 1: Analyze image for layers."""
        print("\n=== Step 1: Layer Analysis ===")
        mime = "image/png" if image_data[:3] != b'\xff\xd8\xff' else "image/jpeg"

        response = self._call_vision(
            contents=[types.Content(role="user", parts=[
                types.Part.from_text(text=LAYER_ANALYSIS_PROMPT),
                types.Part.from_bytes(data=image_data, mime_type=mime)
            ])],
            config=types.GenerateContentConfig(
                temperature=0, max_output_tokens=16384,
                media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
            )
        )

        text = None
        if response.candidates:
            for part in response.candidates[0].content.parts:
                if hasattr(part, 'text') and part.text:
                    text = part.text

        if "```json" in text:
            text = text.split("```json")[1].split("```")[0]
        elif "```" in text:
            text = text.split("```")[1].split("```")[0]

        result = json.loads(text.strip())
        layers = result.get("layers", [])
        total_elements = sum(len(l.get("elements", [])) for l in layers)
        print(f"  Found {len(layers)} layers with {total_elements} total elements")
        for l in layers:
            print(f"  Layer {l['layer']}: {[e['name'] for e in l.get('elements', [])]}")
        return result

    def detect_elements(self, image_data: bytes, elements: list) -> list:
        """Step 2: Detect bounding boxes for elements."""
        print(f"\n=== Step 2: Detect {len(elements)} elements ===")
        mime = "image/png" if image_data[:3] != b'\xff\xd8\xff' else "image/jpeg"

        element_list = "\n".join([
            f'  - "{e["name"]}": {e.get("description", "")}'
            for e in elements
        ])
        prompt = BATCH_DETECTION_PROMPT.format(
            num_elements=len(elements),
            element_list=element_list
        )

        response = self._call_vision(
            contents=[types.Content(role="user", parts=[
                types.Part.from_text(text=prompt),
                types.Part.from_bytes(data=image_data, mime_type=mime)
            ])],
            config=types.GenerateContentConfig(
                temperature=0, max_output_tokens=16384,
                media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
                thinking_config=types.ThinkingConfig(thinking_budget=2048),
            )
        )

        text = None
        if response.candidates:
            for part in response.candidates[0].content.parts:
                if hasattr(part, 'text') and part.text:
                    text = part.text  # Use last text part

        if "```json" in text:
            text = text.split("```json")[1].split("```")[0]
        elif "```" in text:
            text = text.split("```")[1].split("```")[0]

        detections = json.loads(text.strip())
        if isinstance(detections, dict):
            detections = detections.get("detections", [])

        found = [d for d in detections if d.get("found", True)]
        print(f"  Found {len(found)}/{len(elements)} elements")
        for d in found:
            print(f"  {d['label']}: box={d['box_2d']}, gaps={d.get('has_internal_gaps', False)}")
        return found

    def detect_outline(self, image_data: bytes, name: str, description: str, box: list) -> list:
        """Detect outline points for one element using vision model (no image generation)."""
        print(f"\n  Detecting outline points for: {name}")
        mime = "image/png" if image_data[:3] != b'\xff\xd8\xff' else "image/jpeg"

        prompt = OUTLINE_POINTS_PROMPT.format(
            element_name=name,
            element_description=description,
            box=box
        )

        for attempt in range(3):
            if attempt > 0:
                wait = 10 * (2 ** (attempt - 1))
                print(f"    Retry {attempt}/2 in {wait}s...")
                time.sleep(wait)
            else:
                time.sleep(1)

            try:
                response = self._call_vision(
                    contents=[types.Content(role="user", parts=[
                        types.Part.from_text(text=prompt),
                        types.Part.from_bytes(data=image_data, mime_type=mime)
                    ])],
                    config=types.GenerateContentConfig(
                        temperature=0,
                        max_output_tokens=16384,
                        media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
                        thinking_config=types.ThinkingConfig(thinking_budget=2048),
                    )
                )

                text = None
                if response.candidates:
                    for part in response.candidates[0].content.parts:
                        if hasattr(part, 'text') and part.text:
                            text = part.text

                if text:
                    if "```json" in text:
                        text = text.split("```json")[1].split("```")[0]
                    elif "```" in text:
                        text = text.split("```")[1].split("```")[0]

                    result = json.loads(text.strip())
                    points = result.get("outline_points", [])
                    print(f"    Got {len(points)} outline points")
                    return points

            except Exception as e:
                if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                    print(f"    Rate limited (attempt {attempt + 1}/3)")
                    continue
                print(f"    Failed: {e}")
                break

        return []

    def generate_rough_mask(self, image_data: bytes, name: str, description: str, box: list) -> bytes:
        """Step 3: Generate rough mask for one element."""
        print(f"\n  Generating rough mask for: {name}")
        mime = "image/png" if image_data[:3] != b'\xff\xd8\xff' else "image/jpeg"

        prompt = ROUGH_MASK_PROMPT.format(
            element_name=name,
            element_description=description,
            box=box
        )

        # Try IMAGE_PRIMARY first, then fallback
        for model in [IMAGE_PRIMARY, IMAGE_FALLBACK]:
            for attempt in range(3):
                if attempt > 0:
                    wait = 10 * (2 ** (attempt - 1))
                    print(f"    Retry {attempt}/2 in {wait}s...")
                    time.sleep(wait)
                else:
                    time.sleep(2)  # Base rate limit protection

                try:
                    response = self.client.models.generate_content(
                        model=model,
                        contents=[
                            types.Part.from_text(text=prompt),
                            types.Part.from_bytes(data=image_data, mime_type=mime)
                        ],
                        config=types.GenerateContentConfig(
                            temperature=0.0,
                            max_output_tokens=8192,
                            response_modalities=["IMAGE", "TEXT"],
                        )
                    )

                    if response.candidates and response.candidates[0].content:
                        for part in response.candidates[0].content.parts or []:
                            if hasattr(part, 'inline_data') and part.inline_data:
                                print(f"    Got rough mask from {model}")
                                return part.inline_data.data

                    print(f"    WARNING: No image from {model}")
                    break  # Try next model

                except Exception as e:
                    if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                        print(f"    Rate limited on {model} (attempt {attempt + 1}/3)")
                        continue
                    print(f"    {model} failed: {e}, trying next...")
                    break  # Try next model

        print(f"    FAILED: All models exhausted")
        return None

    async def test_sam2(self, image_data: bytes, box: list, label: str,
                        positive_points=None, negative_points=None,
                        mask_input=None) -> bytes:
        """Test SAM2 segmentation with optional mask input."""
        if not self.sam2_url:
            return None

        import httpx

        image_b64 = base64.b64encode(image_data).decode('utf-8')
        img = Image.open(io.BytesIO(image_data))
        w, h = img.size

        # Convert box from normalized to pixels [x_min, y_min, x_max, y_max]
        y_min, x_min, y_max, x_max = box
        pixel_box = [
            int(x_min * w / 1000), int(y_min * h / 1000),
            int(x_max * w / 1000), int(y_max * h / 1000)
        ]

        # Build point prompts
        points = []
        point_labels = []
        if positive_points:
            for pt in positive_points:
                y, x = pt
                points.append([int(x * w / 1000), int(y * h / 1000)])
                point_labels.append(1)
        if negative_points:
            for pt in negative_points:
                y, x = pt
                points.append([int(x * w / 1000), int(y * h / 1000)])
                point_labels.append(0)

        request_data = {
            "image": f"data:image/png;base64,{image_b64}",
            "boxes": [pixel_box],
            "labels": [label],
            "multimask_output": False,
        }
        if points:
            request_data["points"] = points
            request_data["point_labels"] = point_labels
        if mask_input:
            mask_b64 = base64.b64encode(mask_input).decode('utf-8')
            request_data["mask_input"] = f"data:image/png;base64,{mask_b64}"

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{self.sam2_url}/segment",
                    json=request_data,
                    timeout=60.0
                )
                if resp.status_code == 200:
                    data = resp.json()
                    masks = data.get("masks", [])
                    if masks:
                        mask_b64 = masks[0]["mask"]
                        if "base64," in mask_b64:
                            mask_b64 = mask_b64.split("base64,")[1]
                        print(f"    SAM2 mask score: {masks[0]['score']:.3f}")
                        return base64.b64decode(mask_b64)
                else:
                    print(f"    SAM2 error: {resp.status_code}")
        except Exception as e:
            print(f"    SAM2 connection failed: {e}")
        return None


async def main():
    parser = argparse.ArgumentParser(description="Test rough mask generation for SAM2 guidance")
    parser.add_argument("--image", required=True, help="Path to test image")
    parser.add_argument("--sam2-url", default=None, help="SAM2 server URL (e.g. http://localhost:8666)")
    parser.add_argument("--analysis", default=None, help="Path to existing analysis JSON (skip Gemini analysis)")
    parser.add_argument("--detections", default=None, help="Path to existing detections JSON (skip detection)")
    parser.add_argument("--layer", type=int, default=1, help="Which layer to test (default: 1)")
    parser.add_argument("--skip-gemini", action="store_true", help="Skip Gemini rough mask (only test programmatic)")
    parser.add_argument("--element", default=None, help="Only test this element name (e.g. right-foreground-pine-tree)")
    args = parser.parse_args()

    # Load image
    image_path = Path(args.image)
    if not image_path.exists():
        print(f"Image not found: {image_path}")
        sys.exit(1)

    image_data = image_path.read_bytes()
    print(f"Loaded image: {image_path} ({len(image_data)} bytes)")

    # Setup output
    OUTPUT_DIR.mkdir(exist_ok=True)
    (OUTPUT_DIR / "elements").mkdir(exist_ok=True)
    (OUTPUT_DIR / "00_original.png").write_bytes(image_data)

    tester = RoughMaskTester(sam2_url=args.sam2_url)

    # Step 1: Analysis
    if args.analysis:
        analysis = json.loads(Path(args.analysis).read_text())
        print(f"Loaded existing analysis from {args.analysis}")
    else:
        t0 = time.time()
        analysis = tester.analyze_layers(image_data)
        print(f"  Analysis took {time.time() - t0:.1f}s")

    (OUTPUT_DIR / "01_analysis.json").write_text(json.dumps(analysis, indent=2))

    # Step 2: Detect elements for target layer
    layers = analysis.get("layers", [])
    target_layer = None
    for l in layers:
        if l["layer"] == args.layer:
            target_layer = l
            break

    if not target_layer:
        print(f"Layer {args.layer} not found. Available: {[l['layer'] for l in layers]}")
        sys.exit(1)

    elements = target_layer.get("elements", [])
    print(f"\nTesting layer {args.layer} with {len(elements)} elements")

    if args.detections:
        detections = json.loads(Path(args.detections).read_text())
        print(f"Loaded existing detections from {args.detections}")
    else:
        t0 = time.time()
        detections = tester.detect_elements(image_data, elements)
        print(f"  Detection took {time.time() - t0:.1f}s")
        (OUTPUT_DIR / "02_detections.json").write_text(json.dumps(detections, indent=2))

    # Step 3: For each detected element, generate rough mask
    print(f"\n=== Step 3: Generate Rough Masks ===")

    for det in detections:
        name = det["label"]
        if args.element and name != args.element:
            continue
        box = det["box_2d"]
        pos_pts = det.get("positive_points", [])
        neg_pts = det.get("negative_points", [])
        safe_name = sanitize(name)

        elem_dir = OUTPUT_DIR / "elements" / safe_name
        elem_dir.mkdir(exist_ok=True, parents=True)

        # Find description from original elements
        desc = ""
        for e in elements:
            if e["name"] == name:
                desc = e.get("description", "")
                break

        # Save bbox visualization
        bbox_img = draw_bbox(image_data, box, name)
        (elem_dir / "01_bbox.png").write_bytes(bbox_img)

        # Save points visualization
        points_img = draw_points(image_data, pos_pts, neg_pts, box)
        (elem_dir / "01b_points.png").write_bytes(points_img)

        # === Programmatic mask (free, no API call) ===
        img = Image.open(io.BytesIO(image_data))
        prog_mask = make_programmatic_mask(box, pos_pts, neg_pts, img.width, img.height)
        (elem_dir / "02a_programmatic_mask.png").write_bytes(prog_mask)

        # === Gemini rough mask (API call) ===
        if not args.skip_gemini:
            t0 = time.time()
            rough_mask = tester.generate_rough_mask(image_data, name, desc, box)
            elapsed = time.time() - t0

            if rough_mask:
                (elem_dir / "02b_gemini_rough_mask.png").write_bytes(rough_mask)
                print(f"    Gemini rough mask saved ({elapsed:.1f}s)")

                binary_mask = make_binary_mask(rough_mask, image_data, box)
                (elem_dir / "03_gemini_binary_mask.png").write_bytes(binary_mask)
        else:
            print(f"    Skipping Gemini rough mask")

        # === Outline points approach (vision API, no image generation) ===
        t0 = time.time()
        outline_pts = tester.detect_outline(image_data, name, desc, box)
        elapsed = time.time() - t0

        if outline_pts and len(outline_pts) >= 3:
            img = Image.open(io.BytesIO(image_data))

            # Save visualization of outline points on image
            outline_viz = draw_outline_points(image_data, outline_pts, name)
            (elem_dir / "04a_outline_points.png").write_bytes(outline_viz)

            # Rasterize to binary mask
            outline_mask = rasterize_polygon(outline_pts, img.width, img.height)
            (elem_dir / "04b_outline_mask.png").write_bytes(outline_mask)

            # Coverage stats
            mask_arr = np.array(Image.open(io.BytesIO(outline_mask)))
            coverage = np.sum(mask_arr > 128) / mask_arr.size
            print(f"    Outline mask: {len(outline_pts)} points, coverage={coverage:.1%} ({elapsed:.1f}s)")
        else:
            print(f"    Outline detection failed or too few points")

        # Test SAM2 if available
        if args.sam2_url:
            print(f"\n    Testing SAM2 for {name}...")

            # A: Baseline — SAM2 with bbox + points only
            print(f"    [A] Baseline: bbox + points only")
            sam2_baseline = await tester.test_sam2(
                image_data, box, name,
                positive_points=pos_pts, negative_points=neg_pts
            )
            if sam2_baseline:
                (elem_dir / "04a_sam2_baseline.png").write_bytes(sam2_baseline)

            # B: SAM2 with programmatic mask
            print(f"    [B] With programmatic mask:")
            sam2_prog = await tester.test_sam2(
                image_data, box, name,
                positive_points=pos_pts, negative_points=neg_pts,
                mask_input=prog_mask
            )
            if sam2_prog:
                (elem_dir / "04b_sam2_programmatic.png").write_bytes(sam2_prog)

            # Create comparison: original | baseline | with programmatic mask
            results = [("Original", image_data), ("SAM2 baseline", sam2_baseline), ("SAM2 + prog mask", sam2_prog)]
            results = [(label, d) for label, d in results if d]
            if len(results) >= 2:
                orig = Image.open(io.BytesIO(image_data)).convert('RGB')
                w, h = orig.size
                comparison = Image.new('RGB', (w * len(results), h))
                draw = ImageDraw.Draw(comparison)
                for i, (label, data) in enumerate(results):
                    img = Image.open(io.BytesIO(data)).convert('RGB')
                    if img.size != (w, h):
                        img = img.resize((w, h))
                    comparison.paste(img, (w * i, 0))
                    draw.text((w * i + 10, 10), label, fill='red')
                buf = io.BytesIO()
                comparison.save(buf, format='PNG')
                (elem_dir / "05_comparison.png").write_bytes(buf.getvalue())
                print(f"    Comparison saved!")

    print(f"\n=== Done! Output in {OUTPUT_DIR}/ ===")
    print(f"Open {OUTPUT_DIR}/elements/ to inspect rough masks")


if __name__ == "__main__":
    asyncio.run(main())
