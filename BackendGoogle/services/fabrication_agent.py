"""
Fabrication Agent Service

AI agent that analyzes designs for fabrication issues and can fix them.
Uses Gemini 2.5 Flash with function calling (tool use).
"""

import logging
import json
from typing import Optional, Dict, Any, List

from google import genai
from google.genai import types

from prompts.prompts import FABRICATION_AGENT_PROMPT

logger = logging.getLogger(__name__)


# =============================================================================
# Tool Definitions (model-agnostic format, converted to Gemini at call time)
# =============================================================================

FABRICATION_TOOLS = [
    {
        "name": "analyze_layer_connectivity",
        "description": "Analyze a layer's SVG paths to find floating/isolated parts that are not connected to the outer boundary. Returns detailed connectivity analysis including which parts touch which, and identifies floating parts that will fall out after laser cutting.",
        "parameters": {
            "type": "object",
            "properties": {
                "layer_id": {
                    "type": "string",
                    "description": "The ID of the layer to analyze"
                }
            },
            "required": ["layer_id"]
        }
    },
    {
        "name": "find_floating_parts",
        "description": "Find all parts in a layer that are completely enclosed by cuts and not connected to the boundary or other anchored parts. These parts will fall out after cutting and need bridges or tabs to stay attached.",
        "parameters": {
            "type": "object",
            "properties": {
                "layer_id": {
                    "type": "string",
                    "description": "The ID of the layer to analyze"
                }
            },
            "required": ["layer_id"]
        }
    },
    {
        "name": "add_bridge",
        "description": "Add a connecting bridge between two parts to prevent one from being a floating/isolated piece. The bridge is a small rectangular connector. Use this when connecting to a nearby part would look natural.",
        "parameters": {
            "type": "object",
            "properties": {
                "layer_id": {
                    "type": "string",
                    "description": "The layer containing the parts"
                },
                "from_part_id": {
                    "type": "string",
                    "description": "ID of the floating part to connect"
                },
                "to_part_id": {
                    "type": "string",
                    "description": "ID of the anchor part to connect to. Use 'boundary' to connect to the outer frame."
                },
                "bridge_width_mm": {
                    "type": "number",
                    "description": "Width of the bridge in millimeters. Default is 2.0mm which is sturdy but not too visible."
                },
                "from_point": {
                    "type": "object",
                    "properties": {
                        "x": {"type": "number"},
                        "y": {"type": "number"}
                    },
                    "description": "Optional explicit start point in SVG coordinates (0-1024). If provided with to_point, overrides auto-computed nearest points."
                },
                "to_point": {
                    "type": "object",
                    "properties": {
                        "x": {"type": "number"},
                        "y": {"type": "number"}
                    },
                    "description": "Optional explicit end point in SVG coordinates (0-1024). If provided with from_point, overrides auto-computed nearest points."
                }
            },
            "required": ["layer_id", "from_part_id", "to_part_id"]
        }
    },
    {
        "name": "add_tabs_to_border",
        "description": "Add multiple small tabs connecting a floating part to the outer border/frame. Good for parts that should stay attached but have minimal visible connection. Tabs can be snapped off after cutting if needed.",
        "parameters": {
            "type": "object",
            "properties": {
                "layer_id": {
                    "type": "string",
                    "description": "The layer containing the part"
                },
                "part_id": {
                    "type": "string",
                    "description": "ID of the floating part to add tabs to"
                },
                "num_tabs": {
                    "type": "integer",
                    "description": "Number of tabs to add. Default is 2 which provides stability without being too intrusive."
                },
                "tab_width_mm": {
                    "type": "number",
                    "description": "Width of each tab in millimeters. Default is 1.5mm for minimal visibility."
                }
            },
            "required": ["layer_id", "part_id"]
        }
    },
    {
        "name": "highlight_part",
        "description": "Highlight a specific part on the canvas to show the user which part has an issue or is being discussed.",
        "parameters": {
            "type": "object",
            "properties": {
                "layer_id": {
                    "type": "string",
                    "description": "The layer containing the part"
                },
                "part_id": {
                    "type": "string",
                    "description": "ID of the part to highlight"
                },
                "highlight_type": {
                    "type": "string",
                    "enum": ["warning", "error", "info", "success"],
                    "description": "Type of highlight: 'warning' for potential issues, 'error' for critical issues, 'info' for neutral, 'success' for fixed"
                }
            },
            "required": ["layer_id", "part_id"]
        }
    },
    {
        "name": "get_part_info",
        "description": "Get detailed information about a specific part including its geometry, position, connections, and fabrication status.",
        "parameters": {
            "type": "object",
            "properties": {
                "layer_id": {
                    "type": "string",
                    "description": "The layer containing the part"
                },
                "part_id": {
                    "type": "string",
                    "description": "ID of the part to get info about"
                }
            },
            "required": ["layer_id", "part_id"]
        }
    },
    {
        "name": "preview_fix",
        "description": "Generate a preview of what a fix will look like without actually applying it. Shows the user the proposed bridge or tabs before committing.",
        "parameters": {
            "type": "object",
            "properties": {
                "layer_id": {
                    "type": "string",
                    "description": "The layer to preview the fix on"
                },
                "fix_type": {
                    "type": "string",
                    "enum": ["add_bridge", "add_tabs"],
                    "description": "Type of fix to preview"
                },
                "fix_params": {
                    "type": "object",
                    "description": "Parameters for the fix (same as the corresponding fix tool)"
                }
            },
            "required": ["layer_id", "fix_type", "fix_params"]
        }
    },
    {
        "name": "apply_all_fixes",
        "description": "Apply recommended fixes for all floating parts in a layer. Uses smart defaults based on part positions and design context.",
        "parameters": {
            "type": "object",
            "properties": {
                "layer_id": {
                    "type": "string",
                    "description": "The layer to fix"
                },
                "fix_strategy": {
                    "type": "string",
                    "enum": ["minimal_tabs", "natural_bridges", "auto"],
                    "description": "Strategy: 'minimal_tabs' uses small tabs to border, 'natural_bridges' connects to nearby parts, 'auto' chooses best for each part based on context"
                }
            },
            "required": ["layer_id"]
        }
    },
    {
        "name": "check_fabrication_ready",
        "description": "Check if a layer is ready for fabrication. Returns true if there are no floating parts or other structural issues.",
        "parameters": {
            "type": "object",
            "properties": {
                "layer_id": {
                    "type": "string",
                    "description": "The layer to check"
                }
            },
            "required": ["layer_id"]
        }
    },
    {
        "name": "detect_thin_areas",
        "description": "Detect areas in a layer that are too thin/narrow for the selected material. Thin areas may break during or after laser cutting. The minimum width threshold depends on the material.",
        "parameters": {
            "type": "object",
            "properties": {
                "layer_id": {
                    "type": "string",
                    "description": "The layer to check for thin areas"
                },
                "min_width_mm": {
                    "type": "number",
                    "description": "Minimum acceptable width in millimeters. Defaults to material-appropriate value (typically 1.0mm for plywood, 1.5mm for acrylic)."
                }
            },
            "required": ["layer_id"]
        }
    },
    {
        "name": "analyze_all_layers",
        "description": "Run a comprehensive analysis on ALL layers at once: connectivity (floating parts) + thin area detection. Use this when the user enters fabrication mode or asks for a full design check.",
        "parameters": {
            "type": "object",
            "properties": {
                "min_width_mm": {
                    "type": "number",
                    "description": "Minimum acceptable width in mm. Defaults to material-appropriate value."
                }
            },
            "required": []
        }
    },
    {
        "name": "set_material",
        "description": "Set the material for a specific layer. You determine all properties based on your material knowledge. Affects 3D appearance, thickness, and min width for thin-feature detection.",
        "parameters": {
            "type": "object",
            "properties": {
                "layer_id": {
                    "type": "string",
                    "description": "The ID of the layer to set the material for"
                },
                "material_name": {
                    "type": "string",
                    "description": "Human-readable material name (e.g. 'Clear Acrylic', 'Birch Plywood', '3mm Red Acrylic')"
                },
                "thickness_mm": {
                    "type": "number",
                    "description": "Material thickness in mm"
                },
                "min_width_mm": {
                    "type": "number",
                    "description": "Minimum safe feature width in mm for this material"
                },
                "appearance": {
                    "type": "object",
                    "description": "Visual properties for 3D rendering",
                    "properties": {
                        "color": {
                            "type": "string",
                            "description": "Hex color string (e.g. '#d4a76a' for plywood, '#ffffff' for clear acrylic)"
                        },
                        "roughness": {
                            "type": "number",
                            "description": "Surface roughness 0.0 (mirror) to 1.0 (matte). Wood ~0.7, polished acrylic ~0.1"
                        },
                        "metalness": {
                            "type": "number",
                            "description": "Metalness 0.0-1.0. Almost always 0.0 for laser-cut materials"
                        },
                        "clearcoat": {
                            "type": "number",
                            "description": "Glossy clearcoat layer 0.0-1.0. Acrylic ~0.8-1.0, raw wood ~0.0"
                        },
                        "transmission": {
                            "type": "number",
                            "description": "Transparency 0.0 (opaque) to 1.0 (fully transparent). Clear acrylic ~0.9, wood = 0.0"
                        },
                        "opacity": {
                            "type": "number",
                            "description": "Overall opacity 0.0-1.0. Usually 1.0 (use transmission for transparent materials)"
                        },
                        "ior": {
                            "type": "number",
                            "description": "Index of refraction (only if transmission > 0). Acrylic = 1.49, glass = 1.5"
                        },
                        "useWoodTexture": {
                            "type": "boolean",
                            "description": "True for wood-based materials (plywood, MDF, bamboo, balsa) to show wood grain texture. False for non-wood materials."
                        }
                    }
                }
            },
            "required": ["layer_id", "material_name", "thickness_mm", "min_width_mm", "appearance"]
        }
    }
]


