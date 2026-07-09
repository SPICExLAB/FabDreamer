"""
Test SVG tracing with adaptive Sobel threshold.

Replicates the frontend traceWorker.js logic in Python for quick iteration.
Processes all extracted_*.png files in the test session folder.

Usage:
    cd BackendGoogle/Test
    python test_trace.py
"""

import numpy as np
from PIL import Image
from pathlib import Path
import math

# --- Constants (match traceWorker.js) ---
SOBEL_X = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float32)
SOBEL_Y = np.array([[-1, -2, -1], [0, 0, 0], [1, 2, 1]], dtype=np.float32)

TARGET_DENSITY = 0.10   # Target: ≤10% edge density
BASE_THRESHOLD = 25
ERODE_RADIUS = 2


def compute_edges(gray, alpha, width, height, sobel_threshold, erode_radius):
    """Sobel edge detection + alpha erosion. Mirrors JS computeEdges()."""
    edges = np.zeros((height, width), dtype=np.uint8)
    opaque_count = 0
    edge_count = 0

    for y in range(1, height - 1):
        for x in range(1, width - 1):
            if alpha[y, x] < 128:
                continue
            opaque_count += 1

            gx, gy = 0.0, 0.0
            for ky in range(-1, 2):
                for kx in range(-1, 2):
                    p = float(gray[y + ky, x + kx])
                    gx += p * SOBEL_X[ky + 1, kx + 1]
                    gy += p * SOBEL_Y[ky + 1, kx + 1]
            if math.sqrt(gx * gx + gy * gy) > sobel_threshold:
                edges[y, x] = 1
                edge_count += 1

    # Erode alpha mask
    eroded = np.zeros((height, width), dtype=np.uint8)
    for y in range(erode_radius, height - erode_radius):
        for x in range(erode_radius, width - erode_radius):
            patch = alpha[y - erode_radius:y + erode_radius + 1,
                          x - erode_radius:x + erode_radius + 1]
            if np.all(patch >= 128):
                eroded[y, x] = 1

    return edges, eroded, edge_count, opaque_count


def compute_edges_fast(gray, alpha, width, height, sobel_threshold, erode_radius):
    """Vectorized version for speed (same result as pixel-loop version)."""
    from scipy.ndimage import convolve, minimum_filter

    opaque_mask = alpha >= 128
    opaque_count = int(np.sum(opaque_mask))

    gray_f = gray.astype(np.float32)
    gx = convolve(gray_f, SOBEL_X, mode='constant', cval=0)
    gy = convolve(gray_f, SOBEL_Y, mode='constant', cval=0)
    magnitude = np.sqrt(gx ** 2 + gy ** 2)

    edges = np.zeros((height, width), dtype=np.uint8)
    edge_mask = (magnitude > sobel_threshold) & opaque_mask
    edges[edge_mask] = 1
    edge_count = int(np.sum(edges))

    # Erode: pixel is interior if ALL neighbors within radius are opaque
    kernel_size = 2 * erode_radius + 1
    min_alpha = minimum_filter(alpha.astype(np.float32), size=kernel_size, mode='constant', cval=0)
    eroded = np.zeros((height, width), dtype=np.uint8)
    eroded[min_alpha >= 128] = 1

    return edges, eroded, edge_count, opaque_count


