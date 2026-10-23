# -*- coding: utf-8 -*-
"""AssetManager · Unreal Engine 桥接插件 · 5.8 系列（UE 5.8+）

协议与 3ds Max / Blender / SketchUp 插件相同：轮询
http://127.0.0.1:<port>/api/bridge/ue/next，在主线程执行
导入模型 / 材质 / 贴图 / HDRI / IES 任务，回传 /api/bridge/ue/result，
每 5 秒 POST /api/bridge/ue/heartbeat 上报版本。

版本规则（见 app/bridge/ue/README.md）
  插件版本与软件版本解耦：第一版 0.1.0，之后只递增第三位（0.1.1、0.1.2…）；
  各 UE 系列目录共用同一个插件版本号，改一次递增一次。

线程模型（UE 的硬约束）
  后台线程只做 HTTP；所有 unreal.* 资产操作都在主线程的
  slate post tick 回调里跑（引擎 API 不允许跨线程改资产）。

菜单：Tools → AssetManager（状态 / 重连 / 断开 / 打开软件页面）
"""

AM_PLUGIN_VERSION = "0.1.7"
AM_SERIES = "5.8"

# >>> AM_BODY >>> 下面所有 UE 系列共用；改完用 tools/sync-ue-bridge.mjs 同步到其他系列

import json
import os
import queue
import re
import socket
import threading
import time
import traceback
import urllib.error
import urllib.request

import unreal

TARGET = "ue"
DEFAULT_PORT = 8787
PORT_MIN, PORT_MAX = 8787, 8805
POLL_INTERVAL = 0.8
HEARTBEAT_INTERVAL = 5.0
LOCATOR_INTERVAL = 5.0      # 多久核对一次软件的端口定位文件
ROOT_FOLDER = "/Game/AssetManager"
MARK_TAG = "AssetManager"   # 打在自己建的资产上的元数据标签，用来判断「能不能原地重建」

_UE_VERSION = unreal.SystemLibrary.get_engine_version()
# 注意：unreal.* 只能在主线程调。后台线程（心跳/轮询）要用到的东西全部在导入时（主线程）取好，
# 否则会抛 "Attempted to access Unreal API from outside the main game thread"，
# 表现就是「能收任务（纯 HTTP），但界面一直显示未连接（心跳发不出去）」。
try:
    _PROJECT_FILE = unreal.Paths.get_project_file_path()
except Exception:
    _PROJECT_FILE = ""

_jobs = queue.Queue()
_events = []
_tick_handle = None
_menus_built = False
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
}


def _event(text, kind="info"):
    """面板 / 菜单里显示的最近事件（只留最近 8 条）

    后台线程也会调这里，unreal.log 跨线程是安全的（实测），但仍兜一层，
    免得日志本身把心跳/轮询线程带崩。
    """
    _events.append({"at": time.strftime("%H:%M:%S"), "text": str(text)[:200], "kind": kind})
    del _events[:-8]
    try:
        unreal.log("[AssetManager] %s" % text)
    except Exception:
        pass


def log(text):
    _event(text, "info")


def log_err(text):
    _event(text, "error")
    unreal.log_error("[AssetManager] %s" % text)


# ----------------------------------------------------------------- 基础 HTTP

def _base(port):
    return "http://127.0.0.1:%d" % int(port)


def _req(port, path, data=None, timeout=4):
    url = _base(port) + path
    body = None
    headers = {"User-Agent": "AssetManager-UE/%s (%s)" % (AM_PLUGIN_VERSION, AM_SERIES)}
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


def _alive(port):
    """/api/state 里带 appRoot 的就是本软件（主进程校验端口用的也是这个字段）"""
    try:
        d = _req(port, "/api/state", timeout=1.5)
        return bool(d) and (d.get("app") == "AssetManager" or "appRoot" in d)
    except Exception:
        return False


def _detect_port():
    """先信定位文件，再退回扫 8787-8805（同 Blender 插件 0.1.2 的策略）"""
    p = _locator_port()
    if p and _alive(p):
        return p
    for port in range(PORT_MIN, PORT_MAX + 1):
        if port == p:
            continue
        if _alive(port):
            return port
    return None


def _follow_locator():
    """软件换端口（重启 / 便携版换路径）时自动跟过去"""
    now = time.time()
    if now - _state["locator_at"] < LOCATOR_INTERVAL:
        return
    _state["locator_at"] = now
    p = _locator_port()
    if not p or p == _state["port"]:
        return
    if _alive(p):
        _state["port"] = p
        _state["connected"] = True
        log("跟随软件端口 → %d" % p)


# ----------------------------------------------------------------- 小工具

_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe_name(name, fallback="AssetManager"):
    s = _BAD.sub("_", str(name or "")).strip().strip(".")
    s = re.sub(r"\s+", "_", s)
    return s[:64] or fallback


def _num(d, key, dflt):
    try:
        v = d.get(key, dflt)
        return float(v)
    except Exception:
        return float(dflt)


def _dest_for(name, sub=""):
    """任务落盘目录：/Game/AssetManager/<素材名>/[sub]"""
    p = "%s/%s" % (ROOT_FOLDER, _safe_name(name))
    if sub:
        p = "%s/%s" % (p, _safe_name(sub))
    return p


def _ensure_dir(path):
    try:
        if not unreal.EditorAssetLibrary.does_directory_exist(path):
            unreal.EditorAssetLibrary.make_directory(path)
    except Exception:
        pass


def _load(path):
    try:
        return unreal.EditorAssetLibrary.load_asset(path)
    except Exception:
        return None


def _save(obj):
    try:
        unreal.EditorAssetLibrary.save_loaded_asset(obj)
    except Exception:
        pass


def _is_ours(obj):
    """只碰自己建的资产：用户同名资产不覆盖"""
    try:
        return str(unreal.EditorAssetLibrary.get_metadata_tag(obj, MARK_TAG) or "") != ""
    except Exception:
        return False


def _our_version(obj):
    """自己建的资产上记录的插件版本（用来判断要不要重建）"""
    try:
        return str(unreal.EditorAssetLibrary.get_metadata_tag(obj, MARK_TAG) or "")
    except Exception:
        return ""


def _mark(obj):
    try:
        unreal.EditorAssetLibrary.set_metadata_tag(obj, MARK_TAG, AM_PLUGIN_VERSION)
    except Exception:
        pass


def _asset_tools():
    return unreal.AssetToolsHelpers.get_asset_tools()


def _create_asset_safe(name, dest, cls, factory):
    """建资产；同名被别的资产占着时让 UE 起唯一名。

    直接 create_asset 撞名会弹「资产已存在，是否替换？」**模态框**，把游戏线程卡住
    （tick 回调不再跑、任务永远不结束，编辑器看着还活着）。这里绝不让它弹。
    """
    _ensure_dir(dest)          # 目录不存在时 create_asset 会失败
    path_try = "%s/%s" % (dest, name)
    if unreal.EditorAssetLibrary.does_asset_exist(path_try):
        path_try = _asset_tools().create_unique_asset_name(path_try, "")
        name = path_try.rsplit("/", 1)[-1]
    return _asset_tools().create_asset(name, dest, cls, factory)


def _mel():
    return unreal.MaterialEditingLibrary


def _actor_subsystem():
    try:
        return unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    except Exception:
        return None


def _find_actor(label):
    sub = _actor_subsystem()
    if not sub:
        return None
    try:
        for a in sub.get_all_level_actors():
            if a.get_actor_label() == label:
                return a
    except Exception:
        pass
    return None


def _viewport_location():
    """新对象放在当前视口位置（拿不到就用原点）"""
    def _from(v):
        if v is None:
            return None
        loc = v[0] if isinstance(v, (tuple, list)) else getattr(v, "location", None)
        if loc is None:
            return None
        return unreal.Vector(float(loc.x), float(loc.y), float(loc.z))

    for getter in (
        lambda: unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_level_viewport_camera_info(),
        lambda: unreal.EditorLevelLibrary.get_level_viewport_camera_info(),
    ):
        try:
            loc = _from(getter())
            if loc is not None:
                return loc
        except Exception:
            continue
    return unreal.Vector(0.0, 0.0, 0.0)


