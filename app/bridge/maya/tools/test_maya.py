# -*- coding: utf-8 -*-
"""Maya 端集成测试（在 mayapy 里跑，开发/回归用）

做这些事，任何一步失败都会以非 0 退出码结束：

  1. 加载插件模块，校验版本号 / 系列号
  2. 端口发现：定位文件（%LOCALAPPDATA%\\AssetManager\\bridge.json）+ 扫描回退
  3. 后台线程心跳：不发手动心跳，等插件自己上报，服务端能看到 maya 在线
  4. 材质网络：standardSurface + file / place2dTexture / reverse / multiplyDivide /
     plusMinusAverage，逐条核对通道连线、打包图共享、UV、强度、DX 法线、原地重建
  5. 贴图任务、模型导入（FBX / OBJ）+ 素材材质套用
  6. HDRI（无 Arnold 时退化成环境球）、IES（无 Arnold 时明确报错、.ldt 明确报错）
  7. 真实桥接协议：临时素材库 → /api/bridge/send → 后台线程取任务 → 主线程执行 → 结果回传
  8. 端口跟随：软件换端口后（假服务 + 假 bridge.json）插件自动切过去

用法（PowerShell）：
    mayapy tools/test_maya.py <系列目录> <服务端口> <工作目录>

依赖：AssetManager 已在该端口启动，且带临时数据目录（AM_DATA）。
"""
import io
import os
import struct
import sys
import json
import time
import zlib
import shutil
import traceback
import urllib.request

import maya.standalone

maya.standalone.initialize(name="python")

import maya.cmds as cmds
import maya.utils

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
if len(ARGS) < 3:
    print("AMTEST FAIL args 需要：<系列目录> <服务端口> <工作目录>")
    sys.exit(2)
SERIES_DIR = os.path.abspath(ARGS[0])
PORT = int(ARGS[1])
WORK = os.path.abspath(ARGS[2])
os.makedirs(WORK, exist_ok=True)
os.makedirs(os.path.join(WORK, "tex"), exist_ok=True)
sys.path.insert(0, os.path.join(SERIES_DIR, "scripts"))

FAILS = []


def step(text):
    print("AMSTEP " + text)


def check(name, cond, info=""):
    print("%s %s%s" % ("AMTEST PASS" if cond else "AMTEST FAIL", name, ("  " + str(info)) if info else ""))
    if not cond:
        FAILS.append(name)


def http(path, data=None, timeout=15):
    url = "http://127.0.0.1:%d%s" % (PORT, path)
    body = json.dumps(data).encode("utf-8") if data is not None else None
    headers = {"Content-Type": "application/json"} if body else {}
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw.decode("utf-8")) if raw else None


# ---------------------------------------------------------------- 素材：写 png / mtlx / exr / ies

def write_png(path, w, h, rgb):
    """最小 PNG 写出（不依赖 PIL；Maya 自带的图片库在 batch 下不好用）"""
    raw = b""
    for y in range(h):
        raw += b"\x00" + bytes(rgb) * w

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    return path


step("准备测试贴图")
tex = {
    "base": write_png(os.path.join(WORK, "tex", "T_BaseColor.png"), 8, 8, (204, 102, 51)),
    "arm": write_png(os.path.join(WORK, "tex", "T_ARM.png"), 8, 8, (230, 128, 26)),
    "normal": write_png(os.path.join(WORK, "tex", "T_NormalDX.png"), 8, 8, (128, 128, 255)),
    "height": write_png(os.path.join(WORK, "tex", "T_Height.png"), 8, 8, (128, 128, 128)),
    "emissive": write_png(os.path.join(WORK, "tex", "T_Emissive.png"), 8, 8, (26, 230, 51)),
    "opacity": write_png(os.path.join(WORK, "tex", "T_Opacity.png"), 8, 8, (255, 255, 255)),
}
check("png_written", all(os.path.getsize(p) > 60 for p in tex.values()), [os.path.getsize(p) for p in tex.values()])


# ---------------------------------------------------------------- 1. 加载插件

