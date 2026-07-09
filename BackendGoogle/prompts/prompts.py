"""
Gemini API Prompts for FabDreamer

All prompts are centralized here for easy modification and testing.
"""

# =============================================================================
# STAGE 1: IMAGE ANALYSIS - Layer Detection
# =============================================================================

LAYER_ANALYSIS_PROMPT = """Analyze this image for laser-cut art layers based on PHYSICAL DEPTH (Z-distance from camera).

CRITICAL RULES:
1. Layer by PHYSICAL DEPTH only, NOT by color or visual similarity
2. An "Atomic Object" is a SINGLE physical entity - NEVER split parts of one object into different layers
   - Example: A duck (body + beak + eye) is ONE atomic object, even if parts have different colors
3. For repetitive elements (clouds, lily pads), detect EACH INDIVIDUAL instance separately
   - Use names like "left-cloud", "center-cloud", "right-cloud" - NOT "clouds"
4. Layer 1 = frontmost (closest to viewer), higher numbers = further back

DESCRIPTION FORMAT - ABSOLUTE POSITIONING ONLY (CRITICAL):
- Use ONLY absolute image positions: "top-left", "bottom-center", "upper-right", "middle of image"
- NEVER reference other elements: NO "behind the tree", "next to the duck", "supporting the bird"
- Describe ONLY the element's own visual features: color, shape, size, position in image
- Good: "Blue oval pond in the bottom-center of the image"
- Bad: "Blue pond where the ducks are swimming" (references ducks)
- Good: "Purple mountains spanning the upper portion of the image"
- Bad: "Mountains behind the green hill" (references hill)

Return JSON:
{
  "layers": [
    {
      "layer": 1,
      "description": "frontmost elements",
      "elements": [
        {"name": "unique-name-with-location", "description": "color, shape, and ABSOLUTE position in image"}
      ]
    }
  ]
}

Additional Rules:
- Include location hints (left, right, center, top, bottom) in EVERY element name
- Maximum 5 layers
- Exclude solid backgrounds (sky, water surface)
- Each element must be a SINGLE detectable object with ONE bounding box"""

# =============================================================================
SINGLE_OBJECT_SEGMENTATION_PROMPT = """Segment the object "{element_name}" in this image.

The object is approximately located at bounding box: {bounding_box}

Return JSON with:
{{
  "name": "{element_name}",
  "box_2d": [y_min, x_min, y_max, x_max],
  "mask": "<base64_encoded_mask_png>"
}}

The mask should be:
- Binary PNG (white=object, black=background)
- Same dimensions as input image
- Clean edges suitable for laser cutting
- Base64 encoded
"""

# =============================================================================
# STAGE 1: OBJECT DETECTION - Bounding Boxes
# =============================================================================

OBJECT_DETECTION_PROMPT = """Detect the following objects in this image and return their bounding boxes.

Objects to find: {object_names}

Return JSON only:
{
  "detections": [
    {
      "name": "<object name>",
      "box_2d": [y_min, x_min, y_max, x_max],
      "confidence": <0.0-1.0>
    }
  ]
}

Notes:
- box_2d coordinates are normalized 0-1000
- If an object is not found, omit it from results
- Only include detections with confidence > 0.5
"""

# =============================================================================
# STAGE 1: SEGMENTATION - Mask Generation
# =============================================================================

SEGMENTATION_PROMPT = """Generate a segmentation mask for the following element in this image.

Element to segment: "{element_name}"
Bounding box hint: {bounding_box}

Return a binary mask where:
- WHITE (255, 255, 255) = the element
- BLACK (0, 0, 0) = everything else

The mask should:
1. Have clean, smooth edges suitable for laser cutting
2. Capture the complete outline of the element
3. Not include any background or other objects
4. Be the same dimensions as the input image

Return the mask as an image.
"""

SEGMENTATION_MASK_PROMPT = """Look at this image and create a precise segmentation mask for: "{element_name}"

The bounding box for this element is approximately: {bounding_box}

Create a binary mask image where:
- The element "{element_name}" is WHITE (255, 255, 255)
- Everything else is BLACK (0, 0, 0)

Requirements:
- Edges should be clean and smooth (suitable for laser cutting vectors)
- Include the complete element, no missing parts
- Do not include shadows or reflections
- The mask should be the same size as the input image
"""

# =============================================================================
# STAGE 1: IMAGE STRUCTURE ANALYSIS - One-time analysis for inpainting guidance
# =============================================================================

IMAGE_STRUCTURE_ANALYSIS_PROMPT = """Analyze this image's visual structure for later use in inpainting.

Describe in 3-5 sentences:
1. ART STYLE: What kind of image is this? (photograph, illustration, quilted fabric art, watercolor, cartoon, collage, digital art, etc.)
2. SPATIAL MODEL: How do elements relate spatially?
   - "Layered flat" = elements stacked on a flat background with no real depth (e.g., paper cutout, fabric collage, sticker art)
   - "Scene with depth" = natural depth ordering (foreground/midground/background with perspective)
   - "Mixed" = some depth but stylized (e.g., illustrated landscape)
3. BACKGROUND: What is the base surface/backdrop? (e.g., "crosshatch linen fabric in blue-grey", "gradient sky from blue to white", "solid cream paper")
4. TEXTURE LANGUAGE: How should inpainted regions look to be consistent? (e.g., "fabric textures with visible weave", "smooth flat colors with black outlines", "photorealistic with natural lighting")

Be SPECIFIC and VISUAL. This description will guide an image generation model later."""

# =============================================================================
# STAGE 1: INPAINT ANALYSIS - Per-layer vision analysis before inpainting
# =============================================================================

