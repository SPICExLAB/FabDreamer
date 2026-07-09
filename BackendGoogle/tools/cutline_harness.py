"""
Cut-line diagnostic & regression harness.

Batch-runs mask -> SVG conversion (utils.svg_converter) over saved masks,
measures stability/quality metrics, renders comparison sheets, and diffs
against a previous run to make converter changes measurable.

Usage (from BackendGoogle/):
    venv/bin/python tools/cutline_harness.py --out eval_results/cutline/before
    venv/bin/python tools/cutline_harness.py --out eval_results/cutline/after \
        --baseline eval_results/cutline/before

Inputs default to output/*/layer_*/mask_*.png (SAM2 masks saved per session).

Per input:
  - subpath / hole / tiny-fragment counts, vertex count, smallest subpath area
  - IoU between the rasterized SVG and the source binary mask
  - determinism: converts twice, asserts byte-identical SVG
  - comparison sheet PNG: [source mask | red cut-line render | overlay]

Outputs under --out:
  metrics.csv, summary.json, sheets/<name>.png, svg/<name>.svg
"""

import argparse
import csv
import io
import json
import sys
from pathlib import Path

import numpy as np
import cv2
from PIL import Image

# Allow running from BackendGoogle/ or tools/
BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from utils.svg_converter import mask_to_svg  # noqa: E402

try:
    import cairosvg
except ImportError:
    cairosvg = None

TINY_AREA_RATIO = 0.001  # subpaths below 0.1% of image area count as "tiny"


# ---------------------------------------------------------------- SVG parsing

def parse_svg_subpaths(svg: str):
    """Parse the converter's M/L/Z path output into a list of point arrays."""
    import re
    subpaths = []
    for d in re.findall(r'd="([^"]+)"', svg):
        for sub in d.split("M"):
            sub = sub.strip()
            if not sub:
                continue
            pts = []
            for tok in sub.replace("Z", "").split("L"):
                tok = tok.strip()
                if not tok:
                    continue
                try:
                    x, y = tok.split(",")
                    pts.append((float(x), float(y)))
                except ValueError:
                    pass
            if len(pts) >= 3:
                subpaths.append(np.array(pts))
    return subpaths


def polygon_area(pts: np.ndarray) -> float:
    x, y = pts[:, 0], pts[:, 1]
    return abs(float(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))) / 2.0


def count_path_elements(svg: str) -> int:
    return svg.count("<path")


# ------------------------------------------------------------------ rendering

def rasterize_svg(svg: str, width: int, height: int) -> np.ndarray:
    """Render the fill SVG to a binary numpy mask (True = shape)."""
    png = cairosvg.svg2png(
        bytestring=svg.encode("utf-8"),
        output_width=width,
        output_height=height,
        background_color="black",
    )
    img = np.array(Image.open(io.BytesIO(png)).convert("L"))
    return img > 127


def render_cutline(svg: str, width: int, height: int) -> np.ndarray:
    """Render the SVG as red stroke on white (what the laser 'sees')."""
    stroked = svg.replace('fill="white"', 'fill="none"').replace(
        'stroke="none"', 'stroke="red" stroke-width="2"'
    )
    png = cairosvg.svg2png(
        bytestring=stroked.encode("utf-8"),
        output_width=width,
        output_height=height,
        background_color="white",
    )
    return np.array(Image.open(io.BytesIO(png)).convert("RGB"))


def make_sheet(mask: np.ndarray, cutline: np.ndarray, out_path: Path):
    """[source mask | red cut-line render | overlay] side by side."""
    h, w = mask.shape
    mask_rgb = np.stack([np.where(mask, 220, 30)] * 3, axis=-1).astype(np.uint8)
    overlay = mask_rgb.copy()
    red = (cutline[:, :, 0] > 180) & (cutline[:, :, 1] < 120)
    overlay[red] = [255, 40, 40]
    gap = np.full((h, 8, 3), 255, dtype=np.uint8)
    sheet = np.concatenate([mask_rgb, gap, cutline, gap, overlay], axis=1)
    Image.fromarray(sheet).save(out_path)


# ------------------------------------------------------------------- pipeline

def process_mask(mask_path: Path, out_dir: Path, rel_name: str, sheets: bool):
    mask_bytes = mask_path.read_bytes()
    mask_img = Image.open(io.BytesIO(mask_bytes)).convert("L")
    mask_arr = np.array(mask_img)
    h, w = mask_arr.shape
    image_area = w * h
    src_binary = mask_arr > 127

    svg1 = mask_to_svg(mask_bytes)
    svg2 = mask_to_svg(mask_bytes)
    deterministic = svg1 == svg2

    subpaths = parse_svg_subpaths(svg1)
    areas = [polygon_area(p) for p in subpaths]
    n_paths = count_path_elements(svg1)
    n_subpaths = len(subpaths)
    n_holes = max(0, n_subpaths - n_paths)
    n_tiny = sum(1 for a in areas if a < image_area * TINY_AREA_RATIO)
    vertices = int(sum(len(p) for p in subpaths))
    min_area_ratio = (min(areas) / image_area) if areas else 0.0

    iou = float("nan")
    if cairosvg is not None and n_subpaths:
        rendered = rasterize_svg(svg1, w, h)
        inter = np.logical_and(rendered, src_binary).sum()
        union = np.logical_or(rendered, src_binary).sum()
        iou = float(inter) / float(union) if union else 1.0

    svg_out = out_dir / "svg" / f"{rel_name}.svg"
    svg_out.parent.mkdir(parents=True, exist_ok=True)
    svg_out.write_text(svg1)

    if sheets and cairosvg is not None:
        sheet_out = out_dir / "sheets" / f"{rel_name}.png"
        sheet_out.parent.mkdir(parents=True, exist_ok=True)
        make_sheet(src_binary, render_cutline(svg1, w, h), sheet_out)

    return {
        "name": rel_name,
        "width": w,
        "height": h,
        "n_paths": n_paths,
        "n_subpaths": n_subpaths,
        "n_holes": n_holes,
        "n_tiny_subpaths": n_tiny,
        "vertices": vertices,
        "min_subpath_area_ratio": round(min_area_ratio, 6),
        "iou": round(iou, 4) if iou == iou else "",
        "deterministic": deterministic,
        "svg_bytes": len(svg1),
    }