step("加载插件模块（%s）" % SERIES_DIR)
# 注意：mayapy 启动时也会执行 Maya 用户目录里的 userSetup.py（装了插件的那份会自己起轮询线程，
# 把任务抢进它自己的队列里，而 mayapy 没有主线程泵 → 任务永远停在 running）。
# 所以先把自动启动的那份停掉，再按路径加载源码（直接 import 也可能拿到安装目录里的旧版本）。
_auto = sys.modules.get("assetmanager_maya")
if _auto is not None:
    try:
        _auto.stop()
        print("AMTEST note 已停掉 userSetup 自动启动的那份插件")
    except Exception as e:
        print("AMTEST note 停不掉自动启动的插件：%s" % e)
    sys.modules.pop("assetmanager_maya", None)

import importlib.util

PLUGIN_FILE = os.path.join(SERIES_DIR, "scripts", "assetmanager_maya.py")
try:
    _spec = importlib.util.spec_from_file_location("assetmanager_maya", PLUGIN_FILE)
    mod = importlib.util.module_from_spec(_spec)
    sys.modules["assetmanager_maya"] = mod
    _spec.loader.exec_module(mod)
except Exception as e:
    print("AMTEST FAIL 插件导入失败：%s: %s" % (type(e).__name__, e))
    traceback.print_exc()
    sys.exit(1)

check("module_from_source", os.path.samefile(mod.__file__, PLUGIN_FILE), mod.__file__)
check("module_traceback_free", True)
check("plugin_version_format", len(mod.AM_PLUGIN_VERSION.split(".")) == 3, mod.AM_PLUGIN_VERSION)
check("plugin_series", mod.AM_SERIES == os.path.basename(SERIES_DIR), "%s / %s" % (mod.AM_SERIES, os.path.basename(SERIES_DIR)))
check("target_maya", mod.TARGET == "maya", mod.TARGET)
check("python3", sys.version_info[0] == 3, sys.version.split()[0])
check("has_pump", callable(getattr(mod, "pump_once", None)))
check("has_execute", callable(getattr(mod, "execute", None)))


# ---------------------------------------------------------------- 2. 端口发现

step("端口发现（定位文件 + 扫描回退）")
check("locator_port", mod._locator_port() == PORT, "%s / 期望 %s" % (mod._locator_port(), PORT))
check("probe_port", mod._probe(PORT), "GET /api/state")
check("discover_port", mod.discover_port() == PORT, mod.discover_port())
fake_bad = 6553
check("probe_dead_port", not mod._probe(fake_bad), "没人监听的端口必须探不通")


# ---------------------------------------------------------------- 3. 后台线程 + 心跳

step("后台线程心跳（不手动调心跳，等插件自己上报）")
mod.stop()
mod._state["port"] = PORT
started = mod.start()
check("thread_started", started and mod._state["thread"] is not None)
check("thread_alive", mod._state["thread"].is_alive(), "worker 线程活着")

deadline = time.time() + 20
online = False
while time.time() < deadline:
    st = http("/api/bridge/status")["targets"].get("maya") or {}
    if st.get("connected"):
        online = True
        break
    time.sleep(0.5)
st = http("/api/bridge/status")["targets"].get("maya") or {}
check("heartbeat_from_worker", online, st)
check("heartbeat_version", st.get("version") == mod.AM_PLUGIN_VERSION, st.get("version"))
check("heartbeat_host", bool(st.get("host")), st.get("host"))
# 插件自己记的连接状态（心跳/取任务偶发超时会短暂 false，等它一下）
deadline = time.time() + 15
while time.time() < deadline and not mod.state()["connected"]:
    mod.pump_once()
    time.sleep(0.3)
check("state_connected", mod.state()["connected"] is True,
      "%s / err=%s" % (mod.state().get("last"), mod.state().get("error")))


# ---------------------------------------------------------------- 4. 材质网络

step("材质网络（standardSurface + 全部通道）")
cmds.file(new=True, force=True)
os.makedirs(os.path.join(WORK, "tex"), exist_ok=True)