INPAINT_ANALYSIS_PROMPT = """You are preparing instructions for an image generation model that will fill a masked area.

IMAGE STRUCTURE (analyzed earlier):
{image_structure}

CONTEXT:
- REMOVED: "{removed_elements}" (the white masked area is where it was)
- BEHIND THE HOLE: {behind_elements}
{previously_removed_note}

Look at the CURRENT IMAGE and the MASK. Write a SHORT, SPECIFIC inpainting instruction (3-5 sentences) that tells the image model EXACTLY what to paint in the white area.

Your instruction MUST include:
1. WHAT to paint: the specific textures, patterns, and colors visible at the edges of the hole that should extend inward. Be concrete (e.g., "red-and-navy plaid fabric pattern", NOT "background texture").
2. HOW to paint it: match the art style described above. If it's fabric art, the fill should look like fabric. If it's a photograph, it should be photorealistic.
3. What NOT to paint: the removed element ({removed_elements}) — the hole is shaped like it, but do NOT recreate it.

If back-layer objects are partially visible at the hole edges, describe how to complete them.
Do NOT say generic things like "extend the background." Be SPECIFIC about what you see at the edges."""

# =============================================================================
# STAGE 1: INPAINTING - Object Removal (Seamless Texture Approach)
# =============================================================================

INPAINTING_PROMPT = """TASK: Extend the surrounding background into the masked (white) area.

INSTRUCTIONS:
1. IDENTIFY THE SURROUNDING TEXTURE: Closely analyze the grain, lighting, and patterns of the background (e.g., grass blades, water ripples, sky gradients) adjacent to the mask.
2. SEAMLESS CLONING: Synthesize new pixels that match the exact frequency, color, and noise profile of the surrounding environment.
3. LIGHTING CONSISTENCY: Ensure the inpainted area follows the global light direction and shadows of the original scene.
4. FLAT CONTENT ONLY: The area must remain an empty background. Do NOT generate new objects, outlines, or structural features.
5. NO ARTIFACTS: The transition between original pixels and new pixels must be invisible to the human eye.

Think like a master photo-restoration artist filling a hole with matching material."""

# Context-aware inpainting - receives adaptive instructions from vision analysis
CONTEXT_INPAINTING_PROMPT = """TASK: Fill the masked (white) area in this image.

WHAT TO PAINT:
{scene_analysis}

RULES:
1. ⚠️ THE HOLE IS SHAPED LIKE THE REMOVED ELEMENT ({removed_elements}). The shape is an artifact of removal — do NOT let it influence what you paint. Do NOT recreate the removed element.
2. LOOK AT THE EDGES of the hole. Extend the surrounding pixels inward seamlessly.
3. Match the image's existing art style, color palette, and texture language exactly.
4. DO NOT invent new objects. Only extend what is visible at the edges or described above.
5. REMOVE ALL TRACES of the removed element — outlines, borders, shadows, ghost shapes.
6. Seamless blending — no visible seams, color shifts, or artifacts at the boundary.
{previously_removed_warning}"""

# REDO version - More explicit about not recreating objects
REDO_INPAINTING_PROMPT = """⚠️ REDO: Previous inpainting had artifacts. BE MORE CAREFUL.

TASK: Extend the surrounding background into the masked (white) area.

⚠️ CRITICAL REDO RULES:

1. IDENTIFY SURROUNDING TEXTURE FIRST:
   - Analyze pixels IMMEDIATELY adjacent to mask
   - Match EXACT color, grain, lighting direction

2. DO NOT RECREATE ANY OBJECTS:
   - Masked area contained REMOVED objects
   - Fill with EMPTY background only
   - If tempted to add any shape: STOP - use flat/textured background instead

3. TEXTURE CONTINUITY:
   - Grass → continue grass blade pattern
   - Sky → continue gradient smoothly
   - Water → continue ripple pattern
   - Any texture → seamlessly extend it

4. LIGHTING CONSISTENCY:
   - Ensure inpainted area follows global light direction
   - Match shadows and highlights of surrounding area

5. NO ARTIFACTS:
   - The transition between original and new pixels must be invisible
   - No visible seams, no color banding, no abrupt changes

Think like a master photo-restoration artist filling a hole with matching material.
The goal is an EMPTY background where the object used to be - nothing more."""

# Foliage/texture inpainting - for removing objects from complex textures like trees
FOLIAGE_INPAINTING_PROMPT = """Using the provided image segment, remove the masked objects (white areas in the mask).

TASK: Replace masked areas by synthesizing matching foliage/texture.

INSTRUCTIONS:
1. ANALYZE SURROUNDING TEXTURE: Closely examine the leaf shapes, branch thickness, color variations, and lighting in the areas immediately adjacent to each mask.

2. SYNTHESIZE MATCHING CONTENT: Generate new pixels that seamlessly continue the surrounding foliage pattern. Match:
   - Leaf shapes and sizes
   - Branch patterns and thickness
   - Color gradients and variations
   - Lighting direction and shadows

3. SEAMLESS INTEGRATION: The result must be an invisible repair - no solid colors, no artifacts, no visible seams. The inpainted areas should look like natural continuation of the tree canopy.

4. MAINTAIN SCENE LOGIC: Preserve the existing lighting, shadow logic, and depth perception of the original image.

5. NO SOLID FILLS: Never fill with flat/solid colors. Always generate textured content matching the surroundings.

Think like a master digital artist seamlessly extending foliage to fill gaps."""

# =============================================================================
# STAGE 1: IMAGE GENERATION
# =============================================================================

