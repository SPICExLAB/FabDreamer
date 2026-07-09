#!/usr/bin/env python3
"""
Compare rough mask generation methods for the grassy-bank element.

Problem: Current method uses per-point MAX union for color barriers.
If positive points span different colors (green grass + brown rock),
the barrier has holes and flood fill leaks into the river.

Methods tested:
  1. CURRENT: Per-point max union (barrier = far from ANY point)
  2. MEAN: Single barrier from mean color of all positive points
  3. INTERSECT: Per-point min intersection (barrier = far from ALL points)
  4. INTERSECT+NEG: Intersection + negative points as forced barriers

Usage:
  cd BackendGoogle
  python tests/test_rough_mask_compare.py

Output: tests/rough_mask_compare_output/ with step-by-step visualizations
"""

import sys, os, io
import numpy as np
import cv2
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# ── Config ──────────────────────────────────────────────────────────
SESSION = "343da096-24cd-48f2-8b26-46ab2597f8f3"
ELEMENT = "bottom-left-grassy-bank"

# These are approximate normalized [y, x] coords (0-1000 scale)
# based on the element description: green landmass with bushes, lower-left quadrant
# Bbox from layer analysis: roughly [600, 0, 1000, 500] (lower-left)
BBOX = [600, 0, 1000, 500]  # [y_min, x_min, y_max, x_max] normalized

# Positive points inside the grassy bank (green areas + bushes)
POS_POINTS = [
    [750, 100],  # Left grass area
    [700, 250],  # Center grass
    [800, 350],  # Right bush area
    [850, 150],  # Lower grass
    [680, 50],   # Upper-left grass
    [720, 400],  # Right edge grass
]

# Negative points (river/water areas nearby)
NEG_POINTS = [
    [650, 300],  # River above bank
    [600, 200],  # River further up
    [750, 480],  # Water to the right
    [650, 100],  # Water above left side
]

COLOR_DIST_THRESH = 35
OUTPUT_DIR = Path("tests/rough_mask_compare_output")

# ── Helpers ─────────────────────────────────────────────────────────

def norm_to_px(pts, h, w):
    """Convert normalized [y,x] to pixel [y,x]."""
    return [(int(p[0]/1000*h), int(p[1]/1000*w)) for p in pts]


def draw_points(img, pos_px, neg_px, bbox_px):
    """Draw points and bbox on image for visualization."""
    vis = img.copy()
    by_min, bx_min, by_max, bx_max = bbox_px
    cv2.rectangle(vis, (bx_min, by_min), (bx_max, by_max), (0, 255, 0), 2)
    for py, px in pos_px:
        cv2.circle(vis, (px, py), 8, (0, 255, 0), -1)  # Green = positive
        cv2.circle(vis, (px, py), 8, (0, 0, 0), 2)
    for py, px in neg_px:
        cv2.circle(vis, (px, py), 8, (0, 0, 255), -1)  # Red = negative
        cv2.circle(vis, (px, py), 8, (0, 0, 0), 2)
    return vis


def compute_edges(img_bgr, bbox_px):
    """Compute Canny edges with adaptive thresholds."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    by_min, bx_min, by_max, bx_max = bbox_px
    bbox_gray = gray[by_min:by_max, bx_min:bx_max]
    otsu_thresh, _ = cv2.threshold(bbox_gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    low = max(10, int(otsu_thresh * 0.33))
    high = max(30, int(otsu_thresh * 0.66))
    edges = cv2.Canny(blurred, low, high)
    kernel = np.ones((3, 3), np.uint8)
    return cv2.dilate(edges, kernel, iterations=1), otsu_thresh, low, high


def flood_fill_from_points(combined_edges, pos_px, h, w):
    """Flood fill from positive points, returns mask."""
    mask = np.zeros((h, w), dtype=np.uint8)
    for py, px in pos_px:
        # Find non-edge pixel nearby
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
        if not (0 <= py < h and 0 <= px < w):
            continue
        ff_mask = np.zeros((h+2, w+2), dtype=np.uint8)
        fill_img = combined_edges.copy()
        cv2.floodFill(fill_img, ff_mask, (px, py), 128,
                       loDiff=0, upDiff=0,
                       flags=cv2.FLOODFILL_MASK_ONLY | (255 << 8))
        mask = np.maximum(mask, ff_mask[1:h+1, 1:w+1])
    return mask


def clip_to_bbox(mask, bbox_px, h, w, pad_frac=0.05):
    """Clip mask to padded bbox."""
    by_min, bx_min, by_max, bx_max = bbox_px
    pad_y = int((by_max - by_min) * pad_frac)
    pad_x = int((bx_max - bx_min) * pad_frac)
    clip = np.zeros((h, w), dtype=np.uint8)
    clip[max(0,by_min-pad_y):min(h,by_max+pad_y),
         max(0,bx_min-pad_x):min(w,bx_max+pad_x)] = 255
    return cv2.bitwise_and(mask, clip)


def save_vis(name, img, is_mask=False):
    """Save visualization image."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if is_mask:
        Image.fromarray(img, 'L').save(OUTPUT_DIR / name)
    else:
        Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)).save(OUTPUT_DIR / name)
    print(f"  Saved {name}")


