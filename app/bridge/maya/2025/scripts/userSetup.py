# -*- coding: utf-8 -*-
"""AssetManager · Maya 桥接插件启动钩子

Maya 启动时会把模块里的 scripts 目录加进 MAYA_SCRIPT_PATH，并执行其中的
userSetup.py（官方推荐的模块自动加载方式，比写 Maya.env 干净）。

做两件事：
  1. 起后台轮询线程（只做 HTTP，绝不碰 maya.cmds）
  2. 在主菜单栏加「AssetManager」菜单（GUI 才有；batch/mayapy 跳过）

卸载：删掉本模块目录（或菜单里的「断开」）即可，不改 Maya 安装目录、不写 Maya.env。
启动失败不会拦住 Maya —— 只打印堆栈，用户照常工作。
"""

import traceback

AM_PLUGIN_VERSION = "0.1.0"   # 与 assetmanager_maya.py 保持一致（安装时用来显示版本）


def _am_start():
    try:
        import assetmanager_maya as am
    except Exception:
        print("[AssetManager] 插件导入失败：")
        traceback.print_exc()
        return
    try:
        am.auto_start()
    except Exception:
        print("[AssetManager] 启动失败：")
        traceback.print_exc()


try:
    _am_start()
except Exception:
    traceback.print_exc()
