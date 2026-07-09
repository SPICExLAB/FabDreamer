# SAM2 Segmentation Server

Standalone FastAPI server that runs Meta's [SAM2](https://github.com/facebookresearch/sam2) for pixel-perfect segmentation. The FabDreamer backend calls it over HTTP (`SAM2_SERVER_URL`).

Runs on Apple Silicon (MPS) or NVIDIA GPUs (CUDA). A machine with ≥16 GB RAM is recommended for the `large` checkpoint.

## Setup

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Install SAM2 from source
pip install git+https://github.com/facebookresearch/sam2.git

# Download the checkpoint (~2.3 GB)
mkdir -p checkpoints
curl -L -o checkpoints/sam2.1_hiera_large.pt \
  https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt
```

The config file `configs/sam2.1/sam2.1_hiera_l.yaml` ships with the `sam2` package.

## Run

```bash
python sam2_server.py
# → SAM2 model loaded successfully!
# → Uvicorn running on http://0.0.0.0:8666
```

Health check:

```bash
curl http://localhost:8666/health
# {"status":"healthy","model_loaded":true,"device":"mps"}
```

Then point the FabDreamer backend at it in `BackendGoogle/.env`:

```
SAM2_SERVER_URL=http://localhost:8666
```

(or the LAN address of this machine if it runs elsewhere).
