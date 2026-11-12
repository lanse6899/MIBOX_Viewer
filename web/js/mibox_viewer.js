import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_NAME = "MIBOXViewer";
const HTML_URL = new URL("../MIBOX-V1.2.html?v=20261112-3", import.meta.url).href;

function getWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function notify(message) {
    try {
        const toast = app.extensionManager?.toast;
        if (toast?.add) {
            toast.add({
                severity: "warn",
                summary: "MIBOX 3D视口",
                detail: message,
                life: 6000,
            });
            return;
        }
    } catch (err) {
        // fall through to console
    }
    console.warn("[MIBOX]", message);
}

function injectStyles() {
    if (document.getElementById("mibox-viewer-styles")) return;
    const style = document.createElement("style");
    style.id = "mibox-viewer-styles";
    style.textContent = `
        .mibox-iframe-wrap {
            position: relative;
            width: 100%;
            height: 100%;
            min-height: 420px;
            background: #1b1b1b;
            border-radius: 8px;
            overflow: hidden;
            border: 1px solid #30363d;
        }
        .mibox-iframe-wrap iframe {
            width: 100%;
            height: 100%;
            min-height: 420px;
            border: 0;
            display: block;
            background: #242424;
        }
        .mibox-output-frame {
            position: absolute;
            left: 50%;
            top: 50%;
            transform: translate(-50%, -50%);
            box-sizing: border-box;
            border: 2px solid rgba(255, 45, 45, 0.95);
            pointer-events: none;
            z-index: 2;
        }
        .mibox-clear-btn {
            position: absolute;
            top: 6px;
            right: 6px;
            z-index: 3;
            padding: 3px 8px;
            font-size: 11px;
            line-height: 18px;
            color: #c9d1d9;
            background: rgba(33, 38, 45, 0.88);
            border: 1px solid #30363d;
            border-radius: 4px;
            cursor: pointer;
        }
        .mibox-clear-btn:hover {
            background: #30363d;
        }
        .mibox-accumulate-btn {
            position: absolute;
            top: 6px;
            right: 80px;
            z-index: 3;
            padding: 3px 8px;
            font-size: 11px;
            line-height: 18px;
            color: #8b949e;
            background: rgba(33, 38, 45, 0.88);
            border: 1px solid #30363d;
            border-radius: 4px;
            cursor: pointer;
        }
        .mibox-accumulate-btn:hover {
            background: #30363d;
        }
        .mibox-accumulate-btn.active {
            color: #58a6ff;
            border-color: #1f6feb;
            background: rgba(31, 111, 235, 0.18);
        }
        .mibox-play-btn {
            position: absolute;
            top: 6px;
            right: 150px;
            z-index: 3;
            padding: 3px 8px;
            font-size: 11px;
            line-height: 18px;
            color: #c9d1d9;
            background: rgba(33, 38, 45, 0.88);
            border: 1px solid #30363d;
            border-radius: 4px;
            cursor: pointer;
        }
        .mibox-play-btn:hover {
            background: #30363d;
        }
        .mibox-play-btn:disabled {
            color: #6e7681;
            cursor: default;
            background: rgba(33, 38, 45, 0.6);
        }
    `;
    document.head.appendChild(style);
}

