"""MIBOX Asset Browser for ComfyUI.

The node embeds the local asset browser HTML in a DOM widget.  Images chosen in
the browser are uploaded to ComfyUI's input directory (the upload itself is
local) and the node returns all chosen images as one IMAGE batch.

ComfyUI's own PreviewImage node automatically slices this batch when several
PreviewImage nodes are connected to the same MIBOXAssetBrowser output.  The
patch is deliberately scoped to previews whose direct input comes from this
plugin; all other PreviewImage usage keeps ComfyUI's normal behavior.
"""

from __future__ import annotations

import importlib
import json
import os
import re
import shutil
import time
import uuid
from pathlib import PurePosixPath

import numpy as np
import torch
from PIL import Image

try:
    import folder_paths
except Exception:  # pragma: no cover - allows importing outside ComfyUI
    folder_paths = None

try:
    from aiohttp import web
    from server import PromptServer
except Exception:  # pragma: no cover - only used inside ComfyUI
    PromptServer = None
    web = None


UPLOAD_ROOT_NAME = "mibox_asset_browser"
SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
MAX_UPLOAD_FILES = 300
RESERVED_WINDOWS_NAMES = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$", re.IGNORECASE)
INVALID_FILENAME_CHARS = re.compile(r'[\x00-\x1f<>:"|?*\\]')


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _input_root() -> str:
    if folder_paths is None:
        raise RuntimeError("folder_paths 不可用，请确认插件运行在 ComfyUI 内。")
    root = os.path.abspath(folder_paths.get_input_directory())
    os.makedirs(root, exist_ok=True)
    return root


def _safe_segment(segment: str, fallback: str = "image") -> str:
    name = str(segment or "").replace("/", "_").replace("\\", "_")
    name = INVALID_FILENAME_CHARS.sub("_", name).strip(" .")
    if not name or name in (".", ".."):
        name = fallback
    if RESERVED_WINDOWS_NAMES.match(name):
        name = "_" + name
    if len(name) > 140:
        stem, ext = os.path.splitext(name)
        name = stem[:120] + ext[:20]
    return name or fallback


def _safe_relative_path(raw_path: str, fallback_name: str) -> str:
    """Return a sanitized, relative, forward-slash path."""
    clean = str(raw_path or "").replace("\\", "/").lstrip("/")
    parts = []
    for part in PurePosixPath(clean).parts:
        if part in ("", ".", ".."):
            continue
        parts.append(_safe_segment(part))
    if not parts:
        parts = [_safe_segment(fallback_name, "image")]
    return "/".join(parts)


def _unique_path(directory: str, relative_path: str) -> str:
    """Find a non-existing path under directory and create its parent dirs."""
    directory = os.path.abspath(directory)
    rel_parts = [part for part in relative_path.split("/") if part]
    candidate = os.path.abspath(os.path.join(directory, *rel_parts))
    if os.path.commonpath([directory, candidate]) != directory:
        raise ValueError("非法上传路径")

    parent = os.path.dirname(candidate)
    os.makedirs(parent, exist_ok=True)
    stem, ext = os.path.splitext(candidate)
    counter = 2
    while os.path.exists(candidate):
        candidate = f"{stem} ({counter}){ext}"
        counter += 1
    return candidate


def _cleanup_old_sessions(upload_root: str) -> None:
    try:
        now = time.time()
        for name in os.listdir(upload_root):
            path = os.path.join(upload_root, name)
            if not os.path.isdir(path):
                continue
            try:
                if now - os.path.getmtime(path) > SESSION_MAX_AGE_SECONDS:
                    shutil.rmtree(path, ignore_errors=True)
            except OSError:
                continue
    except OSError:
        return


def _resolve_uploaded_path(relative_path: str) -> str:
    """Resolve a stored upload path safely inside ComfyUI's input directory."""
    root = _input_root()
    normalized = str(relative_path or "").replace("\\", "/").strip("/")
    if not normalized.startswith(UPLOAD_ROOT_NAME + "/"):
        raise ValueError("节点中的图片路径不属于素材浏览器上传目录。")

    parts = [p for p in normalized.split("/") if p not in ("", ".", "..")]
    if len(parts) < 3:
        raise ValueError("节点中的图片路径无效。")

    full_path = os.path.abspath(os.path.join(root, *parts))
    if os.path.commonpath([root, full_path]) != root:
        raise ValueError("节点中的图片路径越界。")
    if not os.path.isfile(full_path):
        raise ValueError(f"图片文件不存在：{normalized}")
    return full_path


def _load_rgb_image(path: str) -> tuple[Image.Image, np.ndarray]:
    with Image.open(path) as image:
        image.load()
        rgb = image.convert("RGB")
    array = np.asarray(rgb, dtype=np.float32) / 255.0
    return rgb, array


def _node_sort_key(node_id: str):
    text = str(node_id)
    match = re.match(r"(\d+)", text)
    if match:
        return (0, int(match.group(1)), text)
    return (1, 0, text)


def _prompt_link(value):
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return tuple(str(part) for part in value)
    return None