IMAGE_GENERATION_PROMPT = """Generate a 1024x1024 square image based on this description:

{prompt}

CANVAS REQUIREMENT (CRITICAL):
- The scene MUST fill the ENTIRE 1024x1024 canvas edge-to-edge
- NO white frame, border, or margin around the scene
- NO rounded corners or vignette effect
- Background color/sky/environment extends to ALL four edges

STYLE - Simple Layered Paper-Cutout:
- Meticulously clean, flat vector shapes stacked in layers, as clean as a physically cut piece of paper.
- LAYERED DEPTH: All stacked layers must have defined, subtle, soft, natural shadows to create clean separation and a sense of depth, simulating physically stacked paper cutouts. Soft, subtle, controlled shadows only; no harsh or overly prominent drop shadows.
- NO black outlines around objects.
- No complex internal details, hatching, intricate patterns, shading, realistic textures, or gradients within shapes.
- All objects are composed of single, distinct, solid, high-contrast flat color fields.
- Shapes should be closed-path, clean vector forms, easily separable for laser cutting.
- Think: the cleanest possible vector illustration of a children's book style or high-quality laser-cut puzzle.

SEGMENTATION-FRIENDLY COLORS & LAYOUT:
- Each object must be a distinct hue from its neighbors (e.g., green tree, red fruit, blue water).
- High contrast between adjacent solid color fields.

GOOD: Simple duck on a layered pond, a solid green hill with distinct layered apple tree, bright solid flowers, all with defined layers and subtle depth.
BAD: Black outlines, realistic shading, gradients, fine textures, intricate internal patterns, multiple overlapping colors without clear boundaries, overly complex background elements that blend.
"""

# =============================================================================
# =============================================================================
# HUMANIZATION PROMPTS
# =============================================================================

HUMANIZE_ANALYSIS_PROMPT = """Convert technical element names into natural, human-readable descriptions.

Technical analysis:
{analysis_json}

Your task: Look at the ACTUAL element names in each layer and describe WHAT those elements are.

Examples of converting element names:
- "center-duck" → "the duck"
- "bottom-left-lily-pad, bottom-right-lily-pad" → "lily pads"
- "front-center-ripple, front-left-ripple" → "ripples in the water"
- "top-left-cloud, top-right-cloud" → "clouds"
- "background-sun" → "the sun"
- "center-bird" → "the bird"

Return JSON:
{{
  "layers": [
    {{
      "layer": 1,
      "name": "Front layer",
      "description": "<describe the actual elements in this layer>"
    }}
  ]
}}

CRITICAL RULES:
1. ALWAYS describe the ACTUAL elements by their names - never use generic terms like "foreground elements" or "main subject"
2. Read each element's "name" field and convert it to natural language
3. Group similar elements: "left-cloud" + "right-cloud" → "clouds"
4. Use articles naturally: "the duck", "lily pads", "clouds in the sky"
5. Keep descriptions SHORT (3-8 words per layer)
6. Maintain layer numbers exactly as provided

BAD examples (too generic):
- "Foreground elements closest to the viewer" ❌
- "Main subject in the mid-foreground" ❌
- "Background elements" ❌

GOOD examples (specific to actual elements):
- "the duck swimming in water" ✓
- "lily pads at the bottom" ✓
- "clouds in the sky" ✓
"""

# =============================================================================
# =============================================================================
# BATCH DETECTION - Bounding Boxes for Multiple Elements
# =============================================================================

BATCH_DETECTION_PROMPT = """You are an API. Return ONLY a JSON array. No conversational text.

IMPORTANT: These {num_elements} elements DEFINITELY EXIST in this image - they were identified in a previous analysis step.
Your task is to find their EXACT bounding boxes and point prompts for segmentation.

ELEMENTS TO FIND (name: description):
{element_list}

CRITICAL CONSTRAINTS:
- Each bounding box must be a MATHEMATICAL CROP of ONLY that element's silhouette
- Do NOT include other objects the element is touching
- Err on the side of a SMALLER box rather than accidentally including other things

PIXEL-PRECISE BOUNDING BOX PROTOCOL:
1. Identify the TOPMOST pixel of ONLY that element
2. Identify the BOTTOMMOST pixel of ONLY that element
3. Identify the LEFTMOST pixel of ONLY that element
4. Identify the RIGHTMOST pixel of ONLY that element
5. VERIFY each point only touches this element's silhouette
6. Output the tightest box encompassing those 4 extreme points

POINT PROMPTS FOR SEGMENTATION (for SAM2):
For each element, provide:
- positive_points: 6-8 points [y, x] strictly INSIDE the object body
  * Spread across VISUALLY DISTINCT parts of the element (different colors/textures)
  * Cover: top, middle, bottom, left side, right side of the element
  * For trees: crown tip, mid-crown, branches, trunk, base
  * For people: head, torso, arms, legs
  * DO NOT cluster all points in one area — maximize spatial + color diversity
- negative_points: 3-4 points [y, x] placed on NEIGHBORING objects or background
  * At least 1 point on any object touching/overlapping the element (e.g., ground foliage near a tree)
  * At least 1 point on the background (sky, water, ground)
  * These help distinguish the element FROM its surroundings

OBJECT-SPECIFIC RULES:
- For people: Include ENTIRE body from head to sole/heel
- For animals: Include ENTIRE tail tip, ALL leg ends, ear tips
- For plants/flowers: Include ENTIRE plant including stem AND bloom

SPATIAL REASONING:
- Pay attention to location words (left, right, center, top, bottom) in element names

INTERNAL GAPS CHECK:
- has_internal_gaps = TRUE: background visible THROUGH holes in ONE object (tree canopy, fence)
- has_internal_gaps = FALSE: object is solid (flower, duck, person)

All coordinates normalized 0-1000. Return JSON array:
[
  {{
    "found": true,
    "label": "element-name",
    "box_2d": [y_min, x_min, y_max, x_max],
    "positive_points": [[y1,x1], [y2,x2], [y3,x3], [y4,x4], [y5,x5], [y6,x6]],
    "negative_points": [[y1,x1], [y2,x2], [y3,x3]],
    "has_internal_gaps": false
  }},
  ...
]"""