def load_baseline(baseline_dir: Path):
    csv_path = baseline_dir / "metrics.csv"
    if not csv_path.exists():
        print(f"WARNING: no metrics.csv in baseline {baseline_dir}", file=sys.stderr)
        return {}
    with open(csv_path) as f:
        return {row["name"]: row for row in csv.DictReader(f)}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--masks", default="output/*/layer_*/mask_*.png",
                    help="Glob (relative to BackendGoogle/) for binary mask PNGs")
    ap.add_argument("--out", required=True, help="Output directory for this run")
    ap.add_argument("--baseline", help="Previous run directory to diff against")
    ap.add_argument("--limit", type=int, help="Process at most N masks")
    ap.add_argument("--no-sheets", action="store_true", help="Skip comparison sheet PNGs")
    args = ap.parse_args()

    if cairosvg is None:
        print("WARNING: cairosvg unavailable — IoU and sheets disabled", file=sys.stderr)

    mask_paths = sorted(BACKEND_DIR.glob(args.masks))
    if args.limit:
        mask_paths = mask_paths[: args.limit]
    if not mask_paths:
        print(f"No masks matched {args.masks}", file=sys.stderr)
        sys.exit(1)

    out_dir = Path(args.out)
    if not out_dir.is_absolute():
        out_dir = BACKEND_DIR / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = []
    for i, p in enumerate(mask_paths):
        rel_name = str(p.relative_to(BACKEND_DIR / "output")).replace("/", "__").removesuffix(".png")
        try:
            rows.append(process_mask(p, out_dir, rel_name, sheets=not args.no_sheets))
        except Exception as e:  # keep batch going; a crash is itself a finding
            print(f"ERROR {p}: {e}", file=sys.stderr)
            rows.append({"name": rel_name, "error": str(e)})
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(mask_paths)}")

    ok_rows = [r for r in rows if "error" not in r]
    fieldnames = list(ok_rows[0].keys()) if ok_rows else ["name"]
    with open(out_dir / "metrics.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames + (["error"] if len(ok_rows) < len(rows) else []),
                                extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    ious = [r["iou"] for r in ok_rows if r.get("iou") != ""]
    summary = {
        "inputs": len(rows),
        "errors": len(rows) - len(ok_rows),
        "non_deterministic": sum(1 for r in ok_rows if not r["deterministic"]),
        "total_subpaths": sum(r["n_subpaths"] for r in ok_rows),
        "total_tiny_subpaths": sum(r["n_tiny_subpaths"] for r in ok_rows),
        "total_vertices": sum(r["vertices"] for r in ok_rows),
        "mean_iou": round(float(np.mean(ious)), 4) if ious else None,
        "min_iou": round(float(np.min(ious)), 4) if ious else None,
        "inputs_with_tiny_subpaths": sum(1 for r in ok_rows if r["n_tiny_subpaths"] > 0),
    }

    if args.baseline:
        base = load_baseline(Path(args.baseline) if Path(args.baseline).is_absolute()
                             else BACKEND_DIR / args.baseline)
        matched = [r for r in ok_rows if r["name"] in base]
        if matched:
            d_sub = sum(r["n_subpaths"] - int(base[r["name"]]["n_subpaths"]) for r in matched)
            d_tiny = sum(r["n_tiny_subpaths"] - int(base[r["name"]]["n_tiny_subpaths"]) for r in matched)
            d_vert = sum(r["vertices"] - int(base[r["name"]]["vertices"]) for r in matched)
            base_ious = [float(base[r["name"]]["iou"]) for r in matched
                         if base[r["name"]].get("iou") not in ("", None)]
            summary["baseline"] = {
                "matched_inputs": len(matched),
                "delta_subpaths": d_sub,
                "delta_tiny_subpaths": d_tiny,
                "delta_vertices": d_vert,
                "baseline_mean_iou": round(float(np.mean(base_ious)), 4) if base_ious else None,
            }

    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    print(f"\nWrote {out_dir}/metrics.csv, summary.json"
          + ("" if args.no_sheets else f", sheets/ ({len(ok_rows)} PNGs)"))


if __name__ == "__main__":
    main()
