#!/usr/bin/env python3
"""
Simulate the real pipeline for layers 1 & 2 of session 343da096.

For each element:
1. Call Gemini to detect bounding box + point prompts (same as real pipeline)
2. Generate rough mask with BOTH methods (old max-union vs new intersection)
3. Save side-by-side comparison images

Usage:
  cd BackendGoogle
  source venv/bin/activate
  python tests/test_rough_mask_pipeline.py
"""

import asyncio
import json
import io
import os
import sys
import logging
import numpy as np
import cv2
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# Setup path
sys.path.insert(0, str(Path(__file__).parent.parent))

from google import genai
from google.genai import types
from config.models import VISION_PRIMARY, VISION_FALLBACK
from prompts.prompts import BATCH_DETECTION_PROMPT

logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger(__name__)

# ── Config ──────────────────────────────────────────────────────────
SESSION = "343da096-24cd-48f2-8b26-46ab2597f8f3"
OUTPUT_DIR = Path("tests/rough_mask_pipeline_output")
COLOR_DIST_THRESH = 35


def generate_rough_mask(image_data, bbox, pos_points, method="intersect"):
    """Generate rough mask. method = 'max_union' or 'intersect'."""
    if not pos_points:
        return None

    img = np.array(Image.open(io.BytesIO(image_data)).convert('RGB'))
    img_bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    h, w = img_bgr.shape[:2]

    y_min, x_min, y_max, x_max = bbox
    by_min = int(y_min / 1000 * h)
    bx_min = int(x_min / 1000 * w)
    by_max = int(y_max / 1000 * h)
    bx_max = int(x_max / 1000 * w)

    pos_px = [(int(p[0]/1000*h), int(p[1]/1000*w)) for p in pos_points]

    # Adaptive Canny
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    bbox_gray = gray[by_min:by_max, bx_min:bx_max]
    if bbox_gray.size == 0:
        return None
    otsu_thresh, _ = cv2.threshold(bbox_gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    low = max(10, int(otsu_thresh * 0.33))
    high = max(30, int(otsu_thresh * 0.66))
    edges = cv2.Canny(blurred, low, high)
    edges_closed = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    # Color barrier
    img_lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2Lab).astype(np.float32)

    if method == "max_union":
        color_barrier = np.zeros((h, w), dtype=np.uint8)
        for py, px in pos_px:
            if not (0 <= py < h and 0 <= px < w): continue
            seed = img_lab[py, px]
            diff = np.sqrt(np.sum((img_lab - seed) ** 2, axis=2))
            far = (diff > COLOR_DIST_THRESH).astype(np.uint8) * 255
            color_barrier = np.maximum(color_barrier, far)
    else:  # intersect
        color_barrier = np.full((h, w), 255, dtype=np.uint8)
        valid = 0
        for py, px in pos_px:
            if not (0 <= py < h and 0 <= px < w): continue
            valid += 1
            seed = img_lab[py, px]
            diff = np.sqrt(np.sum((img_lab - seed) ** 2, axis=2))
            far = (diff > COLOR_DIST_THRESH).astype(np.uint8) * 255
            color_barrier = np.minimum(color_barrier, far)
        if valid == 0:
            color_barrier = np.zeros((h, w), dtype=np.uint8)

    combined_edges = np.maximum(edges_closed, color_barrier)

    # Flood fill
    mask = np.zeros((h, w), dtype=np.uint8)
    for py, px in pos_px:
        if 0 <= py < h and 0 <= px < w and combined_edges[py, px] > 0:
            found = False
            for r in range(1, 20):
                for dy in range(-r, r+1):
                    for dx in range(-r, r+1):
                        ny, nx = py + dy, px + dx
                        if 0 <= ny < h and 0 <= nx < w and combined_edges[ny, nx] == 0:
                            py, px = ny, nx
                            found = True
                            break
                    if found: break
                if found: break
        if not (0 <= py < h and 0 <= px < w): continue
        ff_mask = np.zeros((h+2, w+2), dtype=np.uint8)
        fill_img = combined_edges.copy()
        cv2.floodFill(fill_img, ff_mask, (px, py), 128,
                       loDiff=0, upDiff=0,
                       flags=cv2.FLOODFILL_MASK_ONLY | (255 << 8))
        mask = np.maximum(mask, ff_mask[1:h+1, 1:w+1])

    # Bbox clip
    pad_y = int((by_max - by_min) * 0.05)
    pad_x = int((bx_max - bx_min) * 0.05)
    clip = np.zeros((h, w), dtype=np.uint8)
    clip[max(0,by_min-pad_y):min(h,by_max+pad_y),
         max(0,bx_min-pad_x):min(w,bx_max+pad_x)] = 255
    result = cv2.bitwise_and(mask, clip)

    # Morphology
    elem_size = max(by_max - by_min, bx_max - bx_min)
    if elem_size >= 150:
        result = cv2.morphologyEx(result, cv2.MORPH_CLOSE, np.ones((5,5), np.uint8), iterations=1)
    elif elem_size >= 50:
        result = cv2.morphologyEx(result, cv2.MORPH_CLOSE, np.ones((3,3), np.uint8), iterations=1)

    bbox_area = (min(h,by_max+pad_y)-max(0,by_min-pad_y)) * (min(w,bx_max+pad_x)-max(0,bx_min-pad_x))
    coverage = np.sum(result > 0) / bbox_area if bbox_area > 0 else 0

    return result, coverage