# REDO version - More anchors and verification steps
REDO_BATCH_DETECTION_PROMPT = """⚠️ REDO: Previous detection was inaccurate. BE EXTRA CAREFUL.

You are an API. Return ONLY a JSON array. No conversational text.

IMPORTANT: These {num_elements} elements DEFINITELY EXIST in this image - they were identified in a previous analysis step.
Your task is to find their EXACT bounding boxes and point prompts for segmentation.

ELEMENTS TO FIND (name: description):
{element_list}

⚠️ REDO-SPECIFIC VERIFICATION STEPS:

1. EDGE-TO-EDGE SCANNING:
   - Scan 5 pixels INWARD from initial boundary guess
   - Verify you're on object MATERIAL, not shadow or background

2. PART COMPLETENESS CHECKLIST:
   - "Does box include BEAK?" (birds)
   - "Does box include TAIL TIP?" (animals)
   - "Does box include ALL LEAF EDGES?" (plants)
   - "Does box include FEET/BASE?" (all objects)

3. BOUNDARY CONTRAST CHECK:
   - Identify DANGER ZONES (where object color ≈ background color)
   - These areas need negative points to help SAM2

4. NEGATIVE POINT "PRESSURE":
   - Place negative points IN danger zones
   - Helps SAM2 distinguish ambiguous boundaries

CRITICAL CONSTRAINTS:
- Each bounding box must be a MATHEMATICAL CROP of ONLY that element's silhouette
- Do NOT include other objects the element is touching
- Err on the side of a SMALLER box rather than accidentally including other things

PIXEL-PRECISE BOUNDING BOX PROTOCOL:
1. Identify the TOPMOST pixel of ONLY that element
2. Identify the BOTTOMMOST pixel of ONLY that element
3. Identify the LEFTMOST pixel of ONLY that element
4. Identify the RIGHTMOST pixel of ONLY that element
5. VERIFY each point only touches this element's silhouette
6. Output the tightest box encompassing those 4 extreme points

⚠️ REDO POINT PROMPTS - MORE ANCHORS:
- positive_points: 5-8 points [y, x] spread across ENTIRE object body
  * CENTER of the object
  * TOP region (head, top edge)
  * BOTTOM region (feet, base, roots)
  * LEFT edge (wing tip, arm, leftmost leaf)
  * RIGHT edge (wing tip, arm, rightmost leaf)
  * Additional points for complex objects (trunk, branch, leaf cluster)
- negative_points: 2-3 points [y, x] strictly OUTSIDE, especially in DANGER ZONES
  * Place in areas where object color is similar to background
  * Place just outside ambiguous boundaries

OBJECT-SPECIFIC RULES:
- For people: Include ENTIRE body from head to sole/heel
- For animals: Include ENTIRE tail tip, ALL leg ends, ear tips
- For plants/flowers: Include ENTIRE plant including stem AND bloom

SPATIAL REASONING:
- Pay attention to location words (left, right, center, top, bottom) in element names

INTERNAL GAPS CHECK:
- has_internal_gaps = TRUE: background visible THROUGH holes in ONE object (tree canopy, fence)
- has_internal_gaps = FALSE: object is solid (flower, duck, person)

All coordinates normalized 0-1000. Return JSON array:
[
  {{
    "found": true,
    "label": "element-name",
    "box_2d": [y_min, x_min, y_max, x_max],
    "positive_points": [[y1,x1], [y2,x2], [y3,x3], [y4,x4], [y5,x5]],
    "negative_points": [[y1,x1], [y2,x2]],
    "has_internal_gaps": false
  }},
  ...
]"""

# =============================================================================
# POINT REFINEMENT - Re-segment with denser points (same box)
# =============================================================================

POINT_REFINEMENT_PROMPT = """You are an API. Return ONLY a JSON array. No conversational text.

⚠️ RE-SEGMENT: The previous segmentation was inaccurate. The bounding boxes are CORRECT — do NOT change them.
Your job is to provide DENSER, MORE PRECISE point prompts to guide the segmentation model.

ELEMENTS TO REFINE (name: description, with their FIXED bounding boxes):
{element_list}

FOR EACH ELEMENT, provide:

positive_points: 10-12 points [y, x] spread densely across the ENTIRE element body:
  * CENTER of the object (2 points — center mass and geometric center)
  * TOP region (2 points — head, top edge, crown)
  * BOTTOM region (2 points — feet, base, roots, bottom edge)
  * LEFT edge (2 points — leftmost features)
  * RIGHT edge (2 points — rightmost features)
  * INTERIOR (2 points — filling gaps between the above)

negative_points: 5-6 points [y, x] strictly OUTSIDE the element:
  * Place points in areas the segmentation likely LEAKED into (neighboring objects)
  * Place points just outside AMBIGUOUS boundaries (where element color ≈ background)
  * Place at least one point on each side where another object is nearby
  * Points must be WITHIN the bounding box but OUTSIDE the element

CRITICAL RULES:
- Do NOT change box_2d — copy it EXACTLY as given
- Positive points must be ON the element's actual pixels
- Negative points must be OUTSIDE the element but INSIDE the bounding box
- Pay attention to the element description for shape and extent
- All coordinates normalized 0-1000

Return JSON array:
[
  {{
    "found": true,
    "label": "element-name",
    "box_2d": [y_min, x_min, y_max, x_max],
    "positive_points": [[y1,x1], [y2,x2], ...],
    "negative_points": [[y1,x1], [y2,x2], ...],
    "has_internal_gaps": false
  }},
  ...
]"""

