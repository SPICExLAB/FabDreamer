"""
FabDreamer Backend (Gemini Version)

FastAPI server that provides AI-powered image segmentation using Google's Gemini API.
This is a drop-in replacement for the original multi-API backend.
"""

import os
import sys
import uuid
import logging
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
import asyncio
import json
from dotenv import load_dotenv

# Add project root to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from services import (
    get_image_analyzer,
    get_segmentation_service,
    get_inpainting_service,
    get_image_generation_service,
    get_layer_pipeline_service,
)
from utils import (
    decode_base64_image,
    encode_image_to_base64,
    get_image_dimensions,
    create_green_background_image,
    png_to_svg,
)

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler('app.log')
    ]
)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="FabDreamer Backend (Gemini)",
    description="AI-powered image segmentation for layered laser-cut art using Gemini API",
    version="2.0.0"
)

# CORS middleware — extra origins (e.g. a deployed frontend) via env:
#   ALLOWED_ORIGINS=https://example.com,https://www.example.com
_default_origins = ["http://localhost:3000", "http://localhost:5173"]
_extra_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_default_origins + _extra_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Output directory for generated files
OUTPUT_DIR = Path(__file__).parent / "output"
OUTPUT_DIR.mkdir(exist_ok=True)


# =============================================================================
# Request/Response Models
# =============================================================================

class DetectAndSegmentRequest(BaseModel):
    """Request model for /detect-and-segment endpoint."""
    base64_image: str


class BoundingBox(BaseModel):
    """Bounding box coordinates."""
    x: float
    y: float
    width: float
    height: float


class Segment(BaseModel):
    """Single segment within a layer."""
    segmentId: str
    svgData: str  # SVG string or base64 PNG
    boundingBox: BoundingBox


class Layer(BaseModel):
    """Layer containing segments."""
    layerId: str
    segments: list[Segment]


class DetectAndSegmentResponse(BaseModel):
    """Response model for /detect-and-segment endpoint."""
    imageId: str
    layers: list[Layer]
    restImage: str  # Base64 encoded final background image


class GenerateImageRequest(BaseModel):
    """Request model for /generate-image endpoint."""
    prompt: str


class GenerateImageResponse(BaseModel):
    """Response model for /generate-image endpoint."""
    images: list[str]  # List of base64 encoded images


class StatusResponse(BaseModel):
    """Response model for /status endpoint."""
    status: str


# =============================================================================
# Layer Pipeline Models (User Confirmation Flow)
# =============================================================================

class LayerElement(BaseModel):
    """Single element within a layer."""
    name: str
    description: Optional[str] = None


class LayerInfo(BaseModel):
    """Layer with elements."""
    layer: int
    description: Optional[str] = None
    elements: list[LayerElement]


class AnalyzeLayersRequest(BaseModel):
    """Request for /analyze-layers endpoint."""
    base64_image: str


class HumanizedLayer(BaseModel):
    """Human-readable layer description."""
    layer: int
    name: str
    description: str


class AnalyzeLayersResponse(BaseModel):
    """Response for /analyze-layers endpoint."""
    session_id: str
    layers: list[LayerInfo]
    humanized: Optional[list[HumanizedLayer]] = None  # Human-readable descriptions


class UpdateLayersRequest(BaseModel):
    """Request for /update-layers endpoint."""
    session_id: str
    layers: Optional[list[LayerInfo]] = None  # Direct layer modifications
    modification_request: Optional[str] = None  # Natural language modification
    current_layers: Optional[list[dict]] = None  # Current layers for context
    reanalyze: bool = False


class UpdateLayersResponse(BaseModel):
    """Response for /update-layers endpoint."""
    session_id: str
    status: str
    layers: list[LayerInfo]
    humanized: Optional[list[HumanizedLayer]] = None  # Human-readable descriptions


class ProcessLayersRequest(BaseModel):
    """Request for /process-layers endpoint."""
    session_id: str
    is_redo: bool = False  # If True, use REDO prompt for extra careful detection


class ProcessedElement(BaseModel):
    """Processed element with mask and extracted image."""
    name: str
    mask: str  # Base64 encoded PNG
    extracted: str  # Base64 encoded PNG
    svg: str = ""  # SVG outline for 3D geometry (from mask_to_svg)
    box_2d: list[int]
    was_completed: bool = False  # True if occlusion completion was used
    completion_note: Optional[str] = None  # Description of what was completed


class ProcessedLayer(BaseModel):
    """Processed layer with elements."""
    layer: int
    elements: list[ProcessedElement]


class ProcessLayersResponse(BaseModel):
    """Response for /process-layers endpoint."""
    session_id: str
    layers: list[ProcessedLayer]
    rest_image: str  # Base64 encoded PNG


class GrabElementsRequest(BaseModel):
    """Request for /grab-elements endpoint."""
    base64_image: str
    element_description: str
    session_id: Optional[str] = None  # Optional client-provided session_id for progress tracking
    enable_occlusion_completion: bool = True  # Enable amodal segmentation for occluded objects


class GrabElementsResponse(BaseModel):
    """Response for /grab-elements endpoint."""
    session_id: str
    elements: list[ProcessedElement]
    rest_image: str  # Base64 encoded PNG
    parsed_query: str  # The actual object name parsed from user input (e.g., "duck" from "get a duck")


class SubSegmentRequest(BaseModel):
    """Request for /sub-segment endpoint."""
    image: str  # Base64 encoded PNG of the segment
    prompt: str  # What to extract from the segment
    segment_id: str  # ID of the parent segment
    transform: Optional[dict] = None  # Transform data (x, y, width, height, rotation, scaleX, scaleY)


class SubSegmentElement(BaseModel):
    """Sub-segment element result."""
    name: str
    mask: str  # Base64 encoded mask PNG
    extracted: str  # Base64 encoded extracted PNG
    svg: str  # SVG string for 3D geometry
    box_2d: list[int]  # [y_min, x_min, y_max, x_max] relative to input PNG (0-1000)


class SubSegmentResponse(BaseModel):
    """Response for /sub-segment endpoint."""
    sub_segments: list[SubSegmentElement]
    rest_segment: Optional[SubSegmentElement] = None  # The remaining segment (tree without apples)
    parsed_query: str


class RepairSegmentRequest(BaseModel):
    """Request for /repair-segment endpoint."""
    image: str          # Base64 encoded extracted segment PNG
    original_image: str # Base64 encoded full scene image
    segment_id: str
    element_name: str = ""  # Name of the element to repair (helps Gemini identify it)