def _custom_inputs(names):
    """MaterialExpressionCustom 的输入口：UE 的 CustomInput 不能用构造参数，只能建完再设"""
    out = []
    for n in names:
        ci = unreal.CustomInput()
        ci.set_editor_property("input_name", n)
        out.append(ci)
    return out


# ----------------------------------------------------------------- 贴图

_TEX_KIND = {
    "color": (True, "TC_DEFAULT"),
    "normal": (False, "TC_NORMALMAP"),
    "mask": (False, "TC_GRAYSCALE"),
    "hdr": (False, "TC_HDR"),
    "ui": (True, "TC_EDITOR_ICON"),
}


def _apply_texture_settings(tex, kind):
    srgb, comp = _TEX_KIND.get(kind, _TEX_KIND["color"])
    try:
        tex.set_editor_property("srgb", srgb)
    except Exception:
        pass
    try:
        tex.set_editor_property("compression_settings",
                                getattr(unreal.TextureCompressionSettings, comp))
    except Exception:
        pass
    if kind in ("hdr",):
        try:
            tex.set_editor_property("never_stream", True)
        except Exception:
            pass
    if kind in ("mask", "normal"):
        try:
            tex.set_editor_property("filter", unreal.TextureFilter.TF_BILINEAR)
        except Exception:
            pass
    try:
        tex.update_resource()
    except Exception:
        pass


def import_texture(path, dest_dir, name=None, kind="color", reuse=True):
    """把一张图片导入成 Texture2D；返回资产对象（失败返回 None）"""
    if not path or not os.path.exists(path):
        log_err("贴图不存在：%s" % path)
        return None
    name = _safe_name(name or os.path.splitext(os.path.basename(path))[0])
    asset_path = "%s/%s" % (dest_dir, name)
    if reuse and unreal.EditorAssetLibrary.does_asset_exist(asset_path):
        tex = _load(asset_path)
        if tex:
            _apply_texture_settings(tex, kind)
            _save(tex)
            return tex

    _ensure_dir(dest_dir)
    task = unreal.AssetImportTask()
    task.filename = path
    task.destination_path = dest_dir
    task.destination_name = name
    task.automated = True
    task.replace_existing = True
    task.save = True
    try:
        f = unreal.TextureFactory()
        for k, v in (("srgb", _TEX_KIND.get(kind, _TEX_KIND["color"])[0]),):
            try:
                f.set_editor_property(k, v)
            except Exception:
                pass
        task.factory = f
    except Exception:
        pass

    try:
        _asset_tools().import_asset_tasks([task])
    except Exception as e:
        log_err("贴图导入失败 %s：%s" % (os.path.basename(path), e))
        return None

    tex = None
    for p in list(task.imported_object_paths or []):
        obj = _load(str(p))
        if isinstance(obj, unreal.Texture2D):
            tex = obj
            break
    if not tex:
        tex = _load(asset_path)
    if not tex:
        log_err("贴图导入后取不到资产：%s" % path)
        return None
    _apply_texture_settings(tex, kind)
    _mark(tex)
    _save(tex)
    return tex


# ----------------------------------------------------------------- 材质

def _mat_exp(mat, cls, x, y):
    return _mel().create_material_expression(mat, cls, x, y)


def _const(mat, value, x, y):
    e = _mat_exp(mat, unreal.MaterialExpressionConstant, x, y)
    e.set_editor_property("r", float(value))
    return e


def _const3(mat, value, x, y):
    e = _mat_exp(mat, unreal.MaterialExpressionConstant3Vector, x, y)
    v = float(value)
    e.set_editor_property("constant", unreal.LinearColor(v, v, v, 1.0))
    return e


def _multiply(mat, a, b, x, y, a_out="", b_out=""):
    e = _mat_exp(mat, unreal.MaterialExpressionMultiply, x, y)
    _mel().connect_material_expressions(a, a_out, e, "A")
    _mel().connect_material_expressions(b, b_out, e, "B")
    return e


def _oneminus(mat, src, x, y, src_out=""):
    e = _mat_exp(mat, unreal.MaterialExpressionOneMinus, x, y)
    _mel().connect_material_expressions(src, src_out, e, "")
    return e


def _mask(mat, src, ch, x, y, src_out="RGB"):
    """ComponentMask：输入口没有名字（""）；采样节点的颜色输出叫 "RGB" """
    e = _mat_exp(mat, unreal.MaterialExpressionComponentMask, x, y)
    for c in ("r", "g", "b", "a"):
        e.set_editor_property(c, c == ch)
    _mel().connect_material_expressions(src, src_out, e, "")
    return e


def _flip_green(mat, src, x, y):
    """GL 法线（+Y）转 UE 的 DX 法线：G 取反；建不出自定义节点就原样返回 None"""
    try:
        e = _mat_exp(mat, unreal.MaterialExpressionCustom, x, y)
        e.set_editor_property("description", "AM_FlipGreen")
        e.set_editor_property("code", "return float3(N.r, 1.0 - N.g, N.b);")
        e.set_editor_property("output_type", unreal.CustomMaterialOutputType.CMOT_FLOAT3)
        e.set_editor_property("inputs", _custom_inputs(["N"]))
        _mel().connect_material_expressions(src, "RGB", e, "N")
        return e
    except Exception as ex:
        log("法线 G 通道翻转没建起来（按原样用）：%s" % ex)
        return None


def _tex_coord(mat, uv, x, y):
    """UV 平铺 / 旋转：TextureCoordinate + Rotator"""
    cfg = uv or {}
    rep_u = _num(cfg, "repeatU", 1.0)
    rep_v = _num(cfg, "repeatV", 1.0)
    rot = _num(cfg, "rot", 0.0)
    off_u = _num(cfg, "offsetU", 0.0)
    off_v = _num(cfg, "offsetV", 0.0)
    if rep_u == 1.0 and rep_v == 1.0 and rot == 0.0 and off_u == 0.0 and off_v == 0.0:
        return None
    tc = _mat_exp(mat, unreal.MaterialExpressionTextureCoordinate, x, y)
    try:
        tc.set_editor_property("u_tiling", rep_u)
        tc.set_editor_property("v_tiling", rep_v)
    except Exception:
        pass
    src = tc
    if off_u or off_v:
        try:
            add = _mat_exp(mat, unreal.MaterialExpressionAdd, x + 180, y)
            _mel().connect_material_expressions(tc, "", add, "A")
            c = _mat_exp(mat, unreal.MaterialExpressionConstant2Vector, x + 180, y + 90)
            c.set_editor_property("r", off_u)
            c.set_editor_property("g", off_v)
            _mel().connect_material_expressions(c, "", add, "B")
            src = add
        except Exception:
            pass
    if rot:
        try:
            r = _mat_exp(mat, unreal.MaterialExpressionRotator, x + 360, y)
            r.set_editor_property("center_x", 0.5)
            r.set_editor_property("center_y", 0.5)
            r.set_editor_property("speed", float(rot) / 360.0)
            _mel().connect_material_expressions(src, "", r, "Coordinate")
            _mel().connect_material_expressions(_const(mat, 1.0, x + 360, y + 120), "", r, "Time")
            src = r
        except Exception:
            pass
    return src


def _sample(mat, tex, uv_node, x, y, normal=False):
    s = _mat_exp(mat, unreal.MaterialExpressionTextureSample, x, y)
    s.set_editor_property("texture", tex)
    if normal:
        try:
            s.set_editor_property("sampler_type", unreal.MaterialSamplerType.SAMPLERTYPE_NORMAL)
        except Exception:
            pass
    if uv_node is not None:
        _mel().connect_material_expressions(uv_node, "", s, "UVs")
    return s


