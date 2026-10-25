# -*- coding: utf-8 -*-
"""AssetManager · Autodesk Maya 桥接插件 · 2025 系列（Maya 2025+）

协议与 3ds Max / Blender / SketchUp / UE 插件相同：轮询
http://127.0.0.1:<port>/api/bridge/maya/next，在主线程执行
导入模型 / 材质 / 贴图 / HDRI / IES 任务，回传 /api/bridge/maya/result，
每 5 秒 POST /api/bridge/maya/heartbeat 上报版本。

版本规则（见 app/bridge/maya/README.md）
  插件版本与软件版本解耦：第一版 0.1.0，之后只递增第三位（0.1.1、0.1.2…）；
  各 Maya 系列目录（2025/、以后 2026/…）共用同一个插件版本号。

线程模型（Maya 的硬约束，等同 UE 插件踩过的坑）
  后台线程只做 HTTP（轮询 / 心跳 / 端口跟随），任务进队列；
  所有 maya.cmds / maya.utils 调用都在主线程执行（pump_once 是入口）。
  Maya 的 API 不是线程安全的，在 worker 里碰 cmds 会随机崩溃。

菜单：主菜单栏 → AssetManager（已连接 / 未连接）
"""

AM_PLUGIN_VERSION = "0.1.0"
AM_SERIES = "2025"

# >>> AM_BODY >>> 以下所有 Maya 系列共用；改完用 tools/sync-maya-bridge.mjs 同步到其他系列

import json
import os
import queue
import re
import threading
import time
import traceback
import urllib.error
import urllib.request
import webbrowser

import maya.cmds as cmds

TARGET = "maya"
DEFAULT_PORT = 8787
PORT_MIN, PORT_MAX = 8787, 8805
POLL_INTERVAL = 0.8          # 取任务间隔
HEARTBEAT_INTERVAL = 5.0     # 心跳间隔
LOCATOR_INTERVAL = 5.0       # 多久核对一次软件的端口定位文件
TIMER_INTERVAL_MS = 250      # 主线程泵的节拍（GUI）
MARK_ATTR = "assetmanager"   # 打在自己建的着色组上的标记，用来判断「能不能原地重建」
ROOT_PREFIX = "am"           # 自己建的节点名前缀
SUPPORTED_IMPORT = (".fbx", ".obj", ".ma", ".mb", ".abc", ".usd", ".usda", ".usdc", ".usdz")

_jobs = queue.Queue()
_events = []
_state = {
    "connected": False,
    "port": DEFAULT_PORT,
    "last": "",
    "job": "",
    "error": "",
    "thread": None,
    "stop": False,
    "locator_at": 0.0,
    "heartbeat_at": 0.0,
    "jobs_done": 0,
    "jobs_failed": 0,
    "ui_dirty": False,
}
_timers = []          # Qt 定时器（GUI）
_menus = []           # 菜单控件
_menu_tries = 0
_deferred_armed = False


# ----------------------------------------------------------------- 日志 / 事件

def _event(text, kind="info"):
    """面板 / 菜单里显示的最近事件（只留最近 10 条）"""
    _events.append({"at": time.strftime("%H:%M:%S"), "text": str(text)[:300], "kind": kind})
    del _events[:-10]


def log(text):
    _event(text, "info")
    try:
        print("[AssetManager] %s" % text)
    except Exception:
        pass


def log_err(text):
    _event(text, "error")
    try:
        print("[AssetManager][ERROR] %s" % text)
    except Exception:
        pass


def events():
    return list(_events)


def state():
    """测试 / 菜单用：当前连接状态快照"""
    d = dict(_state)
    d["version"] = AM_PLUGIN_VERSION
    d["series"] = AM_SERIES
    d["queue"] = _jobs.qsize()
    return d


# ----------------------------------------------------------------- 基础 HTTP

def _base(port):
    return "http://127.0.0.1:%d" % int(port)


def _req(port, path, data=None, timeout=4):
    url = _base(port) + path
    body = None
    headers = {"User-Agent": "AssetManager-Maya/%s (%s)" % (AM_PLUGIN_VERSION, AM_SERIES)}
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw else None


def _locator_file():
    local = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    return os.path.join(local, "AssetManager", "bridge.json")


def _locator_port():
    """软件每次启动都会写 %LOCALAPPDATA%\\AssetManager\\bridge.json"""
    try:
        with open(_locator_file(), "r", encoding="utf-8") as f:
            d = json.load(f)
        if d.get("app") == "AssetManager" and d.get("port"):
            return int(d["port"])
    except Exception:
        pass
    return None


def _probe(port):
    """探活：返回 True 表示该端口上确实是 AssetManager"""
    try:
        d = _req(port, "/api/state", timeout=1.2)
        return bool(d and d.get("appRoot"))
    except Exception:
        return False


def discover_port():
    """先读定位文件，探不通再扫 8787–8805（便携版换了解压路径、端口漂移时靠这段）"""
    p = _locator_port()
    if p and _probe(p):
        return p
    for port in range(PORT_MIN, PORT_MAX + 1):
        if port == p:
            continue
        if _probe(port):
            return port
    return None


def _follow_locator():
    """运行中核对定位文件：软件换端口（重启/换路径）就切过去

    返回 True 表示端口发生了变化。同一端口不会反复切换。
    """
    p = _locator_port()
    if not p or p == int(_state["port"]):
        return False
    if not _probe(p):
        return False
    _state["port"] = p
    _state["locator_at"] = time.time()
    _state["ui_dirty"] = True      # 菜单刷新留给主线程（后台线程不碰 cmds）
    log("检测到软件换端口：%d" % p)
    return True


