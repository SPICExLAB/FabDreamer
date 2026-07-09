#!/usr/bin/env python3
"""
Full Layer-by-Layer Pipeline Test

Workflow:
1. Gemini identifies layers with specific descriptions
2. For each layer (front to back):
   a. Detect each element's bounding box (PARALLEL)
   b. Generate SAM2 masks for each element
   c. Save: layer image with boxes, individual masks, extracted elements
   d. Inpaint to remove layer elements (combined mask)
   e. Use inpainted image for next layer

Output structure:
  pipeline_output/
    00_original.png
    layer_1/
      00_input.png            - Input image for this layer
      01_boxes.png            - Image with bounding boxes drawn
      mask_*.png              - Individual masks
      extracted_*.png         - Extracted elements
    layer_2/
      00_input.png            - Inpainted result from layer 1
      ...
"""

import asyncio
import json
import os
import time
from PIL import Image, ImageDraw, ImageFont
import io
import re

import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
load_dotenv()

from google import genai
from google.genai import types
from services.segmentation import get_segmentation_service
from services.inpainting import get_inpainting_service

TEST_IMAGE = os.environ.get("TEST_IMAGE", "test_images/duck_pond.png")
OUTPUT_DIR = "pipeline_output"

# Timing tracker
timings = {}

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


async def identify_layers(client, image_data: bytes) -> dict:
    """Stage 1: Identify layers with specific element descriptions."""

    prompt = """Analyze this image for laser-cut art layers based on PHYSICAL DEPTH (Z-distance from camera).

CRITICAL RULES:
1. Layer by PHYSICAL DEPTH only, NOT by color or visual similarity
2. An "Atomic Object" is a SINGLE physical entity - NEVER split parts of one object into different layers
   - Example: A duck (body + beak + eye) is ONE atomic object, even if parts have different colors
3. For repetitive elements (clouds, lily pads), detect EACH INDIVIDUAL instance separately
   - Use names like "left-cloud", "center-cloud", "right-cloud" - NOT "clouds"
4. Layer 1 = frontmost (closest to viewer), higher numbers = further back

Return JSON:
{
  "layers": [
    {
      "layer": 1,
      "description": "frontmost elements",
      "elements": [
        {"name": "unique-name-with-location", "description": "specific location and full object description"}
      ]
    }
  ]
}

Additional Rules:
- Include location hints (left, right, center, top, bottom) in EVERY element name
- Maximum 5 layers
- Exclude solid backgrounds (sky, water surface)
- Each element must be a SINGLE detectable object with ONE bounding box"""

    mime_type = "image/png" if image_data[:3] != b'\xff\xd8\xff' else "image/jpeg"

    response = client.models.generate_content(
        model="gemini-3.1-pro-preview",
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
            max_output_tokens=8192,
            media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
        )
    )

    text = response.text
    if text is None:
        print("ERROR: Gemini returned None for layer analysis")
        print(f"Response object: {response}")
        return {"layers": []}

    if "```json" in text:
        text = text.split("```json")[1].split("```")[0]
    elif "```" in text:
        text = text.split("```")[1].split("```")[0]

    return json.loads(text.strip())


