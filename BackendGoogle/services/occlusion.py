"""
Occlusion Service

Handles detection and completion of occluded objects for amodal segmentation.
Enables grabbing objects that are partially hidden behind other elements.
"""

import logging
import io
import json
import re
from typing import Optional, List, Dict, Any, Tuple
from dataclasses import dataclass
from PIL import Image
import numpy as np

from google import genai
from google.genai import types

from prompts.prompts import (
    OCCLUSION_CHECKER_PROMPT,
    OCCLUSION_CHECK_SIMPLE_PROMPT,
    OCCLUSION_COMPLETION_PROMPT,
)
from config.models import IMAGE_PRIMARY, VISION_PRIMARY

logger = logging.getLogger(__name__)


@dataclass
class OcclusionResult:
    """Result from occlusion check."""
    is_occluded: bool
    confidence: float
    occluder_name: Optional[str] = None
    missing_parts: Optional[str] = None
    amodal_box_2d: Optional[List[int]] = None
    # Additional fields for simple check (before detection)
    found: bool = True  # Whether object was found at all
    object_name: Optional[str] = None  # Specific name of found object
    visible_box_2d: Optional[List[int]] = None  # Box of visible portion


class OcclusionService:
    """Handles occlusion detection and object completion for grab operations."""

    def __init__(self, api_key: str):
        self.client = genai.Client(api_key=api_key)
        self.checker_model = VISION_PRIMARY
        self.completion_model = IMAGE_PRIMARY

    async def check_occlusion(
        self,
        image_data: bytes,
        object_name: str,
        box_2d: List[int]
    ) -> OcclusionResult:
        """Check if an object is partially occluded by another object.

        Args:
            image_data: Original image bytes
            object_name: Name of the target object (e.g., "duck")
            box_2d: Bounding box [y_min, x_min, y_max, x_max] normalized 0-1000

        Returns:
            OcclusionResult with occlusion details
        """
        logger.info(f"Checking occlusion for '{object_name}' at box {box_2d}")

        prompt = OCCLUSION_CHECKER_PROMPT.format(
            object_name=object_name,
            box_2d=box_2d
        )

        # Determine MIME type
        mime_type = "image/png" if image_data[:4] == b'\x89PNG' else "image/jpeg"

        try:
            response = await self.client.aio.models.generate_content(
                model=self.checker_model,
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_bytes(data=image_data, mime_type=mime_type),
                            types.Part.from_text(text=prompt),
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    temperature=0,
                    max_output_tokens=2048,  # Increased to avoid truncation
                ),
            )

            # Parse JSON response
            text = response.text.strip()
            logger.debug(f"  Occlusion check raw response: {text[:500]}")

            # Remove markdown code blocks if present
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]

            text = text.strip()

            # Try to find JSON object - find matching braces
            start_idx = text.find('{')
            if start_idx != -1:
                # Find matching closing brace
                brace_count = 0
                end_idx = start_idx
                for i, c in enumerate(text[start_idx:], start_idx):
                    if c == '{':
                        brace_count += 1
                    elif c == '}':
                        brace_count -= 1
                        if brace_count == 0:
                            end_idx = i + 1
                            break
                text = text[start_idx:end_idx]

            result = json.loads(text)

            occlusion_result = OcclusionResult(
                is_occluded=result.get("is_occluded", False),
                confidence=result.get("confidence", 0.0),
                occluder_name=result.get("occluder_name"),
                missing_parts=result.get("missing_parts"),
                amodal_box_2d=result.get("amodal_box_2d"),
            )

            if occlusion_result.is_occluded:
                logger.info(
                    f"  Occlusion detected: '{object_name}' hidden by '{occlusion_result.occluder_name}' "
                    f"(missing: {occlusion_result.missing_parts}, confidence: {occlusion_result.confidence:.2f})"
                )
            else:
                logger.info(f"  No occlusion detected for '{object_name}'")

            return occlusion_result

        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse occlusion check response: {e}")
            logger.warning(f"  Raw text was: {text[:300] if text else 'empty'}")
            return OcclusionResult(is_occluded=False, confidence=0.0)
        except Exception as e:
            logger.error(f"Occlusion check failed: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return OcclusionResult(is_occluded=False, confidence=0.0)

    async def check_occlusion_simple(
        self,
        image_data: bytes,
        object_description: str
    ) -> OcclusionResult:
        """Fast occlusion check that doesn't require a precise bounding box.

        Use this BEFORE expensive detection to determine if object completion is needed.

        Args:
            image_data: Original image bytes
            object_description: Description of target object (e.g., "the cloud", "duck in center")

        Returns:
            OcclusionResult with found, is_occluded, and box info
        """
        logger.info(f"Simple occlusion check for '{object_description}'")

        prompt = OCCLUSION_CHECK_SIMPLE_PROMPT.format(
            object_description=object_description
        )

        # Determine MIME type
        mime_type = "image/png" if image_data[:4] == b'\x89PNG' else "image/jpeg"

        try:
            response = await self.client.aio.models.generate_content(
                model=self.checker_model,
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_bytes(data=image_data, mime_type=mime_type),
                            types.Part.from_text(text=prompt),
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    temperature=0,
                    max_output_tokens=2048,
                ),
            )

            # Parse JSON response
            text = response.text.strip()
            logger.debug(f"  Simple occlusion check raw response: {text[:500]}")

            # Remove markdown code blocks if present
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]

            text = text.strip()

            # Find JSON object
            start_idx = text.find('{')
            if start_idx != -1:
                brace_count = 0
                end_idx = start_idx
                for i, c in enumerate(text[start_idx:], start_idx):
                    if c == '{':
                        brace_count += 1
                    elif c == '}':
                        brace_count -= 1
                        if brace_count == 0:
                            end_idx = i + 1
                            break
                text = text[start_idx:end_idx]

            result = json.loads(text)

            occlusion_result = OcclusionResult(
                found=result.get("found", False),
                is_occluded=result.get("is_occluded", False),
                confidence=result.get("confidence", 0.0),
                object_name=result.get("object_name"),
                occluder_name=result.get("occluder_name"),
                missing_parts=result.get("missing_parts"),
                visible_box_2d=result.get("visible_box_2d"),
                amodal_box_2d=result.get("amodal_box_2d"),
            )

            if not occlusion_result.found:
                logger.info(f"  Object '{object_description}' not found in image")
            elif occlusion_result.is_occluded:
                logger.info(
                    f"  Occlusion detected: '{occlusion_result.object_name}' hidden by "
                    f"'{occlusion_result.occluder_name}' (missing: {occlusion_result.missing_parts}, "
                    f"confidence: {occlusion_result.confidence:.2f})"
                )
            else:
                logger.info(f"  '{occlusion_result.object_name}' is fully visible")

            return occlusion_result

        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse simple occlusion check response: {e}")
            logger.warning(f"  Raw text was: {text[:300] if text else 'empty'}")
            return OcclusionResult(found=False, is_occluded=False, confidence=0.0)
        except Exception as e:
            logger.error(f"Simple occlusion check failed: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return OcclusionResult(found=False, is_occluded=False, confidence=0.0)

    async def complete_object(
        self,
        image_data: bytes,
        object_name: str,
        occluder_name: str,
        missing_parts: str,
        amodal_box_2d: Optional[List[int]] = None,
        original_box_2d: Optional[List[int]] = None
    ) -> Optional[bytes]:
        """Generate image with the occluded object fully visible.

        Uses Gemini to "bring the object to front" by revealing hidden parts.

        Args:
            image_data: Original image bytes
            object_name: Name of the target object
            occluder_name: Name of the occluding object
            missing_parts: Description of hidden parts
            amodal_box_2d: Estimated full bounding box [y_min, x_min, y_max, x_max] (0-1000)
            original_box_2d: Original visible bounding box (fallback if amodal not available)

        Returns:
            Image bytes with completed object, or None if failed
        """
        # Get original image dimensions
        original_img = Image.open(io.BytesIO(image_data))
        original_width, original_height = original_img.size

        # Use amodal box if available, otherwise fall back to original box
        # If neither available, use a default full-image box
        box = amodal_box_2d or original_box_2d or [0, 0, 1000, 1000]

        logger.info(
            f"Completing occluded object: '{object_name}' "
            f"(hidden by '{occluder_name}', missing: {missing_parts}, "
            f"original size: {original_width}x{original_height}, "
            f"amodal_box: {box})"
        )

        prompt = OCCLUSION_COMPLETION_PROMPT.format(
            object_name=object_name,
            occluder_name=occluder_name,
            missing_parts=missing_parts,
            width=original_width,
            height=original_height,
            amodal_y_min=box[0],
            amodal_x_min=box[1],
            amodal_y_max=box[2],
            amodal_x_max=box[3]
        )

        # Determine MIME type
        mime_type = "image/png" if image_data[:4] == b'\x89PNG' else "image/jpeg"

        try:
            response = await self.client.aio.models.generate_content(
                model=self.completion_model,
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_bytes(data=image_data, mime_type=mime_type),
                            types.Part.from_text(text=prompt),
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    temperature=0.3,  # Slight creativity for reconstruction
                    max_output_tokens=8192,
                    response_modalities=["IMAGE", "TEXT"],
                ),
            )

            # Extract image from response
            for part in response.candidates[0].content.parts:
                if hasattr(part, 'inline_data') and part.inline_data:
                    image_bytes = part.inline_data.data
                    # Validate it's a real image
                    img = Image.open(io.BytesIO(image_bytes))
                    logger.info(
                        f"  Generated image size: {img.size[0]}x{img.size[1]}"
                    )

                    # Check if size matches original, resize if needed
                    if img.size != (original_width, original_height):
                        logger.warning(
                            f"  Size mismatch! Generated {img.size[0]}x{img.size[1]}, "
                            f"expected {original_width}x{original_height}. Resizing..."
                        )
                        img = img.resize(
                            (original_width, original_height),
                            Image.Resampling.LANCZOS
                        )

                    # Apply magenta chroma key → transparent background
                    img = img.convert("RGBA")
                    data = np.array(img)
                    r, g, b, a = data[:, :, 0], data[:, :, 1], data[:, :, 2], data[:, :, 3]
                    magenta_mask = (r > 200) & (g < 80) & (b > 200)
                    data[magenta_mask] = [0, 0, 0, 0]
                    img = Image.fromarray(data)

                    logger.info(
                        f"  Object completion successful: {img.size[0]}x{img.size[1]} "
                        f"(magenta pixels removed: {np.sum(magenta_mask)})"
                    )
                    buf = io.BytesIO()
                    img.save(buf, format='PNG')
                    return buf.getvalue()

            logger.warning("No image in completion response")
            return None

        except Exception as e:
            logger.error(f"Object completion failed: {e}")
            return None

    async def grab_with_occlusion_handling(
        self,
        image_data: bytes,
        object_name: str,
        box_2d: List[int],
        occlusion_threshold: float = 0.7
    ) -> Tuple[bytes, bool, Optional[str]]:
        """Check for occlusion and complete if necessary.

        This is a helper that combines check + complete.

        Args:
            image_data: Original image bytes
            object_name: Name of the target object
            box_2d: Initial bounding box
            occlusion_threshold: Minimum confidence to trigger completion

        Returns:
            Tuple of (image_to_segment, was_completed, completion_note)
            - image_to_segment: Either original or completed image
            - was_completed: True if completion was performed
            - completion_note: Description of what was completed, or None
        """
        # Step 1: Check occlusion
        occlusion = await self.check_occlusion(image_data, object_name, box_2d)

        if not occlusion.is_occluded or occlusion.confidence < occlusion_threshold:
            logger.info(f"No significant occlusion for '{object_name}', using original image")
            return image_data, False, None

        # Step 2: Complete if occluded
        logger.info(f"Significant occlusion detected, completing '{object_name}'...")
        completed_image = await self.complete_object(
            image_data,
            object_name,
            occlusion.occluder_name,
            occlusion.missing_parts,
            amodal_box_2d=occlusion.amodal_box_2d,
            original_box_2d=box_2d
        )

        if completed_image:
            completion_note = f"Completed {object_name} (was hidden by {occlusion.occluder_name}, revealed {occlusion.missing_parts})"
            return completed_image, True, completion_note
        else:
            logger.warning("Completion failed, falling back to original image")
            return image_data, False, None


# Singleton instance
_occlusion_service: Optional[OcclusionService] = None


def get_occlusion_service() -> OcclusionService:
    """Get singleton OcclusionService instance."""
    global _occlusion_service
    if _occlusion_service is None:
        import os
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise ValueError("GEMINI_API_KEY environment variable not set")
        _occlusion_service = OcclusionService(api_key)
    return _occlusion_service
