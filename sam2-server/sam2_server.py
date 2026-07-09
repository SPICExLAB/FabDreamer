"""
SAM2 Segmentation Server for FabDreamer

Runs on Mac Mini with M4 chip using MPS (Metal) acceleration.
Accepts bounding boxes + point prompts, returns pixel-perfect masks.

Usage:
    python sam2_server.py

The server will run on http://0.0.0.0:8666
"""

import io
import base64
import logging
from typing import List, Optional

import numpy as np
import torch
from PIL import Image
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI
app = FastAPI(
    title="SAM2 Segmentation Server",
    description="Pixel-perfect segmentation using SAM2 on Apple Silicon",
    version="1.0.0"
)

# CORS for cross-machine access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global model instance
sam2_model = None
sam2_predictor = None


def get_device():
    """Get the best available device for PyTorch."""
    if torch.backends.mps.is_available():
        logger.info("Using MPS (Apple Metal) acceleration")
        return torch.device("mps")
    elif torch.cuda.is_available():
        logger.info("Using CUDA acceleration")
        return torch.device("cuda")
    else:
        logger.info("Using CPU (slower)")
        return torch.device("cpu")


def load_model():
    """Load SAM2 model on startup."""
    global sam2_model, sam2_predictor

    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    device = get_device()

    # Model configuration - use base+ for better quality
    # model_cfg = "configs/sam2.1/sam2.1_hiera_b+.yaml"
    # checkpoint = "checkpoints/sam2.1_hiera_base_plus.pt"
    model_cfg = "configs/sam2.1/sam2.1_hiera_l.yaml"
    checkpoint = "checkpoints/sam2.1_hiera_large.pt"

    logger.info(f"Loading SAM2 model from {checkpoint}...")

    sam2_model = build_sam2(model_cfg, checkpoint, device=device)
    sam2_predictor = SAM2ImagePredictor(sam2_model)

    logger.info("SAM2 model loaded successfully!")
    return sam2_predictor


# Load model on startup
@app.on_event("startup")
async def startup_event():
    load_model()


# Request/Response Models
class SegmentRequest(BaseModel):
    """Request for segmentation."""
    image: str  # Base64 encoded image
    boxes: List[List[int]]  # [[x_min, y_min, x_max, y_max], ...]
    labels: Optional[List[str]] = None  # Optional labels for each box
    points: Optional[List[List[int]]] = None  # [[x, y], ...] point prompts
    point_labels: Optional[List[int]] = None  # [1, 1, ...] 1=foreground, 0=background
    mask_input: Optional[str] = None  # Base64 encoded rough mask (PNG) - used as spatial prior
    multimask_output: bool = False  # Return multiple masks or single best


class MaskResult(BaseModel):
    """Single mask result."""
    label: str
    box: List[int]
    mask: str  # Base64 encoded PNG mask
    score: float


class SegmentResponse(BaseModel):
    """Response with masks."""
    masks: List[MaskResult]


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "model_loaded": sam2_predictor is not None,
        "device": str(get_device())
    }


