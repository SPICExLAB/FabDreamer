"""
Inpainting Service

Handles object removal and background filling.
Replaces Stability AI erase endpoint.
"""

import logging
import io
from typing import Optional
from PIL import Image
import numpy as np

from .gemini_client import get_gemini_client

logger = logging.getLogger(__name__)


class InpaintingService:
    """Handles image inpainting using Gemini API."""

    def __init__(self):
        self.client = get_gemini_client()

    async def remove_object(
        self,
        image_data: bytes,
        mask_data: bytes,
        is_redo: bool = False,
        prompt: str = None,
        original_image: bytes = None
    ) -> Optional[bytes]:
        """Remove masked area from image and fill with background.

        This replaces the Stability AI erase endpoint.
        Uses mask-preserving composite to ensure non-masked areas are unchanged.

        Args:
            image_data: Original image bytes
            mask_data: Mask PNG bytes (white = area to remove)
            is_redo: If True, use REDO_INPAINTING_PROMPT for extra careful inpainting
            prompt: Custom inpainting prompt (optional)
            original_image: Original untouched image for scene reference (optional)

        Returns:
            Inpainted image bytes with object removed
            Returns original image if inpainting fails
        """
        redo_label = " (REDO)" if is_redo else ""
        logger.info(f"Removing object via inpainting{redo_label}")

        inpaint_prompt = prompt or "Remove the masked object and fill naturally with the surrounding background. Make it seamless."

        result = await self.client.inpaint_image(
            image_data=image_data,
            mask_data=mask_data,
            prompt=inpaint_prompt,
            is_redo=is_redo,
            original_image=original_image
        )

        if result is None:
            logger.warning("Inpainting failed, returning original image")
            return image_data

        # Validate result is a valid image
        try:
            inpainted_img = Image.open(io.BytesIO(result))
            logger.info("Inpainting returned valid image")

            # CRITICAL: Composite to preserve non-masked areas exactly
            # Gemini's inpainting can modify pixels outside the mask
            composited = self._composite_with_mask(
                original_data=image_data,
                inpainted_img=inpainted_img,
                mask_data=mask_data
            )

            logger.info("Inpainting successful with mask-preserving composite")
            return composited

        except Exception as e:
            logger.error(f"Invalid inpainting result: {e}")
            return image_data

    def _composite_with_mask(
        self,
        original_data: bytes,
        inpainted_img: Image.Image,
        mask_data: bytes
    ) -> bytes:
        """Composite inpainted image with original using mask.

        Ensures pixels outside the mask are preserved exactly from original.
        Only masked (white) areas use the inpainted pixels.

        Args:
            original_data: Original image bytes
            inpainted_img: Inpainted PIL Image
            mask_data: Mask PNG bytes (white = inpainted area)

        Returns:
            Composited image bytes
        """
        # Load original and mask
        original = Image.open(io.BytesIO(original_data)).convert('RGBA')
        mask = Image.open(io.BytesIO(mask_data)).convert('L')

        # Ensure inpainted image is same size as original
        if inpainted_img.size != original.size:
            inpainted_img = inpainted_img.resize(original.size, Image.Resampling.LANCZOS)
        inpainted = inpainted_img.convert('RGBA')

        # Ensure mask is same size
        if mask.size != original.size:
            mask = mask.resize(original.size, Image.Resampling.LANCZOS)

        # Create slightly dilated mask for smoother blending at edges
        mask_array = np.array(mask)

        # Normalize mask to 0-1 range
        mask_normalized = mask_array.astype(np.float32) / 255.0

        # Apply feathering at edges for smoother blend
        # Erode first so the feathered transition stays INSIDE the inpainted area,
        # preventing original outline pixels from bleeding back through the blend
        if np.any(mask_normalized > 0):
            try:
                import cv2
                # Erode mask by 3px so feathering doesn't extend into original pixels
                erode_kernel = np.ones((7, 7), np.uint8)
                mask_eroded = cv2.erode((mask_normalized * 255).astype(np.uint8), erode_kernel, iterations=1)
                mask_normalized = mask_eroded.astype(np.float32) / 255.0
                # Then blur for smooth transition (within the inpainted region)
                mask_normalized = cv2.GaussianBlur(mask_normalized, (7, 7), 0)
            except ImportError:
                pass  # Skip feathering if cv2 not available

        # Expand to RGBA
        mask_rgba = np.stack([mask_normalized] * 4, axis=-1)

        # Blend: result = original * (1 - mask) + inpainted * mask
        original_array = np.array(original).astype(np.float32)
        inpainted_array = np.array(inpainted).astype(np.float32)

        result_array = original_array * (1 - mask_rgba) + inpainted_array * mask_rgba
        result_array = np.clip(result_array, 0, 255).astype(np.uint8)

        # Convert back to bytes
        result_img = Image.fromarray(result_array, 'RGBA').convert('RGB')
        buffer = io.BytesIO()
        result_img.save(buffer, format='PNG')

        logger.debug(f"Composited image: preserved {np.sum(mask_normalized < 0.5)} pixels from original")

        return buffer.getvalue()

    async def remove_multiple_objects(
        self,
        image_data: bytes,
        masks: list[bytes]
    ) -> bytes:
        """Remove multiple objects from image sequentially.

        Args:
            image_data: Original image bytes
            masks: List of mask PNG bytes

        Returns:
            Image with all masked objects removed
        """
        current_image = image_data

        for i, mask in enumerate(masks):
            logger.info(f"Removing object {i + 1}/{len(masks)}")
            current_image = await self.remove_object(current_image, mask)

        return current_image

    async def remove_objects_combined(
        self,
        image_data: bytes,
        masks: list[bytes],
        dilate_pixels: int = 8,
        is_redo: bool = False,
        prompt: str = None,
        original_image: bytes = None
    ) -> bytes:
        """Remove multiple objects at once using combined mask.

        More efficient than sequential removal when objects don't overlap.

        Args:
            image_data: Original image bytes
            masks: List of mask PNG bytes
            dilate_pixels: Expand mask by this many pixels to catch outlines/borders
            is_redo: If True, use REDO_INPAINTING_PROMPT for extra careful inpainting
            prompt: Custom inpainting prompt (optional)
            original_image: Original untouched image for scene reference (optional)

        Returns:
            Image with all masked objects removed
        """
        if not masks:
            return image_data

        # Combine masks
        if len(masks) == 1:
            combined_mask = masks[0]
        else:
            combined_mask = self._combine_masks(masks)

        # Dilate mask to include object outlines/borders
        # This prevents leaving dark edges after inpainting
        if dilate_pixels > 0:
            logger.info(f"Dilating mask by {dilate_pixels}px to include outlines")
            combined_mask = self.dilate_mask(combined_mask, dilate_pixels)

        return await self.remove_object(image_data, combined_mask, is_redo=is_redo, prompt=prompt, original_image=original_image)

    def _combine_masks(self, masks: list[bytes]) -> bytes:
        """Combine multiple masks into one (union)."""
        if not masks:
            raise ValueError("No masks provided")

        # Load first mask as base
        combined = np.array(Image.open(io.BytesIO(masks[0])).convert('L'))

        # Union with remaining masks
        for mask_bytes in masks[1:]:
            mask = np.array(Image.open(io.BytesIO(mask_bytes)).convert('L'))
            if mask.shape == combined.shape:
                combined = np.maximum(combined, mask)
            else:
                # Resize if needed
                mask_img = Image.open(io.BytesIO(mask_bytes)).convert('L')
                mask_img = mask_img.resize(
                    (combined.shape[1], combined.shape[0]),
                    Image.Resampling.LANCZOS
                )
                combined = np.maximum(combined, np.array(mask_img))

        # Convert back to bytes
        result_image = Image.fromarray(combined)
        buffer = io.BytesIO()
        result_image.save(buffer, format='PNG')
        return buffer.getvalue()

    def dilate_mask(self, mask_data: bytes, pixels: int = 5) -> bytes:
        """Dilate mask to ensure complete coverage.

        Useful when object edges need extra margin for clean removal.

        Args:
            mask_data: Mask PNG bytes
            pixels: Dilation amount in pixels

        Returns:
            Dilated mask PNG bytes
        """
        try:
            import cv2

            mask = np.array(Image.open(io.BytesIO(mask_data)).convert('L'))
            kernel = np.ones((pixels * 2 + 1, pixels * 2 + 1), np.uint8)
            dilated = cv2.dilate(mask, kernel, iterations=1)

            result = Image.fromarray(dilated)
            buffer = io.BytesIO()
            result.save(buffer, format='PNG')
            return buffer.getvalue()
        except ImportError:
            logger.warning("OpenCV not available, returning original mask")
            return mask_data
        except Exception as e:
            logger.error(f"Error dilating mask: {e}")
            return mask_data


# Singleton instance
_service: Optional[InpaintingService] = None


def get_inpainting_service() -> InpaintingService:
    """Get or create the InpaintingService singleton."""
    global _service
    if _service is None:
        _service = InpaintingService()
    return _service
