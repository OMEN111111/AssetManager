# -*- coding: utf-8 -*-
"""真机（GUI Maya）验证脚本：由 devtest/maya/gui-verify.ps1 通过 `maya -script` 拉起

只做「mayapy 里做不到」的事：
  · mtoa(Arnold) 在 GUI Maya 里是否加载、Arnold 节点是否真的能建
  · aiPhotometricLight 的配光文件属性到底叫什么（不同 Arnold 版本不一样）
  · aiSkyDomeLight 的 color 属性、能不能挂 file 贴图
  · 插件的 userSetup.py 自动启动有没有生效（菜单建没建、心跳通不通）
  · 真机跑一遍 HDRI / IES 两个任务

结果写到 AM_GUI_OUT 指定的 JSON，然后自己退出 Maya。
"""
import json
import os
import time
import traceback

import maya.cmds as cmds
import maya.mel as mel
import maya.utils

try:
    from PySide6.QtCore import QTimer
except Exception:                                   # Maya 2024 之前是 PySide2
    from PySide2.QtCore import QTimer

OUT = os.environ.get("AM_GUI_OUT") or r"D:\Program\AssetManager\devtest\maya\work\gui_probe.json"
IES = os.environ.get("AM_GUI_IES") or ""
EXR = os.environ.get("AM_GUI_EXR") or ""
WAIT_MS = int(os.environ.get("AM_GUI_WAIT_MS") or "25000")

RESULT = {"steps": [], "error": ""}


def note(k, v):
    RESULT["steps"].append({k: v})


def attrs_of(node):
    try:
        return sorted(cmds.listAttr(node) or [])
    except Exception:
        return []


def probe():
    try:
        note("maya_version", cmds.about(version=True))
        note("maya_product", cmds.about(product=True))
        note("batch", cmds.about(batch=True))
        note("python", __import__("sys").version)
        note("renderer", mel.eval("currentRenderer()"))
        note("mtoa_loaded", bool(cmds.pluginInfo("mtoa", query=True, loaded=True)))
        try:
            note("arnold_version", cmds.pluginInfo("mtoa", query=True, version=True))
        except Exception as e:
            note("arnold_version_error", str(e)[:120])

        # Arnold 节点能不能真建出来
        for t in ("aiSkyDomeLight", "aiPhotometricLight", "aiNormalMap", "aiShuffle", "aiStandardSurface"):
            try:
                n = cmds.createNode(t)
                note("createNode_" + t, {"node": n, "type": cmds.nodeType(n),
                                         "attrs": attrs_of(n)[:40]})
            except Exception as e:
                note("createNode_" + t, {"error": str(e)[:200]})

        # 关键：光靠名字猜不准，直接把 aiPhotometricLight / aiSkyDomeLight 的属性全列出来
        for t in ("aiPhotometricLight", "aiSkyDomeLight"):
            try:
                n = cmds.shadingNode(t, asLight=True)
                note("shadingNode_" + t, {"node": n, "type": cmds.nodeType(n), "attrs": attrs_of(n)})
                if cmds.nodeType(n) == "unknown":
                    cmds.delete(n)
            except Exception as e:
                note("shadingNode_" + t, {"error": str(e)[:200]})

        # 插件是否自动启动
        try:
            import assetmanager_maya as am
            note("plugin_imported", {"version": am.AM_PLUGIN_VERSION, "series": am.AM_SERIES})
            note("plugin_state", am.state())
            note("menu_exists", bool(cmds.control("amAssetManagerMenu", exists=True)))
            note("module_file", getattr(am, "__file__", ""))
            RESULT["plugin"] = True
        except Exception as e:
            note("plugin_import_error", "%s: %s" % (type(e).__name__, e))
            RESULT["plugin"] = False
            return

        # 真机跑 HDRI / IES
        if EXR and os.path.exists(EXR):
            try:
                msg = am.execute({"mode": "hdri", "payload": {"files": [EXR], "hdriApply": {"env": True}}})
                note("hdri_job", msg)
                note("hdri_light", {n: cmds.nodeType(n) for n in (cmds.ls(type="aiSkyDomeLight") or [])})
                note("hdri_dome", bool(cmds.objExists("amSkyDome")))
            except Exception as e:
                note("hdri_job", {"error": "%s: %s" % (type(e).__name__, e)})
        if IES and os.path.exists(IES):
            try:
                msg = am.execute({"mode": "ies", "payload": {"files": [IES]}})
                note("ies_job", msg)
                lights = cmds.ls(type="aiPhotometricLight") or []
                info = {}
                for lt in lights:
                    vals = {}
                    for a in attrs_of(lt):
                        try:
                            if cmds.attributeQuery(a, node=lt, attributeType=True) == "string":
                                vals[a] = cmds.getAttr(lt + "." + a)
                        except Exception:
                            pass
                    info[lt] = vals
                note("ies_lights", info)
            except Exception as e:
                note("ies_job", {"error": "%s: %s" % (type(e).__name__, e)})
    except Exception:
        RESULT["error"] = traceback.format_exc()[-1500:]
    finally:
        try:
            with open(OUT, "w", encoding="utf-8") as f:
                json.dump(RESULT, f, indent=2, ensure_ascii=False, default=str)
        except Exception:
            pass
        print("[AM GUI PROBE] 结果已写到 %s" % OUT)
        try:
            cmds.quit(force=True)
        except Exception:
            os._exit(0)


# GUI 有事件循环：等插件自己的定时器/HTTP 线程跑起来（也等服务端起来），再探测
QTimer.singleShot(WAIT_MS, probe)
print("[AM GUI PROBE] %d ms 后开始探测" % WAIT_MS)