def _map_output(mat, entry, slot, tex, uv_node, x, y):
    """把一张贴图按 channel / intensity / invert 处理成要接到材质属性的表达式

    返回 (表达式, 输出口名)。采样节点的颜色输出叫 "RGB"，
    ComponentMask / Multiply / Custom 这类单输出节点输出口没有名字（""）。
    """
    ch = str(entry.get("channel") or "rgb").lower()
    normal = (slot == "normal")
    s = _sample(mat, tex, uv_node, x, y, normal=normal)
    if normal:
        if str(entry.get("normalSpace") or "").lower() == "gl":
            flipped = _flip_green(mat, s, x + 200, y)
            if flipped is not None:
                return flipped, ""
        return s, "RGB"

    if ch == "rgb":
        # 颜色类：只处理强度
        k = _num(entry, "intensity", 1.0)
        if k != 1.0:
            return _multiply(mat, s, _const3(mat, k, x + 200, y + 120), x + 380, y, a_out="RGB"), ""
        return s, "RGB"

    m = _mask(mat, s, ch, x + 200, y)
    out = m
    if entry.get("invert"):
        out = _oneminus(mat, out, x + 380, y)
    k = _num(entry, "intensity", 1.0)
    if k != 1.0:
        out = _multiply(mat, out, _const(mat, k, x + 380, y + 120), x + 560, y)
    return out, ""


# 槽位 → 材质属性
_SLOT_PROP = {
    "baseColor": "MP_BASE_COLOR",
    "emissive": "MP_EMISSIVE_COLOR",
    "roughness": "MP_ROUGHNESS",
    "metallic": "MP_METALLIC",
    "ao": "MP_AMBIENT_OCCLUSION",
    "specular": "MP_SPECULAR",
    "normal": "MP_NORMAL",
    "opacity": "MP_OPACITY",
}
_SLOT_KIND = {
    "baseColor": "color",
    "emissive": "color",
    "normal": "normal",
    "roughness": "mask",
    "metallic": "mask",
    "ao": "mask",
    "opacity": "mask",
    "specular": "mask",
    "glossiness": "mask",
    "height": "mask",
}


def build_material(spec, name=None, reuse=True):
    """按 MaterialSpec 建 / 原地重建一个 UE Material

    spec = { name, workflow, maps: {slot: {path, channel, intensity, invert, normalSpace}}, uv }
    """
    mat_name = _safe_name(name or spec.get("name") or "AM_Material")
    dest = _dest_for(spec.get("assetName") or mat_name)
    asset_path = "%s/%s" % (dest, "M_" + mat_name)

    mat = None
    if reuse and unreal.EditorAssetLibrary.does_asset_exist(asset_path):
        old = _load(asset_path)
        if old and _is_ours(old):
            mat = old          # 自己的材质：原地重建，不堆 .001
    if mat is None:
        _ensure_dir(dest)
        mat = _create_asset_safe("M_" + mat_name, dest, unreal.Material, unreal.MaterialFactoryNew())
        if not mat:
            raise RuntimeError("创建材质失败：%s" % asset_path)
    _mark(mat)

    _mel().delete_all_material_expressions(mat)
    try:
        mat.set_editor_property("two_sided", False)
    except Exception:
        pass

    maps = spec.get("maps") or {}
    uv_node = _tex_coord(mat, spec.get("uv"), -1400, 400)
    tex_dir = "%s/Textures" % dest
    applied, skipped = [], []

    # 光泽度工作流：roughness = 1 - glossiness
    if "roughness" not in maps and "glossiness" in maps:
        maps = dict(maps)
        maps["roughness"] = dict(maps["glossiness"], invert=True)

    # 置换/高度：UE 的延迟渲染没有 tessellation 位移槽，用 BumpOffset（视差）表现，
    # 接到贴图采样的 UV 上，这样颜色/粗糙度等都会跟着高度产生视差。
    height_entry = maps.get("height") or maps.get("displacement")
    if height_entry and height_entry.get("path"):
        try:
            h_tex = import_texture(height_entry["path"], tex_dir,
                                   name="T_%s_height" % mat_name, kind="mask")
            if h_tex:
                h_sample = _sample(mat, h_tex, uv_node, -1200, 700)
                bump = _mat_exp(mat, unreal.MaterialExpressionBumpOffset, -1000, 700)
                ratio = _num(height_entry, "intensity", 0.04) or 0.04
                try:
                    bump.set_editor_property("height_ratio", ratio)
                except Exception:
                    pass
                _mel().connect_material_expressions(h_sample, "R", bump, "Height")
                uv_node = bump          # 后续所有采样都用视差后的 UV
                applied.append("height")
            else:
                skipped.append("height")
        except Exception as e:
            skipped.append("height(%s)" % e)

    for slot, entry in maps.items():
        if slot in ("height", "displacement"):
            continue
        prop = _SLOT_PROP.get(slot)
        if not prop or not entry or not entry.get("path"):
            skipped.append(slot)
            continue
        tex = import_texture(entry["path"], tex_dir,
                             name="T_%s_%s" % (mat_name, slot),
                             kind=_SLOT_KIND.get(slot, "color"))
        if not tex:
            skipped.append(slot)
            continue
        node, out_name = _map_output(mat, entry, slot, tex, uv_node, -900, 0)
        try:
            _mel().connect_material_property(node, out_name, getattr(unreal.MaterialProperty, prop))
            applied.append(slot)
            if slot == "emissive":
                # 自发光要"真的亮"：给材质一个非黑的自发光色，强度由贴图强度控制
                try:
                    mat.set_editor_property("emissive_color", unreal.LinearColor(1.0, 1.0, 1.0, 1.0))
                except Exception:
                    pass
        except Exception as e:
            skipped.append("%s(%s)" % (slot, e))

    if "opacity" in applied:
        try:
            mat.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
            mat.set_editor_property("two_sided", True)   # 半透明单薄片（树叶/布）单面会缺一半
        except Exception:
            pass

    try:
        _mel().layout_material_expressions(mat)
    except Exception:
        pass
    try:
        _mel().recompile_material(mat)
    except Exception:
        pass
    _save(mat)
    return mat, applied, skipped


# ----------------------------------------------------------------- 材质模式（独立材质 / 父材质实例）

# 材质任务**不再弹模态框**：UE 的模态框会挡住内容浏览器，没法在弹窗里去选父材质。
# 父材质改由 AssetManager 端发送时指定（payload.parentMaterial，留空=独立材质）；
# 想事后改成实例：内容浏览器选中父材质 → 工具 → AssetManager → 用选中的材质重建最近材质。
ASK_MATERIAL_MODE = False
# 最近一次的材质任务（菜单「用选中的材质重建最近材质」要用）
_last_material_spec = {}

# 父材质里常见的参数名（按顺序找第一个存在的）
_PARAM_ALIASES = {
    "baseColor": ["BaseColor", "BaseColorMap", "BaseColorTexture", "Albedo", "Diffuse", "T_BaseColor"],
    "normal": ["Normal", "NormalMap", "NormalTexture", "T_Normal"],
    "roughness": ["Roughness", "RoughnessMap", "T_Roughness"],
    "metallic": ["Metallic", "MetallicMap", "Metalness", "T_Metallic"],
    "ao": ["AO", "AOMap", "AmbientOcclusion", "T_AO"],
    "emissive": ["Emissive", "EmissiveMap", "EmissiveTexture", "T_Emissive"],
    "opacity": ["Opacity", "OpacityMap", "T_Opacity"],
    "height": ["Height", "HeightMap", "Displacement", "T_Height"],
}

# 参数名对不上时按关键词兜底（很多父材质叫 BaseColorTex / T_Rough / Nrm …）
_SLOT_KEYWORDS = {
    "baseColor": ("basecolor", "albedo", "diffuse", "color"),
    "normal": ("normal", "nrm"),
    "roughness": ("roughness", "rough"),
    "metallic": ("metallic", "metal", "metalness"),
    "ao": ("ambientocclusion", "occlusion", "ao"),
    "emissive": ("emissive", "emission", "emit"),
    "opacity": ("opacity", "alpha"),
    "height": ("displacement", "height", "disp", "bump"),
}