# =============================================================================
# GRAB ELEMENTS - User-Requested Element Extraction
# =============================================================================

GRAB_ELEMENTS_PROMPT = """You are an API. Return ONLY a JSON object. No markdown, no explanation.

CRITICAL CONSTRAINTS:
- The bounding box must be a MATHEMATICAL CROP of ONLY the target object's silhouette
- Do NOT include tables, desks, chairs, or any object the target is touching
- Err on the side of a SMALLER box rather than accidentally including other elements

The user wants to extract: "{element_description}"

Parse what object(s) the user is looking for and find ALL matching elements.

PIXEL-PRECISE BOUNDING BOX PROTOCOL:
For EACH element:
1. Identify the TOPMOST pixel of the target object
2. Identify the BOTTOMMOST pixel of the target object
3. Identify the LEFTMOST pixel of the target object
4. Identify the RIGHTMOST pixel of the target object
5. VERIFY each point only touches the target's silhouette
6. Output the tightest box encompassing those 4 extreme points

POINT PROMPTS FOR SEGMENTATION (for SAM2):
For each element, provide:
- positive_points: 3 points [y, x] strictly INSIDE the object body
  * Point 1: center of the object
  * Point 2: top region (head, top edge)
  * Point 3: bottom region (feet, base)
- negative_points: 1 point [y, x] strictly OUTSIDE the object in background

OBJECT-SPECIFIC RULES:
- For people: Include ENTIRE body from head to sole/heel
- For animals: Include ENTIRE tail tip, ALL leg ends, ear tips
- For plants/flowers: Include ENTIRE plant including stem AND bloom

All coordinates normalized 0-1000. Return JSON:
{{
  "parsed_query": "object name being searched",
  "elements": [
    {{
      "label": "object-name",
      "box_2d": [y_min, x_min, y_max, x_max],
      "positive_points": [[y1,x1], [y2,x2], [y3,x3]],
      "negative_points": [[y1,x1]],
      "has_internal_gaps": false
    }}
  ]
}}

If nothing matches: {{"parsed_query": "object-name", "elements": []}}"""

# Grab elements with location hint (used after occlusion completion)
GRAB_ELEMENTS_WITH_HINT_PROMPT = """You are an API. Return ONLY a JSON object. No markdown, no explanation.

CRITICAL CONSTRAINTS:
- The bounding box must be a MATHEMATICAL CROP of ONLY the target object's silhouette
- Do NOT include tables, desks, chairs, or any object the target is touching
- Err on the side of a SMALLER box rather than accidentally including other elements

The user wants to extract: "{element_description}"

⚠️ LOCATION HINT: The target object "{object_name}" is located in the area around:
   [y_min={hint_y_min}, x_min={hint_x_min}, y_max={hint_y_max}, x_max={hint_x_max}] (normalized 0-1000)
   Focus on this region. If there are multiple similar objects, select the one in this area.

Parse what object(s) the user is looking for and find ALL matching elements.

PIXEL-PRECISE BOUNDING BOX PROTOCOL:
For EACH element:
1. Identify the TOPMOST pixel of the target object
2. Identify the BOTTOMMOST pixel of the target object
3. Identify the LEFTMOST pixel of the target object
4. Identify the RIGHTMOST pixel of the target object
5. VERIFY each point only touches the target's silhouette
6. Output the tightest box encompassing those 4 extreme points

POINT PROMPTS FOR SEGMENTATION (for SAM2):
For each element, provide:
- positive_points: 3 points [y, x] strictly INSIDE the object body
  * Point 1: center of the object
  * Point 2: top region (head, top edge)
  * Point 3: bottom region (feet, base)
- negative_points: 1 point [y, x] strictly OUTSIDE the object in background

OBJECT-SPECIFIC RULES:
- For people: Include ENTIRE body from head to sole/heel
- For animals: Include ENTIRE tail tip, ALL leg ends, ear tips
- For plants/flowers: Include ENTIRE plant including stem AND bloom

All coordinates normalized 0-1000. Return JSON:
{{
  "parsed_query": "object name being searched",
  "elements": [
    {{
      "label": "object-name",
      "box_2d": [y_min, x_min, y_max, x_max],
      "positive_points": [[y1,x1], [y2,x2], [y3,x3]],
      "negative_points": [[y1,x1]],
      "has_internal_gaps": false
    }}
  ]
}}

If nothing matches: {{"parsed_query": "object-name", "elements": []}}"""

# =============================================================================
# IMAGE STYLIZATION - For Laser Cut Optimization
# =============================================================================

STYLIZE_FOR_LASER_CUT_PROMPT = """Transform this photograph into a flat, cel-shaded cartoon illustration optimized for laser cutting.

STYLE:
- Children's book illustration, vibrant and charming
- Cel-shaded coloring with highly distinct, high-contrast hues for neighboring objects
- Posterized effect: use solid blocks of color with hard edges
- Maintain the original composition, silhouettes, and proportions perfectly

COLORS:
- Each object a DISTINCT hue from its neighbors
- Solid fill colors, minimal gradients
- High contrast between adjacent elements

Ensure all elements and color blocks connect smoothly without gaps, floating elements, or dark borders separating the shapes."""

# =============================================================================
# UTILITY PROMPTS
# =============================================================================

# =============================================================================
# PLAN B: HYBRID PIPELINE - SAM + DIFF-MASK
# =============================================================================

# Keywords that indicate complex objects with internal gaps (use diff-mask)
COMPLEX_OBJECT_KEYWORDS = [
    "tree", "canopy", "foliage", "bush", "branches", "shrub",
    "fence", "lattice", "cage", "net", "mesh", "grid"
]

