"""
Compare two clip methods for multi-subpath SVGs with holes:

Method A (current): All subpaths → Clipper as one subject with EvenOdd fill
Method B (per-subpath): Clip each subpath independently, rejoin

Test with two different masks:
1. P1-wudi bridge (current session — user says holes disappear)
2. grab-1774370881664 bridge (previous session — worked)

Usage:
    cd BackendGoogle && source venv/bin/activate && cd Test && python test_clip_methods.py
"""

import re, sys, io
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
from PIL import Image
import cv2
import pyclipper

SCALE = 1000
OUTPUT_DIR = Path(__file__).parent / "clip_methods_output"


def split_subpaths(pathD):
    commands = re.findall(r'[MLZmlz][^MLZmlz]*', pathD)
    subpaths, current = [], []
    for cmd in commands:
        if cmd[0] in ('M', 'm') and current:
            subpaths.append(''.join(current))
            current = [cmd]
        else:
            current.append(cmd)
    if current:
        subpaths.append(''.join(current))
    return subpaths


def parse_points(pathD):
    points = []
    for cmd in re.findall(r'[MLZmlz][^MLZmlz]*', pathD):
        t = cmd[0]
        coords = [float(x) for x in re.findall(r'[-+]?[\d.]+', cmd[1:])]
        if t == 'M' and len(coords) >= 2:
            points.append((coords[0], coords[1]))
        elif t == 'L':
            for i in range(0, len(coords) - 1, 2):
                points.append((coords[i], coords[i + 1]))
    return points


def points_to_path(points):
    if not points:
        return ''
    parts = [f'M {points[0][0]:.2f},{points[0][1]:.2f}']
    for x, y in points[1:]:
        parts.append(f'L {x:.2f},{y:.2f}')
    parts.append('Z')
    return ' '.join(parts)


def to_clipper(points):
    return [(int(x * SCALE), int(y * SCALE)) for x, y in points]


def from_clipper(path):
    return [(x / SCALE, y / SCALE) for x, y in path]


def clip_method_A_evenodd(subpaths, frame_points):
    """Method A: All subpaths as one subject with EvenOdd fill."""
    clipper = pyclipper.Pyclipper()
    for sp in subpaths:
        pts = parse_points(sp)
        if len(pts) >= 3:
            clipper.AddPath(to_clipper(pts), pyclipper.PT_SUBJECT, True)
    clipper.AddPath(to_clipper(frame_points), pyclipper.PT_CLIP, True)

    solution = clipper.Execute(
        pyclipper.CT_INTERSECTION,
        pyclipper.PFT_EVENODD,
        pyclipper.PFT_NONZERO
    )

    result_paths = [points_to_path(from_clipper(poly)) for poly in solution]
    return ' '.join(result_paths), solution


def clip_method_B_per_subpath(subpaths, frame_points):
    """Method B: Clip each subpath independently, rejoin."""
    result_paths = []
    all_solutions = []
    for sp in subpaths:
        pts = parse_points(sp)
        if len(pts) < 3:
            continue
        clipper = pyclipper.Pyclipper()
        clipper.AddPath(to_clipper(pts), pyclipper.PT_SUBJECT, True)
        clipper.AddPath(to_clipper(frame_points), pyclipper.PT_CLIP, True)
        solution = clipper.Execute(
            pyclipper.CT_INTERSECTION,
            pyclipper.PFT_NONZERO,
            pyclipper.PFT_NONZERO
        )
        for poly in solution:
            result_paths.append(points_to_path(from_clipper(poly)))
            all_solutions.append(poly)

    return ' '.join(result_paths), all_solutions