# =============================================================================
# Tool Execution Functions
# =============================================================================

class ToolExecutor:
    """Executes fabrication tools on layer data using real geometry analysis."""

    def __init__(self, layer_data: Dict[str, Any]):
        self.layer_data = layer_data
        self.highlights: List[Dict] = []
        self.svg_updates: List[Dict] = []
        self._analysis_cache: Dict[str, Dict] = {}

        canvas_size = layer_data.get("canvasSize", {})
        self._editing_width = float(canvas_size.get("width", 0))
        self._editing_height = float(canvas_size.get("height", 0))

        fab = layer_data.get("fabrication", {})
        self._fabrication_scale = float(fab.get("scale", 1.0))
        # Physical size of the 1024-unit canvas at scale 1.0 (~104.4mm)
        # Falls back to 304.8mm (full board) for backward compat
        self._canvas_size_mm = float(fab.get("canvasSizeMm", 304.8))

    @staticmethod
    def _normalize_ids(params: Dict[str, Any]) -> Dict[str, Any]:
        """Cast ID fields to strings — Gemini sometimes returns numeric-looking IDs as numbers."""
        id_keys = ("layer_id", "part_id", "from_part_id", "to_part_id")
        out = dict(params)
        for k in id_keys:
            if k in out and out[k] is not None:
                out[k] = str(out[k])
        return out

    def execute(self, tool_name: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a tool and return the result."""
        params = self._normalize_ids(params)
        tool_map = {
            "analyze_layer_connectivity": self._analyze_connectivity,
            "find_floating_parts": self._find_floating_parts,
            "add_bridge": self._add_bridge,
            "add_tabs_to_border": self._add_tabs,
            "highlight_part": self._highlight_part,
            "get_part_info": self._get_part_info,
            "preview_fix": self._preview_fix,
            "apply_all_fixes": self._apply_all_fixes,
            "check_fabrication_ready": self._check_fabrication_ready,
            "detect_thin_areas": self._detect_thin_areas,
            "analyze_all_layers": self._analyze_all_layers,
            "set_material": self._set_material,
        }

        if tool_name not in tool_map:
            return {"error": f"Unknown tool: {tool_name}"}

        try:
            result = tool_map[tool_name](params)
            logger.info(f"Tool {tool_name} executed successfully")
            return result
        except Exception as e:
            logger.exception(f"Tool execution failed: {tool_name}")
            return {"error": str(e)}

    def _get_layer(self, layer_id: str) -> Optional[Dict]:
        """Get layer by ID (string comparison, tolerant of numeric IDs)."""
        layer_id_str = str(layer_id)
        for layer in self.layer_data.get("layers", []):
            if str(layer.get("id")) == layer_id_str:
                return layer
        return None

    def _inject_fix_segment(self, layer_id: str, fix_svg: str, fix_type: str,
                            segment_id: str = None):
        """Inject a fix into layer_data so subsequent tool calls see it.

        If segment_id is provided, replaces that segment's SVG in-place
        (boolean union merge). Otherwise appends a new fix segment.
        """
        layer = self._get_layer(layer_id)
        if not layer:
            return

        if segment_id:
            # Replace existing segment's SVG (bridge merged into part).
            # The merged SVG is already in 1024 world coordinates, so set
            # skipTransform to prevent re-applying the segment transform
            # during subsequent analyses within the same turn.
            for seg in layer.get("segments", []):
                if str(seg.get("id")) == str(segment_id):
                    seg["svg"] = fix_svg
                    seg["skipTransform"] = True
                    seg["skipClip"] = True
                    logger.info(f"Replaced segment {segment_id} SVG with merged bridge")
                    return
            logger.warning(f"Segment {segment_id} not found for replacement, appending instead")

        import time
        fix_seg = {
            "id": f"fix-{fix_type}-{int(time.time()*1000)}",
            "name": f"Fix: {fix_type}",
            "svg": fix_svg,
            "isFrame": False,
            "skipClip": True,
        }
        layer.setdefault("segments", []).append(fix_seg)

    def _get_layer_analysis(self, layer_id: str) -> Dict:
        """Get or compute layer analysis (cached)."""
        if layer_id in self._analysis_cache:
            return self._analysis_cache[layer_id]

        layer = self._get_layer(layer_id)
        if not layer:
            return {"error": f"Layer not found: {layer_id}"}

        from utils.geometry_analyzer import analyze_layer_for_fabrication

        analysis = analyze_layer_for_fabrication(
            layer,
            editing_width=self._editing_width,
            editing_height=self._editing_height,
        )
        self._analysis_cache[layer_id] = analysis
        return analysis

    def _analyze_connectivity(self, params: Dict) -> Dict:
        """Analyze layer connectivity using real geometry analysis."""
        layer_id = params.get("layer_id")
        analysis = self._get_layer_analysis(layer_id)

        if "error" in analysis:
            return analysis

        has_frame = analysis.get("has_frame", True)

        result = {
            "layer_id": layer_id,
            "layer_name": analysis.get("layer_name"),
            "total_parts": analysis.get("total_parts", 0),
            "valid_parts": analysis.get("valid_parts", 0),
            "floating_parts_count": analysis.get("floating_parts_count", 0),
            "floating_parts": analysis.get("floating_parts", []),
            "connectivity": analysis.get("connectivity", []),
            "issues": analysis.get("issues", []),
            "is_fabrication_ready": analysis.get("is_fabrication_ready", False),
            "summary": self._generate_connectivity_summary(analysis)
        }

        if not has_frame:
            result["message"] = "No frame — floating detection skipped"

        return result

    def _generate_connectivity_summary(self, analysis: Dict) -> str:
        """Generate human-readable summary of connectivity analysis."""
        total = analysis.get("total_parts", 0)
        floating = analysis.get("floating_parts_count", 0)

        if floating == 0:
            return f"All {total} parts are properly connected. Layer is ready for fabrication."
        elif floating == 1:
            part = analysis.get("floating_parts", [{}])[0]
            return f"Found 1 floating part: '{part.get('part_name', 'unknown')}'. It needs to be connected to prevent falling out after cutting."
        else:
            names = [p.get("part_name", "unknown")
                     for p in analysis.get("floating_parts", [])]
            return f"Found {floating} floating parts: {', '.join(names)}. These need to be connected to prevent falling out after cutting."

    def _find_floating_parts(self, params: Dict) -> Dict:
        """Find all floating parts using real geometry analysis."""
        layer_id = params.get("layer_id")
        analysis = self._get_layer_analysis(layer_id)

        if "error" in analysis:
            return analysis

        has_frame = analysis.get("has_frame", True)
        if not has_frame:
            return {
                "layer_id": layer_id,
                "floating_parts": [],
                "count": 0,
                "message": "No frame — floating detection skipped"
            }

        floating_parts = analysis.get("floating_parts", [])

        for part in floating_parts:
            self.highlights.append({
                "layer_id": layer_id,
                "part_id": part.get("part_id"),
                "type": "error",
                "reason": "floating"
            })

        return {
            "layer_id": layer_id,
            "floating_parts": floating_parts,
            "count": len(floating_parts),
            "message": f"Found {len(floating_parts)} floating part(s)" if floating_parts else "No floating parts found"
        }

    def _add_bridge(self, params: Dict) -> Dict:
        """Add a connecting bridge between parts using real geometry."""
        layer_id = params.get("layer_id")
        from_part = params.get("from_part_id")
        to_part = params.get("to_part_id")
        width = params.get("bridge_width_mm", 3.0)
        from_point = params.get("from_point")
        to_point = params.get("to_point")

        layer = self._get_layer(layer_id)
        if not layer:
            return {"error": f"Layer not found: {layer_id}"}

        from utils.geometry_analyzer import generate_fix_svg

        fix_params = {
            "from_part_id": from_part,
            "to_part_id": to_part,
            "bridge_width_mm": width
        }

        # Pass through explicit user-drawn bridge points
        if from_point and to_point:
            fix_params["from_point"] = (from_point["x"], from_point["y"])
            fix_params["to_point"] = (to_point["x"], to_point["y"])

        result = generate_fix_svg(
            "add_bridge", layer, fix_params,
            editing_width=self._editing_width,
            editing_height=self._editing_height,
            fabrication_scale=self._fabrication_scale,
            board_size_mm=self._canvas_size_mm,
        )

        if result.get("success"):
            merged_svg = result.get("merged_svg")
            segment_id = result.get("segment_id")

            if merged_svg and segment_id:
                # Combined union: segment now contains merged shape
                self.svg_updates.append({
                    "type": "segment_update",
                    "layer_id": layer_id,
                    "segment_id": segment_id,
                    "svg": merged_svg,
                })
                self._inject_fix_segment(layer_id, merged_svg, "bridge",
                                         segment_id=segment_id)

                # If frame ring was merged into the segment, disable
                # separate frame rendering to avoid duplicate edges
                if result.get("boundary_disabled"):
                    self.svg_updates.append({
                        "type": "boundary_update",
                        "layer_id": layer_id,
                        "disabled": True,
                    })

                # If target part was merged into from_part, hide target segment
                # (its geometry is now part of the combined shape).
                # Use the merged SVG for connectivity analysis — the merged
                # shape touches the boundary/other parts, so the target should
                # be recognized as connected, not floating.
                to_seg_id = result.get("to_segment_id")
                if to_seg_id:
                    self.svg_updates.append({
                        "type": "segment_update",
                        "layer_id": layer_id,
                        "segment_id": to_seg_id,
                        "svg": None,  # null → frontend hides, backend falls back to _bridgedSvg
                        "merged_into": segment_id,  # track which segment absorbed this one
                    })
                    # In-memory: set svg to the merged shape so same-turn
                    # re-analysis sees the combined geometry as connected.
                    self._inject_fix_segment(layer_id, merged_svg, "bridge-merged",
                                             segment_id=to_seg_id)
            else:
                # Fallback: add as separate segment
                bridge_svg = result.get("bridge_svg")
                self.svg_updates.append({
                    "type": "add_bridge",
                    "layer_id": layer_id,
                    "svg": bridge_svg,
                    "path": result.get("bridge_path"),
                    "from_part": from_part,
                    "to_part": to_part
                })
                self._inject_fix_segment(layer_id, bridge_svg, "bridge")

            self._analysis_cache.pop(layer_id, None)

            from_name = from_part
            to_name = to_part
            for seg in layer.get("segments", []):
                if seg.get("id") == from_part:
                    from_name = seg.get("name", from_part)
                if seg.get("id") == to_part:
                    to_name = seg.get("name", to_part)

            return {
                "success": True,
                "layer_id": layer_id,
                "action": "add_bridge",
                "from_part": from_part,
                "from_name": from_name,
                "to_part": to_part,
                "to_name": to_name,
                "bridge_width_mm": width,
                "bridge_svg": result.get("bridge_svg"),
                "bridge_path": result.get("bridge_path"),
                "connection_points": result.get("connection_points"),
                "message": f"Added {width}mm bridge connecting '{from_name}' to '{to_name}'"
            }

        return result

    def _add_tabs(self, params: Dict) -> Dict:
        """Add tabs connecting a part to the border using real geometry."""
        layer_id = params.get("layer_id")
        part_id = params.get("part_id")
        num_tabs = params.get("num_tabs", 2)
        tab_width = params.get("tab_width_mm", 1.5)

        layer = self._get_layer(layer_id)
        if not layer:
            return {"error": f"Layer not found: {layer_id}"}

        from utils.geometry_analyzer import generate_fix_svg

        fix_params = {
            "part_id": part_id,
            "num_tabs": num_tabs,
            "tab_width_mm": tab_width
        }

        result = generate_fix_svg(
            "add_tabs", layer, fix_params,
            editing_width=self._editing_width,
            editing_height=self._editing_height,
            fabrication_scale=self._fabrication_scale,
            board_size_mm=self._canvas_size_mm,
        )

        if result.get("success"):
            tabs_svg = result.get("tabs_svg")

            self.svg_updates.append({
                "type": "add_tabs",
                "layer_id": layer_id,
                "svg": tabs_svg,
                "paths": result.get("tab_paths"),
                "part_id": part_id
            })

            self._inject_fix_segment(layer_id, tabs_svg, "tabs")
            self._analysis_cache.pop(layer_id, None)

            part_name = part_id
            for seg in layer.get("segments", []):
                if seg.get("id") == part_id:
                    part_name = seg.get("name", part_id)
                    break

            return {
                "success": True,
                "layer_id": layer_id,
                "action": "add_tabs",
                "part_id": part_id,
                "part_name": part_name,
                "num_tabs": num_tabs,
                "tab_width_mm": tab_width,
                "tabs_svg": result.get("tabs_svg"),
                "tab_paths": result.get("tab_paths"),
                "tab_positions": result.get("tab_positions"),
                "message": f"Added {num_tabs} tabs ({tab_width}mm each) connecting '{part_name}' to border"
            }

        return result

    def _highlight_part(self, params: Dict) -> Dict:
        """Highlight a part for visualization."""
        layer_id = params.get("layer_id")
        part_id = params.get("part_id")
        highlight_type = params.get("highlight_type", "info")

        layer = self._get_layer(layer_id)
        if not layer:
            return {"error": f"Layer not found: {layer_id}"}

        part_name = part_id
        for seg in layer.get("segments", []):
            if seg.get("id") == part_id:
                part_name = seg.get("name", part_id)
                break

        self.highlights.append({
            "layer_id": layer_id,
            "part_id": part_id,
            "part_name": part_name,
            "type": highlight_type
        })

        return {
            "success": True,
            "layer_id": layer_id,
            "part_id": part_id,
            "part_name": part_name,
            "highlight_type": highlight_type,
            "message": f"Highlighted '{part_name}'"
        }

    def _get_part_info(self, params: Dict) -> Dict:
        """Get detailed info about a part."""
        layer_id = params.get("layer_id")
        part_id = params.get("part_id")

        layer = self._get_layer(layer_id)
        if not layer:
            return {"error": f"Layer not found: {layer_id}"}

        segment = None
        for seg in layer.get("segments", []):
            if seg.get("id") == part_id:
                segment = seg
                break

        if not segment:
            return {"error": f"Part not found: {part_id}"}

        analysis = self._get_layer_analysis(layer_id)
        connectivity = {}
        for conn in analysis.get("connectivity", []):
            if conn.get("part_id") == part_id:
                connectivity = conn
                break

        return {
            "part_id": part_id,
            "name": segment.get("name", part_id),
            "bbox": segment.get("bbox"),
            "has_svg": bool(segment.get("svg")),
            "has_trace": bool(segment.get("svg_trace")),
            "is_frame": segment.get("isFrame", False),
            "engrave_style": segment.get("engraveStyle", "traced"),
            "is_floating": connectivity.get("is_floating", None),
            "is_connected_to_boundary": connectivity.get("is_connected_to_boundary", None),
            "connected_to_parts": connectivity.get("connected_to", []),
            "nearest_anchor": connectivity.get("nearest_anchor"),
            "distance_to_nearest": connectivity.get("distance")
        }

    def _preview_fix(self, params: Dict) -> Dict:
        """Preview a fix without applying it."""
        layer_id = params.get("layer_id")
        fix_type = params.get("fix_type")
        fix_params = params.get("fix_params", {})

        layer = self._get_layer(layer_id)
        if not layer:
            return {"error": f"Layer not found: {layer_id}"}

        from utils.geometry_analyzer import generate_fix_svg

        result = generate_fix_svg(
            fix_type, layer, fix_params,
            editing_width=self._editing_width,
            editing_height=self._editing_height,
            fabrication_scale=self._fabrication_scale,
            board_size_mm=self._canvas_size_mm,
        )

        if result.get("success"):
            return {
                "layer_id": layer_id,
                "fix_type": fix_type,
                "fix_params": fix_params,
                "preview_svg": result.get("bridge_svg") or result.get("tabs_svg"),
                "preview_paths": result.get("bridge_path") or result.get("tab_paths"),
                "is_preview": True,
                "message": f"Preview of {fix_type} fix generated. Call the fix tool to apply."
            }

        return result

    def _apply_all_fixes(self, params: Dict) -> Dict:
        """Apply all recommended fixes to a layer."""
        layer_id = params.get("layer_id")
        strategy = params.get("fix_strategy", "auto")

        layer = self._get_layer(layer_id)
        if not layer:
            return {"error": f"Layer not found: {layer_id}"}

        analysis = self._get_layer_analysis(layer_id)
        floating_parts = analysis.get("floating_parts", [])

        if not floating_parts:
            return {
                "layer_id": layer_id,
                "fixes_applied": 0,
                "message": "No floating parts to fix"
            }

        fixes_applied = []

        for part in floating_parts:
            part_id = part.get("part_id")
            recommended = part.get("recommended_fix", "add_tabs")
            nearest = part.get("nearest_anchor", "boundary")

            if strategy == "minimal_tabs":
                fix_result = self._add_tabs({
                    "layer_id": layer_id,
                    "part_id": part_id,
                    "num_tabs": 2,
                    "tab_width_mm": 1.5
                })
            elif strategy == "natural_bridges":
                fix_result = self._add_bridge({
                    "layer_id": layer_id,
                    "from_part_id": part_id,
                    "to_part_id": nearest,
                    "bridge_width_mm": 3.0
                })
            else:  # auto
                fix_result = self._add_bridge({
                    "layer_id": layer_id,
                    "from_part_id": part_id,
                    "to_part_id": nearest,
                    "bridge_width_mm": 3.0
                })

            if fix_result.get("success"):
                fixes_applied.append(fix_result)

        return {
            "layer_id": layer_id,
            "strategy": strategy,
            "fixes_applied": len(fixes_applied),
            "fixes": fixes_applied,
            "message": f"Applied {len(fixes_applied)} fix(es) using '{strategy}' strategy"
        }

    def _check_fabrication_ready(self, params: Dict) -> Dict:
        """Check if layer is ready for fabrication."""
        layer_id = params.get("layer_id")
        analysis = self._get_layer_analysis(layer_id)

        if "error" in analysis:
            return analysis

        is_ready = analysis.get("is_fabrication_ready", False)
        issues = analysis.get("issues", [])

        return {
            "layer_id": layer_id,
            "is_ready": is_ready,
            "issues_count": len(issues),
            "issues": issues,
            "message": "Layer is ready for fabrication!" if is_ready else f"Layer has {len(issues)} issue(s) to resolve"
        }

    def _detect_thin_areas(self, params: Dict) -> Dict:
        """Detect thin/narrow areas in a layer."""
        layer_id = params.get("layer_id")
        min_width = params.get("min_width_mm", self._get_material_min_width(layer_id))

        layer = self._get_layer(layer_id)
        if not layer:
            return {"error": f"Layer not found: {layer_id}"}

        from utils.geometry_analyzer import analyze_thin_areas_for_layer

        thin_areas = analyze_thin_areas_for_layer(
            layer, min_width_mm=min_width,
            board_size_mm=self._canvas_size_mm,
            editing_width=self._editing_width,
            editing_height=self._editing_height,
            fabrication_scale=self._fabrication_scale,
        )

        for ta in thin_areas:
            if ta.get("severity") == "error":
                self.highlights.append({
                    "layer_id": layer_id,
                    "part_id": ta.get("part_id"),
                    "type": "error",
                    "reason": "thin_area"
                })
            elif ta.get("severity") == "warning":
                self.highlights.append({
                    "layer_id": layer_id,
                    "part_id": ta.get("part_id"),
                    "type": "warning",
                    "reason": "thin_area"
                })

        return {
            "layer_id": layer_id,
            "min_width_mm": min_width,
            "thin_areas": thin_areas,
            "count": len(thin_areas),
            "message": f"Found {len(thin_areas)} thin area(s) below {min_width}mm" if thin_areas else f"No areas thinner than {min_width}mm found"
        }

    def _analyze_all_layers(self, params: Dict) -> Dict:
        """Run comprehensive analysis on all layers."""
        min_width_override = params.get("min_width_mm")  # None → per-layer material default
        layers = self.layer_data.get("layers", [])

        if not layers:
            return {"error": "No layers in the design"}

        results = []
        total_floating = 0
        total_thin = 0
        all_ready = True

        for layer in layers:
            layer_id = layer.get("id")

            connectivity = self._analyze_connectivity({"layer_id": layer_id})
            floating_count = connectivity.get("floating_parts_count", 0)
            total_floating += floating_count

            # Get detailed floating part info for frontend UI
            floating_details = connectivity.get("floating_parts", [])

            thin_params = {"layer_id": layer_id}
            if min_width_override is not None:
                thin_params["min_width_mm"] = min_width_override
            thin = self._detect_thin_areas(thin_params)
            thin_count = thin.get("count", 0)
            thin_details = thin.get("thin_areas", [])
            total_thin += thin_count

            layer_ready = floating_count == 0 and thin_count == 0
            if not layer_ready:
                all_ready = False

            results.append({
                "layer_id": layer_id,
                "layer_name": layer.get("name", layer_id),
                "floating_parts": floating_count,
                "floating_parts_detail": floating_details,
                "thin_areas": thin_count,
                "thin_areas_detail": thin_details,
                "min_width_mm": thin.get("min_width_mm", 1.0),
                "is_ready": layer_ready,
            })

        return {
            "layers_analyzed": len(results),
            "total_floating_parts": total_floating,
            "total_thin_areas": total_thin,
            "all_layers_ready": all_ready,
            "per_layer": results,
            "message": (
                "All layers are ready for fabrication!"
                if all_ready
                else f"Found {total_floating} floating part(s) and {total_thin} thin area(s) across {len(results)} layer(s)"
            ),
        }

    def _set_material(self, params: Dict) -> Dict:
        """Set the material for a specific layer.
        AI provides all properties — no lookup table. We validate and pass through."""
        layer_id = params.get("layer_id")
        material_name = params.get("material_name", "Unknown")
        thickness_mm = params.get("thickness_mm", 3.0)
        min_width_mm = params.get("min_width_mm", 1.0)
        appearance = params.get("appearance", {})

        layer = self._get_layer(layer_id)
        if not layer:
            return {"error": f"Layer not found: {layer_id}"}

        # Validate and clamp appearance properties
        validated_appearance = {
            "color": appearance.get("color", "#d4a76a"),
            "roughness": max(0.0, min(1.0, float(appearance.get("roughness", 0.7)))),
            "metalness": max(0.0, min(1.0, float(appearance.get("metalness", 0.0)))),
            "clearcoat": max(0.0, min(1.0, float(appearance.get("clearcoat", 0.0)))),
            "transmission": max(0.0, min(1.0, float(appearance.get("transmission", 0.0)))),
            "opacity": max(0.0, min(1.0, float(appearance.get("opacity", 1.0)))),
            "ior": max(1.0, min(2.5, float(appearance.get("ior", 1.5)))),
            "useWoodTexture": bool(appearance.get("useWoodTexture", False)),
        }

        return {
            "success": True,
            "layer_id": layer_id,
            "material_name": material_name,
            "thickness_mm": float(thickness_mm),
            "min_width_mm": float(min_width_mm),
            "appearance": validated_appearance,
            "message": f"Set layer to {material_name} ({thickness_mm}mm thick, min width {min_width_mm}mm)"
        }

    def _get_material_min_width(self, layer_id: str = None) -> float:
        """Get minimum width threshold based on per-layer material data.
        Reads min_width_mm set by the AI via set_material tool."""
        if layer_id:
            layer = self._get_layer(layer_id)
            if layer:
                min_w = layer.get("min_width_mm")
                if min_w is not None:
                    return float(min_w)
        # Default fallback
        return 1.0


# =============================================================================
# Gemini Tool Format Conversion
# =============================================================================

_TYPE_MAP = {
    "string": "STRING",
    "number": "NUMBER",
    "integer": "INTEGER",
    "boolean": "BOOLEAN",
    "object": "OBJECT",
    "array": "ARRAY",
}


def _convert_schema(schema: Dict) -> Dict:
    """Convert JSON Schema dict to Gemini Schema dict format."""
    result = {"type": _TYPE_MAP.get(schema.get("type", "string"), "STRING")}

    if "description" in schema:
        result["description"] = schema["description"]

    if "enum" in schema:
        result["enum"] = schema["enum"]

    if "properties" in schema:
        result["properties"] = {
            k: _convert_schema(v) for k, v in schema["properties"].items()
        }

    if "required" in schema and schema["required"]:
        result["required"] = schema["required"]

    return result


def get_gemini_tools() -> types.Tool:
    """Convert tool definitions to Gemini FunctionDeclaration format."""
    declarations = []
    for tool in FABRICATION_TOOLS:
        params = tool.get("parameters", {})
        decl_kwargs = {
            "name": tool["name"],
            "description": tool["description"],
        }
        if params.get("properties"):
            decl_kwargs["parameters"] = _convert_schema(params)

        declarations.append(types.FunctionDeclaration(**decl_kwargs))

    return types.Tool(function_declarations=declarations)


# =============================================================================
# Fabrication Agent (Gemini 2.5 Flash)
# =============================================================================

class FabricationAgent:
    """
    AI agent for fabrication analysis and fixes.
    Uses Gemini 2.5 Flash with function calling.
    """

    MODEL_ID = "gemini-2.5-flash"

    SYSTEM_PROMPT = FABRICATION_AGENT_PROMPT

    def __init__(self, api_key: Optional[str] = None):
        """Initialize the agent with Gemini client."""
        import os
        self.api_key = api_key or os.getenv("GEMINI_API_KEY")
        if not self.api_key:
            raise ValueError("GEMINI_API_KEY not found")

        self.client = genai.Client(api_key=self.api_key)
        logger.info(
            f"Fabrication Agent initialized with Gemini {self.MODEL_ID}")

    async def chat(
        self,
        message: str,
        layer_data: Dict[str, Any],
        conversation_history: List[Dict] = None
    ) -> Dict[str, Any]:
        """
        Process a user message with access to fabrication tools (non-streaming).

        Args:
            message: User's message/question
            layer_data: Current layer data from frontend
            conversation_history: Previous messages for context

        Returns:
            {
                "response": "Agent's text response",
                "tool_calls": [...],
                "tool_results": [...],
                "highlights": [...],
                "svg_updates": [...],
            }
        """
        executor = ToolExecutor(layer_data)
        tool = get_gemini_tools()

        # Build contents list
        contents = []

        if conversation_history:
            for msg in conversation_history:
                role = "user" if msg.get("role") == "user" else "model"
                contents.append(types.Content(
                    role=role,
                    parts=[types.Part.from_text(text=msg.get("content", ""))]
                ))

        layer_summary = self._summarize_layers(layer_data)
        user_content = f"""Current design state:
{layer_summary}

User request: {message}"""

        contents.append(types.Content(
            role="user",
            parts=[types.Part.from_text(text=user_content)]
        ))

        config = types.GenerateContentConfig(
            tools=[tool],
            system_instruction=self.SYSTEM_PROMPT,
            temperature=0.7,
            max_output_tokens=4096,
        )

        all_tool_calls = []
        all_tool_results = []
        final_response = ""
        max_iterations = 10

        for iteration in range(max_iterations):
            try:
                response = self.client.models.generate_content(
                    model=self.MODEL_ID,
                    contents=contents,
                    config=config,
                )
            except Exception as e:
                logger.error(f"Gemini API error: {e}")
                return {
                    "response": f"I encountered an error communicating with the AI service: {str(e)}",
                    "tool_calls": all_tool_calls,
                    "tool_results": all_tool_results,
                    "highlights": executor.highlights,
                    "svg_updates": executor.svg_updates,
                }

            if not response.candidates:
                logger.warning("Gemini returned no candidates")
                break

            candidate = response.candidates[0]
            parts = candidate.content.parts if candidate.content else []

            # Separate text and function calls
            text_parts = []
            function_calls = []

            for part in parts:
                if part.text:
                    text_parts.append(part.text)
                elif part.function_call:
                    function_calls.append(part.function_call)

            if text_parts:
                final_response += " ".join(text_parts)

            if not function_calls:
                # No function calls → done
                break

            # Add model's response to contents
            contents.append(candidate.content)

            # Execute each function call
            function_response_parts = []

            for fc in function_calls:
                tool_name = fc.name
                tool_input = dict(fc.args) if fc.args else {}

                logger.info(
                    f"Executing tool: {tool_name} with args: {json.dumps(tool_input, default=str)[:200]}")

                result = executor.execute(tool_name, tool_input)

                all_tool_calls.append({
                    "tool": tool_name,
                    "args": tool_input
                })
                all_tool_results.append({
                    "tool": tool_name,
                    "result": result
                })

                function_response_parts.append(
                    types.Part.from_function_response(
                        name=tool_name,
                        response=result
                    )
                )

            # Add function results as user message
            contents.append(types.Content(
                role="user",
                parts=function_response_parts
            ))

        return {
            "response": final_response.strip(),
            "tool_calls": all_tool_calls,
            "tool_results": all_tool_results,
            "highlights": executor.highlights,
            "svg_updates": executor.svg_updates,
        }

    async def chat_stream(
        self,
        message: str,
        layer_data: Dict[str, Any],
        conversation_history: List[Dict] = None
    ):
        """
        Stream agent responses with real-time tool calls and text.

        Yields SSE-formatted events:
        - {"type": "tool_call_start", "tool": "...", "tool_use_id": "..."}
        - {"type": "tool_call", "tool": "...", "args": {...}, "tool_use_id": "..."}
        - {"type": "tool_result", "tool": "...", "result": {...}}
        - {"type": "text", "content": "..."}
        - {"type": "highlight", ...}
        - {"type": "done", "highlights": [...], "svg_updates": [...]}
        """
        executor = ToolExecutor(layer_data)
        tool = get_gemini_tools()

        # Build contents list
        contents = []

        if conversation_history:
            for msg in conversation_history:
                role = "user" if msg.get("role") == "user" else "model"
                contents.append(types.Content(
                    role=role,
                    parts=[types.Part.from_text(text=msg.get("content", ""))]
                ))

        layer_summary = self._summarize_layers(layer_data)
        user_content = f"""Current design state:
{layer_summary}

User request: {message}"""

        contents.append(types.Content(
            role="user",
            parts=[types.Part.from_text(text=user_content)]
        ))

        config = types.GenerateContentConfig(
            tools=[tool],
            system_instruction=self.SYSTEM_PROMPT,
            temperature=0.7,
            max_output_tokens=4096,
        )

        max_iterations = 10

        for iteration in range(max_iterations):
            try:
                # Stream the response
                accumulated_text = ""
                function_calls = []  # list of (name, args) tuples
                fc_counter = 0

                for chunk in self.client.models.generate_content_stream(
                    model=self.MODEL_ID,
                    contents=contents,
                    config=config,
                ):
                    if not chunk.candidates:
                        continue
                    candidate = chunk.candidates[0]
                    if not candidate.content or not candidate.content.parts:
                        continue

                    for part in candidate.content.parts:
                        if part.text:
                            yield {
                                "type": "text",
                                "content": part.text
                            }
                            accumulated_text += part.text

                        elif part.function_call:
                            fc = part.function_call
                            fc_counter += 1
                            fc_id = f"fc-{iteration}-{fc_counter}"
                            fc_args = dict(fc.args) if fc.args else {}

                            function_calls.append((fc.name, fc_args))

                            # Emit tool call events matching frontend expectations
                            yield {
                                "type": "tool_call_start",
                                "tool": fc.name,
                                "tool_use_id": fc_id
                            }
                            yield {
                                "type": "tool_call",
                                "tool": fc.name,
                                "args": fc_args,
                                "tool_use_id": fc_id
                            }

                if not function_calls:
                    # No function calls → we're done
                    yield {
                        "type": "done",
                        "highlights": executor.highlights,
                        "svg_updates": executor.svg_updates
                    }
                    return

                # Build the model's response for conversation history
                model_parts = []
                if accumulated_text:
                    model_parts.append(
                        types.Part.from_text(text=accumulated_text))
                for fc_name, fc_args in function_calls:
                    model_parts.append(types.Part(
                        function_call=types.FunctionCall(
                            name=fc_name, args=fc_args)
                    ))

                contents.append(types.Content(
                    role="model", parts=model_parts))

                # Execute function calls and yield results
                function_response_parts = []

                for fc_name, fc_args in function_calls:
                    result = executor.execute(fc_name, fc_args)

                    yield {
                        "type": "tool_result",
                        "tool": fc_name,
                        "result": result
                    }

                    # Emit any new highlights from this tool execution
                    for highlight in executor.highlights:
                        yield {
                            "type": "highlight",
                            **highlight
                        }

                    function_response_parts.append(
                        types.Part.from_function_response(
                            name=fc_name,
                            response=result
                        )
                    )

                # Add function results to conversation
                contents.append(types.Content(
                    role="user",
                    parts=function_response_parts
                ))

            except Exception as e:
                logger.error(f"Gemini streaming error: {e}")
                yield {
                    "type": "error",
                    "message": str(e)
                }
                return

        # Max iterations reached
        yield {
            "type": "done",
            "highlights": executor.highlights,
            "svg_updates": executor.svg_updates
        }

    def _summarize_layers(self, layer_data: Dict) -> str:
        """Create a text summary of layers for the agent."""
        lines = []

        fab = layer_data.get("fabrication", {})
        if fab:
            material = fab.get("material", "unknown")
            thickness = fab.get("materialThickness", "?")
            scale = fab.get("scale", 1.0)
            lines.append(
                f"Material: {material} ({thickness}mm), Scale: {scale}x")

        layers = layer_data.get("layers", [])
        if not layers:
            lines.append("No layers in the design.")
            return "\n".join(lines)

        for layer in layers:
            layer_id = layer.get("id", "unknown")
            layer_name = layer.get("name", layer_id)
            segments = layer.get("segments", [])

            seg_info = []
            for s in segments:
                name = s.get("name", s.get("id", "?"))
                has_svg = "svg" if s.get("svg") else "no-svg"
                seg_info.append(f"{name}({has_svg})")

            lines.append(
                f"- {layer_name} (id: {layer_id}): {len(segments)} parts [{', '.join(seg_info)}]")

        return "\n".join(lines)


# =============================================================================
# Singleton
# =============================================================================

_agent: Optional[FabricationAgent] = None


def get_fabrication_agent() -> FabricationAgent:
    """Get or create the fabrication agent singleton."""
    global _agent
    if _agent is None:
        _agent = FabricationAgent()
    return _agent