SPEC = {
    "name": "AMTest_Mat",
    "workflow": "SG",              # SG：粗糙度图其实是光泽度，要反相
    "maps": {
        "baseColor": {"path": tex["base"], "channel": "rgb", "intensity": 1.0},
        "ao": {"path": tex["arm"], "channel": "r", "intensity": 1.0},
        "roughness": {"path": tex["arm"], "channel": "g", "intensity": 0.8},
        "metallic": {"path": tex["arm"], "channel": "b", "invert": True},
        "normal": {"path": tex["normal"], "channel": "rgb", "normalSpace": "dx", "intensity": 1.2},
        "emissive": {"path": tex["emissive"], "channel": "rgb", "intensity": 2.0},
        "opacity": {"path": tex["opacity"], "channel": "rgb"},
    },
    "uv": {"repeatU": 2.0, "repeatV": 3.0, "rot": 0.5, "offsetU": 0.1, "offsetV": 0.2},
}

sg, applied = mod.build_material(SPEC, "AMTest_Mat", asset_id=999)
check("material_sg_created", bool(sg) and cmds.objExists(sg), sg)
shader = (cmds.listConnections(sg + ".surfaceShader", source=True, destination=False) or [None])[0]
check("material_shader", bool(shader) and cmds.nodeType(shader) == "standardSurface", shader and cmds.nodeType(shader))
check("material_slots", set(applied) == {"baseColor", "ao", "roughness", "metallic", "normal", "emissive", "opacity"}, sorted(applied))
check("tagged_sg", mod._is_tagged(sg), "自建材质要打标记才能原地重建")
check("tag_asset_id", cmds.getAttr(sg + "." + mod.MARK_ATTR) == "999", cmds.getAttr(sg + "." + mod.MARK_ATTR))

# 基础色：被 AO 乘过 → baseColor 的上游一定有个 multiplyDivide
def has_upstream(attr, want, seen=None):
    """attr 上游有没有某类节点（例如 reverse）"""
    seen = seen if seen is not None else set()
    for n in cmds.listConnections(attr, source=True, destination=False) or []:
        if n in seen:
            continue
        seen.add(n)
        if cmds.nodeType(n) == want:
            return True
        for a in (cmds.listAttr(n) or []):
            if has_upstream(n + "." + a, want, seen):
                return True
    return False


up = cmds.listConnections(shader + ".baseColor", source=True, destination=False) or []
check("link_baseColor", bool(up), up)
check("ao_multiplied", any(cmds.nodeType(n) == "multiplyDivide" for n in up), [cmds.nodeType(n) for n in up])
# 粗糙度（SG 工作流 → 反相）
up_r = cmds.listConnections(shader + ".specularRoughness", source=True, destination=False) or []
check("link_roughness", bool(up_r), up_r)
check("roughness_inverted", has_upstream(shader + ".specularRoughness", "reverse"), "上游要有 reverse")
# 金属度（invert=True）
up_m = cmds.listConnections(shader + ".metalness", source=True, destination=False) or []
check("link_metallic", bool(up_m), up_m)
check("metallic_inverted", has_upstream(shader + ".metalness", "reverse"), "上游要有 reverse")
# 法线：plusMinusAverage → normalCamera，DX 时 G 的乘数是负的
up_n = cmds.listConnections(shader + ".normalCamera", source=True, destination=False) or []
check("link_normal", bool(up_n) and cmds.nodeType(up_n[0]) == "plusMinusAverage", up_n and cmds.nodeType(up_n[0]))
if up_n and cmds.nodeType(up_n[0]) == "plusMinusAverage":
    md = (cmds.listConnections(up_n[0] + ".input3D[0]", source=True, destination=False) or [None])[0]
    check("normal_scale_node", bool(md) and cmds.nodeType(md) == "multiplyDivide", md and cmds.nodeType(md))
    if md:
        check("normal_dx_flip", cmds.getAttr(md + ".input2Y") < 0, cmds.getAttr(md + ".input2Y"))
        check("normal_intensity", abs(cmds.getAttr(md + ".input2X") - 2.4) < 1e-4, cmds.getAttr(md + ".input2X"))