class RepairSegmentResponse(BaseModel):
    """Response for /repair-segment endpoint."""
    repaired_image: str = ""  # Base64 PNG (with transparency)
    svg: str = ""             # Outline SVG from mask
    mask: str = ""            # Base64 mask PNG
    box_2d: list[int] = [0, 0, 1000, 1000]  # [y_min, x_min, y_max, x_max] normalized 0-1000
    success: bool = False


class StylizeImageRequest(BaseModel):
    """Request for /stylize-image endpoint."""
    base64_image: str


class StylizeImageResponse(BaseModel):
    """Response for /stylize-image endpoint."""
    styled_image: str  # Base64 encoded PNG


class UpdateImageRequest(BaseModel):
    """Request for /update-image endpoint."""
    base64_image: str
    original_prompt: str
    update_prompt: str
    is_uploaded: bool = False  # Whether image was uploaded (not AI-generated)
    update_history: list = []  # List of previous update prompts


class UpdateImageResponse(BaseModel):
    """Response for /update-image endpoint."""
    image: str  # Base64 encoded PNG


# =============================================================================
# API Endpoints
# =============================================================================

@app.get("/status", response_model=StatusResponse)
async def status():
    """Health check endpoint."""
    return StatusResponse(status="online")


class ProgressResponse(BaseModel):
    """Response for /session/{session_id}/progress endpoint."""
    status: str  # "processing", "completed", "unknown"
    progress: int  # 0-100
    message: str  # Current step description


@app.get("/session/{session_id}/progress", response_model=ProgressResponse)
async def get_session_progress(session_id: str):
    """Get processing progress for a session.

    Returns progress percentage (0-100) and current step message.
    Poll this endpoint while processing to update UI progress bar.
    """
    pipeline = get_layer_pipeline_service()
    progress = pipeline.get_progress(session_id)
    return ProgressResponse(
        status=progress.get("status", "unknown"),
        progress=progress.get("progress", 0),
        message=progress.get("message", "")
    )