def _norm_name(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def _root_material(obj):
    """一路往上找到最底层的 Material（材质实例的默认值得设在它上面）"""
    cur = obj
    for _ in range(8):
        if isinstance(cur, unreal.Material):
            return cur
        try:
            nxt = cur.get_editor_property("parent") if isinstance(cur, unreal.MaterialInstance) else None
        except Exception:
            nxt = None
        if not nxt:
            break
        cur = nxt
    return cur


def _parent_param_names(parent):
    """父材质声明了哪些贴图参数（材质实例就给到它的 base material 去取）"""
    seen = []
    cur = parent
    for _ in range(8):
        try:
            for n in _mel().get_texture_parameter_names(cur):
                n = str(n)
                if n not in seen:
                    seen.append(n)
        except Exception:
            pass
        try:
            nxt = cur.get_editor_property("parent") if isinstance(cur, unreal.MaterialInstance) else None
        except Exception:
            nxt = None
        if not nxt:
            break
        cur = nxt
    return seen


def _pick_param(slot, params):
    """给某个通道挑一个父材质参数名：先精确别名（归一化），再关键词包含"""
    table = {}
    for p in params:
        table.setdefault(_norm_name(p), p)
    for cand in _PARAM_ALIASES.get(slot, []):
        hit = table.get(_norm_name(cand))
        if hit:
            return hit
    for kw in _SLOT_KEYWORDS.get(slot, ()):
        for norm, real in table.items():
            if kw in norm:
                return real
    return None


def _dialogs_enabled():
    return ASK_MATERIAL_MODE and os.environ.get("AM_NO_DIALOG") != "1"


def _pkg(obj):
    """资产对象 → 包路径（不带 .ObjectName）"""
    try:
        return str(obj.get_path_name()).split(".")[0]
    except Exception:
        return ""


def _cfg_file():
    """插件自己的小配置（记上次用的父材质），放工程的 Saved 目录"""
    try:
        base = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_saved_dir())
        return os.path.join(base, "AssetManagerBridge.json")
    except Exception:
        return ""


def _load_cfg():
    p = _cfg_file()
    if not p or not os.path.exists(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _save_cfg(**kw):
    p = _cfg_file()
    if not p:
        return
    try:
        d = _load_cfg()
        d.update(kw)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)
    except Exception as e:
        log("写配置失败：%s" % e)


def _remember_parent(path):
    if path:
        _save_cfg(lastParent=str(path))


def _last_parent():
    return str(_load_cfg().get("lastParent") or "")


def _msg(text):
    """弹一条消息框；无头测试（AM_NO_DIALOG=1）时只写日志，不阻塞"""
    try:
        if _dialogs_enabled():
            unreal.EditorDialog.show_message("AssetManager", str(text), unreal.AppMsgType.OK)
    except Exception as e:
        log("弹窗失败：%s" % e)


def _selected_parent_material():
    """内容浏览器里当前选中的材质（当父材质用）；UE 没给 Python 资产选择器，只能这么选"""
    try:
        for o in unreal.EditorUtilityLibrary.get_selected_assets() or []:
            if isinstance(o, unreal.MaterialInterface):
                return o
    except Exception:
        pass
    return None


def _ask_material_mode(spec_name, parent_from_payload=""):
    """决定材质怎么建：独立材质 / 基于父材质建实例。返回 (mode, parent_path)

    **关键：不能在弹窗开着的时候让用户在内容浏览器里选东西**（模态框会挡住点击），
    所以这里是「先读选中项 → 再弹窗」，弹窗里只做 是/否/取消 三选一。
    mode = 'material' / 'instance' / None（用户取消）
    """
    if parent_from_payload:
        return "instance", parent_from_payload
    if not _dialogs_enabled():
        return "material", ""

    sel = _selected_parent_material()
    sel_path = _pkg(sel) if sel else ""
    last = _last_parent()

    try:
        if sel_path:
            r = unreal.EditorDialog.show_message(
                "AssetManager · 材质",
                "收到材质「%s」。\n\n要把父材质设成内容浏览器里选中的这个吗？\n%s\n\n"
                "是 = 基于它创建「材质实例」\n否 = 直接生成独立材质\n取消 = 跳过这次" % (spec_name, sel_path),
                unreal.AppMsgType.YES_NO_CANCEL)
            if "CANCEL" in str(r):
                return None, ""
            if "YES" in str(r):
                _remember_parent(sel_path)
                return "instance", sel_path
            return "material", ""

        if last:
            r = unreal.EditorDialog.show_message(
                "AssetManager · 材质",
                "收到材质「%s」。\n\n内容浏览器现在没有选中材质，\
上次用的父材质是：\n%s\n\n"
                "是 = 继续用它创建「材质实例」\n否 = 直接生成独立材质\n取消 = 跳过这次" % (spec_name, last),
                unreal.AppMsgType.YES_NO_CANCEL)
            if "CANCEL" in str(r):
                return None, ""
            if "YES" in str(r):
                return "instance", last
            return "material", ""

        # 既没选中、也没有历史：只给两个选择，不做「让你去选」
        r = unreal.EditorDialog.show_message(
            "AssetManager · 材质",
            "收到材质「%s」。\n\n当前没有可用的父材质。\n\n"
            "想用父材质的话：先在内容浏览器里选中它（先选好，再从这里点确定），\n"
            "或者之后用菜单「工具 → AssetManager → 用选中的材质重建最近材质」。\n\n"
            "确定 = 先按独立材质导入\n取消 = 跳过这次" % spec_name,
            unreal.AppMsgType.OK_CANCEL)
        if "CANCEL" in str(r):
            return None, ""
        return "material", ""
    except Exception as e:
        log("弹窗失败（按独立材质处理）：%s" % e)
        return "material", ""


def rebuild_with_selected_parent():
    """菜单用：拿内容浏览器选中的材质当父材质，把最近一次的材质任务重建成材质实例

    这条路完全非模态：先在内容浏览器选中，再点菜单。
    """
    par = _selected_parent_material()
    if not par:
        _msg("请先在内容浏览器里选中一个材质 / 材质实例，再点这个菜单。")
        return
    spec = dict(_last_material_spec or {})
    if not spec.get("maps"):
        _msg("还没有可重建的材质任务——先从 AssetManager 发一次材质过来。")
        return
    parent_path = _pkg(par)
    try:
        mi, done, missing, info = build_material_instance(
            spec, parent_path, name=spec.get("assetName") or spec.get("name"))
        _remember_parent(parent_path)
        msg = "已用父材质 %s 重建为材质实例 %s\n\n导入 %d 张贴图，写入 %d 个参数：%s" % (
            parent_path, mi.get_name(), info["imported"], len(done), "、".join(done) or "无")
        if missing:
            msg += "\n未写入：%s" % "、".join(str(x) for x in missing)
        if not done:
            msg += "\n父材质的贴图参数：%s（需要命名为 BaseColor/Normal/Roughness/Metallic/AO/Emissive/Opacity/Height）" % (
                "、".join(info["params"]) or "无")
        _msg(msg)
        log(msg.replace("\n", " "))
    except Exception as e:
        log_err("按父材质重建失败：%s" % e)
        _msg("重建失败：%s" % e)


def _write_material_report(dest, mat_name, info):
    """把「哪些贴图写到了哪些参数、父材质还剩哪些参数没对上」写成文本放到素材目录

    用户遇到材质实例里没贴图时，看这个文件就知道该怎么改父材质。
    """
    lines = [
        "# AssetManager · 材质实例报告",
        "插件版本: %s" % AM_PLUGIN_VERSION,
        "父材质: %s" % info.get("parent", ""),
        "导入贴图: %d 张" % info.get("imported", 0),
        "",
        "已写入参数（实例覆盖）: %s" % ("、".join(info.get("done") or []) or "无"),
        "未写入: %s" % ("、".join(str(x) for x in (info.get("missing") or [])) or "无"),
        "父材质里默认贴图为空的参数（会导致编译器报 Found NULL）: %s"
        % ("、".join(info.get("null_defaults") or []) or "无"),
        "",
        "父材质的贴图参数: %s" % ("、".join(info.get("params") or []) or "无"),
        "",
        "## 如果实例里还是没贴图",
        "1. 父材质里的贴图节点必须是 TextureSampleParameter2D（不是普通 TextureSample，也不是材质函数里的）。",
        "2. 参数名建议含这些关键词，插件会自动对上：",
        "   BaseColor/Albedo/Diffuse、Normal/Nrm、Roughness/Rough、Metallic/Metal、",
        "   AO/Occlusion、Emissive/Emit、Opacity/Alpha、Height/Displacement/Bump",
        "3. 也可以在父材质里给参数的默认贴图赋值——插件只补 NULL 的默认值。",
        "",
    ]
    try:
        p = "%s/am_material_report.txt" % dest
        base = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_content_dir())
        full = os.path.join(base, dest.replace("/Game/", "").replace("/", os.sep), "am_material_report.txt")
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        log("材质报告：%s" % full)
    except Exception as e:
        log("写材质报告失败：%s" % e)


