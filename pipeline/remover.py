import os
from typing import Any
from io import BytesIO
from PIL import Image
from rembg import remove, new_session

_sessions: dict[str, Any] = {}

MODEL_LIST = [
    {"id": "birefnet-general", "label": "BiRefNet General"},
    {"id": "bria-rmbg", "label": "BRIA RMBG"},
    {"id": "birefnet-portrait", "label": "BiRefNet Portrait"},
    {"id": "isnet-general-use", "label": "ISNet"},
    {"id": "u2net", "label": "U2Net"},
]

MODELS = {m["id"]: m["id"] for m in MODEL_LIST}

_CACHE_DIR = os.path.expanduser("~/.u2net")


def _get_session(model: str):
    if model not in _sessions:
        _sessions[model] = new_session(model)
    return _sessions[model]


def bg_model_status() -> dict[str, str]:
    """Returns 'loaded' | 'cached' | 'not_downloaded' for each model."""
    cached_stems: set[str] = set()
    if os.path.isdir(_CACHE_DIR):
        for f in os.listdir(_CACHE_DIR):
            cached_stems.add(os.path.splitext(f)[0].lower())

    result = {}
    for model, key in MODELS.items():
        if key in _sessions:
            result[model] = "loaded"
        elif any(key.lower() in stem for stem in cached_stems):
            result[model] = "cached"
        else:
            result[model] = "not_downloaded"
    return result


def preload_model(model: str) -> str:
    """Load model into memory. Returns 'loaded' | 'cached' | 'not_downloaded' (prior state)."""
    if model not in MODELS:
        raise ValueError(f"Unknown model: {model}. Choose from: {list(MODELS)}")
    prior = bg_model_status().get(model, "not_downloaded")
    _get_session(MODELS[model])
    return prior


def remove_background(image_bytes: bytes, model: str = "birefnet-general") -> bytes:
    if model not in MODELS:
        raise ValueError(f"Unknown model: {model}. Choose from: {list(MODELS)}")
    session = _get_session(MODELS[model])
    img = Image.open(BytesIO(image_bytes)).convert("RGBA")
    result = remove(img, session=session)
    out = BytesIO()
    result.save(out, format="PNG")
    return out.getvalue()
