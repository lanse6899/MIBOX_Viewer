"""MIBOX 3D viewer node with embedded HTML viewer.

The node accepts a ComfyUI FILE_3D model, asks the browser node widget to add
that model to the embedded MIBOX viewer, waits for the browser to send back a
PNG screenshot, and exposes that screenshot as an IMAGE output.  When the
`sequence` output is connected, the viewer also plays the model animation once
and uploads the sampled frames, which are exposed as an IMAGE batch.
"""

from __future__ import annotations

import asyncio
import base64
import io
import os
import threading
import time
import uuid

import numpy as np
import torch
from PIL import Image

try:
    import folder_paths
except Exception:  # pragma: no cover - only in unusual test environments
    folder_paths = None

try:
    from server import PromptServer
    from aiohttp import web
except Exception:  # pragma: no cover
    PromptServer = None
    web = None


MAX_SEQUENCE_FRAMES = 600
SEQUENCE_MAX_AGE_SECONDS = 60 * 60

_PENDING: dict[str, dict] = {}
_SEQUENCES: dict[str, dict] = {}
_LAST_IMAGES: dict[str, Image.Image] = {}
_MODEL_FILES: dict[str, str] = {}
_TEMP_DIR = None


def _get_temp_dir() -> str:
    global _TEMP_DIR
    if _TEMP_DIR:
        return _TEMP_DIR
    if folder_paths is not None:
        try:
            _TEMP_DIR = os.path.join(folder_paths.get_temp_directory(), "mibox_viewer")
        except Exception:
            _TEMP_DIR = None
    if not _TEMP_DIR:
        import tempfile

        _TEMP_DIR = os.path.join(tempfile.gettempdir(), "mibox_viewer")
    os.makedirs(_TEMP_DIR, exist_ok=True)
    return _TEMP_DIR


def _image_to_tensor(image: Image.Image) -> torch.Tensor:
    array = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(array)[None, ...]


def _output_connected(prompt, unique_id, slot: int) -> bool:
    """Return True when a prompt link reads the given output slot of this node."""
    if not prompt or unique_id is None:
        return False
    key = str(unique_id)
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        for value in (node.get("inputs") or {}).values():
            if isinstance(value, (list, tuple)) and len(value) == 2:
                if str(value[0]) == key and str(value[1]) == str(slot):
                    return True
    return False


def _decode_sequence_frames(data_urls) -> list[Image.Image]:
    frames = []
    for data in data_urls:
        image_data = str(data or "")
        if "," in image_data and image_data.strip().startswith("data:"):
            image_data = image_data.split(",", 1)[1]
        frames.append(Image.open(io.BytesIO(base64.b64decode(image_data))).convert("RGB"))
    return frames


def _take_sequence(request_id: str):
    entry = _SEQUENCES.pop(request_id, None)
    if not entry:
        return None
    frames = entry["frames"]
    if not frames or any(frame is None for frame in frames):
        return None
    return frames


