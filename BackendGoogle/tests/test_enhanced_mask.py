#!/usr/bin/env python3
"""Test mask generation using enhanced detection (more points + color guidance)."""
import cv2
import numpy as np
import json
from PIL import Image, ImageDraw
from pathlib import Path
import io

img_path = "output/dsd/test.png"
img = cv2.imread(img_path)
h, w = img.shape[:2]
out_dir = Path("test_outline_output/elements/right-foreground-pine-tree")

# Load enhanced detection
with open(out_dir / "08_enhanced_detection.json") as f:
    det = json.load(f)

box = [205, 745, 1000, 1000]

def norm_to_px(y, x):
    return int(y / 1000 * h), int(x / 1000 * w)

pos_px = [norm_to_px(p[0], p[1]) for p in det["positive_points"]]
neg_px = [norm_to_px(p[0], p[1]) for p in det["negative_points"]]
elem_colors = [np.array(c[::-1], dtype=np.float64) for c in det["element_colors"]]  # RGB→BGR
excl_colors = [np.array(c[::-1], dtype=np.float64) for c in det["exclude_colors"]]  # RGB→BGR
by_min, bx_min = norm_to_px(box[0], box[1])
by_max, bx_max = norm_to_px(box[2], box[3])

print(f"Image: {w}x{h}")
print(f"{len(pos_px)} positive points, {len(neg_px)} negative points")
print(f"{len(elem_colors)} element colors, {len(excl_colors)} exclude colors")

# Visualize enhanced points
viz = img.copy()
for py, px in pos_px:
    cv2.circle(viz, (px, py), 6, (0, 255, 0), -1)
    cv2.circle(viz, (px, py), 6, (255, 255, 255), 1)
for py, px in neg_px:
    cv2.circle(viz, (px, py), 6, (0, 0, 255), -1)
    cv2.circle(viz, (px, py), 6, (255, 255, 255), 1)
cv2.rectangle(viz, (bx_min, by_min), (bx_max, by_max), (0, 0, 255), 2)
cv2.imwrite(str(out_dir / "08a_enhanced_points.png"), viz)
print("Saved: 08a_enhanced_points.png")

# Also sample ACTUAL colors at the positive/negative points
print("\nActual colors at points:")
for i, (py, px) in enumerate(pos_px):
    c = img[py, px]
    print(f"  pos[{i}] ({py},{px}): BGR={c.tolist()}")
for i, (py, px) in enumerate(neg_px):
    c = img[py, px]
    print(f"  neg[{i}] ({py},{px}): BGR={c.tolist()}")

# ============================================================
# Method A: GrabCut with enhanced markers
# ============================================================
print("\n=== A. GrabCut (enhanced) ===")
mask_gc = np.zeros((h, w), np.uint8)
rect = (bx_min, by_min, bx_max - bx_min, by_max - by_min)
bgd_model = np.zeros((1, 65), np.float64)
fgd_model = np.zeros((1, 65), np.float64)

cv2.grabCut(img, mask_gc, rect, bgd_model, fgd_model, 5, cv2.GC_INIT_WITH_RECT)

for py, px in pos_px:
    cv2.circle(mask_gc, (px, py), 6, cv2.GC_FGD, -1)
for py, px in neg_px:
    cv2.circle(mask_gc, (px, py), 6, cv2.GC_BGD, -1)

cv2.grabCut(img, mask_gc, rect, bgd_model, fgd_model, 5, cv2.GC_INIT_WITH_MASK)