def detect_with_gemini(client, image_data, elements):
    """Call Gemini to detect bounding boxes + points for elements."""
    element_list = "\n".join([
        f'  - "{e["name"]}": {e.get("description", "")}'
        for e in elements
    ])
    prompt = BATCH_DETECTION_PROMPT.format(
        num_elements=len(elements),
        element_list=element_list
    )
    mime = "image/png" if image_data[:3] != b'\xff\xd8\xff' else "image/jpeg"

    for model in [VISION_PRIMARY, VISION_FALLBACK]:
        try:
            logger.info(f"  Detecting with {model}...")
            response = client.models.generate_content(
                model=model,
                contents=[types.Content(role="user", parts=[
                    types.Part.from_text(text=prompt),
                    types.Part.from_bytes(data=image_data, mime_type=mime),
                ])],
                config=types.GenerateContentConfig(
                    temperature=0,
                    max_output_tokens=16384,
                    media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
                    thinking_config=types.ThinkingConfig(thinking_budget=2048),
                )
            )

            text = None
            if response.candidates and response.candidates[0].content:
                texts = [p.text for p in response.candidates[0].content.parts
                         if hasattr(p, 'text') and p.text]
                if texts:
                    text = texts[-1]
            if text is None:
                text = response.text

            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]

            results = json.loads(text.strip())
            if not isinstance(results, list):
                results = [results]
            return results

        except Exception as e:
            logger.warning(f"  {model} failed: {e}")
            if model == VISION_PRIMARY:
                continue
            raise

    return []


def make_comparison_image(img_bgr, element_name, detection, mask_old, cov_old, mask_new, cov_new, actual_mask=None):
    """Create a side-by-side comparison image."""
    h, w = img_bgr.shape[:2]
    # 3 or 4 panels: input+points | old method | new method | (actual pipeline mask)
    n_panels = 4 if actual_mask is not None else 3
    canvas = np.zeros((h, w * n_panels + (n_panels-1)*4, 3), dtype=np.uint8)
    canvas[:, :, :] = 40  # Dark grey separators

    # Panel 1: Input with bbox + points
    vis = img_bgr.copy()
    box = detection.get("box_2d", [])
    if len(box) == 4:
        by1 = int(box[0]/1000*h); bx1 = int(box[1]/1000*w)
        by2 = int(box[2]/1000*h); bx2 = int(box[3]/1000*w)
        cv2.rectangle(vis, (bx1, by1), (bx2, by2), (0, 255, 0), 2)
    for pt in detection.get("positive_points", []):
        py, px = int(pt[0]/1000*h), int(pt[1]/1000*w)
        cv2.circle(vis, (px, py), 6, (0, 255, 0), -1)
        cv2.circle(vis, (px, py), 6, (0, 0, 0), 1)
    for pt in detection.get("negative_points", []):
        py, px = int(pt[0]/1000*h), int(pt[1]/1000*w)
        cv2.circle(vis, (px, py), 6, (0, 0, 255), -1)
        cv2.circle(vis, (px, py), 6, (0, 0, 0), 1)
    canvas[:, 0:w] = vis

    # Panel 2: Old method overlay
    overlay_old = img_bgr.copy()
    if mask_old is not None:
        overlay_old[mask_old > 0] = [0, 0, 255]  # Red = old (bad)
        overlay_old = cv2.addWeighted(img_bgr, 0.5, overlay_old, 0.5, 0)
    canvas[:, w+4:2*w+4] = overlay_old

    # Panel 3: New method overlay
    overlay_new = img_bgr.copy()
    if mask_new is not None:
        overlay_new[mask_new > 0] = [0, 255, 0]  # Green = new (good)
        overlay_new = cv2.addWeighted(img_bgr, 0.5, overlay_new, 0.5, 0)
    canvas[:, 2*w+8:3*w+8] = overlay_new

    # Panel 4: Actual pipeline mask (if available)
    if actual_mask is not None:
        overlay_actual = img_bgr.copy()
        overlay_actual[actual_mask > 127] = [255, 165, 0]  # Orange = actual
        overlay_actual = cv2.addWeighted(img_bgr, 0.5, overlay_actual, 0.5, 0)
        canvas[:, 3*w+12:4*w+12] = overlay_actual

    # Add labels
    font = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(canvas, f"{element_name}", (10, 30), font, 0.7, (255,255,255), 2)
    cv2.putText(canvas, "Detection", (10, h-10), font, 0.6, (255,255,255), 1)
    cv2.putText(canvas, f"OLD max-union ({cov_old:.0%})", (w+14, h-10), font, 0.6, (100,100,255), 1)
    cv2.putText(canvas, f"NEW intersect ({cov_new:.0%})", (2*w+18, h-10), font, 0.6, (100,255,100), 1)
    if actual_mask is not None:
        cv2.putText(canvas, "Pipeline actual", (3*w+22, h-10), font, 0.6, (100,200,255), 1)

    # Leaked warning
    if cov_old > 0.85:
        cv2.putText(canvas, "LEAKED!", (w+14, 30), font, 0.8, (0,0,255), 2)
    if cov_new > 0.85:
        cv2.putText(canvas, "LEAKED!", (2*w+18, 30), font, 0.8, (0,0,255), 2)

    return canvas