def _load_preview_original(source: dict, position: int):
    """Load the original file for a preview slot, preserving its native size."""
    try:
        raw_data = (source.get("inputs") or {}).get("images_data")
        if isinstance(raw_data, str):
            entries = json.loads(raw_data or "[]")
        elif isinstance(raw_data, list):
            entries = raw_data
        else:
            return None
        if not isinstance(entries, list) or not entries:
            return None

        entry = entries[position % len(entries)]
        if isinstance(entry, str):
            relative_path = entry
        elif isinstance(entry, dict):
            relative_path = entry.get("path") or entry.get("filename")
        else:
            return None
        if not relative_path:
            return None

        full_path = _resolve_uploaded_path(relative_path)
        _, array = _load_rgb_image(full_path)
        return torch.from_numpy(array).unsqueeze(0)
    except Exception as exc:
        print("[MIBOX AssetBrowser] native preview fallback:", exc)
        return None


def _slice_preview_batch(images, prompt: dict | None, unique_id: str | None):
    """Return one frame for each standard PreviewImage on a MIBOX output.

    A single output link cannot carry different data to each downstream node.
    However, when several standard PreviewImage nodes are attached to the same
    MIBOX output, each preview may save a distinct frame based on its node-id
    order.  With zero or one preview connected, normal ComfyUI behavior (show
    the entire batch) is kept.

    For multiple previews we load the original uploaded file instead of slicing
    the padded batch.  This keeps each preview's native size/aspect ratio, even
    though the IMAGE batch itself must use one common padded resolution.
    """
    try:
        if not prompt or unique_id is None or not hasattr(images, "shape"):
            return images
        current = str(unique_id)
        own_data = prompt.get(current)
        if not isinstance(own_data, dict):
            return images
        target = _prompt_link((own_data.get("inputs") or {}).get("images"))
        if target is None:
            return images

        source = prompt.get(target[0])
        if not isinstance(source, dict) or source.get("class_type") != "MIBOXAssetBrowser":
            return images

        siblings: list[str] = []
        for node_id, node_data in prompt.items():
            if not isinstance(node_data, dict):
                continue
            if node_data.get("class_type") != "PreviewImage":
                continue
            link = _prompt_link((node_data.get("inputs") or {}).get("images"))
            if link == target:
                siblings.append(str(node_id))

        if len(siblings) <= 1:
            return images
        siblings.sort(key=_node_sort_key)
        if current not in siblings:
            return images

        batch_size = int(images.shape[0])
        if batch_size <= 1:
            return images
        position = siblings.index(current)
        native = _load_preview_original(source, position)
        if native is not None:
            return native
        index = position % batch_size
        return images[index:index + 1]
    except Exception as exc:
        print("[MIBOX AssetBrowser] preview slice fallback:", exc)
        return images


def _install_previewimage_patch() -> None:
    """Extend core PreviewImage only for inputs coming from this plugin."""
    try:
        comfy_nodes = importlib.import_module("nodes")
        preview_class = getattr(comfy_nodes, "PreviewImage", None)
    except Exception as exc:
        print("[MIBOX AssetBrowser] cannot patch PreviewImage:", exc)
        return
    if preview_class is None or getattr(preview_class, "_mibox_asset_patch", False):
        return

    original_input_types = preview_class.INPUT_TYPES
    original_save_images = preview_class.save_images

    @classmethod
    def patched_input_types(cls):
        func = getattr(original_input_types, "__func__", original_input_types)
        data = func(cls)
        if isinstance(data, dict):
            data.setdefault("hidden", {})["unique_id"] = "UNIQUE_ID"
        return data

    def patched_save_images(self, images, filename_prefix="ComfyUI", prompt=None, extra_pnginfo=None, unique_id=None, **kwargs):
        selected = _slice_preview_batch(images, prompt, unique_id)
        output = original_save_images(
            self,
            selected,
            filename_prefix=filename_prefix,
            prompt=prompt,
            extra_pnginfo=extra_pnginfo,
            **kwargs,
        )
        # Keep PreviewImage's (rarely used) output semantically equivalent to
        # ComfyUI's stock node: the UI gets one sliced frame, but downstream
        # nodes still receive the original batch.
        if isinstance(output, dict) and "result" in output:
            output["result"] = (images,)
        return output

    preview_class.INPUT_TYPES = patched_input_types
    preview_class.save_images = patched_save_images
    preview_class._mibox_asset_patch = True
    print("[MIBOX AssetBrowser] patched core PreviewImage for automatic per-preview slicing")


# ---------------------------------------------------------------------------
# Upload endpoint
# ---------------------------------------------------------------------------