# Threshold for sub-box count to consider object as complex
COMPLEX_SUB_BOX_THRESHOLD = 3  # Objects with 3+ sub-boxes are considered complex

ROUGH_MASK_PROMPT = """Paint a SOLID WHITE SILHOUETTE over ONLY "{element_name}" in this image.

Element description: {element_description}
Approximate bounding box (y_min, x_min, y_max, x_max normalized 0-1000): {box}

STEP 1 — IDENTIFY the element:
- Read the name and description carefully: "{element_name}" — {element_description}
- The bounding box tells you WHERE to look. The element is somewhere inside this box.
- ⚠️ The box is APPROXIMATE and may include neighboring objects — do NOT paint everything in the box!

STEP 2 — DISCRIMINATE:
- Paint ONLY "{element_name}", NOT other objects that happen to be nearby or overlapping the box
- Example: box around a "pine tree" may also contain ground foliage → paint ONLY the tree, NOT the foliage
- Example: box around a "bird" may include the branch it sits on → paint ONLY the bird, NOT the branch
- Ask yourself: "Is this pixel part of {element_name} specifically, or is it a DIFFERENT element?"

STEP 3 — PAINT the full element:
- Paint SOLID WHITE (#FFFFFF) over every pixel that belongs to "{element_name}"
- Include ALL parts of this one element: trunk + branches + leaves = one tree, pad + flower = one lilypad
- Multi-colored parts of the SAME object are still one element — paint them all white
- Cover the element from edge to edge — don't miss tips, extremities, or the base

BACKGROUND:
- Keep everything else UNCHANGED — other objects, sky, water, ground stay as original
- For gaps where background shows THROUGH the object (e.g., sky between tree branches), leave as original

Output: Same image with ONLY "{element_name}" painted as solid white silhouette."""

# REDO version - Fixed "color awareness" bug (2026-01-07)
# Uses FORM and ATTACHMENT instead of color matching
REDO_ROUGH_MASK_PROMPT = """⚠️ REDO: Previous mask had issues. Try again more carefully.

Paint a SOLID WHITE SILHOUETTE over ONLY "{element_name}" in this image.

Element description: {element_description}
Approximate bounding box (y_min, x_min, y_max, x_max normalized 0-1000): {box}

⚠️ COMMON MISTAKES TO AVOID:
1. Painting TOO LITTLE — only a small feature instead of the full element (e.g., just the flower, not the whole lilypad)
2. Painting TOO MUCH — including neighboring objects that overlap the bounding box (e.g., ground foliage along with a tree)

THE BOUNDING BOX IS APPROXIMATE:
- It tells you WHERE to look, but may include nearby objects
- Paint ONLY "{element_name}", not everything in the box
- Ask: "Is this pixel part of {element_name} specifically?" — if it belongs to a DIFFERENT element, leave it

PAINT THE FULL ELEMENT (but only this element):
- Include ALL parts of "{element_name}": multi-colored sub-parts are still one object
- Tree = trunk + branches + leaves + roots (but NOT ground plants next to it)
- Lilypad = pad + flower + stem (but NOT the water around it)
- Cover edge to edge — don't miss tips, extremities, or the base

BACKGROUND:
- Keep everything else UNCHANGED — other objects, sky, water, ground stay as original

Output: Same image with ONLY "{element_name}" painted as solid white silhouette."""

# =============================================================================
# OCCLUSION DETECTION & COMPLETION - For Amodal Segmentation
# =============================================================================

OCCLUSION_CHECKER_PROMPT = """You are an API. Return ONLY a JSON object. No explanation, no markdown.

Analyze if the target object is fully visible or partially hidden by another object.

Target object: "{object_name}"
Bounding box (normalized 0-1000): {box_2d}

Determine:
1. Is any part of this object hidden BEHIND another object?
2. If yes, what is hiding it and what parts are hidden?

Return JSON only:
{{
  "is_occluded": true or false,
  "confidence": 0.0-1.0,
  "occluder_name": "name of object hiding it" or null if not occluded,
  "missing_parts": "description of hidden parts" or null if not occluded,
  "amodal_box_2d": [y_min, x_min, y_max, x_max] or null if not occluded
}}

The amodal_box_2d should be the ESTIMATED full bounding box of the complete object if it were fully visible."""

# Simple occlusion check - used BEFORE detection to check if object is occluded
# This is a fast/cheap check that doesn't require a precise bounding box
OCCLUSION_CHECK_SIMPLE_PROMPT = """You are an API. Return ONLY a JSON object. No explanation, no markdown.

Find the "{object_description}" in this image and determine if ANY part of it is hidden or cut off.

OCCLUSION CHECKLIST — answer YES to "is_occluded" if ANY of these apply:
- Another object overlaps or sits in front of ANY part of the target (even slightly)
- The target's feet, legs, base, tail, or bottom edge disappears behind something (ground, grass, rocks, mushrooms, another object)
- Part of the target extends beyond the image boundary (cropped)
- The target's silhouette has an unnatural flat edge where it meets another object (indicating the other object is covering it)
- You can imagine the complete object would be LARGER than what is currently visible

Common occlusion patterns to watch for:
- Animals/characters standing behind rocks, plants, fences, other characters
- Feet/legs hidden by grass, ground, water, or foreground objects
- Objects partially behind furniture, walls, containers
- Any element where the bottom or sides are "cut" by an overlapping element

IMPORTANT: Even MINOR occlusion counts. If a bear's feet are behind mushrooms, that IS occlusion. If a tree trunk disappears behind a hill, that IS occlusion. When in doubt, say is_occluded=true.

Return JSON only:
{{
  "found": true or false,
  "is_occluded": true or false,
  "confidence": 0.0-1.0,
  "object_name": "specific name of the found object" or null if not found,
  "occluder_name": "name of object hiding it" or null if not occluded,
  "missing_parts": "description of hidden parts (e.g. 'lower legs and feet', 'right side of body', 'tail')" or null if not occluded,
  "visible_box_2d": [y_min, x_min, y_max, x_max] (0-1000 normalized) - bounding box of VISIBLE portion,
  "amodal_box_2d": [y_min, x_min, y_max, x_max] (0-1000 normalized) - ESTIMATED full box INCLUDING hidden parts
}}

visible_box_2d = what you can actually see now.
amodal_box_2d = your best estimate of the COMPLETE object boundary if nothing was hiding any part of it. This box should be LARGER than visible_box_2d when occlusion is detected."""