# 自发光 / 不透明度
check("link_emissive", bool(cmds.listConnections(shader + ".emissionColor", source=True, destination=False)))
check("emission_weight", abs(cmds.getAttr(shader + ".emission") - 1.0) < 1e-6, cmds.getAttr(shader + ".emission"))
# 不透明度：rgb 贴图接复合属性 .opacity，带 alpha 的才逐通道接 .opacityR/G/B
check("link_opacity", bool(cmds.listConnections(shader + ".opacity", source=True, destination=False)
                          or cmds.listConnections(shader + ".opacityR", source=True, destination=False)))

# 打包图（ARM 同时给 AO / 粗糙 / 金属三处）只建一个 file 节点
arm_files = [f for f in (cmds.ls(type="file") or []) if "T_ARM" in str(cmds.getAttr(f + ".fileTextureName"))]
check("packed_map_shared", len(arm_files) == 1, len(arm_files))
# 非颜色贴图必须是 Raw，基础色是 sRGB
for slot, want in (("T_ARM", "Raw"), ("T_NormalDX", "Raw"), ("T_BaseColor", "sRGB"), ("T_Emissive", "sRGB")):
    fonts = [f for f in (cmds.ls(type="file") or []) if slot in str(cmds.getAttr(f + ".fileTextureName"))]
    check("colorspace_" + slot, bool(fonts) and all(cmds.getAttr(f + ".colorSpace") == want for f in fonts),
          [cmds.getAttr(f + ".colorSpace") for f in fonts])
# UV 平铺
p2d = [p for p in (cmds.ls(type="place2dTexture") or []) if cmds.isConnected(p + ".repeatUV", arm_files[0] + ".repeatUV")] if arm_files else []
check("uv_place2d", bool(p2d), len(p2d))
if p2d:
    check("uv_repeat", abs(cmds.getAttr(p2d[0] + ".repeatU") - 2.0) < 1e-6, cmds.getAttr(p2d[0] + ".repeatU"))
    check("uv_rotate", abs(cmds.getAttr(p2d[0] + ".rotateUV") - 0.5) < 1e-6, cmds.getAttr(p2d[0] + ".rotateUV"))
# 强度（0.8 的粗糙度图 → multiplyDivide 乘 0.8）
mul_nodes = [n for n in (cmds.ls(type="multiplyDivide") or [])
             if abs(cmds.getAttr(n + ".input2X") - 0.8) < 1e-6]
check("intensity_multiplier", bool(mul_nodes), mul_nodes)

# 空的材质配置也要能建（纯色）
sg2, applied2 = mod.build_material({"name": "AMTest_Empty", "maps": {}}, "AMTest_Empty")
check("empty_spec_ok", bool(sg2) and applied2 == [], [sg2, applied2])

# 原地重建：同名不堆 _SG1，节点数不涨
before = len(cmds.ls(type="file") or [])
sg3, applied3 = mod.build_material(SPEC, "AMTest_Mat", asset_id=999)
after = len(cmds.ls(type="file") or [])
check("reuse_same_sg_name", sg3 == "AMTest_Mat_SG", sg3)
check("reuse_no_duplicates", after == before, "%d → %d" % (before, after))
check("reuse_channels_again", set(applied3) == set(applied), sorted(applied3))
shader3 = (cmds.listConnections(sg3 + ".surfaceShader", source=True, destination=False) or [None])[0]
check("reuse_relinked", bool(cmds.listConnections(shader3 + ".baseColor", source=True, destination=False)))

# 用户自己的同名材质不能被覆盖
cmds.shadingNode("lambert", asShader=True, name="AMTest_Foreign")
user_sg = cmds.sets(renderable=True, noSurfaceShader=True, empty=True, name="AMTest_Foreign_SG")
user_shader = (cmds.listConnections(user_sg + ".surfaceShader", source=True, destination=False) or [None])[0]
sg4, _ = mod.build_material({"name": "AMTest_Foreign", "maps": {}}, "AMTest_Foreign")
check("reuse_not_hijack_user_material", sg4 != "AMTest_Foreign_SG", sg4)
check("user_material_intact", cmds.objExists("AMTest_Foreign_SG"), "用户材质还在")

