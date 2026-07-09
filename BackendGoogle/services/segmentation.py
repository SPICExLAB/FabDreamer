"""
Segmentation Service

Handles mask generation for detected elements.
Uses SAM2 server for pixel-perfect masks.
Uses diff-mask method for complex objects (trees, bushes) with internal gaps.
"""

import asyncio
import logging
import io
import os
from typing import Dict, Any, List, Optional, Tuple
from PIL import Image
import numpy as np

from google import genai
from google.genai import types

from .sam2_client import get_sam2_client
from config.models import IMAGE_FALLBACK, IMAGE_PRIMARY
from prompts.prompts import (
    COMPLEX_SUB_BOX_THRESHOLD,
    ROUGH_MASK_PROMPT,
    REDO_ROUGH_MASK_PROMPT,
)

logger = logging.getLogger(__name__)


class SegmentationService:
    """Generates segmentation masks using SAM2 server or diff-mask for complex objects."""

    def __init__(self):
        self.sam2_client = get_sam2_client()
        self._sam2_available = None  # Cached availability
        # Initialize Gemini client for diff-mask method
        api_key = os.getenv("GEMINI_API_KEY")
        self.gemini_client = genai.Client(api_key=api_key) if api_key else None

    async def _check_sam2(self) -> bool:
        """Check if SAM2 server is available (retry on failure)."""
        # Only cache successful results, retry on failure
        if self._sam2_available is True:
            return True
        # Check again if previously failed or not checked yet
        self._sam2_available = await self.sam2_client.health_check()
        return self._sam2_available

    # =========================================================================
    # LOCAL ROUGH MASK (Canny edge + flood fill from positive points)
    # =========================================================================

    def generate_rough_mask_local(
        self,
        image_data: bytes,
        bounding_box: List[int],
        positive_points: List[List[int]] = None,
    ) -> Optional[bytes]:
        """
        Generate rough mask using Canny edge detection + flood fill from positive points.
        No API calls, ~50ms. Used as mask_input for SAM2.

        Args:
            image_data: Raw image bytes
            bounding_box: [y_min, x_min, y_max, x_max] normalized 0-1000
            positive_points: Points [y, x] inside element (normalized 0-1000)

        Returns:
            PNG mask bytes or None
        """
        if not positive_points:
            return None

        try:
            import cv2

            img = np.array(Image.open(io.BytesIO(image_data)).convert('RGB'))
            # Convert RGB to BGR for OpenCV
            img_bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
            h, w = img_bgr.shape[:2]

            # Convert normalized box to pixels
            y_min, x_min, y_max, x_max = bounding_box
            by_min = int(y_min / 1000 * h)
            bx_min = int(x_min / 1000 * w)
            by_max = int(y_max / 1000 * h)
            bx_max = int(x_max / 1000 * w)

            # Convert positive points to pixels
            pos_px = []
            for pt in positive_points:
                py = int(pt[0] / 1000 * h)
                px = int(pt[1] / 1000 * w)
                pos_px.append((py, px))

            # Fix 1: Adaptive Canny thresholds (Otsu-based from bbox region)
            gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
            blurred = cv2.GaussianBlur(gray, (3, 3), 0)
            bbox_gray = gray[by_min:by_max, bx_min:bx_max]
            otsu_thresh, _ = cv2.threshold(bbox_gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            low_thresh = max(10, int(otsu_thresh * 0.33))
            high_thresh = max(30, int(otsu_thresh * 0.66))
            edges = cv2.Canny(blurred, low_thresh, high_thresh)
            logger.debug(f"  Adaptive Canny: otsu={otsu_thresh:.0f}, low={low_thresh}, high={high_thresh}")

            # Dilate edges to close gaps
            kernel = np.ones((3, 3), np.uint8)
            edges_closed = cv2.dilate(edges, kernel, iterations=1)

            # Fix 2: Color-aware flood fill barrier (Lab distance)
            # Uses INTERSECTION (min) instead of union (max):
            # A pixel is only a barrier if it's far from ALL positive points.
            # This prevents leakage when points span different colors (e.g. green grass + brown rock).
            img_lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2Lab).astype(np.float32)
            color_barrier = np.full((h, w), 255, dtype=np.uint8)  # Start all-barrier
            COLOR_DIST_THRESH = 35  # Lab distance — works for illustrations with flat colors

            valid_points = 0
            for py, px in pos_px:
                if not (0 <= py < h and 0 <= px < w):
                    continue
                valid_points += 1
                seed_color = img_lab[py, px]
                diff = np.sqrt(np.sum((img_lab - seed_color) ** 2, axis=2))
                far_pixels = (diff > COLOR_DIST_THRESH).astype(np.uint8) * 255
                color_barrier = np.minimum(color_barrier, far_pixels)  # Intersection

            if valid_points == 0:
                color_barrier = np.zeros((h, w), dtype=np.uint8)

            combined_edges = np.maximum(edges_closed, color_barrier)

            # Flood fill from each positive point
            combined_mask = np.zeros((h, w), dtype=np.uint8)
            for py, px in pos_px:
                # Find non-edge pixel nearby if point is on an edge
                if 0 <= py < h and 0 <= px < w and combined_edges[py, px] > 0:
                    found = False
                    for r in range(1, 20):
                        for dy in range(-r, r + 1):
                            for dx in range(-r, r + 1):
                                ny, nx = py + dy, px + dx
                                if 0 <= ny < h and 0 <= nx < w and combined_edges[ny, nx] == 0:
                                    py, px = ny, nx
                                    found = True
                                    break
                            if found:
                                break
                        if found:
                            break

                if not (0 <= py < h and 0 <= px < w):
                    continue

                ff_mask = np.zeros((h + 2, w + 2), dtype=np.uint8)
                fill_img = combined_edges.copy()
                cv2.floodFill(
                    fill_img, ff_mask, (px, py), 128,
                    loDiff=0, upDiff=0,
                    flags=cv2.FLOODFILL_MASK_ONLY | (255 << 8)
                )
                combined_mask = np.maximum(combined_mask, ff_mask[1:h+1, 1:w+1])

            # Fix 3: Expanded bbox clip (+5% padding)
            pad_y = int((by_max - by_min) * 0.05)
            pad_x = int((bx_max - bx_min) * 0.05)
            clip_y_min = max(0, by_min - pad_y)
            clip_x_min = max(0, bx_min - pad_x)
            clip_y_max = min(h, by_max + pad_y)
            clip_x_max = min(w, bx_max + pad_x)
            bbox_clip = np.zeros((h, w), dtype=np.uint8)
            bbox_clip[clip_y_min:clip_y_max, clip_x_min:clip_x_max] = 255
            result = cv2.bitwise_and(combined_mask, bbox_clip)

            # Fix 4: Size-adaptive morphology
            elem_size = max(by_max - by_min, bx_max - bx_min)
            if elem_size < 50:
                pass  # Very small — skip morphology
            elif elem_size < 150:
                result = cv2.morphologyEx(result, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8), iterations=1)
            else:
                result = cv2.morphologyEx(result, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=1)

            # Fix 5: Relative coverage check (vs bbox area, not full image)
            bbox_area = (clip_y_max - clip_y_min) * (clip_x_max - clip_x_min)
            coverage = np.sum(result > 0) / bbox_area if bbox_area > 0 else 0
            logger.info(f"  Local rough mask: coverage={coverage:.1%} of bbox (elem_size={elem_size}px)")

            if coverage < 0.05:
                logger.warning(f"  Local rough mask too small (<5% of bbox), skipping")
                return None

            if coverage > 0.85:
                logger.warning(f"  Local rough mask too large (>{coverage:.0%} of bbox), flood fill likely leaked — skipping")
                return None

            # Convert to PNG bytes
            mask_img = Image.fromarray(result, mode='L')
            buffer = io.BytesIO()
            mask_img.save(buffer, format='PNG')
            return buffer.getvalue()

        except Exception as e:
            logger.error(f"Failed to generate local rough mask: {e}")
            return None

    # =========================================================================
    # COMPLEX OBJECT DETECTION (Plan B)
    # =========================================================================

    def is_complex_object(
        self,
        element_name: str,
        sub_parts_count: int = 0
    ) -> bool:
        """
        Determine if an element is "complex" and should use diff-mask method.

        Complex objects have internal gaps where background is visible (e.g., trees).

        Detection: Sub-parts count (3+ = complex object)
        - Objects with 3+ distinct internal parts are likely complex

        Args:
            element_name: Name of the element
            sub_parts_count: Number of distinct internal parts detected by Gemini

        Returns:
            True if complex (use diff-mask), False otherwise (use SAM)
        """
        is_complex = sub_parts_count >= COMPLEX_SUB_BOX_THRESHOLD

        if is_complex:
            logger.info(f"  {element_name}: COMPLEX object ({sub_parts_count} sub-parts) → will use diff-mask")

        return is_complex

    def is_element_white(
        self,
        image_data: bytes,
        box: List[int],
        brightness_threshold: float = 200
    ) -> bool:
        """
        Check if element is predominantly white/light colored.
        Diff-mask fails for white objects (no difference to detect).

        Args:
            image_data: Image bytes
            box: Bounding box [y_min, x_min, y_max, x_max] normalized 0-1000
            brightness_threshold: Brightness threshold (0-255)

        Returns:
            True if element is white/light, False otherwise
        """
        img = Image.open(io.BytesIO(image_data)).convert('RGB')
        img_np = np.array(img)
        height, width = img_np.shape[:2]

        # Convert box to pixels
        y_min, x_min, y_max, x_max = box
        px_x_min = int(x_min / 1000 * width)
        px_x_max = int(x_max / 1000 * width)
        px_y_min = int(y_min / 1000 * height)
        px_y_max = int(y_max / 1000 * height)

        # Extract box region
        box_region = img_np[px_y_min:px_y_max, px_x_min:px_x_max]

        if box_region.size == 0:
            return False

        # Calculate average brightness
        gray = np.mean(box_region, axis=2)
        avg_brightness = np.mean(gray)

        # Check if most pixels are light
        light_ratio = np.sum(gray > brightness_threshold) / gray.size

        is_white = avg_brightness > brightness_threshold or light_ratio > 0.5
        return is_white

    # =========================================================================
    # DIFF-MASK METHOD (for complex objects)
    # =========================================================================

    async def get_rough_mask_from_gemini(
        self,
        image_data: bytes,
        element_name: str,
        element_description: str,
        box: List[int],
        is_redo: bool = False
    ) -> Optional[bytes]:
        """
        Get rough mask from Gemini for diff-mask extraction.

        Args:
            image_data: Image bytes
            element_name: Name of element to mask
            element_description: Description of element
            box: Bounding box [y_min, x_min, y_max, x_max] normalized 0-1000
            is_redo: If True, use REDO_ROUGH_MASK_PROMPT with color awareness

        Returns:
            Rough mask PNG bytes, or None if failed
        """
        if not self.gemini_client:
            logger.warning("Gemini client not available for rough mask")
            return None

        mime_type = "image/png" if image_data[:4] == b'\x89PNG' else "image/jpeg"

        # Use redo prompt for extra careful masking
        if is_redo:
            logger.info(f"  Using REDO_ROUGH_MASK_PROMPT for {element_name}")
            prompt = REDO_ROUGH_MASK_PROMPT.format(
                element_name=element_name,
                element_description=element_description,
                box=box
            )
        else:
            prompt = ROUGH_MASK_PROMPT.format(
                element_name=element_name,
                element_description=element_description,
                box=box
            )

        try:
            config = types.GenerateContentConfig(
                temperature=0.0,
                max_output_tokens=8192,
                response_modalities=["IMAGE", "TEXT"],
            )

            response = await asyncio.to_thread(
                self.gemini_client.models.generate_content,
                model=IMAGE_PRIMARY,
                contents=[
                    types.Part.from_text(text=prompt),
                    types.Part.from_bytes(data=image_data, mime_type=mime_type)
                ],
                config=config
            )

            if response.candidates and response.candidates[0].content:
                for part in response.candidates[0].content.parts or []:
                    if hasattr(part, 'inline_data') and part.inline_data:
                        return part.inline_data.data

            return None

        except Exception as e:
            logger.error(f"Failed to get rough mask from Gemini: {e}")
            return None

    def diff_mask_extract(
        self,
        image_data: bytes,
        rough_mask_bytes: bytes,
        box: List[int]
    ) -> Tuple[Optional[bytes], str]:
        """
        Extract element using adaptive diff-mask method.
        Handles both TRUE_BINARY (black bg) and OVERLAY (original bg) mask types.

        Args:
            image_data: Original image bytes
            rough_mask_bytes: Rough mask from Gemini
            box: Bounding box [y_min, x_min, y_max, x_max] normalized 0-1000

        Returns:
            Tuple of (mask_bytes, mask_type) where mask_type is "TRUE_BINARY" or "OVERLAY"
        """
        original = Image.open(io.BytesIO(image_data)).convert('RGB')
        rough = Image.open(io.BytesIO(rough_mask_bytes)).convert('RGB')
        width, height = original.size

        # Resize rough mask if needed
        if rough.size != original.size:
            rough = rough.resize(original.size, Image.Resampling.LANCZOS)

        orig_np = np.array(original)
        rough_np = np.array(rough)

        # Detect mask type: TRUE_BINARY (black bg) or OVERLAY (original bg)
        black_pixels = np.sum(
            (rough_np[:, :, 0] < 20) &
            (rough_np[:, :, 1] < 20) &
            (rough_np[:, :, 2] < 20)
        )
        black_ratio = black_pixels / (rough_np.shape[0] * rough_np.shape[1])

        rough_gray = np.mean(rough_np, axis=2)

        # Calculate difference from original (used to detect holes/gaps)
        diff = np.abs(rough_np.astype(int) - orig_np.astype(int))
        diff_sum = diff.sum(axis=2)

        if black_ratio > 0.3:
            # TRUE_BINARY: white pixels that are DIFFERENT from original
            # This excludes holes where Gemini accidentally drew white but it matches original sky
            mask_type = "TRUE_BINARY"
            is_white = rough_gray > 200
            is_different = diff_sum > 50  # Lower threshold for TRUE_BINARY
            is_element = is_white & is_different
            logger.debug(f"  TRUE_BINARY: white_pixels={np.sum(is_white)}, different={np.sum(is_different)}, final={np.sum(is_element)}")
        else:
            # OVERLAY: use difference detection
            mask_type = "OVERLAY"
            is_element = (rough_gray > 200) & (diff_sum > 100)

        # Apply bounding box crop
        y_min, x_min, y_max, x_max = box
        px_x_min = int(x_min / 1000 * width)
        px_x_max = int(x_max / 1000 * width)
        px_y_min = int(y_min / 1000 * height)
        px_y_max = int(y_max / 1000 * height)

        box_mask = np.zeros_like(is_element)
        box_mask[px_y_min:px_y_max, px_x_min:px_x_max] = True
        is_element = is_element & box_mask

        # Create binary mask
        binary_mask = (is_element * 255).astype(np.uint8)

        # Save as PNG
        mask_img = Image.fromarray(binary_mask, mode='L')
        buffer = io.BytesIO()
        mask_img.save(buffer, format='PNG')

        return buffer.getvalue(), mask_type

    async def generate_mask_diff(
        self,
        image_data: bytes,
        element_name: str,
        element_description: str,
        bounding_box: List[int],
        is_redo: bool = False
    ) -> Optional[bytes]:
        """
        Generate mask using diff-mask method (for complex objects).

        Args:
            image_data: Original image bytes
            element_name: Name of element
            element_description: Description of element
            bounding_box: [y_min, x_min, y_max, x_max] normalized 0-1000
            is_redo: If True, use REDO_ROUGH_MASK_PROMPT

        Returns:
            Mask PNG bytes, or None if failed
        """
        redo_label = " (REDO)" if is_redo else ""
        logger.info(f"  Using diff-mask method{redo_label} for {element_name}")

        # Get rough mask from Gemini
        rough_mask = await self.get_rough_mask_from_gemini(
            image_data, element_name, element_description, bounding_box, is_redo=is_redo
        )

        if not rough_mask:
            logger.warning(f"  Failed to get rough mask for {element_name}")
            return None

        # DEBUG: Save rough mask from Gemini
        debug_dir = "pipeline_output/debug_masks"
        import os
        os.makedirs(debug_dir, exist_ok=True)
        safe_name = element_name.replace(" ", "_").replace("/", "_")
        with open(f"{debug_dir}/{safe_name}_rough_mask.png", "wb") as f:
            f.write(rough_mask)
        logger.info(f"  DEBUG: Saved rough mask to {debug_dir}/{safe_name}_rough_mask.png")

        # Extract using diff-mask
        mask_data, mask_type = self.diff_mask_extract(
            image_data, rough_mask, bounding_box
        )

        if mask_data:
            # Calculate coverage
            mask_np = np.array(Image.open(io.BytesIO(mask_data)).convert('L'))
            coverage = np.sum(mask_np > 128) / mask_np.size
            logger.info(f"  Diff-mask: {mask_type}, coverage={coverage:.1%}")

            # DEBUG: Save diff-mask result
            with open(f"{debug_dir}/{safe_name}_diff_mask.png", "wb") as f:
                f.write(mask_data)
            logger.info(f"  DEBUG: Saved diff mask to {debug_dir}/{safe_name}_diff_mask.png")

            if coverage < 0.01:
                logger.warning(f"  Diff-mask coverage too low ({coverage:.1%}), will fallback to SAM")
                return None

            # Clean the mask - preserve holes for complex objects!
            return self._clean_mask(mask_data, preserve_holes=True)

        return None

    async def generate_mask(
        self,
        image_data: bytes,
        element_name: str,
        bounding_box: List[int],
        padding_percent: float = 0.0,
        element_description: str = "",
        has_internal_gaps: bool = False,
        use_hybrid: bool = True,
        positive_points: List[List[int]] = None,
        negative_points: List[List[int]] = None,
        is_redo: bool = False
    ) -> Optional[bytes]:
        """Generate a segmentation mask for a specific element.

        Uses hybrid approach (Plan B):
        - Diff-mask for objects with internal gaps (trees, bushes)
        - SAM2 for solid objects

        Args:
            image_data: Raw image bytes
            element_name: Name of the element to segment
            bounding_box: [y_min, x_min, y_max, x_max] normalized 0-1000
            padding_percent: Expand box by this percentage (default 0%)
            element_description: Description for complex object detection
            has_internal_gaps: True if object has gaps where background shows through
            use_hybrid: Enable hybrid SAM/diff-mask (default True)
            positive_points: 5 points [y, x] inside object (normalized 0-1000)
            negative_points: 2 points [y, x] outside object (normalized 0-1000)
            is_redo: If True, use REDO prompts for more careful processing

        Returns:
            PNG mask bytes (white = element, black = background)
            Returns None if mask generation fails
        """
        logger.info(f"Generating mask for element: {element_name}")

        is_white = self.is_element_white(image_data, bounding_box)

        # Step A: Complex objects with internal gaps → diff-mask first (preserves gaps)
        if has_internal_gaps and not is_white:
            logger.info(f"  {element_name} has internal gaps → trying diff-mask first")
            mask_data = await self.generate_mask_diff(
                image_data, element_name, element_description, bounding_box, is_redo=is_redo
            )
            if mask_data:
                return self._clean_mask(mask_data, preserve_holes=True)
            logger.info(f"  Diff-mask failed for {element_name}, falling back to SAM2")

        # Step B: SAM2 with box + points (no rough mask — works for most elements)
        # Convert normalized box (0-1000) to pixel coordinates
        image = Image.open(io.BytesIO(image_data))
        width, height = image.size

        y_min, x_min, y_max, x_max = bounding_box

        # Add padding to bounding box (helps SAM2 capture full object)
        box_width = x_max - x_min
        box_height = y_max - y_min
        pad_x = int(box_width * padding_percent)
        pad_y = int(box_height * padding_percent)

        # Apply padding while staying within 0-1000 range
        x_min = max(0, x_min - pad_x)
        y_min = max(0, y_min - pad_y)
        x_max = min(1000, x_max + pad_x)
        y_max = min(1000, y_max + pad_y)

        pixel_box = [
            int(x_min * width / 1000),   # x_min
            int(y_min * height / 1000),  # y_min
            int(x_max * width / 1000),   # x_max
            int(y_max * height / 1000),  # y_max
        ]

        logger.info(f"  Bounding box: {bounding_box} -> pixels (with {padding_percent*100}% padding): {pixel_box}")

        # Convert points from normalized (0-1000) to pixel coordinates
        # Points are [y, x] in normalized coords, SAM2 expects [x, y] in pixels
        pixel_positive_points = []
        pixel_negative_points = []

        if positive_points:
            for pt in positive_points:
                if len(pt) >= 2:
                    y, x = pt[0], pt[1]
                    pixel_positive_points.append([int(x * width / 1000), int(y * height / 1000)])
            logger.info(f"  Positive points: {len(pixel_positive_points)} points from Gemini")

        if negative_points:
            for pt in negative_points:
                if len(pt) >= 2:
                    y, x = pt[0], pt[1]
                    pixel_negative_points.append([int(x * width / 1000), int(y * height / 1000)])
            logger.info(f"  Negative points: {len(pixel_negative_points)} points from Gemini")

        # Try SAM2 with just box + points (no rough mask)
        if await self._check_sam2():
            logger.info(f"  Using SAM2 for {element_name} (box + points only)")
            sam2_result = await self.sam2_client.segment_single(
                image_data, pixel_box, element_name,
                positive_points=pixel_positive_points if pixel_positive_points else None,
                negative_points=pixel_negative_points if pixel_negative_points else None,
            )
            if sam2_result:
                mask_data = sam2_result["mask"]
                score = sam2_result.get("score", 1.0)
                quality = self._check_mask_quality(mask_data, bounding_box, width, height, sam2_score=score)

                if quality == "good":
                    logger.info(f"  SAM2 pass 1 good (score={score:.3f})")
                    return self._clean_mask(mask_data, from_sam2=True)

                # Pass 2: Iterative refinement — feed mask back to SAM2
                low_res_mask = sam2_result.get("low_res_mask")
                if low_res_mask and quality == "low_confidence":
                    logger.info(f"  SAM2 pass 1 low confidence ({score:.3f}), trying refinement...")
                    refined = await self.sam2_client.refine_single(
                        image_data, pixel_box, element_name,
                        low_res_mask=low_res_mask,
                        positive_points=pixel_positive_points if pixel_positive_points else None,
                        negative_points=pixel_negative_points if pixel_negative_points else None,
                    )
                    if refined:
                        refined_score = refined.get("score", 0)
                        refined_quality = self._check_mask_quality(
                            refined["mask"], bounding_box, width, height, sam2_score=refined_score
                        )
                        if refined_quality == "good":
                            logger.info(f"  SAM2 pass 2 good (score={refined_score:.3f})")
                            return self._clean_mask(refined["mask"], from_sam2=True)
                        logger.warning(f"  SAM2 pass 2 still {refined_quality} (score={refined_score:.3f})")

                logger.warning(f"  SAM2 quality: {quality} (score={score:.3f}) → falling back to diff-mask")
            else:
                logger.warning(f"  SAM2 returned no mask for {element_name}")

        # Step C: Diff-mask fallback (VLM traces the element)
        if not is_white:
            logger.info(f"  Trying diff-mask (VLM trace) for {element_name}")
            mask_data = await self.generate_mask_diff(
                image_data, element_name, element_description, bounding_box, is_redo=is_redo
            )
            if mask_data:
                return self._clean_mask(mask_data)

        # Last resort: bounding box mask
        logger.warning(f"Using bounding box fallback for {element_name}")
        mask_data = self._create_bbox_mask(image_data, bounding_box)

        if mask_data:
            mask_data = self._clean_mask(mask_data)

        return mask_data

    async def generate_masks_for_layer(
        self,
        image_data: bytes,
        elements: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Generate masks for all elements in a layer.

        Args:
            image_data: Raw image bytes
            elements: List of elements with name and box_2d

        Returns:
            List of element dicts with added 'mask' field containing PNG bytes
        """
        results = []

        for elem in elements:
            elem_copy = elem.copy()

            mask_data = await self.generate_mask(
                image_data=image_data,
                element_name=elem["name"],
                bounding_box=elem["box_2d"]
            )

            if mask_data:
                elem_copy["mask"] = mask_data
                elem_copy["mask_success"] = True
            else:
                elem_copy["mask"] = None
                elem_copy["mask_success"] = False
                logger.warning(f"Failed to generate mask for {elem['name']}")

            results.append(elem_copy)

        return results

    def combine_masks(self, masks: List[bytes]) -> bytes:
        """Combine multiple masks into one (union).

        Args:
            masks: List of PNG mask bytes

        Returns:
            Combined PNG mask bytes
        """
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
                logger.warning("Mask size mismatch, skipping")

        # Convert back to bytes
        result_image = Image.fromarray(combined)
        buffer = io.BytesIO()
        result_image.save(buffer, format='PNG')
        return buffer.getvalue()

    def extract_masked_region(
        self,
        image_data: bytes,
        mask_data: bytes,
        background_color: Tuple[int, int, int] = (0, 255, 0)
    ) -> bytes:
        """Extract masked region with colored background.

        Args:
            image_data: Original image bytes
            mask_data: Mask PNG bytes (white = keep)
            background_color: RGB tuple for background (default: green)

        Returns:
            PNG bytes of extracted region on colored background
        """
        # Load images
        image = Image.open(io.BytesIO(image_data)).convert('RGBA')
        mask = Image.open(io.BytesIO(mask_data)).convert('L')

        # Ensure same size
        if mask.size != image.size:
            mask = mask.resize(image.size, Image.Resampling.LANCZOS)

        # Create background
        background = Image.new('RGBA', image.size, (*background_color, 255))

        # Create output with alpha from mask
        output = Image.new('RGBA', image.size)
        output.paste(background, (0, 0))

        # Apply mask to original image
        image_array = np.array(image)
        mask_array = np.array(mask)

        # Set alpha channel based on mask
        if image_array.shape[2] == 4:
            image_array[:, :, 3] = mask_array
        else:
            # Add alpha channel
            alpha = mask_array
            image_array = np.dstack([image_array, alpha])

        masked_image = Image.fromarray(image_array)

        # Composite onto background
        output = Image.alpha_composite(background, masked_image)

        # Convert to RGB (remove alpha for SVG conversion later)
        output = output.convert('RGB')

        buffer = io.BytesIO()
        output.save(buffer, format='PNG')
        return buffer.getvalue()

    def _create_bbox_mask(
        self,
        image_data: bytes,
        bounding_box: List[int]
    ) -> bytes:
        """Create a simple rectangular mask from bounding box.

        Fallback when Gemini doesn't return a proper mask.
        """
        image = Image.open(io.BytesIO(image_data))
        width, height = image.size

        # Convert normalized coords to pixels
        y_min, x_min, y_max, x_max = bounding_box
        x1 = int(x_min * width / 1000)
        y1 = int(y_min * height / 1000)
        x2 = int(x_max * width / 1000)
        y2 = int(y_max * height / 1000)

        # Create black mask
        mask = Image.new('L', (width, height), 0)

        # Draw white rectangle
        from PIL import ImageDraw
        draw = ImageDraw.Draw(mask)
        draw.rectangle([x1, y1, x2, y2], fill=255)

        buffer = io.BytesIO()
        mask.save(buffer, format='PNG')
        return buffer.getvalue()

    def _check_mask_quality(
        self,
        mask_data: bytes,
        bounding_box: List[int],
        img_width: int,
        img_height: int,
        sam2_score: float = 1.0
    ) -> str:
        """Quick heuristic check on SAM2 mask quality.

        Returns:
            'good' - mask looks reasonable
            'low_confidence' - SAM2 score below threshold
            'too_small' - mask covers <3% of bbox (SAM2 missed the element)
            'too_large' - mask covers >95% of bbox (SAM2 grabbed too much)
            'empty' - no mask pixels at all
        """
        try:
            import cv2

            # SAM2 confidence check — low score means SAM2 struggled
            if sam2_score < 0.7:
                logger.info(f"    SAM2 score {sam2_score:.3f} < 0.7 threshold")
                return "low_confidence"

            mask = np.array(Image.open(io.BytesIO(mask_data)).convert('L'))
            _, mask = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)

            # Calculate bbox area in pixels
            y_min, x_min, y_max, x_max = bounding_box
            bx_min = int(x_min / 1000 * img_width)
            bx_max = int(x_max / 1000 * img_width)
            by_min = int(y_min / 1000 * img_height)
            by_max = int(y_max / 1000 * img_height)
            bbox_area = max(1, (by_max - by_min) * (bx_max - bx_min))

            mask_pixels = np.sum(mask > 0)
            if mask_pixels == 0:
                return "empty"

            coverage = mask_pixels / bbox_area
            logger.info(f"    Mask quality: {mask_pixels}px, {coverage:.1%} of bbox, score={sam2_score:.3f}")

            if coverage < 0.03:
                return "too_small"
            if coverage > 0.95:
                return "too_large"
            return "good"

        except Exception as e:
            logger.warning(f"    Mask quality check failed: {e}")
            return "good"  # Don't block on check failure

    def _clean_mask(self, mask_data: bytes, preserve_holes: bool = False, from_sam2: bool = False) -> bytes:
        """Clean up mask for laser cutting: smooth edges suitable for vector conversion.

        Args:
            mask_data: Raw mask PNG bytes
            preserve_holes: If True, don't fill internal holes (for complex objects like trees)
            from_sam2: If True, mask is from SAM2 (already pixel-perfect) - minimal processing
        """
        try:
            import cv2

            mask = Image.open(io.BytesIO(mask_data)).convert('L')
            mask_array = np.array(mask)

            # Hard binary threshold first
            _, mask_array = cv2.threshold(mask_array, 127, 255, cv2.THRESH_BINARY)

            if not preserve_holes:
                # Fill internal holes (e.g., flower hole in lily pad)
                # SKIP this for complex objects (trees, bushes) where holes should be preserved
                contours, _ = cv2.findContours(mask_array, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                mask_array = np.zeros_like(mask_array)
                cv2.drawContours(mask_array, contours, -1, 255, cv2.FILLED)

            # SAM2 masks and diff-masks (preserve_holes) - light denoise only
            # Full edge smoothing was causing fragmentation issues for trees
            if from_sam2 or preserve_holes:
                # Remove single-pixel noise/scatter (common with low-confidence SAM2 masks)
                kernel_denoise = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
                mask_array = cv2.morphologyEx(mask_array, cv2.MORPH_OPEN, kernel_denoise, iterations=1)
                result = Image.fromarray(mask_array)
                buffer = io.BytesIO()
                result.save(buffer, format='PNG')
                return buffer.getvalue()

            # EDGE SMOOTHING for simple Gemini masks only (laser cutting quality)
            # 1. Morphological close to fill small gaps
            kernel_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
            mask_array = cv2.morphologyEx(mask_array, cv2.MORPH_CLOSE, kernel_close, iterations=1)

            # 2. Morphological open to remove small noise
            kernel_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
            mask_array = cv2.morphologyEx(mask_array, cv2.MORPH_OPEN, kernel_open, iterations=1)

            # 3. Smooth contours using approxPolyDP for cleaner edges
            contour_mode = cv2.RETR_TREE if preserve_holes else cv2.RETR_EXTERNAL
            contours, hierarchy = cv2.findContours(mask_array, contour_mode, cv2.CHAIN_APPROX_SIMPLE)

            # Create smoothed mask
            smoothed_mask = np.zeros_like(mask_array)

            for i, contour in enumerate(contours):
                # Approximate contour to reduce jaggedness
                # epsilon = 0.5% of perimeter gives good smoothing
                epsilon = 0.005 * cv2.arcLength(contour, True)
                approx = cv2.approxPolyDP(contour, epsilon, True)

                # Determine if this is an outer or inner contour (hole)
                if preserve_holes and hierarchy is not None:
                    # hierarchy[0][i][3] = parent index, -1 means no parent (outer contour)
                    is_hole = hierarchy[0][i][3] != -1
                    if is_hole:
                        # Draw hole (subtract from mask)
                        cv2.drawContours(smoothed_mask, [approx], -1, 0, cv2.FILLED)
                    else:
                        # Draw outer contour
                        cv2.drawContours(smoothed_mask, [approx], -1, 255, cv2.FILLED)
                else:
                    cv2.drawContours(smoothed_mask, [approx], -1, 255, cv2.FILLED)

            # 4. Final light blur + threshold for anti-aliased appearance
            smoothed_mask = cv2.GaussianBlur(smoothed_mask, (3, 3), 0)
            _, smoothed_mask = cv2.threshold(smoothed_mask, 180, 255, cv2.THRESH_BINARY)

            result = Image.fromarray(smoothed_mask)
            buffer = io.BytesIO()
            result.save(buffer, format='PNG')
            return buffer.getvalue()
        except ImportError:
            logger.warning("OpenCV not available, using basic threshold only")
            # Fallback without OpenCV
            mask = Image.open(io.BytesIO(mask_data)).convert('L')
            mask_array = np.array(mask)
            mask_array = (mask_array > 127).astype(np.uint8) * 255
            result = Image.fromarray(mask_array)
            buffer = io.BytesIO()
            result.save(buffer, format='PNG')
            return buffer.getvalue()
        except Exception as e:
            logger.error(f"Error cleaning mask: {e}")
            return mask_data


# Singleton instance
_service: Optional[SegmentationService] = None


def get_segmentation_service() -> SegmentationService:
    """Get or create the SegmentationService singleton."""
    global _service
    if _service is None:
        _service = SegmentationService()
    return _service
