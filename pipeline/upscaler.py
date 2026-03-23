import os
from io import BytesIO
from typing import Callable

import requests
import torch
import torchvision.transforms.functional as TF
from PIL import Image
from spandrel import ImageModelDescriptor, ModelLoader

MODELS_DIR = os.path.join(os.path.dirname(__file__), "..", "models")

MODELS = {
    "realesrgan-x4": "RealESRGAN_x4plus.pth",
    "realesrgan-x2": "RealESRGAN_x2plus.pth",
    "realesrgan-x4-anime": "RealESRGAN_x4plus_anime_6B.pth",
}

DOWNLOAD_URLS = {
    "realesrgan-x4": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
    "realesrgan-x2": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth",
    "realesrgan-x4-anime": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth",
}

_loaded: dict = {}


def list_available() -> list[str]:
    return [
        name
        for name, fn in MODELS.items()
        if os.path.isfile(os.path.join(MODELS_DIR, fn))
    ]


def download_model(model: str, progress_cb: Callable[[float, str], None]) -> None:
    """Download a model .pth file with progress. Calls progress_cb(pct, msg)."""
    if model not in MODELS:
        raise ValueError(f"Unknown model: {model}")
    path = os.path.join(MODELS_DIR, MODELS[model])
    if os.path.isfile(path):
        progress_cb(100.0, "Already downloaded")
        return
    url = DOWNLOAD_URLS[model]
    os.makedirs(MODELS_DIR, exist_ok=True)
    tmp = path + ".tmp"
    try:
        r = requests.get(url, stream=True, timeout=30)
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        done = 0
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=65536):
                f.write(chunk)
                done += len(chunk)
                pct = (done / total * 100) if total else 0
                mb_done = done / 1024 / 1024
                mb_total = total / 1024 / 1024
                progress_cb(pct, f"Downloading… {mb_done:.1f} / {mb_total:.1f} MB")
        os.replace(tmp, path)
        progress_cb(100.0, "Download complete")
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def _load_model(name: str):
    if name in _loaded:
        return _loaded[name]
    path = os.path.join(MODELS_DIR, MODELS[name])
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Model file not found: {path}")
    descriptor = ModelLoader().load_from_file(path)
    if not isinstance(descriptor, ImageModelDescriptor):
        raise ValueError(f"Model {name} is not a single-image model")
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = descriptor.model.eval().to(device)
    _loaded[name] = model
    return model


TILE_SIZE = 512  # safe for ~4 GB VRAM; each tile processed independently


def _detect_scale(net, c: int, device) -> int:
    with torch.no_grad():
        probe = net(torch.zeros(1, c, 4, 4, device=device))
    return probe.shape[-1] // 4


def _upscale_tiled(net, tensor: torch.Tensor, scale: int, device) -> torch.Tensor:
    """Upscale by processing TILE_SIZE×TILE_SIZE patches to avoid OOM."""
    b, c, h, w = tensor.shape
    tensor = tensor.to(device)
    out = torch.zeros(b, c, h * scale, w * scale, device=device)
    for y in range(0, h, TILE_SIZE):
        for x in range(0, w, TILE_SIZE):
            patch = tensor[:, :, y : y + TILE_SIZE, x : x + TILE_SIZE]
            with torch.no_grad():
                patch_out = net(patch)
            y2, x2 = min(y + TILE_SIZE, h), min(x + TILE_SIZE, w)
            out[:, :, y * scale : y2 * scale, x * scale : x2 * scale] = patch_out
    return out.cpu()


def upscale(image_bytes: bytes, model: str = "realesrgan-x4") -> bytes:

    if model not in MODELS:
        raise ValueError(f"Unknown model: {model}. Choose from: {list(MODELS)}")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    net = _load_model(model)

    img = Image.open(BytesIO(image_bytes))
    has_alpha = img.mode == "RGBA"
    rgb = img.convert("RGB")

    tensor = TF.to_tensor(rgb).unsqueeze(0)
    scale = _detect_scale(net, tensor.shape[1], device)
    out_tensor = _upscale_tiled(net, tensor, scale, device)
    out_img = TF.to_pil_image(out_tensor.squeeze(0).clamp(0, 1))

    if has_alpha:
        alpha = img.split()[3].resize(out_img.size, Image.BICUBIC)
        out_img.putalpha(alpha)

    buf = BytesIO()
    out_img.save(buf, format="PNG")
    return buf.getvalue()
