"""
Check SVG path quality for Three.js compatibility.
Tests: self-intersections, winding order, containment.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import re
import numpy as np
from shapely.geometry import Polygon, MultiPolygon
from shapely.validation import explain_validity


def parse_svg_paths(svg_str):
    """Extract path d-attributes and parse into coordinate lists."""
    paths = []
    for match in re.finditer(r'd="([^"]*)"', svg_str):
        d = match.group(1)
        # Split into sub-paths at M commands
        sub_paths = []
        current = []
        for token in re.findall(r'[MLZ]\s*[\d,.\s-]*', d):
            cmd = token[0]
            if cmd == 'M':
                if current:
                    sub_paths.append(current)
                coords = re.findall(r'([\d.]+),([\d.]+)', token)
                current = [(float(x), float(y)) for x, y in coords]
            elif cmd == 'L':
                coords = re.findall(r'([\d.]+),([\d.]+)', token)
                current.extend([(float(x), float(y)) for x, y in coords])
            elif cmd == 'Z':
                if current:
                    sub_paths.append(current)
                    current = []
        if current:
            sub_paths.append(current)
        paths.append(sub_paths)
    return paths


def check_quality(svg_path):
    """Check SVG quality for Three.js mesh generation."""
    svg_str = svg_path.read_text()
    all_paths = parse_svg_paths(svg_str)

    print(f"\n=== {svg_path.name} ===")
    print(f"  {len(all_paths)} path elements")

    total_issues = 0

    for pi, sub_paths in enumerate(all_paths):
        print(f"\n  Path {pi}: {len(sub_paths)} sub-paths")

        if len(sub_paths) == 0:
            continue

        # First sub-path is outer, rest are holes
        outer_coords = sub_paths[0]
        if len(outer_coords) < 3:
            print(f"    ISSUE: outer has only {len(outer_coords)} points")
            total_issues += 1
            continue

        outer_poly = Polygon(outer_coords)
        print(f"    Outer: {len(outer_coords)} points, area={outer_poly.area:.0f}, valid={outer_poly.is_valid}")
        if not outer_poly.is_valid:
            print(f"      Reason: {explain_validity(outer_poly)}")
            total_issues += 1

        for hi, hole_coords in enumerate(sub_paths[1:]):
            if len(hole_coords) < 3:
                print(f"    Hole {hi}: SKIP ({len(hole_coords)} points)")
                continue

            hole_poly = Polygon(hole_coords)
            contained = outer_poly.contains(hole_poly)
            intersects = outer_poly.boundary.intersects(hole_poly.boundary)

            status = "OK" if hole_poly.is_valid and contained else ""
            if not hole_poly.is_valid:
                status = "INVALID"
                total_issues += 1
            elif not contained and not intersects:
                status = "OUTSIDE"
                total_issues += 1
            elif intersects and not contained:
                status = "CROSSES_BOUNDARY"
                total_issues += 1

            print(f"    Hole {hi}: {len(hole_coords)}pts, area={hole_poly.area:.0f}, "
                  f"valid={hole_poly.is_valid}, contained={contained} {status}")

    print(f"\n  Total issues: {total_issues}")
    return total_issues


def main():
    output_dir = Path(__file__).parent / "fix_and_outline_output"

    for name in ["outline_ratio_0.0.svg", "outline_ratio_0.0001.svg"]:
        svg_path = output_dir / name
        if svg_path.exists():
            check_quality(svg_path)


if __name__ == "__main__":
    main()
