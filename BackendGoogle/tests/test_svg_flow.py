"""
Simulate the full SVG flow: backend mask → composeLayerSvg → CutBoard input.

Shows exactly how the bridge SVG gets corrupted and what the fix looks like.

Usage:
    cd BackendGoogle && source venv/bin/activate && cd Test && python test_svg_flow.py
"""

import sys, re, io
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
from PIL import Image
import cv2

OUTPUT_DIR = Path(__file__).parent / "svg_flow_output"
SESSION_DIR = Path(__file__).parent / "grab-1774370881664-n0x7az5mk"


# ============================================================
# Replicate frontend functions in Python (same bugs)
# ============================================================

def parse_path_to_points_CURRENT(pathD):
    """Current frontend parsePathToPoints — FLATTENS all subpaths into one array."""
    if not pathD:
        return []
    points = []
    commands = re.findall(r'[MLZmlz][^MLZmlz]*', pathD)
    cx, cy = 0, 0
    for cmd in commands:
        t = cmd[0]
        coords = [float(x) for x in re.findall(r'[-+]?[\d.]+', cmd[1:])]
        if t == 'M' and len(coords) >= 2:
            cx, cy = coords[0], coords[1]
            points.append((cx, cy))
        elif t == 'L':
            for i in range(0, len(coords) - 1, 2):
                cx, cy = coords[i], coords[i + 1]
                points.append((cx, cy))
        # Z: ignored, no separation
    return points


def points_to_path_CURRENT(points):
    """Current frontend pointsToPath — single M...Z path."""
    if not points:
        return ''
    parts = []
    for i, (x, y) in enumerate(points):
        cmd = 'M' if i == 0 else 'L'
        parts.append(f'{cmd} {x:.2f},{y:.2f}')
    parts.append('Z')
    return ' '.join(parts)


def apply_transform_to_path_CURRENT(pathD, transform_str):
    """Current frontend applyTransformToPath — loses subpath structure."""
    if not transform_str:
        return pathD
    points = parse_path_to_points_CURRENT(pathD)
    if len(points) < 3:
        return pathD
    transformed = apply_transform_to_points(points, transform_str)
    return points_to_path_CURRENT(transformed)


# ============================================================
# FIXED versions — preserve subpath structure
# ============================================================

def split_subpaths(pathD):
    """Split a multi-subpath d attribute into individual subpaths.
    Each subpath starts with M and ends with Z."""
    subpaths = []
    current = []
    for cmd in re.findall(r'[MLZmlz][^MLZmlz]*', pathD):
        t = cmd[0]
        if t in ('M', 'm') and current:
            # New subpath starting — save previous
            subpaths.append(current)
            current = [cmd]
        else:
            current.append(cmd)
    if current:
        subpaths.append(current)
    return [''.join(cmds) for cmds in subpaths]


def parse_path_to_points_FIXED(pathD):
    """Fixed version — returns list of point arrays (one per subpath)."""
    subpath_strings = split_subpaths(pathD)
    all_subpaths = []
    for sp_str in subpath_strings:
        points = parse_path_to_points_CURRENT(sp_str)
        if points:
            all_subpaths.append(points)
    return all_subpaths


def points_to_path_FIXED(subpaths):
    """Fixed version — generates M...Z for each subpath."""
    parts = []
    for points in subpaths:
        if not points:
            continue
        sp_parts = []
        for i, (x, y) in enumerate(points):
            cmd = 'M' if i == 0 else 'L'
            sp_parts.append(f'{cmd} {x:.2f},{y:.2f}')
        sp_parts.append('Z')
        parts.append(' '.join(sp_parts))
    return ' '.join(parts)


def apply_transform_to_path_FIXED(pathD, transform_str):
    """Fixed version — transforms each subpath independently, preserves structure."""
    if not transform_str:
        return pathD
    subpaths = parse_path_to_points_FIXED(pathD)
    if not subpaths:
        return pathD
    transformed_subpaths = []
    for points in subpaths:
        if len(points) >= 3:
            transformed_subpaths.append(apply_transform_to_points(points, transform_str))
        else:
            transformed_subpaths.append(points)
    return points_to_path_FIXED(transformed_subpaths)


# ============================================================
# Shared transform logic
# ============================================================

