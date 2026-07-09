"""
Layer Pipeline Service

Provides user-confirmed layer-by-layer image segmentation for laser-cut art.

Workflow:
1. analyze_layers() - Returns layer JSON for user review
2. User modifies/confirms the layer assignments
3. process_confirmed_layers() - Processes confirmed layers (detect + SAM2 + inpaint)
"""

import asyncio
import json
import logging
import os
import re
import io
import uuid
from pathlib import Path
from typing import Dict, Any, List, Optional
from PIL import Image, ImageDraw, ImageFont

from google import genai
from google.genai import types

from .segmentation import get_segmentation_service
from .inpainting import get_inpainting_service
from .occlusion import get_occlusion_service
from prompts.prompts import HUMANIZE_ANALYSIS_PROMPT, REPAIR_SEGMENT_PROMPT
from utils.svg_converter import mask_to_svg
from config.models import VISION_PRIMARY, VISION_FALLBACK, TEXT_FAST, IMAGE_PRIMARY

logger = logging.getLogger(__name__)

# Output directory
OUTPUT_DIR = Path(__file__).parent.parent / "output"

LAYER_COLORS = [
    (255, 0, 0),    # Layer 1 - Red
    (0, 255, 0),    # Layer 2 - Green
    (0, 0, 255),    # Layer 3 - Blue
    (255, 255, 0),  # Layer 4 - Yellow
    (255, 0, 255),  # Layer 5 - Magenta
]


def sanitize_filename(name: str) -> str:
    """Convert element name to safe filename."""
    return re.sub(r'[^\w\-]', '_', name.lower().strip())