async def process_layer(client, layer_num, layer_info, session_dir):
    """Process one layer: detect elements, compare rough masks."""
    layer_dir = session_dir / f"layer_{layer_num}"
    input_path = layer_dir / "00_input.png"

    if not input_path.exists():
        logger.error(f"  No input image for layer {layer_num}")
        return

    image_data = input_path.read_bytes()
    img = np.array(Image.open(input_path).convert('RGB'))
    img_bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    h, w = img_bgr.shape[:2]

    elements = layer_info.get("elements", [])
    logger.info(f"\n{'='*60}")
    logger.info(f"LAYER {layer_num}: {layer_info.get('description', '')}")
    logger.info(f"  Elements: {[e['name'] for e in elements]}")
    logger.info(f"{'='*60}")

    # Step 1: Detect with Gemini
    detections = detect_with_gemini(client, image_data, elements)
    logger.info(f"  Got {len(detections)} detections")

    # Save detection JSON
    out_dir = OUTPUT_DIR / f"layer_{layer_num}"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "detections.json").write_text(json.dumps(detections, indent=2))

    # Step 2: For each element, generate both masks and compare
    for det in detections:
        name = det.get("label", "unknown")
        if not det.get("found", False):
            logger.info(f"\n  {name}: NOT FOUND, skipping")
            continue

        box = det.get("box_2d", [])
        pos = det.get("positive_points", [])
        neg = det.get("negative_points", [])

        logger.info(f"\n  {name}:")
        logger.info(f"    bbox: {box}")
        logger.info(f"    pos_points: {len(pos)}, neg_points: {len(neg)}")

        if not box or not pos:
            logger.info(f"    No bbox/points, skipping rough mask")
            continue

        # Generate with OLD method (max union)
        result_old = generate_rough_mask(image_data, box, pos, method="max_union")
        mask_old, cov_old = result_old if result_old else (None, 0)
        logger.info(f"    OLD (max_union): coverage={cov_old:.1%}")

        # Generate with NEW method (intersection)
        result_new = generate_rough_mask(image_data, box, pos, method="intersect")
        mask_new, cov_new = result_new if result_new else (None, 0)
        logger.info(f"    NEW (intersect): coverage={cov_new:.1%}")

        # Verdict
        if mask_old is not None and cov_old > 0.85:
            logger.info(f"    ⚠️  OLD method LEAKED ({cov_old:.0%})")
        if mask_new is not None and cov_new > 0.85:
            logger.info(f"    ⚠️  NEW method LEAKED ({cov_new:.0%})")

        # Load actual pipeline mask if it exists
        actual_mask_path = layer_dir / f"mask_{name}.png"
        actual_mask = None
        if actual_mask_path.exists():
            actual_mask = np.array(Image.open(actual_mask_path).convert('L'))

        # Save comparison
        comp = make_comparison_image(img_bgr, name, det, mask_old, cov_old, mask_new, cov_new, actual_mask)
        comp_path = out_dir / f"{name}_comparison.png"
        Image.fromarray(cv2.cvtColor(comp, cv2.COLOR_BGR2RGB)).save(comp_path)
        logger.info(f"    Saved: {comp_path}")

        # Save individual masks too
        if mask_old is not None:
            Image.fromarray(mask_old, 'L').save(out_dir / f"{name}_mask_old.png")
        if mask_new is not None:
            Image.fromarray(mask_new, 'L').save(out_dir / f"{name}_mask_new.png")


async def main():
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        # Try loading from .env
        env_path = Path(__file__).parent.parent / ".env"
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                if line.startswith("GEMINI_API_KEY="):
                    api_key = line.split("=", 1)[1].strip().strip('"')
                    break
    if not api_key:
        logger.error("GEMINI_API_KEY not set")
        sys.exit(1)

    client = genai.Client(api_key=api_key)

    session_dir = Path(f"output/{SESSION}")
    layers_info = json.loads((session_dir / "layers_info.json").read_text())

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Process layers 1 and 2
    for layer_info in layers_info["layers"]:
        layer_num = layer_info["layer"]
        if layer_num in [1, 2]:
            await process_layer(client, layer_num, layer_info, session_dir)

    logger.info(f"\n\nAll results saved to: {OUTPUT_DIR}/")
    logger.info("Open the *_comparison.png files to see side-by-side:")
    logger.info("  Left = detection | Red = OLD max-union | Green = NEW intersect | Orange = actual pipeline")


if __name__ == "__main__":
    asyncio.run(main())