# 清理
mod.clear_materials()
left = [s for s in (cmds.ls(type="shadingEngine") or []) if mod._is_tagged(s)]
check("clear_materials", left == [], left)


# ---------------------------------------------------------------- 5. 贴图任务

step("贴图任务")
cmds.file(new=True, force=True)
try:
    msg = mod.execute({"mode": "texture", "payload": {"files": [tex["base"], tex["normal"]]}})
    check("texture_task", "2 张" in msg, msg)
    checks = [f for f in (cmds.ls(type="file") or [])
              if "T_BaseColor" in str(cmds.getAttr(f + ".fileTextureName"))]
    check("texture_nodes", len(checks) == 1, len(checks))
    norms = [f for f in (cmds.ls(type="file") or [])
             if "T_NormalDX" in str(cmds.getAttr(f + ".fileTextureName"))]
    check("texture_normal_raw", bool(norms) and cmds.getAttr(norms[0] + ".colorSpace") == "Raw",
          cmds.getAttr(norms[0] + ".colorSpace") if norms else "—")
    check("texture_selected", len(cmds.ls(selection=True) or []) == 2, cmds.ls(selection=True))
except Exception as e:
    check("texture_task", False, "%s: %s" % (type(e).__name__, e))


# ---------------------------------------------------------------- 6. 模型导入

step("模型导入（FBX / OBJ）")
cmds.file(new=True, force=True)
cmds.loadPlugin("fbxmaya", quiet=True)
os.makedirs(os.path.join(WORK, "models"), exist_ok=True)
cube = cmds.polyCube(name="AMTestCube", width=2, height=2, depth=2)[0]
sphere = cmds.polySphere(name="AMTestSphere", radius=0.6)[0]
cmds.setAttr(sphere + ".translateX", 2.0)
fbx = os.path.join(WORK, "models", "AMTest_Box.fbx").replace("\\", "/")
cmds.select(cube, sphere)
cmds.file(fbx, force=True, exportSelected=True, type="FBX export", options="v=0;")
check("fbx_exported", os.path.getsize(fbx) > 1000, os.path.getsize(fbx))

cmds.file(new=True, force=True)
try:
    msg = mod.execute({"mode": "import", "payload": {"modelPath": fbx, "ext": ".fbx", "name": "AMTest_fbx"}})
    meshes = cmds.ls(type="mesh", long=True) or []
    check("import_fbx_ok", len(meshes) == 2, msg)
    check("import_fbx_message", "已导入" in msg, msg)
    check("import_fbx_selected", len(cmds.ls(selection=True) or []) > 0, cmds.ls(selection=True))
except Exception as e:
    check("import_fbx_ok", False, "%s: %s" % (type(e).__name__, e))

# 带材质的导入：素材有贴图 → 建材质并套给导入的网格
cmds.file(new=True, force=True)
try:
    msg = mod.execute({"mode": "import", "payload": {
        "modelPath": fbx, "ext": ".fbx", "name": "AMTest_fbx_mat", "assetId": 1234,
        "material": {"name": "AMTest_Imported", "workflow": "MR", "maps": {
            "baseColor": {"path": tex["base"], "channel": "rgb"},
            "roughness": {"path": tex["arm"], "channel": "g"},
        }}}})
    meshes = cmds.ls(type="mesh", long=True) or []
    sgs = set()
    for m in meshes:
        sgs.update(cmds.listConnections(m, type="shadingEngine") or [])
    check("import_with_material", any("AMTest_Imported" in s for s in sgs), sorted(sgs))
    check("import_material_message", "套用" in msg, msg)
except Exception as e:
    check("import_with_material", False, "%s: %s" % (type(e).__name__, e))

