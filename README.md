# FabDreamer

**AI-assisted design tool for layered laser-cut art** — turn a single image (generated or uploaded) into stacked, cut-ready laser cutting layers through a three-stage human-AI workflow.

> 📄 This is the research code for our **UIST 2026** paper, [FabDreamer: Exploring the Image-to-Physical Workflow Through AI-Assisted Layered Fabrication](https://doi.org/10.1145/3830398.3830571). See [Citation](#citation) below.

## How it works

FabDreamer structures human-AI collaboration into three stages, each with a different division of labor:

| Stage | Name | AI role | What happens |
|-------|------|---------|--------------|
| 1 | **Compose** | AI-led | AI analyzes the image, proposes depth layers, and segments elements (Gemini + SAM2) |
| 2 | **Create** | Human-led | You arrange segments on layers with a 2D canvas + live 3D preview; AI assists on demand (grab, repair, sub-segment) |
| 3 | **Prepare** | AI-advisory | AI validates manufacturability (floating parts, thin features), suggests fixes like connection bridges; you decide; export cut-ready SVGs |

Exported SVGs follow the laser-cutting convention: **red strokes = cut**, **black strokes = engrave** (tested with xTool Creative Space; the attribute-based styling also survives Adobe Illustrator).

## Architecture

```
Frontend (React + Vite + Three.js + Konva)
   │
   ▼
Backend (FastAPI, Python 3.11+)
   │                       │
   ▼                       ▼
SAM2 server            Google Gemini API
(self-hosted,          (bring your own key)
 sam2-server/)
```

## Quickstart

You need three things running: the **SAM2 server**, the **backend**, and the **frontend**.

### 0. Prerequisites

- Python 3.11+ and Node.js 18+
- A **Gemini API key** — free tier available at [Google AI Studio](https://aistudio.google.com/apikey)
- A machine that can run SAM2 (Apple Silicon with MPS, or an NVIDIA GPU)

> ⚠️ The authors' demo servers (SAM2 + hosted backend) are **private** and not accessible to the public — you must self-host both, which the steps below cover.

### 1. SAM2 server

```bash
cd sam2-server
# see sam2-server/README.md for model checkpoint download + install
python sam2_server.py          # serves on http://0.0.0.0:8666
```

### 2. Backend

```bash
cd BackendGoogle
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env           # then edit: set GEMINI_API_KEY and SAM2_SERVER_URL
python main.py                 # serves on http://localhost:8000
```

### 3. Frontend

```bash
cd Frontend
npm install
cp .env.example .env           # points VITE_API_URL at the backend
npm run dev                    # opens on http://localhost:3000
```

### Try it

Open http://localhost:3000, describe what you want to create (e.g. *"a forest scene with layered trees"*) or upload an image, then follow the three stages: **Decompose → Create → Prepare**, and export cut-ready SVGs with **Export Asset**.

## Repository layout

```
BackendGoogle/     FastAPI backend: Gemini pipeline, segmentation, geometry analysis
  services/        Stage 1 layer pipeline, SAM2 client, fabrication agent (Stage 3)
  utils/           SVG conversion (mask → cut outline), geometry analyzer
  prompts/         All Gemini prompts (centralized)
  tools/           cutline_harness.py — batch regression harness for cut-line quality
Frontend/          React app: chat UI, Konva editing canvas, Three.js 3D preview, SVG export
sam2-server/       Standalone SAM2 segmentation server (FastAPI, MPS/CUDA)
```

## Citation

If you build on this work, please cite our UIST 2026 paper:

```bibtex
@inproceedings{gao2026fabdreamer,
  title     = {FabDreamer: Exploring the Image-to-Physical Workflow Through AI-Assisted Layered Fabrication},
  author    = {Gao, Chenfeng and Chen, Zeya and Yang, Anjie and Ahuja, Karan and Luo, Danli},
  booktitle = {Proceedings of the 39th Annual ACM Symposium on User Interface Software and Technology},
  series    = {UIST '26},
  pages     = {1--16},
  year      = {2026},
  publisher = {ACM},
  doi       = {10.1145/3830398.3830571},
  url       = {https://doi.org/10.1145/3830398.3830571}
}
```

## License

[MIT](LICENSE)