def _sequence_to_tensor(frames) -> torch.Tensor:
    width, height = frames[0].size
    batch = np.empty((len(frames), height, width, 3), dtype=np.float32)
    for index, frame in enumerate(frames):
        batch[index] = np.asarray(frame.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(batch)


def _register_routes() -> None:
    if PromptServer is None or web is None:
        return
    try:
        # PromptServer.instance.routes is an aiohttp RouteTableDef.
        routes = PromptServer.instance.routes
    except Exception:
        return

    # Add routes only once.
    if getattr(_register_routes, "_done", False):
        return
    _register_routes._done = True

    @routes.post("/mibox_viewer/capture")
    async def mibox_capture(request):
        try:
            payload = await request.json()
            request_id = str(payload.get("request_id") or "")
            image_data = payload.get("image") or ""
            if not request_id or not image_data:
                return web.json_response({"ok": False, "error": "missing request_id or image"}, status=400)

            if "," in image_data and image_data.strip().startswith("data:"):
                image_data = image_data.split(",", 1)[1]
            image = Image.open(io.BytesIO(base64.b64decode(image_data))).convert("RGB")

            pending = _PENDING.get(request_id)
            if pending is not None:
                pending["image"] = image
                pending["event"].set()
            return web.json_response({"ok": True})
        except Exception as exc:
            print("[MIBOX] capture error:", exc)
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/mibox_viewer/sequence")
    async def mibox_sequence(request):
        try:
            payload = await request.json()
            request_id = str(payload.get("request_id") or "")
            total = int(payload.get("total") or 0)
            start = int(payload.get("start") or 0)
            data_urls = payload.get("frames") or []
            if not request_id or not data_urls:
                return web.json_response({"ok": False, "error": "missing request_id or frames"}, status=400)
            if total <= 0 or total > MAX_SEQUENCE_FRAMES:
                return web.json_response({"ok": False, "error": "invalid sequence size"}, status=400)
            if start < 0 or start + len(data_urls) > total:
                return web.json_response({"ok": False, "error": "invalid sequence range"}, status=400)

            now = time.time()
            for stale_id, entry in list(_SEQUENCES.items()):
                if now - entry["time"] > SEQUENCE_MAX_AGE_SECONDS:
                    _SEQUENCES.pop(stale_id, None)

            entry = _SEQUENCES.get(request_id)
            if entry is None or entry["total"] != total:
                entry = {"frames": [None] * total, "total": total, "time": now}
                _SEQUENCES[request_id] = entry

            frames = await asyncio.to_thread(_decode_sequence_frames, list(data_urls))
            for offset, frame in enumerate(frames):
                entry["frames"][start + offset] = frame
            entry["time"] = time.time()
            return web.json_response({"ok": True})
        except Exception as exc:
            print("[MIBOX] sequence error:", exc)
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    @routes.get("/mibox_viewer/model/{token}")
    async def mibox_model(request):
        token = request.match_info.get("token", "")
        path = _MODEL_FILES.get(token)
        if not path or not os.path.isfile(path):
            raise web.HTTPNotFound()
        return web.FileResponse(path)

    try:
        print("[MIBOX] routes registered: /mibox_viewer/capture, /mibox_viewer/sequence, /mibox_viewer/model/{token}")
    except Exception:
        pass


def _send_viewer_request(payload: dict) -> None:
    if PromptServer is None:
        return
    try:
        PromptServer.instance.send_sync("mibox_viewer.request", payload)
    except Exception as exc:
        print("[MIBOX] send_sync error:", exc)


class MIBOXViewerNode:
    """Embed the MIBOX HTML viewport, import FILE_3D inputs, output a screenshot."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "frame_width": ("INT", {
                    "default": 360,
                    "min": 64,
                    "max": 4096,
                    "step": 1,
                    "tooltip": "红色输出线框宽度（像素），输出图会按此区域裁剪",
                }),
                "frame_height": ("INT", {
                    "default": 260,
                    "min": 64,
                    "max": 4096,
                    "step": 1,
                    "tooltip": "红色输出线框高度（像素），输出图会按此区域裁剪",
                }),
                "hide_frame": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "隐藏红色线框；输出仍按线框区域裁剪",
                }),
                "accumulate_input": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "开启时接收并累积新的 model_3d；关闭时停止接收新模型，保留当前模型",
                }),
                "sequence_fps": ("INT", {
                    "default": 24,
                    "min": 1,
                    "max": 60,
                    "step": 1,
                    "tooltip": "播放动画时序列帧的采样帧率；只有连接了 sequence 输出才会采集",
                }),
            },
            "optional": {
                "model_3d": ("FILE_3D", {
                    "tooltip": "连接到 Create 3D Animation File 的 model_3d 输出；由 accumulate_input 控制是否接收",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("image", "sequence")
    FUNCTION = "render"
    CATEGORY = "🔵BB 3DViewer"
    OUTPUT_NODE = True
    OUTPUT_TOOLTIPS = (
        "红色线框内的截图",
        "动画只播放一遍时采集的序列帧；未连接时不采集，回退为单帧截图",
    )

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Always execute so a new screenshot is produced for the current view.
        return float("nan")

    def __init__(self):
        _register_routes()

    def render(self, frame_width=360, frame_height=260, hide_frame=False, accumulate_input=True,
               sequence_fps=24, model_3d=None, unique_id=None, prompt=None):
        _register_routes()
        node_key = str(unique_id or "")
        capture_sequence = _output_connected(prompt, unique_id, 1)
        model_url = None
        file_name = None
        model_path = None

        if model_3d is not None:
            try:
                fmt = (getattr(model_3d, "format", "") or "glb").lstrip(".").lower()
                source = model_3d.get_source()
                if isinstance(source, str):
                    base_name = os.path.basename(source)
                else:
                    base_name = "mibox_model." + fmt
                token = uuid.uuid4().hex
                ext = os.path.splitext(base_name)[1]
                if not ext:
                    ext = "." + fmt
                    base_name = base_name + ext
                file_name = base_name
                model_path = os.path.join(_get_temp_dir(), token + ext)
                model_3d.save_to(model_path)
                _MODEL_FILES[token] = model_path
                model_url = f"/mibox_viewer/model/{token}"
            except Exception as exc:
                print("[MIBOX] failed to save model_3d:", exc)

        request_id = uuid.uuid4().hex
        pending = {"event": threading.Event(), "image": None}
        _PENDING[request_id] = pending

        _send_viewer_request({
            "node_id": node_key,
            "request_id": request_id,
            "model_url": model_url,
            "file_name": file_name,
            "accumulate_input": bool(accumulate_input),
            "capture_sequence": capture_sequence,
            "sequence_fps": max(1, min(60, int(sequence_fps or 24))),
        })

        # The browser viewer loads the model, renders it, and POSTs the PNG.
        # Sequence capture plays the animation before that, so allow more time.
        got_capture = pending["event"].wait(timeout=180.0 if capture_sequence else 60.0)
        _PENDING.pop(request_id, None)
        image = pending.get("image") if got_capture else None
        sequence_frames = _take_sequence(request_id) if capture_sequence else None

        if image is None:
            image = _LAST_IMAGES.get(node_key)
        if image is None:
            image = Image.new(
                "RGB",
                (max(1, int(frame_width)), max(1, int(frame_height))),
                (0, 0, 0),
            )

        _LAST_IMAGES[node_key] = image

        image_tensor = _image_to_tensor(image)
        if sequence_frames:
            sequence_tensor = _sequence_to_tensor(sequence_frames)
        else:
            sequence_tensor = image_tensor
        return {
            "result": (image_tensor, sequence_tensor),
        }


# Register HTTP routes while ComfyUI is still building its aiohttp app.
# Registering later (from a node's __init__/execute) is too late: the router
# is already frozen, and POST /mibox_viewer/capture would return 405.
_register_routes()


__all__ = ["MIBOXViewerNode", "_register_routes"]
