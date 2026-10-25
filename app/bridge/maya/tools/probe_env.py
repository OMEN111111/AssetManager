# -*- coding: utf-8 -*-
"""Maya 环境探针（加新系列 / 排查「为什么某个功能不可用」时先跑它）

    mayapy tools/probe_env.py            # 无界面环境报告
    mayapy tools/probe_env.py --json     # 只要 JSON

报告内容：
  · Maya / Python 版本、是否 batch、默认渲染器
  · mtoa(Arnold) 能不能加载（本机 Arnold 装不全时这里就会报出来）
  · 关键节点类型能不能建（standardSurface / aiSkyDomeLight / aiPhotometricLight …）
  · FBX / OBJ / USD / ABC 各种导入类型是否注册
  · 原生着色链是否可用（file → multiplyDivide → plusMinusAverage → normalCamera 等）
  · file 节点的色彩空间接口（Raw / sRGB / ACEScg）

结论只作为实现依据，插件本身不依赖本文件。
"""
import json
import os
import sys
import tempfile

import maya.standalone

maya.standalone.initialize(name="python")

import maya.cmds as cmds
import maya.mel as mel

JSON_ONLY = "--json" in sys.argv

out = {}
out["maya"] = {
    "version": cmds.about(version=True),
    "api": cmds.about(api=True),
    "product": cmds.about(product=True),
    "batch": cmds.about(batch=True),
    "python": sys.version.split()[0],
}
try:
    out["maya"]["renderer"] = mel.eval("currentRenderer()")
except Exception as e:
    out["maya"]["renderer"] = "error: %s" % e

# ---- Arnold
arn = {"loaded": False}
try:
    arn["loaded"] = bool(cmds.pluginInfo("mtoa", query=True, loaded=True))
    if not arn["loaded"]:
        cmds.loadPlugin("mtoa", quiet=True)
        arn["loaded"] = bool(cmds.pluginInfo("mtoa", query=True, loaded=True))
except Exception as e:
    arn["load_error"] = str(e).strip().replace("\n", " ")[:200]
arn["mll_exists"] = os.path.exists(r"C:\Program Files\Autodesk\Arnold\maya2025\plug-ins\mtoa.mll")
arn["arnold_dll_exists"] = os.path.exists(r"C:\Program Files\Autodesk\Arnold\maya2025\bin\arnold.dll")
out["arnold"] = arn

# ---- 节点能否真建出来（未注册类型会静默造出 unknown 节点）
nodes = {}
for t in ("standardSurface", "file", "place2dTexture", "bump2d", "multiplyDivide", "plusMinusAverage",
          "reverse", "aiSkyDomeLight", "aiPhotometricLight", "aiNormalMap", "aiShuffle", "aiStandardSurface"):
    try:
        n = cmds.createNode(t)
        nodes[t] = {"ok": cmds.nodeType(n) == t, "attrs": (cmds.listAttr(n) or [])[:12]}
        cmds.delete(n)
    except Exception as e:
        nodes[t] = {"ok": False, "error": str(e)[:120]}
out["node_types"] = nodes

# ---- 导入 / 导出类型
tmp = tempfile.mkdtemp(prefix="am_probe_")
cmds.file(new=True, force=True)
cmds.loadPlugin("fbxmaya", quiet=True)
probe = {}
for t in ("FBX", "OBJ", "USD", "ABC", "mayaAscii", "glTF", "GLB"):
    try:
        cmds.file(os.path.join(tmp, "x.dat").replace("\\", "/"), i=True, type=t)
        probe[t] = "ok"
    except Exception as e:
        msg = str(e).strip().replace("\n", " ")
        probe[t] = "file-missing(=类型已注册)" if "找不到文件" in msg or "file not found" in msg.lower() else msg[:100]
out["import_types"] = probe

# FBX 往返
try:
    cube = cmds.polyCube(name="amProbeCube")[0]
    fbx = os.path.join(tmp, "probe.fbx").replace("\\", "/")
    cmds.select(cube)
    cmds.file(fbx, force=True, exportSelected=True, type="FBX export", options="v=0;")
    cmds.file(new=True, force=True)
    cmds.loadPlugin("fbxmaya", quiet=True)
    before = len(cmds.ls(type="mesh") or [])
    cmds.file(fbx, i=True, type="FBX", ignoreVersion=True, ra=True, options="v=0;")
    out["fbx_roundtrip"] = {"ok": True, "meshes": len(cmds.ls(type="mesh") or []) - before}
except Exception as e:
    out["fbx_roundtrip"] = {"ok": False, "error": str(e)[:200]}

# ---- 原生着色链（法线）：file → multiplyDivide(×2) → plusMinusAverage(−1) → normalCamera
chain = {}
try:
    cmds.file(new=True, force=True)
    ss = cmds.shadingNode("standardSurface", asShader=True)
    f = cmds.shadingNode("file", asTexture=True)
    cmds.setAttr(f + ".fileTextureName", os.path.join(tmp, "n.png").replace("\\", "/"), type="string")
    md = cmds.shadingNode("multiplyDivide", asUtility=True)
    pma = cmds.shadingNode("plusMinusAverage", asUtility=True)
    cmds.connectAttr(f + ".outColor", md + ".input1", force=True)
    for ch in ("X", "Y", "Z"):
        cmds.setAttr(md + ".input2" + ch, 2.0)
    cmds.connectAttr(md + ".output", pma + ".input3D[0]", force=True)
    for ch in ("x", "y", "z"):
        cmds.setAttr(pma + ".input3D[1].input3D" + ch, -1.0)
    cmds.connectAttr(pma + ".output3D", ss + ".normalCamera", force=True)
    chain["normal_chain"] = cmds.isConnected(pma + ".output3D", ss + ".normalCamera")
    # 单通道 + 强度
    md2 = cmds.shadingNode("multiplyDivide", asUtility=True)
    cmds.connectAttr(f + ".outColorG", md2 + ".input1X", force=True)
    cmds.setAttr(md2 + ".input2X", 0.5)
    cmds.connectAttr(md2 + ".outputX", ss + ".specularRoughness", force=True)
    chain["scalar_chain"] = cmds.isConnected(md2 + ".outputX", ss + ".specularRoughness")
    chain["color_space"] = cmds.getAttr(f + ".colorSpace")
    chain["has_opacity_attr"] = bool(cmds.attributeQuery("opacity", node=ss, exists=True))
except Exception as e:
    chain["error"] = str(e)[:300]
out["native_chain"] = chain

print("=== AM PROBE JSON ===")
print(json.dumps(out, indent=2, ensure_ascii=False, default=str))