def trace_element(png_path, output_dir):
    """Run adaptive tracing on a single extracted PNG."""
    img = Image.open(png_path).convert('RGBA')
    arr = np.array(img)
    height, width = arr.shape[:2]

    gray = np.round(arr[:, :, 0] * 0.299 + arr[:, :, 1] * 0.587 + arr[:, :, 2] * 0.114).astype(np.uint8)
    alpha = arr[:, :, 3]

    name = png_path.stem.replace('extracted_', '')

    # Measure initial density
    edges, eroded, edge_count, opaque_count = compute_edges_fast(
        gray, alpha, width, height, BASE_THRESHOLD, ERODE_RADIUS
    )
    initial_density = edge_count / opaque_count if opaque_count > 0 else 0

    # Simple tier-based threshold — predictable, no overshoot
    if initial_density > 0.30:
        used_threshold = 200
    elif initial_density > 0.15:
        used_threshold = 120
    elif initial_density > TARGET_DENSITY:
        used_threshold = 60
    else:
        used_threshold = BASE_THRESHOLD

    if used_threshold != BASE_THRESHOLD:
        edges, eroded, edge_count, opaque_count = compute_edges_fast(
            gray, alpha, width, height, used_threshold, ERODE_RADIUS
        )
        density = edge_count / opaque_count if opaque_count > 0 else 0
        print(f"  {name}: ADAPTIVE {initial_density:.1%} → {density:.1%} (threshold {used_threshold})")
    else:
        density = initial_density
        print(f"  {name}: density {density:.1%} (threshold {used_threshold}, ok)")

    # Build interior edge image
    interior = edges & eroded

    # Save edge visualization (white bg, black edges)
    edge_vis = np.ones((height, width, 3), dtype=np.uint8) * 255
    edge_vis[interior == 1] = [0, 0, 0]

    # Overlay on original with transparency
    overlay = arr[:, :, :3].copy()
    overlay[interior == 1] = [255, 0, 0]  # Red edges on original

    out_edge = output_dir / f"trace_{name}_edges.png"
    out_overlay = output_dir / f"trace_{name}_overlay.png"

    Image.fromarray(edge_vis).save(out_edge)

    # Compose overlay with alpha
    overlay_rgba = np.zeros((height, width, 4), dtype=np.uint8)
    overlay_rgba[:, :, :3] = overlay
    overlay_rgba[:, :, 3] = alpha
    Image.fromarray(overlay_rgba).save(out_overlay)

    return {
        'name': name,
        'density': density,
        'threshold': used_threshold,
        'edge_count': int(np.sum(interior)),
        'opaque_count': opaque_count,
    }


def sweep_thresholds(png_path, output_dir, thresholds=None):
    """Test multiple thresholds on a single element for comparison."""
    if thresholds is None:
        thresholds = [25, 50, 100, 150, 200, 300]

    img = Image.open(png_path).convert('RGBA')
    arr = np.array(img)
    height, width = arr.shape[:2]
    gray = np.round(arr[:, :, 0] * 0.299 + arr[:, :, 1] * 0.587 + arr[:, :, 2] * 0.114).astype(np.uint8)
    alpha = arr[:, :, 3]
    name = png_path.stem.replace('extracted_', '')

    print(f"\n  Sweep for {name}:")
    for thresh in thresholds:
        for erode in [2, 4, 6]:
            edges, eroded, ec, oc = compute_edges_fast(gray, alpha, width, height, thresh, erode)
            interior = edges & eroded
            d = ec / oc if oc > 0 else 0
            ie = int(np.sum(interior))
            print(f"    thresh={thresh:>4}, erode={erode}: density={d:.1%}, interior_edges={ie}")

            edge_vis = np.ones((height, width, 3), dtype=np.uint8) * 255
            edge_vis[interior == 1] = [0, 0, 0]
            Image.fromarray(edge_vis).save(output_dir / f"sweep_{name}_t{thresh}_e{erode}.png")


def main():
    test_dir = Path(__file__).parent
    session_dir = test_dir / "9f4c778e-8395-4685-ad3a-5800258a347c"

    if not session_dir.exists():
        print(f"Session dir not found: {session_dir}")
        return

    output_dir = test_dir / "trace_output"
    output_dir.mkdir(exist_ok=True)

    # Sweep bridge and house specifically
    bridge = session_dir / "layer_1" / "extracted_center-bridge.png"
    house = session_dir / "layer_2" / "extracted_middle-left-house.png"

    sweep_thresholds(bridge, output_dir)
    sweep_thresholds(house, output_dir)

    # Also run full adaptive on all elements
    print("\n\n=== Full adaptive run ===")
    results = []
    for layer_dir in sorted(session_dir.glob("layer_*")):
        print(f"\n=== {layer_dir.name} ===")
        for png in sorted(layer_dir.glob("extracted_*.png")):
            result = trace_element(png, output_dir)
            results.append(result)

    print("\n" + "=" * 60)
    print(f"{'Element':<35} {'Density':>8} {'Thresh':>7} {'Edges':>8}")
    print("-" * 60)
    for r in results:
        print(f"{r['name']:<35} {r['density']:>7.1%} {r['threshold']:>7} {r['edge_count']:>8}")


if __name__ == "__main__":
    main()