def heartbeat_once():
    """上报心跳（后台线程调用，纯 HTTP，不碰 cmds）"""
    port = int(_state["port"])
    info = {
        "series": AM_SERIES,
        "product": "Maya %s" % AM_SERIES,
        "version": AM_PLUGIN_VERSION,
    }
    try:
        _req(port, "/api/bridge/maya/heartbeat",
             {"version": AM_PLUGIN_VERSION, "host": _host(), "series": AM_SERIES,
              "maya": AM_SERIES, "info": info}, timeout=3)
        _state["heartbeat_at"] = time.time()
        if not _state["connected"]:
            _state["connected"] = True
            _state["ui_dirty"] = True   # 菜单标题的更新留给主线程
            log("已连接 AssetManager（端口 %d）" % port)
        return True
    except Exception as e:
        if _state["connected"]:
            _state["connected"] = False
            _state["ui_dirty"] = True
            log_err("连接断开：%s" % e)
        return False


def _host():
    """主机名（后台线程只读环境变量，不调 cmds）"""
    return os.environ.get("COMPUTERNAME") or "localhost"


def _next_job():
    """取一个任务（后台线程，纯 HTTP）"""
    try:
        job = _req(int(_state["port"]), "/api/bridge/maya/next", timeout=5)
    except urllib.error.HTTPError as e:
        if e.code == 204:
            return None
        raise
    except Exception:
        raise
    return job or None


def _report(job, ok, message, detail=None):
    try:
        _req(int(_state["port"]), "/api/bridge/maya/result",
             {"id": job.get("id"), "ok": bool(ok), "message": str(message)[:2000], "detail": detail},
             timeout=5)
        return True
    except Exception as e:
        log_err("结果回传失败：%s" % e)
        return False


# ----------------------------------------------------------------- 后台线程

def _worker():
    """轮询线程：只做 HTTP（心跳 / 取任务 / 端口跟随），任务丢进队列等主线程执行"""
    log("后台轮询已启动（插件 v%s · %s 系列）" % (AM_PLUGIN_VERSION, AM_SERIES))
    while not _state["stop"]:
        try:
            if not _state["connected"]:
                port = discover_port()
                if port:
                    _state["port"] = port
                    heartbeat_once()
                else:
                    time.sleep(2.0)
                    continue

            now = time.time()
            if now - _state["locator_at"] > LOCATOR_INTERVAL:
                _state["locator_at"] = now
                _follow_locator()
            if now - _state["heartbeat_at"] > HEARTBEAT_INTERVAL:
                heartbeat_once()

            job = _next_job()
            if job:
                _jobs.put(job)
            else:
                time.sleep(POLL_INTERVAL)
        except Exception as e:
            if _state["connected"]:
                _state["connected"] = False
                _state["ui_dirty"] = True
            _state["error"] = str(e)[:200]
            time.sleep(2.0)
    log("后台轮询已停止")


def start():
    t = _state.get("thread")
    if t and t.is_alive():
        return False
    _state["stop"] = False
    th = threading.Thread(target=_worker, name="AssetManagerBridge", daemon=True)
    th.start()
    _state["thread"] = th
    _start_pump()
    return True


def stop():
    _state["stop"] = True
    for t in list(_timers):
        try:
            t.stop()
        except Exception:
            pass
    del _timers[:]
    th = _state.get("thread")
    if th and th.is_alive():
        th.join(timeout=2.0)
    _state["thread"] = None
    _state["connected"] = False
    _refresh_menu()
    return True


def reconnect():
    stop()
    time.sleep(0.1)
    ok = start()
    port = discover_port()
    _state["port"] = port or DEFAULT_PORT
    if port:
        heartbeat_once()
    return ok


# ----------------------------------------------------------------- 主线程泵

def _gui():
    try:
        return not cmds.about(batch=True)
    except Exception:
        return False


def _start_pump():
    """GUI 下用 Qt 定时器驱动 pump_once；没有 Qt 就退回 evalDeferred 链"""
    if _timers:
        return True
    if _start_qtimer():
        return True
    _arm_deferred()
    return False


def _start_qtimer():
    if not _gui():
        return False
    QTimer = None
    for mod, cls in (("PySide6.QtCore", "QTimer"), ("PySide2.QtCore", "QTimer")):
        try:
            mod_obj = __import__(mod, fromlist=[cls])
            QTimer = getattr(mod_obj, cls)
            break
        except Exception:
            continue
    if QTimer is None:
        return False
    try:
        t = QTimer()
        t.setInterval(TIMER_INTERVAL_MS)
        t.timeout.connect(pump_once)
        t.start()
        _timers.append(t)
        return True
    except Exception:
        return False


def _arm_deferred():
    global _deferred_armed
    if _deferred_armed or not _gui():
        return
    _deferred_armed = True
    try:
        cmds.evalDeferred(_deferred_tick, lowestPriority=True)
    except Exception:
        _deferred_armed = False


def _deferred_tick():
    global _deferred_armed
    _deferred_armed = False
    try:
        pump_once()
    except Exception:
        pass
    _arm_deferred()


def pump_once():
    """执行队列里的任务（必须在主线程调用；测试脚本也直接调它）"""
    # GUI 里顺手维护菜单：Maya 启动过程中菜单可能还建不出来，这里重试几次
    _maybe_build_menu()
    if _state.get("ui_dirty"):
        _state["ui_dirty"] = False
        _refresh_menu()
    ran = 0
    while True:
        try:
            job = _jobs.get_nowait()
        except queue.Empty:
            break
        _run_and_report(job)
        ran += 1
    return ran


def _run_and_report(job):
    jid = job.get("id")
    mode = job.get("mode")
    title = job.get("title") or mode
    _state["job"] = "%s #%s" % (title, jid)
    try:
        message = execute(job)
        _state["jobs_done"] += 1
        _state["last"] = "%s ✓ %s" % (title, str(message)[:120])
        log("%s 完成：%s" % (title, message))
        _report(job, True, message, {"mode": mode, "plugin": AM_PLUGIN_VERSION})
    except Exception as e:
        _state["jobs_failed"] += 1
        msg = "%s: %s" % (type(e).__name__, e)
        _state["last"] = "%s ✗ %s" % (title, msg[:120])
        log_err("%s 失败：%s" % (title, msg))
        _report(job, False, msg, {"mode": mode, "traceback": traceback.format_exc()[-1200:]})
    finally:
        _state["job"] = ""