def build_material_instance(spec, parent_path, name=None):
    """基于父材质建材质实例

    - **贴图一律先导入**（`<素材名>/Textures/`），即便父材质没有对应参数，
      用户也能在项目里看到贴图、自己连。
    - 参数名先做归一化精确匹配，再按关键词包含匹配（父材质常写成 BaseColorTex / T_Rough / Nrm …）。
    - 一个参数都对不上时，消息里会写清楚"父材质有哪些参数"，不至于只剩个空球。
    """
    mat_name = _safe_name(name or spec.get("name") or "AM_Instance")
    dest = _dest_for(spec.get("assetName") or mat_name)
    parent = _load(parent_path)
    if not isinstance(parent, unreal.MaterialInterface):
        raise RuntimeError("父材质无效：%s" % parent_path)

    asset_path = "%s/MI_%s" % (dest, mat_name)
    mi = _load(asset_path) if unreal.EditorAssetLibrary.does_asset_exist(asset_path) else None
    if not (mi and _is_ours(mi)):
        _ensure_dir(dest)
        mi = _create_asset_safe("MI_" + mat_name, dest, unreal.MaterialInstanceConstant,
                                unreal.MaterialInstanceConstantFactoryNew())
    if not mi:
        raise RuntimeError("创建材质实例失败：%s" % asset_path)
    _mark(mi)
    _mel().set_material_instance_parent(mi, parent)

    params = _parent_param_names(parent)
    tex_dir = "%s/Textures" % dest

    imported, done, missing = 0, [], []
    for slot, entry in (spec.get("maps") or {}).items():
        if not entry or not entry.get("path"):
            continue
        # 先导入贴图（无论参数能否匹配）
        tex = import_texture(entry["path"], tex_dir, name="T_%s_%s" % (mat_name, slot),
                             kind=_SLOT_KIND.get(slot, "color"))
        if not tex:
            missing.append("%s(贴图导入失败)" % slot)
            continue
        imported += 1
        real = _pick_param(slot, params)
        if not real:
            missing.append("%s(父材质无对应参数)" % slot)
            continue
        try:
            _mel().set_material_instance_texture_parameter_value(mi, real, tex)
            done.append("%s→%s" % (slot, real))
        except Exception as e:
            missing.append("%s(%s)" % (slot, e))
            continue

    # 父材质里默认贴图是空（引擎的 DefaultTexture）的参数：
    # UE 5.7 的 Python 没有 set_material_default_texture_parameter_value，也没有遍历表达式节点的 API，
    # 所以修不了——但这些参数会让**父材质编译失败**（"TextureSampleParameter2D Found NULL"），
    # 连带材质实例也显示不出来。这里检测出来，明确告诉用户去父材质里补默认贴图。
    null_defaults = []
    root = _root_material(parent)
    for p in params:
        try:
            cur = _mel().get_material_default_texture_parameter_value(root, p)
        except Exception:
            continue
        nm = str(cur.get_name()).lower() if cur else ""
        if (not cur) or ("defaulttexture" in nm) or nm in ("none", ""):
            null_defaults.append(p)

    try:
        _mel().update_material_instance(mi)
    except Exception:
        pass
    _save(mi)

    info = {
        "parent": parent_path,
        "imported": imported,
        "params": params,
        "done": done,
        "missing": missing,
        "null_defaults": null_defaults,
    }
    _write_material_report(dest, mat_name, info)
    return mi, done, missing, info


# ----------------------------------------------------------------- 模型导入

_MESH_EXT = {".fbx", ".obj", ".glb", ".gltf", ".usd", ".usdz", ".abc", ".stl", ".ply"}


def _import_options(payload):
    """导入类型选项：默认只导入静态网格体、且**不往视口放演员**（与软件里的弹窗一致）"""
    o = payload.get("importOptions") or {}
    return (bool(o.get("staticMesh", True)),
            bool(o.get("skeletalMesh", False)),
            bool(o.get("physicsAsset", False)),
            bool(o.get("placeInViewport", False)))


def _asset_pkg(obj):
    """对象 → 资产包路径（去掉 .ObjectName 后缀）"""
    try:
        return str(obj.get_path_name()).split(".")[0]
    except Exception:
        return ""


def _delete_asset(obj):
    try:
        p = _asset_pkg(obj)
        return bool(p) and bool(unreal.EditorAssetLibrary.delete_asset(p))
    except Exception as e:
        log("删资产失败（%s）：%s" % (getattr(obj, "get_name", lambda: "?")() if obj else "?", e))
        return False


def _ensure_physics(skel):
    """给骨骼网格体补一个物理资产（Interchange 没生成时用编辑器子系统建）"""
    try:
        pa = skel.get_editor_property("physics_asset")
    except Exception:
        pa = None
    if pa:
        return pa
    try:
        sub = unreal.get_editor_subsystem(unreal.SkeletalMeshEditorSubsystem)
        pa = sub.create_physics_asset(skel, True, 0)
        if pa:
            _save(skel)
            _save(pa)
        return pa
    except Exception as e:
        log("物理资产创建失败（%s）：%s" % (getattr(skel, "get_name", lambda: "?")() if skel else "?", e))
        return None


def _make_movable(actor):
    """演员/组件改成 Movable。

    不这样的话新生成的 StaticMeshActor 是 Static mobility：关卡的静态灯光没烘焙过它，
    于是"看着像阴影烘在贴图上、怎么动灯都不受影响"。Movable 立刻吃动态光照。
    """
    try:
        for comp in actor.get_components_by_class(unreal.PrimitiveComponent) or []:
            comp.set_mobility(unreal.ComponentMobility.MOVABLE)
    except Exception:
        pass
    try:
        comp = actor.get_component_by_class(unreal.StaticMeshComponent)
        if comp:
            comp.set_mobility(unreal.ComponentMobility.MOVABLE)
    except Exception:
        pass
    try:
        comp = actor.get_component_by_class(unreal.SkeletalMeshComponent)
        if comp:
            comp.set_mobility(unreal.ComponentMobility.MOVABLE)
    except Exception:
        pass


