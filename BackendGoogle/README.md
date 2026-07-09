# FabDreamer Backend (Gemini Version)

## Overview

This is a new backend implementation using Google's Gemini 2.5 Flash API to replace the multi-API architecture of the original backend.

## API Replacement Map

| Original API | Purpose | New (Gemini) |
|-------------|---------|--------------|
| Qwen VL Max | Image analysis, layer detection | Gemini 2.5 Flash Vision |
| Grounding DINO | Object detection (bounding boxes) | Gemini 2.5 Flash Vision |
| SAM2 (local) | Segmentation masks | Gemini 2.5 Flash Vision |
| Stability AI | Object removal/inpainting | Gemini 2.5 Flash Image Generation |
| FLUX.1 (local) | Text-to-image generation | Gemini Imagen 3 |

## Benefits

- **Single API**: One provider instead of 5+
- **No GPU Required**: All processing via API
- **Lower Cost**: ~$0.04-0.08 per image vs ~$0.25
- **Simpler Maintenance**: One SDK, one auth token
- **Lower Latency**: Fewer round trips

## Setup

```bash
cd BackendGoogle
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows
pip install -r requirements.txt
cp .env.example .env
# Add your GEMINI_API_KEY to .env
python main.py
```

## Environment Variables

```
GEMINI_API_KEY=your_gemini_api_key_here
PORT=8000
```

## API Endpoints

Same as original backend for frontend compatibility:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/detect-and-segment` | POST | Main pipeline - analyze, detect, segment, inpaint |
| `/generate-image` | POST | Text-to-image generation |
| `/status` | GET | Health check |

## Project Structure

```
BackendGoogle/
├── main.py                 # FastAPI app and routes
├── requirements.txt        # Python dependencies
├── .env.example           # Environment template
├── services/
│   ├── gemini_client.py   # Gemini API wrapper
│   ├── image_analyzer.py  # Layer analysis + detection
│   ├── segmentation.py    # Mask generation
│   ├── inpainting.py      # Object removal
│   └── image_generator.py # Text-to-image
├── utils/
│   ├── image_utils.py     # Image processing helpers
│   └── svg_converter.py   # PNG mask to SVG
├── prompts/
│   └── prompts.py         # All Gemini prompts
└── tests/
    ├── test_detection.py
    ├── test_segmentation.py
    └── test_inpainting.py
```

## Development Status

- [ ] Project setup
- [ ] Gemini client wrapper
- [ ] Image analysis (layer detection)
- [ ] Object detection (bounding boxes)
- [ ] Segmentation masks
- [ ] Inpainting (object removal)
- [ ] Full pipeline integration
- [ ] Frontend compatibility testing

## Testing

```bash
# Run individual tests
python -m pytest tests/test_detection.py -v
python -m pytest tests/test_segmentation.py -v
python -m pytest tests/test_inpainting.py -v

# Run all tests
python -m pytest tests/ -v
```
