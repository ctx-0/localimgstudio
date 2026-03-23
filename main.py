import asyncio
import json
import os
import threading
from collections.abc import Callable
from typing import Any

import torch
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from pipeline.remover import (
    remove_background,
    preload_model,
    bg_model_status,
    MODELS as BG_MODELS,
    MODEL_LIST as BG_MODEL_LIST,
)
from pipeline.upscaler import (
    upscale,
    download_model,
    list_available as upscale_available,
    MODELS as UP_MODELS,
)


async def run_sync(fn: Callable[..., Any], *args: Any) -> Any:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, fn, *args)


def _sse_stream(worker: Callable[[Callable[[dict], None]], None]):
    """Run worker(put_fn) in a thread, stream results as SSE."""
    queue: asyncio.Queue = asyncio.Queue()

    async def generate():
        loop = asyncio.get_running_loop()

        def put(data: dict):
            loop.call_soon_threadsafe(queue.put_nowait, data)

        threading.Thread(target=worker, args=(put,), daemon=True).start()

        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=1.0)
                yield f"data: {json.dumps(item)}\n\n"
                if item["phase"] in ("ready", "error"):
                    break
            except asyncio.TimeoutError:
                yield ": ping\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


app = FastAPI(title="LocalImg-01")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/device")
def device():
    gpu = torch.cuda.is_available()
    name = torch.cuda.get_device_name(0) if gpu else "CPU"
    return {"gpu": gpu, "name": name}


@app.get("/models")
def models():
    return {
        "bg_models": BG_MODEL_LIST,
        "bg_removal": bg_model_status(),
        "upscaling": {k: (k in upscale_available()) for k in UP_MODELS},
    }


@app.get("/load-model/stream")
async def load_model_stream(model: str):
    if model not in BG_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model: {model}")

    def worker(put):
        try:
            prior = bg_model_status().get(model, "not_downloaded")
            if prior == "loaded":
                put({"phase": "ready", "msg": "Already loaded in memory"})
                return
            if prior == "cached":
                put({"phase": "loading", "msg": "Loading cached model into memory…"})
            else:
                put(
                    {
                        "phase": "downloading",
                        "msg": "Downloading model — this may take a while…",
                    }
                )
            preload_model(model)
            put({"phase": "ready", "msg": "Model ready"})
        except Exception as e:
            put({"phase": "error", "msg": str(e)})

    return _sse_stream(worker)


@app.get("/download-upscale/stream")
async def download_upscale_stream(model: str):
    if model not in UP_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model: {model}")

    def worker(put):
        try:

            def progress(pct, msg):
                put({"phase": "downloading", "pct": round(pct, 1), "msg": msg})

            download_model(model, progress)
            put({"phase": "ready", "msg": "Model ready", "pct": 100})
        except Exception as e:
            put({"phase": "error", "msg": str(e)})

    return _sse_stream(worker)


@app.post("/remove-bg")
async def remove_bg(
    file: UploadFile = File(...),
    model: str = Form("birefnet-general"),
):
    data = await file.read()
    try:
        result = await run_sync(remove_background, data, model)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return Response(content=result, media_type="image/png")


@app.post("/upscale")
async def upscale_image(
    file: UploadFile = File(...),
    model: str = Form("realesrgan-x4"),
):
    data = await file.read()
    try:
        result = await run_sync(upscale, data, model)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return Response(content=result, media_type="image/png")


static_dir = os.path.join(os.path.dirname(__file__), "static")
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