def visualize(subpaths_str, title, output_path, size=800):
    """Draw SVG subpaths on white background."""
    img = np.ones((size, size, 3), dtype=np.uint8) * 255
    subpaths = split_subpaths(subpaths_str)

    colors = [(0, 0, 200), (200, 0, 0), (0, 150, 0), (200, 100, 0)]
    for si, sp in enumerate(subpaths):
        pts = parse_points(sp)
        if len(pts) < 2:
            continue
        scaled = [(int(x * size / 1024), int(y * size / 1024)) for x, y in pts]
        arr = np.array(scaled, dtype=np.int32)
        color = colors[0] if si == 0 else colors[1]
        cv2.polylines(img, [arr], True, color, 2)

    cv2.putText(img, title, (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)
    cv2.imwrite(str(output_path), img)


def analyze_mask(name, mask_path, frame_points):
    """Run both clip methods on a mask and compare."""
    from utils.svg_converter import mask_to_svg

    print(f"\n{'=' * 60}")
    print(f"  {name}")
    print(f"{'=' * 60}")

    mask_data = mask_path.read_bytes()
    svg = mask_to_svg(mask_data, simplify_tolerance=2.0, min_hole_area_ratio=0.0)

    # Find the main path with holes
    paths_d = re.findall(r'd="([^"]*)"', svg)
    main_path = max(paths_d, key=lambda d: d.count('M '))
    subpaths = split_subpaths(main_path)
    print(f"  Input: {len(subpaths)} subpaths (1 outer + {len(subpaths)-1} holes)")

    # Check winding direction of each subpath
    print(f"\n  Winding analysis:")
    for i, sp in enumerate(subpaths):
        pts = parse_points(sp)
        if len(pts) >= 3:
            area = pyclipper.Area(to_clipper(pts))
            direction = "CW" if area > 0 else "CCW"
            label = "outer" if i == 0 else f"hole {i}"
            print(f"    {label}: {direction}, area={abs(area)/SCALE/SCALE:.0f}")

    # Visualize input
    visualize(main_path, f"{name} - Input", OUTPUT_DIR / f"{name}_input.png")

    # Method A: EvenOdd
    result_a, sol_a = clip_method_A_evenodd(subpaths, frame_points)
    subs_a = split_subpaths(result_a)
    area_a = sum(abs(pyclipper.Area(p)) for p in sol_a) / SCALE / SCALE
    print(f"\n  Method A (EvenOdd): {len(subs_a)} output subpaths, total area={area_a:.0f}")
    visualize(result_a, f"{name} - Method A (EvenOdd): {len(subs_a)} subpaths", OUTPUT_DIR / f"{name}_method_A.png")

    # Method B: Per-subpath
    result_b, sol_b = clip_method_B_per_subpath(subpaths, frame_points)
    subs_b = split_subpaths(result_b)
    area_b = sum(abs(pyclipper.Area(p)) for p in sol_b) / SCALE / SCALE
    print(f"  Method B (per-sub): {len(subs_b)} output subpaths, total area={area_b:.0f}")
    visualize(result_b, f"{name} - Method B (per-subpath): {len(subs_b)} subpaths", OUTPUT_DIR / f"{name}_method_B.png")

    # Compare
    outer_pts = parse_points(subpaths[0])
    outer_area = abs(pyclipper.Area(to_clipper(outer_pts))) / SCALE / SCALE
    print(f"\n  Outer area: {outer_area:.0f}")
    print(f"  Method A holes subtracted: {outer_area - area_a:.0f}")
    print(f"  Method B holes subtracted: {outer_area - area_b:.0f}")

    if abs(area_a - area_b) < 100:
        print(f"  → SAME result (both {'preserve' if area_a < outer_area - 100 else 'lose'} holes)")
    else:
        winner = "A" if area_a < area_b else "B"
        print(f"  → DIFFERENT! Method {winner} has smaller area (more holes subtracted)")

    return {
        'name': name,
        'input_subpaths': len(subpaths),
        'method_a_subpaths': len(subs_a),
        'method_b_subpaths': len(subs_b),
        'method_a_area': area_a,
        'method_b_area': area_b,
        'outer_area': outer_area,
    }


def main():
    OUTPUT_DIR.mkdir(exist_ok=True)

    test_dir = Path(__file__).parent

    # Frame = full canvas (no actual clipping, just testing hole preservation)
    full_frame = [(0, 0), (1024, 0), (1024, 1024), (0, 1024)]

    # Circular frame (more realistic Stage 3 scenario)
    import math
    circle_frame = [(512 + 450 * math.cos(a), 512 + 450 * math.sin(a))
                    for a in [i * 2 * math.pi / 64 for i in range(64)]]

    results = []

    # Test 1: P1-wudi bridge
    mask1 = test_dir / "P1-wudi" / "layer_1" / "mask_lower-center-bridge.png"
    if mask1.exists():
        print("\n\n=== WITH FULL FRAME (no actual clipping) ===")
        r1 = analyze_mask("P1-wudi-full", mask1, full_frame)
        results.append(r1)

        print("\n\n=== WITH CIRCULAR FRAME (realistic Stage 3) ===")
        r1c = analyze_mask("P1-wudi-circle", mask1, circle_frame)
        results.append(r1c)

    # Test 2: grab bridge (previous session)
    mask2 = test_dir / "grab-1774370881664-n0x7az5mk" / "mask_bridge.png"
    if mask2.exists():
        print("\n\n=== GRAB BRIDGE WITH FULL FRAME ===")
        r2 = analyze_mask("grab-bridge-full", mask2, full_frame)
        results.append(r2)

        print("\n\n=== GRAB BRIDGE WITH CIRCULAR FRAME ===")
        r2c = analyze_mask("grab-bridge-circle", mask2, circle_frame)
        results.append(r2c)

    # Test 3: Previous session bridge (9f4c...)
    mask3 = test_dir / "9f4c778e-8395-4685-ad3a-5800258a347c" / "layer_1" / "mask_center-bridge.png"
    if mask3.exists():
        print("\n\n=== SESSION BRIDGE WITH CIRCULAR FRAME ===")
        r3 = analyze_mask("session-bridge-circle", mask3, circle_frame)
        results.append(r3)

    print(f"\n\n{'=' * 70}")
    print(f"{'Name':<25} {'In':>4} {'A out':>6} {'B out':>6} {'A area':>8} {'B area':>8} {'Outer':>8}")
    print(f"{'-' * 70}")
    for r in results:
        print(f"{r['name']:<25} {r['input_subpaths']:>4} {r['method_a_subpaths']:>6} {r['method_b_subpaths']:>6} "
              f"{r['method_a_area']:>8.0f} {r['method_b_area']:>8.0f} {r['outer_area']:>8.0f}")

    print(f"\nOutput: {OUTPUT_DIR}/")


if __name__ == "__main__":
    main()
