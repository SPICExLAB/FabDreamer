#!/usr/bin/env python3
"""
Test: Color-guided edge detection → flood fill → rough mask for SAM2.

Pipeline:
  VLM gives us: box + diverse points + element/exclude colors
  We compute: color-guided edges (element vs non-element boundaries only)
  Flood fill from positive points, stopped by color-guided edges
  Result = rough mask to pass as SAM2 mask_input
"""
import cv2
import numpy as np
import json
from pathlib import Path

img_path = "output/dsd/test.png"
img = cv2.imread(img_path)
h, w = img.shape[:2]
out_dir = Path("test_outline_output/elements/right-foreground-pine-tree")

# Load enhanced detection from VLM
with open(out_dir / "08_enhanced_detection.json") as f:
    det = json.load(f)

box = [205, 745, 1000, 1000]

def norm_to_px(y, x):
    return int(y / 1000 * h), int(x / 1000 * w)

pos_px = [norm_to_px(p[0], p[1]) for p in det["positive_points"]]
neg_px = [norm_to_px(p[0], p[1]) for p in det["negative_points"]]
by_min, bx_min = norm_to_px(box[0], box[1])
by_max, bx_max = norm_to_px(box[2], box[3])

img_float = img.astype(np.float64)

# Sample actual colors at points (more reliable than VLM-estimated colors)
pos_colors = [img[py, px].astype(np.float64) for py, px in pos_px]
neg_colors = [img[py, px].astype(np.float64) for py, px in neg_px]

print(f"Image: {w}x{h}")
print(f"Pos colors: {[c.astype(int).tolist() for c in pos_colors]}")
print(f"Neg colors: {[c.astype(int).tolist() for c in neg_colors]}")

# ============================================================
# Step 1: Color score map (how likely each pixel is the element)
# ============================================================
pos_dist = np.full((h, w), 999.0)
for c in pos_colors:
    d = np.sqrt(np.sum((img_float - c) ** 2, axis=2))
    pos_dist = np.minimum(pos_dist, d)

neg_dist = np.full((h, w), 999.0)
for c in neg_colors:
    d = np.sqrt(np.sum((img_float - c) ** 2, axis=2))
    neg_dist = np.minimum(neg_dist, d)

color_score = neg_dist / (pos_dist + neg_dist + 1e-6)  # 0=background, 1=element

# Visualize
score_viz = (color_score * 255).clip(0, 255).astype(np.uint8)
cv2.imwrite(str(out_dir / "09a_color_score_full.png"), score_viz)

# ============================================================
# Step 2: Color-guided edges (gradient of color score)
# ============================================================
# Smooth the score map slightly, then find gradient
score_smooth = cv2.GaussianBlur(color_score.astype(np.float32), (5, 5), 0)
grad_x = cv2.Sobel(score_smooth, cv2.CV_64F, 1, 0, ksize=3)
grad_y = cv2.Sobel(score_smooth, cv2.CV_64F, 0, 1, ksize=3)
color_gradient = np.sqrt(grad_x ** 2 + grad_y ** 2)

# Normalize to 0-255
color_gradient_norm = (color_gradient / color_gradient.max() * 255).astype(np.uint8)
cv2.imwrite(str(out_dir / "09b_color_gradient.png"), color_gradient_norm)

# Also get standard Canny for comparison
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
canny_edges = cv2.Canny(cv2.GaussianBlur(gray, (3, 3), 0), 20, 80)
cv2.imwrite(str(out_dir / "09c_canny_edges.png"), canny_edges)

# ============================================================
# Step 3: Combine color-guided edges + Canny for robust boundaries
# ============================================================