# ----------------------------------------------------------------- 任务分发

def execute(job):
    """执行一个任务（主线程）。返回给用户的成功消息；失败请抛异常。"""
    mode = (job or {}).get("mode")
    payload = (job or {}).get("payload") or {}
    handler = {
        "import": _do_import,
        "material": _do_material,
        "texture": _do_texture,
        "hdri": _do_hdri,
        "ies": _do_ies,
    }.get(mode)
    if handler is None:
        raise RuntimeError("不支持的任务类型：%s（Maya 插件只做 import / material / texture / hdri / ies）" % mode)
    return handler(payload)


# 测试脚本 / 旧命名兼容
_execute = execute


# ----------------------------------------------------------------- 小工具

def _safe_name(name, default="AM_Material"):
    s = re.sub(r"[^0-9A-Za-z_]+", "_", str(name or "")).strip("_")
    if not s:
        s = default
    if s[0].isdigit():
        s = "AM_" + s
    return s[:60]


def _unique(prefix):
    """拿一个没被占用的节点名（Maya 自己也会加数字，这里先保证语义清晰）"""
    if not cmds.objExists(prefix):
        return prefix
    for i in range(1, 1000):
        cand = "%s%d" % (prefix, i)
        if not cmds.objExists(cand):
            return cand
    return prefix


def _tag(node, asset_id=None):
    """给自建节点打标记：有标记才允许原地重建 / 清理"""
    try:
        if not cmds.attributeQuery(MARK_ATTR, node=node, exists=True):
            cmds.addAttr(node, longName=MARK_ATTR, dataType="string")
        cmds.setAttr(node + "." + MARK_ATTR, str(asset_id if asset_id is not None else "1"), type="string")
        return True
    except Exception:
        return False


def _is_tagged(node):
    try:
        return bool(cmds.objExists(node)) and cmds.attributeQuery(MARK_ATTR, node=node, exists=True)
    except Exception:
        return False


def _tagged_shading_groups():
    """所有带本插件标记的着色组（排除 Maya 自带的 initialShadingGroup 之类）"""
    out = []
    try:
        sgs = cmds.ls(type="shadingEngine") or []
    except Exception:
        return out
    for sg in sgs:
        try:
            if str(sg).startswith("initialShadingGroup") or str(sg).startswith("initialParticleSE"):
                continue
            if _is_tagged(sg):
                out.append(sg)
        except Exception:
            continue
    return out


def _renderer():
    try:
        return cmds.getAttr("defaultRenderGlobals.currentRenderer")
    except Exception:
        return ""


def _arnold_problem():
    """Arnold 不可用的原因（空字符串 = 可用）"""
    try:
        loaded = bool(cmds.pluginInfo("mtoa", query=True, loaded=True))
    except Exception:
        loaded = False
    if not loaded:
        try:
            cmds.loadPlugin("mtoa", quiet=True)
            loaded = bool(cmds.pluginInfo("mtoa", query=True, loaded=True))
        except Exception as e:
            return "mtoa 加载失败（%s）" % (str(e).strip().splitlines() or ["未知"])[0][:90]
    if not loaded:
        return "mtoa 未加载"
    if not _type_ok("aiSkyDomeLight"):
        return "mtoa 已加载但 Arnold 节点建不出来"
    return ""


def _arnold():
    """Arnold 是否可用（Maya 装好后默认加载 mtoa；自建节点前先问一次）"""
    return _arnold_problem() == ""


def _type_ok(t):
    """节点类型是否真的能建（未注册时 shadingNode 会静默造出 unknown 节点）"""
    try:
        n = cmds.createNode(t)
    except Exception:
        return False
    try:
        ok = cmds.nodeType(n) == t
    except Exception:
        ok = False
    try:
        cmds.delete(n)
    except Exception:
        pass
    return ok


def _load_plugin(name):
    try:
        if not cmds.pluginInfo(name, query=True, loaded=True):
            cmds.loadPlugin(name, quiet=True)
        return True
    except Exception:
        return False


# ----------------------------------------------------------------- 贴图 / 通道

COLOR_SPACE = {
    "baseColor": "sRGB",
    "emissive": "sRGB",
    "opacity": "sRGB",
    "roughness": "Raw",
    "metallic": "Raw",
    "ao": "Raw",
    "normal": "Raw",
    "height": "Raw",
    "specular": "Raw",
    "displacement": "Raw",
}

P2D_CONNECTIONS = (
    ("coverage", "coverage"), ("translateFrame", "translateFrame"),
    ("rotateFrame", "rotateFrame"), ("mirrorU", "mirrorU"), ("mirrorV", "mirrorV"),
    ("stagger", "stagger"), ("wrapU", "wrapU"), ("wrapV", "wrapV"),
    ("repeatUV", "repeatUV"), ("offset", "offset"), ("rotateUV", "rotateUV"),
    ("noiseUV", "noiseUV"), ("vertexUvOne", "vertexUvOne"), ("vertexUvTwo", "vertexUvTwo"),
    ("vertexUvThree", "vertexUvThree"), ("vertexCameraOne", "vertexCameraOne"),
    ("outUV", "uv"), ("outUvFilterSize", "uvFilterSize"),
)


