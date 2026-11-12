from .nodes import MIBOXViewerNode
from .asset_browser import MIBOXAssetBrowser

NODE_CLASS_MAPPINGS = {
    "MIBOXViewer": MIBOXViewerNode,
    "MIBOXAssetBrowser": MIBOXAssetBrowser,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MIBOXViewer": "🔵BB MIBOX 3D视口",
    "MIBOXAssetBrowser": "🔵BB 素材浏览器",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