def apply_transform_to_points(points, transform_str):
    """Apply SVG transform to points (translate, scale, rotate)."""
    import math
    result = list(points)
    transforms = re.findall(r'\w+\([^)]+\)', transform_str)
    for t in reversed(transforms):
        if t.startswith('translate'):
            m = re.match(r'translate\(\s*([^,\s]+)[\s,]+([^)]+)\)', t)
            if m:
                tx, ty = float(m.group(1)), float(m.group(2))
                result = [(x + tx, y + ty) for x, y in result]
        elif t.startswith('scale'):
            m = re.match(r'scale\(\s*([^,\s]+)(?:[\s,]+([^)]+))?\)', t)
            if m:
                sx = float(m.group(1))
                sy = float(m.group(2)) if m.group(2) else sx
                result = [(x * sx, y * sy) for x, y in result]
        elif t.startswith('rotate'):
            m = re.match(r'rotate\(\s*([^,\s]+)(?:[\s,]+([^,\s]+)[\s,]+([^)]+))?\)', t)
            if m:
                angle = float(m.group(1)) * math.pi / 180
                cx = float(m.group(2)) if m.group(2) else 0
                cy = float(m.group(3)) if m.group(3) else 0
                cos_a, sin_a = math.cos(angle), math.sin(angle)
                new_result = []
                for x, y in result:
                    dx, dy = x - cx, y - cy
                    new_result.append((cx + dx * cos_a - dy * sin_a, cy + dx * sin_a + dy * cos_a))
                result = new_result
    return result


# ============================================================
# SVG visualization
# ============================================================