async def detect_element(client, image_data: bytes, name: str, description: str) -> dict:
    """Detect ONE specific element by its description with pixel-perfect precision.

    DEPRECATED: Use detect_layer_elements for batch detection.
    """

    prompt = f"""You are an API. Return ONLY the JSON object. No conversational text.

Identify the PIXEL-PERFECT bounding box for "{name}".
Description: {description}

SPATIAL REASONING PROTOCOL:
1. Locate the absolute leftmost pixel of this object.
2. Locate the absolute rightmost pixel.
3. Locate the absolute highest pixel (top).
4. Locate the absolute lowest pixel (bottom).

CRITICAL RULES:
- Return ONLY the pixels belonging to this SPECIFIC object.
- Do NOT include surrounding water, ripples, or neighboring objects.
- The box must be a TIGHT mathematical crop that includes the FULL object.
- For lily pads: include the ENTIRE green pad AND the white flower on top.

Return box_2d as [y_min, x_min, y_max, x_max] normalized 0-1000.

{{"found": true, "box_2d": [y_min, x_min, y_max, x_max], "label": "{name}"}}"""

    mime_type = "image/png" if image_data[:3] != b'\xff\xd8\xff' else "image/jpeg"

    try:
        # Use Gemini 3 Pro Preview with Thinking Mode for spatial precision
        response = client.models.generate_content(
            model="gemini-3.1-pro-preview",
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
                max_output_tokens=8192,
                media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
                thinking_config=types.ThinkingConfig(
                    thinking_budget=4096  # Enable thinking for spatial reasoning
                ),
            )
        )

        text = response.text
        if text is None:
            print(f"    Warning: Gemini returned None response")
            return {"found": False, "box_2d": [], "label": name}

        # Parse JSON from response
        if "```json" in text:
            text = text.split("```json")[1].split("```")[0]
        elif "```" in text:
            text = text.split("```")[1].split("```")[0]

        result = json.loads(text.strip())
        result["label"] = name  # Ensure correct label
        return result

    except Exception as e:
        print(f"    Error in detection: {e}")
        return {"found": False, "box_2d": [], "label": name}


async def detect_layer_elements(client, image_data: bytes, elements: list) -> list:
    """Detect ALL elements in a layer in a single batch call.

    This is much faster than detecting elements one-by-one because:
    1. Image is only tiled/encoded once
    2. Thinking time is amortized across all elements
    3. Model can reason about spatial relationships between objects
    """

    if not elements:
        return []

    # Build element descriptions
    element_list = "\n".join([
        f'  - "{e["name"]}": {e.get("description", "")}'
        for e in elements
    ])

    prompt = f"""You are an API. Return ONLY a JSON array. No conversational text.

Identify the PIXEL-PERFECT bounding boxes for these {len(elements)} elements:
{element_list}

SPATIAL REASONING PROTOCOL:
For EACH element:
1. Locate the absolute leftmost pixel of this object.
2. Locate the absolute rightmost pixel.
3. Locate the absolute highest pixel (top).
4. Locate the absolute lowest pixel (bottom).

CRITICAL RULES:
- Return ONLY the pixels belonging to each SPECIFIC object.
- Do NOT include surrounding water, ripples, or neighboring objects.
- Each box must be a TIGHT mathematical crop that includes the FULL object.
- For lily pads: include the ENTIRE green pad AND the white flower on top.
- Pay careful attention to spatial location words (left, right, center, top, bottom).

Return box_2d as [y_min, x_min, y_max, x_max] normalized 0-1000.

Return a JSON array:
[
  {{"found": true, "box_2d": [y_min, x_min, y_max, x_max], "label": "element-name"}},
  ...
]"""

    mime_type = "image/png" if image_data[:3] != b'\xff\xd8\xff' else "image/jpeg"

    try:
        response = client.models.generate_content(
            model="gemini-3.1-pro-preview",
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
                max_output_tokens=8192,
                media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
                thinking_config=types.ThinkingConfig(
                    thinking_budget=4096  # Enable thinking for spatial reasoning
                ),
            )
        )

        text = response.text
        if text is None:
            print(f"    Warning: Gemini returned None response for batch detection")
            return [{"found": False, "box_2d": [], "label": e["name"]} for e in elements]

        # Parse JSON from response
        if "```json" in text:
            text = text.split("```json")[1].split("```")[0]
        elif "```" in text:
            text = text.split("```")[1].split("```")[0]

        results = json.loads(text.strip())

        # Ensure it's a list
        if not isinstance(results, list):
            results = [results]

        return results

    except Exception as e:
        print(f"    Error in batch detection: {e}")
        return [{"found": False, "box_2d": [], "label": e["name"]} for e in elements]


