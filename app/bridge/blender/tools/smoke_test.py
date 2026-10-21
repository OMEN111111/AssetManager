# -*- coding: utf-8 -*-
"""无 Blender 环境下的冒烟测试（开发用，不装进 Blender）

用假的 bpy / 节点系统把插件主体跑一遍，能在没有 Blender 的机器上抓出
结构性错误（插槽名、索引、参数个数、分支漏掉）。节点 API 本身的行为仍以 Blender 为准。

    python tools/smoke_test.py
"""
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIRS = ["3.6", "4.0", "5.2"]

try:  # Windows 控制台默认 GBK，中文输出会炸
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# ---------------------------------------------------------------- 假 bpy

VALUE, VECTOR, RGBA = "VALUE", "VECTOR", "RGBA"


class Sock:
    def __init__(self, name, kind):
        self.name = name
        self.type = kind
        self.default_value = None


class Socks:
    def __init__(self, items):
        self.items = list(items)

    def __iter__(self):
        return iter(self.items)

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        if isinstance(i, str):
            sock = self.get(i)
            if sock is None:
                raise KeyError(i)
            return sock
        return self.items[i]

    def get(self, name, default=None):
        for s in self.items:
            if s.name == name:
                return s
        return default

    def __contains__(self, name):
        return self.get(name) is not None


# 每种节点在被访问到的插槽上都要有：3.x 与 4.x 的差异故意都提供，插件应各自命中
SCHEMAS = {
    "ShaderNodeTexCoord": ([], [("UV", VECTOR)]),
    "ShaderNodeMapping": ([("Vector", VECTOR), ("Location", VECTOR), ("Rotation", VECTOR), ("Scale", VECTOR)],
                          [("Vector", VECTOR)]),
    "ShaderNodeTexImage": ([("Vector", VECTOR)], [("Color", RGBA), ("Alpha", VALUE)]),
    "ShaderNodeSeparateColor": ([("Color", RGBA)], [("Red", VALUE), ("Green", VALUE), ("Blue", VALUE)]),
    "ShaderNodeCombineColor": ([("Red", VALUE), ("Green", VALUE), ("Blue", VALUE)], [("Color", RGBA)]),
    "ShaderNodeMix": ([("Factor", VALUE), ("Factor", VECTOR), ("A", VALUE), ("B", VALUE),
                       ("A", VECTOR), ("B", VECTOR), ("A", RGBA), ("B", RGBA)],
                      [("Result", VALUE), ("Result", VECTOR), ("Result", RGBA)]),
    "ShaderNodeMath": ([("Value", VALUE), ("Value", VALUE)], [("Value", VALUE)]),
    "ShaderNodeRGBToBW": ([("Color", RGBA)], [("Val", VALUE)]),
    "ShaderNodeHueSaturation": ([("Hue", VALUE), ("Saturation", VALUE), ("Value", VALUE),
                                 ("Fac", VALUE), ("Color", RGBA)], [("Color", RGBA)]),
    "ShaderNodeRGB": ([], []),
    "ShaderNodeNormalMap": ([("Strength", VALUE), ("Color", RGBA)], [("Normal", VECTOR)]),
    "ShaderNodeBump": ([("Strength", VALUE), ("Distance", VALUE), ("Height", VALUE), ("Normal", VECTOR)],
                       [("Normal", VECTOR)]),
}

BSDF_INPUTS = [("Base Color", RGBA), ("Metallic", VALUE), ("Roughness", VALUE),
               ("IOR", VALUE), ("Alpha", VALUE), ("Normal", VECTOR),
               ("Emission Color", RGBA), ("Emission Strength", VALUE)]


class Node:
    def __init__(self, ntype):
        self.type = ntype
        ins, outs = SCHEMAS.get(ntype, ([], []))
        self.inputs = Socks([Sock(n, k) for n, k in ins])
        self.outputs = Socks([Sock(n, k) for n, k in outs])