@app.post("/segment", response_model=SegmentResponse)
async def segment_image(request: SegmentRequest):
    """
    Segment objects in an image using bounding boxes + optional point prompts.

    Args:
        request: Contains base64 image, bounding boxes, and optional points

    Returns:
        List of masks (base64 PNG) for each bounding box
    """
    if sam2_predictor is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    try:
        # Decode image
        image_data = base64.b64decode(request.image.split(",")[-1])
        image = Image.open(io.BytesIO(image_data)).convert("RGB")
        image_np = np.array(image)

        logger.info(f"Processing image {image.size} with {len(request.boxes)} boxes")

        # Set image in predictor
        sam2_predictor.set_image(image_np)

        # Process mask_input if provided (rough mask as spatial prior)
        mask_input_logits = None
        if request.mask_input:
            try:
                mask_data = base64.b64decode(request.mask_input.split(",")[-1])
                mask_img = Image.open(io.BytesIO(mask_data)).convert("L")
                # Resize to SAM2's expected size (256x256)
                mask_resized = mask_img.resize((256, 256), Image.Resampling.LANCZOS)
                mask_np = np.array(mask_resized, dtype=np.float32) / 255.0
                # Convert to logits (SAM2 expects logits, not probabilities)
                # Use HARD thresholding to avoid fuzzy boundaries that cause leaking
                # Values > 0.5 become strong positive (+20), otherwise strong negative (-20)
                mask_input_logits = np.where(mask_np > 0.5, 20.0, -20.0).astype(np.float32)
                mask_input_logits = mask_input_logits[None, None, :, :]  # Add batch and channel dims
                mask_input_logits = torch.from_numpy(mask_input_logits).to(get_device())
                logger.info(f"Using rough mask input as spatial prior (256x256)")
            except Exception as e:
                logger.warning(f"Failed to process mask_input: {e}")
                mask_input_logits = None

        results = []

        # Calculate points per box
        # If single box, use ALL points; otherwise divide evenly
        num_boxes = len(request.boxes)
        total_points = len(request.points) if request.points else 0
        points_per_box = total_points // num_boxes if num_boxes > 0 and total_points > 0 else 0

        for i, box in enumerate(request.boxes):
            label = request.labels[i] if request.labels and i < len(request.labels) else f"object_{i}"

            # Convert box to numpy array
            box_np = np.array(box)

            # Get point prompts for this box (if provided)
            point_coords = None
            point_labels_np = None

            if request.points and request.point_labels and points_per_box > 0:
                start_idx = i * points_per_box
                end_idx = start_idx + points_per_box
                # For last box, take all remaining points
                if i == num_boxes - 1:
                    end_idx = total_points
                if start_idx < total_points:
                    point_coords = np.array(request.points[start_idx:end_idx])
                    point_labels_np = np.array(request.point_labels[start_idx:end_idx])
                    logger.info(f"  Using {len(point_coords)} point prompts for {label}")

            # Predict mask with box + optional point prompts + optional mask prior
            # Use multimask_output=True to get multiple candidates, then pick BEST one
            predict_kwargs = {
                "box": box_np,
                "point_coords": point_coords,
                "point_labels": point_labels_np,
                "multimask_output": True  # Get multiple masks
            }

            # Add mask_input if available (only for first box or single box mode)
            if mask_input_logits is not None and i == 0:
                predict_kwargs["mask_input"] = mask_input_logits

            masks, scores, _ = sam2_predictor.predict(**predict_kwargs)

            # Use BEST mask (highest score) instead of combining all
            # Combining causes bleeding into nearby objects
            best_idx = int(np.argmax(scores))
            mask = masks[best_idx]
            score = float(scores[best_idx])
            logger.info(f"  Using best mask (idx={best_idx}, score={score:.3f}) for {label}")

            # Convert mask to PNG
            mask_uint8 = (mask * 255).astype(np.uint8)
            mask_img = Image.fromarray(mask_uint8, mode='L')

            buffer = io.BytesIO()
            mask_img.save(buffer, format='PNG')
            mask_b64 = base64.b64encode(buffer.getvalue()).decode('utf-8')

            results.append(MaskResult(
                label=label,
                box=box,
                mask=f"data:image/png;base64,{mask_b64}",
                score=score
            ))

            logger.info(f"  {label}: score={score:.3f}")

        return SegmentResponse(masks=results)

    except Exception as e:
        logger.exception(f"Segmentation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/segment_single")
async def segment_single(
    image: str,  # Base64 image
    x_min: int,
    y_min: int,
    x_max: int,
    y_max: int,
    label: str = "object"
):
    """
    Simplified endpoint for single object segmentation.
    """
    request = SegmentRequest(
        image=image,
        boxes=[[x_min, y_min, x_max, y_max]],
        labels=[label]
    )
    response = await segment_image(request)
    return response.masks[0] if response.masks else None


if __name__ == "__main__":
    import uvicorn

    # Run server
    uvicorn.run(
        app,
        host="0.0.0.0",  # Accept connections from other machines
        port=8666,
        log_level="info"
    )

