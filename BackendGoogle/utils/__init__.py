"""
FabDreamer Backend Utilities (Gemini Version)
"""

from .image_utils import (
    decode_base64_image,
    encode_image_to_base64,
    get_image_dimensions,
    resize_image,
    convert_to_png,
    create_green_background_image,
    crop_to_bbox,
    overlay_images,
)

from .svg_converter import (
    png_to_svg,
    mask_to_svg,
    svg_to_png,
    optimize_svg,
)

__all__ = [
    "decode_base64_image",
    "encode_image_to_base64",
    "get_image_dimensions",
    "resize_image",
    "convert_to_png",
    "create_green_background_image",
    "crop_to_bbox",
    "overlay_images",
    "png_to_svg",
    "mask_to_svg",
    "svg_to_png",
    "optimize_svg",
]