class LayerPipelineService:
    """Service for layer-by-layer segmentation with user confirmation flow."""

    def __init__(self):
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise ValueError("GEMINI_API_KEY environment variable not set")
        self.client = genai.Client(api_key=api_key)
        self.seg_service = get_segmentation_service()
        self.inpaint_service = get_inpainting_service()
        self.occlusion_service = get_occlusion_service()
        # In-memory storage for pending sessions (could be Redis in production)
        self._sessions: Dict[str, Dict[str, Any]] = {}
        # Progress tracking per session
        self._progress: Dict[str, Dict[str, Any]] = {}
        # Counter for unique element IDs
        self._element_counter = 0

    def _generate_with_fallback(self, contents, config):
        """Call vision model with automatic fallback on failure."""
        for model in [VISION_PRIMARY, VISION_FALLBACK]:
            try:
                response = self.client.models.generate_content(
                    model=model, contents=contents, config=config
                )
                logger.info(f"Vision call successful with {model}")
                return response
            except Exception as e:
                if model == VISION_PRIMARY:
                    logger.warning(f"{model} failed: {e}, trying fallback {VISION_FALLBACK}...")
                else:
                    raise

    def get_progress(self, session_id: str) -> Dict[str, Any]:
        """Get current progress for a session."""
        if session_id not in self._progress:
            return {"status": "unknown", "progress": 0, "message": "Session not found"}
        return self._progress[session_id]

    def _update_progress(self, session_id: str, progress: int, message: str, status: str = "processing"):
        """Update progress for a session."""
        self._progress[session_id] = {
            "status": status,
            "progress": progress,
            "message": message
        }

    def _generate_element_id(self, name: str) -> str:
        """Generate a unique element ID."""
        self._element_counter += 1
        safe_name = sanitize_filename(name)[:20]
        return f"elem_{safe_name}_{self._element_counter:03d}"

    def _renumber_layers(self, layers_info: Dict[str, Any]) -> Dict[str, Any]:
        """Renumber layers sequentially (1, 2, 3, ...) regardless of original numbers."""
        layers = layers_info.get("layers", [])
        if not layers:
            return layers_info

        # Sort by original layer number to preserve order
        layers.sort(key=lambda l: l.get("layer", 0))

        # Renumber sequentially starting from 1
        for i, layer in enumerate(layers, start=1):
            layer["layer"] = i

        layers_info["layers"] = layers
        return layers_info

    def _add_element_ids(self, layers_info: Dict[str, Any]) -> Dict[str, Any]:
        """Add unique IDs to elements if they don't have them."""
        for layer in layers_info.get("layers", []):
            for elem in layer.get("elements", []):
                if "id" not in elem:
                    elem["id"] = self._generate_element_id(elem.get("name", "unknown"))
        return layers_info

    def _get_layer_element_ids(self, layers_info: Dict[str, Any]) -> Dict[int, set]:
        """Get element IDs (or names as fallback) per layer."""
        result = {}
        for layer in layers_info.get("layers", []):
            layer_num = layer.get("layer", 0)
            elem_ids = set()
            for elem in layer.get("elements", []):
                elem_ids.add(elem.get("id") or elem.get("name", "unknown"))
            result[layer_num] = elem_ids
        return result

    def _find_changed_layers(
        self,
        old_layers: Dict[str, Any],
        new_layers: Dict[str, Any]
    ) -> set:
        """Find which layers have changed (elements added/removed/moved)."""
        old_mapping = self._get_layer_element_ids(old_layers)
        new_mapping = self._get_layer_element_ids(new_layers)

        changed = set()

        # Check all layer numbers from both old and new
        all_layers = set(old_mapping.keys()) | set(new_mapping.keys())

        for layer_num in all_layers:
            old_elems = old_mapping.get(layer_num, set())
            new_elems = new_mapping.get(layer_num, set())

            if old_elems != new_elems:
                changed.add(layer_num)

        return changed

    async def update_humanized_incremental(
        self,
        old_layers: Dict[str, Any],
        new_layers: Dict[str, Any],
        old_humanized: Dict[str, Any],
        modification_request: str
    ) -> Dict[str, Any]:
        """
        Incrementally update humanized descriptions - only regenerate changed layers.

        Args:
            old_layers: Previous layers_info
            new_layers: Modified layers_info
            old_humanized: Previous humanized descriptions
            modification_request: What the user asked to change

        Returns:
            Updated humanized with unchanged layers preserved
        """
        changed_layers = self._find_changed_layers(old_layers, new_layers)
        logger.info(f"Changed layers: {changed_layers}")

        # Build humanized result, preserving unchanged
        old_humanized_map = {}
        for h in old_humanized.get("layers", []):
            old_humanized_map[h.get("layer")] = h

        result_layers = []

        for layer in new_layers.get("layers", []):
            layer_num = layer.get("layer", 0)

            if layer_num not in changed_layers and layer_num in old_humanized_map:
                # Layer unchanged - preserve existing description
                result_layers.append(old_humanized_map[layer_num])
                logger.info(f"Layer {layer_num}: preserved existing description")
            else:
                # Layer changed - regenerate description for just this layer
                new_desc = await self._humanize_single_layer(layer, modification_request)
                result_layers.append(new_desc)
                logger.info(f"Layer {layer_num}: regenerated description")

        return {"layers": result_layers}

    async def _humanize_single_layer(
        self,
        layer: Dict[str, Any],
        context: str = ""
    ) -> Dict[str, Any]:
        """Humanize a single layer's description."""
        layer_num = layer.get("layer", 0)
        elements = layer.get("elements", [])
        element_names = [e.get("name", "unknown") for e in elements]

        # Simple rule-based humanization (no API call needed)
        description = self._humanize_element_names(element_names)

        # Determine layer name based on position
        if layer_num == 1:
            name = "Front layer"
        elif layer_num == 2:
            name = "Mid-ground layer"
        else:
            name = f"Layer {layer_num}"

        return {
            "layer": layer_num,
            "name": name,
            "description": description
        }

    def _humanize_element_names(self, names: List[str]) -> str:
        """Convert technical element names to human-readable description."""
        if not names:
            return "empty layer"

        # Group similar elements
        groups = {}
        for name in names:
            # Extract base type: "bottom-left-lily-pad" -> "lily-pad"
            parts = name.replace("_", "-").split("-")
            # Remove position words
            position_words = {"left", "right", "center", "top", "bottom", "front", "back", "mid", "inner", "outer"}
            base_parts = [p for p in parts if p.lower() not in position_words]
            base_type = "-".join(base_parts) if base_parts else name

            if base_type not in groups:
                groups[base_type] = []
            groups[base_type].append(name)

        # Convert to natural language
        descriptions = []
        for base_type, items in groups.items():
            # Convert base type to readable
            readable = base_type.replace("-", " ").replace("_", " ")

            if len(items) > 1:
                # Pluralize if multiple
                if readable.endswith("y"):
                    readable = readable[:-1] + "ies"
                elif not readable.endswith("s"):
                    readable = readable + "s"
                descriptions.append(readable)
            else:
                # Single item - add article
                if readable[0].lower() in "aeiou":
                    descriptions.append(f"the {readable}")
                else:
                    descriptions.append(f"the {readable}")

        # Join descriptions
        if len(descriptions) == 1:
            return descriptions[0]
        elif len(descriptions) == 2:
            return f"{descriptions[0]} and {descriptions[1]}"
        else:
            return ", ".join(descriptions[:-1]) + f", and {descriptions[-1]}"

    async def analyze_layers(self, image_data: bytes) -> Dict[str, Any]:
        """
        Stage 1: Analyze image and return layer JSON for user review.

        Returns:
            {
                "session_id": str,  # Use this for subsequent calls
                "layers": [
                    {
                        "layer": 1,
                        "description": "frontmost elements",
                        "elements": [
                            {"name": "unique-name-with-location", "description": "..."}
                        ]
                    }
                ]
            }
        """
        logger.info("Analyzing image for layer decomposition")

        # Use centralized prompt from prompts.py
        from prompts.prompts import LAYER_ANALYSIS_PROMPT
        prompt = LAYER_ANALYSIS_PROMPT

        mime_type = "image/png" if image_data[:3] != b'\xff\xd8\xff' else "image/jpeg"

        try:
            response = self._generate_with_fallback(
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_text(text=prompt),
                            types.Part.from_bytes(data=image_data, mime_type=mime_type)
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    temperature=0,
                    max_output_tokens=16384,
                    media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
                )
            )

            # Debug: log response structure
            logger.info(f"Response candidates count: {len(response.candidates) if response.candidates else 0}")

            text = None
            if response.candidates and len(response.candidates) > 0:
                candidate = response.candidates[0]
                if candidate.content and candidate.content.parts:
                    for part in candidate.content.parts:
                        if hasattr(part, 'text') and part.text:
                            text = part.text
                            break

            # Fallback to response.text
            if text is None:
                text = response.text

            if text is None:
                logger.error(f"Gemini returned None for layer analysis. Response: {response}")
                return {"error": "AI returned empty response"}

            # Parse JSON
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]

            try:
                layers_info = json.loads(text.strip())
            except json.JSONDecodeError as e:
                logger.error(f"JSON parse error: {e}")
                logger.error(f"Raw text (first 2000 chars): {text[:2000]}")
                logger.error(f"Raw text (last 500 chars): {text[-500:]}")
                return {"error": f"Failed to parse layer analysis JSON: {e}"}

            # Renumber layers sequentially (Gemini might skip numbers like 1,3,5 -> 1,2,3)
            layers_info = self._renumber_layers(layers_info)

            # Add unique element IDs for tracking
            layers_info = self._add_element_ids(layers_info)

            # Analyze image structure for smart inpainting (runs in parallel conceptually)
            image_structure = await self._analyze_image_structure(image_data)

            # Create session
            session_id = str(uuid.uuid4())
            self._sessions[session_id] = {
                "image_data": image_data,
                "layers_info": layers_info,
                "image_structure": image_structure,
                "humanized": None,  # Will be populated after humanization
                "status": "pending_confirmation"
            }

            # Create output directory
            session_dir = OUTPUT_DIR / session_id
            session_dir.mkdir(parents=True, exist_ok=True)

            # Save original image
            (session_dir / "00_original.png").write_bytes(image_data)

            # Save layers info
            with open(session_dir / "layers_info.json", "w") as f:
                json.dump(layers_info, f, indent=2)

            logger.info(f"Created session {session_id} with {len(layers_info.get('layers', []))} layers")

            # Humanize the analysis for display
            humanized = await self.humanize_analysis(layers_info)

            # Store humanized in session for incremental updates
            self._sessions[session_id]["humanized"] = humanized

            # Save humanized info
            with open(session_dir / "layers_humanized.json", "w") as f:
                json.dump(humanized, f, indent=2)

            return {
                "session_id": session_id,
                "humanized": humanized.get("layers", []),  # Human-readable descriptions
                **layers_info  # Original technical data
            }

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse layer analysis JSON: {e}")
            return {"error": f"Failed to parse AI response: {str(e)}"}
        except Exception as e:
            logger.exception(f"Layer analysis failed: {e}")
            return {"error": str(e)}

    async def humanize_analysis(self, layers_info: Dict[str, Any]) -> Dict[str, Any]:
        """
        Use Gemini to convert technical layer names into human-readable descriptions.

        Args:
            layers_info: Raw layer analysis with technical element names

        Returns:
            Humanized layer descriptions
        """
        try:
            prompt = HUMANIZE_ANALYSIS_PROMPT.format(
                analysis_json=json.dumps(layers_info, indent=2)
            )

            response = self.client.models.generate_content(
                model=TEXT_FAST,  # Fast model for simple task
                contents=[prompt],
                config=types.GenerateContentConfig(
                    temperature=0.3,  # Slight creativity for natural language
                    max_output_tokens=2048,
                )
            )

            text = response.text
            if text is None:
                logger.warning("Humanization returned None, using original")
                return layers_info

            # Parse JSON
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]

            humanized = json.loads(text.strip())
            logger.info("Successfully humanized layer analysis")
            return humanized

        except Exception as e:
            logger.warning(f"Humanization failed, using original: {e}")
            return layers_info

    async def modify_layers_with_ai(
        self,
        session_id: str,
        modification_request: str,
        current_layers: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Use AI to interpret a natural language modification request and update layers.
        Sends the original image so AI can discover new elements the user asks about.

        Args:
            session_id: Session ID
            modification_request: Natural language request like "move duck to back layer"
            current_layers: Current layer structure

        Returns:
            Updated layers_info with session_id
        """
        if session_id not in self._sessions:
            return {"error": f"Session {session_id} not found"}

        session = self._sessions[session_id]
        existing_humanized = session.get("humanized", {})

        logger.info(f"Modifying layers with AI: {modification_request}")

        # STEP 1: Modify the layers_info structure (with image context)
        modify_prompt = f"""You are modifying a layer structure for laser-cut art based on the user's request.
Look at the attached image carefully — the user may ask you to add elements that were missed in the original analysis.

CURRENT LAYER STRUCTURE:
{json.dumps(current_layers, indent=2)}

USER'S REQUEST: "{modification_request}"

SUPPORTED OPERATIONS:
1. REMOVE - Delete a layer or element (e.g., "remove the duck", "delete layer 2")
2. MOVE - Move element to different layer (e.g., "move frog to layer 1")
3. MERGE - Combine layers into one (e.g., "merge layers 2 and 3")
4. SPLIT - Separate element into new layer (e.g., "put duck in its own layer")
5. RENAME - Change names (e.g., "rename flower to lotus")
6. REORDER - Change layer depth (e.g., "move background to back")
7. ADD - Add NEW elements visible in the image that were missed (e.g., "also include the left river bank")

CRITICAL RULES:
1. Each element has a unique "id" field - use this to identify elements precisely
2. PRESERVE all "id" fields exactly - never change or regenerate IDs
3. PRESERVE "name" and "description" fields unless user explicitly asks to change them
4. When removing a layer, delete it entirely from the array
5. When moving elements, copy the entire element object (with id) to the new layer
6. Layer numbers will be auto-renumbered after your changes, so focus on the structure
7. For NEW elements (not in current structure), generate a new id like "elem_" + a random 8-char hex string
8. New element descriptions MUST use ABSOLUTE POSITIONING only (e.g., "golden strip in the lower-left of the image") — NEVER reference other elements

LAYER DEPTH:
- Layer 1 = front (closest to viewer, cut first)
- Higher layer numbers = further back (cut later)

OUTPUT FORMAT - Return ONLY valid JSON:
{{
  "layers": [
    {{
      "layer": 1,
      "elements": [
        {{"id": "elem_xxx", "name": "...", "description": "..."}}
      ]
    }}
  ]
}}"""

        try:
            # Send image so AI can discover new elements the user asks about
            image_data = session.get("image_data")
            if image_data:
                mime_type = "image/png" if image_data[:3] != b'\xff\xd8\xff' else "image/jpeg"
                contents = [
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_text(text=modify_prompt),
                            types.Part.from_bytes(data=image_data, mime_type=mime_type)
                        ]
                    )
                ]
            else:
                # Fallback: text-only if image not available
                logger.warning("[modify] No image_data in session, falling back to text-only")
                contents = [modify_prompt]

            response = self._generate_with_fallback(
                contents=contents,
                config=types.GenerateContentConfig(
                    temperature=0,
                    max_output_tokens=16384,
                    media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
                )
            )

            # Extract text from response (vision models may have thinking parts)
            text = None
            if response.candidates and len(response.candidates) > 0:
                candidate = response.candidates[0]
                if candidate.content and candidate.content.parts:
                    for part in candidate.content.parts:
                        if hasattr(part, 'text') and part.text:
                            text = part.text
                            break
            if text is None:
                text = response.text
            if text is None:
                return {"error": "AI returned empty response"}

            # Parse JSON
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]

            parsed = json.loads(text.strip())

            # Handle both formats: {"layers": [...]} or just [...]
            if isinstance(parsed, list):
                modified_layers = {"layers": parsed}
            elif isinstance(parsed, dict) and "layers" in parsed:
                modified_layers = parsed
            else:
                modified_layers = {"layers": parsed}

            # STEP 1.5: Renumber layers sequentially (1, 2, 3...) after any modifications
            # This ensures layers are contiguous after deletions (e.g., if layer 2 was removed,
            # layers [1, 3] become [1, 2])
            layers_list = modified_layers.get("layers", [])
            # Sort by current layer number to preserve order
            layers_list.sort(key=lambda l: l.get("layer", 0))
            # Renumber sequentially
            for idx, layer in enumerate(layers_list, start=1):
                old_num = layer.get("layer")
                if old_num != idx:
                    logger.info(f"Renumbering layer {old_num} -> {idx}")
                    layer["layer"] = idx
            modified_layers["layers"] = layers_list

            # STEP 2: Incremental humanization - preserve unchanged descriptions
            humanized = await self.update_humanized_incremental(
                old_layers={"layers": current_layers},
                new_layers=modified_layers,
                old_humanized=existing_humanized,
                modification_request=modification_request
            )

            # Update session
            session["layers_info"] = modified_layers
            session["humanized"] = humanized
            session["status"] = "confirmed"

            # Save updated files
            session_dir = OUTPUT_DIR / session_id
            with open(session_dir / "layers_info.json", "w") as f:
                json.dump(modified_layers, f, indent=2)
            with open(session_dir / "layers_humanized.json", "w") as f:
                json.dump(humanized, f, indent=2)

            logger.info(f"Modified layers for session {session_id}")

            return {
                "session_id": session_id,
                "status": "confirmed",
                "humanized": humanized.get("layers", []),
                **modified_layers
            }

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse modified layers JSON: {e}")
            return {"error": f"Failed to parse AI response: {str(e)}"}
        except Exception as e:
            logger.exception(f"Layer modification failed: {e}")
            return {"error": str(e)}

    async def update_layers(
        self,
        session_id: str,
        updated_layers: List[Dict[str, Any]],
        reanalyze: bool = False
    ) -> Dict[str, Any]:
        """
        Stage 2: User modifies or confirms layer assignments.

        Args:
            session_id: Session ID from analyze_layers
            updated_layers: Modified layer structure from user
            reanalyze: If True, re-run AI analysis with user feedback

        Returns:
            Updated layers_info with session_id
        """
        if session_id not in self._sessions:
            return {"error": f"Session {session_id} not found"}

        session = self._sessions[session_id]

        if reanalyze:
            # User wants to re-analyze with their feedback
            # TODO: Could add user feedback to prompt for better results
            logger.info(f"Re-analyzing session {session_id}")
            image_data = session["image_data"]
            result = await self.analyze_layers(image_data)
            # Keep same session_id
            if "error" not in result:
                session["layers_info"] = {k: v for k, v in result.items() if k != "session_id"}
                session["status"] = "pending_confirmation"
            return {"session_id": session_id, **session["layers_info"]}
        else:
            # User directly modified the JSON
            session["layers_info"] = {"layers": updated_layers}
            session["status"] = "confirmed"

            # Save updated layers info
            session_dir = OUTPUT_DIR / session_id
            with open(session_dir / "layers_info.json", "w") as f:
                json.dump(session["layers_info"], f, indent=2)

            logger.info(f"Updated session {session_id} with user modifications")

            return {
                "session_id": session_id,
                "status": "confirmed",
                **session["layers_info"]
            }

    async def _analyze_image_structure(self, image_data: bytes) -> str:
        """One-time analysis of image's visual structure for inpainting guidance."""
        from prompts.prompts import IMAGE_STRUCTURE_ANALYSIS_PROMPT

        mime_type = "image/png" if image_data[:3] != b'\xff\xd8\xff' else "image/jpeg"

        try:
            response = self._generate_with_fallback(
                contents=[types.Content(role="user", parts=[
                    types.Part.from_text(text=IMAGE_STRUCTURE_ANALYSIS_PROMPT),
                    types.Part.from_bytes(data=image_data, mime_type=mime_type),
                ])],
                config=types.GenerateContentConfig(
                    temperature=0.2,
                    max_output_tokens=1024,
                )
            )
            result = response.text.strip()
            logger.info(f"Image structure analysis: {result}")
            return result
        except Exception as e:
            logger.warning(f"Image structure analysis failed: {e}")
            return "Unable to determine image structure. Extend surrounding textures inward."

    async def _analyze_inpaint_region(self, current_image: bytes, combined_mask: bytes,
                                       removed_names: str, behind_names: str,
                                       image_structure: str, previously_removed: list = None) -> str:
        """Vision model generates specific inpainting instructions for this layer."""
        from prompts.prompts import INPAINT_ANALYSIS_PROMPT

        prev_note = ""
        if previously_removed:
            prev_names = ", ".join(previously_removed)
            prev_note = f"\n⚠️ Already removed (NOT in image): {prev_names}. Ignore them."

        prompt = INPAINT_ANALYSIS_PROMPT.format(
            image_structure=image_structure,
            removed_elements=removed_names,
            behind_elements=behind_names if behind_names else "unknown background",
            previously_removed_note=prev_note,
        )

        contents = [types.Content(role="user", parts=[
            types.Part.from_text(text=prompt),
            types.Part.from_text(text="Current image:"),
            types.Part.from_bytes(data=current_image, mime_type="image/png"),
            types.Part.from_text(text="Mask (white = area to fill):"),
            types.Part.from_bytes(data=combined_mask, mime_type="image/png"),
        ])]

        config = types.GenerateContentConfig(temperature=0.3, max_output_tokens=1024)

        try:
            response = self._generate_with_fallback(contents, config)
            analysis = response.text.strip()
            logger.info(f"Layer inpaint analysis: {analysis}")
            return analysis
        except Exception as e:
            logger.warning(f"Inpaint analysis failed: {e}, using generic fallback")
            return f"Extend surrounding textures and patterns inward to seamlessly fill the area where {removed_names} was removed."

    def _get_inpaint_context(self, current_layer, all_layers):
        """Extract element context for inpainting (removed, behind, previously removed).

        Returns:
            Tuple of (removed_names, behind_names, previously_removed, previously_removed_warning)
        """
        current_layer_num = current_layer.get("layer", 1)
        current_elements = current_layer.get("elements", [])

        # Collect elements from all layers behind this one (higher layer numbers = further back)
        behind_elements = []
        for layer in all_layers:
            if layer.get("layer", 0) > current_layer_num:
                for elem in layer.get("elements", []):
                    name = elem.get("name", "unknown")
                    desc = elem.get("description", "")
                    if desc:
                        behind_elements.append(f"{name} ({desc})")
                    else:
                        behind_elements.append(name)

        # Collect elements from all layers IN FRONT of this one (already removed)
        previously_removed = []
        for layer in all_layers:
            if layer.get("layer", 0) < current_layer_num:
                for elem in layer.get("elements", []):
                    previously_removed.append(elem.get("name", "unknown"))

        removed_names = ", ".join(e.get("name", "unknown") for e in current_elements)
        behind_names = ", ".join(behind_elements)

        # Build previously-removed warning
        if previously_removed:
            prev_names = ", ".join(previously_removed)
            previously_removed_warning = (
                f"\n⚠️ CRITICAL: These elements were ALREADY REMOVED and DO NOT EXIST "
                f"in the current image: {prev_names}. "
                f"DO NOT recreate them."
            )
        else:
            previously_removed_warning = ""

        return removed_names, behind_names, previously_removed, previously_removed_warning

    def _build_inpaint_prompt(self, current_layer, all_layers, scene_analysis=""):
        """Build a context-aware inpainting prompt.

        Args:
            current_layer: The layer being removed (dict with 'layer' and 'elements')
            all_layers: All layers in the session (list of dicts)
            scene_analysis: Vision-generated inpainting instructions (from _analyze_inpaint_region)

        Returns:
            Context-aware prompt string, or None to use default prompt
        """
        from prompts.prompts import CONTEXT_INPAINTING_PROMPT

        removed_names, behind_names, previously_removed, previously_removed_warning = \
            self._get_inpaint_context(current_layer, all_layers)

        if not behind_names and not scene_analysis:
            # Last layer or no info — use default prompt
            return None

        # If no scene_analysis provided, use a generic fallback
        if not scene_analysis:
            scene_analysis = f"Extend the surrounding background inward. Behind the hole: {behind_names}."

        return CONTEXT_INPAINTING_PROMPT.format(
            removed_elements=removed_names,
            scene_analysis=scene_analysis,
            previously_removed_warning=previously_removed_warning,
        )

    async def process_confirmed_layers(
        self,
        session_id: str,
        progress_callback: Optional[callable] = None,
        is_redo: bool = False
    ) -> Dict[str, Any]:
        """
        Stage 3: Process confirmed layers (batch detect + SAM2 + inpaint).

        Args:
            session_id: Session ID from analyze_layers
            progress_callback: Optional callback for progress updates
            is_redo: If True, use REDO prompts for more careful processing

        Returns:
            {
                "session_id": str,
                "layers": [
                    {
                        "layer": int,
                        "elements": [
                            {
                                "name": str,
                                "mask": str (base64),
                                "extracted": str (base64),
                                "box_2d": [y_min, x_min, y_max, x_max]
                            }
                        ]
                    }
                ],
                "rest_image": str (base64)
            }
        """
        if session_id not in self._sessions:
            return {"error": f"Session {session_id} not found"}

        session = self._sessions[session_id]
        layers_info = session["layers_info"]
        current_image = session["image_data"]
        original_image = session["image_data"]  # Untouched original for inpainting reference

        session_dir = OUTPUT_DIR / session_id
        results = {"session_id": session_id, "layers": [], "rest_image": None}

        layers = layers_info.get("layers", [])
        if not layers:
            return {"error": "No layers to process"}

        # Calculate total work for progress tracking
        # Each layer: 1 detection + N masks + 1 inpaint = N+2 steps
        total_elements = sum(len(l.get("elements", [])) for l in layers)
        total_steps = len(layers) * 2 + total_elements  # detection + inpaint per layer + 1 mask per element
        current_step = 0

        self._update_progress(session_id, 0, "Starting processing...")

        for layer_idx, layer in enumerate(layers):
            layer_num = layer.get("layer", 1)
            elements = layer.get("elements", [])

            if not elements:
                logger.info(f"Layer {layer_num} has no elements, skipping")
                continue

            layer_dir = session_dir / f"layer_{layer_num}"
            layer_dir.mkdir(exist_ok=True)

            logger.info(f"Processing layer {layer_num} with {len(elements)} elements")

            # Progress: Detecting elements
            current_step += 1
            progress_pct = int((current_step / total_steps) * 100)
            self._update_progress(session_id, progress_pct, f"Layer {layer_num}: Detecting elements...")

            if progress_callback:
                progress_callback(f"Processing layer {layer_num}...")

            # Save input image for this layer
            (layer_dir / "00_input.png").write_bytes(current_image)

            # BATCH DETECTION: Detect all elements in a single call
            redo_label = " (REDO)" if is_redo else ""
            detection_results = await self._detect_layer_elements(current_image, elements, is_redo=is_redo)

            # Filter successful detections
            detections = [r for r in detection_results if r.get("found", False)]

            if not detections:
                logger.warning(f"No elements detected in layer {layer_num}")
                continue

            # Draw boxes visualization
            boxed_image = self._draw_boxes_on_image(current_image, detections, layer_num)
            (layer_dir / "01_boxes.png").write_bytes(boxed_image)

            # Save detection results for potential re-segment later
            with open(layer_dir / "detections.json", "w") as f:
                json.dump(detections, f, indent=2)

            # Generate SAM2 masks and extract elements
            layer_results = {"layer": layer_num, "elements": []}
            masks = []

            for det_idx, det in enumerate(detections):
                name = det.get("label", "unknown")
                box = det.get("box_2d", [])
                has_internal_gaps = det.get("has_internal_gaps", False)
                positive_points = det.get("positive_points", [])
                negative_points = det.get("negative_points", [])
                if len(box) != 4:
                    continue

                safe_name = sanitize_filename(name)

                # Progress: Generating mask for this element
                current_step += 1
                progress_pct = int((current_step / total_steps) * 100)
                self._update_progress(session_id, progress_pct, f"Layer {layer_num}: Masking {name}...{redo_label}")

                # Generate SAM2 mask (or diff-mask for objects with internal gaps)
                mask_data = await self.seg_service.generate_mask(
                    image_data=current_image,
                    element_name=name,
                    bounding_box=box,
                    has_internal_gaps=has_internal_gaps,
                    positive_points=positive_points,
                    negative_points=negative_points,
                    is_redo=is_redo
                )

                if not mask_data:
                    logger.warning(f"Failed to generate mask for {name}")
                    continue

                masks.append(mask_data)

                # Save mask
                (layer_dir / f"mask_{safe_name}.png").write_bytes(mask_data)

                # Extract element with transparent background
                extracted = self._extract_element_with_mask(current_image, mask_data)
                (layer_dir / f"extracted_{safe_name}.png").write_bytes(extracted)

                # Compute actual bounding box from mask (more accurate than Gemini's box)
                actual_box = self._get_mask_bounding_box(mask_data)
                logger.info(f"  Gemini box: {box} -> Mask box: {actual_box}")

                # Convert mask to SVG for 3D geometry (cut outline)
                try:
                    svg_string = mask_to_svg(mask_data)
                except Exception as e:
                    logger.warning(f"  Failed to generate SVG for {name}: {e}")
                    svg_string = ""

                # Add to results
                import base64
                layer_results["elements"].append({
                    "name": name,
                    "mask": base64.b64encode(mask_data).decode("utf-8"),
                    "extracted": base64.b64encode(extracted).decode("utf-8"),
                    "svg": svg_string,
                    "box_2d": actual_box  # Use mask-based box for accurate positioning
                })

            results["layers"].append(layer_results)

            # Save visualization of what was masked/removed
            if masks:
                removed_vis = self._create_removed_visualization(current_image, masks)
                (layer_dir / "02_masked_areas.png").write_bytes(removed_vis)

            # Inpaint to remove this layer's elements (for next layer)
            # Skip inpainting for the last layer - nothing comes after it
            is_last_layer = (layer_num >= max(l.get("layer", 0) for l in layers))
            if masks and not is_last_layer:
                # Progress: Inpainting
                current_step += 1
                progress_pct = int((current_step / total_steps) * 100)
                self._update_progress(session_id, progress_pct, f"Layer {layer_num}: Analyzing + Inpainting...")

                logger.info(f"Inpainting layer {layer_num} elements{redo_label}")

                # Smart inpainting: vision analyzes the region first
                combined_mask = self.inpaint_service._combine_masks(masks) if len(masks) > 1 else masks[0]
                removed_names, behind_names, previously_removed, _ = \
                    self._get_inpaint_context(layer, layers)
                image_structure = session.get("image_structure", "")
                scene_analysis = await self._analyze_inpaint_region(
                    current_image, combined_mask, removed_names,
                    behind_names, image_structure, previously_removed
                )
                inpaint_prompt = self._build_inpaint_prompt(layer, layers, scene_analysis=scene_analysis)
                # Only send original image as reference for layers 1-2.
                # For layer 3+, the original contains too many removed elements
                # that the model may hallucinate back into the hole.
                ref_image = original_image
                current_image = await self.inpaint_service.remove_objects_combined(
                    current_image, masks, is_redo=is_redo, prompt=inpaint_prompt,
                    original_image=ref_image
                )
                (layer_dir / "inpainted.png").write_bytes(current_image)
            elif is_last_layer:
                logger.info(f"Layer {layer_num} is last layer, skipping inpainting")
                current_step += 1  # Still count the step

        # Final rest image
        import base64
        results["rest_image"] = base64.b64encode(current_image).decode("utf-8")
        (session_dir / "rest_image.png").write_bytes(current_image)

        # Update session status
        session["status"] = "completed"

        # Progress: Complete
        self._update_progress(session_id, 100, "Complete!", status="completed")

        logger.info(f"Session {session_id} completed: {len(results['layers'])} layers processed")

        return results

    async def process_confirmed_layers_stream(
        self,
        session_id: str,
        is_redo: bool = False
    ):
        """
        Stage 3 (Streaming): Process layers and yield elements as they're extracted.

        This is an async generator that yields SSE events:
        - type: "start" - Processing started, includes layer info
        - type: "detecting" - Detecting elements in a layer
        - type: "element" - An element was extracted (includes extracted image)
        - type: "inpainting" - Inpainting a layer
        - type: "complete" - All done, includes rest_image

        Args:
            is_redo: If True, use REDO prompts for more careful processing

        Yields:
            Dict with event type and data
        """
        redo_label = " (REDO)" if is_redo else ""
        if is_redo:
            logger.info(f"Processing session {session_id} with REDO prompts")
        if session_id not in self._sessions:
            yield {"type": "error", "message": f"Session {session_id} not found"}
            return

        session = self._sessions[session_id]
        layers_info = session["layers_info"]
        current_image = session["image_data"]
        original_image = session["image_data"]  # Untouched original for inpainting reference

        session_dir = OUTPUT_DIR / session_id

        layers = layers_info.get("layers", [])
        if not layers:
            yield {"type": "error", "message": "No layers to process"}
            return

        # Calculate totals
        total_elements = sum(len(l.get("elements", [])) for l in layers)
        total_layers = len(layers)

        # Start event
        yield {
            "type": "start",
            "session_id": session_id,
            "total_layers": total_layers,
            "total_elements": total_elements
        }

        all_layers_results = []

        for layer_idx, layer in enumerate(layers):
            layer_num = layer.get("layer", 1)
            elements = layer.get("elements", [])

            if not elements:
                continue

            layer_dir = session_dir / f"layer_{layer_num}"
            layer_dir.mkdir(exist_ok=True)

            # Detecting event
            yield {
                "type": "detecting",
                "layer": layer_num,
                "element_count": len(elements)
            }

            # Save input image for this layer
            (layer_dir / "00_input.png").write_bytes(current_image)

            # BATCH DETECTION
            logger.info(f"[Stream L{layer_num}] Detecting {len(elements)} elements...{redo_label}")
            detection_results = await self._detect_layer_elements(current_image, elements, is_redo=is_redo)
            detections = [r for r in detection_results if r.get("found", False)]
            logger.info(f"[Stream L{layer_num}] Found {len(detections)} detections out of {len(elements)} elements")

            if not detections:
                logger.warning(f"[Stream L{layer_num}] No elements detected, skipping layer")
                continue

            # Draw boxes visualization
            boxed_image = self._draw_boxes_on_image(current_image, detections, layer_num)
            (layer_dir / "01_boxes.png").write_bytes(boxed_image)

            # Save detection results for potential re-segment later
            with open(layer_dir / "detections.json", "w") as f:
                json.dump(detections, f, indent=2)

            # Process each element and yield as it's extracted
            layer_results = {"layer": layer_num, "elements": []}
            masks = []

            for det_idx, det in enumerate(detections):
                name = det.get("label", "unknown")
                box = det.get("box_2d", [])
                has_internal_gaps = det.get("has_internal_gaps", False)
                positive_points = det.get("positive_points", [])
                negative_points = det.get("negative_points", [])
                if len(box) != 4:
                    continue

                safe_name = sanitize_filename(name)

                # Generate SAM2 mask (or diff-mask for objects with internal gaps)
                mask_data = await self.seg_service.generate_mask(
                    image_data=current_image,
                    element_name=name,
                    bounding_box=box,
                    has_internal_gaps=has_internal_gaps,
                    positive_points=positive_points,
                    negative_points=negative_points,
                    is_redo=is_redo
                )

                if not mask_data:
                    logger.warning(f"Failed to generate mask for {name}")
                    continue

                masks.append(mask_data)

                # Save mask
                (layer_dir / f"mask_{safe_name}.png").write_bytes(mask_data)

                # Extract element with transparent background
                extracted = self._extract_element_with_mask(current_image, mask_data)
                (layer_dir / f"extracted_{safe_name}.png").write_bytes(extracted)

                # Compute actual bounding box from mask
                actual_box = self._get_mask_bounding_box(mask_data)

                # Convert mask to SVG for 3D geometry (cut outline)
                try:
                    svg_string = mask_to_svg(mask_data)
                    logger.info(f"  Generated SVG for {name} ({len(svg_string)} chars)")
                except Exception as e:
                    logger.warning(f"  Failed to generate SVG for {name}: {e}")
                    svg_string = ""

                # Add to layer results
                import base64
                element_data = {
                    "name": name,
                    "mask": base64.b64encode(mask_data).decode("utf-8"),
                    "extracted": base64.b64encode(extracted).decode("utf-8"),
                    "svg": svg_string,
                    "box_2d": actual_box
                }
                layer_results["elements"].append(element_data)

                # Yield element event immediately
                yield {
                    "type": "element",
                    "layer": layer_num,
                    "name": name,
                    "extracted": element_data["extracted"],
                    "mask": element_data["mask"],
                    "svg": svg_string,
                    "box_2d": actual_box,
                    "element_index": det_idx,
                    "total_in_layer": len(detections)
                }

            all_layers_results.append(layer_results)

            # Visualization
            if masks:
                removed_vis = self._create_removed_visualization(current_image, masks)
                (layer_dir / "02_masked_areas.png").write_bytes(removed_vis)

            # Inpaint for next layer
            is_last_layer = (layer_num >= max(l.get("layer", 0) for l in layers))
            if masks and not is_last_layer:
                yield {
                    "type": "inpainting",
                    "layer": layer_num
                }

                # Smart inpainting: vision analyzes the region first
                combined_mask = self.inpaint_service._combine_masks(masks) if len(masks) > 1 else masks[0]
                removed_names, behind_names, previously_removed, _ = \
                    self._get_inpaint_context(layer, layers)
                image_structure = session.get("image_structure", "")
                scene_analysis = await self._analyze_inpaint_region(
                    current_image, combined_mask, removed_names,
                    behind_names, image_structure, previously_removed
                )
                inpaint_prompt = self._build_inpaint_prompt(layer, layers, scene_analysis=scene_analysis)
                ref_image = original_image
                current_image = await self.inpaint_service.remove_objects_combined(
                    current_image, masks, is_redo=is_redo, prompt=inpaint_prompt,
                    original_image=ref_image
                )
                (layer_dir / "inpainted.png").write_bytes(current_image)

        # Final rest image
        import base64
        rest_image_b64 = base64.b64encode(current_image).decode("utf-8")
        (session_dir / "rest_image.png").write_bytes(current_image)

        # Update session status
        session["status"] = "completed"

        # Complete event with all data
        yield {
            "type": "complete",
            "session_id": session_id,
            "layers": all_layers_results,
            "rest_image": rest_image_b64
        }

        logger.info(f"Streaming session {session_id} completed")

    async def redo_from_layer_stream(
        self,
        session_id: str,
        from_layer: int,
        only_this_layer: bool = False
    ):
        """
        Redo segmentation from a specific layer (streaming).

        Loads the stored input image for from_layer, then re-processes
        from_layer and all subsequent layers with is_redo=True (emphasis prompts).
        If only_this_layer=True, only re-process the single layer (no cascade, no inpainting).

        Yields same SSE event format as process_confirmed_layers_stream.
        """
        mode = "single layer" if only_this_layer else f"from layer {from_layer}"
        logger.info(f"Redo {mode} for session {session_id}")

        if session_id not in self._sessions:
            yield {"type": "error", "message": f"Session {session_id} not found"}
            return

        session = self._sessions[session_id]
        layers_info = session["layers_info"]
        layers = layers_info.get("layers", [])

        if not layers:
            yield {"type": "error", "message": "No layers to process"}
            return

        # Load the stored input image for the redo layer
        session_dir = OUTPUT_DIR / session_id
        input_image_path = session_dir / f"layer_{from_layer}" / "00_input.png"

        if not input_image_path.exists():
            yield {"type": "error", "message": f"No stored input image for layer {from_layer}"}
            return

        current_image = input_image_path.read_bytes()
        original_image = session["image_data"]  # Untouched original for inpainting reference

        # Filter to target layers
        if only_this_layer:
            redo_layers = [l for l in layers if l.get("layer", 0) == from_layer]
        else:
            redo_layers = [l for l in layers if l.get("layer", 0) >= from_layer]

        if not redo_layers:
            yield {"type": "error", "message": f"No layers found for layer {from_layer}"}
            return

        total_elements = sum(len(l.get("elements", [])) for l in redo_layers)

        yield {
            "type": "redo_start",
            "session_id": session_id,
            "from_layer": from_layer,
            "total_layers": len(redo_layers),
            "total_elements": total_elements
        }

        all_layers_results = []

        for layer_idx, layer in enumerate(redo_layers):
            layer_num = layer.get("layer", 1)
            elements = layer.get("elements", [])

            if not elements:
                continue

            layer_dir = session_dir / f"layer_{layer_num}"
            layer_dir.mkdir(exist_ok=True)

            yield {
                "type": "detecting",
                "layer": layer_num,
                "element_count": len(elements)
            }

            # Save input image for this layer
            (layer_dir / "00_input.png").write_bytes(current_image)

            # SINGLE-LAYER REDO: reuse original boxes, just get denser points
            # CASCADE REDO: full re-detection
            if only_this_layer:
                detections = await self._refine_points_for_layer(
                    current_image, layer_dir, elements, layer_num
                )
            else:
                logger.info(f"[Redo L{layer_num}] Detecting {len(elements)} elements... (REDO)")
                detection_results = await self._detect_layer_elements(current_image, elements, is_redo=True)
                detections = [r for r in detection_results if r.get("found", False)]
                logger.info(f"[Redo L{layer_num}] Found {len(detections)} detections out of {len(elements)} elements")

            if not detections:
                logger.warning(f"[Redo L{layer_num}] No elements detected, skipping layer")
                yield {
                    "type": "layer_warning",
                    "layer": layer_num,
                    "message": f"No elements detected in layer {layer_num}"
                }
                continue

            # Draw boxes visualization
            boxed_image = self._draw_boxes_on_image(current_image, detections, layer_num)
            (layer_dir / "01_boxes.png").write_bytes(boxed_image)

            # Save detection results for future re-segment
            with open(layer_dir / "detections.json", "w") as f:
                json.dump(detections, f, indent=2)

            # Process each element
            layer_results = {"layer": layer_num, "elements": []}
            masks = []

            for det_idx, det in enumerate(detections):
                name = det.get("label", "unknown")
                box = det.get("box_2d", [])
                has_internal_gaps = det.get("has_internal_gaps", False)
                positive_points = det.get("positive_points", [])
                negative_points = det.get("negative_points", [])
                if len(box) != 4:
                    continue

                safe_name = sanitize_filename(name)

                mask_data = await self.seg_service.generate_mask(
                    image_data=current_image,
                    element_name=name,
                    bounding_box=box,
                    has_internal_gaps=has_internal_gaps,
                    positive_points=positive_points,
                    negative_points=negative_points,
                    is_redo=True
                )

                if not mask_data:
                    logger.warning(f"Failed to generate mask for {name}")
                    continue

                masks.append(mask_data)
                (layer_dir / f"mask_{safe_name}.png").write_bytes(mask_data)

                extracted = self._extract_element_with_mask(current_image, mask_data)
                (layer_dir / f"extracted_{safe_name}.png").write_bytes(extracted)

                actual_box = self._get_mask_bounding_box(mask_data)

                try:
                    svg_string = mask_to_svg(mask_data)
                    logger.info(f"  Generated SVG for {name} ({len(svg_string)} chars)")
                except Exception as e:
                    logger.warning(f"  Failed to generate SVG for {name}: {e}")
                    svg_string = ""

                import base64
                element_data = {
                    "name": name,
                    "mask": base64.b64encode(mask_data).decode("utf-8"),
                    "extracted": base64.b64encode(extracted).decode("utf-8"),
                    "svg": svg_string,
                    "box_2d": actual_box
                }
                layer_results["elements"].append(element_data)

                yield {
                    "type": "element",
                    "layer": layer_num,
                    "name": name,
                    "extracted": element_data["extracted"],
                    "mask": element_data["mask"],
                    "svg": svg_string,
                    "box_2d": actual_box,
                    "element_index": det_idx,
                    "total_in_layer": len(detections)
                }

            all_layers_results.append(layer_results)

            # Visualization
            if masks:
                removed_vis = self._create_removed_visualization(current_image, masks)
                (layer_dir / "02_masked_areas.png").write_bytes(removed_vis)

            # Inpaint for next layer (skip for single-layer redo — no cascade)
            is_last_layer = (layer_num >= max(l.get("layer", 0) for l in layers))
            if masks and not is_last_layer and not only_this_layer:
                yield {
                    "type": "inpainting",
                    "layer": layer_num
                }

                # Smart inpainting: vision analyzes the region first
                combined_mask = self.inpaint_service._combine_masks(masks) if len(masks) > 1 else masks[0]
                removed_names, behind_names, previously_removed, _ = \
                    self._get_inpaint_context(layer, layers)
                image_structure = session.get("image_structure", "")
                scene_analysis = await self._analyze_inpaint_region(
                    current_image, combined_mask, removed_names,
                    behind_names, image_structure, previously_removed
                )
                inpaint_prompt = self._build_inpaint_prompt(layer, layers, scene_analysis=scene_analysis)
                ref_image = original_image
                current_image = await self.inpaint_service.remove_objects_combined(
                    current_image, masks, is_redo=True, prompt=inpaint_prompt,
                    original_image=ref_image
                )
                (layer_dir / "inpainted.png").write_bytes(current_image)

        # Final rest image
        import base64
        rest_image_b64 = base64.b64encode(current_image).decode("utf-8")
        (session_dir / "rest_image.png").write_bytes(current_image)

        yield {
            "type": "redo_complete",
            "session_id": session_id,
            "from_layer": from_layer,
            "layers": all_layers_results,
            "rest_image": rest_image_b64
        }

        logger.info(f"Redo from layer {from_layer} for session {session_id} completed")

    async def _refine_points_for_layer(
        self,
        image_data: bytes,
        layer_dir,
        elements: List[Dict[str, Any]],
        layer_num: int
    ) -> List[Dict[str, Any]]:
        """Re-segment a layer by keeping original boxes and getting denser points.

        Loads saved detection results (boxes) from the first pass,
        asks Gemini for more precise point prompts, returns updated detections.
        Falls back to full re-detection if saved detections not found.
        """
        from prompts.prompts import POINT_REFINEMENT_PROMPT

        # Try to load saved detections from first pass
        detections_path = layer_dir / "detections.json"
        if not detections_path.exists():
            logger.warning(f"[Redo L{layer_num}] No saved detections, falling back to full re-detection")
            results = await self._detect_layer_elements(image_data, elements, is_redo=True)
            return [r for r in results if r.get("found", False)]

        with open(detections_path) as f:
            saved_detections = json.load(f)

        logger.info(f"[Redo L{layer_num}] Loaded {len(saved_detections)} saved detections, requesting denser points...")

        # Build element list with FIXED boxes for the prompt
        element_list = "\n".join([
            f'  - "{det["label"]}": box_2d={det["box_2d"]}, '
            f'description: {next((e.get("description", "") for e in elements if e["name"] == det["label"]), "")}'
            for det in saved_detections
            if det.get("found", True)
        ])

        prompt = POINT_REFINEMENT_PROMPT.format(element_list=element_list)
        mime_type = "image/png" if image_data[:3] != b'\xff\xd8\xff' else "image/jpeg"

        try:
            response = self._generate_with_fallback(
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_text(text=prompt),
                            types.Part.from_bytes(data=image_data, mime_type=mime_type)
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    temperature=0,
                    max_output_tokens=16384,
                    media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
                )
            )

            # Extract text from response
            text = None
            if response.candidates and len(response.candidates) > 0:
                candidate = response.candidates[0]
                if candidate.content and candidate.content.parts:
                    for part in candidate.content.parts:
                        if hasattr(part, 'text') and part.text:
                            text = part.text
                            break
            if text is None:
                text = response.text

            if text is None:
                logger.error(f"[Redo L{layer_num}] Point refinement returned empty response")
                return saved_detections  # Fall back to original detections

            # Parse JSON
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]

            refined = json.loads(text.strip())
            if not isinstance(refined, list):
                refined = refined.get("detections", refined.get("elements", []))

            # Merge: use refined points but ensure boxes match originals
            refined_by_label = {r.get("label", ""): r for r in refined}
            merged = []
            for det in saved_detections:
                label = det.get("label", "")
                if label in refined_by_label:
                    ref = refined_by_label[label]
                    merged.append({
                        **det,
                        "box_2d": det["box_2d"],  # Keep original box
                        "positive_points": ref.get("positive_points", det.get("positive_points", [])),
                        "negative_points": ref.get("negative_points", det.get("negative_points", [])),
                        "has_internal_gaps": ref.get("has_internal_gaps", det.get("has_internal_gaps", False)),
                    })
                    new_pos = len(ref.get("positive_points", []))
                    new_neg = len(ref.get("negative_points", []))
                    logger.info(f"  {label}: refined to {new_pos} pos + {new_neg} neg points (box unchanged)")
                else:
                    merged.append(det)
                    logger.warning(f"  {label}: not in refinement response, using original points")

            logger.info(f"[Redo L{layer_num}] Point refinement complete: {len(merged)} elements")
            return merged

        except Exception as e:
            logger.exception(f"[Redo L{layer_num}] Point refinement failed: {e}")
            return saved_detections  # Fall back to original detections

    async def _detect_layer_elements(
        self,
        image_data: bytes,
        elements: List[Dict[str, Any]],
        retry_count: int = 0,
        is_redo: bool = False
    ) -> List[Dict[str, Any]]:
        """Detect ALL elements in a layer in a single batch call.

        Includes retry logic for transient Gemini failures.

        Args:
            is_redo: If True, use REDO_BATCH_DETECTION_PROMPT with more anchor points
        """
        if not elements:
            return []

        MAX_RETRIES = 2

        # Import centralized prompt - use REDO version if is_redo=True
        from prompts.prompts import BATCH_DETECTION_PROMPT, REDO_BATCH_DETECTION_PROMPT

        element_list = "\n".join([
            f'  - "{e["name"]}": {e.get("description", "")}'
            for e in elements
        ])

        if is_redo:
            logger.info(f"  Using REDO_BATCH_DETECTION_PROMPT (5-8 points, danger zones)")
            prompt = REDO_BATCH_DETECTION_PROMPT.format(
                num_elements=len(elements),
                element_list=element_list
            )
        else:
            prompt = BATCH_DETECTION_PROMPT.format(
                num_elements=len(elements),
                element_list=element_list
            )

        mime_type = "image/png" if image_data[:3] != b'\xff\xd8\xff' else "image/jpeg"

        try:
            response = self._generate_with_fallback(
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_text(text=prompt),
                            types.Part.from_bytes(data=image_data, mime_type=mime_type)
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    temperature=0,
                    max_output_tokens=16384,
                    media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
                    thinking_config=types.ThinkingConfig(thinking_budget=2048),  # Medium thinking for speed
                )
            )

            # Extract text from response (thinking mode returns text in parts)
            text = None
            if response.candidates and len(response.candidates) > 0:
                candidate = response.candidates[0]
                if candidate.content and candidate.content.parts:
                    # Collect ALL text parts (thinking mode may have multiple)
                    all_texts = []
                    for part in candidate.content.parts:
                        if hasattr(part, 'text') and part.text:
                            all_texts.append(part.text)
                    # Use the last text part (usually contains the JSON result)
                    if all_texts:
                        text = all_texts[-1]
                        logger.debug(f"  Found {len(all_texts)} text parts, using last one")
            if text is None:
                text = response.text

            if text is None:
                # Log more details about the response structure
                logger.warning("Gemini returned None for batch detection")
                logger.warning(f"  Response has candidates: {bool(response.candidates)}")
                if response.candidates:
                    candidate = response.candidates[0]
                    logger.warning(f"  Candidate count: {len(response.candidates)}")
                    logger.warning(f"  Finish reason: {candidate.finish_reason if hasattr(candidate, 'finish_reason') else 'N/A'}")
                    logger.warning(f"  Safety ratings: {candidate.safety_ratings if hasattr(candidate, 'safety_ratings') else 'N/A'}")
                    if candidate.content:
                        logger.warning(f"  Parts count: {len(candidate.content.parts) if candidate.content.parts else 0}")
                        if candidate.content.parts:
                            for i, part in enumerate(candidate.content.parts):
                                part_type = type(part).__name__
                                logger.warning(f"  Part {i} type={part_type}: has_text={hasattr(part, 'text')}, text_value={part.text[:100] if hasattr(part, 'text') and part.text else 'None'}...")
                    else:
                        logger.warning(f"  Content is None!")

                # Retry on None response
                if retry_count < MAX_RETRIES:
                    logger.info(f"  Retrying detection (attempt {retry_count + 2}/{MAX_RETRIES + 1})...")
                    import asyncio
                    await asyncio.sleep(1)  # Brief pause before retry
                    return await self._detect_layer_elements(image_data, elements, retry_count + 1)

                return [{"found": False, "box_2d": [], "label": e["name"]} for e in elements]

            # Parse JSON
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]

            # Try to parse, with repair for common Gemini JSON issues
            try:
                results = json.loads(text.strip())
            except json.JSONDecodeError as e:
                logger.warning(f"JSON parse failed, attempting repair: {e}")
                repaired = self._repair_json(text.strip())
                results = json.loads(repaired)

            if not isinstance(results, list):
                results = [results]

            # Log detection results for debugging
            found_names = [r.get("label") for r in results if r.get("found", False)]
            not_found = [e["name"] for e in elements if e["name"] not in found_names]
            logger.info(f"  Batch detection results: found={found_names}, not_found={not_found}")
            if not_found:
                logger.warning(f"  Elements NOT detected by Gemini: {not_found}")

            # Log elements with internal gaps
            for r in results:
                if r.get("has_internal_gaps"):
                    logger.info(f"  {r.get('label')}: has_internal_gaps=True → will use diff-mask")


            # Retry if ALL elements failed to detect (likely transient failure)
            if len(found_names) == 0 and len(elements) > 0 and retry_count < MAX_RETRIES:
                logger.info(f"  All elements failed, retrying (attempt {retry_count + 2}/{MAX_RETRIES + 1})...")
                import asyncio
                await asyncio.sleep(1)
                return await self._detect_layer_elements(image_data, elements, retry_count + 1)

            return results

        except Exception as e:
            logger.exception(f"Batch detection failed: {e}")
            return [{"found": False, "box_2d": [], "label": e["name"]} for e in elements]

    def _create_removed_visualization(self, image_data: bytes, masks: List[bytes]) -> bytes:
        """Create visualization showing what areas are masked.

        Shows the input image with masked areas highlighted in red overlay,
        so user can see exactly what SAM detected.

        Args:
            image_data: Original image bytes
            masks: List of mask PNG bytes

        Returns:
            Visualization image bytes
        """
        import numpy as np

        # Load original image
        original = Image.open(io.BytesIO(image_data)).convert('RGBA')
        width, height = original.size

        # Combine all masks
        combined_mask = np.zeros((height, width), dtype=np.uint8)
        for mask_bytes in masks:
            mask = Image.open(io.BytesIO(mask_bytes)).convert('L')
            if mask.size != (width, height):
                mask = mask.resize((width, height), Image.Resampling.LANCZOS)
            mask_array = np.array(mask)
            combined_mask = np.maximum(combined_mask, mask_array)

        # Create red overlay for masked areas
        overlay = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        overlay_array = np.array(overlay)

        # Where mask is white (>127), add semi-transparent red
        mask_bool = combined_mask > 127
        overlay_array[mask_bool] = [255, 0, 0, 128]  # Red with 50% opacity

        overlay = Image.fromarray(overlay_array, 'RGBA')

        # Composite
        result = Image.alpha_composite(original, overlay)

        # Convert to bytes
        buffer = io.BytesIO()
        result.convert('RGB').save(buffer, format='PNG')
        return buffer.getvalue()

    def _repair_json(self, text: str) -> str:
        """Repair common JSON issues from Gemini output.

        Fixes:
        - Missing closing brackets in arrays: [1,2,3, "key" -> [1,2,3], "key"
        - Trailing commas
        - Unbalanced brackets
        """
        import re

        # Fix pattern: [num,num,num,num, "key" -> [num,num,num,num], "key"
        # This happens when Gemini forgets to close box_2d arrays
        text = re.sub(
            r'\[(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*"',
            r'[\1, \2, \3, \4], "',
            text
        )

        # Fix trailing commas before closing brackets
        text = re.sub(r',\s*\]', ']', text)
        text = re.sub(r',\s*\}', '}', text)

        # Try to balance brackets if still unbalanced
        open_brackets = text.count('[') - text.count(']')
        open_braces = text.count('{') - text.count('}')

        if open_brackets > 0:
            text = text + ']' * open_brackets
        if open_braces > 0:
            text = text + '}' * open_braces

        logger.debug(f"Repaired JSON: {text[:200]}...")
        return text

    def _draw_boxes_on_image(
        self,
        image_data: bytes,
        detections: List[Dict[str, Any]],
        layer_num: int
    ) -> bytes:
        """Draw bounding boxes on image and return as bytes."""
        image = Image.open(io.BytesIO(image_data)).convert('RGB')
        draw = ImageDraw.Draw(image)
        width, height = image.size

        try:
            font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 14)
        except:
            font = ImageFont.load_default()

        color = LAYER_COLORS[(layer_num - 1) % len(LAYER_COLORS)]

        for det in detections:
            # Default to True - if element is in the list, it was found
            if not det.get("found", True):
                continue

            box = det.get("box_2d", [])
            label = f"L{layer_num}: {det.get('label', 'unknown')}"

            if len(box) != 4:
                continue

            y_min, x_min, y_max, x_max = box
            x1 = int(x_min * width / 1000)
            y1 = int(y_min * height / 1000)
            x2 = int(x_max * width / 1000)
            y2 = int(y_max * height / 1000)

            # Draw box
            for offset in range(3):
                draw.rectangle([x1 - offset, y1 - offset, x2 + offset, y2 + offset], outline=color)

            # Draw label
            label_width = len(label) * 7 + 10
            draw.rectangle([x1, y1 - 18, x1 + label_width, y1], fill=color)
            draw.text((x1 + 5, y1 - 16), label, fill=(255, 255, 255), font=font)

        output = io.BytesIO()
        image.save(output, format='PNG')
        return output.getvalue()

    def _extract_element_with_mask(self, image_data: bytes, mask_data: bytes) -> bytes:
        """Extract element using mask (transparent background)."""
        image = Image.open(io.BytesIO(image_data)).convert('RGBA')
        mask = Image.open(io.BytesIO(mask_data)).convert('L')

        if mask.size != image.size:
            mask = mask.resize(image.size, Image.Resampling.LANCZOS)

        output = Image.new('RGBA', image.size, (0, 0, 0, 0))
        output.paste(image, mask=mask)

        buffer = io.BytesIO()
        output.save(buffer, format='PNG')
        return buffer.getvalue()

    def _get_mask_bounding_box(self, mask_data: bytes) -> List[int]:
        """Compute bounding box from mask (returns [y_min, x_min, y_max, x_max] in 0-1000 coords)."""
        import numpy as np
        mask = Image.open(io.BytesIO(mask_data)).convert('L')
        mask_array = np.array(mask)
        height, width = mask_array.shape

        # Find non-zero pixels (white = mask area)
        rows = np.any(mask_array > 128, axis=1)
        cols = np.any(mask_array > 128, axis=0)

        if not np.any(rows) or not np.any(cols):
            # Empty mask, return full image
            return [0, 0, 1000, 1000]

        y_indices = np.where(rows)[0]
        x_indices = np.where(cols)[0]

        y_min = int(y_indices[0] * 1000 / height)
        y_max = int(y_indices[-1] * 1000 / height)
        x_min = int(x_indices[0] * 1000 / width)
        x_max = int(x_indices[-1] * 1000 / width)

        return [y_min, x_min, y_max, x_max]

    async def grab_elements(
        self,
        image_data: bytes,
        element_description: str,
        session_id: Optional[str] = None,
        enable_occlusion_completion: bool = True
    ) -> Dict[str, Any]:
        """
        Grab specific elements from image without layer analysis.

        This is a simplified flow where user describes what they want
        (e.g., "the duck in the center") and we extract just those elements.

        Args:
            image_data: Image bytes
            element_description: What to extract (e.g., "the duck")
            session_id: Optional client-provided session_id for progress tracking
            enable_occlusion_completion: If True, check for occlusion and complete hidden objects

        Returns:
            {
                "session_id": str,
                "elements": [
                    {
                        "name": str,
                        "mask": str (base64),
                        "extracted": str (base64),
                        "box_2d": [y_min, x_min, y_max, x_max]
                    }
                ],
                "rest_image": str (base64)
            }
        """
        logger.info(f"Grabbing elements: {element_description}")

        # Use provided session_id or generate new one
        if not session_id:
            session_id = str(uuid.uuid4())
        session_dir = OUTPUT_DIR / session_id
        session_dir.mkdir(parents=True, exist_ok=True)

        # Initialize progress
        self._update_progress(session_id, 0, "Finding elements...")

        # Save original image
        (session_dir / "00_original.png").write_bytes(image_data)

        # Use centralized prompt from prompts.py
        from prompts.prompts import GRAB_ELEMENTS_PROMPT, GRAB_ELEMENTS_WITH_HINT_PROMPT
        # Will be set to hint prompt if completion was performed
        prompt = GRAB_ELEMENTS_PROMPT.format(element_description=element_description)
        location_hint = None  # Will store occlusion box for detection hint

        mime_type = "image/png" if image_data[:3] != b'\xff\xd8\xff' else "image/jpeg"

        try:
            # Track completion info
            was_completed = False
            completion_note = None
            image_for_detection = image_data  # Will be updated if completion needed

            # =====================================================================
            # OPTIONAL: OCCLUSION CHECK + COMPLETION (before detection)
            # Only runs if enable_occlusion_completion=True
            # =====================================================================
            if enable_occlusion_completion:
                self._update_progress(session_id, 5, "Checking for occlusion...")

                occlusion = await self.occlusion_service.check_occlusion_simple(
                    image_data, element_description
                )

                if occlusion.found and occlusion.is_occluded and occlusion.confidence >= 0.5:
                    logger.info(
                        f"'{occlusion.object_name}' is occluded by '{occlusion.occluder_name}' "
                        f"(missing: {occlusion.missing_parts}) - completing..."
                    )
                    self._update_progress(
                        session_id, 10,
                        f"Bringing {occlusion.object_name} to front (hidden by {occlusion.occluder_name})..."
                    )

                    completed_image = await self.occlusion_service.complete_object(
                        image_data,
                        occlusion.object_name,
                        occlusion.occluder_name,
                        occlusion.missing_parts,
                        amodal_box_2d=occlusion.amodal_box_2d,
                        original_box_2d=occlusion.visible_box_2d
                    )

                    if completed_image:
                        was_completed = True
                        completion_note = (
                            f"Completed (was hidden by {occlusion.occluder_name}, "
                            f"revealed {occlusion.missing_parts})"
                        )
                        # Save completed image for debugging
                        safe_name = sanitize_filename(occlusion.object_name or element_description)
                        (session_dir / f"01_completed_{safe_name}.png").write_bytes(completed_image)
                        logger.info(f"Object completion successful (magenta chroma-keyed)")

                        # Completed image is already on transparent background (magenta removed).
                        # Derive mask from alpha channel, compute box, generate SVG — skip SAM2.
                        from PIL import Image as PILImage
                        import numpy as np
                        comp_img = PILImage.open(io.BytesIO(completed_image)).convert("RGBA")
                        alpha = np.array(comp_img)[:, :, 3]
                        # Create binary mask from alpha
                        mask_arr = np.where(alpha > 20, 255, 0).astype(np.uint8)
                        mask_pil = PILImage.fromarray(mask_arr, mode='L')
                        mask_buf = io.BytesIO()
                        mask_pil.save(mask_buf, format='PNG')
                        mask_data = mask_buf.getvalue()

                        # Compute bounding box from mask
                        actual_box = self._get_mask_bounding_box(mask_data)

                        # Generate SVG from mask
                        try:
                            svg_string = mask_to_svg(mask_data)
                            logger.info(f"  Completed element SVG: {len(svg_string)} chars, box: {actual_box}")
                        except Exception as e:
                            logger.warning(f"  SVG generation failed for completed element: {e}")
                            svg_string = ""

                        # Save artifacts
                        (session_dir / f"mask_{safe_name}.png").write_bytes(mask_data)
                        (session_dir / f"extracted_{safe_name}.png").write_bytes(completed_image)

                        # Build result directly — no SAM2 needed
                        import base64
                        element_name = occlusion.object_name or element_description
                        results = {
                            "session_id": session_id,
                            "elements": [{
                                "name": element_name,
                                "mask": base64.b64encode(mask_data).decode("utf-8"),
                                "extracted": base64.b64encode(completed_image).decode("utf-8"),
                                "svg": svg_string,
                                "box_2d": actual_box,
                                "was_completed": True,
                                "completion_note": completion_note,
                            }],
                            "rest_image": None,
                            "parsed_query": element_description,
                        }

                        # Inpaint original image to create rest image (use alpha mask on original)
                        self._update_progress(session_id, 80, "Removing element from background...")
                        rest_image = await self.inpaint_service.remove_objects_combined(
                            image_data, [mask_data]
                        )
                        (session_dir / "rest_image.png").write_bytes(rest_image)
                        results["rest_image"] = base64.b64encode(rest_image).decode("utf-8")

                        self._update_progress(session_id, 100, "Complete!", status="completed")
                        self._sessions[session_id] = {
                            "image_data": image_data,
                            "elements": results["elements"],
                            "status": "completed"
                        }
                        logger.info(f"Grab (completed path) done: {element_name}")
                        return results
                    else:
                        logger.warning("Completion failed, proceeding with original image")
                elif occlusion.found:
                    logger.info(f"'{occlusion.object_name}' is fully visible, no completion needed")
                else:
                    logger.info(f"Occlusion check: object not clearly identified, proceeding with detection")

            # =====================================================================
            # STEP 3: DETECTION WITH GEMINI 3 PRO (on original image — no completion)
            # =====================================================================
            self._update_progress(session_id, 20, "Detecting elements with AI...")

            response = self._generate_with_fallback(
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_text(text=prompt),
                            types.Part.from_bytes(data=image_for_detection, mime_type=mime_type)
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    temperature=0,
                    max_output_tokens=16384,
                    media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
                    thinking_config=types.ThinkingConfig(thinking_budget=2048),
                )
            )

            logger.info(f"Gemini grab response received, candidates: {len(response.candidates) if response.candidates else 0}")

            # Extract text from response (thinking mode returns text in parts)
            text = None
            if response.candidates and len(response.candidates) > 0:
                candidate = response.candidates[0]
                if candidate.content and candidate.content.parts:
                    all_texts = []
                    for part in candidate.content.parts:
                        if hasattr(part, 'text') and part.text:
                            all_texts.append(part.text)
                    if all_texts:
                        text = all_texts[-1]
                        logger.debug(f"  Grab: Found {len(all_texts)} text parts, using last one")
            if text is None:
                text = response.text

            if text is None:
                logger.warning("Gemini grab returned None response")
                return {"error": "AI returned empty response"}

            logger.info(f"Raw Gemini response for grab: {text[:500]}")

            # Parse JSON
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]

            try:
                response_data = json.loads(text.strip())
            except json.JSONDecodeError as e:
                logger.error(f"JSON parse error: {e}. Text was: {text[:500]}")
                return {"error": f"Failed to parse AI response: {str(e)}"}

            # Handle new format: {"parsed_query": "...", "elements": [...]}
            if isinstance(response_data, dict) and "elements" in response_data:
                parsed_query = response_data.get("parsed_query", element_description)
                detections = response_data.get("elements", [])
            elif isinstance(response_data, list):
                parsed_query = element_description
                detections = response_data
            else:
                parsed_query = element_description
                detections = [response_data]

            # Filter successful detections
            detections = [d for d in detections if d.get("found", True) and d.get("box_2d") and d.get("label")]

            if not detections:
                return {"error": f"No matching elements found", "parsed_query": parsed_query}

            logger.info(f"Found {len(detections)} elements matching: {element_description}")
            self._update_progress(session_id, 30, f"Found {len(detections)} elements...")

            # Draw boxes visualization (on the image used for detection)
            boxed_image = self._draw_boxes_on_image(image_for_detection, detections, 1)
            (session_dir / "02_boxes.png").write_bytes(boxed_image)

            # =====================================================================
            # STEP 4: GENERATE MASKS AND EXTRACT ELEMENTS
            # Uses SAM2 on the (possibly completed) image
            # =====================================================================
            results = {"session_id": session_id, "elements": [], "rest_image": None, "parsed_query": parsed_query}
            masks = []
            current_image = image_data

            # Calculate progress steps: 30% for detection+occlusion, 50% for masks, 20% for inpainting
            total_elements = len(detections)

            for det_idx, det in enumerate(detections):
                name = det.get("label", "unknown")
                box = det.get("box_2d", [])
                has_internal_gaps = det.get("has_internal_gaps", False)
                positive_points = det.get("positive_points", [])
                negative_points = det.get("negative_points", [])
                if len(box) != 4:
                    continue

                safe_name = sanitize_filename(name)

                # Update progress for this element (30-80% range for masks)
                mask_progress = 30 + int((det_idx / total_elements) * 50)
                if was_completed:
                    self._update_progress(session_id, mask_progress, f"Masking completed {name}...")
                else:
                    self._update_progress(session_id, mask_progress, f"Masking {name}...")

                # Generate SAM2 mask (or diff-mask for objects with internal gaps)
                # Use completed image if object was occluded and completed
                mask_data = await self.seg_service.generate_mask(
                    image_data=image_for_detection,  # Use completed image
                    element_name=name,
                    bounding_box=box,
                    has_internal_gaps=has_internal_gaps,
                    positive_points=positive_points,
                    negative_points=negative_points
                )

                if not mask_data:
                    logger.warning(f"Failed to generate mask for {name}")
                    continue

                masks.append(mask_data)

                # Save mask
                (session_dir / f"mask_{safe_name}.png").write_bytes(mask_data)

                # Extract element with transparent background
                # Use the completed image for extraction
                extracted = self._extract_element_with_mask(image_for_detection, mask_data)
                (session_dir / f"extracted_{safe_name}.png").write_bytes(extracted)

                # Compute actual bounding box from mask (more accurate than Gemini's box)
                actual_box = self._get_mask_bounding_box(mask_data)
                logger.info(f"  Gemini box: {box} -> Mask box: {actual_box}")

                # Convert mask to SVG for 3D geometry
                try:
                    svg_string = mask_to_svg(mask_data)
                    logger.info(f"  Generated SVG for {name} ({len(svg_string)} chars)")
                except Exception as e:
                    logger.warning(f"  Failed to generate SVG for {name}: {e}")
                    svg_string = ""

                # Add to results
                import base64
                element_result = {
                    "name": name,
                    "mask": base64.b64encode(mask_data).decode("utf-8"),
                    "extracted": base64.b64encode(extracted).decode("utf-8"),
                    "svg": svg_string,
                    "box_2d": actual_box,  # Use mask-based box for accurate positioning
                    "was_completed": was_completed,
                }

                # Add completion note if applicable (same for all elements since completion was done before detection)
                if was_completed and completion_note:
                    element_result["completion_note"] = completion_note

                results["elements"].append(element_result)

            # Inpaint to create rest image
            if masks:
                self._update_progress(session_id, 80, "Removing elements from background...")
                logger.info(f"Inpainting {len(masks)} elements")
                current_image = await self.inpaint_service.remove_objects_combined(
                    image_data, masks
                )
                (session_dir / "rest_image.png").write_bytes(current_image)

            import base64
            results["rest_image"] = base64.b64encode(current_image).decode("utf-8")

            # Complete
            self._update_progress(session_id, 100, "Complete!", status="completed")

            # Store session
            self._sessions[session_id] = {
                "image_data": image_data,
                "elements": results["elements"],
                "status": "completed"
            }

            logger.info(f"Grab elements completed: {len(results['elements'])} elements extracted")

            return results

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse grab elements JSON: {e}")
            return {"error": f"Failed to parse AI response: {str(e)}"}
        except Exception as e:
            logger.exception(f"Grab elements failed: {e}")
            return {"error": str(e)}

    async def sub_segment(
        self,
        image_data: bytes,
        prompt: str,
        segment_id: str,
        transform: Dict[str, Any] = None
    ) -> Dict[str, Any]:
        """
        Break a segment into smaller sub-segments based on user prompt.

        Args:
            image_data: The segment PNG (extracted segment, not full canvas)
            prompt: What to extract (e.g., "get the apples from the tree")
            segment_id: ID of the parent segment being broken up
            transform: Transform data from parent segment (x, y, width, height, rotation, scaleX, scaleY)

        Returns:
            {
                "sub_segments": [
                    {
                        "name": str,
                        "mask": str (base64),
                        "extracted": str (base64),
                        "svg": str,
                        "box_2d": [y_min, x_min, y_max, x_max]  # relative to input PNG (0-1000)
                    }
                ],
                "parsed_query": str
            }
        """
        logger.info(f"Sub-segmenting {segment_id}: {prompt}")

        session_id = f"subseg-{segment_id}-{uuid.uuid4().hex[:8]}"
        session_dir = OUTPUT_DIR / session_id
        session_dir.mkdir(parents=True, exist_ok=True)

        # Save input segment for debugging
        (session_dir / "00_input_segment.png").write_bytes(image_data)

        # Get image dimensions
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(image_data))
        width, height = img.size
        logger.info(f"Sub-segment input size: {width}x{height}")

        # Use sub-segment prompt
        from prompts.prompts import SUB_SEGMENT_PROMPT
        detection_prompt = SUB_SEGMENT_PROMPT.format(prompt=prompt)

        mime_type = "image/png" if image_data[:3] != b'\xff\xd8\xff' else "image/jpeg"

        try:
            # Step 1: Detect sub-elements with Gemini
            response = self._generate_with_fallback(
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_text(text=detection_prompt),
                            types.Part.from_bytes(data=image_data, mime_type=mime_type)
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    temperature=0,
                    max_output_tokens=16384,
                    media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
                    thinking_config=types.ThinkingConfig(thinking_budget=2048),
                )
            )

            # Extract text from response
            text = None
            if response.candidates and len(response.candidates) > 0:
                candidate = response.candidates[0]
                if candidate.content and candidate.content.parts:
                    all_texts = []
                    for part in candidate.content.parts:
                        if hasattr(part, 'text') and part.text:
                            all_texts.append(part.text)
                    if all_texts:
                        text = all_texts[-1]

            if text is None:
                text = response.text

            if text is None:
                logger.warning("Gemini sub-segment returned None")
                return {"error": "AI returned empty response", "sub_segments": [], "parsed_query": prompt}

            logger.info(f"Sub-segment detection response: {text[:500]}")

            # Parse JSON
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]

            response_data = json.loads(text.strip())
            parsed_query = response_data.get("parsed_query", prompt)
            detections = response_data.get("sub_elements", [])

            if not detections:
                logger.info(f"No sub-elements found for: {prompt}")
                return {"error": "No matching sub-elements found", "sub_segments": [], "parsed_query": parsed_query}

            logger.info(f"Found {len(detections)} sub-elements")

            # Draw detection boxes for debugging
            boxed_image = self._draw_boxes_on_image(image_data, detections, 1)
            (session_dir / "01_detections.png").write_bytes(boxed_image)

            # Step 2: Generate masks and extract sub-elements
            results = {"sub_segments": [], "parsed_query": parsed_query}
            masks = []  # Collect masks for inpainting rest segment

            for det_idx, det in enumerate(detections):
                name = det.get("label", f"sub_{det_idx}")
                box = det.get("box_2d", [])
                positive_points = det.get("positive_points", [])
                negative_points = det.get("negative_points", [])
                has_internal_gaps = det.get("has_internal_gaps", False)

                if len(box) != 4:
                    continue

                safe_name = sanitize_filename(name)
                logger.info(f"  Processing sub-element: {name} at {box}")

                # Generate SAM2 mask
                mask_data = await self.seg_service.generate_mask(
                    image_data=image_data,
                    element_name=name,
                    bounding_box=box,
                    has_internal_gaps=has_internal_gaps,
                    positive_points=positive_points,
                    negative_points=negative_points
                )

                if not mask_data:
                    logger.warning(f"  Failed to generate mask for {name}")
                    continue

                # Save mask
                (session_dir / f"mask_{safe_name}.png").write_bytes(mask_data)

                # Extract element with transparent background
                extracted = self._extract_element_with_mask(image_data, mask_data)
                (session_dir / f"extracted_{safe_name}.png").write_bytes(extracted)

                # Compute actual bounding box from mask
                actual_box = self._get_mask_bounding_box(mask_data)
                logger.info(f"  Detection box: {box} -> Mask box: {actual_box}")

                # Convert mask to SVG for 3D geometry
                try:
                    svg_string = mask_to_svg(mask_data)
                    logger.info(f"  Generated SVG for {name} ({len(svg_string)} chars)")
                except Exception as e:
                    logger.warning(f"  Failed to generate SVG for {name}: {e}")
                    svg_string = ""

                # Add to results and collect masks for inpainting
                import base64
                results["sub_segments"].append({
                    "name": name,
                    "mask": base64.b64encode(mask_data).decode("utf-8"),
                    "extracted": base64.b64encode(extracted).decode("utf-8"),
                    "svg": svg_string,
                    "box_2d": actual_box  # Relative to input PNG (0-1000 normalized)
                })
                masks.append(mask_data)

            # Step 3: Create "rest" segment (original tree with apples inpainted out)
            if masks and len(results["sub_segments"]) > 0:
                logger.info(f"Creating rest segment ({len(masks)} masks to inpaint)")
                try:
                    from PIL import Image
                    import io
                    import numpy as np

                    # Combine all masks into one (areas to remove)
                    combined_mask = None
                    for mask_bytes in masks:
                        mask_img = Image.open(io.BytesIO(mask_bytes)).convert('L')
                        mask_arr = np.array(mask_img)
                        if combined_mask is None:
                            combined_mask = mask_arr
                        else:
                            combined_mask = np.maximum(combined_mask, mask_arr)

                    # Get original image and its alpha channel
                    orig_img = Image.open(io.BytesIO(image_data)).convert('RGBA')
                    orig_arr = np.array(orig_img)
                    alpha = orig_arr[:, :, 3]

                    # Create rest mask: original visible area (tree outline)
                    # This is the same as original segment's alpha - we keep the full tree shape
                    rest_mask_arr = np.where(alpha > 128, 255, 0).astype(np.uint8)
                    rest_mask_img = Image.fromarray(rest_mask_arr, mode='L')

                    rest_mask_buffer = io.BytesIO()
                    rest_mask_img.save(rest_mask_buffer, format='PNG')
                    rest_mask_bytes = rest_mask_buffer.getvalue()
                    (session_dir / "mask_rest.png").write_bytes(rest_mask_bytes)

                    # ORGANIC PADDING: Use edge-extension to fill transparent areas
                    # This gives the AI "semantic noise" to seed the inpainting
                    import cv2

                    visible_mask = (alpha > 128).astype(np.uint8)

                    # Step 1: Use cv2.inpaint to extend tree edges into transparent areas
                    # This "bleeds" the tree texture outward naturally
                    rgb_arr = orig_arr[:, :, :3].copy()
                    # Inpaint mask: 255 where we want to fill (transparent areas)
                    inpaint_mask = (255 - visible_mask * 255).astype(np.uint8)

                    # Use TELEA inpainting to extend edges (fast and good for this use case)
                    extended_rgb = cv2.inpaint(rgb_arr, inpaint_mask, inpaintRadius=15, flags=cv2.INPAINT_TELEA)

                    # Step 2: Apply Gaussian blur for softer transitions
                    blurred_rgb = cv2.GaussianBlur(extended_rgb, (21, 21), 0)

                    # Step 3: Composite - original where visible, blurred-extended where transparent
                    filled_arr = orig_arr.copy()
                    filled_arr[~visible_mask.astype(bool), :3] = blurred_rgb[~visible_mask.astype(bool)]
                    filled_arr[:, :, 3] = 255  # Make fully opaque for inpainting
                    filled_img = Image.fromarray(filled_arr, 'RGBA')

                    filled_buffer = io.BytesIO()
                    filled_img.save(filled_buffer, format='PNG')
                    filled_bytes = filled_buffer.getvalue()
                    (session_dir / "rest_for_inpaint.png").write_bytes(filled_bytes)

                    # Use foliage-specific prompt for better texture matching
                    from prompts.prompts import FOLIAGE_INPAINTING_PROMPT

                    # DEBUG: Save combined apple mask (what we send to Gemini for inpainting)
                    combined_apple_mask_arr = combined_mask.copy()
                    # Dilate to match what inpainting service does
                    kernel = np.ones((5*2+1, 5*2+1), np.uint8)
                    dilated_mask = cv2.dilate(combined_apple_mask_arr, kernel, iterations=1)
                    dilated_mask_img = Image.fromarray(dilated_mask, mode='L')
                    dilated_mask_buffer = io.BytesIO()
                    dilated_mask_img.save(dilated_mask_buffer, format='PNG')
                    (session_dir / "mask_apples_combined_dilated.png").write_bytes(dilated_mask_buffer.getvalue())
                    logger.info(f"Saved combined dilated apple mask for debugging")

                    # Inpaint with dilated masks and foliage prompt
                    rest_inpainted_raw = await self.inpaint_service.remove_objects_combined(
                        filled_bytes, masks, dilate_pixels=5, prompt=FOLIAGE_INPAINTING_PROMPT
                    )
                    (session_dir / "rest_inpainted_raw.png").write_bytes(rest_inpainted_raw)

                    # Simply restore original alpha to inpainted image
                    inpainted_img = Image.open(io.BytesIO(rest_inpainted_raw)).convert('RGBA')
                    inpainted_arr = np.array(inpainted_img)
                    # Replace alpha with original alpha (tree shape only)
                    inpainted_arr[:, :, 3] = alpha
                    rest_inpainted_img = Image.fromarray(inpainted_arr, 'RGBA')

                    rest_inpainted_buffer = io.BytesIO()
                    rest_inpainted_img.save(rest_inpainted_buffer, format='PNG')
                    rest_inpainted = rest_inpainted_buffer.getvalue()
                    (session_dir / "rest_inpainted.png").write_bytes(rest_inpainted)

                    # The rest_extracted is just the inpainted image with original alpha
                    # No need for additional masking since alpha already defines the shape
                    rest_extracted = rest_inpainted
                    (session_dir / "rest_segment.png").write_bytes(rest_extracted)

                    # Generate SVG for rest segment
                    try:
                        rest_svg = mask_to_svg(rest_mask_bytes)
                        logger.info(f"  Generated SVG for rest segment ({len(rest_svg)} chars)")
                    except Exception as e:
                        logger.warning(f"  Failed to generate SVG for rest segment: {e}")
                        rest_svg = ""

                    # Rest segment box should match the original segment's bounding box
                    # The transform data contains the original segment position in 1024-coords
                    # Convert to 0-1000 normalized coordinates
                    if transform:
                        orig_x = transform.get("x", 0)
                        orig_y = transform.get("y", 0)
                        orig_w = transform.get("width", 1024)
                        orig_h = transform.get("height", 1024)
                        # Convert from pixel coords (assuming 1024 canvas) to 0-1000 normalized
                        rest_box = [
                            int(orig_y / 1024 * 1000),  # y_min
                            int(orig_x / 1024 * 1000),  # x_min
                            int((orig_y + orig_h) / 1024 * 1000),  # y_max
                            int((orig_x + orig_w) / 1024 * 1000),  # x_max
                        ]
                        logger.info(f"Rest segment using original transform box: {rest_box}")
                    else:
                        # Fallback: compute from mask bounding box
                        rest_box = self._get_mask_bounding_box(rest_mask_bytes)
                        logger.info(f"Rest segment using mask-computed box: {rest_box}")

                    results["rest_segment"] = {
                        "name": "rest",
                        "mask": base64.b64encode(rest_mask_bytes).decode("utf-8"),
                        "extracted": base64.b64encode(rest_extracted).decode("utf-8"),
                        "svg": rest_svg,
                        "box_2d": rest_box
                    }
                    logger.info(f"Rest segment created with box: {rest_box}")
                except Exception as e:
                    logger.warning(f"Failed to create rest segment: {e}")
                    import traceback
                    traceback.print_exc()
                    # Continue without rest segment

            logger.info(f"Sub-segment completed: {len(results['sub_segments'])} sub-elements extracted")
            return results

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse sub-segment JSON: {e}")
            return {"error": f"Failed to parse AI response: {str(e)}", "sub_segments": [], "parsed_query": prompt}
        except Exception as e:
            logger.exception(f"Sub-segment failed: {e}")
            return {"error": str(e), "sub_segments": [], "parsed_query": prompt}

    async def repair_segment(
        self,
        image_data: bytes,
        original_image_data: bytes,
        segment_id: str,
        element_name: str = "",
    ) -> Dict[str, Any]:
        """Repair a noisy segment extraction using Gemini image model.

        Composites the extracted segment onto magenta (#FF00FF) background,
        sends to Gemini with original scene reference, then derives a clean
        mask via chroma-key and generates outline SVG.

        Returns:
            {
                "repaired_image": base64 RGBA PNG,
                "svg": outline SVG string,
                "mask": base64 mask PNG,
                "success": bool
            }
        """
        import base64
        import numpy as np

        logger.info(f"[repair] Starting repair for segment {segment_id}")

        # Debug output directory
        debug_dir = OUTPUT_DIR / "repair_debug"
        debug_dir.mkdir(parents=True, exist_ok=True)

        try:
            # Step 1: Crop to element bounding box, then composite onto magenta
            img = Image.open(io.BytesIO(image_data)).convert('RGBA')
            original_size = img.size
            logger.info(f"[repair] Input image size: {original_size}")

            # Save input for debugging
            img.save(debug_dir / "01_input_rgba.png")

            # Find bounding box of non-transparent pixels
            import numpy as np
            alpha = np.array(img.split()[3])
            rows = np.any(alpha > 10, axis=1)
            cols = np.any(alpha > 10, axis=0)
            if not np.any(rows) or not np.any(cols):
                logger.error("[repair] No visible pixels in input")
                return {"success": False}

            y_indices = np.where(rows)[0]
            x_indices = np.where(cols)[0]
            y_min, y_max = int(y_indices[0]), int(y_indices[-1])
            x_min, x_max = int(x_indices[0]), int(x_indices[-1])

            # Add padding (10% of bbox size, min 10px)
            bbox_w = x_max - x_min
            bbox_h = y_max - y_min
            pad = max(10, int(max(bbox_w, bbox_h) * 0.1))
            crop_x1 = max(0, x_min - pad)
            crop_y1 = max(0, y_min - pad)
            crop_x2 = min(original_size[0], x_max + pad)
            crop_y2 = min(original_size[1], y_max + pad)
            crop_box = (crop_x1, crop_y1, crop_x2, crop_y2)
            logger.info(f"[repair] Element bbox: ({x_min},{y_min})-({x_max},{y_max}), crop with pad: {crop_box}")

            # Crop the element and composite onto magenta
            cropped = img.crop(crop_box)
            cropped_size = cropped.size
            magenta_bg = Image.new('RGBA', cropped_size, (255, 0, 255, 255))
            composite = Image.alpha_composite(magenta_bg, cropped).convert('RGB')

            # Save composite for debugging
            composite.save(debug_dir / "02_magenta_composite.png")

            # Convert composite to bytes for Gemini
            buf = io.BytesIO()
            composite.save(buf, format='PNG')
            composite_bytes = buf.getvalue()

            # Step 2: Crop original scene to same region + prepare position hint
            original_img = Image.open(io.BytesIO(original_image_data)).convert('RGB')
            orig_w, orig_h = original_img.size

            # Save original scene for debugging
            original_img.save(debug_dir / "00_original_scene.png")

            # Crop original to same bbox (with extra padding for context)
            context_pad = max(20, int(max(bbox_w, bbox_h) * 0.25))  # 25% padding for more context
            ctx_x1 = max(0, x_min - context_pad)
            ctx_y1 = max(0, y_min - context_pad)
            ctx_x2 = min(orig_w, x_max + context_pad)
            ctx_y2 = min(orig_h, y_max + context_pad)
            cropped_original = original_img.crop((ctx_x1, ctx_y1, ctx_x2, ctx_y2))
            cropped_orig_buf = io.BytesIO()
            cropped_original.save(cropped_orig_buf, format='PNG')
            cropped_original_bytes = cropped_orig_buf.getvalue()

            # Save cropped original for debugging
            cropped_original.save(debug_dir / "02b_original_cropped.png")

            # Full original for overall context
            orig_buf = io.BytesIO()
            original_img.save(orig_buf, format='PNG')
            original_bytes = orig_buf.getvalue()

            # Compute human-readable position hint from bbox center
            cx = (x_min + x_max) / 2 / orig_w
            cy = (y_min + y_max) / 2 / orig_h
            v_pos = "top" if cy < 0.33 else ("bottom" if cy > 0.66 else "middle")
            h_pos = "left" if cx < 0.33 else ("right" if cx > 0.66 else "center")
            position_hint = f"the {v_pos}-{h_pos}" if v_pos != "middle" or h_pos != "center" else "the center"

            # Format prompt with element name and position hint
            name_for_prompt = element_name or "element"
            formatted_prompt = REPAIR_SEGMENT_PROMPT.format(
                element_name=name_for_prompt,
                position_hint=position_hint
            )
            logger.info(f"[repair] Calling Gemini {IMAGE_PRIMARY} for repair of '{name_for_prompt}' at {position_hint}...")

            response = self.client.models.generate_content(
                model=IMAGE_PRIMARY,
                contents=[
                    types.Part.from_bytes(data=original_bytes, mime_type="image/png"),
                    types.Part.from_bytes(data=cropped_original_bytes, mime_type="image/png"),
                    types.Part.from_bytes(data=composite_bytes, mime_type="image/png"),
                    formatted_prompt,
                ],
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE", "TEXT"],
                ),
            )

            # Log any text response from Gemini
            for part in response.candidates[0].content.parts:
                if hasattr(part, 'text') and part.text:
                    logger.info(f"[repair] Gemini text response: {part.text[:500]}")

            # Extract image from response
            repaired_bytes = None
            for part in response.candidates[0].content.parts:
                if hasattr(part, 'inline_data') and part.inline_data and part.inline_data.mime_type.startswith('image/'):
                    repaired_bytes = part.inline_data.data
                    break

            if not repaired_bytes:
                logger.error("[repair] Gemini returned no image")
                return {"success": False}

            logger.info(f"[repair] Got repaired image ({len(repaired_bytes)} bytes)")

            # Step 3: Derive mask from repaired output (chroma-key magenta removal)
            repaired_cropped = Image.open(io.BytesIO(repaired_bytes)).convert('RGB')

            # Save raw Gemini output for debugging
            repaired_cropped.save(debug_dir / "03_gemini_output_raw.png")

            # Ensure same size as the cropped region
            if repaired_cropped.size != cropped_size:
                logger.info(f"[repair] Resizing Gemini output from {repaired_cropped.size} to {cropped_size}")
                repaired_cropped = repaired_cropped.resize(cropped_size, Image.LANCZOS)

            arr = np.array(repaired_cropped)
            # Magenta detection — loosened for Gemini's anti-aliased edges
            # Pure magenta is (255,0,255), but edges blend to ~(240,30,240)
            is_magenta = (arr[:, :, 0] > 200) & (arr[:, :, 1] < 80) & (arr[:, :, 2] > 200)
            cropped_mask = (~is_magenta).astype(np.uint8) * 255

            foreground_pct = np.sum(cropped_mask > 0) / cropped_mask.size * 100
            logger.info(f"[repair] Cropped mask: {np.sum(cropped_mask > 0)} fg pixels ({foreground_pct:.1f}%)")

            # Save cropped mask for debugging
            Image.fromarray(cropped_mask, mode='L').save(debug_dir / "04a_mask_cropped.png")

            # Paste cropped result back into full-size canvas
            full_repaired = Image.new('RGB', original_size, (255, 0, 255))
            full_repaired.paste(repaired_cropped, (crop_x1, crop_y1))

            full_mask = np.zeros((original_size[1], original_size[0]), dtype=np.uint8)
            full_mask[crop_y1:crop_y1+cropped_size[1], crop_x1:crop_x1+cropped_size[0]] = cropped_mask

            mask_img = Image.fromarray(full_mask, mode='L')

            # Save full mask for debugging
            mask_img.save(debug_dir / "04_mask_full.png")

            # Step 4: Generate outline SVG from mask
            mask_buf = io.BytesIO()
            mask_img.save(mask_buf, format='PNG')
            mask_bytes = mask_buf.getvalue()

            try:
                svg_string = mask_to_svg(mask_bytes)
                logger.info(f"[repair] Generated SVG ({len(svg_string)} chars)")
            except Exception as e:
                logger.warning(f"[repair] SVG generation failed: {e}")
                svg_string = ""

            # Step 5: Apply transparency (magenta → transparent)
            repaired_rgba = full_repaired.convert('RGBA')
            repaired_rgba.putalpha(mask_img)

            # Save final output for debugging
            repaired_rgba.save(debug_dir / "05_final_output.png")

            out_buf = io.BytesIO()
            repaired_rgba.save(out_buf, format='PNG')
            repaired_b64 = base64.b64encode(out_buf.getvalue()).decode('utf-8')
            mask_b64 = base64.b64encode(mask_bytes).decode('utf-8')

            # Compute box_2d from full mask (normalized 0-1000)
            mask_rows = np.any(full_mask > 0, axis=1)
            mask_cols = np.any(full_mask > 0, axis=0)
            if np.any(mask_rows) and np.any(mask_cols):
                my = np.where(mask_rows)[0]
                mx = np.where(mask_cols)[0]
                h, w = original_size[1], original_size[0]
                box_2d = [
                    int(my[0] * 1000 / h),
                    int(mx[0] * 1000 / w),
                    int(my[-1] * 1000 / h),
                    int(mx[-1] * 1000 / w),
                ]
            else:
                box_2d = [0, 0, 1000, 1000]
            logger.info(f"[repair] box_2d: {box_2d}")

            logger.info(f"[repair] Repair complete for segment {segment_id}")

            return {
                "repaired_image": repaired_b64,
                "svg": svg_string,
                "mask": mask_b64,
                "box_2d": box_2d,
                "success": True,
            }

        except Exception as e:
            logger.exception(f"[repair] Failed: {e}")
            return {"success": False}

    def get_session_status(self, session_id: str) -> Dict[str, Any]:
        """Get status of a session."""
        if session_id not in self._sessions:
            return {"error": f"Session {session_id} not found"}

        session = self._sessions[session_id]
        return {
            "session_id": session_id,
            "status": session.get("status", "unknown"),
            "layers_info": session.get("layers_info", {})
        }

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Get session data by ID."""
        return self._sessions.get(session_id)

    def cleanup_session(self, session_id: str):
        """Remove session from memory (files remain on disk)."""
        if session_id in self._sessions:
            del self._sessions[session_id]
            logger.info(f"Cleaned up session {session_id}")


# Singleton instance
_service: Optional[LayerPipelineService] = None


def get_layer_pipeline_service() -> LayerPipelineService:
    """Get or create the LayerPipelineService singleton."""
    global _service
    if _service is None:
        _service = LayerPipelineService()
    return _service