class Nodes:
    def __init__(self):
        self.items = [self._bsdf()]

    def _bsdf(self):
        n = Node("BSDF_PRINCIPLED")
        n.type = "BSDF_PRINCIPLED"
        n.inputs = Socks([Sock(name, kind) for name, kind in BSDF_INPUTS])
        n.outputs = Socks([Sock("BSDF", "SHADER")])
        return n

    def new(self, ntype):
        if ntype not in SCHEMAS:
            raise RuntimeError("未知节点类型（假 bpy 未收录）：%s" % ntype)
        node = Node(ntype)
        self.items.append(node)
        return node

    def get(self, name):
        for n in self.items:
            if getattr(n, "name", None) == name:
                return n
        return None

    def __iter__(self):
        return iter(self.items)


class Links:
    def __init__(self):
        self.items = []

    def new(self, a, b):
        if not isinstance(a, Sock) or not isinstance(b, Sock):
            raise TypeError("links.new 只接受 socket：%r -> %r" % (a, b))
        self.items.append((a, b))


class MaterialTree:
    def __init__(self):
        self.nodes = Nodes()
        self.links = Links()
        self.nodes.items[0].name = "Principled BSDF"


class Image:
    def __init__(self, path):
        self.name = os.path.basename(path)
        self.filepath = path
        self.colorspace_settings = types.SimpleNamespace(name="sRGB")


class Material:
    def __init__(self, name):
        self.name = name
        self.use_nodes = False
        self.node_tree = MaterialTree()
        self._custom = {}   # bpy 的自定义属性（材质上我们打了 assetmanager 标记）

    def get(self, key, default=None):
        return self._custom.get(key, default)

    def __setitem__(self, key, value):
        self._custom[key] = value


class Materials(dict):
    """假 bpy.data.materials：new() 自动避重名（Blender 会给 .001），get() 按名字查"""

    def new(self, name, *a, **k):
        base = name or "Material"
        final, i = base, 0
        while final in self:
            i += 1
            final = "%s.%03d" % (base, i)
        mat = Material(final)
        self[final] = mat
        return mat

    def remove(self, mat):
        self.pop(mat.name, None)


def make_bpy():
    bpy = types.ModuleType("bpy")
    bpy.app = types.SimpleNamespace(version_string="4.3.0", timers=types.SimpleNamespace(
        register=lambda *a, **k: None, unregister=lambda *a, **k: None))
    bpy.data = types.SimpleNamespace(
        images=types.SimpleNamespace(load=lambda p, check_existing=True: Image(p)),
        materials=Materials(),
    )
    bpy.context = types.SimpleNamespace(selected_objects=[], scene=types.SimpleNamespace(objects=[]))
    bpy.types = types.SimpleNamespace(Operator=object, Panel=object, Scene=types.SimpleNamespace(),
                                      IntProperty=lambda **k: None)
    bpy.utils = types.SimpleNamespace(register_class=lambda c: None, unregister_class=lambda c: None)
    bpy.props = types.SimpleNamespace(IntProperty=lambda **k: 0)
    bpy.ops = types.SimpleNamespace()
    return bpy


def load_plugin(series):
    path = os.path.join(HERE, "..", series, "assetmanager_blender.py")
    src = open(path, "r", encoding="utf-8").read()
    mod = types.ModuleType("am_plugin_%s" % series.replace(".", "_"))
    mod.__file__ = path
    sys.modules["bpy"] = make_bpy()
    exec(compile(src, path, "exec"), mod.__dict__)
    return mod


# ---------------------------------------------------------------- 用例