def _make_file_node(name, path, color_space="sRGB", uv=None):
    """建 file + place2dTexture（Maya 里 file 节点必须配 place2dTexture 才有 UV 平铺）"""
    node = _unique(name)
    f = cmds.shadingNode("file", asTexture=True, name=node)
    p2d = cmds.shadingNode("place2dTexture", asUtility=True, name=node + "_p2d")
    for src, dst in P2D_CONNECTIONS:
        try:
            cmds.connectAttr(p2d + "." + src, f + "." + dst, force=True)
        except Exception:
            pass
    try:
        cmds.setAttr(f + ".fileTextureName", path, type="string")
    except Exception as e:
        log_err("贴图路径设置失败 %s：%s" % (path, e))
    try:
        cmds.setAttr(f + ".colorSpace", color_space or "sRGB", type="string")
    except Exception:
        pass
    uv = uv or {}
    try:
        cmds.setAttr(p2d + ".repeatU", float(uv.get("repeatU") or 1.0))
        cmds.setAttr(p2d + ".repeatV", float(uv.get("repeatV") or 1.0))
        cmds.setAttr(p2d + ".offsetU", float(uv.get("offsetU") or 0.0))
        cmds.setAttr(p2d + ".offsetV", float(uv.get("offsetV") or 0.0))
        cmds.setAttr(p2d + ".rotateUV", float(uv.get("rot") or 0.0))
    except Exception:
        pass
    return f


def _scalar_src(f, channel):
    """从 file 节点取单通道（float）"""
    ch = (channel or "r").lower()
    if ch == "g":
        return f + ".outColorG"
    if ch == "b":
        return f + ".outColorB"
    if ch == "a":
        return f + ".outAlpha"
    return f + ".outColorR"


def _color_src(f, channel):
    """从 file 节点取颜色（float3）"""
    ch = (channel or "rgb").lower()
    if ch == "a":
        return f + ".outAlpha"
    return f + ".outColor"


def _scalar_chain(f, channel, name, invert=False, intensity=1.0):
    """单通道 → 反相 → 强度，返回可连到 float 输入的属性名"""
    src = _scalar_src(f, channel)
    if invert:
        rv = _unique(name + "_inv")
        rev = cmds.shadingNode("reverse", asUtility=True, name=rv)
        try:
            cmds.connectAttr(src, rev + ".inputX", force=True)
        except Exception:
            cmds.connectAttr(src, rev + ".input", force=True)
        src = rev + ".outputX"
    if abs(float(intensity) - 1.0) > 1e-6:
        md = cmds.shadingNode("multiplyDivide", asUtility=True, name=_unique(name + "_mul"))
        cmds.connectAttr(src, md + ".input1X", force=True)
        cmds.setAttr(md + ".input2X", float(intensity))
        src = md + ".outputX"
    return src


def _color_chain(f, channel, name, invert=False, intensity=1.0):
    """颜色 → 反相 → 强度，返回可连到 color 输入的属性名"""
    src = _color_src(f, channel)
    if invert:
        rev = cmds.shadingNode("reverse", asUtility=True, name=_unique(name + "_inv"))
        cmds.connectAttr(src, rev + ".input", force=True)
        src = rev + ".output"
    if abs(float(intensity) - 1.0) > 1e-6:
        md = cmds.shadingNode("multiplyDivide", asUtility=True, name=_unique(name + "_mul"))
        cmds.connectAttr(src, md + ".input1", force=True)
        for ch in ("X", "Y", "Z"):
            cmds.setAttr(md + ".input2" + ch, float(intensity))
        src = md + ".output"
    return src


def _normal_chain(f, name, dx=False, intensity=1.0):
    """颜色贴图 → 切线空间法线向量（[0,1] → [-1,1]），再接 normalCamera

    Maya 的 bump2d 在「切线空间法线」模式下只收 float，接不了彩色贴图，
    所以用原生 multiplyDivide(×2·强度) + plusMinusAverage(−1) 直接算出向量。
    DX 法线（G 朝下）用 (2, -2, 2) / (-1, 1, -1) 的分量号翻过来。
    """
    scale = 2.0 * float(intensity if intensity else 1.0)
    md = cmds.shadingNode("multiplyDivide", asUtility=True, name=_unique(name + "_nmScale"))
    pma = cmds.shadingNode("plusMinusAverage", asUtility=True, name=_unique(name + "_nmBias"))
    cmds.connectAttr(f + ".outColor", md + ".input1", force=True)
    vals = [scale, -scale if dx else scale, scale]
    for ch, v in zip(("X", "Y", "Z"), vals):
        cmds.setAttr(md + ".input2" + ch, v)
    cmds.connectAttr(md + ".output", pma + ".input3D[0]", force=True)
    bias = [-1.0, 1.0 if dx else -1.0, -1.0]
    for ch, v in zip(("x", "y", "z"), bias):
        cmds.setAttr(pma + ".input3D[1].input3D" + ch, v)
    return pma + ".output3D"


def _bump_chain(f, channel, name, depth=0.02):
    """高度图 → bump2d（不用法线贴图时的兜底）"""
    b = cmds.shadingNode("bump2d", asUtility=True, name=_unique(name + "_bump"))
    cmds.connectAttr(_scalar_src(f, channel), b + ".bumpValue", force=True)
    try:
        cmds.setAttr(b + ".bumpInterp", 0)          # 0=Bump 1=切线空间法线 2=物体空间法线
        cmds.setAttr(b + ".bumpDepth", float(depth))
    except Exception:
        pass
    return b + ".outNormal"


# ----------------------------------------------------------------- 材质

