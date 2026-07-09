"""
Image Analyzer Service

Handles image analysis for layer detection and object detection.
Replaces Qwen VL Max + Grounding DINO.
"""

import logging
from typing import Dict, Any, List, Optional
from .gemini_client import get_gemini_client
from prompts.prompts import LAYER_ANALYSIS_PROMPT, OBJECT_DETECTION_PROMPT

logger = logging.getLogger(__name__)


class ImageAnalyzer:
    """Analyzes images to detect layers and objects for laser-cut art."""

    def __init__(self):
        self.client = get_gemini_client()

    async def analyze_for_layers(self, image_data: bytes) -> Dict[str, Any]:
        """Analyze image and suggest layer decomposition.

        This replaces the Qwen VL Max analysis in the original backend.

        Args:
            image_data: Raw image bytes

        Returns:
            {
                "total_layers": int,
                "layers": [
                    {
                        "layer_number": int,
                        "elements": [
                            {
                                "name": str,
                                "description": str,
                                "box_2d": [y_min, x_min, y_max, x_max],
                                "confidence": float
                            }
                        ]
                    }
                ]
            }
        """
        logger.info("Analyzing image for layer decomposition")

        result = await self.client.analyze_image(
            image_data=image_data,
            prompt=LAYER_ANALYSIS_PROMPT
        )

        if "error" in result:
            logger.error(f"Layer analysis failed: {result['error']}")
            return result

        # Validate and clean up result
        result = self._validate_layer_analysis(result)

        logger.info(f"Found {result.get('total_layers', 0)} layers with "
                    f"{sum(len(l.get('elements', [])) for l in result.get('layers', []))} elements")

        return result

    async def detect_objects(
        self,
        image_data: bytes,
        object_names: List[str]
    ) -> Dict[str, Any]:
        """Detect specific objects and return bounding boxes.

        This replaces the Grounding DINO detection in the original backend.

        Args:
            image_data: Raw image bytes
            object_names: List of object names to detect

        Returns:
            {
                "detections": [
                    {
                        "name": str,
                        "box_2d": [y_min, x_min, y_max, x_max],
                        "confidence": float
                    }
                ]
            }
        """
        logger.info(f"Detecting objects: {object_names}")

        prompt = OBJECT_DETECTION_PROMPT.format(
            object_names=", ".join(object_names)
        )

        result = await self.client.analyze_image(
            image_data=image_data,
            prompt=prompt
        )

        if "error" in result:
            logger.error(f"Object detection failed: {result['error']}")
            return result

        # Validate detections
        result = self._validate_detections(result, object_names)

        logger.info(f"Detected {len(result.get('detections', []))} objects")

        return result

    def _validate_layer_analysis(self, result: Dict[str, Any]) -> Dict[str, Any]:
        """Validate and normalize layer analysis result.

        Handles both flat list format (from simplified prompt) and nested layers format.
        """
        # If result is a flat list (new format), convert to nested layers
        if isinstance(result, list):
            # Group by layer number
            layer_groups = {}
            for item in result:
                layer_num = item.get("layer", 1)
                if layer_num not in layer_groups:
                    layer_groups[layer_num] = []
                # Rename 'label' to 'name' for consistency
                element = {
                    "name": item.get("label", item.get("name", "unknown")),
                    "box_2d": item.get("box_2d", []),
                    "confidence": item.get("confidence", 0.9)
                }
                layer_groups[layer_num].append(element)

            # Convert to nested format
            layers = []
            for layer_num in sorted(layer_groups.keys()):
                layers.append({
                    "layer_number": layer_num,
                    "elements": layer_groups[layer_num]
                })

            result = {
                "total_layers": len(layers),
                "layers": layers
            }

        # Standard validation for nested format
        if "layers" not in result:
            result["layers"] = []

        if "total_layers" not in result:
            result["total_layers"] = len(result["layers"])

        # Ensure all layers have required fields
        for layer in result.get("layers", []):
            if "layer_number" not in layer:
                layer["layer_number"] = 1
            if "elements" not in layer:
                layer["elements"] = []

            # Validate elements
            valid_elements = []
            for elem in layer.get("elements", []):
                if self._is_valid_element(elem):
                    valid_elements.append(elem)
            layer["elements"] = valid_elements

        # Sort layers by layer_number
        result["layers"] = sorted(
            result["layers"],
            key=lambda x: x.get("layer_number", 0)
        )

        return result

    def _validate_detections(
        self,
        result: Dict[str, Any],
        expected_names: List[str]
    ) -> Dict[str, Any]:
        """Validate detection results."""
        if "detections" not in result:
            result["detections"] = []

        valid_detections = []
        for det in result.get("detections", []):
            if self._is_valid_detection(det):
                valid_detections.append(det)

        result["detections"] = valid_detections
        return result

    def _is_valid_element(self, elem: Dict[str, Any]) -> bool:
        """Check if element has valid structure."""
        required = ["name", "box_2d"]
        if not all(k in elem for k in required):
            return False

        # Validate bounding box
        box = elem.get("box_2d", [])
        if not isinstance(box, list) or len(box) != 4:
            return False

        # Validate coordinates are in range
        try:
            coords = [float(c) for c in box]
            if not all(0 <= c <= 1000 for c in coords):
                return False
        except (TypeError, ValueError):
            return False

        # Validate confidence if present
        conf = elem.get("confidence", 1.0)
        if not isinstance(conf, (int, float)) or conf < 0.5:
            return False

        return True

    def _is_valid_detection(self, det: Dict[str, Any]) -> bool:
        """Check if detection has valid structure."""
        return self._is_valid_element(det)

    def convert_box_to_pixels(
        self,
        box_2d: List[int],
        image_width: int,
        image_height: int
    ) -> Dict[str, int]:
        """Convert normalized box_2d to pixel coordinates.

        Args:
            box_2d: [y_min, x_min, y_max, x_max] normalized 0-1000
            image_width: Image width in pixels
            image_height: Image height in pixels

        Returns:
            {
                "x": int,
                "y": int,
                "width": int,
                "height": int
            }
        """
        y_min, x_min, y_max, x_max = box_2d

        x = int(x_min * image_width / 1000)
        y = int(y_min * image_height / 1000)
        width = int((x_max - x_min) * image_width / 1000)
        height = int((y_max - y_min) * image_height / 1000)

        return {
            "x": x,
            "y": y,
            "width": width,
            "height": height
        }


# Singleton instance
_analyzer: Optional[ImageAnalyzer] = None


def get_image_analyzer() -> ImageAnalyzer:
    """Get or create the ImageAnalyzer singleton."""
    global _analyzer
    if _analyzer is None:
        _analyzer = ImageAnalyzer()
    return _analyzer
