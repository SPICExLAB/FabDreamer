"""
Gemini API Client Wrapper

Handles all interactions with Google's Gemini API.
"""

import os
import base64
import json
import re
import logging
from typing import Optional, Dict, Any, List
from google import genai
from google.genai import types
from PIL import Image
import io

from prompts.prompts import INPAINTING_PROMPT, REDO_INPAINTING_PROMPT
from config.models import IMAGE_PRIMARY, IMAGE_FALLBACK, TEXT_FAST

logger = logging.getLogger(__name__)


class GeminiClient:
    """Wrapper for Gemini API interactions."""

    def __init__(self, api_key: Optional[str] = None):
        """Initialize the Gemini client.

        Args:
            api_key: Gemini API key. If not provided, reads from GEMINI_API_KEY env var.
        """
        self.api_key = api_key or os.getenv("GEMINI_API_KEY")
        if not self.api_key:
            raise ValueError("GEMINI_API_KEY not found in environment variables")

        # Initialize the client
        self.client = genai.Client(api_key=self.api_key)

        # Model configurations (from config/models.py)
        self.vision_model = TEXT_FAST
        self.segmentation_model = IMAGE_FALLBACK
        self.image_model = IMAGE_FALLBACK
        self.inpaint_model = IMAGE_PRIMARY

    async def analyze_image(self, image_data: bytes, prompt: str) -> Dict[str, Any]:
        """Send image to Gemini for analysis.

        Args:
            image_data: Raw image bytes
            prompt: Analysis prompt

        Returns:
            Parsed JSON response from Gemini
        """
        # Convert bytes to base64
        base64_image = base64.b64encode(image_data).decode('utf-8')

        # Determine mime type (assume PNG for now, could be improved)
        mime_type = "image/png"
        if image_data[:3] == b'\xff\xd8\xff':
            mime_type = "image/jpeg"

        # Create the content
        # Based on Google's official spatial-understanding demo:
        # 1. Disable thinking for spatial understanding tasks
        # 2. Use temperature=0 for deterministic results
        response = self.client.models.generate_content(
            model=self.vision_model,
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
                temperature=0,  # Zero temperature for deterministic spatial precision
                max_output_tokens=8192,
                thinking_config=types.ThinkingConfig(thinking_budget=0),  # Disable thinking for spatial tasks
            )
        )

        # Extract and parse JSON from response
        response_text = response.text
        return self._parse_json_response(response_text)

    async def analyze_image_with_mask(
        self,
        image_data: bytes,
        mask_data: bytes,
        prompt: str
    ) -> Dict[str, Any]:
        """Send image and mask to Gemini for analysis.

        Args:
            image_data: Raw image bytes
            mask_data: Raw mask image bytes
            prompt: Analysis prompt

        Returns:
            Parsed JSON response from Gemini
        """
        response = self.client.models.generate_content(
            model=self.vision_model,
            contents=[
                types.Content(
                    role="user",
                    parts=[
                        types.Part.from_text(text=prompt),
                        types.Part.from_text(text="Main image:"),
                        types.Part.from_bytes(data=image_data, mime_type="image/png"),
                        types.Part.from_text(text="Mask (white = area to process):"),
                        types.Part.from_bytes(data=mask_data, mime_type="image/png"),
                    ]
                )
            ],
            config=types.GenerateContentConfig(
                temperature=0.1,
                max_output_tokens=4096,
            )
        )

        return self._parse_json_response(response.text)

    async def segment_with_native_masks(
        self,
        image_data: bytes,
        prompt: str
    ) -> Dict[str, Any]:
        """Use Gemini 2.5 Flash Image for native segmentation with masks.

        This model supports Zero-Shot Instance Segmentation and returns
        mask data directly in the JSON response.

        Args:
            image_data: Raw image bytes
            prompt: Segmentation prompt

        Returns:
            Dict with objects array containing box_2d and mask fields
        """
        mime_type = "image/png"
        if image_data[:3] == b'\xff\xd8\xff':
            mime_type = "image/jpeg"

        response = self.client.models.generate_content(
            model=self.segmentation_model,
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
                temperature=0.1,
                max_output_tokens=16384,  # Larger for mask data
            )
        )

        return self._parse_json_response(response.text)

    async def segment_single_object(
        self,
        image_data: bytes,
        element_name: str,
        bounding_box: List[int]
    ) -> Dict[str, Any]:
        """Segment a single object using Gemini 2.5 Flash Image.

        Args:
            image_data: Raw image bytes
            element_name: Name of element to segment
            bounding_box: [y_min, x_min, y_max, x_max] normalized 0-1000

        Returns:
            Dict with name, box_2d, and mask (base64 encoded)
        """
        from prompts.prompts import SINGLE_OBJECT_SEGMENTATION_PROMPT

        prompt = SINGLE_OBJECT_SEGMENTATION_PROMPT.format(
            element_name=element_name,
            bounding_box=bounding_box
        )

        return await self.segment_with_native_masks(image_data, prompt)

    async def generate_segmentation_mask(
        self,
        image_data: bytes,
        element_name: str,
        bounding_box: List[int]
    ) -> Optional[bytes]:
        """Generate a segmentation mask for an element.

        Uses Gemini 2.5 Flash Image with response_modalities=["IMAGE", "TEXT"]
        to get the mask as a direct image output (not base64 in JSON).

        Args:
            image_data: Raw image bytes
            element_name: Name of element to segment
            bounding_box: [y_min, x_min, y_max, x_max] normalized 0-1000

        Returns:
            PNG mask bytes (white = element, black = background)
        """
        mime_type = "image/png"
        if image_data[:3] == b'\xff\xd8\xff':
            mime_type = "image/jpeg"

        # Create a prompt that asks for mask as image output
        # Be VERY explicit that we want a filled silhouette, not a line drawing
        prompt = f"""Create a FILLED SILHOUETTE mask for the "{element_name}" object in this image.

Location hint: bounding box {bounding_box} (format: [y_min, x_min, y_max, x_max], normalized 0-1000).

CRITICAL REQUIREMENTS:
1. Output a SOLID FILLED shape - NOT a line drawing or outline
2. The "{element_name}" region must be COMPLETELY FILLED with solid white (RGB 255,255,255)
3. ALL other areas must be COMPLETELY FILLED with solid black (RGB 0,0,0)
4. NO outlines, NO sketches, NO gradients - just two flat colors
5. The white area should be the EXACT SHAPE of the {element_name}, filled solid

Think of it like a shadow or silhouette - the object casts a pure white shadow on a black background.

Output dimensions should match the input image."""

        try:
            response = self.client.models.generate_content(
                model=self.segmentation_model,  # gemini-2.5-flash-image
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_text(text=prompt),
                            types.Part.from_bytes(data=image_data, mime_type=mime_type),
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE", "TEXT"],
                )
            )

            # Extract image from response parts
            if response.candidates and response.candidates[0].content.parts:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'inline_data') and part.inline_data:
                        logger.info(f"Got mask image for {element_name}")
                        return part.inline_data.data

            logger.warning(f"No mask image in response for {element_name}")

        except Exception as e:
            logger.warning(f"Mask generation failed for {element_name}: {e}")

        # Return None to trigger bounding box fallback in caller
        return None

    async def inpaint_image(
        self,
        image_data: bytes,
        mask_data: bytes,
        prompt: str = "Fill the masked area naturally with the surrounding background",
        is_redo: bool = False,
        original_image: bytes = None
    ) -> Optional[bytes]:
        """Remove/inpaint masked area in image.

        Uses Gemini 3 Pro Image Preview for object removal and inpainting.
        Falls back to gemini-2.5-flash-image, then to original image.

        Args:
            image_data: Raw image bytes (may have previous layers already inpainted)
            mask_data: Mask bytes (white = area to inpaint)
            prompt: Inpainting instruction
            is_redo: If True, use REDO_INPAINTING_PROMPT for extra careful inpainting
            original_image: Original untouched image bytes (before any inpainting).
                           Provided as scene reference so the model understands the full context.

        Returns:
            Inpainted image bytes (or original if inpainting not available)
        """
        import logging
        logger = logging.getLogger(__name__)

        # Try gemini-3.1-flash-image-preview first (better inpainting quality)
        try:
            # Use caller-provided prompt if available, otherwise centralized defaults
            if prompt and prompt != "Fill the masked area naturally with the surrounding background":
                inpaint_prompt = prompt
                logger.info("Using caller-provided inpainting prompt")
            elif is_redo:
                logger.info("Using REDO_INPAINTING_PROMPT for extra careful inpainting")
                inpaint_prompt = REDO_INPAINTING_PROMPT
            else:
                inpaint_prompt = INPAINTING_PROMPT

            # Build parts: prompt + image to edit + mask + optional original reference
            parts = [
                types.Part.from_text(text=inpaint_prompt),
            ]

            # Include original scene reference if available (helps model understand full context)
            if original_image and original_image != image_data:
                logger.info("Including original scene reference for context-aware inpainting")
                parts.append(types.Part.from_text(text="Reference (original scene before any elements were removed):"))
                parts.append(types.Part.from_bytes(data=original_image, mime_type="image/png"))

            parts.extend([
                types.Part.from_text(text="Image to edit (fill the masked area in THIS image):"),
                types.Part.from_bytes(data=image_data, mime_type="image/png"),
                types.Part.from_text(text="Mask (white = area to fill):"),
                types.Part.from_bytes(data=mask_data, mime_type="image/png"),
            ])

            response = self.client.models.generate_content(
                model=self.inpaint_model,  # gemini-3.1-flash-image-preview
                contents=[
                    types.Content(
                        role="user",
                        parts=parts,
                    )
                ],
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE", "TEXT"],
                )
            )

            # Extract image from response
            if response.candidates and response.candidates[0].content.parts:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'inline_data') and part.inline_data:
                        logger.info("Inpainting successful with gemini-3.1-flash-image-preview")
                        return part.inline_data.data

        except Exception as e:
            logger.warning(f"gemini-3.1-flash-image-preview inpainting failed: {e}")

        # Fallback to gemini-2.5-flash-image
        try:
            full_prompt = (
                "ERASE the white masked area. Fill with plain background only. "
                "DO NOT add any objects or shapes. Just background texture."
            )

            response = self.client.models.generate_content(
                model=self.segmentation_model,  # gemini-2.5-flash-image (fallback)
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_text(text=full_prompt),
                            types.Part.from_bytes(data=image_data, mime_type="image/png"),
                            types.Part.from_bytes(data=mask_data, mime_type="image/png"),
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE", "TEXT"],
                )
            )

            # Extract image from response
            if response.candidates and response.candidates[0].content.parts:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'inline_data') and part.inline_data:
                        logger.info("Inpainting successful with gemini-2.5-flash-image (fallback)")
                        return part.inline_data.data

            # If no image in response, try to extract from text
            if response.text:
                extracted = self._extract_base64_image(response.text)
                if extracted:
                    return extracted

        except Exception as e:
            logger.warning(f"gemini-2.5-flash-image fallback inpainting failed: {e}")

        # Final fallback: return original image (no inpainting available)
        # This allows the pipeline to continue even without inpainting
        logger.warning("All inpainting methods failed, returning original image")
        return image_data

    async def generate_image(self, prompt: str) -> Optional[bytes]:
        """Generate image from text prompt using Gemini 3 Pro.

        Uses Gemini 3 Pro with thinking mode for paper cut-out style images
        optimized for laser cutting.

        Args:
            prompt: Text description of image to generate

        Returns:
            Generated image bytes
        """
        from prompts.prompts import IMAGE_GENERATION_PROMPT

        full_prompt = IMAGE_GENERATION_PROMPT.format(prompt=prompt)

        try:
            # Gemini 3 Image config: no thinking_config, no media_resolution
            # Gemini 3 Pro Image config
            response = self.client.models.generate_content(
                model=IMAGE_PRIMARY,
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_text(text=full_prompt),
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    temperature=1.0,
                    max_output_tokens=8192,
                    response_modalities=["IMAGE", "TEXT"],
                    image_config=types.ImageConfig(
                        aspect_ratio="1:1"
                    )
                )
            )

            # Extract image from response parts with debug logging
            if response.candidates and len(response.candidates) > 0:
                candidate = response.candidates[0]
                if candidate.content and candidate.content.parts:
                    part_types = []
                    for part in candidate.content.parts:
                        if part.inline_data is not None:
                            part_types.append(f"inline_data({part.inline_data.mime_type if hasattr(part.inline_data, 'mime_type') else 'unknown'})")
                            logger.info(f"Gemini 3 Pro Image response parts: {part_types}")
                            logger.info("Image generated successfully with gemini-3.1-flash-image-preview")
                            return part.inline_data.data
                        elif hasattr(part, 'text') and part.text:
                            part_types.append(f"text({len(part.text)} chars)")
                        elif hasattr(part, 'thought') and part.thought:
                            part_types.append("thought")
                    logger.warning(f"Gemini 3 Pro Image response parts (no image): {part_types}")
                else:
                    logger.warning("Gemini 3 Pro Image: no content.parts")
            else:
                logger.warning("Gemini 3 Pro Image: no candidates")

            logger.warning("No image found in Gemini 3 Pro Image response, trying fallback")
        except Exception as e:
            logger.warning(f"Gemini 3 Pro Image generation failed: {e}, trying fallback")

        # Fallback to gemini-2.5-flash-image
        try:
            response = self.client.models.generate_content(
                model=IMAGE_FALLBACK,
                contents=[full_prompt],
            )

            for part in response.parts:
                if part.inline_data is not None:
                    logger.info("Image generated with gemini-2.5-flash-image fallback")
                    return part.inline_data.data
        except Exception as e:
            logger.error(f"Fallback image generation also failed: {e}")

        return None

    async def update_image(
        self,
        image_data: bytes,
        original_prompt: str,
        update_prompt: str,
        update_history: list = None,
        is_uploaded: bool = False
    ) -> Optional[bytes]:
        """Update an existing image with multi-turn editing.

        Args:
            image_data: Current image bytes
            original_prompt: Original generation prompt
            update_prompt: User's requested change
            update_history: List of previous update prompts for context
            is_uploaded: Whether this is an uploaded (not AI-generated) image

        Returns:
            Updated image bytes, or None if update fails
        """
        mime_type = "image/png"
        if image_data[:3] == b'\xff\xd8\xff':
            mime_type = "image/jpeg"

        # Build context from history
        history_context = ""
        if update_history and len(update_history) > 0:
            history_context = "\n\nPrevious edits applied to this image:\n"
            for i, edit in enumerate(update_history, 1):
                history_context += f"{i}. {edit}\n"

        if is_uploaded:
            update_full_prompt = f"""This is a cartoon illustration of a scene.
{history_context}
Apply this change to the image: {update_prompt}

IMPORTANT:
- Keep the same overall composition and cartoon illustration style
- Only make the specific change requested
- Maintain solid colors, high contrast, and clear boundaries between objects
- Do not add outlines or drop shadows
"""
        else:
            update_full_prompt = f"""This image was originally created with the prompt: "{original_prompt}"
{history_context}
Now apply this change to the image: {update_prompt}

IMPORTANT:
- Keep the same overall composition and style
- Only make the specific change requested
- Maintain flat colors and clear boundaries
- The result should still be suitable for laser cutting
"""

        try:
            # Gemini 3 Image config: no thinking_config, no media_resolution
            # Gemini 3 Pro Image config
            response = self.client.models.generate_content(
                model=IMAGE_PRIMARY,
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_bytes(data=image_data, mime_type=mime_type),
                            types.Part.from_text(text=update_full_prompt),
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    temperature=0.1,
                    response_modalities=["IMAGE", "TEXT"],
                )
            )

            # Extract image from response
            if response.candidates and len(response.candidates) > 0:
                candidate = response.candidates[0]
                if candidate.content and candidate.content.parts:
                    for part in candidate.content.parts:
                        if part.inline_data is not None:
                            logger.info("Image updated successfully with gemini-3.1-flash-image-preview")
                            return part.inline_data.data

            logger.warning("No image in Gemini 3 update response, trying fallback")
        except Exception as e:
            logger.warning(f"Gemini 3 image update failed: {e}, trying fallback")

        # Fallback to gemini-2.5-flash-image
        try:
            response = self.client.models.generate_content(
                model=IMAGE_FALLBACK,
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_bytes(data=image_data, mime_type=mime_type),
                            types.Part.from_text(text=update_full_prompt),
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE", "TEXT"],
                )
            )

            if response.candidates and len(response.candidates) > 0:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'inline_data') and part.inline_data:
                        logger.info("Image updated with gemini-2.5-flash-image fallback")
                        return part.inline_data.data
        except Exception as e:
            logger.error(f"Fallback image update also failed: {e}")

        return None

    async def stylize_for_laser_cut(self, image_data: bytes) -> Optional[bytes]:
        """Transform photo into laser-cut friendly illustration style.

        Uses Gemini 3 Pro with thinking mode for sophisticated style transfer
        (Nano Banana Pro visual engine).

        Args:
            image_data: Raw image bytes (photo to stylize)

        Returns:
            Stylized image bytes, or None if stylization fails
        """
        from prompts.prompts import STYLIZE_FOR_LASER_CUT_PROMPT

        mime_type = "image/png"
        if image_data[:3] == b'\xff\xd8\xff':
            mime_type = "image/jpeg"

        try:
            # Use Gemini 3.1 Flash Image for best style transfer
            response = self.client.models.generate_content(
                model=IMAGE_PRIMARY,
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_text(text=STYLIZE_FOR_LASER_CUT_PROMPT),
                            types.Part.from_bytes(data=image_data, mime_type=mime_type),
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE", "TEXT"],
                )
            )

            # Extract image from response
            if response.candidates and response.candidates[0].content.parts:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'inline_data') and part.inline_data:
                        logger.info("Stylization successful with gemini-3.1-flash-image-preview")
                        return part.inline_data.data

            logger.warning("No image in stylization response, trying fallback...")

        except Exception as e:
            logger.warning(f"gemini-3.1-flash-image-preview stylization failed: {e}, trying fallback...")

        # Fallback to gemini-2.5-flash-image
        try:
            response = self.client.models.generate_content(
                model=IMAGE_FALLBACK,
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_text(text=STYLIZE_FOR_LASER_CUT_PROMPT),
                            types.Part.from_bytes(data=image_data, mime_type=mime_type),
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE", "TEXT"],
                )
            )

            if response.candidates and response.candidates[0].content.parts:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'inline_data') and part.inline_data:
                        logger.info("Stylization successful with gemini-2.5-flash-image fallback")
                        return part.inline_data.data

        except Exception as e:
            logger.error(f"Fallback stylization also failed: {e}")

        return None

    async def generate_images(self, prompt: str, count: int = 3) -> List[bytes]:
        """Generate multiple images from text prompt using Gemini 3 Pro.

        Generates images sequentially to avoid threading issues with the API client.
        Uses Gemini 3 Pro with thinking mode for paper cut-out style.

        Args:
            prompt: Text description of image to generate
            count: Number of images to generate

        Returns:
            List of generated image bytes
        """
        from prompts.prompts import IMAGE_GENERATION_PROMPT

        full_prompt = IMAGE_GENERATION_PROMPT.format(prompt=prompt)
        images = []

        for i in range(count):
            logger.info(f"Generating image {i+1} of {count}...")
            image_data = None

            # Try Gemini 3 Pro Image first
            # Config: no thinking_config, no media_resolution for image generation
            try:
                response = self.client.models.generate_content(
                    model=IMAGE_PRIMARY,
                    contents=[
                        types.Content(
                            role="user",
                            parts=[
                                types.Part.from_text(text=full_prompt),
                            ]
                        )
                    ],
                    config=types.GenerateContentConfig(
                        temperature=1.0,
                        max_output_tokens=8192,
                        response_modalities=["IMAGE", "TEXT"],
                        image_config=types.ImageConfig(
                            aspect_ratio="1:1"
                        )
                    )
                )

                # Debug: log response structure
                if response.candidates and len(response.candidates) > 0:
                    candidate = response.candidates[0]
                    if candidate.content and candidate.content.parts:
                        part_types = []
                        for part in candidate.content.parts:
                            if part.inline_data is not None:
                                part_types.append(f"inline_data({part.inline_data.mime_type if hasattr(part.inline_data, 'mime_type') else 'unknown'})")
                                image_data = part.inline_data.data
                            elif hasattr(part, 'text') and part.text:
                                part_types.append(f"text({len(part.text)} chars)")
                            elif hasattr(part, 'thought') and part.thought:
                                part_types.append("thought")
                            else:
                                part_types.append("unknown")
                        logger.info(f"Image {i+1} Gemini 3 Pro Image response parts: {part_types}")
                        if image_data:
                            logger.info(f"Image {i+1} generated with gemini-3.1-flash-image-preview")
                    else:
                        logger.warning(f"Image {i+1} Gemini 3 Pro Image: no content.parts")
                else:
                    logger.warning(f"Image {i+1} Gemini 3 Pro Image: no candidates")

            except Exception as e:
                logger.warning(f"Image {i+1} Gemini 3 Pro Image failed: {e}, trying fallback")

            # Fallback to gemini-2.5-flash-image
            if not image_data:
                try:
                    response = self.client.models.generate_content(
                        model=IMAGE_FALLBACK,
                        contents=[full_prompt],
                    )

                    if hasattr(response, 'parts') and response.parts:
                        for part in response.parts:
                            if hasattr(part, 'inline_data') and part.inline_data is not None:
                                image_data = part.inline_data.data
                                logger.info(f"Image {i+1} generated with fallback")
                                break

                except Exception as e:
                    logger.error(f"Image {i+1} fallback also failed: {e}")

            if image_data:
                images.append(image_data)
            else:
                logger.warning(f"Image {i+1}: No image data from any model")

        logger.info(f"Generated {len(images)} of {count} images total")
        return images

    def _parse_json_response(self, text: str) -> Dict[str, Any]:
        """Parse JSON from Gemini response text.

        Handles markdown code blocks and raw JSON.
        """
        if not text or not text.strip():
            return {"error": "Empty response text"}

        # Log raw response for debugging
        logger.debug(f"Raw Gemini response (first 500 chars): {text[:500]}")

        # Remove markdown code blocks if present
        text = re.sub(r'```json\s*\n?', '', text)
        text = re.sub(r'```\s*', '', text)  # Also remove trailing ``` without newline
        text = text.strip()

        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            # Try to find JSON object in text - use a more careful approach
            # Find the first { and try to match the corresponding }
            start_idx = text.find('{')
            if start_idx != -1:
                depth = 0
                end_idx = start_idx
                in_string = False
                escape_next = False

                for i, char in enumerate(text[start_idx:], start_idx):
                    if escape_next:
                        escape_next = False
                        continue
                    if char == '\\':
                        escape_next = True
                        continue
                    if char == '"' and not escape_next:
                        in_string = not in_string
                    if not in_string:
                        if char == '{':
                            depth += 1
                        elif char == '}':
                            depth -= 1
                            if depth == 0:
                                end_idx = i
                                break

                if depth == 0 and end_idx > start_idx:
                    json_str = text[start_idx:end_idx + 1]
                    try:
                        return json.loads(json_str)
                    except json.JSONDecodeError:
                        pass

            # Log the raw text for debugging
            logger.warning(f"Failed to parse JSON. Text length: {len(text)}. First 1000 chars: {text[:1000]}")
            logger.warning(f"Last 200 chars: {text[-200:] if len(text) > 200 else text}")

            # Return error structure
            return {
                "error": "Failed to parse JSON response",
                "raw_text": text[:500],
                "parse_error": str(e)
            }

    def _extract_base64_image(self, text: str) -> Optional[bytes]:
        """Extract base64-encoded image from text response."""
        # Look for base64 image data
        patterns = [
            r'data:image/png;base64,([A-Za-z0-9+/=]+)',
            r'data:image/jpeg;base64,([A-Za-z0-9+/=]+)',
            r'"mask_base64":\s*"([A-Za-z0-9+/=]+)"',
            r'"image_base64":\s*"([A-Za-z0-9+/=]+)"',
        ]

        for pattern in patterns:
            match = re.search(pattern, text)
            if match:
                try:
                    return base64.b64decode(match.group(1))
                except Exception:
                    continue

        return None


# Singleton instance
_client: Optional[GeminiClient] = None


def get_gemini_client() -> GeminiClient:
    """Get or create the Gemini client singleton."""
    global _client
    if _client is None:
        _client = GeminiClient()
    return _client