# OBJ
cmds.file(new=True, force=True)
obj = os.path.join(WORK, "models", "AMTest_Tri.obj").replace("\\", "/")
with open(obj, "w") as f:
    f.write("v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\n")
try:
    msg = mod.execute({"mode": "import", "payload": {"modelPath": obj, "ext": ".obj", "name": "AMTest_obj"}})
    check("import_obj_ok", len(cmds.ls(type="mesh") or []) >= 1, msg)
except Exception as e:
    check("import_obj_ok", False, "%s: %s" % (type(e).__name__, e))

# USD / ABC（用 Maya 自己导出样本再走插件的导入，格式支持靠它们验证）
cmds.file(new=True, force=True)
usd_ok = abc_ok = False
try:
    cmds.loadPlugin("mayaUsdPlugin", quiet=True)
    usd = os.path.join(WORK, "models", "AMTest_Box.usda").replace("\\", "/")
    cmds.polyCube(name="AMTestUsdCube")
    cmds.mayaUSDExport(file=usd, selection=True)
    cmds.file(new=True, force=True)
    msg = mod.execute({"mode": "import", "payload": {"modelPath": usd, "name": "AMTest_usd"}})
    check("import_usd_ok", len(cmds.ls(type="mesh") or []) >= 1, msg)
    usd_ok = True
except Exception as e:
    check("import_usd_ok", False, "%s: %s" % (type(e).__name__, e))

cmds.file(new=True, force=True)
try:
    cmds.loadPlugin("AbcExport", quiet=True)
    abc = os.path.join(WORK, "models", "AMTest_Box.abc").replace("\\", "/")
    box = cmds.polyCube(name="AMTestAbcCube")[0]
    cmds.AbcExport(j="-root %s -file %s -frameRange 1 1" % (box, abc))
    cmds.file(new=True, force=True)
    msg = mod.execute({"mode": "import", "payload": {"modelPath": abc, "name": "AMTest_abc"}})
    check("import_abc_ok", len(cmds.ls(type="mesh") or []) >= 1, msg)
    abc_ok = True
except Exception as e:
    check("import_abc_ok", False, "%s: %s" % (type(e).__name__, e))

# 不支持的格式要明确报错
bad_model = os.path.join(WORK, "models", "AMTest_Unsupported.max")
with open(bad_model, "wb") as f:
    f.write(b"\x00\x01\x02")
try:
    mod.execute({"mode": "import", "payload": {"modelPath": bad_model}})
    check("import_unsupported", False, "应该报错")
except Exception as e:
    check("import_unsupported", "读不了" in str(e), str(e)[:120])
# 文件不存在也要说清楚
try:
    mod.execute({"mode": "import", "payload": {"modelPath": os.path.join(WORK, "nope.fbx")}})
    check("import_missing_file", False, "应该报错")
except Exception as e:
    check("import_missing_file", "不存在" in str(e), str(e)[:120])


# ---------------------------------------------------------------- 7. HDRI / IES

step("HDRI（无 Arnold 时退化成环境球）")
cmds.file(new=True, force=True)
try:
    msg = mod.execute({"mode": "hdri", "payload": {"files": [tex["base"]], "hdriApply": {"env": True}}})
    check("hdri_ok", "HDRI 已应用" in msg, msg)
    check("hdri_dome", cmds.objExists("amSkyDome"), msg)
    check("hdri_texture", any("T_BaseColor" in str(cmds.getAttr(f + ".fileTextureName"))
                              for f in (cmds.ls(type="file") or [])))
except Exception as e:
    check("hdri_ok", False, "%s: %s" % (type(e).__name__, e))

step("IES（无 Arnold 时明确报错；.ldt 明确报错）")
ies = os.path.join(WORK, "tex", "AMTest.ies")
with open(ies, "w") as f:
    f.write("IESNA:LM-63-2002\nTILT=NONE\n")
try:
    mod.execute({"mode": "ies", "payload": {"files": [ies]}})
    if mod._arnold():
        check("ies_arnold", True, "Arnold 可用，走真实灯")
    else:
        check("ies_needs_arnold", False, "没有 Arnold 时应该抛出明确错误")