def build_material(spec, name=None, assign_to=None, rebuild=True, asset_id=None, uv=None):
    """按软件给的 MaterialSpec 建 standardSurface 着色网络

    返回 (shading_group, applied_slots)。
    同名着色组如果是自己打的标记 → 原地重建（不堆 _SG1、_SG2）；用户自己的同名材质不覆盖。
    """
    spec = spec or {}
    name = _safe_name(name or spec.get("name") or "AM_Material")
    uv = uv if uv is not None else (spec.get("uv") or {})
    maps = spec.get("maps") or {}
    workflow = (spec.get("workflow") or "MR").upper()

    sg_name = name + "_SG"
    if rebuild and _is_tagged(sg_name):
        _delete_material(sg_name)
    elif cmds.objExists(sg_name):
        sg_name = _unique(sg_name)          # 别人的同名材质：换个名字，绝不覆盖

    if cmds.objExists(name):
        name = _unique(name)

    ss = cmds.shadingNode("standardSurface", asShader=True, name=name)
    sg = cmds.sets(renderable=True, noSurfaceShader=True, empty=True, name=sg_name)
    cmds.connectAttr(ss + ".outColor", sg + ".surfaceShader", force=True)
    _tag(ss, asset_id)
    _tag(sg, asset_id)

    cache = {}
    applied = []
    notes = []

    def file_for(slot):
        """同一张图被多个通道引用时只建一个 file 节点（打包图 ARM 常见）"""
        entry = maps.get(slot) or {}
        path = entry.get("path")
        if not path:
            return None
        cs = COLOR_SPACE.get(slot, "sRGB")
        key = (os.path.normcase(str(path)), cs)
        if key in cache:
            return cache[key]
        base = _safe_name("%s_%s" % (name, slot), "tex")
        f = _make_file_node(base + "_tex", path, cs, uv)
        cache[key] = f
        return f

    # 基础色（AO 用 multiplyDivide 乘进去；standardSurface 没有 AO 槽）
    base_src = None
    f = file_for("baseColor")
    if f:
        entry = maps.get("baseColor") or {}
        base_src = _color_chain(f, entry.get("channel"), name + "_base",
                               bool(entry.get("invert")), entry.get("intensity") or 1.0)
        applied.append("baseColor")
    ao = file_for("ao")
    if ao and base_src:
        entry = maps.get("ao") or {}
        mul = cmds.shadingNode("multiplyDivide", asUtility=True, name=_unique(name + "_aoMul"))
        cmds.connectAttr(base_src, mul + ".input1", force=True)
        cmds.connectAttr(_scalar_src(ao, entry.get("channel") or "r"), mul + ".input2X", force=True)
        base_src = mul + ".output"
        applied.append("ao")
    elif ao:
        notes.append("AO 已跳过（没有基础色可乘）")
    if base_src:
        cmds.connectAttr(base_src, ss + ".baseColor", force=True)

    # 粗糙度（SG 工作流下这张图是光泽度 → 反相）
    f = file_for("roughness")
    if f:
        entry = maps.get("roughness") or {}
        invert = bool(entry.get("invert")) or (workflow == "SG")
        src = _scalar_chain(f, entry.get("channel"), name + "_rough", invert,
                            entry.get("intensity") or 1.0)
        cmds.connectAttr(src, ss + ".specularRoughness", force=True)
        applied.append("roughness")

    f = file_for("metallic")
    if f:
        entry = maps.get("metallic") or {}
        src = _scalar_chain(f, entry.get("channel"), name + "_metal",
                            bool(entry.get("invert")), entry.get("intensity") or 1.0)
        cmds.connectAttr(src, ss + ".metalness", force=True)
        applied.append("metallic")

    # 法线（bump2d 的切线空间模式接不了彩色贴图，直接算向量）
    normal_f = file_for("normal")
    height_f = file_for("height")
    if normal_f:
        entry = maps.get("normal") or {}
        dx = str(entry.get("normalSpace") or "gl").lower() == "dx"
        src = _normal_chain(normal_f, name, dx, entry.get("intensity") or 1.0)
        cmds.connectAttr(src, ss + ".normalCamera", force=True)
        applied.append("normal")
        if height_f:
            notes.append("法线与高度同时存在时用法线，高度忽略")
    elif height_f:
        entry = maps.get("height") or {}
        src = _bump_chain(height_f, entry.get("channel") or "r", name,
                          entry.get("intensity") or 0.02)
        cmds.connectAttr(src, ss + ".normalCamera", force=True)
        applied.append("height")

    # 自发光
    f = file_for("emissive")
    if f:
        entry = maps.get("emissive") or {}
        src = _color_chain(f, entry.get("channel"), name + "_emit",
                           bool(entry.get("invert")), entry.get("intensity") or 1.0)
        cmds.connectAttr(src, ss + ".emissionColor", force=True)
        try:
            cmds.setAttr(ss + ".emission", 1.0)
        except Exception:
            pass
        applied.append("emissive")

    # 不透明度（standardSurface 的 opacity 是颜色：alpha 通道要分别接 R/G/B）
    f = file_for("opacity")
    if f:
        entry = maps.get("opacity") or {}
        ch = str(entry.get("channel") or "r").lower()
        invert = bool(entry.get("invert"))
        if ch == "a":
            src = _scalar_chain(f, "a", name + "_opacity", invert, entry.get("intensity") or 1.0)
            for comp in ("R", "G", "B"):
                cmds.connectAttr(src, ss + ".opacity" + comp, force=True)
        else:
            src = _color_chain(f, "rgb", name + "_opacity", invert, entry.get("intensity") or 1.0)
            cmds.connectAttr(src, ss + ".opacity", force=True)
        applied.append("opacity")

    if maps.get("displacement"):
        notes.append("置换（displacement）在 Maya 里需要细分 + 置换节点，首版未接")

    if assign_to:
        _assign(sg, assign_to)

    msg = "材质 %s（standardSurface · %s）通道：%s" % (
        sg, "MR 金属粗糙" if workflow != "SG" else "SG 高光光泽",
        "、".join(applied) if applied else "无贴图（纯色）")
    if notes:
        msg += "；" + "；".join(notes)
    log(msg)
    return sg, applied


def _assign(sg, nodes):
    """把着色组赋给对象/网格（只动传入的节点）"""
    done = 0
    for n in nodes or []:
        if not n or not cmds.objExists(n):
            continue
        targets = [n]
        try:
            if cmds.nodeType(n) == "transform":
                shapes = cmds.listRelatives(n, shapes=True, type="mesh") or []
                targets = shapes or [n]
            elif cmds.nodeType(n) != "mesh":
                continue
        except Exception:
            continue
        for t in targets:
            try:
                cmds.sets(t, edit=True, forceElement=sg)
                done += 1
            except Exception as e:
                log_err("赋材质失败 %s：%s" % (t, e))
    return done