# Threshold color gradient to get binary edge map
for edge_label, edge_map in [
    ("color_only", color_gradient_norm),
    ("canny_only", canny_edges),
]:
    print(f"\n=== {edge_label} ===")

    if edge_label == "color_only":
        # Threshold the gradient magnitude
        _, edge_binary = cv2.threshold(edge_map, 30, 255, cv2.THRESH_BINARY)
    else:
        edge_binary = edge_map.copy()

    # Dilate to close gaps
    edge_closed = cv2.dilate(edge_binary, np.ones((3, 3), np.uint8), iterations=1)

    # Flood fill from positive points
    ff_mask = np.zeros((h, w), dtype=np.uint8)
    for py, px in pos_px:
        if edge_closed[py, px] > 0:
            found = False
            for r in range(1, 30):
                for dy in range(-r, r + 1):
                    for dx in range(-r, r + 1):
                        ny, nx = py + dy, px + dx
                        if 0 <= ny < h and 0 <= nx < w and edge_closed[ny, nx] == 0:
                            py, px = ny, nx
                            found = True
                            break
                    if found: break
                if found: break

        ff_m = np.zeros((h + 2, w + 2), dtype=np.uint8)
        fill_img = edge_closed.copy()
        cv2.floodFill(fill_img, ff_m, (px, py), 128, loDiff=0, upDiff=0,
                      flags=cv2.FLOODFILL_MASK_ONLY | (255 << 8))
        ff_mask = np.maximum(ff_mask, ff_m[1:h+1, 1:w+1])

    # Bbox clip
    bbox_clip = np.zeros((h, w), dtype=np.uint8)
    bbox_clip[by_min:by_max, bx_min:bx_max] = 255
    result = cv2.bitwise_and(ff_mask, bbox_clip)

    # Cleanup
    kernel = np.ones((5, 5), np.uint8)
    result = cv2.morphologyEx(result, cv2.MORPH_CLOSE, kernel, iterations=2)

    coverage = np.sum(result > 0) / result.size
    print(f"  Coverage: {coverage:.1%}")
    cv2.imwrite(str(out_dir / f"09d_mask_{edge_label}.png"), result)

# ============================================================
# Step 4: Combined edges (color gradient + Canny intersection/union)
# ============================================================
print("\n=== combined edges ===")

# Method: Use Canny for precise edges, boost where color gradient is strong
_, color_edge_binary = cv2.threshold(color_gradient_norm, 20, 255, cv2.THRESH_BINARY)

# Union: either Canny OR strong color gradient
combined_edges = cv2.bitwise_or(canny_edges, color_edge_binary)
combined_closed = cv2.dilate(combined_edges, np.ones((3, 3), np.uint8), iterations=1)

cv2.imwrite(str(out_dir / "09e_combined_edges.png"), combined_closed)

# Flood fill
ff_mask = np.zeros((h, w), dtype=np.uint8)
for py, px in pos_px:
    if combined_closed[py, px] > 0:
        found = False
        for r in range(1, 30):
            for dy in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    ny, nx = py + dy, px + dx
                    if 0 <= ny < h and 0 <= nx < w and combined_closed[ny, nx] == 0:
                        py, px = ny, nx
                        found = True
                        break
                if found: break
            if found: break

    ff_m = np.zeros((h + 2, w + 2), dtype=np.uint8)
    fill_img = combined_closed.copy()
    cv2.floodFill(fill_img, ff_m, (px, py), 128, loDiff=0, upDiff=0,
                  flags=cv2.FLOODFILL_MASK_ONLY | (255 << 8))
    ff_mask = np.maximum(ff_mask, ff_m[1:h+1, 1:w+1])

bbox_clip = np.zeros((h, w), dtype=np.uint8)
bbox_clip[by_min:by_max, bx_min:bx_max] = 255
result = cv2.bitwise_and(ff_mask, bbox_clip)
kernel = np.ones((5, 5), np.uint8)
result = cv2.morphologyEx(result, cv2.MORPH_CLOSE, kernel, iterations=2)

coverage = np.sum(result > 0) / result.size
print(f"  Coverage: {coverage:.1%}")
cv2.imwrite(str(out_dir / "09f_mask_combined.png"), result)

print("\nDone! Check 09*.png files")
print("Key files:")
print("  09a = color score map (bright = likely element)")
print("  09b = color-guided edges (element/background boundaries)")
print("  09c = standard Canny edges (all edges)")
print("  09d = flood fill masks with each edge type")
print("  09e = combined edges")
print("  09f = final mask from combined edges")
