# -*- coding: utf-8 -*-
"""真机验证 第二弹：GUI Maya 里查三件 mayapy 答不准的事

  1. mtoa(Arnold) 到底能不能加载、报什么错（本机 Arnold 可能没装好）
  2. AssetManager 菜单是不是真的建出来了（cmds.control 查菜单会假阴性）
  3. FBX 导入在 GUI 里为什么可能报「0 个网格」（启动期执行 vs 正常期执行）

结果写 AM_GUI_OUT，然后退出 Maya。
"""
import json
import os
import traceback

import maya.cmds as cmds
import maya.mel as mel

try:
    from PySide6.QtCore import QTimer
except Exception:
    from PySide2.QtCore import QTimer

OUT = os.environ.get("AM_GUI_OUT") or r"D:\Program\AssetManager\devtest\maya\work\gui_probe2.json"
FBX = os.environ.get("AM_GUI_FBX") or ""
WAIT_MS = int(os.environ.get("AM_GUI_WAIT_MS") or "20000")

RESULT = {"steps": []}


def note(k, v):
    RESULT["steps"].append({k: v})


def probe():
    try:
        note("main_window", mel.eval("$tmp=$gMainWindow"))
        # 1) 菜单：用 menu -exists 查（control -exists 查不到菜单）
        found = {}
        for api in ("menu", "control"):
            try:
                found[api] = bool(getattr(cmds, api)("amAssetManagerMenu", exists=True))
            except Exception as e:
                found[api] = "error: %s" % str(e)[:80]
        note("menu_exists", found)
        try:
            note("menu_children", cmds.menu("amAssetManagerMenu", query=True, itemArray=True))
        except Exception as e:
            note("menu_children", "error: %s" % str(e)[:100])
        try:
            note("main_menu_labels", [cmds.menu(m, query=True, label=True) for m in (cmds.lsUI(menus=True) or [])][:30])
        except Exception as e:
            note("main_menu_labels", "error: %s" % str(e)[:100])

        # 2) Arnold
        arn = {}
        try:
            cmds.loadPlugin("mtoa", quiet=True)
            arn["loaded_after_load"] = bool(cmds.pluginInfo("mtoa", query=True, loaded=True))
        except Exception as e:
            arn["load_error"] = str(e)[:400]
        arn["loaded"] = bool(cmds.pluginInfo("mtoa", query=True, loaded=True))
        note("mtoa", arn)
        note("maxtoa_path_check", {
            "mtoa_mll": os.path.exists(r"C:\Program Files\Autodesk\Arnold\maya2025\plug-ins\mtoa.mll"),
            "arnold_bin": os.path.exists(r"C:\Program Files\Autodesk\Arnold\maya2025\bin\arnold.dll"),
        })
        try:
            note("renderer", mel.eval("currentRenderer()"))
        except Exception as e:
            note("renderer", str(e))

        # 3) FBX 导入（正常期执行）：连跑两次，看网格数
        import assetmanager_maya as am
        if FBX and os.path.exists(FBX):
            runs = []
            for i in (1, 2):
                before = len(cmds.ls(type="mesh", long=True) or [])
                try:
                    msg = am.execute({"mode": "import", "payload": {"modelPath": FBX, "name": "GUIProbe_%d" % i}})
                    err = None
                except Exception as e:
                    msg, err = "", "%s: %s" % (type(e).__name__, e)
                after = len(cmds.ls(type="mesh", long=True) or [])
                runs.append({"run": i, "before": before, "after": after, "msg": msg, "err": err})
            note("fbx_import", runs)
            note("fbx_scene_meshes", (cmds.ls(type="mesh") or [])[:10])
        else:
            note("fbx_import", "没有 FBX 样本")

        # 4) 插件状态
        note("plugin_state", am.state())
        note("events", am.events()[-6:])
    except Exception:
        RESULT["error"] = traceback.format_exc()[-1500:]
    finally:
        try:
            with open(OUT, "w", encoding="utf-8") as f:
                json.dump(RESULT, f, indent=2, ensure_ascii=False, default=str)
        except Exception:
            pass
        print("[AM GUI PROBE2] 结果已写到 %s" % OUT)
        try:
            cmds.quit(force=True)
        except Exception:
            os._exit(0)


QTimer.singleShot(WAIT_MS, probe)
print("[AM GUI PROBE2] %d ms 后开始探测" % WAIT_MS)
