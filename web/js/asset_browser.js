import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_NAME = "MIBOXAssetBrowser";
const HTML_URL = new URL("../asset_browser.html?embed=1&v=20261031-6", import.meta.url).href;
const STYLE_ID = "mibox-asset-browser-style";
const ORIGIN = window.location.origin;

const syncWaiters = new Set();
let queueGuardInstalled = false;

function showToastMessage(message) {
    try {
        const toast = app.extensionManager?.toast;
        if (toast?.add) {
            toast.add({
                severity: "error",
                summary: "素材浏览器",
                detail: message,
                life: 6000,
            });
            return;
        }
    } catch (error) {
        // fall through to console
    }
    console.warn("[MIBOX AssetBrowser]", message);
}

function installQueueGuard() {
    if (queueGuardInstalled || typeof app.queuePrompt !== "function") return;
    const originalQueuePrompt = app.queuePrompt;
    app.queuePrompt = async function (...args) {
        if (syncWaiters.size) {
            const waiters = Array.from(syncWaiters);
            const results = await Promise.all(waiters.map((waiter) => {
                try {
                    return Promise.resolve(waiter());
                } catch (error) {
                    console.warn("[MIBOX AssetBrowser] sync waiter failed", error);
                    return true;
                }
            }));
            if (results.some((ok) => ok === false)) {
                showToastMessage("自动同步失败，队列未提交，请重新选择图片后重试。");
                return false;
            }
        }
        return originalQueuePrompt.apply(this, args);
    };
    queueGuardInstalled = true;
}

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        .mibox-ab-shell {
            width: 100%;
            height: 100%;
            min-height: 560px;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            border: 1px solid #2d2d32;
            border-radius: 10px;
            background: #0f0f11;
        }
        .mibox-ab-bar {
            flex: none;
            height: 34px;
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 0 10px;
            border-bottom: 1px solid #29292e;
            background: #18181b;
            color: #8c8b92;
            font: 11px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            user-select: none;
        }
        .mibox-ab-dot {
            width: 6px;
            height: 6px;
            flex: none;
            border-radius: 50%;
            background: #696971;
            box-shadow: 0 0 0 3px rgba(255,255,255,.03);
        }
        .mibox-ab-bar.pending .mibox-ab-dot {
            background: #d2b477;
            box-shadow: 0 0 0 3px rgba(210,180,119,.1);
        }
        .mibox-ab-bar.applied .mibox-ab-dot {
            background: #8fa47d;
            box-shadow: 0 0 0 3px rgba(143,164,125,.1);
        }
        .mibox-ab-bar.error .mibox-ab-dot {
            background: #d1847c;
            box-shadow: 0 0 0 3px rgba(209,132,124,.1);
        }
        .mibox-ab-status {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .mibox-ab-count {
            flex: none;
            height: 20px;
            display: inline-flex;
            align-items: center;
            padding: 0 7px;
            border: 1px solid #313137;
            border-radius: 999px;
            background: #1d1d21;
            color: #7e7e86;
            font: 10px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
            white-space: nowrap;
        }
        .mibox-ab-bar.applied .mibox-ab-count {
            border-color: #3e4939;
            background: #232820;
            color: #aebfa0;
        }
        .mibox-ab-bar.pending .mibox-ab-count {
            border-color: #4a4232;
            background: #29251d;
            color: #c6b082;
        }
        .mibox-ab-bar.error .mibox-ab-count {
            border-color: #4d3836;
            background: #2b2020;
            color: #d19a94;
        }
        .mibox-ab-frame {
            position: relative;
            flex: 1;
            min-height: 0;
            background: #0f0f11;
        }
        .mibox-ab-frame iframe {
            width: 100%;
            height: 100%;
            min-height: 520px;
            border: 0;
            display: block;
            background: #0f0f11;
        }
    `;
    document.head.appendChild(style);
}

function getWidget(node, name) {
    return node.widgets?.find((widget) => widget.name === name);
}

function hideImagesDataWidget(node) {
    const widget = getWidget(node, "images_data");
    if (!widget) return;
    widget.type = "hidden";
    widget.hidden = true;
    widget.label = "";
    widget.computeSize = () => [0, -4];
}

function parseApplied(value) {
    try {
        const entries = JSON.parse(value || "[]");
        return Array.isArray(entries) ? entries : [];
    } catch (error) {
        return [];
    }
}

app.registerExtension({
    name: "mibox.assetbrowser",

    async setup() {
        installQueueGuard();
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            const node = this;
            injectStyles();

            const dataWidget = getWidget(node, "images_data");
            hideImagesDataWidget(node);
            let appliedEntries = parseApplied(dataWidget?.value);
            let appliedCount = appliedEntries.length;
            let selectionCount = 0;
            let selectionSignature = "";
            let uploading = false;
            let syncWaitPromise = null;
            let syncWaitResolve = null;

            const shell = document.createElement("div");
            shell.className = "mibox-ab-shell";

            const bar = document.createElement("div");
            bar.className = "mibox-ab-bar";
            const dot = document.createElement("span");
            dot.className = "mibox-ab-dot";
            const statusText = document.createElement("span");
            statusText.className = "mibox-ab-status";
            statusText.textContent = "正在加载素材浏览器…";
            const countChip = document.createElement("span");
            countChip.className = "mibox-ab-count";
            countChip.textContent = appliedCount ? `已同步 ${appliedCount} 张` : "未同步";
            bar.append(dot, statusText, countChip);
            shell.appendChild(bar);

            const frame = document.createElement("div");
            frame.className = "mibox-ab-frame";
            const iframe = document.createElement("iframe");
            iframe.src = HTML_URL;
            iframe.allow = "clipboard-read; clipboard-write";
            iframe.setAttribute("tabindex", "0");
            frame.appendChild(iframe);
            shell.appendChild(frame);

            try {
                if (typeof node.addDOMWidget === "function") {
                    node.addDOMWidget("mibox_asset_browser", "MIBOX_ASSET_BROWSER", shell, {
                        getValue() { return ""; },
                        setValue() { },
                        hideOnZoom: false,
                        serialize: false,
                        computeSize: (width) => [Math.max(720, width), 560],
                    });
                }
            } catch (error) {
                console.error("[MIBOX AssetBrowser] failed to add DOM widget", error);
            }

            node.miboxAssetBrowser = { shell, bar, iframe };

            const setBar = (state, message, chip) => {
                bar.classList.remove("pending", "applied", "error");
                if (state) bar.classList.add(state);
                statusText.textContent = message;
                if (chip !== undefined) countChip.textContent = chip;
            };

            const idleMessage = () => {
                if (appliedCount > 0) {
                    setBar(
                        "applied",
                        `已自动同步 ${appliedCount} 张图片 · 连接标准预览图像节点直接运行`,
                        `已同步 ${appliedCount} 张`
                    );
                } else {
                    setBar("", "在下方选择图片，连接标准预览图像节点后直接运行", "未同步");
                }
            };

            const refreshAppliedFromWidget = () => {
                appliedEntries = parseApplied(getWidget(node, "images_data")?.value);
                appliedCount = appliedEntries.length;
                idleMessage();
            };

            const sendToIframe = (payload) => {
                try {
                    iframe.contentWindow?.postMessage(payload, ORIGIN);
                } catch (error) {
                    console.warn("[MIBOX AssetBrowser] sendToIframe failed", error);
                }
            };

            const ensureSyncWait = () => {
                if (!syncWaitPromise) {
                    syncWaitPromise = new Promise((resolve) => {
                        syncWaitResolve = resolve;
                    });
                }
            };

            const finishSyncWait = (ok) => {
                const resolve = syncWaitResolve;
                syncWaitResolve = null;
                syncWaitPromise = null;
                if (resolve) resolve(ok);
            };

            const waitForSync = () => syncWaitPromise || Promise.resolve(true);
            syncWaiters.add(waitForSync);

            const uploadSelection = async (data) => {
                if (uploading) return;
                const requestId = String(data.requestId || "");
                const incoming = Array.isArray(data.files) ? data.files : [];
                if (!requestId || !incoming.length) {
                    sendToIframe({
                        type: "MIBOX_ASSET_ERROR",
                        requestId,
                        message: "没有收到可同步的图片。",
                    });
                    return;
                }

                uploading = true;
                setBar(
                    "pending",
                    `正在自动同步 ${incoming.length} 张图片…`,
                    "同步中"
                );

                try {
                    const form = new FormData();
                    const paths = [];
                    let appended = 0;
                    for (const item of incoming) {
                        const file = item?.file;
                        if (!file || typeof file.size !== "number") continue;
                        const name = item.name || file.name || `image_${appended + 1}`;
                        form.append("files", file, name);
                        paths.push(item.path || name);
                        appended += 1;
                    }
                    if (!appended) throw new Error("没有可上传的图片数据。");
                    form.append("paths", JSON.stringify(paths));

                    const response = await api.fetchApi("/mibox_asset_browser/upload", {
                        method: "POST",
                        body: form,
                    });
                    let payload = null;
                    try {
                        payload = await response.json();
                    } catch (error) {
                        payload = null;
                    }
                    if (!response.ok || !payload?.ok) {
                        throw new Error(payload?.error || `上传失败（HTTP ${response.status}）`);
                    }

                    const entries = (payload.files || []).map((file) => ({
                        path: file.path,
                        name: file.name,
                        width: file.width,
                        height: file.height,
                        source: file.source,
                    }));
                    if (!entries.length) throw new Error("ComfyUI 没有返回已保存的图片。");

                    const widget = getWidget(node, "images_data");
                    if (widget) widget.value = JSON.stringify(entries);
                    appliedEntries = entries;
                    appliedCount = entries.length;
                    node.properties = node.properties || {};
                    node.properties.mibox_applied_count = appliedCount;
                    node.properties.mibox_applied_at = Date.now();
                    node.setDirtyCanvas(true, true);
                    app.graph.setDirtyCanvas(true, true);

                    const latestSelection = !data.signature || !selectionSignature || data.signature === selectionSignature;
                    if (latestSelection) {
                        selectionCount = incoming.length;
                        setBar(
                            "applied",
                            `已自动同步 ${appliedCount} 张图片 · 连接标准预览图像节点直接运行`,
                            `已同步 ${appliedCount} 张`
                        );
                        finishSyncWait(true);
                    } else {
                        setBar("pending", `已选择新图片 · 正在自动同步…`, "同步中");
                    }
                    sendToIframe({
                        type: "MIBOX_ASSET_APPLIED",
                        requestId,
                        count: appliedCount,
                        signature: data.signature || "",
                    });
                } catch (error) {
                    console.error("[MIBOX AssetBrowser] auto sync failed", error);
                    setBar("error", error.message || "自动同步失败", "失败");
                    finishSyncWait(false);
                    sendToIframe({
                        type: "MIBOX_ASSET_ERROR",
                        requestId,
                        message: error.message || "自动同步失败，请重试。",
                    });
                } finally {
                    uploading = false;
                }
            };

            const onMessage = (event) => {
                if (event.source !== iframe.contentWindow) return;
                if (event.origin && event.origin !== ORIGIN) return;
                const data = event.data || {};
                if (data.type === "MIBOX_ASSET_FRAME_READY") {
                    idleMessage();
                    return;
                }
                if (data.type === "MIBOX_ASSET_SELECTION") {
                    selectionCount = Number(data.count) || 0;
                    selectionSignature = String(data.signature || "");
                    if (selectionCount > 0 && !data.applied) {
                        ensureSyncWait();
                        setBar(
                            "pending",
                            `已选 ${selectionCount} 张 · 正在自动同步…`,
                            "同步中"
                        );
                    } else {
                        if (data.applied) finishSyncWait(true);
                        idleMessage();
                    }
                    return;
                }
                if (data.type === "MIBOX_ASSET_APPLY") {
                    uploadSelection(data);
                    return;
                }
                if (data.type === "MIBOX_ASSET_CLEAR") {
                    const widget = getWidget(node, "images_data");
                    if (widget) widget.value = "[]";
                    appliedEntries = [];
                    appliedCount = 0;
                    selectionCount = 0;
                    selectionSignature = "";
                    node.properties = node.properties || {};
                    node.properties.mibox_applied_count = 0;
                    node.properties.mibox_applied_at = Date.now();
                    node.setDirtyCanvas(true, true);
                    app.graph.setDirtyCanvas(true, true);
                    finishSyncWait(true);
                    idleMessage();
                }
            };

            window.addEventListener("message", onMessage);

            iframe.addEventListener("load", () => {
                setTimeout(() => {
                    try {
                        iframe.contentWindow?.postMessage({ type: "MIBOX_ASSET_PING" }, ORIGIN);
                    } catch (error) {
                        // ignore
                    }
                }, 250);
            });

            const onConfigure = node.onConfigure;
            node.onConfigure = function () {
                const configured = onConfigure?.apply(this, arguments);
                hideImagesDataWidget(node);
                window.setTimeout(refreshAppliedFromWidget, 0);
                return configured;
            };

            const onRemoved = node.onRemoved;
            node.onRemoved = function () {
                window.removeEventListener("message", onMessage);
                syncWaiters.delete(waitForSync);
                finishSyncWait(true);
                try { iframe.src = "about:blank"; } catch (error) { /* ignore */ }
                onRemoved?.apply(this, arguments);
            };

            node.setSize([1120, 760]);
            idleMessage();

            return result;
        };
    },
});