def _delete_material(sg_name):
    """删掉自己建的材质（含上游 file / 工具节点），用于原地重建"""
    try:
        if not cmds.objExists(sg_name):
            return 0
        nodes = []
        try:
            shader = (cmds.listConnections(sg_name + ".surfaceShader", source=True, destination=False) or [None])[0]
        except Exception:
            shader = None
        if shader:
            nodes.append(shader)
            try:
                nodes.extend(cmds.listHistory(shader, pruneDagObjects=True) or [])
            except Exception:
                pass
        nodes.append(sg_name)
        seen = []
        for n in nodes:
            if n and n not in seen and cmds.objExists(n):
                seen.append(n)
        if seen:
            cmds.delete(seen)
        return len(seen)
    except Exception as e:
        log_err("删除旧材质失败：%s" % e)
        return 0


def clear_materials():
    """删掉本插件建的所有材质（菜单用）"""
    removed = 0
    for sg in _tagged_shading_groups():
        removed += _delete_material(sg)
    log("已清理本插件建的材质：%d 个节点" % removed)
    return removed


# ----------------------------------------------------------------- 各模式

def _do_material(payload):
    name = payload.get("assetName") or payload.get("name") or "AM_Material"
    spec = dict(payload)
    spec["name"] = name
    sg, applied = build_material(spec, name, asset_id=payload.get("assetId"))
    # 材质模式下把选区里的网格一并换上新材质（和 Blender 插件行为一致）
    sel = []
    try:
        for n in cmds.ls(selection=True, long=True) or []:
            if cmds.nodeType(n) in ("transform", "mesh"):
                sel.append(n)
    except Exception:
        pass
    if sel:
        n = _assign(sg, sel)
        return "材质 %s 已建好（%d 个通道），已赋给 %d 个选中对象" % (sg, len(applied), n)
    return "材质 %s 已建好（%d 个通道：%s）" % (sg, len(applied), "、".join(applied) or "无")


NONCOLOR_HINTS = ("normal", "_nrm", "nor_gl", "nor_dx", "rough", "metal", "ao", "occlusion",
                  "height", "disp", "gloss", "specular", "mask")


def guess_color_space(path):
    """按扩展名 + 文件名猜色彩空间：法线/粗糙/金属/AO/高度这类数据图必须是 Raw"""
    ext = os.path.splitext(str(path))[1].lower()
    if ext in (".exr", ".hdr", ".tif", ".tiff", ".exr"):
        return "Raw"
    name = os.path.basename(str(path)).lower()
    if any(k in name for k in NONCOLOR_HINTS):
        return "Raw"
    return "sRGB"


def _do_texture(payload):
    files = payload.get("files") or []
    if not files:
        raise RuntimeError("任务里没有贴图文件")
    made = []
    for path in files:
        if not os.path.exists(str(path)):
            log_err("贴图不存在，跳过：%s" % path)
            continue
        base = _safe_name(os.path.splitext(os.path.basename(str(path)))[0], "tex")
        made.append(_make_file_node(base + "_tex", str(path), guess_color_space(path)))
    if not made:
        raise RuntimeError("贴图文件都存在不了（路径不对？）")
    try:
        cmds.select(made, replace=True)
    except Exception:
        pass
    return "已导入 %d 张贴图（选中了这些 file 节点，可直接接到材质上）" % len(made)


def _do_import(payload):
    path = str(payload.get("modelPath") or "")
    if not path or not os.path.exists(path):
        raise RuntimeError("模型文件不存在：%s" % path)
    ext = os.path.splitext(path)[1].lower()
    if ext not in SUPPORTED_IMPORT:
        raise RuntimeError("Maya 插件读不了 %s 格式（支持 %s）" % (ext, " / ".join(SUPPORTED_IMPORT)))

    before = set(cmds.ls(type="mesh", long=True) or [])
    if ext == ".fbx":
        if not _load_plugin("fbxmaya"):
            raise RuntimeError("Maya 的 FBX 插件（fbxmaya）加载失败，无法导入 FBX")
        cmds.file(path, i=True, type="FBX", ignoreVersion=True, ra=True,
                  mergeNamespacesOnClash=False, options="v=0;", pr=True)
    elif ext == ".obj":
        _load_plugin("objExport")
        cmds.file(path, i=True, type="OBJ", ignoreVersion=True, ra=True, pr=True)
    elif ext in (".ma", ".mb"):
        cmds.file(path, i=True, ignoreVersion=True, ra=True,
                  type="mayaAscii" if ext == ".ma" else "mayaBinary", pr=True)
    elif ext == ".abc":
        if not _load_plugin("AbcImport"):
            raise RuntimeError("Alembic 插件（AbcImport）加载失败")
        cmds.AbcImport(path, mode="import")
    else:  # usd / usda / usdc / usdz
        if not _load_plugin("mayaUsdPlugin"):
            raise RuntimeError("Maya 的 USD 插件（mayaUsdPlugin）加载失败，无法导入 %s" % ext)
        try:
            # USD 的 translator 按扩展名识别，不给 type 反而最稳（type='USD' 会报「类型无效」）
            cmds.file(path, i=True, ignoreVersion=True, ra=True, pr=True)
        except Exception:
            cmds.mayaUSDImport(file=path)

    new_meshes = [m for m in (cmds.ls(type="mesh", long=True) or []) if m not in before]
    transforms = []
    for m in new_meshes:
        tr = (cmds.listRelatives(m, parent=True, fullPath=True) or [None])[0]
        if tr and tr not in transforms:
            transforms.append(tr)

    if new_meshes:
        msg = "已导入 %s：%d 个网格" % (ext.upper().strip("."), len(new_meshes))
    else:
        # Maya 的 FBX 导入会按名称与场景里已有对象合并：同名再导一次不会新增网格
        msg = "已导入 %s：场景里已有同名网格，按名称合并更新（没有新增网格）" % ext.upper().strip(".")
        transforms = [t for t in (cmds.ls(type="transform", long=True) or [])
                      if t.split("|")[-1] and not t.startswith("|persp")][:1]
    if transforms:
        msg += "（%s）" % (transforms[0].split("|")[-1] + ("…" if len(transforms) > 1 else ""))
        try:
            cmds.select(transforms, replace=True)
        except Exception:
            pass

    # 素材带贴图时：按素材里的材质重建一份，套到导入的网格上（模型自带的材质会被替换）
    spec = payload.get("material")
    if spec and (spec.get("maps") or {}):
        targets = list(new_meshes)
        if not targets:      # 合并导入的情况：拿刚选中的那几个变换下的网格
            for tr in transforms:
                targets.extend(cmds.listRelatives(tr, shapes=True, type="mesh", fullPath=True) or [])
        if targets:
            try:
                sg, applied = build_material(spec, spec.get("name") or payload.get("name"),
                                             asset_id=payload.get("assetId"))
                n = _assign(sg, targets)
                msg += "；套用 %s（%d 个通道，%d 个网格）" % (sg, len(applied), n)
            except Exception as e:
                msg += "；材质套用失败：%s" % e
    return msg