@app.post("/detect-and-segment", response_model=DetectAndSegmentResponse)
async def detect_and_segment(request: DetectAndSegmentRequest):
    """Main processing endpoint - analyze image and return segmented layers.

    This endpoint:
    1. Analyzes the image to detect layers and elements (replaces Qwen)
    2. Detects bounding boxes for each element (replaces Grounding DINO)
    3. Generates segmentation masks (replaces SAM2)
    4. Extracts segments with green background
    5. Converts to SVG
    6. Removes segmented objects for next layer (replaces Stability AI)

    Compatible with the original backend's API format.
    """
    image_id = str(uuid.uuid4())
    logger.info(f"Processing image {image_id}")

    try:
        # Decode input image
        image_data = decode_base64_image(request.base64_image)
        width, height = get_image_dimensions(image_data)
        logger.info(f"Image dimensions: {width}x{height}")

        # Create output directory for this request
        request_dir = OUTPUT_DIR / image_id
        request_dir.mkdir(exist_ok=True)

        # Save original image
        (request_dir / "original.png").write_bytes(image_data)

        # Step 1: Analyze image for layers
        analyzer = get_image_analyzer()
        analysis = await analyzer.analyze_for_layers(image_data)

        if "error" in analysis:
            raise HTTPException(status_code=500, detail=f"Analysis failed: {analysis['error']}")

        logger.info(f"Analysis found {analysis.get('total_layers', 0)} layers")

        # Step 2-5: Process each layer
        segmentation_service = get_segmentation_service()
        inpainting_service = get_inpainting_service()

        layers_response = []
        current_image = image_data  # Image for processing (objects get removed after each layer)

        for layer_data in analysis.get("layers", []):
            layer_num = layer_data.get("layer_number", 1)
            elements = layer_data.get("elements", [])

            if not elements:
                logger.info(f"Layer {layer_num} has no elements, skipping")
                continue

            logger.info(f"Processing layer {layer_num} with {len(elements)} elements")

            layer_dir = request_dir / f"layer_{layer_num}"
            layer_dir.mkdir(exist_ok=True)

            segments = []
            layer_masks = []  # Collect masks for inpainting

            for elem_idx, element in enumerate(elements):
                elem_name = element.get("name", f"element_{elem_idx}")
                box_2d = element.get("box_2d", [0, 0, 1000, 1000])

                logger.info(f"  Processing element: {elem_name}")

                # Generate segmentation mask
                mask_data = await segmentation_service.generate_mask(
                    image_data=current_image,
                    element_name=elem_name,
                    bounding_box=box_2d
                )

                if not mask_data:
                    logger.warning(f"  Failed to generate mask for {elem_name}")
                    continue

                # Save mask
                mask_path = layer_dir / f"mask_{elem_idx}_{elem_name}.png"
                mask_path.write_bytes(mask_data)

                # Extract masked region with green background
                extracted = segmentation_service.extract_masked_region(
                    image_data=current_image,
                    mask_data=mask_data,
                    background_color=(0, 255, 0)
                )

                # Save extracted image
                extracted_path = layer_dir / f"entity_{elem_idx}_{elem_name}.png"
                extracted_path.write_bytes(extracted)

                # Convert to SVG
                try:
                    svg_data = png_to_svg(extracted, background_color=(0, 255, 0))
                    svg_path = layer_dir / f"entity_{elem_idx}_{elem_name}.svg"
                    svg_path.write_text(svg_data)
                except Exception as e:
                    logger.warning(f"  SVG conversion failed: {e}, using PNG fallback")
                    svg_data = encode_image_to_base64(extracted)

                # Convert bounding box to pixel coordinates
                y_min, x_min, y_max, x_max = box_2d
                bbox = BoundingBox(
                    x=x_min * width / 1000,
                    y=y_min * height / 1000,
                    width=(x_max - x_min) * width / 1000,
                    height=(y_max - y_min) * height / 1000
                )

                # Add segment
                segments.append(Segment(
                    segmentId=f"segment_{layer_num}_{elem_idx}",
                    svgData=svg_data,
                    boundingBox=bbox
                ))

                # Collect mask for later inpainting
                layer_masks.append(mask_data)

            # Add layer if it has segments
            if segments:
                layers_response.append(Layer(
                    layerId=f"layer_{layer_num}",
                    segments=segments
                ))

            # Remove objects for next layer (inpainting)
            if layer_masks and layer_num < analysis.get("total_layers", 1):
                logger.info(f"  Inpainting {len(layer_masks)} objects for next layer")
                current_image = await inpainting_service.remove_objects_combined(
                    image_data=current_image,
                    masks=layer_masks
                )

                # Save inpainted image
                inpainted_path = layer_dir / "inpainted.png"
                inpainted_path.write_bytes(current_image)

        # Save final background image
        rest_image_path = request_dir / "rest_image.png"
        rest_image_path.write_bytes(current_image)

        logger.info(f"Completed processing {image_id}: {len(layers_response)} layers")

        return DetectAndSegmentResponse(
            imageId=image_id,
            layers=layers_response,
            restImage=encode_image_to_base64(current_image)
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error processing image {image_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate-image", response_model=GenerateImageResponse)
async def generate_image(request: GenerateImageRequest):
    """Generate multiple images from text prompt.

    Uses Gemini to generate 3 images suitable for layered laser-cut art.
    User can then choose their preferred image.
    """
    logger.info(f"[NEW] Generating 3 images for prompt: {request.prompt[:50]}...")

    try:
        generator = get_image_generation_service()
        images_data = await generator.generate_multiple(request.prompt, count=3)

        if not images_data:
            raise HTTPException(status_code=500, detail="Image generation failed")

        return GenerateImageResponse(
            images=[encode_image_to_base64(img) for img in images_data]
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error generating images: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# Layer Pipeline Endpoints (User Confirmation Flow)
# =============================================================================

@app.post("/analyze-layers", response_model=AnalyzeLayersResponse)
async def analyze_layers(request: AnalyzeLayersRequest):
    """Stage 1: Analyze image and return layer structure for user review.

    This endpoint:
    1. Analyzes the image using Gemini 3 Pro Preview
    2. Identifies layers based on physical depth
    3. Returns JSON with layer/element structure for user confirmation

    The user can then modify the structure and call /update-layers or
    proceed directly to /process-layers.
    """
    logger.info("Analyzing image for layer structure")

    try:
        image_data = decode_base64_image(request.base64_image)
        pipeline = get_layer_pipeline_service()
        result = await pipeline.analyze_layers(image_data)

        if "error" in result:
            raise HTTPException(status_code=500, detail=result["error"])

        # Convert to response model
        layers = []
        for layer_data in result.get("layers", []):
            elements = [
                LayerElement(
                    name=e.get("name", "unknown"),
                    description=e.get("description")
                )
                for e in layer_data.get("elements", [])
            ]
            layers.append(LayerInfo(
                layer=layer_data.get("layer", 1),
                description=layer_data.get("description"),
                elements=elements
            ))

        # Convert humanized data if present
        humanized = None
        if result.get("humanized"):
            humanized = [
                HumanizedLayer(
                    layer=h.get("layer", 1),
                    name=h.get("name", f"Layer {h.get('layer', 1)}"),
                    description=h.get("description", "")
                )
                for h in result.get("humanized", [])
            ]

        return AnalyzeLayersResponse(
            session_id=result["session_id"],
            layers=layers,
            humanized=humanized
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error analyzing layers: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/update-layers", response_model=UpdateLayersResponse)
async def update_layers(request: UpdateLayersRequest):
    """Stage 2: User modifies or confirms layer assignments.

    This endpoint:
    1. Accepts user modifications to the layer structure (via layers field)
    2. Or accepts natural language modification request (via modification_request field)
    3. Optionally re-analyzes if reanalyze=true
    4. Stores the confirmed structure for processing

    After this, call /process-layers to generate masks and extractions.
    """
    logger.info(f"Updating layers for session {request.session_id}")

    try:
        pipeline = get_layer_pipeline_service()

        # Handle natural language modification request
        if request.modification_request and request.current_layers:
            result = await pipeline.modify_layers_with_ai(
                session_id=request.session_id,
                modification_request=request.modification_request,
                current_layers=request.current_layers
            )
        elif request.layers:
            # Convert request to service format (direct layer modifications)
            updated_layers = [
                {
                    "layer": layer.layer,
                    "description": layer.description,
                    "elements": [
                        {"name": e.name, "description": e.description}
                        for e in layer.elements
                    ]
                }
                for layer in request.layers
            ]

            result = await pipeline.update_layers(
                session_id=request.session_id,
                updated_layers=updated_layers,
                reanalyze=request.reanalyze
            )
        else:
            raise HTTPException(status_code=400, detail="Either layers or modification_request required")

        if "error" in result:
            raise HTTPException(status_code=404, detail=result["error"])

        # Convert to response model
        layers = []
        for layer_data in result.get("layers", []):
            elements = [
                LayerElement(
                    name=e.get("name", "unknown"),
                    description=e.get("description")
                )
                for e in layer_data.get("elements", [])
            ]
            layers.append(LayerInfo(
                layer=layer_data.get("layer", 1),
                description=layer_data.get("description"),
                elements=elements
            ))

        # Convert humanized data if present
        humanized = None
        if result.get("humanized"):
            humanized = [
                HumanizedLayer(
                    layer=h.get("layer", 1),
                    name=h.get("name", f"Layer {h.get('layer', 1)}"),
                    description=h.get("description", "")
                )
                for h in result.get("humanized", [])
            ]

        return UpdateLayersResponse(
            session_id=result["session_id"],
            status=result.get("status", "confirmed"),
            layers=layers,
            humanized=humanized
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error updating layers: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/process-layers", response_model=ProcessLayersResponse)
async def process_layers(request: ProcessLayersRequest):
    """Stage 3: Process confirmed layers with batch detection + SAM2 + inpaint.

    This endpoint:
    1. Detects bounding boxes for all elements (batch call per layer)
    2. Generates SAM2 masks for pixel-perfect segmentation
    3. Extracts elements with transparent backgrounds
    4. Inpaints to remove layers for processing subsequent layers

    Returns base64-encoded masks and extracted elements for each layer.
    """
    logger.info(f"Processing layers for session {request.session_id}")

    try:
        pipeline = get_layer_pipeline_service()

        # Initialize progress immediately so frontend doesn't see "Session not found"
        pipeline._update_progress(request.session_id, 0, "Initializing...")

        result = await pipeline.process_confirmed_layers(request.session_id)

        if "error" in result:
            raise HTTPException(status_code=404, detail=result["error"])

        # Convert to response model
        layers = []
        for layer_data in result.get("layers", []):
            elements = [
                ProcessedElement(
                    name=e.get("name", "unknown"),
                    mask=e.get("mask", ""),
                    extracted=e.get("extracted", ""),
                    svg=e.get("svg", ""),
                    box_2d=e.get("box_2d", [])
                )
                for e in layer_data.get("elements", [])
            ]
            layers.append(ProcessedLayer(
                layer=layer_data.get("layer", 1),
                elements=elements
            ))

        return ProcessLayersResponse(
            session_id=result["session_id"],
            layers=layers,
            rest_image=result.get("rest_image", "")
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error processing layers: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/process-layers-stream")
async def process_layers_stream(request: ProcessLayersRequest):
    """Stage 3 (Streaming): Process layers with SSE for real-time element display.

    Streams elements as they're segmented:
    - event: element - Each extracted element with mask, extracted image, and metadata
    - event: layer_complete - Signals a layer is done (for inpainting)
    - event: complete - All processing done, includes rest_image

    Frontend can display elements as they arrive instead of waiting for all.

    If is_redo=True, uses REDO_BATCH_DETECTION_PROMPT for extra careful detection.
    """
    redo_label = " (REDO)" if request.is_redo else ""
    logger.info(f"Streaming layer processing{redo_label} for session {request.session_id}")

    async def generate_events():
        try:
            pipeline = get_layer_pipeline_service()

            # Initialize progress
            pipeline._update_progress(request.session_id, 0, "Initializing...")

            # Use streaming version that yields elements (pass is_redo for careful prompt)
            async for event in pipeline.process_confirmed_layers_stream(request.session_id, is_redo=request.is_redo):
                event_type = event.get("type", "unknown")
                data = json.dumps(event)
                yield f"event: {event_type}\ndata: {data}\n\n"

        except Exception as e:
            logger.exception(f"Error in streaming: {e}")
            error_event = json.dumps({"type": "error", "message": str(e)})
            yield f"event: error\ndata: {error_event}\n\n"

    return StreamingResponse(
        generate_events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        }
    )


class RedoFromLayerRequest(BaseModel):
    """Request to redo segmentation from a specific layer."""
    session_id: str
    from_layer: int
    only_this_layer: bool = False  # If True, redo only this layer (no cascade)


@app.post("/redo-from-layer")
async def redo_from_layer(request: RedoFromLayerRequest):
    """Redo segmentation from a specific layer (streaming).

    This re-processes the specified layer and all subsequent layers,
    using the stored input image for that layer.

    IMPORTANT: Gemini API calls have inherent randomness. This redo feature
    is designed to help when a layer's segmentation is suboptimal due to
    that randomness. Each redo attempt may produce different results.

    Use case: If L2 extraction is bad, user can redo from L2. This will:
    1. Re-detect elements in L2 using the stored input image
    2. Re-generate SAM2 masks
    3. Re-inpaint L2 elements
    4. Cascade to re-process L3, L4, L5, etc.

    Streams events:
    - redo_start: Beginning redo process
    - detecting: Detecting elements in a layer
    - element: An element was extracted
    - inpainting: Inpainting a layer
    - layer_warning: Warning (e.g., no elements detected)
    - redo_complete: All done with redo results
    - error: An error occurred
    """
    logger.info(f"Redo from layer {request.from_layer} for session {request.session_id}")

    async def generate_events():
        try:
            pipeline = get_layer_pipeline_service()

            # Use streaming redo method
            async for event in pipeline.redo_from_layer_stream(
                request.session_id,
                request.from_layer,
                only_this_layer=request.only_this_layer
            ):
                event_type = event.get("type", "unknown")
                data = json.dumps(event)
                yield f"event: {event_type}\ndata: {data}\n\n"

        except Exception as e:
            logger.exception(f"Error in redo streaming: {e}")
            error_event = json.dumps({"type": "error", "message": str(e)})
            yield f"event: error\ndata: {error_event}\n\n"

    return StreamingResponse(
        generate_events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        }
    )


@app.post("/grab-elements", response_model=GrabElementsResponse)
async def grab_elements(request: GrabElementsRequest):
    """Grab specific elements from image without full layer analysis.

    This is a simplified flow where user describes what they want
    (e.g., "the duck in the center") and we extract just those elements
    along with the rest image.

    Skips the layer analysis step and goes straight to segmentation.
    """
    logger.info(f"Grabbing elements: {request.element_description[:50]}...")

    try:
        image_data = decode_base64_image(request.base64_image)
        pipeline = get_layer_pipeline_service()

        # Initialize progress if session_id provided
        if request.session_id:
            pipeline._update_progress(request.session_id, 0, "Initializing...")

        result = await pipeline.grab_elements(
            image_data,
            request.element_description,
            session_id=request.session_id,
            enable_occlusion_completion=request.enable_occlusion_completion
        )

        if "error" in result:
            # Return error as JSON (not HTTPException) so frontend can show user-friendly message
            # Include parsed_query so frontend can show what was searched for
            return JSONResponse(content={
                "error": result["error"],
                "parsed_query": result.get("parsed_query", request.element_description)
            }, status_code=200)

        # Convert to response model
        elements = [
            ProcessedElement(
                name=e.get("name", "unknown"),
                mask=e.get("mask", ""),
                extracted=e.get("extracted", ""),
                svg=e.get("svg", ""),
                box_2d=e.get("box_2d", []),
                was_completed=e.get("was_completed", False),
                completion_note=e.get("completion_note")
            )
            for e in result.get("elements", [])
        ]

        return GrabElementsResponse(
            session_id=result["session_id"],
            elements=elements,
            rest_image=result.get("rest_image", ""),
            parsed_query=result.get("parsed_query", request.element_description)
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error grabbing elements: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/sub-segment", response_model=SubSegmentResponse)
async def sub_segment(request: SubSegmentRequest):
    """Break a segment into smaller sub-segments based on user prompt.

    This endpoint:
    1. Takes an extracted segment PNG
    2. Uses Gemini to detect sub-elements based on user prompt
    3. Uses SAM2 to generate precise masks
    4. Returns sub-segments with masks, extracted PNGs, and SVG data

    The sub-segments have box_2d positions relative to the input PNG (0-1000 normalized).
    Frontend is responsible for transforming these to canvas coordinates.
    """
    logger.info(f"Sub-segmenting: {request.prompt[:50]}...")

    try:
        image_data = decode_base64_image(request.image)
        pipeline = get_layer_pipeline_service()

        result = await pipeline.sub_segment(
            image_data=image_data,
            prompt=request.prompt,
            segment_id=request.segment_id,
            transform=request.transform
        )

        if "error" in result and not result.get("sub_segments"):
            # Return error as JSON (not HTTPException) so frontend can show user-friendly message
            return JSONResponse(content={
                "error": result["error"],
                "sub_segments": [],
                "parsed_query": result.get("parsed_query", request.prompt)
            }, status_code=200)

        # Convert to response model
        sub_segments = [
            SubSegmentElement(
                name=s.get("name", "unknown"),
                mask=s.get("mask", ""),
                extracted=s.get("extracted", ""),
                svg=s.get("svg", ""),
                box_2d=s.get("box_2d", [0, 0, 1000, 1000])
            )
            for s in result.get("sub_segments", [])
        ]

        # Include rest_segment if present (the remaining part after extraction)
        rest_segment = None
        if result.get("rest_segment"):
            r = result["rest_segment"]
            rest_segment = SubSegmentElement(
                name=r.get("name", "rest"),
                mask=r.get("mask", ""),
                extracted=r.get("extracted", ""),
                svg=r.get("svg", ""),
                box_2d=r.get("box_2d", [0, 0, 1000, 1000])
            )

        return SubSegmentResponse(
            sub_segments=sub_segments,
            rest_segment=rest_segment,
            parsed_query=result.get("parsed_query", request.prompt)
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error sub-segmenting: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/repair-segment", response_model=RepairSegmentResponse)
async def repair_segment(request: RepairSegmentRequest):
    """Repair a noisy segment extraction using Gemini image model.

    Takes the extracted segment PNG + original scene image,
    sends to Gemini on magenta background, derives clean mask via chroma-key.
    """
    logger.info(f"Repairing segment: {request.segment_id}")

    try:
        image_data = decode_base64_image(request.image)
        original_image_data = decode_base64_image(request.original_image)
        pipeline = get_layer_pipeline_service()

        result = await pipeline.repair_segment(
            image_data=image_data,
            original_image_data=original_image_data,
            segment_id=request.segment_id,
            element_name=request.element_name,
        )

        return RepairSegmentResponse(
            repaired_image=result.get("repaired_image", ""),
            svg=result.get("svg", ""),
            mask=result.get("mask", ""),
            box_2d=result.get("box_2d", [0, 0, 1000, 1000]),
            success=result.get("success", False),
        )

    except Exception as e:
        logger.exception(f"Error repairing segment: {e}")
        return RepairSegmentResponse(success=False)


@app.post("/stylize-image", response_model=StylizeImageResponse)
async def stylize_image(request: StylizeImageRequest):
    """Transform uploaded photo into laser-cut friendly illustration style.

    Uses Gemini 3 Pro with thinking mode (Nano Banana Pro visual engine)
    for sophisticated style transfer optimized for laser cutting.

    This endpoint:
    1. Takes a raw photo (typically from iPhone/camera)
    2. Transforms it into a flat, simplified illustration style
    3. Returns stylized image suitable for segmentation

    The stylized image will have:
    - Flat, solid colors (no gradients)
    - Clear, bold outlines
    - High contrast between elements
    - Clean edges suitable for vector conversion
    """
    logger.info("Stylizing image for laser cutting...")

    try:
        from services.gemini_client import get_gemini_client

        image_data = decode_base64_image(request.base64_image)
        client = get_gemini_client()

        styled_data = await client.stylize_for_laser_cut(image_data)

        if styled_data is None:
            raise HTTPException(status_code=500, detail="Stylization failed - no image generated")

        return StylizeImageResponse(
            styled_image=encode_image_to_base64(styled_data)
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error stylizing image: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/update-image", response_model=UpdateImageResponse)
async def update_image(request: UpdateImageRequest):
    """Update an image with multi-turn editing.

    Uses Gemini 3 Pro Image for intelligent image modification
    while maintaining the laser-cut friendly style.

    This endpoint:
    1. Takes current image and change request
    2. Applies the requested modification
    3. Maintains style consistency across edits
    4. Tracks edit history for multi-turn context
    """
    logger.info(f"Updating image with: {request.update_prompt}")

    try:
        from services.gemini_client import get_gemini_client

        image_data = decode_base64_image(request.base64_image)
        client = get_gemini_client()

        updated_data = await client.update_image(
            image_data=image_data,
            original_prompt=request.original_prompt,
            update_prompt=request.update_prompt,
            update_history=request.update_history,
            is_uploaded=request.is_uploaded,
        )

        if updated_data is None:
            raise HTTPException(status_code=500, detail="Image update failed - no image generated")

        return UpdateImageResponse(
            image=encode_image_to_base64(updated_data)
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error updating image: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# Fabrication Agent Endpoints
# =============================================================================

class FabricationAgentRequest(BaseModel):
    """Request for /fabrication-agent endpoint."""
    message: str
    layer_data: dict  # Current layer state from frontend
    conversation_history: list = []  # Previous messages


class ToolCall(BaseModel):
    """A tool that was called by the agent."""
    tool: str
    args: dict


class ToolResult(BaseModel):
    """Result from a tool execution."""
    tool: str
    result: dict


class FabricationAgentResponse(BaseModel):
    """Response from /fabrication-agent endpoint."""
    response: str  # Agent's text response
    tool_calls: list[ToolCall]  # Tools that were called
    tool_results: list[ToolResult]  # Results from tools
    highlights: list[dict]  # Parts to highlight on canvas
    svg_updates: list[dict]  # SVG modifications to apply


@app.post("/fabrication-agent", response_model=FabricationAgentResponse)
async def fabrication_agent_chat(request: FabricationAgentRequest):
    """Chat with the fabrication agent.
    
    The agent can analyze designs for fabrication issues (floating parts,
    thin areas, etc.) and suggest or apply fixes using function calling.
    
    Send a message with the current layer data, and the agent will:
    1. Analyze the design using its tools
    2. Identify issues
    3. Suggest or apply fixes
    4. Return a response with tool call history
    
    Example messages:
    - "Analyze my design for issues"
    - "Are there any floating parts?"
    - "Fix all floating parts"
    - "Add tabs to the tree"
    """
    logger.info(f"Fabrication agent request: {request.message[:50]}...")
    
    try:
        from services.fabrication_agent import get_fabrication_agent
        
        agent = get_fabrication_agent()
        result = await agent.chat(
            message=request.message,
            layer_data=request.layer_data,
            conversation_history=request.conversation_history
        )
        
        return FabricationAgentResponse(
            response=result.get("response", ""),
            tool_calls=[ToolCall(**tc) for tc in result.get("tool_calls", [])],
            tool_results=[ToolResult(**tr) for tr in result.get("tool_results", [])],
            highlights=result.get("highlights", []),
            svg_updates=result.get("svg_updates", [])
        )
        
    except Exception as e:
        logger.exception(f"Fabrication agent error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/fabrication-agent/stream")
async def fabrication_agent_stream(request: FabricationAgentRequest):
    """Stream chat with the fabrication agent using Server-Sent Events.
    
    This endpoint streams events as they happen:
    - tool_call_start: When a tool call begins
    - tool_call: When tool call arguments are ready
    - tool_result: When a tool returns results
    - text: Streaming text response chunks
    - highlight: Parts to highlight on canvas
    - done: Final state with all highlights and svg_updates
    - error: If something goes wrong
    
    Client should use EventSource or fetch with streaming to consume.
    """
    logger.info(f"Fabrication agent stream request: {request.message[:50]}...")
    
    async def event_generator():
        try:
            from services.fabrication_agent import get_fabrication_agent
            
            agent = get_fabrication_agent()
            
            async for event in agent.chat_stream(
                message=request.message,
                layer_data=request.layer_data,
                conversation_history=request.conversation_history
            ):
                # Format as SSE
                data = json.dumps(event, default=str)
                yield f"data: {data}\n\n"
                
        except Exception as e:
            logger.exception(f"Fabrication agent stream error: {e}")
            error_event = json.dumps({"type": "error", "message": str(e)})
            yield f"data: {error_event}\n\n"
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        }
    )


# =============================================================================
# Direct Thin-Area Detection Endpoint (no AI agent, pure geometry)
# =============================================================================

class ThinDetectionRequest(BaseModel):
    """Request for /detect-thin-areas endpoint."""
    layer_data: dict  # { layers: [...], fabrication: { scale }, canvasSize: { width, height } }


@app.post("/detect-thin-areas")
async def detect_thin_areas_endpoint(request: ThinDetectionRequest):
    """Run thin-area detection on all layers without going through the AI agent.

    Called when the fabrication scale slider changes — much faster than a full
    agent round-trip since it's pure computational geometry.
    """
    from utils.geometry_analyzer import analyze_thin_areas_for_layer

    layer_data = request.layer_data
    layers = layer_data.get("layers", [])
    fab = layer_data.get("fabrication", {})
    fabrication_scale = float(fab.get("scale", 1.0))
    canvas = layer_data.get("canvasSize", {})
    editing_width = float(canvas.get("width", 0))
    editing_height = float(canvas.get("height", 0))

    per_layer = []
    for layer in layers:
        layer_id = layer.get("id")
        min_width_mm = float(layer.get("minWidthMm") or layer.get("min_width_mm") or 1.0)

        thin_areas = analyze_thin_areas_for_layer(
            layer,
            min_width_mm=min_width_mm,
            editing_width=editing_width,
            editing_height=editing_height,
            fabrication_scale=fabrication_scale,
        )

        per_layer.append({
            "layer_id": layer_id,
            "layer_name": layer.get("name", str(layer_id)),
            "thin_areas_detail": thin_areas,
            "thin_areas": len(thin_areas),
            "min_width_mm": min_width_mm,
        })

    return {
        "per_layer": per_layer,
        "total_thin_areas": sum(lr["thin_areas"] for lr in per_layer),
    }


# =============================================================================
# DXF Export Endpoint
# =============================================================================

class ExportRequest(BaseModel):
    """Request for /export-dxf endpoint."""
    layer_data: dict
    format: str = "dxf"


@app.post("/export-dxf")
async def export_dxf(request: ExportRequest):
    """Export a layer as DXF file for laser cutting.
    
    Converts SVG cut/engrave paths to DXF format compatible with
    most laser cutter software.
    """
    from fastapi.responses import Response
    
    try:
        from utils.geometry_analyzer import export_layer_to_dxf
        
        dxf_bytes = export_layer_to_dxf(request.layer_data)
        
        layer_name = request.layer_data.get("name", "layer").replace(" ", "_").lower()
        filename = f"{layer_name}.dxf"
        
        return Response(
            content=dxf_bytes,
            media_type="application/dxf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'}
        )
    except Exception as e:
        logger.exception(f"DXF export error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# Direct Bridge Endpoint (bypasses agent for user-drawn bridges)
# =============================================================================

class AddBridgeRequest(BaseModel):
    """Request for /add-bridge endpoint."""
    layer_data: dict
    from_part_id: str
    to_part_id: str = "boundary"
    bridge_width_mm: float = 3.0
    from_point: Optional[dict] = None  # {x, y} in SVG coords
    to_point: Optional[dict] = None    # {x, y} in SVG coords
    editing_width: float = 0
    editing_height: float = 0
    fabrication_scale: float = 1.0
    board_size_mm: float = 304.8


@app.post("/add-bridge")
async def add_bridge_direct(request: AddBridgeRequest):
    """Add a bridge directly without going through the agent.

    Used for user-drawn bridges where coordinates are already known.
    Returns the bridge SVG and updated segment SVG.
    """
    from utils.geometry_analyzer import generate_fix_svg

    try:
        fix_params = {
            "from_part_id": request.from_part_id,
            "to_part_id": request.to_part_id,
            "bridge_width_mm": request.bridge_width_mm,
        }

        if request.from_point and request.to_point:
            fix_params["from_point"] = (request.from_point["x"], request.from_point["y"])
            fix_params["to_point"] = (request.to_point["x"], request.to_point["y"])

        # Simple approach: just generate the bridge polygon as a new segment.
        # Don't modify existing segments — avoids all coordinate/union complexity.
        fix_params["bridge_only"] = True

        result = generate_fix_svg(
            "add_bridge",
            request.layer_data,
            fix_params,
            editing_width=request.editing_width,
            editing_height=request.editing_height,
            fabrication_scale=request.fabrication_scale,
            board_size_mm=request.board_size_mm,
        )

        return result

    except Exception as e:
        logger.exception(f"Error adding bridge: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# Test/Dev Endpoints
# =============================================================================

@app.get("/test-data")
async def get_test_data():
    """DEV: Get pre-generated test data for UI testing.

    Returns the test-session data so frontend can test without running
    the full generate → analyze → segment flow.

    Prefers output/test-session (which has layer directories with extracted images)
    over pipeline_output (which may only have original and layers_info.json).
    """
    import base64
    import json

    # Prefer test-session which has complete extracted data
    test_session_dir = Path(__file__).parent / "output" / "test-session"
    pipeline_output = Path(__file__).parent / "pipeline_output"

    # Use test-session if it exists and has layer directories, otherwise fall back to pipeline_output
    if test_session_dir.exists() and any(test_session_dir.glob("layer_*")):
        pipeline_output = test_session_dir
        logger.info(f"Using test-session data: {pipeline_output}")
    elif not pipeline_output.exists():
        raise HTTPException(status_code=404, detail="No test data found. Run test_full_pipeline.py first.")

    try:
        # Load original image
        original_path = pipeline_output / "00_original.png"
        if not original_path.exists():
            raise HTTPException(status_code=404, detail="Original image not found")

        original_b64 = base64.b64encode(original_path.read_bytes()).decode()

        # Load layers info
        layers_info_path = pipeline_output / "layers_info.json"
        layers_info = json.loads(layers_info_path.read_text()) if layers_info_path.exists() else {}

        # Build analysis layers from layers_info.json (not from processed directories)
        # This allows testing V2 pipeline which processes from analysis
        analysis_layers = []
        for layer_data in layers_info.get("layers", []):
            analysis_layers.append({
                "layer": layer_data.get("layer", 1),
                "elements": [
                    {"name": e.get("name", "unknown")}
                    for e in layer_data.get("elements", [])
                ]
            })

        # Check if there are processed layer directories (from V1 or V2)
        processed_layers = []
        layer_dirs = sorted([d for d in pipeline_output.iterdir() if d.is_dir() and d.name.startswith("layer_")])

        for layer_dir in layer_dirs:
            layer_num = int(layer_dir.name.split("_")[1])
            elements = []

            # Find all extracted images in this layer
            for extracted_file in sorted(layer_dir.glob("extracted_*.png")):
                elem_name = extracted_file.stem.replace("extracted_", "")

                # Load extracted image
                extracted_b64 = base64.b64encode(extracted_file.read_bytes()).decode()

                # Load corresponding mask
                mask_file = layer_dir / f"mask_{elem_name}.png"
                mask_b64 = ""
                box_2d = [0, 0, 1000, 1000]  # default

                svg_string = ""
                if mask_file.exists():
                    mask_bytes = mask_file.read_bytes()
                    mask_b64 = base64.b64encode(mask_bytes).decode()

                    # Generate SVG from mask for 3D geometry
                    try:
                        from utils.svg_converter import mask_to_svg
                        svg_string = mask_to_svg(mask_bytes)
                        logger.info(f"  Test data: Generated SVG for {elem_name} ({len(svg_string)} chars)")
                    except Exception as e:
                        logger.warning(f"  Test data: Failed to generate SVG for {elem_name}: {e}")

                    # Compute box_2d from mask (don't rely on layers_info.json)
                    try:
                        from PIL import Image
                        import numpy as np
                        import io
                        mask_img = Image.open(io.BytesIO(mask_bytes)).convert('L')
                        mask_array = np.array(mask_img)
                        height, width = mask_array.shape

                        # Find non-zero pixels (white = mask area)
                        rows = np.any(mask_array > 128, axis=1)
                        cols = np.any(mask_array > 128, axis=0)

                        if np.any(rows) and np.any(cols):
                            y_indices = np.where(rows)[0]
                            x_indices = np.where(cols)[0]
                            y_min = int(y_indices[0] * 1000 / height)
                            y_max = int(y_indices[-1] * 1000 / height)
                            x_min = int(x_indices[0] * 1000 / width)
                            x_max = int(x_indices[-1] * 1000 / width)
                            box_2d = [y_min, x_min, y_max, x_max]
                    except Exception as e:
                        logger.warning(f"Failed to compute box_2d from mask: {e}")
                        # Fallback to layers_info.json if mask computation fails
                        for ld in layers_info.get("layers", []):
                            if ld.get("layer") == layer_num:
                                for elem in ld.get("elements", []):
                                    if elem.get("name") == elem_name:
                                        box_2d = elem.get("box_2d", box_2d)
                                        break

                elements.append({
                    "name": elem_name,
                    "mask": mask_b64,
                    "extracted": extracted_b64,
                    "svg": svg_string,
                    "box_2d": box_2d
                })

            if elements:
                processed_layers.append({
                    "layer": layer_num,
                    "elements": elements
                })

        # Load rest image (from last layer or final)
        rest_image_b64 = ""
        # Try to find the rest image from the last layer's input (which is the inpainted result)
        if layer_dirs:
            last_layer_input = layer_dirs[-1] / "00_input.png"
            if last_layer_input.exists():
                rest_image_b64 = base64.b64encode(last_layer_input.read_bytes()).decode()

        # Register this session in the pipeline so API calls work
        pipeline = get_layer_pipeline_service()

        # Generate humanized descriptions from layers_info
        # Format: [{"layer": 1, "name": "Front layer", "description": "element1, element2, ..."}]
        humanized_list = layers_info.get("humanized", [])
        if not humanized_list:
            # Build humanized from layer descriptions
            humanized_list = []
            for layer_data in layers_info.get("layers", []):
                layer_num = layer_data.get("layer", 1)
                # Use layer description as name if available
                layer_desc = layer_data.get("description", "")
                layer_name = layer_desc if layer_desc else (
                    "Front layer" if layer_num == 1 else
                    "Middle layer" if layer_num == 2 else
                    f"Back layer"
                )
                # Element names as description
                elements = [e.get("name", "unknown") for e in layer_data.get("elements", [])]
                humanized_list.append({
                    "layer": layer_num,
                    "name": layer_name,
                    "description": ", ".join(elements)
                })

        # Create session directory in output folder (if not already using test-session)
        session_dir = Path(__file__).parent / "output" / "test-session"
        session_dir.mkdir(parents=True, exist_ok=True)

        # Only copy if source is different from target
        if pipeline_output != session_dir:
            import shutil
            shutil.copy(original_path, session_dir / "00_original.png")
            # Save layers_info to session dir
            with open(session_dir / "layers_info.json", "w") as f:
                json.dump(layers_info, f, indent=2)

        pipeline._sessions["test-session"] = {
            "image_data": original_path.read_bytes(),
            "layers_info": layers_info,
            "humanized": {"layers": humanized_list} if isinstance(humanized_list, list) else humanized_list,
        }
        logger.info("Registered test-session in pipeline for API calls")

        # Load secondary test session (noisy set) for Image 3 repair testing
        secondary_session = None
        secondary_dir = Path(__file__).parent / "output" / "8a7caeb5-d5e4-41d9-8ff7-96c08827b4ff"
        if secondary_dir.exists() and any(secondary_dir.glob("layer_*")):
            try:
                sec_original_path = secondary_dir / "00_original.png"
                sec_original_b64 = base64.b64encode(sec_original_path.read_bytes()).decode() if sec_original_path.exists() else ""

                sec_layers_info_path = secondary_dir / "layers_info.json"
                sec_layers_info = json.loads(sec_layers_info_path.read_text()) if sec_layers_info_path.exists() else {}

                sec_analysis_layers = []
                for layer_data in sec_layers_info.get("layers", []):
                    sec_analysis_layers.append({
                        "layer": layer_data.get("layer", 1),
                        "elements": [{"name": e.get("name", "unknown")} for e in layer_data.get("elements", [])]
                    })

                sec_processed_layers = []
                sec_layer_dirs = sorted([d for d in secondary_dir.iterdir() if d.is_dir() and d.name.startswith("layer_")])
                for layer_dir in sec_layer_dirs:
                    layer_num = int(layer_dir.name.split("_")[1])
                    elements = []
                    for extracted_file in sorted(layer_dir.glob("extracted_*.png")):
                        elem_name = extracted_file.stem.replace("extracted_", "")
                        extracted_b64_sec = base64.b64encode(extracted_file.read_bytes()).decode()
                        mask_file = layer_dir / f"mask_{elem_name}.png"
                        mask_b64_sec = ""
                        svg_string_sec = ""
                        box_2d_sec = [0, 0, 1000, 1000]
                        if mask_file.exists():
                            mask_bytes_sec = mask_file.read_bytes()
                            mask_b64_sec = base64.b64encode(mask_bytes_sec).decode()
                            try:
                                from utils.svg_converter import mask_to_svg
                                svg_string_sec = mask_to_svg(mask_bytes_sec)
                            except Exception:
                                pass
                            try:
                                from PIL import Image
                                import numpy as np
                                import io
                                mask_img_sec = Image.open(io.BytesIO(mask_bytes_sec)).convert('L')
                                mask_array_sec = np.array(mask_img_sec)
                                h, w = mask_array_sec.shape
                                rows = np.any(mask_array_sec > 128, axis=1)
                                cols = np.any(mask_array_sec > 128, axis=0)
                                if np.any(rows) and np.any(cols):
                                    yi = np.where(rows)[0]
                                    xi = np.where(cols)[0]
                                    box_2d_sec = [int(yi[0]*1000/h), int(xi[0]*1000/w), int(yi[-1]*1000/h), int(xi[-1]*1000/w)]
                            except Exception:
                                pass
                        elements.append({"name": elem_name, "mask": mask_b64_sec, "extracted": extracted_b64_sec, "svg": svg_string_sec, "box_2d": box_2d_sec})
                    if elements:
                        sec_processed_layers.append({"layer": layer_num, "elements": elements})

                sec_rest_b64 = ""
                sec_rest_path = secondary_dir / "rest_image.png"
                if sec_rest_path.exists():
                    sec_rest_b64 = base64.b64encode(sec_rest_path.read_bytes()).decode()

                sec_humanized = []
                for layer_data in sec_layers_info.get("layers", []):
                    ln = layer_data.get("layer", 1)
                    elems = [e.get("name", "unknown") for e in layer_data.get("elements", [])]
                    sec_humanized.append({"layer": ln, "name": layer_data.get("description", f"Layer {ln}"), "description": ", ".join(elems)})

                # Register secondary session
                pipeline._sessions["test-session-2"] = {
                    "image_data": sec_original_path.read_bytes() if sec_original_path.exists() else b"",
                    "layers_info": sec_layers_info,
                    "humanized": {"layers": sec_humanized},
                }

                secondary_session = {
                    "session_id": "test-session-2",
                    "original_image": f"data:image/png;base64,{sec_original_b64}",
                    "layers": sec_processed_layers,
                    "analysis_layers": sec_analysis_layers,
                    "rest_image": sec_rest_b64,
                    "humanized": sec_humanized,
                }
                logger.info(f"Loaded secondary test session with {len(sec_processed_layers)} layers")
            except Exception as e:
                logger.warning(f"Failed to load secondary test session: {e}")

        return {
            "session_id": "test-session",
            "original_image": f"data:image/png;base64,{original_b64}",
            "layers": processed_layers,  # Processed segments (may be empty)
            "analysis_layers": analysis_layers,  # Analysis from layers_info.json
            "rest_image": rest_image_b64,
            "humanized": humanized_list,  # Human-readable layer descriptions
            "secondary_session": secondary_session,  # Noisy set for repair testing
        }

    except Exception as e:
        logger.exception(f"Error loading test data: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/test-analyze")
async def get_test_analyze():
    """DEV: Load test image and return analysis (like /analyze-layers).

    Use this to test V2 processing without running the full flow.
    Returns data in same format as /analyze-layers so frontend can
    then call /process-layers-v2.
    """
    import base64
    import json

    pipeline_output = Path(__file__).parent / "pipeline_output"

    if not pipeline_output.exists():
        raise HTTPException(status_code=404, detail="No test data found")

    try:
        # Load original image
        original_path = pipeline_output / "00_original.png"
        if not original_path.exists():
            raise HTTPException(status_code=404, detail="Original image not found")

        original_b64 = base64.b64encode(original_path.read_bytes()).decode()

        # Load layers info
        layers_info_path = pipeline_output / "layers_info.json"
        if not layers_info_path.exists():
            raise HTTPException(status_code=404, detail="layers_info.json not found")

        layers_info = json.loads(layers_info_path.read_text())

        # Register session in V1 pipeline (V2 imports from V1)
        pipeline = get_layer_pipeline_service()
        pipeline._sessions["test-session"] = {
            "image_data": original_path.read_bytes(),
            "layers_info": layers_info,
            "status": "analyzed"
        }
        logger.info("Registered test-session for V2 testing")

        # Convert to response format (same as /analyze-layers)
        layers = []
        for layer_data in layers_info.get("layers", []):
            elements = [
                LayerElement(
                    name=e.get("name", "unknown"),
                    description=e.get("description")
                )
                for e in layer_data.get("elements", [])
            ]
            layers.append(LayerInfo(
                layer=layer_data.get("layer", 1),
                description=layer_data.get("description"),
                elements=elements
            ))

        return {
            "session_id": "test-session",
            "original_image": f"data:image/png;base64,{original_b64}",
            "layers": [l.model_dump() for l in layers],
            "humanized": layers_info.get("humanized", [])
        }

    except Exception as e:
        logger.exception(f"Error loading test analyze: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# Main Entry Point
# =============================================================================

if __name__ == "__main__":
    import uvicorn

    # Get configuration from environment
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))

    # Check for required environment variables
    if not os.getenv("GEMINI_API_KEY"):
        logger.error("GEMINI_API_KEY environment variable not set!")
        logger.error("Please set it in .env file or environment")
        sys.exit(1)

    logger.info(f"Starting FabDreamer Backend (Gemini) on {host}:{port}")

    # Optional: ngrok tunnel for public access
    ngrok_token = os.getenv("NGROK_AUTH_TOKEN")
    ngrok_domain = os.getenv("NGROK_DOMAIN")

    if ngrok_token and ngrok_domain:
        try:
            import pyngrok
            from pyngrok import ngrok

            ngrok.set_auth_token(ngrok_token)
            tunnel = ngrok.connect(port, domain=ngrok_domain)
            logger.info(f"ngrok tunnel established: {tunnel.public_url}")
        except ImportError:
            logger.warning("pyngrok not installed, skipping ngrok tunnel")
        except Exception as e:
            logger.warning(f"Failed to establish ngrok tunnel: {e}")

    # Run server
    uvicorn.run(app, host=host, port=port)