def svg_to_visualization(svg_str, title, output_path, size=800):
    """Render SVG paths as a PNG visualization with colored paths."""
    img = np.ones((size, size, 3), dtype=np.uint8) * 255

    # Parse all path d attributes
    paths = re.findall(r'd="([^"]*)"', svg_str)
    colors = [(0, 0, 200), (200, 0, 0), (0, 150, 0), (200, 0, 200)]

    for pi, d in enumerate(paths):
        color = colors[pi % len(colors)]
        subpaths = split_subpaths(d)

        for si, sp in enumerate(subpaths):
            points = parse_path_to_points_CURRENT(sp)
            if len(points) < 2:
                continue
            # Scale from 1024 to size
            scaled = [(int(x * size / 1024), int(y * size / 1024)) for x, y in points]
            pts = np.array(scaled, dtype=np.int32)

            # Draw as polyline
            hole_color = (0, 0, 255) if si > 0 else color
            cv2.polylines(img, [pts], isClosed=True, color=hole_color, thickness=2)

            # Mark first point with a circle
            if scaled:
                cv2.circle(img, scaled[0], 4, hole_color, -1)

    # Add title
    cv2.putText(img, title, (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)

    cv2.imwrite(str(output_path), img)
    return img


# ============================================================
# Main simulation
# ============================================================

def main():
    OUTPUT_DIR.mkdir(exist_ok=True)

    # Step 1: Generate SVG from mask (backend)
    print("=" * 70)
    print("STEP 1: Backend mask_to_svg()")
    print("=" * 70)

    from utils.svg_converter import mask_to_svg
    mask_path = SESSION_DIR / "mask_bridge.png"
    mask_data = mask_path.read_bytes()
    backend_svg = mask_to_svg(mask_data, simplify_tolerance=2.0, min_hole_area_ratio=0.0)

    # Extract the main path (the one with evenodd)
    path_tags = re.findall(r'<path[^>]*>', backend_svg)
    print(f"  Generated {len(path_tags)} path elements")

    for i, tag in enumerate(path_tags):
        d = re.search(r'd="([^"]*)"', tag).group(1)
        subpaths = split_subpaths(d)
        has_evenodd = 'evenodd' in tag
        print(f"  Path {i}: {len(subpaths)} subpaths, evenodd={has_evenodd}, d_len={len(d)}")

    (OUTPUT_DIR / "step1_backend_svg.svg").write_text(backend_svg)
    svg_to_visualization(backend_svg, "Step 1: Backend SVG (from mask)", OUTPUT_DIR / "step1_vis.png")

    # Find the main path with holes
    main_path_d = None
    main_path_tag = None
    for tag in path_tags:
        d = re.search(r'd="([^"]*)"', tag).group(1)
        if len(split_subpaths(d)) > 1:
            main_path_d = d
            main_path_tag = tag
            break

    if not main_path_d:
        # Use the largest path
        main_path_d = re.search(r'd="([^"]*)"', path_tags[-1]).group(1)
        main_path_tag = path_tags[-1]

    print(f"\n  Main path: {len(split_subpaths(main_path_d))} subpaths")

    # Step 2: Simulate composeLayerSvg with a transform
    print("\n" + "=" * 70)
    print("STEP 2: composeLayerSvg() — CURRENT (buggy)")
    print("=" * 70)

    # Simulate a typical segment transform (scale + translate from drag-to-canvas)
    test_transform = "translate(100, 50) scale(0.8, 0.8)"
    print(f"  Transform: {test_transform}")

    # CURRENT behavior: flatten all subpaths
    current_result = apply_transform_to_path_CURRENT(main_path_d, test_transform)
    current_subpaths = split_subpaths(current_result)
    print(f"  Input:  {len(split_subpaths(main_path_d))} subpaths")
    print(f"  Output: {len(current_subpaths)} subpaths  ← ALL HOLES LOST!")

    # Wrap in SVG for visualization
    current_svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <path d="{current_result}" fill="white" stroke="none" fill-rule="evenodd"/>
</svg>'''
    (OUTPUT_DIR / "step2_current_composed.svg").write_text(current_svg)
    svg_to_visualization(current_svg, "Step 2: CURRENT compose (BROKEN - 1 subpath)", OUTPUT_DIR / "step2_current_vis.png")

    # Step 3: Fixed behavior
    print("\n" + "=" * 70)
    print("STEP 3: composeLayerSvg() — FIXED")
    print("=" * 70)

    fixed_result = apply_transform_to_path_FIXED(main_path_d, test_transform)
    fixed_subpaths = split_subpaths(fixed_result)
    print(f"  Input:  {len(split_subpaths(main_path_d))} subpaths")
    print(f"  Output: {len(fixed_subpaths)} subpaths  ← HOLES PRESERVED!")

    fixed_svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <path d="{fixed_result}" fill="white" stroke="none" fill-rule="evenodd"/>
</svg>'''
    (OUTPUT_DIR / "step3_fixed_composed.svg").write_text(fixed_svg)
    svg_to_visualization(fixed_svg, f"Step 3: FIXED compose ({len(fixed_subpaths)} subpaths preserved)", OUTPUT_DIR / "step3_fixed_vis.png")

    # Step 4: Show what CutBoard receives
    print("\n" + "=" * 70)
    print("STEP 4: What CutBoard receives")
    print("=" * 70)
    print(f"  CURRENT: 1 giant self-intersecting polygon → messy triangulation")
    print(f"  FIXED:   {len(fixed_subpaths)} clean subpaths (1 outer + {len(fixed_subpaths)-1} holes) → proper evenodd")

    # Validate: check if fixed output is geometrically valid
    try:
        from shapely.geometry import Polygon
        from shapely.validation import explain_validity

        # Parse outer and holes from fixed result
        outer_pts = parse_path_to_points_CURRENT(fixed_subpaths[0])
        outer_poly = Polygon(outer_pts)
        print(f"\n  Fixed outer polygon: valid={outer_poly.is_valid}, area={outer_poly.area:.0f}")

        for hi, sp in enumerate(fixed_subpaths[1:]):
            hole_pts = parse_path_to_points_CURRENT(sp)
            hole_poly = Polygon(hole_pts)
            contained = outer_poly.contains(hole_poly)
            print(f"  Fixed hole {hi}: valid={hole_poly.is_valid}, area={hole_poly.area:.0f}, contained={contained}")

        # Check current (broken) - is it self-intersecting?
        current_pts = parse_path_to_points_CURRENT(current_result)
        current_poly = Polygon(current_pts)
        print(f"\n  Current (broken) polygon: valid={current_poly.is_valid}")
        if not current_poly.is_valid:
            print(f"    Reason: {explain_validity(current_poly)}")
    except ImportError:
        print("  (shapely not installed, skipping validation)")

    print(f"\n{'=' * 70}")
    print(f"Output files in: {OUTPUT_DIR}/")
    print(f"  step1_backend_svg.svg  — original from mask_to_svg")
    print(f"  step1_vis.png          — visualization")
    print(f"  step2_current_composed.svg  — BROKEN (holes flattened)")
    print(f"  step2_current_vis.png       — shows single polygon")
    print(f"  step3_fixed_composed.svg    — FIXED (holes preserved)")
    print(f"  step3_fixed_vis.png         — shows outer + holes")


if __name__ == "__main__":
    main()