# =============================================================================
# SUB-SEGMENT - Break segment into smaller parts
# =============================================================================

SUB_SEGMENT_PROMPT = """You are an API. Return ONLY a JSON object. No markdown, no explanation.

This is an EXTRACTED SEGMENT (a single object already cut out from a larger image).
The user wants to break this segment into SMALLER PARTS based on their description.

User request: "{prompt}"

TASK: Find the distinct sub-elements within this segment that match the user's request.
Each sub-element should be a visually distinct, separable part.

PIXEL-PRECISE BOUNDING BOX PROTOCOL:
For EACH sub-element found:
1. Identify the TOPMOST pixel of the sub-element
2. Identify the BOTTOMMOST pixel of the sub-element
3. Identify the LEFTMOST pixel of the sub-element
4. Identify the RIGHTMOST pixel of the sub-element
5. Output the tightest box encompassing those 4 extreme points

POINT PROMPTS FOR SAM2:
For each sub-element, provide:
- positive_points: 3 points [y, x] strictly INSIDE the sub-element
- negative_points: 1-2 points [y, x] strictly OUTSIDE (on background or other parts)

All coordinates normalized 0-1000 (relative to THIS segment image, not the original canvas).

Return JSON:
{{
  "parsed_query": "what was extracted",
  "sub_elements": [
    {{
      "label": "sub-element-name",
      "box_2d": [y_min, x_min, y_max, x_max],
      "positive_points": [[y1,x1], [y2,x2], [y3,x3]],
      "negative_points": [[y1,x1]],
      "has_internal_gaps": false
    }}
  ]
}}

If nothing matches the request: {{"parsed_query": "...", "sub_elements": []}}"""

# =============================================================================
# REPAIR SEGMENT - Clean up noisy extraction on magenta background
# =============================================================================

REPAIR_SEGMENT_PROMPT = """I'm showing you three images:

1. FULL ORIGINAL SCENE — the complete illustration for overall context
2. CROPPED ORIGINAL — a zoomed-in crop of the area where "{element_name}" is located in the original scene
3. NOISY EXTRACTION — a rough cut-out of "{element_name}" on a magenta (#FF00FF) background. The edges are jagged and noisy.

The element "{element_name}" is approximately located at {position_hint} of the original scene. Image 2 shows that area cropped from the original — use it as your primary reference.

YOUR TASK: Look at "{element_name}" in image 2 (the cropped original) and image 3 (the noisy extraction). Now re-draw JUST "{element_name}" — cleanly, with smooth edges — on a pure magenta (#FF00FF) background. Nothing else.

Think of it as: re-cut "{element_name}" from the original scene, but with perfect clean edges this time.

CRITICAL RULES:
- Output ONLY "{element_name}" on pure magenta #FF00FF background
- Do NOT include any other objects from the scene — ONLY "{element_name}"
- Do NOT recreate the full scene — just the ONE element
- Background MUST be solid pure magenta #FF00FF everywhere except the element
- Match the exact style, colors, and proportions from the original scene
- Smooth, clean edges — no jagged artifacts
- Keep the same image dimensions as image 3
- Place the element at roughly the same position as in image 3"""

OCCLUSION_COMPLETION_PROMPT = """Look at this image. The "{object_name}" is partially hidden behind "{occluder_name}".
The hidden parts are: {missing_parts}

TASK: Generate an image of ONLY the "{object_name}" — complete and fully visible — on a pure magenta (#FF00FF) background.

⚠️ CRITICAL RULES:

1. IMAGE SIZE: Output MUST be EXACTLY {width}x{height} pixels.

2. DRAW ONLY THE {object_name}:
   - Extract it from the scene and complete its hidden parts
   - The {object_name} should be at the SAME position and size as in the original
   - Its bounding box (normalized 0-1000): [y_min={amodal_y_min}, x_min={amodal_x_min}, y_max={amodal_y_max}, x_max={amodal_x_max}]
   - DO NOT move or resize it — keep it exactly where it appears

3. COMPLETE THE HIDDEN PARTS:
   - The parts currently hidden ({missing_parts}) must be drawn naturally
   - Match the visible parts' style, color, texture, and proportions exactly
   - Imagine what the full object looks like and draw those hidden portions

4. BACKGROUND: Everything that is NOT the {object_name} must be solid pure magenta #FF00FF
   - No other objects from the scene
   - No shadows, no ground, no other elements
   - ONLY the {object_name} on magenta

5. STYLE MATCH: The completed parts must seamlessly match the visible parts — same art style, line work, colors, and level of detail."""


# =============================================================================
# STAGE 3: FABRICATION AGENT - System Prompt
# =============================================================================

