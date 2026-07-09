"""
Centralized Gemini model configuration.

All model names are defined here so they can be updated in one place
when Google releases new versions or deprecates old ones.
"""

# Vision / Analysis models (text + image understanding, JSON output)
VISION_PRIMARY = "gemini-3.1-pro-preview"
VISION_FALLBACK = "gemini-3-flash-preview"

# Image generation / editing models (image output)
IMAGE_PRIMARY = "gemini-3.1-flash-image-preview"
IMAGE_FALLBACK = "gemini-2.5-flash-image"

# Lightweight text models (humanize, occlusion check, simple tasks)
TEXT_FAST = "gemini-2.5-flash"
