"""
Image Generation Service

Handles text-to-image generation using Gemini Imagen 3.
Replaces FLUX.1 local processing.
"""

import logging
import io
from typing import Optional, List
from PIL import Image

from .gemini_client import get_gemini_client

logger = logging.getLogger(__name__)


class ImageGenerationService:
    """Generates images from text prompts using Gemini Imagen 3."""

    def __init__(self):
        self.client = get_gemini_client()

    async def generate(self, prompt: str) -> Optional[bytes]:
        """Generate an image from a text prompt.

        Args:
            prompt: Text description of the image to generate

        Returns:
            PNG image bytes, or None if generation fails
        """
        logger.info(f"Generating image for prompt: {prompt[:50]}...")

        # Augment prompt for laser-cut friendly output
        augmented_prompt = self._augment_prompt(prompt)

        result = await self.client.generate_image(augmented_prompt)

        if result is None:
            logger.error("Image generation failed")
            return None

        # Validate result is a valid image
        try:
            img = Image.open(io.BytesIO(result))
            logger.info(f"Generated image: {img.size[0]}x{img.size[1]}")

            # Ensure PNG format
            if img.format != 'PNG':
                buffer = io.BytesIO()
                img.save(buffer, format='PNG')
                return buffer.getvalue()

            return result
        except Exception as e:
            logger.error(f"Invalid generated image: {e}")
            return None

    def _augment_prompt(self, prompt: str) -> str:
        """Augment user prompt for laser-cut friendly images.

        Adds instructions for clearer segmentation.
        """
        augmentation = (
            "Create an image with clearly defined, easily separable elements. "
            "Use high contrast between objects. "
            "Each element should have clean, distinct boundaries. "
            "Avoid complex overlapping or blending between elements. "
            "Style: suitable for layered paper cut or laser cut art. "
        )

        return f"{augmentation}\n\nScene description: {prompt}"

    async def generate_multiple(self, prompt: str, count: int = 3) -> List[bytes]:
        """Generate multiple images from a text prompt.

        Args:
            prompt: Text description of the image to generate
            count: Number of images to generate (default 3)

        Returns:
            List of PNG image bytes
        """
        logger.info(f"Generating {count} images for prompt: {prompt[:50]}...")

        augmented_prompt = self._augment_prompt(prompt)
        logger.info("Starting parallel image generation...")
        results = await self.client.generate_images(augmented_prompt, count)
        logger.info(f"Received {len(results)} images from Gemini")

        # Validate and convert each image
        valid_images = []
        for i, result in enumerate(results):
            try:
                img = Image.open(io.BytesIO(result))
                logger.info(f"Generated image {i+1}: {img.size[0]}x{img.size[1]}")

                # Ensure PNG format
                if img.format != 'PNG':
                    buffer = io.BytesIO()
                    img.save(buffer, format='PNG')
                    valid_images.append(buffer.getvalue())
                else:
                    valid_images.append(result)
            except Exception as e:
                logger.error(f"Invalid generated image {i+1}: {e}")

        return valid_images

    async def generate_for_fabrication(
        self,
        prompt: str,
        num_layers: int = 3
    ) -> Optional[bytes]:
        """Generate image optimized for multi-layer fabrication.

        Args:
            prompt: Text description
            num_layers: Suggested number of layers (used in prompt)

        Returns:
            PNG image bytes
        """
        layer_prompt = (
            f"Create an image that can be separated into {num_layers} distinct depth layers. "
            f"Layer 1 (front): main foreground elements. "
            f"Layer {num_layers} (back): background elements. "
            f"Each layer should have clear boundaries suitable for cutting. "
        )

        full_prompt = f"{layer_prompt}\n\nScene: {prompt}"

        return await self.generate(full_prompt)


# Singleton instance
_service: Optional[ImageGenerationService] = None


def get_image_generation_service() -> ImageGenerationService:
    """Get or create the ImageGenerationService singleton."""
    global _service
    if _service is None:
        _service = ImageGenerationService()
    return _service