except Exception as e:
    check("ies_needs_arnold", "Arnold" in str(e), str(e)[:140])
ldt = os.path.join(WORK, "tex", "AMTest.ldt")
open(ldt, "w").close()
try:
    mod.execute({"mode": "ies", "payload": {"files": [ldt]}})
    check("ies_ldt_rejected", False, "应该报错")
except Exception as e:
    check("ies_ldt_rejected", "ies" in str(e).lower(), str(e)[:140])

step("未知任务类型")
try:
    mod.execute({"mode": "pack", "payload": {}})
    check("unknown_mode", False, "应该报错")
except Exception as e:
    check("unknown_mode", "不支持的任务类型" in str(e), str(e)[:120])


# ---------------------------------------------------------------- 8. 真实桥接协议

step("搭临时素材库并通过服务端跑真实任务")
lib = os.path.join(WORK, "lib")
matdir = os.path.join(lib, "Material", "AMTest_Concrete")
mdldir = os.path.join(lib, "Model", "AMTest_Box")
hdrdir = os.path.join(lib, "HDRI", "AMTest_Studio")
iesdir = os.path.join(lib, "IES", "AMTest_Lamp")
for d in (matdir, mdldir, hdrdir, iesdir):
    os.makedirs(d, exist_ok=True)
# 材质集：要有 .mtlx 才算 material
with open(os.path.join(matdir, "AMTest_Concrete.mtlx"), "w", encoding="utf-8") as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?>\n<materialx version="1.38"/>\n')
for tag, src in (("BaseColor", tex["base"]), ("Roughness", tex["arm"]),
                 ("NormalDX", tex["normal"]), ("AO", tex["arm"]), ("Height", tex["height"])):
    shutil.copy(src, os.path.join(matdir, "AMTest_Concrete_%s.png" % tag))
shutil.copy(fbx, os.path.join(mdldir, "AMTest_Box.fbx"))
shutil.copy(tex["base"], os.path.join(hdrdir, "AMTest_Studio.exr"))
with open(os.path.join(iesdir, "AMTest_Lamp.ies"), "w") as f:
    f.write("IESNA:LM-63-2002\nTILT=NONE\n")

http("/api/libraries", {"root": lib})
deadline = time.time() + 40
while time.time() < deadline:
    if not http("/api/scan").get("running"):
        break
    time.sleep(0.4)
state = http("/api/state")
libs = state.get("libraries") or []
check("library_added", len(libs) >= 1, [l.get("name") for l in libs])
lib_id = libs[-1]["id"] if libs else 0

deadline = time.time() + 25
assets = []
while time.time() < deadline:
    assets = http("/api/assets?lib=%d&limit=200" % lib_id).get("assets") or []
    if len(assets) >= 4:
        break
    time.sleep(0.4)
by_name = {a["name"]: a["id"] for a in assets}
check("assets_scanned", "AMTest_Concrete" in by_name and "AMTest_Box" in by_name, sorted(by_name))


def pump_until(job_id, seconds=60):
    """主线程泵：mayapy 没有事件循环，靠测试循环推进队列"""
    end = time.time() + seconds
    last = None
    while time.time() < end:
        mod.pump_once()
        job = http("/api/bridge/job/%d" % job_id)
        last = job
        if job and job.get("status") in ("done", "failed"):
            return job
        time.sleep(0.2)
    return last


if "AMTest_Concrete" in by_name:
    r = http("/api/bridge/send", {"assetId": by_name["AMTest_Concrete"], "mode": "material", "target": "maya"})
    check("send_material_queued", bool(r.get("id")), r)
    job = pump_until(r.get("id"))
    check("bridge_material_job", job and job.get("status") == "done",
          "%s / %s" % (job.get("status") if job else "?", job.get("message") if job else ""))
    sgs = [s for s in (cmds.ls(type="shadingEngine") or []) if "AMTest_Concrete" in s]
    check("bridge_material_created", bool(sgs), sgs)

