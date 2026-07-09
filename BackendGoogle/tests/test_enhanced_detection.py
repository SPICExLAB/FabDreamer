#!/usr/bin/env python3
"""Test enhanced detection with color guidance from vision model."""
import json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

from google import genai
from google.genai import types
from config.models import VISION_PRIMARY

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
image_data = open("output/dsd/test.png", "rb").read()

prompt = """You are an API. Return ONLY a JSON object. No conversational text.

Look at this image. Find the element "right-foreground-pine-tree":
Description: Tall, dark, almost black silhouette of a coniferous tree extending from the bottom right corner up to the middle right edge of the image.
Known bounding box (y_min, x_min, y_max, x_max normalized 0-1000): [205, 745, 1000, 1000]

Return:
1. positive_points: 6-8 points [y, x] spread across VISUALLY DISTINCT parts of the tree ONLY
   - Place points on different colored/textured regions (crown tip, mid-crown, branches, trunk, base)
   - DO NOT cluster all points in one area - spread them to capture color diversity
   - Points must be ON the tree itself, not on neighboring foliage/plants

2. negative_points: 3-4 points [y, x] placed on NEIGHBORING objects that are close to or overlapping the tree
   - At least one point on any ground foliage/plants near the tree base
   - At least one point on the background (sky, mountains, etc.)
   - These help distinguish the tree FROM its surroundings

3. element_colors: 3-5 representative RGB [r,g,b] colors sampled from different parts of the tree
   - Sample from crown (top), mid-section, trunk, any lighter/darker regions

4. exclude_colors: 2-3 RGB [r,g,b] colors of neighboring objects that should NOT be included
   - Ground foliage, background, other trees behind this one

All coordinates normalized 0-1000. Return JSON:
{
  "positive_points": [[y,x], ...],
  "negative_points": [[y,x], ...],
  "element_colors": [[r,g,b], ...],
  "exclude_colors": [[r,g,b], ...]
}"""

print("Calling Gemini vision for enhanced detection...")
t0 = time.time()
response = client.models.generate_content(
    model=VISION_PRIMARY,
    contents=[types.Content(role="user", parts=[
        types.Part.from_text(text=prompt),
        types.Part.from_bytes(data=image_data, mime_type="image/png")
    ])],
    config=types.GenerateContentConfig(
        temperature=0, max_output_tokens=16384,
        media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
        thinking_config=types.ThinkingConfig(thinking_budget=2048),
    )
)
elapsed = time.time() - t0

text = None
for part in response.candidates[0].content.parts:
    if hasattr(part, "text") and part.text:
        text = part.text

if "```json" in text:
    text = text.split("```json")[1].split("```")[0]
elif "```" in text:
    text = text.split("```")[1].split("```")[0]

result = json.loads(text.strip())
print(f"Done in {elapsed:.1f}s\n")
print(json.dumps(result, indent=2))

out_path = "test_outline_output/elements/right-foreground-pine-tree/08_enhanced_detection.json"
with open(out_path, "w") as f:
    json.dump(result, f, indent=2)
print(f"\nSaved to {out_path}")