def import_model(payload):
    """导入模型并放到视口；返回 (消息, 资产路径列表)

    - 不指定 factory：UE 5.x 用 Interchange 管线自动挑导入器（FBX / GLB / OBJ 都走它）。
      FbxImportUI 在 5.x 里不是 UFactory，赋给 task.factory 会报 nativize 错误。
    - importOptions：{ staticMesh, skeletalMesh, physicsAsset }（默认只静态网格体）。
      Interchange 会把 FBX 里有的东西都导进来，所以不要的类型我们导完再删（只删本素材目录里的）。
    """
    path = payload.get("modelPath") or ""
    if not path or not os.path.exists(path):
        raise RuntimeError("模型文件不存在：%s" % path)
    ext = os.path.splitext(path)[1].lower()
    if ext not in _MESH_EXT:
        raise RuntimeError("UE 读不了 %s（支持 %s）" % (ext, " / ".join(sorted(_MESH_EXT))))

    name = _safe_name(payload.get("name") or os.path.splitext(os.path.basename(path))[0])
    dest = _dest_for(name)
    _ensure_dir(dest)
    want_static, want_skeletal, want_physics, want_place = _import_options(payload)

    task = unreal.AssetImportTask()
    task.filename = path
    task.destination_path = dest
    task.destination_name = name
    task.automated = True
    task.replace_existing = True
    task.save = True

    _asset_tools().import_asset_tasks([task])
    imported = [str(p) for p in list(task.imported_object_paths or [])]
    if not imported:
        raise RuntimeError("导入没有产出资产（%s）：UE 可能不支持该文件，或 FBX 是 ASCII 格式" % ext)

    # 按资产类型判断（资产路径里不含类名，只能载入后看）
    statics, skels, physics = [], [], []
    for p in imported:
        obj = _load(p)
        if isinstance(obj, unreal.StaticMesh):
            statics.append(obj)
        elif isinstance(obj, unreal.SkeletalMesh):
            skels.append(obj)
        elif isinstance(obj, unreal.PhysicsAsset):
            physics.append(obj)

    notes = []
    # 骨骼网格体：要就补物理资产，不要就删掉（连它带的物理资产一起）
    if skels and want_physics:
        made = 0
        for sk in skels:
            if _ensure_physics(sk):
                made += 1
        notes.append("物理资产 %d 个" % made)
    if skels and not want_skeletal:
        for sk in skels:
            _delete_asset(sk)
        skels = []
        notes.append("未勾选骨骼网格体，已丢弃")
    if physics and not want_physics:
        for pa in physics:
            _delete_asset(pa)
        physics = []
    if statics and not want_static:
        for sm in statics:
            _delete_asset(sm)
        statics = []
        notes.append("未勾选静态网格体，已丢弃")

    # 放到视口（默认不放；勾了才放，且复用同名演员，重复导入不会堆一堆）
    placed = ""
    if want_place and (statics or skels):
        loc = _viewport_location()
        sub = _actor_subsystem()
        try:
            actor = _find_actor("AM_" + name)
            if statics:
                if not actor:
                    actor = sub.spawn_actor_from_object(statics[0], loc)
                comp = actor.get_component_by_class(unreal.StaticMeshComponent)
                if comp:
                    comp.set_static_mesh(statics[0])
                placed = "StaticMesh"
            else:
                if not actor:
                    actor = sub.spawn_actor_from_class(unreal.SkeletalMeshActor, loc)
                comp = actor.get_component_by_class(unreal.SkeletalMeshComponent)
                if comp:
                    comp.set_skeletal_mesh(skels[0])
                placed = "SkeletalMesh"
            if actor:
                actor.set_actor_label("AM_" + name)
                _make_movable(actor)
        except Exception as e:
            placed = ""
            log("已导入但没能放到视口：%s" % e)

    msg = "已导入 %s → %s（%d 个资产，%d 静态网格体 / %d 骨骼网格体%s）" % (
        os.path.basename(path), dest, len(imported), len(statics), len(skels),
        "，已放到视口" if placed else "")
    if not statics and not skels:
        msg += "：没有网格（可能是贴图 / 材质文件，或所选的类型都被丢弃了）"
    if notes:
        msg += "；" + "，".join(notes)

    # 素材带贴图时，顺手把软件里的材质套到网格上（模型自带材质常常缺图 / 命名冲突）
    spec = payload.get("material") or {}
    if (statics or skels) and (spec.get("maps") or {}):
        try:
            spec = dict(spec)
            spec.setdefault("assetName", name)
            spec["assetName"] = name
            mat, applied, _sk = build_material(spec, name=name)
            for mesh in (statics[:1] + skels[:1]):
                try:
                    slots = mesh.get_num_sections(0) if isinstance(mesh, unreal.SkeletalMesh) else None
                    count = len(mesh.get_editor_property("static_materials")) if isinstance(mesh, unreal.StaticMesh) else (slots or 1)
                    for i in range(max(1, count)):
                        mesh.set_material(i, mat)
                except Exception:
                    try:
                        mesh.set_material(0, mat)
                    except Exception:
                        pass
            _save(mat)
            msg += "；已套用材质 %s（%s）" % (mat.get_name(), "、".join(applied) or "无通道")
        except Exception as e:
            msg += "；材质套用失败：%s" % e
    return msg, imported


# ----------------------------------------------------------------- 天空 / HDRI

SKY_MATERIAL = ROOT_FOLDER + "/_Environment/M_AM_SkyEquirect"
SKY_ACTOR_LABEL = "AM_SkySphere"
SKYLIGHT_LABEL = "AM_SkyLight"

_SKY_CODE = """
// UE 贴图的 v=0 在图片顶部（跟 OpenGL 相反），等距柱状图顶行是天空，
// 所以仰角越大 v 越接近 0 —— 这里写反了 HDRI 就会上下颠倒。
float3 d = normalize(WorldPos - CamPos);
float u = atan2(d.y, d.x) / 6.28318530718 + 0.5;
float v = acos(clamp(d.z, -1.0, 1.0)) / 3.14159265359;
return float2(u, v);
"""


