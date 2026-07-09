"""
Image Utility Functions
"""

import base64
import io
from typing import Tuple, Optional
from PIL import Image
import numpy as np


def decode_base64_image(base64_string: str) -> bytes:
    """Decode base64 image string to bytes.

    Handles both with and without data URI prefix.
    Automatically fixes padding issues.

    Args:
        base64_string: Base64 encoded image (with or without data:image/... prefix)

    Returns:
        Raw image bytes
    """
    if not base64_string:
        raise ValueError("Empty base64 string")

    # Remove data URI prefix if present
    if ',' in base64_string:
        base64_string = base64_string.split(',')[1]

    # Remove whitespace and newlines
    base64_string = base64_string.strip().replace('\n', '').replace('\r', '').replace(' ', '')

    # Fix padding - base64 strings must be multiple of 4
    padding_needed = len(base64_string) % 4
    if padding_needed:
        base64_string += '=' * (4 - padding_needed)

    decoded = base64.b64decode(base64_string)

    # Validate it's actually an image by checking magic bytes
    if len(decoded) < 8:
        raise ValueError(f"Decoded data too small: {len(decoded)} bytes")

    # Check for common image formats
    if decoded[:8] == b'\x89PNG\r\n\x1a\n':
        pass  # PNG
    elif decoded[:2] == b'\xff\xd8':
        pass  # JPEG
    elif decoded[:6] in (b'GIF87a', b'GIF89a'):
        pass  # GIF
    elif decoded[:4] == b'RIFF' and decoded[8:12] == b'WEBP':
        pass  # WebP
    else:
        # Log first few bytes for debugging
        import logging
        logging.warning(f"Unknown image format. First 20 bytes: {decoded[:20].hex()}")

    return decoded


def encode_image_to_base64(image_data: bytes, include_prefix: bool = True) -> str:
    """Encode image bytes to base64 string.

    Args:
        image_data: Raw image bytes
        include_prefix: Whether to include data:image/png;base64, prefix

    Returns:
        Base64 encoded string
    """
    encoded = base64.b64encode(image_data).decode('utf-8')

    if include_prefix:
        # Detect image type
        if image_data[:3] == b'\xff\xd8\xff':
            return f"data:image/jpeg;base64,{encoded}"
        else:
            return f"data:image/png;base64,{encoded}"

    return encoded


def get_image_dimensions(image_data: bytes) -> Tuple[int, int]:
    """Get image dimensions from bytes.

    Args:
        image_data: Raw image bytes

    Returns:
        (width, height) tuple
    """
    image = Image.open(io.BytesIO(image_data))
    return image.size


def resize_image(
    image_data: bytes,
    max_size: int = 1024,
    maintain_aspect: bool = True
) -> bytes:
    """Resize image to maximum dimension.

    Args:
        image_data: Raw image bytes
        max_size: Maximum dimension (width or height)
        maintain_aspect: Whether to maintain aspect ratio

    Returns:
        Resized image bytes (PNG format)
    """
    image = Image.open(io.BytesIO(image_data))

    if maintain_aspect:
        image.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
    else:
        image = image.resize((max_size, max_size), Image.Resampling.LANCZOS)

    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def convert_to_png(image_data: bytes) -> bytes:
    """Convert any image format to PNG.

    Args:
        image_data: Raw image bytes (any format)

    Returns:
        PNG image bytes
    """
    image = Image.open(io.BytesIO(image_data))

    # Convert to RGB if necessary (removes alpha for some formats)
    if image.mode in ('RGBA', 'LA') or (image.mode == 'P' and 'transparency' in image.info):
        # Keep alpha channel
        image = image.convert('RGBA')
    else:
        image = image.convert('RGB')

    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def create_green_background_image(
    image_data: bytes,
    mask_data: bytes,
    background_color: Tuple[int, int, int] = (0, 255, 0)
) -> bytes:
    """Create image with masked region on colored background.

    Used for autotrace SVG conversion.

    Args:
        image_data: Original image bytes
        mask_data: Mask bytes (white = keep)
        background_color: RGB tuple for background (default: green)

    Returns:
        PNG bytes with masked region on colored background
    """
    image = Image.open(io.BytesIO(image_data)).convert('RGBA')
    mask = Image.open(io.BytesIO(mask_data)).convert('L')

    # Ensure same size
    if mask.size != image.size:
        mask = mask.resize(image.size, Image.Resampling.LANCZOS)

    # Create background
    background = Image.new('RGB', image.size, background_color)

    # Create composite
    image_rgb = image.convert('RGB')

    # Use mask to composite
    mask_np = np.array(mask)
    image_np = np.array(image_rgb)
    background_np = np.array(background)

    # Where mask is white, use image; where black, use background
    mask_bool = mask_np > 127
    result_np = np.where(
        mask_bool[:, :, np.newaxis],
        image_np,
        background_np
    )

    result = Image.fromarray(result_np.astype(np.uint8))
    buffer = io.BytesIO()
    result.save(buffer, format='PNG')
    return buffer.getvalue()


def crop_to_bbox(
    image_data: bytes,
    bbox: dict,
    padding: int = 0
) -> bytes:
    """Crop image to bounding box.

    Args:
        image_data: Raw image bytes
        bbox: {"x": int, "y": int, "width": int, "height": int}
        padding: Extra pixels to include around bbox

    Returns:
        Cropped image bytes
    """
    image = Image.open(io.BytesIO(image_data))
    width, height = image.size

    x = max(0, bbox["x"] - padding)
    y = max(0, bbox["y"] - padding)
    x2 = min(width, bbox["x"] + bbox["width"] + padding)
    y2 = min(height, bbox["y"] + bbox["height"] + padding)

    cropped = image.crop((x, y, x2, y2))

    buffer = io.BytesIO()
    cropped.save(buffer, format='PNG')
    return buffer.getvalue()


def overlay_images(
    background: bytes,
    foreground: bytes,
    position: Tuple[int, int] = (0, 0),
    use_alpha: bool = True
) -> bytes:
    """Overlay foreground image on background.

    Args:
        background: Background image bytes
        foreground: Foreground image bytes
        position: (x, y) position to place foreground
        use_alpha: Whether to use foreground's alpha channel

    Returns:
        Composited image bytes
    """
    bg = Image.open(io.BytesIO(background)).convert('RGBA')
    fg = Image.open(io.BytesIO(foreground)).convert('RGBA')

    # Create composite
    result = bg.copy()

    if use_alpha:
        result.paste(fg, position, fg)
    else:
        result.paste(fg, position)

    # Convert to RGB for output
    result_rgb = Image.new('RGB', result.size, (255, 255, 255))
    result_rgb.paste(result, mask=result.split()[3])

    buffer = io.BytesIO()
    result_rgb.save(buffer, format='PNG')
    return buffer.getvalue()