def make_texture_dir():
    import tempfile
    d = tempfile.mkdtemp(prefix="am-smoke-")
    for name in ("base.png", "arm.png", "normal_dx.png", "height.png", "emissive.png", "opacity.png"):
        with open(os.path.join(d, name), "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n")
    return d


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def run(series):
    m = load_plugin(series)
    # 版本号不写死：只要 bl_info 与 BL_VERSION 一致、系列名与目录一致即可
    want = tuple(int(x) for x in m.BL_VERSION.split("."))
    check(len(want) == 3, "插件版本应是三位：%s" % m.BL_VERSION)
    check(m.bl_info["version"] == want,
          "bl_info['version'] 与 BL_VERSION 不一致：%s vs %s" % (m.bl_info["version"], m.BL_VERSION))
    check(m.BL_SERIES == series, "BL_SERIES 与目录不一致：%s" % m.BL_SERIES)

    d = make_texture_dir()

    def p(name):
        return os.path.join(d, name)

    spec = {
        "name": "Smoke",
        "workflow": "SG",
        "maps": {
            "baseColor": {"path": p("base.png"), "channel": "rgb", "hsl": {"h": 0.6, "s": 0.5, "l": 0.5}},
            "ao": {"path": p("arm.png"), "channel": "r", "intensity": 1.0},
            "roughness": {"path": p("arm.png"), "channel": "g", "intensity": 0.8},
            "metallic": {"path": p("arm.png"), "channel": "b", "invert": True},
            "normal": {"path": p("normal_dx.png"), "channel": "rgb", "normalSpace": "dx", "intensity": 1.2},
            "height": {"path": p("height.png"), "channel": "r", "intensity": 0.4},
            "emissive": {"path": p("emissive.png"), "channel": "rgb", "intensity": 2.0},
            "opacity": {"path": p("opacity.png"), "channel": "a"},
        },
        "uv": {"repeatU": 2.0, "repeatV": 2.0, "rot": 0.5, "offsetU": 0.1, "offsetV": 0.2},
    }
    mat, applied = m.build_material(spec, "Smoke")
    check(isinstance(mat, Material), "build_material 应返回材质")
    want = {"baseColor", "ao", "roughness", "metallic", "normal", "height", "emissive", "opacity"}
    check(set(applied) == want, "通道没全接上：差 %s" % (want - set(applied)))
    links = mat.node_tree.links.items
    check(len(links) > 10, "贴图节点没连起来（links=%d）" % len(links))

    # 空 spec 不应炸
    mat2, applied2 = m.build_material({"name": "Empty", "maps": {}}, "Empty")
    check(applied2 == [], "空 spec 不应接任何通道")

    # 贴图任务
    msg = m._receive_textures({"files": [p("base.png")]})
    check("1 张" in msg, "贴图任务返回值异常：%s" % msg)

    # 不支持的模式（回库 pack 明确不做，也要给出人能看懂的提示）
    for bad, hint in (("pack", "不支持"), ("nope", "不支持")):
        try:
            m._execute({"mode": bad, "payload": {}})
        except RuntimeError as e:
            check(hint in str(e), "错误信息应提到「%s」：%s" % (hint, e))
        else:
            raise AssertionError("%s 模式应当抛错" % bad)

    # 导入格式表：常见格式都有落点
    known = {".fbx", ".glb", ".gltf", ".obj", ".dae", ".stl", ".ply", ".usd", ".usdz", ".abc"}
    covered = set()
    for exts, _cands, _label in m.IMPORTERS:
        covered |= set(exts)
    check(known <= covered, "导入格式缺：%s" % (known - covered))

    # 数值/通道小工具
    check(m._num({"a": 0.0}, "a", 0.5) == 0.0, "_num 把 0 吃掉了")
    check(m._num({"a": "x"}, "a", 0.5) == 0.5, "_num 回退异常")
    check(m._channel({"channel": "G"}) == "g", "_channel 未转小写")

    print("✔ %s 系列（Blender %s）冒烟通过：材质节点 %d 个、连线 %d 条"
          % (series, m.bl_info["blender"], len(mat.node_tree.nodes.items), len(links)))


def cleanup_temp():
    """跑完把假贴图目录删掉（每次跑都建一个，别在临时目录里攒垃圾）"""
    import glob
    import shutil
    import tempfile
    for d in glob.glob(os.path.join(tempfile.gettempdir(), "am-smoke-*")):
        shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    try:
        for s in PLUGIN_DIRS:
            run(s)
    finally:
        cleanup_temp()
    print("全部系列通过")
