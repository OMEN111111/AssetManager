# -*- coding: utf-8 -*-
"""AssetManager · Blender 桥接插件 · 5.2 系列（Blender 5.2 LTS+）

协议与 3ds Max 插件相同：轮询 http://127.0.0.1:<port>/api/bridge/blender/next，
在主线程执行导入 / 材质 / 贴图任务，回传 /api/bridge/blender/result，
每 5 秒 POST /api/bridge/blender/heartbeat 上报版本。

版本规则（见 app/bridge/blender/README.md）
  插件版本与软件版本解耦：第一版 0.1.0，之后只递增第三位（0.1.1、0.1.2…）；
  各 Blender 系列目录共用同一个插件版本号，改一次递增一次。

安装：Blender → 编辑 → 偏好设置 → 获取扩展 / 插件 → 从磁盘安装，选择本文件，勾选
「AssetManager Bridge」。3D 视图按 N → 侧栏 AssetManager 标签即可连接。
"""

bl_info = {
    "name": "AssetManager Bridge",
    "author": "AssetManager",
    "version": (0, 1, 4),
    "blender": (5, 2, 0),
    "location": "View3D > Sidebar > AssetManager",
    "description": "接收 AssetManager 的模型导入、材质重建与贴图（Blender 5.2+，已在 5.2.0 LTS 实测）",
    "category": "Import-Export",
}

BL_VERSION = "0.1.5"
BL_SERIES = "5.2"

# >>> AM_BODY >>> 下面所有 Blender 系列共用；改完用 tools/sync-blender-bridge.mjs 同步到其他系列

import bpy
import os
import json
import time
import queue
import threading
import traceback
import urllib.request
import urllib.error

TARGET = "blender"
DEFAULT_PORT = 8787
PORT_MIN, PORT_MAX = 8787, 8805
POLL_INTERVAL = 0.8
HEARTBEAT_INTERVAL = 5.0
LOCATOR_INTERVAL = 5.0   # 多久检查一次软件的端口定位文件

BL_APP_VERSION = bpy.app.version_string

_jobs = queue.Queue()
_events = []
_timer_on = False
_state = {
    "connected": False,
    "port": DEFAULT_PORT,
    "last": "",
    "job": "",
    "error": "",
    "thread": None,
    "stop": False,
}


def _event(text, kind="info"):
    """面板里显示的最近事件（只留最近 6 条）"""
    _events.append({"at": time.strftime("%H:%M:%S"), "text": str(text)[:180], "kind": kind})
    del _events[:-6]


# ----------------------------------------------------------------- 基础 HTTP

def _base(port):
    return "http://127.0.0.1:%d" % int(port)


def _req(port, path, data=None, timeout=4):
    url = _base(port) + path
    body = None
    headers = {
        "User-Agent": "AssetManager-Blender/%s (%s)" % (BL_VERSION, BL_SERIES),
    }
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if r.status == 204:
            return None
        raw = r.read()
        return json.loads(raw.decode("utf-8")) if raw else None