if "AMTest_Box" in by_name:
    cmds.file(new=True, force=True)
    r = http("/api/bridge/send", {"assetId": by_name["AMTest_Box"], "mode": "import", "target": "maya"})
    check("send_import_queued", bool(r.get("id")), r)
    job = pump_until(r.get("id"))
    check("bridge_import_job", job and job.get("status") == "done",
          "%s / %s" % (job.get("status") if job else "?", job.get("message") if job else ""))
    check("bridge_import_mesh", len(cmds.ls(type="mesh") or []) > 0, len(cmds.ls(type="mesh") or []))

if "AMTest_Studio" in by_name:
    r = http("/api/bridge/send", {"assetId": by_name["AMTest_Studio"], "mode": "hdri", "target": "maya"})
    job = pump_until(r.get("id"))
    check("bridge_hdri_job", job and job.get("status") == "done",
          "%s / %s" % (job.get("status") if job else "?", job.get("message") if job else ""))

if "AMTest_Lamp" in by_name:
    r = http("/api/bridge/send", {"assetId": by_name["AMTest_Lamp"], "mode": "ies", "target": "maya"})
    job = pump_until(r.get("id"))
    if mod._arnold():
        check("bridge_ies_job", job and job.get("status") == "done", job.get("message") if job else "?")
    else:
        check("bridge_ies_job", job and job.get("status") == "failed"
              and "Arnold" in (job.get("message") or ""), job.get("message") if job else "?")

# 未知任务类型也要有回传（服务端能看到失败原因）
r = http("/api/bridge/send", {"assetId": by_name.get("AMTest_Box") or 1, "mode": "import",
                              "target": "maya"})
status_after = http("/api/bridge/status")["targets"].get("maya") or {}
check("queue_stats", "queued" in status_after and "running" in status_after, sorted(status_after))


# ---------------------------------------------------------------- 9. 端口跟随

step("端口跟随（软件换端口后插件自动切过去）")
import http.server
import socketserver
import threading as _threading


class _FakeApp(http.server.BaseHTTPRequestHandler):
    def _send(self, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/state"):
            self._send({"appRoot": "fake-app-root"})
        else:
            self.send_response(204)
            self.end_headers()

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self._send({"ok": True})

    def log_message(self, *args):
        pass


fake = socketserver.TCPServer(("127.0.0.1", 0), _FakeApp)
fake_port = fake.server_address[1]
_threading.Thread(target=fake.serve_forever, daemon=True).start()

real_localappdata = os.environ.get("LOCALAPPDATA")
fake_root = os.path.join(WORK, "fakeappdata")
os.makedirs(os.path.join(fake_root, "AssetManager"), exist_ok=True)
with open(os.path.join(fake_root, "AssetManager", "bridge.json"), "w", encoding="utf-8") as f:
    json.dump({"app": "AssetManager", "port": fake_port, "appRoot": "fake-app-root"}, f)

try:
    os.environ["LOCALAPPDATA"] = fake_root
    check("locator_read", mod._locator_port() == fake_port, "%s / 期望 %s" % (mod._locator_port(), fake_port))
    check("locator_switched", mod._follow_locator() is True, "端口没变时不会切换")
    check("locator_port_now", int(mod._state["port"]) == fake_port, mod._state["port"])
    check("locator_no_loop", mod._follow_locator() is False, "同一端口不应反复切换")
finally:
    if real_localappdata is None:
        os.environ.pop("LOCALAPPDATA", None)
    else:
        os.environ["LOCALAPPDATA"] = real_localappdata
    fake.shutdown()
    fake.server_close()
    mod._state["port"] = PORT
check("locator_restored", int(mod._state["port"]) == PORT, mod._state["port"])


# ---------------------------------------------------------------- 收尾

step("收尾")
mod.stop()
check("stop_thread", mod._state["thread"] is None)
print("AMTEST SUMMARY fails=%d %s" % (len(FAILS), ",".join(FAILS)))
if FAILS:
    sys.exit(1)
print("AMTEST ALL GREEN")