def _register_routes() -> None:
    if PromptServer is None or web is None:
        return
    if getattr(_register_routes, "_done", False):
        return
    try:
        routes = PromptServer.instance.routes
    except Exception:
        return
    _register_routes._done = True

    @routes.post("/mibox_asset_browser/upload")
    async def upload_assets(request):
        session_dir = None
        try:
            post = await request.post()
            raw_fields = post.getall("files") or post.getall("file") or []
            if not raw_fields:
                return web.json_response({"ok": False, "error": "没有收到图片文件。"}, status=400)
            if len(raw_fields) > MAX_UPLOAD_FILES:
                return web.json_response(
                    {"ok": False, "error": f"一次最多同步 {MAX_UPLOAD_FILES} 张图片。"},
                    status=400,
                )

            try:
                paths = json.loads(post.get("paths") or "[]")
                if not isinstance(paths, list):
                    paths = []
            except Exception:
                paths = []

            input_root = _input_root()
            upload_root = os.path.join(input_root, UPLOAD_ROOT_NAME)
            os.makedirs(upload_root, exist_ok=True)
            _cleanup_old_sessions(upload_root)

            session = time.strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:8]
            session_dir = os.path.join(upload_root, session)
            os.makedirs(session_dir, exist_ok=True)

            uploaded = []
            for index, field in enumerate(raw_fields):
                filename = getattr(field, "filename", None) or f"image_{index + 1}.jpg"
                raw_path = paths[index] if index < len(paths) else filename
                relative_path = _safe_relative_path(raw_path, filename)
                destination = _unique_path(session_dir, relative_path)

                field.file.seek(0)
                with open(destination, "wb") as handle:
                    shutil.copyfileobj(field.file, handle)

                try:
                    with Image.open(destination) as image:
                        image.load()
                        width, height = image.size
                        image_format = (image.format or "").upper()
                        if width <= 0 or height <= 0:
                            raise ValueError("无效的图片尺寸")
                except Exception as exc:
                    try:
                        os.remove(destination)
                    except OSError:
                        pass
                    raise ValueError(f"无法读取图片「{filename}」：{exc}") from exc

                rel_from_session = os.path.relpath(destination, session_dir).replace("\\", "/")
                uploaded.append({
                    "path": f"{UPLOAD_ROOT_NAME}/{session}/{rel_from_session}",
                    "name": os.path.basename(filename),
                    "source": relative_path,
                    "width": int(width),
                    "height": int(height),
                    "format": image_format,
                    "size": os.path.getsize(destination),
                })

            return web.json_response({
                "ok": True,
                "session": session,
                "count": len(uploaded),
                "files": uploaded,
            })
        except Exception as exc:
            print("[MIBOX AssetBrowser] upload error:", exc)
            if session_dir:
                shutil.rmtree(session_dir, ignore_errors=True)
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    try:
        print("[MIBOX AssetBrowser] route registered: POST /mibox_asset_browser/upload")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------

class MIBOXAssetBrowser:
    """Browse a local image folder and output the chosen images as one batch."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images_data": ("STRING", {
                    "default": "[]",
                    "multiline": False,
                    "tooltip": "由节点内嵌素材浏览器自动写入；请不要手动修改。",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "load_images"
    CATEGORY = "🔵BB 3DViewer"
    DESCRIPTION = (
        "在节点内嵌的素材浏览器中选择图片后会自动同步，"
        "选中的图片会作为单个 IMAGE batch 从唯一输出口输出。"
        "多个标准预览图像节点连接同一个输出时会自动分别显示不同图片。"
    )
    OUTPUT_TOOLTIPS = ("选中的图片批次；连接多个标准预览图像节点时会自动分图。",)

    def load_images(self, images_data="[]"):
        try:
            entries = json.loads(images_data or "[]")
        except Exception as exc:
            raise ValueError("节点中的图片选择数据损坏，请重新在素材浏览器中选择图片。") from exc
        if not isinstance(entries, list):
            raise ValueError("节点中的图片选择数据格式无效。")
        if not entries:
            raise ValueError("请先在节点内选择图片。")

        arrays = []
        max_width = 0
        max_height = 0
        for entry in entries:
            if isinstance(entry, str):
                relative_path = entry
            elif isinstance(entry, dict):
                relative_path = entry.get("path") or entry.get("filename")
            else:
                continue
            if not relative_path:
                continue

            path = _resolve_uploaded_path(relative_path)
            _, array = _load_rgb_image(path)
            height, width = array.shape[:2]
            arrays.append(array)
            max_width = max(max_width, width)
            max_height = max(max_height, height)

        if not arrays:
            raise ValueError("没有可读取的图片，请重新在素材浏览器中选择。")

        # Different source resolutions are letterboxed onto a common canvas so
        # ComfyUI receives a valid batch without stretching the images.
        batch = np.zeros((len(arrays), max_height, max_width, 3), dtype=np.float32)
        for index, array in enumerate(arrays):
            height, width = array.shape[:2]
            x = (max_width - width) // 2
            y = (max_height - height) // 2
            batch[index, y:y + height, x:x + width, :] = array

        return (torch.from_numpy(batch),)


# Register routes during custom-node import, before aiohttp freezes its router.
_register_routes()
_install_previewimage_patch()


NODE_CLASS_MAPPINGS = {
    "MIBOXAssetBrowser": MIBOXAssetBrowser,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MIBOXAssetBrowser": "🔵BB 素材浏览器",
}

__all__ = [
    "MIBOXAssetBrowser",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