FABRICATION_AGENT_PROMPT = """You are a Fabrication Agent for laser-cut designs. You analyze layers for structural issues and fix them.

## Key Concepts

**Floating Parts**: Parts completely enclosed by cut lines that will fall out after cutting. Fix with bridges.
**Bridges**: Rectangular connectors (default 2mm) between a floating part and the boundary or another anchored part.
**Thin Areas**: Regions too narrow for the material (plywood ≥1.0mm, acrylic ≥1.5mm).

## Behavior Rules

### 1. Be action-oriented — minimize round trips
- Call tools FIRST, then summarize results in ONE text response AFTER. Do NOT output text before a tool call — it creates duplicate messages.
- When you detect issues, tell the user what you found AND offer to fix them in the SAME response.
- When the user says "fix", "bridge", "how to fix", or any intent to resolve issues — call add_bridge IMMEDIATELY. Do NOT ask for confirmation, do NOT call find_floating_parts again, do NOT call highlight_part.
- Use information from previous analysis results. Do NOT re-analyze what you already know.

### 2. Always use bridges (not tabs)
- The default fix for floating parts is add_bridge with to_part_id="boundary".
- Do NOT suggest or use add_tabs_to_border unless the user explicitly asks for tabs.

### 3. After analysis, recommend action
After analyze_all_layers completes:
- List issues found per layer
- For each floating part, say: "I can add a bridge to connect [part:X] to the boundary. Want me to fix it?"
- If only 1-2 issues, offer to fix them right away: "Would you like me to add bridges to fix these?"

### 4. Part IDs must be EXACT
- Part IDs are long strings like "segment-1772343256078-2-10-duck-center-edit-1772343257657"
- When calling add_bridge or any tool, copy the EXACT part_id from the analysis result — do NOT modify, shorten, or append anything (e.g., do NOT add "(svg)", "(no-svg)", or any other suffixes/annotations)
- The part_id in tool calls must match the part_id from analysis results character-for-character

### 5. Tool efficiency
- Use analyze_all_layers for full checks (not individual find_floating_parts calls)
- Do NOT call highlight_part — analysis tools already highlight issues
- Do NOT call preview_fix — just apply the fix
- Do NOT re-call analysis tools for data you already have from a previous call
- After applying fixes, verify with check_fabrication_ready

### 6. Response style
- Be concise — short sentences, no filler
- Use [Layer X] and [part:name] format for clickable references
- ALWAYS use the layer_name (e.g., "Layer 1") in text responses, NOT the raw layer_id (which is a long number like "1772343389957")
- In tool calls, use the raw layer_id for the layer_id parameter
- Example: "Found 1 floating part in [Layer 1]: [part:duck-center]. I can bridge it to the boundary."

## Tool Call Patterns

**Auto-analysis (on entry):**
1. Call analyze_all_layers
2. Summarize findings with clickable references
3. Offer to fix

**User says "fix" / "bridge" / "how to fix":**
1. Call add_bridge — IMMEDIATELY, no extra analysis
   - Use the `nearest_anchor` from analysis results as `to_part_id` (it may be "boundary" or another part's ID)
   - Do NOT always default to "boundary" — if the analysis says the nearest anchor is another part, bridge to that part
2. Call check_fabrication_ready
3. Report result

**User asks about thin areas:**
1. Call detect_thin_areas for the relevant layer(s)
2. Report findings

**User asks to change material:**
1. Call set_material with your knowledge of the material's physical and visual properties
2. You decide: color, opacity, roughness, transmission, clearcoat, thickness, min feature width
3. Report the change and note any fabrication implications

## Material Knowledge (for set_material tool)

You have expert knowledge of laser-cutting materials. When the user says "use acrylic" or "switch to walnut", YOU determine the properties — there is no lookup table. Provide appearance properties for 3D rendering:

**Property guide** (all 0.0–1.0 unless noted):
- `color`: hex string — the material's natural color (e.g. "#f5deb3" for plywood, "#3e2015" for walnut)
- `opacity`: 1.0 for opaque materials, lower for translucent (rarely used — prefer `transmission` for clear materials)
- `roughness`: 0.0 = mirror-smooth, 1.0 = matte. Wood ~0.7, polished acrylic ~0.1, matte acrylic ~0.4
- `metalness`: almost always 0.0 for laser-cut materials
- `clearcoat`: extra glossy layer. Acrylic ~0.8–1.0, varnished wood ~0.3, raw wood 0.0
- `transmission`: 0.0 = fully opaque, 1.0 = fully transparent (like glass). Clear acrylic ~0.9, frosted acrylic ~0.4, wood = 0.0
- `ior`: index of refraction (only matters if transmission > 0). Acrylic = 1.49, glass = 1.5. Default 1.5

**Common materials reference:**
- Plywood: color "#d4a76a", roughness 0.7, transmission 0, thickness 3mm, min_width 1.0mm
- Clear acrylic: color "#ffffff", roughness 0.1, transmission 0.9, clearcoat 1.0, thickness 3mm, min_width 1.5mm
- Frosted acrylic: color "#e8e8e8", roughness 0.4, transmission 0.4, clearcoat 0.5, thickness 3mm, min_width 1.5mm
- Colored acrylic (red/blue/etc): user-specified color, roughness 0.1, transmission 0.6, clearcoat 0.8
- MDF: color "#c4a882", roughness 0.8, transmission 0, thickness 3mm, min_width 1.0mm
- Cardboard: color "#d4a574", roughness 0.9, transmission 0, thickness 1.5mm, min_width 0.8mm
- Birch plywood: color "#e8d5b0", roughness 0.6, transmission 0, thickness 3mm, min_width 1.0mm
- Walnut: color "#5c3a1e", roughness 0.65, transmission 0, thickness 3mm, min_width 1.0mm
- Bamboo: color "#c8a84e", roughness 0.5, transmission 0, thickness 3mm, min_width 1.0mm

Adjust freely based on user descriptions like "6mm thick", "matte finish", "red transparent", etc."""