app.registerExtension({
    name: "mibox.viewer",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            const node = this;
            injectStyles();

            const wrap = document.createElement("div");
            wrap.className = "mibox-iframe-wrap";

            const iframe = document.createElement("iframe");
            iframe.src = HTML_URL;
            iframe.allow = "pointer-lock";
            iframe.setAttribute("tabindex", "0");
            wrap.appendChild(iframe);

            const clearBtn = document.createElement("button");
            clearBtn.className = "mibox-clear-btn";
            clearBtn.textContent = "清空模型";
            clearBtn.title = "清空当前视口中累积的模型";
            wrap.appendChild(clearBtn);

            const accumulateBtn = document.createElement("button");
            accumulateBtn.className = "mibox-accumulate-btn";
            accumulateBtn.type = "button";
            wrap.appendChild(accumulateBtn);

            const playBtn = document.createElement("button");
            playBtn.className = "mibox-play-btn";
            playBtn.type = "button";
            playBtn.disabled = true;
            playBtn.textContent = "播放动画";
            wrap.appendChild(playBtn);

            const outputFrame = document.createElement("div");
            outputFrame.className = "mibox-output-frame";
            wrap.appendChild(outputFrame);

            iframe.addEventListener("load", () => {
                // The initial MIBOX_READY can race with extension setup; ping once after load.
                setTimeout(() => {
                    try {
                        iframe.contentWindow?.postMessage({ type: "MIBOX_PING" }, "*");
                    } catch (err) { /* ignore */ }
                }, 300);
            });

            try {
                if (typeof this.addDOMWidget === "function") {
                    this.addDOMWidget("mibox_html", "MIBOX_HTML", wrap, {
                        getValue() { return ""; },
                        setValue() { },
                        // Keep the iframe rendered when the graph is zoomed out.
                        // Otherwise ComfyUI replaces it with a placeholder and the
                        // capture has no canvas to read from.
                        hideOnZoom: false,
                        // 不写入 widgets_values，否则会挤占 sequence_fps 等标准控件的值
                        serialize: false,
                        computeSize: (width) => [Math.max(360, width), 560],
                    });
                }
            } catch (err) {
                console.error("[MIBOX] failed to add DOM widget", err);
            }

            const applyFrameStyle = () => {
                const widthWidget = getWidget(node, "frame_width");
                const heightWidget = getWidget(node, "frame_height");
                const hideWidget = getWidget(node, "hide_frame");
                const width = Math.max(1, parseInt(widthWidget?.value ?? 360, 10) || 360);
                const height = Math.max(1, parseInt(heightWidget?.value ?? 260, 10) || 260);
                outputFrame.style.width = width + "px";
                outputFrame.style.height = height + "px";
                outputFrame.style.display = hideWidget?.value ? "none" : "block";
            };

            // 旧工作流里 sequence_fps 可能是空字符串，会被 ComfyUI 当成非法 INT
            const normalizeSequenceFps = () => {
                const widget = getWidget(node, "sequence_fps");
                if (widget && !Number.isFinite(parseInt(widget.value, 10))) {
                    widget.value = 24;
                }
            };
            normalizeSequenceFps();

            ["frame_width", "frame_height", "hide_frame"].forEach((name) => {
                const widget = getWidget(node, name);
                if (!widget || widget._miboxWrapped) return;
                const originalCallback = widget.callback;
                widget.callback = function () {
                    const callbackResult = originalCallback?.apply(this, arguments);
                    applyFrameStyle();
                    return callbackResult;
                };
                widget._miboxWrapped = true;
            });

            const updateAccumulateButton = () => {
                const widget = getWidget(node, "accumulate_input");
                const enabled = widget ? !!widget.value : true;
                accumulateBtn.textContent = enabled ? "累积: 开" : "输入: 停";
                accumulateBtn.classList.toggle("active", enabled);
                accumulateBtn.title = enabled
                    ? "当前接收新模型输入并累加；点击关闭后停止接收新模型"
                    : "当前已停止接收新模型，保留现有模型；点击开启后恢复累积输入";
            };

            const accumulateWidget = getWidget(node, "accumulate_input");
            if (accumulateWidget && !accumulateWidget._miboxWrapped) {
                const originalCallback = accumulateWidget.callback;
                accumulateWidget.callback = function () {
                    const callbackResult = originalCallback?.apply(this, arguments);
                    updateAccumulateButton();
                    return callbackResult;
                };
                accumulateWidget._miboxWrapped = true;
            }

            accumulateBtn.addEventListener("click", () => {
                const widget = getWidget(node, "accumulate_input");
                if (!widget) return;
                widget.value = !widget.value;
                updateAccumulateButton();
                app.graph.setDirtyCanvas(true, true);
            });

            const onConfigure = this.onConfigure;
            this.onConfigure = function () {
                const configured = onConfigure?.apply(this, arguments);
                applyFrameStyle();
                updateAccumulateButton();
                window.setTimeout(normalizeSequenceFps, 0);
                return configured;
            };

            const getCropRect = () => {
                const widthWidget = getWidget(node, "frame_width");
                const heightWidget = getWidget(node, "frame_height");
                const width = Math.max(1, parseInt(widthWidget?.value ?? 360, 10) || 360);
                const height = Math.max(1, parseInt(heightWidget?.value ?? 260, 10) || 260);
                const viewWidth = iframe.clientWidth || 1;
                const viewHeight = iframe.clientHeight || 1;
                // Keep the crop inside the visible viewport; the red frame is centered.
                const cropWidth = Math.min(width, viewWidth);
                const cropHeight = Math.min(height, viewHeight);
                const x = Math.max(0, (viewWidth - cropWidth) / 2);
                const y = Math.max(0, (viewHeight - cropHeight) / 2);
                const innerWidth = iframe.contentWindow?.innerWidth || viewWidth;
                const innerHeight = iframe.contentWindow?.innerHeight || viewHeight;
                return {
                    x: x * innerWidth / viewWidth,
                    y: y * innerHeight / viewHeight,
                    width: cropWidth * innerWidth / viewWidth,
                    height: cropHeight * innerHeight / viewHeight,
                };
            };

            node._miboxIframe = iframe;
            node._miboxOutputFrame = outputFrame;
            node._miboxReady = false;
            node._miboxWaiters = new Map();

            const readyPromise = new Promise((resolve) => {
                node._miboxReadyResolve = resolve;
            });

            const waitFor = (key, requestId, timeoutMs = 45000) => {
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        node._miboxWaiters.delete(key + ":" + requestId);
                        reject(new Error("等待 MIBOX 响应超时: " + key));
                    }, timeoutMs);
                    node._miboxWaiters.set(key + ":" + requestId, (value) => {
                        clearTimeout(timer);
                        node._miboxWaiters.delete(key + ":" + requestId);
                        resolve(value);
                    });
                });
            };

            let animationKnown = false;
            let animationState = { animated: false, duration: 0 };
            let playing = false;
            let playPromise = null;

            const getSequenceFps = () => {
                const widget = getWidget(node, "sequence_fps");
                const value = parseInt(widget?.value ?? 24, 10);
                return Number.isFinite(value) ? Math.min(60, Math.max(1, value)) : 24;
            };

            const updatePlayButton = () => {
                playBtn.disabled = playing || !animationState.animated;
                playBtn.textContent = playing ? "播放中…" : (animationState.animated ? "播放动画" : "无动画");
                if (playing) {
                    playBtn.title = "正在按序列帧率播放动画";
                } else if (animationState.animated) {
                    playBtn.title = "播放一遍动画（不循环）；连接 sequence 输出后运行会按帧率采集序列帧";
                } else {
                    playBtn.title = animationKnown
                        ? "当前视口没有带动画的模型"
                        : "先运行一次，把模型加载到视口";
                }
            };

            const playAnimation = () => {
                if (playing || !animationState.animated) return;
                const requestId = "play-" + Date.now().toString(36);
                playing = true;
                updatePlayButton();
                playPromise = waitFor("sequence", requestId, 300000)
                    .catch((err) => {
                        console.warn("[MIBOX] play failed", err);
                        return null;
                    })
                    .then(() => {
                        playing = false;
                        playPromise = null;
                        updatePlayButton();
                    });
                iframe.contentWindow?.postMessage({
                    type: "MIBOX_PLAY_ONCE",
                    requestId,
                    fps: getSequenceFps(),
                    capture: false,
                }, "*");
            };

            const captureSequence = async (requestId, fps) => {
                const done = waitFor("sequence", requestId, 300000);
                iframe.contentWindow.postMessage({
                    type: "MIBOX_PLAY_ONCE",
                    requestId,
                    fps: Number(fps) || getSequenceFps(),
                    crop: getCropRect(),
                    capture: true,
                }, "*");
                try {
                    const result = await done;
                    if (result?.error) {
                        notify(result.error);
                    } else if (result?.animated === false && !node._miboxNoAnimationWarned) {
                        node._miboxNoAnimationWarned = true;
                        notify("当前视口没有带动画的模型，sequence 只有 1 帧");
                    }
                } catch (err) {
                    console.warn("[MIBOX] sequence capture failed", err);
                }
            };

            const onMessage = (event) => {
                if (event.source !== iframe.contentWindow) return;
                const data = event.data || {};
                if (data.type === "MIBOX_READY") {
                    node._miboxReady = true;
                    node._miboxReadyResolve?.();
                    return;
                }
                if (data.type === "MIBOX_ANIMATION_STATE") {
                    animationKnown = true;
                    animationState = { animated: !!data.animated, duration: Number(data.duration) || 0 };
                    if (animationState.animated) node._miboxNoAnimationWarned = false;
                    updatePlayButton();
                    return;
                }
                const requestId = data.requestId;
                if (!requestId) return;
                if (data.type === "MIBOX_MODEL_LOADED") {
                    node._miboxWaiters.get("loaded:" + requestId)?.(true);
                } else if (data.type === "MIBOX_MODEL_ERROR") {
                    node._miboxWaiters.get("loaded:" + requestId)?.(
                        Promise.reject(new Error(data.error || "模型加载失败"))
                    );
                } else if (data.type === "MIBOX_CAPTURE_RESULT") {
                    node._miboxWaiters.get("capture:" + requestId)?.(data.dataUrl);
                } else if (data.type === "MIBOX_SEQUENCE_DONE") {
                    node._miboxWaiters.get("sequence:" + requestId)?.(data);
                }
            };
            window.addEventListener("message", onMessage);

            const uploadCapture = async (requestId, dataUrl) => {
                try {
                    const response = await api.fetchApi("/mibox_viewer/capture", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ request_id: requestId, image: dataUrl }),
                    });
                    if (!response.ok) {
                        console.warn("[MIBOX] capture upload failed", response.status);
                    }
                } catch (err) {
                    console.warn("[MIBOX] capture upload error", err);
                }
            };

            const handleRequest = async (detail) => {
                if (String(detail.node_id) !== String(node.id)) return;
                const requestId = String(detail.request_id || "");
                if (!requestId) return;
                try {
                    await Promise.race([
                        readyPromise,
                        new Promise((_, reject) => setTimeout(
                            () => reject(new Error("MIBOX iframe 未就绪")), 30000
                        )),
                    ]);

                    // 先结束交互触发的预览播放，避免和本次采集抢动画状态
                    if (playing) {
                        iframe.contentWindow?.postMessage({ type: "MIBOX_STOP_PLAYBACK" }, "*");
                    }
                    if (playPromise) await playPromise;

                    // 以本次执行传入的 accumulate_input 为准；窗口里的控件值可能已经不同步
                    const accumulateWidget = getWidget(node, "accumulate_input");
                    const acceptInput = typeof detail.accumulate_input === "boolean"
                        ? detail.accumulate_input
                        : (accumulateWidget ? !!accumulateWidget.value : true);
                    if (detail.model_url && acceptInput) {
                        const url = new URL(detail.model_url, window.location.origin).href;
                        const loadedPromise = waitFor("loaded", requestId);
                        iframe.contentWindow.postMessage({
                            type: "MIBOX_ADD_MODEL",
                            url,
                            fileName: detail.file_name || "model.glb",
                            requestId,
                        }, "*");
                        await loadedPromise;
                    }
                    // 关闭累积输入时，跳过本次 model_3d，不再导入，直接输出当前视口

                    if (detail.capture_sequence) {
                        playing = true;
                        updatePlayButton();
                        try {
                            await captureSequence(requestId, detail.sequence_fps);
                        } finally {
                            playing = false;
                            updatePlayButton();
                        }
                    }

                    const capturePromise = waitFor("capture", requestId);
                    iframe.contentWindow.postMessage({
                        type: "MIBOX_CAPTURE",
                        requestId,
                        crop: getCropRect(),
                    }, "*");
                    const dataUrl = await capturePromise;
                    if (dataUrl) await uploadCapture(requestId, dataUrl);
                } catch (err) {
                    console.error("[MIBOX] request failed", err);
                }
            };

            const requestListener = (event) => {
                handleRequest(event.detail || {});
            };
            api.addEventListener("mibox_viewer.request", requestListener);

            playBtn.addEventListener("click", playAnimation);

            clearBtn.addEventListener("click", () => {
                try {
                    iframe.contentWindow?.postMessage({ type: "MIBOX_CLEAR" }, "*");
                } catch (err) {
                    console.warn("[MIBOX] clear failed", err);
                }
            });

            applyFrameStyle();
            updateAccumulateButton();
            updatePlayButton();
            this.setSize([560, 720]);

            const onRemoved = this.onRemoved;
            this.onRemoved = function () {
                window.removeEventListener("message", onMessage);
                api.removeEventListener("mibox_viewer.request", requestListener);
                node._miboxWaiters.forEach((resolve) => resolve(null));
                node._miboxWaiters.clear();
                onRemoved?.apply(this, arguments);
            };

            return result;
        };
    },
});