def _do_hdri(payload):
    files = payload.get("files") or []
    envs = [f for f in files if os.path.splitext(str(f))[1].lower() in (".exr", ".hdr", ".png", ".jpg", ".jpeg")]
    if not envs:
        raise RuntimeError("任务里没有 .exr / .hdr 环境贴图")
    path = str(envs[0])
    if not os.path.exists(path):
        raise RuntimeError("环境贴图不存在：%s" % path)
    opts = payload.get("hdriApply") or {}
    want_env = opts.get("env", True) is not False

    # 统一先建 file 节点（Arnold 灯和环境球共用）
    cs = "Raw" if os.path.splitext(path)[1].lower() in (".exr", ".hdr") else "sRGB"
    tex = _make_file_node(_unique("amHDRITex"), path, cs)
    _tag(tex, payload.get("assetId"))

    notes = []
    if want_env:
        if _arnold():
            light = _make_sky_light(tex)
            notes.append("Arnold 天空穹灯 %s" % light)
        else:
            dome = _make_sky_dome(tex)
            notes.append("视口环境球 %s（没加载 Arnold，只当背景，不产生照明）" % dome)
    msg = "HDRI 已应用：%s" % os.path.basename(path)
    if notes:
        msg += "；" + "；".join(notes)
    return msg


def _make_sky_light(tex):
    """Arnold：aiSkyDomeLight + file（优先）；失败就退回环境球"""
    name = "amSkyDomeLight"
    try:
        if cmds.objExists(name):
            cmds.delete(name)
        node = cmds.shadingNode("aiSkyDomeLight", asLight=True, name=name)
        if cmds.nodeType(node) == "unknown":
            cmds.delete(node)
            raise RuntimeError("aiSkyDomeLight 建不出来")
        target = _first_attr(node, ("color",), prefer_type="float3") or (node + ".color")
        cmds.connectAttr(tex + ".outColor", target, force=True)
        try:
            cmds.setAttr(node + ".intensity", 1.0)
        except Exception:
            pass
        try:
            cmds.setAttr(node + ".camera", 0)     # 不要在相机里看到灯本身
        except Exception:
            pass
        return node
    except Exception as e:
        log_err("Arnold 天空灯失败，改用环境球：%s" % e)
        return _make_sky_dome(tex)


def _make_sky_dome(tex):
    """原生环境球（内翻面 + 无光照材质）：没有 Arnold 时至少能看到 HDRI"""
    name = "amSkyDome"
    try:
        if not cmds.objExists(name):
            tr = cmds.polySphere(name=name, radius=1000, subdivisionsX=32, subdivisionsY=16)[0]
            shape = (cmds.listRelatives(tr, shapes=True, fullPath=True) or [None])[0]
            if shape:
                for attr, val in (("opposite", 1), ("castsShadows", 0), ("receiveShadows", 0),
                                  ("primaryVisibility", 1)):
                    try:
                        cmds.setAttr(shape + "." + attr, val)
                    except Exception:
                        pass
        tr = name
        ss_name = _unique("amSkyDomeShader")
        sh = cmds.shadingNode("surfaceShader", asShader=True, name=ss_name)
        cmds.connectAttr(tex + ".outColor", sh + ".outColor", force=True)
        sg = cmds.sets(renderable=True, noSurfaceShader=True, empty=True, name=_unique("amSkyDomeSG"))
        cmds.connectAttr(sh + ".outColor", sg + ".surfaceShader", force=True)
        _tag(sh, None)
        _assign(sg, [tr])
        return tr
    except Exception as e:
        raise RuntimeError("环境球创建失败：%s" % e)


def _do_ies(payload):
    files = payload.get("files") or []
    ies = [f for f in files if os.path.splitext(str(f))[1].lower() == ".ies"]
    if not ies:
        bad = [os.path.basename(str(f)) for f in files]
        raise RuntimeError("任务里没有 .ies 配光文件（%s）：.ldt 请先在软件里转换" % ("、".join(bad) or "空"))
    path = str(ies[0])
    if not os.path.exists(path):
        raise RuntimeError("IES 文件不存在：%s" % path)
    if not _arnold():
        raise RuntimeError("IES 需要 Arnold 的 aiPhotometricLight，但%s："
                           "请在「窗口 → 设置/首选项 → 插件管理器」里确认 mtoa 能勾上"
                           "（Arnold 没装好时 Maya 只能用环境球看 HDRI）" % (_arnold_problem() or "Arnold 不可用"))
    node = cmds.shadingNode("aiPhotometricLight", asLight=True, name=_unique("amIESLight"))
    if cmds.nodeType(node) == "unknown":
        cmds.delete(node)
        raise RuntimeError("aiPhotometricLight 建不出来（Arnold 版本不匹配？）")
    attr = _first_attr(node, ("filename", "intensityFile", "iesFile"), prefer_type="string")
    if not attr:
        raise RuntimeError("aiPhotometricLight 上找不到配光文件属性（Arnold 版本差异），已建好灯但没挂 IES")
    cmds.setAttr(node + "." + attr, path, type="string")
    try:
        cmds.setAttr(node + ".intensity", 1.0)
    except Exception:
        pass
    return "IES 灯 %s（%s）" % (node, os.path.basename(path))