# ── Method 1: CURRENT (per-point max union) ────────────────────────

def method_current(img_lab, edges, pos_px, neg_px, h, w, bbox_px):
    """Current: color barrier = far from ANY positive point (max union)."""
    barrier = np.zeros((h, w), dtype=np.uint8)
    for py, px in pos_px:
        if not (0 <= py < h and 0 <= px < w): continue
        seed = img_lab[py, px]
        diff = np.sqrt(np.sum((img_lab - seed) ** 2, axis=2))
        far = (diff > COLOR_DIST_THRESH).astype(np.uint8) * 255
        barrier = np.maximum(barrier, far)

    combined = np.maximum(edges, barrier)
    mask = flood_fill_from_points(combined, pos_px, h, w)
    return clip_to_bbox(mask, bbox_px, h, w), barrier, combined


# ── Method 2: MEAN color ───────────────────────────────────────────

def method_mean(img_lab, edges, pos_px, neg_px, h, w, bbox_px):
    """Mean: single barrier from average color of all positive points."""
    colors = []
    for py, px in pos_px:
        if 0 <= py < h and 0 <= px < w:
            colors.append(img_lab[py, px])
    mean_color = np.mean(colors, axis=0)

    diff = np.sqrt(np.sum((img_lab - mean_color) ** 2, axis=2))
    barrier = (diff > COLOR_DIST_THRESH).astype(np.uint8) * 255

    combined = np.maximum(edges, barrier)
    mask = flood_fill_from_points(combined, pos_px, h, w)
    return clip_to_bbox(mask, bbox_px, h, w), barrier, combined


# ── Method 3: INTERSECTION (per-point min) ─────────────────────────

def method_intersect(img_lab, edges, pos_px, neg_px, h, w, bbox_px):
    """Intersect: barrier = far from ALL positive points (min intersection).
    A pixel is only a barrier if it's far from every seed point."""
    barrier = np.full((h, w), 255, dtype=np.uint8)  # Start all-barrier
    for py, px in pos_px:
        if not (0 <= py < h and 0 <= px < w): continue
        seed = img_lab[py, px]
        diff = np.sqrt(np.sum((img_lab - seed) ** 2, axis=2))
        far = (diff > COLOR_DIST_THRESH).astype(np.uint8) * 255
        barrier = np.minimum(barrier, far)  # Intersection: must be far from ALL

    combined = np.maximum(edges, barrier)
    mask = flood_fill_from_points(combined, pos_px, h, w)
    return clip_to_bbox(mask, bbox_px, h, w), barrier, combined


# ── Method 4: INTERSECT + negative points ──────────────────────────

def method_intersect_neg(img_lab, edges, pos_px, neg_px, h, w, bbox_px):
    """Intersect + negative points: intersection barrier + forced barriers
    around negative point colors."""
    # Intersection barrier from positive points
    barrier = np.full((h, w), 255, dtype=np.uint8)
    for py, px in pos_px:
        if not (0 <= py < h and 0 <= px < w): continue
        seed = img_lab[py, px]
        diff = np.sqrt(np.sum((img_lab - seed) ** 2, axis=2))
        far = (diff > COLOR_DIST_THRESH).astype(np.uint8) * 255
        barrier = np.minimum(barrier, far)

    # Add forced barriers from negative points (pixels CLOSE to neg colors)
    neg_barrier = np.zeros((h, w), dtype=np.uint8)
    NEG_CLOSE_THRESH = 25  # Tighter threshold for negative points
    for py, px in neg_px:
        if not (0 <= py < h and 0 <= px < w): continue
        seed = img_lab[py, px]
        diff = np.sqrt(np.sum((img_lab - seed) ** 2, axis=2))
        close = (diff < NEG_CLOSE_THRESH).astype(np.uint8) * 255
        neg_barrier = np.maximum(neg_barrier, close)

    barrier = np.maximum(barrier, neg_barrier)

    combined = np.maximum(edges, barrier)
    mask = flood_fill_from_points(combined, pos_px, h, w)
    return clip_to_bbox(mask, bbox_px, h, w), barrier, combined


# ── Main ────────────────────────────────────────────────────────────