def ensure_sky_material():
    """可复用的天空球材质：Equirect 贴图参数 + 强度参数，Unlit 双面

    插件版本变了就重建：材质的节点代码随版本改（例如 0.1.3 修了 HDRI 上下颠倒），
    复用旧资产会让修正不生效。
    """
    if unreal.EditorAssetLibrary.does_asset_exist(SKY_MATERIAL):
        m = _load(SKY_MATERIAL)
        if m and _is_ours(m):
            if _our_version(m) == AM_PLUGIN_VERSION:
                return m
            log("天空材质是旧版本建的，重建（%s → %s）" % (_our_version(m) or "?", AM_PLUGIN_VERSION))
            try:
                unreal.EditorAssetLibrary.delete_asset(SKY_MATERIAL)
            except Exception:
                pass
    _ensure_dir(ROOT_FOLDER + "/_Environment")
    mat = _create_asset_safe("M_AM_SkyEquirect", ROOT_FOLDER + "/_Environment", unreal.Material,
                            unreal.MaterialFactoryNew())
    if not mat:
        raise RuntimeError("创建天空材质失败")
    _mark(mat)
    _mel().delete_all_material_expressions(mat)
    try:
        mat.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
        mat.set_editor_property("two_sided", True)
    except Exception:
        pass

    # 贴图参数
    tex = _mat_exp(mat, unreal.MaterialExpressionTextureSampleParameter2D, -600, 0)
    tex.set_editor_property("parameter_name", "Equirect")
    try:
        tex.set_editor_property("sampler_type", unreal.MaterialSamplerType.SAMPLERTYPE_COLOR)
    except Exception:
        pass
    # 方向 → 等距柱状 UV
    custom = _mat_exp(mat, unreal.MaterialExpressionCustom, -900, 100)
    custom.set_editor_property("description", "AM_EquirectUV")
    custom.set_editor_property("code", _SKY_CODE)
    custom.set_editor_property("output_type", unreal.CustomMaterialOutputType.CMOT_FLOAT2)
    custom.set_editor_property("inputs", _custom_inputs(["WorldPos", "CamPos"]))
    wp = _mat_exp(mat, unreal.MaterialExpressionWorldPosition, -1200, 60)
    cp = _mat_exp(mat, unreal.MaterialExpressionCameraPositionWS, -1200, 180)
    _mel().connect_material_expressions(wp, "", custom, "WorldPos")
    _mel().connect_material_expressions(cp, "", custom, "CamPos")
    _mel().connect_material_expressions(custom, "", tex, "UVs")

    inten = _mat_exp(mat, unreal.MaterialExpressionScalarParameter, -600, 200)
    inten.set_editor_property("parameter_name", "Intensity")
    inten.set_editor_property("default_value", 1.0)
    mul = _mat_exp(mat, unreal.MaterialExpressionMultiply, -300, 60)
    _mel().connect_material_expressions(tex, "RGB", mul, "A")
    _mel().connect_material_expressions(inten, "", mul, "B")
    _mel().connect_material_property(mul, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    try:
        _mel().layout_material_expressions(mat)
        _mel().recompile_material(mat)
    except Exception:
        pass
    _save(mat)
    return mat


def _ensure_sky_actor(mid):
    """复用或新建天空球（半径 10000cm 的球，材质双面朝内）"""
    actor = _find_actor(SKY_ACTOR_LABEL)
    sphere = _load("/Engine/BasicShapes/Sphere.Sphere")
    if not sphere:
        raise RuntimeError("引擎基础球体缺失（/Engine/BasicShapes/Sphere）")
    sub = _actor_subsystem()
    if not actor:
        actor = sub.spawn_actor_from_object(sphere, unreal.Vector(0, 0, 0))
        actor.set_actor_label(SKY_ACTOR_LABEL)
    comp = actor.get_component_by_class(unreal.StaticMeshComponent)
    comp.set_mobility(unreal.ComponentMobility.MOVABLE)   # 不然静态灯光没烘焙过它
    comp.set_static_mesh(sphere)
    comp.set_material(0, mid)
    comp.set_editor_property("cast_shadow", False)
    comp.set_editor_property("cast_inset_shadow", False)
    try:
        comp.set_editor_property("ld_max_draw_distance", 0.0)   # 0 = 不限制
    except Exception:
        pass
    # 球体默认直径 100cm → 放大到半径约 10000cm
    actor.set_actor_scale3d(unreal.Vector(200.0, 200.0, 200.0))
    return actor


def _ensure_skylight():
    actor = _find_actor(SKYLIGHT_LABEL)
    if actor:
        return actor
    sub = _actor_subsystem()
    actor = sub.spawn_actor_from_class(unreal.SkyLight, unreal.Vector(0, 0, 2000))
    actor.set_actor_label(SKYLIGHT_LABEL)
    try:
        comp = actor.get_component_by_class(unreal.SkyLightComponent)
        comp.set_editor_property("source_type", unreal.SkyLightSourceType.SLS_CAPTURED_SCENE)
        comp.set_editor_property("mobility", unreal.ComponentMobility.MOVABLE)
        comp.set_editor_property("real_time_capture", True)
    except Exception:
        pass
    return actor


def apply_hdri(payload):
    """HDRI：导入 .hdr/.exr → 建 MID → 天空球 + SkyLight 实时捕捉"""
    files = payload.get("files") or []
    path = ""
    for f in files:
        if str(f).lower().endswith((".hdr", ".exr")):
            path = str(f)
            break
    if not path or not os.path.exists(path):
        raise RuntimeError("HDRI 文件不存在（只支持 .hdr / .exr）")

    name = _safe_name(payload.get("name") or os.path.splitext(os.path.basename(path))[0])
    env_dir = _dest_for(name, "Env")
    tex = import_texture(path, env_dir, name="T_" + name, kind="hdr")
    if not tex:
        raise RuntimeError("HDRI 导入失败：%s" % os.path.basename(path))

    base = ensure_sky_material()
    mid_path = "%s/MI_%s" % (env_dir, name)
    mid = _load(mid_path) if unreal.EditorAssetLibrary.does_asset_exist(mid_path) else None
    if not mid:
        mid = _create_asset_safe("MI_" + name, env_dir, unreal.MaterialInstanceConstant,
                                unreal.MaterialInstanceConstantFactoryNew())
    if not mid:
        raise RuntimeError("创建材质实例失败")
    _mark(mid)
    try:
        _mel().set_material_instance_parent(mid, base)
        _mel().set_material_instance_texture_parameter_value(mid, "Equirect", tex)
        _mel().set_material_instance_scalar_parameter_value(mid, "Intensity", 1.0)
        _mel().update_material_instance(mid)
    except Exception as e:
        raise RuntimeError("设置天空材质实例失败：%s" % e)
    _save(mid)

    hdri_apply = payload.get("hdriApply") or {}
    want_env = hdri_apply.get("env", True) is not False
    did = []
    if want_env:
        _ensure_sky_actor(mid)
        did.append("天空球")
        sky = _ensure_skylight()
        try:
            comp = sky.get_component_by_class(unreal.SkyLightComponent)
            comp.recapture_sky()
            did.append("SkyLight 反射")
        except Exception:
            pass
    if hdri_apply.get("viewport", True) is not False:
        try:
            les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
            les.editor_invalidate_viewports()
        except Exception:
            pass

    return "已应用 HDRI %s → %s（%s）" % (
        os.path.basename(path), env_dir, "、".join(did) or "仅导入贴图")


# ----------------------------------------------------------------- IES

def apply_ies(payload):
    """IES：导入 TextureLightProfile → 生成一盏带配光曲线的 SpotLight"""
    files = payload.get("files") or []
    path = ""
    for f in files:
        if str(f).lower().endswith((".ies", ".ldt")):
            path = str(f)
            break
    if not path:
        raise RuntimeError("任务里没有 .ies 文件")
    if not path.lower().endswith(".ies"):
        raise RuntimeError("UE 只认 .ies（%s 需要先在软件里转换）" % os.path.splitext(path)[1])

    name = _safe_name(payload.get("name") or os.path.splitext(os.path.basename(path))[0])
    dest = _dest_for(name, "IES")
    _ensure_dir(dest)

    asset_path = "%s/%s" % (dest, name)
    profile = _load(asset_path) if unreal.EditorAssetLibrary.does_asset_exist(asset_path) else None
    if not profile:
        task = unreal.AssetImportTask()
        task.filename = path
        task.destination_path = dest
        task.destination_name = name
        task.automated = True
        task.replace_existing = True
        task.save = True
        _asset_tools().import_asset_tasks([task])
        for p in list(task.imported_object_paths or []):
            obj = _load(str(p))
            if isinstance(obj, unreal.TextureLightProfile):
                profile = obj
                break
        if not profile:
            profile = _load(asset_path)
    if not profile:
        raise RuntimeError("IES 导入失败：%s" % os.path.basename(path))
    _mark(profile)
    _save(profile)

    sub = _actor_subsystem()
    if not sub:
        return "已导入配光文件 %s（无法放置灯光：编辑器子系统不可用）" % os.path.basename(path)

    label = "AM_IES_" + name
    actor = _find_actor(label)
    if not actor:
        loc = _viewport_location()
        actor = sub.spawn_actor_from_class(unreal.SpotLight,
                                           unreal.Vector(loc.x, loc.y, loc.z + 300.0))
        actor.set_actor_label(label)
    comp = actor.get_component_by_class(unreal.SpotLightComponent)
    comp.set_editor_property("ies_texture", profile)
    comp.set_editor_property("intensity", 5000.0)
    try:
        comp.set_editor_property("attenuation_radius", 2000.0)
    except Exception:
        pass
    return "已导入 IES %s → %s，并生成灯光 %s" % (os.path.basename(path), dest, label)


# ----------------------------------------------------------------- 任务分发

def _execute(job):
    mode = str(job.get("mode") or "")
    payload = job.get("payload") or {}
    if mode == "import":
        return import_model(payload)
    if mode == "material":
        spec = dict(payload)
        global _last_material_spec
        _last_material_spec = dict(spec)     # 供菜单「用选中的材质重建最近材质」
        spec.setdefault("name", payload.get("name") or "Material")
        target = payload.get("assetName") or spec.get("name")
        parent = str(payload.get("parentMaterial") or "").strip()
        choice = "instance" if parent else "material"
        # 兼容：显式要求问的时候才弹（默认不问）
        if not parent and ASK_MATERIAL_MODE:
            choice2, parent = _ask_material_mode(str(spec.get("name")), "")
            if choice2 is None:
                return "已取消（在 UE 里选择了跳过这次）", None
            choice = choice2
        if choice == "instance":
            mi, done, missing, info = build_material_instance(spec, parent, name=target)
            msg = "已基于父材质创建实例 %s（父：%s；导入 %d 张贴图，写入 %d 个参数：%s" % (
                mi.get_name(), parent, info["imported"], len(done), "、".join(done) or "无")
            msg += "）"
            if info.get("null_defaults"):
                msg += "。⚠ 父材质里这些贴图参数没有默认贴图：%s —— 引擎会报 " \
                       "\"TextureSampleParameter2D Found NULL\" 并让材质编译失败，实例也就显不出来；" \
                       "请在父材质里给它们指定默认贴图（插件没法改父材质）" % (
                           "、".join(info["null_defaults"]))
            if missing:
                msg += "；未写入 %s" % "、".join(str(x) for x in missing)
            if not done:
                msg += "（父材质的贴图参数是 %s；请在父材质里用 TextureSampleParameter2D 命名成 " \
                       "BaseColor/Normal/Roughness/Metallic/AO/Emissive/Opacity/Height 之一）" % (
                           "、".join(info["params"]) or "无")
            return msg, None
        mat, applied, skipped = build_material(spec, name=target)
        msg = "已创建材质 %s（%d 个通道：%s）" % (
            mat.get_name(), len(applied), "、".join(applied) or "无")
        if skipped:
            msg += "；跳过 %s" % "、".join(str(s) for s in skipped)
        msg += "（想要材质实例：在 AM 端发送时填父材质路径，或内容浏览器选中父材质后点 工具 → AssetManager → 用选中的材质重建最近材质）"
        _last_material_spec.clear()
        _last_material_spec.update(spec)
        return msg, None
    if mode == "texture":
        files = payload.get("files") or []
        dest = _dest_for(payload.get("name") or "Textures", "Textures")
        ok = 0
        for f in files:
            if import_texture(str(f), dest, kind="color"):
                ok += 1
        if not ok:
            raise RuntimeError("没有一张贴图导入成功（TIFF 等格式 UE 读不了）")
        return "已导入 %d/%d 张贴图 → %s" % (ok, len(files), dest), None
    if mode == "hdri":
        return apply_hdri(payload), None
    if mode == "ies":
        return apply_ies(payload), None
    raise RuntimeError("不支持的任务类型：%s" % (mode or "(空)"))


def run_job(job):
    """在主线程执行一个任务并回传结果"""
    jid = job.get("id")
    title = job.get("title") or ""
    _state["job"] = title
    t0 = time.time()
    ok, message, detail = False, "", None
    try:
        r = _execute(job)
        if isinstance(r, tuple):
            message, detail = r[0], r[1]
        else:
            message = str(r)
        ok = True
    except Exception as e:
        message = "%s" % e
        log_err("任务失败（%s）：%s" % (title, e))
        unreal.log_error(traceback.format_exc())
    dt = time.time() - t0
    if ok:
        log("%s（%.1fs）" % (message, dt))
    try:
        _req(_state["port"], "/api/bridge/ue/result",
             {"id": jid, "ok": ok, "message": message, "detail": detail}, timeout=6)
    except Exception as e:
        log_err("回传结果失败：%s" % e)
    _state["job"] = ""
    _state["last"] = message
    return ok, message


def pump_once():
    """把队列里的任务全部执行掉（tick 回调与测试脚本都走这里）"""
    n = 0
    while True:
        try:
            job = _jobs.get_nowait()
        except queue.Empty:
            break
        run_job(job)
        n += 1
    return n


# ----------------------------------------------------------------- 后台轮询

def _heartbeat():
    """后台线程调用：只用导入时缓存好的值，绝不碰 unreal.*（跨线程会抛异常）"""
    now = time.time()
    if now - _state["heartbeat_at"] < HEARTBEAT_INTERVAL:
        return
    _state["heartbeat_at"] = now
    info = {"engine": _UE_VERSION, "series": AM_SERIES, "project": _PROJECT_FILE}
    try:
        _req(_state["port"], "/api/bridge/ue/heartbeat",
             {"version": AM_PLUGIN_VERSION, "host": socket.gethostname(), "info": info})
        _state["connected"] = True
        _state["error"] = ""
    except Exception as e:
        _state["connected"] = False
        _state["error"] = str(e)


def _worker():
    """后台线程：只做 HTTP，任务塞进队列等主线程执行"""
    while not _state["stop"]:
        try:
            if not _state["connected"]:
                p = _detect_port()
                if p:
                    _state["port"] = p
                    _state["connected"] = True
                    _state["error"] = ""
                    log("已连接 AssetManager（端口 %d）" % p)
                else:
                    time.sleep(1.5)
                    continue
            _follow_locator()
            _heartbeat()
            job = _req(_state["port"], "/api/bridge/ue/next", timeout=6)
            if job and job.get("id"):
                _jobs.put(job)
        except Exception as e:
            _state["connected"] = False
            _state["error"] = str(e)
        time.sleep(POLL_INTERVAL)


def _tick(_delta_seconds=0.0):
    """主线程回调：执行排队任务 + 刷新菜单状态"""
    try:
        pump_once()
    except Exception:
        unreal.log_error(traceback.format_exc())
    try:
        _refresh_menu()
    except Exception:
        pass


# ----------------------------------------------------------------- 菜单 / 入口

def status_text():
    if _state["connected"]:
        return "AssetManager：已连接（端口 %d，插件 %s）" % (_state["port"], AM_PLUGIN_VERSION)
    return "AssetManager：未连接（%s）" % (_state["error"] or "等待软件启动")


def show_status():
    lines = [status_text(), "", "引擎：" + _UE_VERSION,
             "工程：" + (_PROJECT_FILE or "（未知）")]
    if _state["last"]:
        lines.append("最近：" + _state["last"])
    if _events:
        lines.append("")
        lines.append("事件：")
        for e in _events[-6:]:
            lines.append("  %s %s" % (e["at"], e["text"]))
    unreal.EditorDialog.show_message("AssetManager 桥接", "\n".join(lines),
                                     unreal.AppMsgType.OK)


def reconnect():
    _state["connected"] = False
    p = _detect_port()
    if p:
        _state["port"] = p
        _state["connected"] = True
        log("手动重连成功（端口 %d）" % p)
    else:
        log_err("重连失败：没找到 AssetManager（软件启动了吗？）")
    show_status()


def disconnect():
    _state["connected"] = False
    log("已断开")


def open_app_page():
    p = _state["port"]
    try:
        import webbrowser
        webbrowser.open("http://127.0.0.1:%d" % p)
    except Exception as e:
        log_err("打开页面失败：%s" % e)


def _menu_entry(name, label, command):
    e = unreal.ToolMenuEntry(name=name, type=unreal.MultiBlockType.MENU_ENTRY)
    e.set_label(label)
    e.set_string_command(unreal.ToolMenuStringCommandType.PYTHON, "", command)
    return e


def _build_menu():
    global _menus_built
    if _menus_built:
        return
    try:
        menus = unreal.ToolMenus.get()
        main = menus.find_menu("LevelEditor.MainMenu.Tools")
        if not main:
            return
        sub = main.add_sub_menu("AssetManager", "AssetManager", "AssetManager", "AssetManager")
        sub.add_menu_entry("Status", _menu_entry("AM_Status", "状态…",
                                                "import assetmanager_ue as am; am.show_status()"))
        sub.add_menu_entry("Reconnect", _menu_entry("AM_Reconnect", "重连",
                                                    "import assetmanager_ue as am; am.reconnect()"))
        sub.add_menu_entry("Disconnect", _menu_entry("AM_Disconnect", "断开",
                                                     "import assetmanager_ue as am; am.disconnect()"))
        sub.add_menu_entry("Open", _menu_entry("AM_Open", "打开 AssetManager 页面",
                                               "import assetmanager_ue as am; am.open_app_page()"))
        sub.add_menu_entry("RebuildMat", _menu_entry(
            "AM_RebuildMat", "用选中的材质重建最近材质（建实例）",
            "import assetmanager_ue as am; am.rebuild_with_selected_parent()"))
        menus.refresh_all_widgets()
        _menus_built = True
    except Exception as e:
        unreal.log_warning("[AssetManager] 菜单创建失败：%s" % e)


def _refresh_menu():
    # 菜单标题带上连接状态，一眼能看出通没通
    if not _menus_built:
        _build_menu()
        return
    try:
        menus = unreal.ToolMenus.get()
        main = menus.find_menu("LevelEditor.MainMenu.Tools")
        sub = main.find_sub_menu("AssetManager") if main else None
        if sub:
            sub.set_label("AssetManager（%s）" % ("已连接" if _state["connected"] else "未连接"))
            menus.refresh_all_widgets()
    except Exception:
        pass


def _ensure_tick():
    global _tick_handle
    if _tick_handle is not None:
        return
    try:
        _tick_handle = unreal.register_slate_post_tick_callback(_tick)
    except Exception as e:
        unreal.log_warning("[AssetManager] tick 回调注册失败：%s" % e)


def start(port=None):
    if port:
        _state["port"] = int(port)
    _state["stop"] = False
    if _state["thread"] and _state["thread"].is_alive():
        return
    th = threading.Thread(target=_worker, name="AssetManagerBridge", daemon=True)
    _state["thread"] = th
    th.start()
    log("桥接已启动（插件 %s，系列 %s）" % (AM_PLUGIN_VERSION, AM_SERIES))


def stop():
    _state["stop"] = True
    _state["connected"] = False
    _state["thread"] = None


def auto_start():
    """init_unreal.py 调用：起轮询 + 注册主线程回调 + 建菜单"""
    start()
    _ensure_tick()
    _build_menu()
    log("AssetManager 桥接就绪（%s）" % AM_PLUGIN_VERSION)