def _first_attr(node, names, prefer_type=None):
    """在节点上找属性（Arnold 不同版本属性名不一致，按名字优先级 + 类型兜底）"""
    try:
        attrs = cmds.listAttr(node) or []
    except Exception:
        return None
    low = {a.lower(): a for a in attrs}
    for n in names:
        if n.lower() in low:
            return node + "." + low[n.lower()]
    if prefer_type == "string":
        for a in attrs:
            if any(k in a.lower() for k in ("file", "ies", "photometr")):
                try:
                    if cmds.attributeQuery(a, node=node, attributeType=True) == "string":
                        return node + "." + a
                except Exception:
                    continue
    if prefer_type == "float3":
        for a in attrs:
            if a.lower() in ("color", "colour", "tint"):
                return node + "." + a
    return None


# ----------------------------------------------------------------- 菜单

def _menu_name():
    return "amAssetManagerMenu"


def _menu_exists(name=None):
    """菜单要用 cmds.menu -exists 查；cmds.control 对菜单是假阴性（踩过）"""
    name = name or _menu_name()
    try:
        return bool(cmds.menu(name, exists=True))
    except Exception:
        pass
    try:
        return bool(cmds.control(name, exists=True))
    except Exception:
        return False


def _menu_label():
    if _state["connected"]:
        return "AssetManager（已连接 · v%s）" % AM_PLUGIN_VERSION
    return "AssetManager（未连接 · v%s）" % AM_PLUGIN_VERSION


def _refresh_menu():
    """连接状态变化时改菜单标题（只在主线程、且菜单已建时调用）"""
    if not _menus:
        return
    try:
        if _menu_exists():
            cmds.menu(_menu_name(), edit=True, label=_menu_label())
    except Exception:
        pass


def _maybe_build_menu():
    """菜单没建出来就再试（Maya 启动早期 $gMainWindow 可能还是空的）"""
    global _menu_tries
    if _menus or not _gui() or _menu_tries >= 60:
        return None
    _menu_tries += 1
    return build_menu()


def build_menu():
    """主菜单栏加 AssetManager 菜单（GUI 下调用；重复调用会重建）"""
    if not _gui():
        return None
    try:
        import maya.mel as mel
        main = mel.eval("$temp=$gMainWindow")
        if not main:
            return None
        if _menu_exists():
            try:
                cmds.deleteUI(_menu_name())
            except Exception:
                pass
        del _menus[:]
        m = cmds.menu(_menu_name(), label=_menu_label(), parent=main, tearOff=True)
        _menus.append(m)
        cmds.menuItem(label="状态…", parent=m, command=_menu_status)
        cmds.menuItem(label="重连", parent=m, command=lambda *a: reconnect())
        cmds.menuItem(label="断开", parent=m, command=lambda *a: (stop(), log("已断开")))
        cmds.menuItem(divider=True, parent=m)
        cmds.menuItem(label="立即处理队列", parent=m, command=lambda *a: _menu_pump())
        cmds.menuItem(label="清理本插件建的材质", parent=m, command=lambda *a: clear_materials())
        cmds.menuItem(divider=True, parent=m)
        cmds.menuItem(label="打开 AssetManager 页面", parent=m, command=_open_page)
        log("菜单已就绪：主菜单栏 → AssetManager")
        return m
    except Exception as e:
        log_err("菜单创建失败：%s" % e)
        return None


def _menu_status(*_):
    order = list(reversed(events()))[:8]
    body = "\n".join("%s %s" % (e["at"], e["text"]) for e in order) or "（还没有事件）"
    lines = [
        "插件版本：%s（%s 系列）" % (AM_PLUGIN_VERSION, AM_SERIES),
        "软件端口：%d" % int(_state["port"]),
        "连接状态：%s" % ("已连接" if _state["connected"] else "未连接"),
        "任务：成功 %d / 失败 %d / 排队 %d" % (_state["jobs_done"], _state["jobs_failed"], _jobs.qsize()),
        "当前渲染器：%s" % _renderer(),
        "Arnold：%s" % ("可用" if _arnold() else "未加载"),
        "",
        "最近事件：",
        body,
    ]
    cmds.confirmDialog(title="AssetManager 桥接状态", message="\n".join(lines), button=["好"])


def _menu_pump(*_):
    n = pump_once()
    cmds.confirmDialog(title="AssetManager", message="已处理 %d 个任务（队列剩余 %d）" % (n, _jobs.qsize()), button=["好"])


def _open_page(*_):
    webbrowser.open("http://127.0.0.1:%d" % int(_state["port"]))


# ----------------------------------------------------------------- 启动 / 卸载

_started = False


def auto_start():
    """userSetup.py 调它：建菜单 + 起后台轮询（重复调用安全）"""
    global _started
    if _started:
        return False
    _started = True
    port = discover_port()
    if port:
        _state["port"] = port
    _start_pump()
    start()
    try:
        build_menu()          # 启动早期 $gMainWindow 可能还没好，pump 里会继续重试
    except Exception as e:
        log_err("菜单初始化失败（不影响桥接）：%s" % e)
    if not port:
        log("没检测到 AssetManager（每 2 秒重试；启动软件后自动连上）")
    return True


def unload():
    global _started
    stop()
    _started = False
    if _menu_exists():
        try:
            cmds.deleteUI(_menu_name())
        except Exception:
            pass
    del _menus[:]