gc_result = np.where((mask_gc == cv2.GC_FGD) | (mask_gc == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
coverage = np.sum(gc_result > 0) / gc_result.size
print(f"  Coverage: {coverage:.1%}")
cv2.imwrite(str(out_dir / "08b_grabcut_enhanced.png"), gc_result)

# ============================================================
# Method B: Color-guided mask (VLM colors + edges + flood fill)
# ============================================================
print("\n=== B. Color-guided mask ===")

img_float = img.astype(np.float64)

# Use ACTUAL sampled colors at points (more accurate than VLM-estimated colors)
actual_pos_colors = [img[py, px].astype(np.float64) for py, px in pos_px]
actual_neg_colors = [img[py, px].astype(np.float64) for py, px in neg_px]

# Min distance to positive colors
pos_dist = np.full((h, w), 999.0)
for c in actual_pos_colors:
    d = np.sqrt(np.sum((img_float - c) ** 2, axis=2))
    pos_dist = np.minimum(pos_dist, d)

# Min distance to negative colors
neg_dist = np.full((h, w), 999.0)
for c in actual_neg_colors:
    d = np.sqrt(np.sum((img_float - c) ** 2, axis=2))
    neg_dist = np.minimum(neg_dist, d)

# Color likelihood: closer to pos, farther from neg
color_score = neg_dist / (pos_dist + neg_dist + 1e-6)

# Edge map
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
edges = cv2.Canny(cv2.GaussianBlur(gray, (3, 3), 0), 20, 80)
edges_dilated = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

# Flood fill from positive points
ff_mask = np.zeros((h, w), dtype=np.uint8)
for py, px in pos_px:
    # Find non-edge pixel nearby if on edge
    if edges_dilated[py, px] > 0:
        found = False
        for r in range(1, 20):
            for dy in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    ny, nx = py + dy, px + dx
                    if 0 <= ny < h and 0 <= nx < w and edges_dilated[ny, nx] == 0:
                        py, px = ny, nx
                        found = True
                        break
                if found:
                    break
            if found:
                break

    ff_m = np.zeros((h + 2, w + 2), dtype=np.uint8)
    fill_img = edges_dilated.copy()
    cv2.floodFill(fill_img, ff_m, (px, py), 128, loDiff=0, upDiff=0,
                  flags=cv2.FLOODFILL_MASK_ONLY | (255 << 8))
    ff_mask = np.maximum(ff_mask, ff_m[1:h+1, 1:w+1])

# Bbox clip
bbox_clip = np.zeros((h, w), dtype=np.uint8)
bbox_clip[by_min:by_max, bx_min:bx_max] = 255

for thresh in [0.45, 0.5, 0.55, 0.6]:
    color_filter = (color_score > thresh).astype(np.uint8) * 255
    combined = cv2.bitwise_and(ff_mask, color_filter)
    combined = cv2.bitwise_and(combined, bbox_clip)

    kernel = np.ones((5, 5), np.uint8)
    combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel, iterations=3)
    combined = cv2.morphologyEx(combined, cv2.MORPH_OPEN, kernel, iterations=1)

    coverage = np.sum(combined > 0) / combined.size
    print(f"  Thresh {thresh}: coverage={coverage:.1%}")
    cv2.imwrite(str(out_dir / f"08c_color_guided_{thresh}.png"), combined)

# ============================================================
# Method C: VLM color palette mask (use VLM-provided colors directly)
# ============================================================
print("\n=== C. VLM color palette mask ===")

# Distance to VLM element colors
vlm_pos_dist = np.full((h, w), 999.0)
for c in elem_colors:
    d = np.sqrt(np.sum((img_float - c) ** 2, axis=2))
    vlm_pos_dist = np.minimum(vlm_pos_dist, d)

# Distance to VLM exclude colors
vlm_neg_dist = np.full((h, w), 999.0)
for c in excl_colors:
    d = np.sqrt(np.sum((img_float - c) ** 2, axis=2))
    vlm_neg_dist = np.minimum(vlm_neg_dist, d)

vlm_score = vlm_neg_dist / (vlm_pos_dist + vlm_neg_dist + 1e-6)

for thresh in [0.5, 0.55, 0.6]:
    vlm_filter = (vlm_score > thresh).astype(np.uint8) * 255
    # Combine with flood fill + bbox
    combined = cv2.bitwise_and(ff_mask, vlm_filter)
    combined = cv2.bitwise_and(combined, bbox_clip)

    kernel = np.ones((5, 5), np.uint8)
    combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel, iterations=3)
    combined = cv2.morphologyEx(combined, cv2.MORPH_OPEN, kernel, iterations=1)

    coverage = np.sum(combined > 0) / combined.size
    print(f"  Thresh {thresh}: coverage={coverage:.1%}")
    cv2.imwrite(str(out_dir / f"08d_vlm_color_{thresh}.png"), combined)

# ============================================================
# Method D: Watershed with enhanced markers
# ============================================================
print("\n=== D. Watershed (enhanced) ===")
markers = np.zeros((h, w), dtype=np.int32)

# Background markers
markers[:by_min, :] = 1
markers[:, :bx_min] = 1
for py, px in neg_px:
    cv2.circle(markers, (px, py), 12, 1, -1)

# Foreground markers
for py, px in pos_px:
    cv2.circle(markers, (px, py), 6, 2, -1)

cv2.watershed(img, markers)
ws_result = np.where(markers == 2, 255, 0).astype(np.uint8)
ws_result = cv2.bitwise_and(ws_result, bbox_clip)
coverage = np.sum(ws_result > 0) / ws_result.size
print(f"  Coverage: {coverage:.1%}")
cv2.imwrite(str(out_dir / "08e_watershed_enhanced.png"), ws_result)

# Save color score visualization
score_viz = (color_score * 255).clip(0, 255).astype(np.uint8)
score_viz_clipped = np.zeros_like(score_viz)
score_viz_clipped[by_min:by_max, bx_min:bx_max] = score_viz[by_min:by_max, bx_min:bx_max]
cv2.imwrite(str(out_dir / "08f_color_score_map.png"), score_viz_clipped)

print("\nDone! All results saved as 08*.png")