def main():
    base = Path(f"output/{SESSION}/layer_2")
    input_path = base / "00_input.png"

    if not input_path.exists():
        print(f"ERROR: {input_path} not found")
        sys.exit(1)

    print(f"Loading {input_path}")
    img_rgb = np.array(Image.open(input_path).convert('RGB'))
    img_bgr = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2BGR)
    h, w = img_bgr.shape[:2]

    # Convert coordinates
    pos_px = norm_to_px(POS_POINTS, h, w)
    neg_px = norm_to_px(NEG_POINTS, h, w)
    bbox_px = (int(BBOX[0]/1000*h), int(BBOX[1]/1000*w),
               int(BBOX[2]/1000*h), int(BBOX[3]/1000*w))

    print(f"Image: {w}x{h}")
    print(f"Bbox (px): y={bbox_px[0]}-{bbox_px[2]}, x={bbox_px[1]}-{bbox_px[3]}")
    print(f"Positive points: {len(pos_px)}, Negative points: {len(neg_px)}")

    # Show point colors
    img_lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2Lab).astype(np.float32)
    print("\nPoint colors (Lab):")
    for i, (py, px) in enumerate(pos_px):
        if 0 <= py < h and 0 <= px < w:
            lab = img_lab[py, px]
            rgb = img_rgb[py, px]
            print(f"  POS[{i}] ({py},{px}): Lab=({lab[0]:.0f},{lab[1]:.0f},{lab[2]:.0f}) RGB=({rgb[0]},{rgb[1]},{rgb[2]})")
    for i, (py, px) in enumerate(neg_px):
        if 0 <= py < h and 0 <= px < w:
            lab = img_lab[py, px]
            rgb = img_rgb[py, px]
            print(f"  NEG[{i}] ({py},{px}): Lab=({lab[0]:.0f},{lab[1]:.0f},{lab[2]:.0f}) RGB=({rgb[0]},{rgb[1]},{rgb[2]})")

    # Save input with points
    vis = draw_points(img_bgr, pos_px, neg_px, bbox_px)
    save_vis("00_input_with_points.png", vis)

    # Compute edges
    edges, otsu, low, high = compute_edges(img_bgr, bbox_px)
    print(f"\nCanny: otsu={otsu:.0f}, low={low}, high={high}")
    save_vis("01_edges.png", edges, is_mask=True)

    # Run all methods
    methods = [
        ("current_max_union", method_current),
        ("mean_color", method_mean),
        ("intersect_min", method_intersect),
        ("intersect_plus_neg", method_intersect_neg),
    ]

    results = []
    for name, fn in methods:
        print(f"\n── Method: {name} ──")
        mask, barrier, combined = fn(img_lab, edges, pos_px, neg_px, h, w, bbox_px)

        # Coverage stats
        bbox_area = (bbox_px[2]-bbox_px[0]) * (bbox_px[3]-bbox_px[1])
        coverage = np.sum(mask > 0) / bbox_area if bbox_area > 0 else 0
        total_coverage = np.sum(mask > 0) / (h * w)
        print(f"  Coverage: {coverage:.1%} of bbox, {total_coverage:.1%} of image")

        save_vis(f"02_{name}_barrier.png", barrier, is_mask=True)
        save_vis(f"03_{name}_combined.png", combined, is_mask=True)
        save_vis(f"04_{name}_mask.png", mask, is_mask=True)

        # Overlay mask on image
        overlay = img_bgr.copy()
        overlay[mask > 0] = [0, 255, 0]  # Green overlay
        blended = cv2.addWeighted(img_bgr, 0.6, overlay, 0.4, 0)
        save_vis(f"05_{name}_overlay.png", blended)

        results.append((name, coverage, total_coverage))

    # Also save the actual mask from the pipeline for comparison
    actual_mask_path = base / f"mask_{ELEMENT}.png"
    if actual_mask_path.exists():
        actual = np.array(Image.open(actual_mask_path).convert('L'))
        coverage = np.sum(actual > 127) / (h * w)
        print(f"\n── Actual pipeline mask ──")
        print(f"  Coverage: {coverage:.1%} of image")
        save_vis("06_actual_pipeline_mask.png", actual, is_mask=True)

    # Summary
    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    print(f"{'Method':<25} {'Bbox Coverage':>14} {'Image Coverage':>14}")
    print("-"*55)
    for name, cov_bbox, cov_img in results:
        flag = " ⚠️ LEAKED" if cov_bbox > 0.85 else " ✅" if 0.05 < cov_bbox < 0.85 else " ❌ TOO SMALL"
        print(f"{name:<25} {cov_bbox:>13.1%} {cov_img:>13.1%}{flag}")
    print()
    print("Good result: 10-60% of bbox for this element (grassy bank in lower-left)")
    print("Bad result: >85% means flood fill leaked through barriers")


if __name__ == "__main__":
    main()