def draw_boxes_on_image(image_data: bytes, detections: list, layer_num: int) -> bytes:
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
        if not det.get("found", False):
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
            draw.rectangle([x1-offset, y1-offset, x2+offset, y2+offset], outline=color)

        # Draw label
        label_width = len(label) * 7 + 10
        draw.rectangle([x1, y1-18, x1+label_width, y1], fill=color)
        draw.text((x1+5, y1-16), label, fill=(255,255,255), font=font)

    # Convert back to bytes
    output = io.BytesIO()
    image.save(output, format='PNG')
    return output.getvalue()


def extract_element_with_mask(image_data: bytes, mask_data: bytes) -> bytes:
    """Extract element using mask (transparent background)."""
    image = Image.open(io.BytesIO(image_data)).convert('RGBA')
    mask = Image.open(io.BytesIO(mask_data)).convert('L')

    # Resize mask to match image if needed
    if mask.size != image.size:
        mask = mask.resize(image.size, Image.Resampling.LANCZOS)

    # Create output with transparency
    output = Image.new('RGBA', image.size, (0, 0, 0, 0))
    output.paste(image, mask=mask)

    # Convert to bytes
    buffer = io.BytesIO()
    output.save(buffer, format='PNG')
    return buffer.getvalue()


async def main():
    total_start = time.time()
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Initialize clients
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    seg_service = get_segmentation_service()
    inpaint_service = get_inpainting_service()

    # Load test image
    if not os.path.exists(TEST_IMAGE):
        print(f"Test image not found: {TEST_IMAGE}")
        print("Please set TEST_IMAGE environment variable")
        return

    with open(TEST_IMAGE, "rb") as f:
        original_image = f.read()

    # Save original
    with open(os.path.join(OUTPUT_DIR, "00_original.png"), "wb") as f:
        f.write(original_image)
    print(f"Saved: 00_original.png")

    # Stage 1: Identify layers
    print("\n" + "=" * 60)
    print("Stage 1: Identifying layers")
    print("=" * 60)

    layer_start = time.time()
    layers_info = await identify_layers(client, original_image)
    timings['layer_analysis'] = time.time() - layer_start
    print(f"  Time: {timings['layer_analysis']:.1f}s")

    print(f"\nFound {len(layers_info.get('layers', []))} layers:")
    for layer in layers_info.get('layers', []):
        print(f"\n  Layer {layer.get('layer')}: {layer.get('description', '')}")
        for elem in layer.get('elements', []):
            print(f"    - {elem.get('name')}")

    # Will save layers_info with box_2d after detection
    # Process ALL layers
    current_image = original_image

    # Track complete layer data with box_2d
    complete_layers_info = {"layers": []}

    layers = layers_info.get('layers', [])
    if not layers:
        print("No layers found!")
        return

    # Process each layer
    for layer in layers:
        layer_start = time.time()
        layer_num = layer.get('layer', 1)
        layer_dir = os.path.join(OUTPUT_DIR, f"layer_{layer_num}")
        os.makedirs(layer_dir, exist_ok=True)

        print(f"\n" + "=" * 60)
        print(f"Processing Layer {layer_num}: {layer.get('description', '')}")
        print("=" * 60)

        # Save input image for this layer
        with open(os.path.join(layer_dir, "00_input.png"), "wb") as f:
            f.write(current_image)
        print(f"  Saved: layer_{layer_num}/00_input.png")

        # Print full layer analysis
        elements = layer.get('elements', [])
        print(f"\nLayer Analysis:")
        print(f"  Elements: {len(elements)}")
        for i, elem in enumerate(elements):
            print(f"  [{i+1}] {elem.get('name')}")

        # BATCH DETECTION: Detect all elements in a single call
        print(f"\n  Detecting {len(elements)} elements in BATCH...")
        detect_start = time.time()

        detection_results = await detect_layer_elements(client, current_image, elements)

        detect_time = time.time() - detect_start
        timings[f'layer_{layer_num}_detection'] = detect_time
        print(f"  Detection time: {detect_time:.1f}s (batch for {len(elements)} elements)")

        # Filter successful detections and build complete layer info
        detections = []
        layer_elements_with_box = []
        for result in detection_results:
            if result.get('found', False):
                box = result.get('box_2d')
                print(f"    Found: {result.get('label')} -> Box: {box}")
                detections.append(result)
                # Store element with box_2d for layers_info.json
                layer_elements_with_box.append({
                    "name": result.get('label'),
                    "box_2d": box
                })
            else:
                print(f"    NOT FOUND: {result.get('label')}")

        # Add layer with box_2d data to complete info
        complete_layers_info["layers"].append({
            "layer": layer_num,
            "description": layer.get('description', ''),
            "elements": layer_elements_with_box
        })

        if not detections:
            print(f"  No elements detected in layer {layer_num}")
            continue

        # Draw boxes on current image
        boxed_image = draw_boxes_on_image(current_image, detections, layer_num)
        with open(os.path.join(layer_dir, "01_boxes.png"), "wb") as f:
            f.write(boxed_image)
        print(f"  Saved: layer_{layer_num}/01_boxes.png")

        # Generate SAM2 masks for each detection
        print(f"\n  Generating SAM2 masks...")
        mask_start = time.time()

        masks = []
        for det in detections:
            name = det.get('label', 'unknown')
            box = det.get('box_2d', [])
            if len(box) != 4:
                continue

            safe_name = sanitize_filename(name)

            # Generate mask using segmentation service
            mask_data = await seg_service.generate_mask(
                image_data=current_image,
                element_name=name,
                bounding_box=box
            )

            if mask_data:
                masks.append(mask_data)

                # Save mask
                mask_filename = f"mask_{safe_name}.png"
                with open(os.path.join(layer_dir, mask_filename), "wb") as f:
                    f.write(mask_data)
                print(f"    Saved: {mask_filename}")

                # Extract element with transparent background
                extracted = extract_element_with_mask(current_image, mask_data)
                extracted_filename = f"extracted_{safe_name}.png"
                with open(os.path.join(layer_dir, extracted_filename), "wb") as f:
                    f.write(extracted)
                print(f"    Saved: {extracted_filename}")
            else:
                print(f"    Failed to generate mask for {name}")

        mask_time = time.time() - mask_start
        timings[f'layer_{layer_num}_sam2'] = mask_time
        print(f"  SAM2 time: {mask_time:.1f}s")

        # Inpaint to remove this layer's elements (for next layer)
        if masks and layer_num < len(layers):
            print(f"\n  Inpainting to remove layer {layer_num} elements...")
            inpaint_start = time.time()

            # Use combined mask for efficiency
            current_image = await inpaint_service.remove_objects_combined(
                current_image, masks
            )

            inpaint_time = time.time() - inpaint_start
            timings[f'layer_{layer_num}_inpaint'] = inpaint_time
            print(f"  Inpaint time: {inpaint_time:.1f}s")

        layer_time = time.time() - layer_start
        timings[f'layer_{layer_num}_total'] = layer_time
        print(f"\n  Layer {layer_num} total: {layer_time:.1f}s")

    # Save complete layers info with box_2d coordinates
    with open(os.path.join(OUTPUT_DIR, "layers_info.json"), "w") as f:
        json.dump(complete_layers_info, f, indent=2)
    print(f"\nSaved: layers_info.json (with box_2d coordinates)")

    # Print timing summary
    total_time = time.time() - total_start
    print("\n" + "=" * 60)
    print("TIMING SUMMARY")
    print("=" * 60)
    print(f"  Layer analysis: {timings.get('layer_analysis', 0):.1f}s")
    for layer in layers:
        layer_num = layer.get('layer', 1)
        print(f"\n  Layer {layer_num}:")
        print(f"    Detection: {timings.get(f'layer_{layer_num}_detection', 0):.1f}s")
        print(f"    SAM2:      {timings.get(f'layer_{layer_num}_sam2', 0):.1f}s")
        print(f"    Inpaint:   {timings.get(f'layer_{layer_num}_inpaint', 0):.1f}s")
        print(f"    Total:     {timings.get(f'layer_{layer_num}_total', 0):.1f}s")
    print(f"\n  TOTAL TIME: {total_time:.1f}s")

    print("\n" + "=" * 60)
    print(f"Pipeline complete! Output in: {OUTPUT_DIR}/")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