def _locator_port():
    """软件会把真实端口写到 %LOCALAPPDATA%\\AssetManager\\bridge.json（端口会漂移）

    bridge.json 里的端口不一定还活着（软件可能刚退出），所以还要探一下 /api/state。
    """
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    path = os.path.join(base, "AssetManager", "bridge.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            port = int(json.load(f).get("port") or 0)
    except Exception:
        return None
    if not port:
        return None
    try:
        st = _req(port, "/api/state", timeout=0.6)
        if st and "appRoot" in st:
            return port
    except Exception:
        pass
    return None


def _detect_port():
    """先读 bridge.json，再扫 8787-8805"""
    found = _locator_port()
    if found:
        return found
    for port in range(PORT_MIN, PORT_MAX + 1):
        try:
            st = _req(port, "/api/state", timeout=0.3)
            if st and "appRoot" in st:
                return port
        except Exception:
            continue
    return None


def _follow_locator():
    """软件换了端口就跟着走（重启、便携版每次解压到不同路径都会换端口）

    返回 True 表示端口变了。软件没在跑时 bridge.json 里的端口探不通，保持原端口。
    """
    found = _locator_port()
    if found and found != _state["port"]:
        _event("端口跟随到 %d（软件换端口了）" % found)
        _state["port"] = found
        return True
    return False


# ----------------------------------------------------------------- 节点兼容层
# Blender 3.x / 4.x 的节点与插槽名有差异，全部收在这一段：
# 以后接新的 Blender 系列，只需要在这里补分支，业务代码不用动。

def _num(d, key, dflt):
    try:
        v = float(d.get(key, dflt))
        return v
    except Exception:
        return float(dflt)


def _bsdf_input(bsdf, *names):
    """按顺序找第一个存在的 BSDF 插槽（Emission / Emission Color 这类改名）"""
    for n in names:
        sock = bsdf.inputs.get(n)
        if sock is not None:
            return sock
    return None


def _ins(node, *names):
    """按顺序找第一个存在的输入插槽（5.x 把 HueSaturation/MixRGB 的 Fac 改名 Factor）"""
    for n in names:
        sock = node.inputs.get(n)
        if sock is not None:
            return sock
    return None


def _color_sockets(node):
    return [s for s in node.inputs if s.type == "RGBA"]


def _multiply_color(nodes, links, a, b):
    """颜色相乘（AO 乘到基础色）。4.x 用 ShaderNodeMix，3.x 回退 MixRGB"""
    node = None
    try:
        node = nodes.new("ShaderNodeMix")
        node.data_type = "RGBA"
        node.blend_type = "MULTIPLY"
        node.inputs[0].default_value = 1.0  # Factor
        ca, cb = _color_sockets(node)[:2]
        links.new(a, ca)
        links.new(b, cb)
        for out in node.outputs:
            if out.type == "RGBA":
                return out
    except Exception:
        if node is not None:
            try:
                nodes.remove(node)
            except Exception:
                pass
    node = nodes.new("ShaderNodeMixRGB")
    node.blend_type = "MULTIPLY"
    _ins(node, "Fac", "Factor").default_value = 1.0
    links.new(a, node.inputs["Color1"])
    links.new(b, node.inputs["Color2"])
    return node.outputs["Color"]


def _sep_rgb(nodes, links, color):
    """颜色拆成 (r, g, b) 三个标量 socket"""
    try:
        node = nodes.new("ShaderNodeSeparateColor")
        links.new(color, node.inputs["Color"])
        return [node.outputs[i] for i in range(3)]
    except Exception:
        node = nodes.new("ShaderNodeSeparateRGB")
        links.new(color, node.inputs["Image"])
        return [node.outputs["R"], node.outputs["G"], node.outputs["B"]]


def _comb_rgb(nodes, links, r, g, b):
    """三个标量 socket 合成颜色"""
    try:
        node = nodes.new("ShaderNodeCombineColor")
        links.new(r, node.inputs[0])
        links.new(g, node.inputs[1])
        links.new(b, node.inputs[2])
        return node.outputs["Color"]
    except Exception:
        node = nodes.new("ShaderNodeCombineRGB")
        links.new(r, node.inputs["R"])
        links.new(g, node.inputs["G"])
        links.new(b, node.inputs["B"])
        return node.outputs["Image"]


def _scale_scalar(nodes, links, sock, k):
    try:
        k = float(k)
    except Exception:
        k = 1.0
    if abs(k - 1.0) < 1e-6:
        return sock
    node = nodes.new("ShaderNodeMath")
    node.operation = "MULTIPLY"
    links.new(sock, node.inputs[0])
    node.inputs[1].default_value = k
    return node.outputs[0]


def _invert_scalar(nodes, links, sock):
    node = nodes.new("ShaderNodeMath")
    node.operation = "SUBTRACT"
    node.inputs[0].default_value = 1.0
    links.new(sock, node.inputs[1])
    return node.outputs[0]


def _hsl(nodes, links, color, cfg):
    """色相 / 饱和 / 明度，与组装器一致：Hue 0.5 = 不变，S/L ×2"""
    try:
        node = nodes.new("ShaderNodeHueSaturation")
        node.inputs["Hue"].default_value = _num(cfg, "h", 0.5)
        node.inputs["Saturation"].default_value = _num(cfg, "s", 0.5) * 2.0
        node.inputs["Value"].default_value = _num(cfg, "l", 0.5) * 2.0
        fac = _ins(node, "Fac", "Factor")
        if fac is not None:
            fac.default_value = 1.0
        links.new(color, node.inputs["Color"])
        return node.outputs["Color"]
    except Exception:
        return color


def _constant_color(nodes, value):
    node = nodes.new("ShaderNodeRGB")
    node.outputs[0].default_value = value
    return node.outputs[0]


def _channel(entry):
    return str(entry.get("channel") or "rgb").lower()


def _tex_node(nodes, links, entry, vec, non_color, cache=None):
    """Mapping → Image 贴图节点；返回 (tex, image)

    同一张贴图在一个材质里只建一个 TexImage（打包图 ARM 会被 AO/粗糙/金属三处用到），
    节点数和显存占用都省下来。
    """
    path = entry.get("path") or ""
    if not path or not os.path.exists(path):
        raise RuntimeError("贴图不存在：%s" % path)
    key = ("tex", path.lower(), bool(non_color))
    if cache is not None and key in cache:
        return cache[key], cache[key].image
    img = bpy.data.images.load(path, check_existing=True)
    if non_color:
        try:
            img.colorspace_settings.name = "Non-Color"
        except Exception:
            pass
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Linear"
    tex.label = os.path.basename(path)
    try:
        tex.extension = "REPEAT"
    except Exception:
        pass
    links.new(vec, tex.inputs["Vector"])
    if cache is not None:
        cache[key] = tex
    return tex, img


def _map_color(nodes, links, entry, vec, cache=None):
    """贴图 → 颜色 socket（按通道抽成灰度再合成，rgb 直接输出）"""
    tex, _img = _tex_node(nodes, links, entry, vec, non_color=False, cache=cache)
    ch = _channel(entry)
    ckey = ("color", (entry.get("path") or "").lower(), ch)
    if cache is not None and ckey in cache:
        return cache[ckey], tex
    if ch in ("", "rgb"):
        return tex.outputs["Color"], tex
    if ch == "a":
        alpha = tex.outputs["Alpha"]
        out = _comb_rgb(nodes, links, alpha, alpha, alpha)
        if cache is not None:
            cache[ckey] = out
        return out, tex
    r, g, b = _sep_rgb(nodes, links, tex.outputs["Color"])
    one = {"r": r, "g": g, "b": b}.get(ch, r)
    out = _comb_rgb(nodes, links, one, one, one)
    if cache is not None:
        cache[ckey] = out
    return out, tex


def _map_scalar(nodes, links, entry, vec, cache=None):
    """贴图 → 标量 socket（粗糙度 / 金属度 / AO / 高度 / 不透明度）"""
    tex, _img = _tex_node(nodes, links, entry, vec, non_color=True, cache=cache)
    ch = _channel(entry)
    ckey = ("scalar", (entry.get("path") or "").lower(), ch)
    if cache is not None and ckey in cache:
        return cache[ckey], tex
    if ch == "a":
        out = tex.outputs["Alpha"]
    elif ch in ("", "rgb"):
        bw = nodes.new("ShaderNodeRGBToBW")
        links.new(tex.outputs["Color"], bw.inputs["Color"])
        out = bw.outputs["Val"]
    else:
        r, g, b = _sep_rgb(nodes, links, tex.outputs["Color"])
        out = {"r": r, "g": g, "b": b}.get(ch, r)
    if cache is not None:
        cache[ckey] = out
    return out, tex


def _apply_scalar_flags(nodes, links, sock, entry):
    """invert（反相，SG 工作流的光泽度／组装的取反）与 intensity（乘系数）"""
    if entry.get("invert"):
        sock = _invert_scalar(nodes, links, sock)
    return _scale_scalar(nodes, links, sock, _num(entry, "intensity", 1.0))


def _set_alpha_mode(mat):
    """4.2+ 用 surface_render_method，3.x/4.0/4.1 用 blend_method"""
    try:
        mat.surface_render_method = "DITHERED"
        return
    except Exception:
        pass
    try:
        mat.blend_method = "BLEND"
    except Exception:
        pass


def _is_ours(mat):
    """这个材质是不是本插件建的（带 assetmanager 标记，才允许覆盖/替换）"""
    try:
        return bool(mat.get("assetmanager"))
    except Exception:
        return False


def _undo(label):
    """留一个撤销点：Ctrl+Z 能撤回导入/赋材质"""
    try:
        bpy.ops.ed.undo_push(message="AssetManager: " + label)
    except Exception:
        pass


def _existing_ours(name):
    """同名且是本插件建的材质（带 assetmanager 标记）——可以原地重建"""
    if not name:
        return None
    mat = bpy.data.materials.get(name)
    if mat is None:
        return None
    return mat if _is_ours(mat) else None


def build_material(spec, name, reuse=True):
    """按 MaterialSpec 重建 PBR 材质；返回 (材质, 已接通道列表)

    reuse=True 时，若已有**本插件建的**同名材质，就在它上面原地重建：
    材质不再堆出 X.001、X.002，而且已经赋了这个材质的对象会跟着一起更新。
    用户自己的同名材质（没有 assetmanager 标记）不会被覆盖，会另建一个。
    """
    spec = spec or {}
    name = name or "AssetManager"
    nodes = links = None

    mat = _existing_ours(name) if reuse else None
    if mat is not None and getattr(mat, "node_tree", None) is not None:
        # 原地重建：清空节点后自建 BSDF + 输出（清空后 Blender 不会自动补输出节点）
        nt = mat.node_tree
        for node in list(nt.nodes):
            nt.nodes.remove(node)
        nodes, links = nt.nodes, nt.links
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        out = nodes.new("ShaderNodeOutputMaterial")
        links.new(bsdf.outputs[0], out.inputs["Surface"])
    else:
        mat = bpy.data.materials.new(name)
        try:
            mat["assetmanager"] = 1
        except Exception:
            pass
        try:
            # 5.x 起新材质默认已带节点树，且 use_nodes 被标记弃用（6.0 移除）
            if not mat.use_nodes:
                mat.use_nodes = True
        except Exception:
            try:
                mat.use_nodes = True
            except Exception:
                pass
        nt = mat.node_tree
        if nt is None:
            raise RuntimeError("材质没有节点树（Blender 版本过旧或材质类型不对）")
        nodes, links = nt.nodes, nt.links

        # 节点名会随界面语言本地化（中文界面是「原理化 BSDF」），所以按类型找
        bsdf = None
        for node in nodes:
            if node.type == "BSDF_PRINCIPLED":
                bsdf = node
                break
        if bsdf is None:
            raise RuntimeError("材质里找不到 Principled BSDF 节点")

    # UV：平铺 / 旋转（弧度）/ 位移
    uv = spec.get("uv") or {}
    tc = nodes.new("ShaderNodeTexCoord")
    mp = nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (
        _num(uv, "repeatU", 1.0), _num(uv, "repeatV", 1.0), 1.0)
    mp.inputs["Rotation"].default_value = (0.0, 0.0, _num(uv, "rot", 0.0))
    mp.inputs["Location"].default_value = (
        _num(uv, "offsetU", 0.0), _num(uv, "offsetV", 0.0), 0.0)
    links.new(tc.outputs["UV"], mp.inputs["Vector"])
    vec = mp.outputs["Vector"]

    maps = spec.get("maps") or {}
    workflow = str(spec.get("workflow") or "MR").upper()
    applied = []
    # 贴图/通道缓存：同一张打包图（ARM 等）只建一个贴图节点、只抽一次通道
    cache = {}

    def entry(slot):
        return maps.get(slot) or {}

    # ---- 基础色（+ HSL，+ AO 相乘）
    base_color = None
    if entry("baseColor").get("path"):
        base_color, _t = _map_color(nodes, links, entry("baseColor"), vec, cache)
        if entry("baseColor").get("hsl"):
            base_color = _hsl(nodes, links, base_color, entry("baseColor")["hsl"])
        applied.append("baseColor")

    if entry("ao").get("path"):
        ao, _t = _map_scalar(nodes, links, entry("ao"), vec, cache)
        ao = _apply_scalar_flags(nodes, links, ao, entry("ao"))
        if base_color is None:
            base_color = _constant_color(nodes, (0.8, 0.8, 0.8, 1.0))
        base_color = _multiply_color(nodes, links, base_color, ao)
        applied.append("ao")

    if base_color is not None:
        base_in = _bsdf_input(bsdf, "Base Color")
        if base_in is not None:
            links.new(base_color, base_in)

    # ---- 粗糙度 / 金属度（SG 工作流的光泽度要反相）
    for slot, input_names in (("roughness", ("Roughness",)), ("metallic", ("Metallic",))):
        e = entry(slot)
        if not e.get("path"):
            continue
        sock, _t = _map_scalar(nodes, links, e, vec, cache)
        flags = dict(e)
        if slot == "roughness" and workflow == "SG" and "invert" not in flags:
            flags["invert"] = True
        sock = _apply_scalar_flags(nodes, links, sock, flags)
        target = _bsdf_input(bsdf, *input_names)
        if target is not None:
            links.new(sock, target)
            applied.append(slot)

    # ---- 自发光
    if entry("emissive").get("path"):
        col, _t = _map_color(nodes, links, entry("emissive"), vec, cache)
        if entry("emissive").get("hsl"):
            col = _hsl(nodes, links, col, entry("emissive")["hsl"])
        target = _bsdf_input(bsdf, "Emission Color", "Emission")
        if target is not None:
            links.new(col, target)
            strength = _bsdf_input(bsdf, "Emission Strength")
            if strength is not None:
                strength.default_value = max(1.0, _num(entry("emissive"), "intensity", 1.0))
            applied.append("emissive")

    # ---- 不透明度
    if entry("opacity").get("path"):
        sock, _t = _map_scalar(nodes, links, entry("opacity"), vec, cache)
        sock = _apply_scalar_flags(nodes, links, sock, entry("opacity"))
        alpha = _bsdf_input(bsdf, "Alpha")
        if alpha is not None:
            links.new(sock, alpha)
            _set_alpha_mode(mat)
            applied.append("opacity")

    # ---- 法线（GL 直连；DX 翻转绿通道）→ 可选再接高度凹凸
    normal_socket = None
    if entry("normal").get("path"):
        col, _t = _map_color(nodes, links, entry("normal"), vec, cache)
        if str(entry("normal").get("normalSpace") or "gl").lower() == "dx":
            r, g, b = _sep_rgb(nodes, links, col)
            col = _comb_rgb(nodes, links, r, _invert_scalar(nodes, links, g), b)
        nmap = nodes.new("ShaderNodeNormalMap")
        nmap.inputs["Strength"].default_value = _num(entry("normal"), "intensity", 1.0)
        links.new(col, nmap.inputs["Color"])
        normal_socket = nmap.outputs["Normal"]
        applied.append("normal")

    if entry("height").get("path"):
        sock, _t = _map_scalar(nodes, links, entry("height"), vec, cache)
        sock = _scale_scalar(nodes, links, sock, 1.0)
        bump = nodes.new("ShaderNodeBump")
        try:
            bump.inputs["Distance"].default_value = 0.05
        except Exception:
            pass
        strength = _num(entry("height"), "intensity", 1.0)
        bump.inputs["Strength"].default_value = max(0.0, min(1.0, strength if strength <= 1.0 else 1.0))
        links.new(sock, bump.inputs["Height"])
        if normal_socket is not None:
            links.new(normal_socket, bump.inputs["Normal"])
        normal_socket = bump.outputs["Normal"]
        applied.append("height")

    if normal_socket is not None:
        nrm_in = _bsdf_input(bsdf, "Normal")
        if nrm_in is not None:
            links.new(normal_socket, nrm_in)

    return mat, applied


# ----------------------------------------------------------------- 导入 / 材质 / 贴图

def _call_op(candidates, path, label):
    """按顺序试操作符（同名 API 在 3.x / 4.x 之间会动）"""
    last = None
    for dotted in candidates:
        mod_name, op_name = dotted.split(".")
        mod = getattr(bpy.ops, mod_name, None)
        func = getattr(mod, op_name, None) if mod is not None else None
        if func is None:
            continue
        try:
            func(filepath=path)
            return
        except Exception as e:
            last = e
    raise RuntimeError("%s：%s" % (label, last))


IMPORTERS = (
    ((".fbx",), ["import_scene.fbx"], "FBX 导入失败（确认 Import-Export: FBX 插件已启用）"),
    ((".glb", ".gltf"), ["import_scene.gltf"], "glTF 导入失败（确认 Import-Export: glTF 插件已启用）"),
    ((".obj",), ["wm.obj_import", "import_scene.obj"], "OBJ 导入失败"),
    ((".dae",), ["wm.collada_import"], "DAE 导入失败"),
    ((".stl",), ["wm.stl_import", "import_scene.stl"], "STL 导入失败"),
    ((".ply",), ["wm.ply_import", "import_scene.ply"], "PLY 导入失败"),
    ((".usd", ".usda", ".usdc", ".usdz"), ["wm.usd_import"], "USD 导入失败"),
    ((".abc",), ["wm.alembic_import"], "Alembic 导入失败"),
)


def _collection_for(name):
    """导入的模型归到一个以素材命名的集合里，Outliner 好找"""
    base = (name or "AssetManager").strip() or "AssetManager"
    col = bpy.data.collections.get(base)
    if col is None:
        col = bpy.data.collections.new(base)
        bpy.context.scene.collection.children.link(col)
    return col


def _move_to_collection(objects, col):
    for obj in objects:
        for c in list(obj.users_collection):
            try:
                c.objects.unlink(obj)
            except Exception:
                pass
        try:
            col.objects.link(obj)
        except Exception:
            pass


def _select_only(objects):
    for obj in bpy.context.selected_objects:
        obj.select_set(False)
    for obj in objects:
        try:
            obj.select_set(True)
        except Exception:
            pass
    if objects:
        bpy.context.view_layer.objects.active = objects[0]


def _meshes(objects):
    return [o for o in objects if o.type == "MESH"]


def _import_model(payload):
    path = payload.get("modelPath") or ""
    ext = str(payload.get("ext") or os.path.splitext(path)[1] or "").lower()
    if not path or not os.path.exists(path):
        raise RuntimeError("模型文件不存在：%s" % path)

    runner = None
    for exts, candidates, label in IMPORTERS:
        if ext in exts:
            runner = (candidates, label)
            break
    if runner is None:
        raise RuntimeError("暂不支持导入格式：%s" % ext)

    before = set(bpy.data.objects)
    _call_op(runner[0], path, runner[1])
    new = [o for o in bpy.data.objects if o not in before]
    if not new:
        raise RuntimeError("导入完成但没有新增对象（%s）" % ext)

    col = _collection_for(payload.get("name") or os.path.splitext(os.path.basename(path))[0])
    _move_to_collection(new, col)

    # 素材自带贴图 → 重建材质并贴到导入的网格上
    applied = []
    spec = payload.get("material")
    if spec and (spec.get("maps") or {}):
        mat, applied = build_material(spec, payload.get("name"))
        for obj in _meshes(new):
            obj.data.materials.clear()
            obj.data.materials.append(mat)

    # 放到 3D 光标处（父物体跟着父物体走，不重复平移）
    cur = bpy.context.scene.cursor.location
    for obj in new:
        if obj.parent is None:
            obj.location = (obj.location.x + cur.x, obj.location.y + cur.y, obj.location.z + cur.z)

    _select_only(new)
    _undo("导入模型")
    msg = "已导入 %d 个对象" % len(new)
    if len(col.objects) > len(new):
        msg += "（集合 %s 现有 %d 个，同一素材多次导入会累加）" % (col.name, len(col.objects))
    if applied:
        msg += "，材质通道：" + "/".join(applied)
    return msg


def _apply_hdri(payload):
    files = payload.get("files") or []
    path = files[0] if files else ""
    if not path or not os.path.exists(path):
        raise RuntimeError("HDRI 文件不存在")
    scene = bpy.context.scene
    if scene.world is None:
        scene.world = bpy.data.worlds.new("AssetManager_World")
    world = scene.world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(path, check_existing=True)
    bg = nt.nodes.new("ShaderNodeBackground")
    out = nt.nodes.new("ShaderNodeOutputWorld")
    try:
        bg.inputs["Strength"].default_value = float(payload.get("strength", 1.0))
    except Exception:
        pass
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    return {"ok": True, "path": path}


def _apply_material(payload):
    name = payload.get("assetName") or payload.get("name") or "AssetManager"
    mat, applied = build_material(payload, name)
    targets = _meshes(bpy.context.selected_objects) or _meshes(bpy.context.scene.objects)
    if not targets:
        raise RuntimeError("场景里没有网格对象：先选中要赋材质的模型或面片")
    reused = replaced = appended = 0
    for obj in targets:
        slots = obj.data.materials
        if any(m == mat for m in slots):
            reused += 1          # 已经用着这个材质：原地重建已经让它更新了
            continue
        # 先把本插件以前建的材质槽换成新的（多材质模型保留面分配）
        hit = 0
        for i, m in enumerate(list(slots)):
            if m is not None and _is_ours(m):
                slots[i] = mat
                hit += 1
        if hit:
            replaced += 1
            continue
        if len(slots) == 1:
            slots[0] = mat       # 单槽直接替换，不动原有的面到材质的分配
        else:
            slots.append(mat)    # 无槽 / 多材质：追加一个槽，原有分配保持不变
            appended += 1
    _undo("赋材质")
    parts = ["已给 %d 个对象赋材质 %s" % (len(targets), mat.name)]
    detail = []
    if reused:
        detail.append("%d 个原地更新" % reused)
    if replaced:
        detail.append("%d 个替换旧槽位" % replaced)
    if appended:
        detail.append("%d 个追加到新槽位" % appended)
    if detail:
        parts.append("（" + "，".join(detail) + "）")
    if applied:
        parts.append("，通道：" + "/".join(applied))
    return "".join(parts)


def _show_in_image_editor(img):
    """有图像编辑器就顺手把第一张贴图显示出来"""
    screen = getattr(bpy.context, "screen", None)
    if not screen:
        return
    for area in screen.areas:
        if area.type != "IMAGE_EDITOR":
            continue
        for space in area.spaces:
            if space.type == "IMAGE_EDITOR":
                try:
                    space.image = img
                except Exception:
                    pass


def _receive_textures(payload):
    files = [f for f in (payload.get("files") or []) if f]
    if not files:
        files = [p.get("path") for p in (payload.get("paths") or []) if p.get("path")]
    files = [f for f in files if os.path.exists(f)]
    if not files:
        raise RuntimeError("没有可用的贴图文件")

    loaded = []
    for f in files:
        try:
            loaded.append(bpy.data.images.load(f, check_existing=True))
        except Exception:
            continue
    if not loaded:
        raise RuntimeError("贴图载入失败（格式可能不被支持）")
    _show_in_image_editor(loaded[0])
    names = ", ".join(img.name for img in loaded[:4])
    more = "…" if len(loaded) > 4 else ""
    return "已载入 %d 张贴图：%s%s（图像编辑器的图片列表里可切换）" % (len(loaded), names, more)


def _execute(job):
    mode = job.get("mode")
    payload = job.get("payload") or {}
    if mode == "import":
        return _import_model(payload)
    if mode == "material":
        return _apply_material(payload)
    if mode == "hdri":
        return _apply_hdri(payload)
    if mode == "texture":
        return _receive_textures(payload)
    # 本插件只做「从 AssetManager 导入」，回库（pack）与拖放都还没做
    raise RuntimeError("不支持的任务类型：%s（本插件只支持 import / material / texture / hdri）" % mode)


# ----------------------------------------------------------------- 轮询线程（后台）
# Blender 不允许跨线程改场景：线程只取任务，执行全在主线程的 timer 里。

def _worker():
    last_hb = 0.0
    last_watch = time.time()
    idle = 0          # 连续没取到任务的次数（用来放慢空闲轮询）
    while not _state["stop"]:
        # 软件换端口（重启 / 便携版解压路径变化）→ 跟着 bridge.json 走
        if time.time() - last_watch > LOCATOR_INTERVAL:
            last_watch = time.time()
            try:
                if _follow_locator():
                    last_hb = 0.0  # 立刻向新端口心跳
            except Exception:
                pass

        port = _state["port"]
        if time.time() - last_hb > HEARTBEAT_INTERVAL:
            try:
                _req(port, "/api/bridge/%s/heartbeat" % TARGET, {
                    "version": BL_VERSION,
                    "plugin": BL_VERSION,
                    "series": BL_SERIES,
                    "blender": BL_APP_VERSION,
                    "host": os.environ.get("COMPUTERNAME", ""),
                    "info": {"plugin": BL_VERSION, "series": BL_SERIES, "blender": BL_APP_VERSION},
                })
                if not _state["connected"]:
                    _event("已连接 AssetManager（端口 %d）" % port, "ok")
                _state["connected"] = True
                _state["error"] = ""
            except Exception as e:
                if _state["connected"]:
                    _event("与 AssetManager 断开：%s" % e, "err")
                _state["connected"] = False
                _state["error"] = str(e)
                found = _detect_port()
                if found and found != port:
                    _state["port"] = found
                    _event("端口已切换到 %d" % found, "info")
                last_hb = 0.0
                time.sleep(2.0)
                continue
            last_hb = time.time()

        try:
            job = _req(port, "/api/bridge/%s/next" % TARGET)
            if job:
                _state["job"] = job.get("title") or job.get("mode") or ""
                _jobs.put(job)
                idle = 0
            else:
                idle += 1
        except Exception as e:
            _state["connected"] = False
            _state["error"] = str(e)
            idle += 1
        # 空闲久了放慢轮询（连续 20 次没任务 ≈ 16 秒后降到 2 秒一次），有任务立刻恢复
        time.sleep(POLL_INTERVAL if idle < 20 else 2.0)


def _start():
    if _state["thread"] and _state["thread"].is_alive():
        return
    _state["stop"] = False
    t = threading.Thread(target=_worker, name="AssetManagerBridge", daemon=True)
    _state["thread"] = t
    t.start()


def _stop():
    _state["stop"] = True
    _state["thread"] = None
    _state["connected"] = False
    _state["job"] = ""
    while True:  # 丢掉未执行的旧任务，避免下次连接时重复执行
        try:
            _jobs.get_nowait()
        except queue.Empty:
            break


def _timer():
    """主线程侧：执行排队任务并回传结果（bpy.app.timers 驱动）"""
    try:
        while True:
            job = _jobs.get_nowait()
            _state["job"] = job.get("title") or job.get("mode") or ""
            ok, msg = True, ""
            try:
                msg = _execute(job)
            except Exception as e:
                ok = False
                msg = str(e) or e.__class__.__name__
                _state["error"] = traceback.format_exc()
                print("[AssetManager] 任务失败：\n" + traceback.format_exc())
            try:
                _req(_state["port"], "/api/bridge/%s/result" % TARGET, {
                    "id": job.get("id"),
                    "ok": ok,
                    "message": msg,
                    "detail": {"plugin": BL_VERSION, "series": BL_SERIES, "blender": BL_APP_VERSION},
                })
            except Exception:
                pass
            _state["last"] = ("OK " if ok else "失败 ") + msg
            _event(_state["last"], "ok" if ok else "err")
            _state["job"] = ""
    except queue.Empty:
        pass
    except Exception:
        _state["error"] = traceback.format_exc()
    return 0.3


def _ensure_timer():
    global _timer_on
    if _timer_on:
        return
    try:
        bpy.app.timers.register(_timer, first_interval=0.2, persistent=True)
        _timer_on = True
    except Exception:
        _timer_on = False


# ----------------------------------------------------------------- UI

def _on_port_update(self, context):
    try:
        _state["port"] = int(self.am_port)
    except Exception:
        pass


class AM_OT_connect(bpy.types.Operator):
    bl_idname = "assetmanager.connect"
    bl_label = "连接 AssetManager"
    bl_description = "探测本地 AssetManager 服务并开始接收任务"

    def execute(self, context):
        port = _detect_port()
        if port:
            context.scene.am_port = port
        else:
            port = int(context.scene.am_port or DEFAULT_PORT)
        _state["port"] = port
        _start()
        _ensure_timer()
        _event("桥接已启动（插件 %s · 系列 %s · 端口 %d）" % (BL_VERSION, BL_SERIES, port))
        self.report({"INFO"}, "AssetManager 桥接已启动（端口 %d）" % port)
        return {"FINISHED"}


class AM_OT_disconnect(bpy.types.Operator):
    bl_idname = "assetmanager.disconnect"
    bl_label = "断开"
    bl_description = "停止接收任务"

    def execute(self, context):
        _stop()
        _event("已断开")
        self.report({"INFO"}, "已断开 AssetManager")
        return {"FINISHED"}


class AM_OT_detect(bpy.types.Operator):
    bl_idname = "assetmanager.detect"
    bl_label = "自动探测端口"
    bl_description = "读 bridge.json / 扫 8787-8805 找到 AssetManager"

    def execute(self, context):
        port = _detect_port()
        if port:
            context.scene.am_port = port
            _state["port"] = port
            self.report({"INFO"}, "找到 AssetManager：%d" % port)
        else:
            self.report({"WARNING"}, "没找到 AssetManager 服务（先启动软件）")
        return {"FINISHED"}


class AM_PT_panel(bpy.types.Panel):
    bl_label = "AssetManager"
    bl_idname = "AM_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "AssetManager"

    def draw(self, context):
        layout = self.layout
        layout.label(text="桥接插件 v%s · Blender %s 系列" % (BL_VERSION, BL_SERIES), icon="PLUGIN")
        layout.label(text="接收：模型导入 / 材质重建 / 贴图", icon="IMPORT")

        box = layout.box()
        box.label(text="服务端口", icon="NETWORK_DRIVE")
        row = box.row(align=True)
        row.prop(context.scene, "am_port", text="")
        row.operator("assetmanager.detect", text="", icon="VIEWZOOM")
        row = box.row(align=True)
        row.operator("assetmanager.connect", icon="PLAY")
        row.operator("assetmanager.disconnect", icon="PAUSE")

        connected = _state["connected"]
        box = layout.box()
        box.label(text="已连接" if connected else "未连接",
                  icon="CHECKMARK" if connected else "CANCEL")
        box.label(text="Blender %s · 端口 %d" % (BL_APP_VERSION, _state["port"]), icon="BLENDER")
        if connected:
            # 队列里有活儿时提示一下，平时不占地方
            pending = _jobs.qsize()
            if pending:
                box.label(text="待执行 %d 个任务" % pending, icon="TIME")
        if _state["job"]:
            box.label(text="执行中：%s" % _state["job"], icon="TIME")
        if _state["last"]:
            box.label(text=_state["last"], icon="INFO")
        if _events:
            col = box.column(align=True)
            for e in reversed(_events[-4:]):
                col.label(text="%s  %s" % (e["at"], e["text"]),
                          icon="ERROR" if e["kind"] == "err" else "DOT")
        if not connected and _state["error"]:
            box.label(text="确认 AssetManager 已启动（会自动跟随它的端口）", icon="ERROR")


_CLASSES = (AM_OT_connect, AM_OT_disconnect, AM_OT_detect, AM_PT_panel)


def register():
    for cls in _CLASSES:
        try:
            bpy.utils.register_class(cls)
        except Exception:
            # 注册失败不要静默吞掉：5.x 起 bpy.types 不再暴露 Python 类，出问题只能靠日志
            print("[AssetManager] 注册 %s 失败：\n%s" % (cls.__name__, traceback.format_exc()))
    bpy.types.Scene.am_port = bpy.props.IntProperty(
        name="端口", default=DEFAULT_PORT, min=1024, max=65535, update=_on_port_update)

    port = _detect_port() or DEFAULT_PORT
    _state["port"] = port
    _ensure_timer()
    _start()
    _event("插件 %s 已载入（Blender %s · 系列 %s）" % (BL_VERSION, BL_APP_VERSION, BL_SERIES))
    print("[AssetManager] 桥接插件 v%s（Blender %s，端口 %d）" % (BL_VERSION, BL_APP_VERSION, port))


def unregister():
    _stop()
    try:
        bpy.app.timers.unregister(_timer)
    except Exception:
        pass
    globals()["_timer_on"] = False
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except Exception:
            pass
    try:
        del bpy.types.Scene.am_port
    except Exception:
        pass


if __name__ == "__main__":
    register()
