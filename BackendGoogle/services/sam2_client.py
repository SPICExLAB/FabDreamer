"""
SAM2 Client - Connects to SAM2 server for pixel-perfect segmentation.

The server address must be provided via the SAM2_SERVER_URL environment
variable (e.g. http://localhost:8666 — see sam2_server.py for self-hosting).
"""

import os
import base64
import logging
import httpx
from typing import List, Optional, Dict, Any

logger = logging.getLogger(__name__)

SAM2_SERVER_URL = os.getenv("SAM2_SERVER_URL", "")


class SAM2Client:
    """Client for SAM2 segmentation server."""

    def __init__(self, server_url: str = None):
        self.server_url = server_url or SAM2_SERVER_URL
        if not self.server_url:
            logger.error(
                "SAM2_SERVER_URL is not set — segmentation will fail. "
                "Set it in .env (e.g. SAM2_SERVER_URL=http://localhost:8666)."
            )
        self.timeout = 60.0  # SAM2 can take a few seconds

    async def health_check(self) -> bool:
        """Check if SAM2 server is available."""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.server_url}/health",
                    timeout=30.0  # Increased from 5s - first connection can be slow
                )
                if response.status_code == 200:
                    data = response.json()
                    logger.info(f"SAM2 server healthy: {data}")
                    return data.get("model_loaded", False)
                return False
        except Exception as e:
            import traceback
            logger.warning(f"SAM2 server not available: {type(e).__name__}: {e}")
            logger.debug(traceback.format_exc())
            return False

    async def segment(
        self,
        image_data: bytes,
        boxes: List[List[int]],
        labels: Optional[List[str]] = None,
        use_center_point: bool = True,
        positive_points: Optional[List[List[int]]] = None,
        negative_points: Optional[List[List[int]]] = None,
        mask_input: Optional[bytes] = None
    ) -> List[Dict[str, Any]]:
        """
        Segment objects using bounding boxes.

        Args:
            image_data: Raw image bytes
            boxes: List of [x_min, y_min, x_max, y_max] pixel coordinates
            labels: Optional labels for each box
            use_center_point: Add center point prompt to help SAM2 focus (fallback if no external points)
            positive_points: External positive points [x, y] in pixels (from Gemini)
            negative_points: External negative points [x, y] in pixels (from Gemini)

        Returns:
            List of {"label": str, "box": list, "mask": bytes, "score": float}
        """
        # Encode image to base64
        image_b64 = base64.b64encode(image_data).decode('utf-8')

        # Use external points from Gemini if provided, otherwise fallback to center point
        points = []
        point_labels = []

        if positive_points or negative_points:
            # Use Gemini-provided points (5 positive + 2 negative)
            if positive_points:
                for pt in positive_points:
                    points.append(pt)  # [x, y] in pixels
                    point_labels.append(1)  # foreground
            if negative_points:
                for pt in negative_points:
                    points.append(pt)  # [x, y] in pixels
                    point_labels.append(0)  # background
            logger.info(f"  Using Gemini points: {len(positive_points or [])} positive + {len(negative_points or [])} negative")
        elif use_center_point:
            # Fallback: use single center point
            for box in boxes:
                x_min, y_min, x_max, y_max = box
                center_x = (x_min + x_max) // 2
                center_y = (y_min + y_max) // 2
                points.append([center_x, center_y])
                point_labels.append(1)  # foreground point

        # Prepare request
        request_data = {
            "image": f"data:image/png;base64,{image_b64}",
            "boxes": boxes,
            "labels": labels or [f"object_{i}" for i in range(len(boxes))],
            "multimask_output": False,  # Get single best mask
        }

        # Add point prompts if any
        if points:
            request_data["points"] = points
            request_data["point_labels"] = point_labels

        # Add rough mask as spatial prior for SAM2
        if mask_input:
            mask_b64 = base64.b64encode(mask_input).decode('utf-8')
            request_data["mask_input"] = f"data:image/png;base64,{mask_b64}"
            logger.info(f"  Including rough mask as mask_input for SAM2")

        try:
            async with httpx.AsyncClient() as client:
                logger.info(f"Sending {len(boxes)} boxes to SAM2 server")
                response = await client.post(
                    f"{self.server_url}/segment",
                    json=request_data,
                    timeout=self.timeout
                )

                if response.status_code != 200:
                    logger.error(f"SAM2 error: {response.status_code} - {response.text}")
                    return []

                data = response.json()

                # Decode masks from base64
                results = []
                for mask_data in data.get("masks", []):
                    mask_b64 = mask_data["mask"]
                    if "base64," in mask_b64:
                        mask_b64 = mask_b64.split("base64,")[1]

                    mask_bytes = base64.b64decode(mask_b64)

                    results.append({
                        "label": mask_data["label"],
                        "box": mask_data["box"],
                        "mask": mask_bytes,
                        "score": mask_data["score"],
                        "low_res_mask": mask_data.get("low_res_mask"),
                    })

                logger.info(f"SAM2 returned {len(results)} masks")
                return results

        except httpx.TimeoutException:
            logger.error("SAM2 request timed out")
            return []
        except Exception as e:
            logger.exception(f"SAM2 segmentation failed: {e}")
            return []

    async def segment_single(
        self,
        image_data: bytes,
        box: List[int],
        label: str = "object",
        positive_points: Optional[List[List[int]]] = None,
        negative_points: Optional[List[List[int]]] = None,
        mask_input: Optional[bytes] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Segment a single object.

        Args:
            image_data: Raw image bytes
            box: [x_min, y_min, x_max, y_max] pixel coordinates
            label: Object label
            positive_points: Points [x, y] inside object (from Gemini)
            negative_points: Points [x, y] outside object (from Gemini)
            mask_input: Rough mask PNG bytes as spatial prior

        Returns:
            {"mask": PNG bytes, "score": float} or None if failed
        """
        results = await self.segment(
            image_data, [box], [label],
            positive_points=positive_points,
            negative_points=negative_points,
            mask_input=mask_input
        )
        if results:
            return {
                "mask": results[0]["mask"],
                "score": results[0].get("score", 1.0),
                "low_res_mask": results[0].get("low_res_mask"),
            }
        return None

    async def refine_single(
        self,
        image_data: bytes,
        box: List[int],
        label: str,
        low_res_mask: str,
        positive_points: Optional[List[List[int]]] = None,
        negative_points: Optional[List[List[int]]] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Refine a SAM2 mask using iterative feedback.

        Args:
            image_data: Raw image bytes
            box: [x_min, y_min, x_max, y_max] pixel coordinates
            label: Object label
            low_res_mask: Base64 string of 256x256 float32 logits from Pass 1
            positive_points: Points [x, y] inside object
            negative_points: Points [x, y] outside object

        Returns:
            {"mask": PNG bytes, "score": float} or None if failed
        """
        image_b64 = base64.b64encode(image_data).decode('utf-8')

        points = []
        point_labels = []
        if positive_points:
            for pt in positive_points:
                points.append(pt)
                point_labels.append(1)
        if negative_points:
            for pt in negative_points:
                points.append(pt)
                point_labels.append(0)

        request_data = {
            "image": f"data:image/png;base64,{image_b64}",
            "box": box,
            "label": label,
            "low_res_mask": low_res_mask,
        }
        if points:
            request_data["points"] = points
            request_data["point_labels"] = point_labels

        try:
            async with httpx.AsyncClient() as client:
                logger.info(f"  Sending refinement request for {label}")
                response = await client.post(
                    f"{self.server_url}/refine",
                    json=request_data,
                    timeout=self.timeout
                )
                if response.status_code != 200:
                    logger.error(f"SAM2 refine error: {response.status_code} - {response.text}")
                    return None

                data = response.json()
                masks = data.get("masks", [])
                if masks:
                    mask_b64 = masks[0]["mask"]
                    if "base64," in mask_b64:
                        mask_b64 = mask_b64.split("base64,")[1]
                    return {
                        "mask": base64.b64decode(mask_b64),
                        "score": masks[0]["score"],
                    }
            return None

        except Exception as e:
            logger.exception(f"SAM2 refine failed: {e}")
            return None


# Singleton instance
_client = None


def get_sam2_client():
    """Get or create SAM2 client singleton."""
    global _client
    if _client is None:
        _client = SAM2Client()
    return _client
