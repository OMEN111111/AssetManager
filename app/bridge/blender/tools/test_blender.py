# -*- coding: utf-8 -*-
"""Blender 端集成测试（在 Blender 里跑，开发用）

做六件事，任何一步失败都会以非 0 退出码结束：

  1. 按用户的方式安装并启用插件（addon_install / addon_enable），校验 bl_info、注册项、端口自动发现
  2. 用真实贴图重建材质，逐个检查 BSDF 插槽是否接上、透明模式、节点/连线数量
  3. 导出 FBX / GLB / OBJ 模型再走插件的导入流程，检查集合归类、材质套用、选中与光标偏移
  4. 起临时素材库 + 走真实桥接协议（心跳 / next / 执行 / result），确认任务被插件执行成功
  5. 端口跟随：软件换端口后（假服务 + 假 bridge.json）插件应自动切过去，避免「软件说未检测到 Blender」
  6. 材质原地重建：同名材质不堆 .001、已赋对象的材质跟着更新、别人的同名材质不被覆盖

用法（PowerShell）：
    blender --background --python tools/test_blender.py -- ^
        <插件路径> <服务端口> <工作目录>

依赖：AssetManager 已在该端口启动，且带临时数据目录（AM_DATA）。
"""
import bpy
import os
import sys
import json
import time
import shutil
import importlib
import traceback
import urllib.request

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(ARGS) < 3:
    print("AMTEST FAIL args 需要：<插件路径> <服务端口> <工作目录>")
    sys.exit(2)
PLUGIN, PORT, WORK = os.path.abspath(ARGS[0]), int(ARGS[1]), os.path.abspath(ARGS[2])
MODULE = "assetmanager_blender"

FAILS = []


def step(text):
    print("AMSTEP " + text)


def check(name, cond, info=""):
    print("%s %s%s" % ("AMTEST PASS" if cond else "AMTEST FAIL", name, ("  " + str(info)) if info else ""))
    if not cond:
        FAILS.append(name)


def http(path, data=None, timeout=10):
    url = "http://127.0.0.1:%d%s" % (PORT, path)
    body = json.dumps(data).encode("utf-8") if data is not None else None
    headers = {"Content-Type": "application/json"} if body else {}
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw.decode("utf-8")) if raw else None


def wipe_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)


def make_png(name, rgba):
    img = bpy.data.images.new(name, 8, 8, alpha=True)
    img.pixels = list(rgba) * (8 * 8)
    img.file_format = "PNG"
    path = os.path.join(WORK, "tex", name + ".png")
    img.filepath_raw = path
    img.save()
    bpy.data.images.remove(img)
    return path


def principled(mat):
    for node in mat.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            return node
    return None


# ---------------------------------------------------------------- 1. 安装插件

step("安装并启用插件（%s）" % PLUGIN)
installed = False
try:
    installed = "FINISHED" in bpy.ops.preferences.addon_install(filepath=PLUGIN)
    print("AMTEST note addon_install -> %s" % installed)
except Exception as e:
    print("AMTEST note addon_install 不可用：%s" % e)
if not installed:
    addons = bpy.utils.user_resource("SCRIPTS", path="addons", create=True)
    shutil.copy(PLUGIN, os.path.join(addons, MODULE + ".py"))
    importlib.invalidate_caches()
    print("AMTEST note 已手工放入 %s" % addons)

enabled = False
try:
    enabled = "FINISHED" in bpy.ops.preferences.addon_enable(module=MODULE)
except Exception as e:
    print("AMTEST note addon_enable 失败：%s" % e)
mod = sys.modules.get(MODULE)
check("addon_enabled", enabled and mod is not None)
if mod is None:
    print("AMTEST FAIL 没有加载到插件模块，后续测试无法进行")
    sys.exit(1)

check("bl_info_name", mod.bl_info.get("name") == "AssetManager Bridge", mod.bl_info.get("name"))
check("bl_info_version", mod.bl_info.get("version") == tuple(int(x) for x in mod.BL_VERSION.split(".")), mod.bl_info.get("version"))
check("bl_info_blender", mod.bl_info.get("blender") == (5, 2, 0), mod.bl_info.get("blender"))
check("bl_version", len(mod.BL_VERSION.split(".")) == 3, mod.BL_VERSION)
check("bl_series", bool(mod.BL_SERIES), mod.BL_SERIES)
check("scene_prop", hasattr(bpy.types.Scene, "am_port"), "Scene.am_port")
check("panel_registered", hasattr(bpy.types, "AM_PT_panel"))


def op_exists(idname):
    """5.x 起 bpy.types 不再暴露 Python 类，注册与否只能看 bpy.ops 里有没有"""
    group, name = idname.split(".")
    try:
        getattr(getattr(bpy.ops, group), name)
        return True
    except Exception:
        return False


for idname in ("assetmanager.connect", "assetmanager.disconnect", "assetmanager.detect"):
    check("op_" + idname.split(".")[1], op_exists(idname), idname)
try:
    r = bpy.ops.assetmanager.detect()
    check("op_detect_runs", "FINISHED" in r, r)
except Exception as e:
    check("op_detect_runs", False, "%s: %s" % (type(e).__name__, e))
check("port_autodetect", int(mod._state["port"]) == PORT, "state=%s 期望 %s" % (mod._state["port"], PORT))


# ---------------------------------------------------------------- 2. 材质重建

step("用真实贴图重建材质")
os.makedirs(os.path.join(WORK, "tex"), exist_ok=True)
tex = {
    "base": make_png("T_BaseColor", (0.8, 0.4, 0.2, 1.0)),
    "arm": make_png("T_ARM", (0.9, 0.5, 0.1, 1.0)),
    "normal": make_png("T_NormalDX", (0.5, 0.5, 1.0, 1.0)),
    "height": make_png("T_Height", (0.5, 0.5, 0.5, 1.0)),
    "emissive": make_png("T_Emissive", (0.1, 0.9, 0.2, 1.0)),
    "opacity": make_png("T_Opacity", (1.0, 1.0, 1.0, 1.0)),
}
spec = {
    "name": "AMTest_Mat",
    "workflow": "SG",
    "maps": {
        "baseColor": {"path": tex["base"], "channel": "rgb", "intensity": 1.0,
                      "hsl": {"h": 0.55, "s": 0.6, "l": 0.45}},
        "ao": {"path": tex["arm"], "channel": "r", "intensity": 1.0},
        "roughness": {"path": tex["arm"], "channel": "g", "intensity": 0.8},
        "metallic": {"path": tex["arm"], "channel": "b", "invert": True},
        "normal": {"path": tex["normal"], "channel": "rgb", "normalSpace": "dx", "intensity": 1.2},
        "height": {"path": tex["height"], "channel": "r", "intensity": 0.4},
        "emissive": {"path": tex["emissive"], "channel": "rgb", "intensity": 2.0},
        "opacity": {"path": tex["opacity"], "channel": "a"},
    },
    "uv": {"repeatU": 2.0, "repeatV": 3.0, "rot": 0.5, "offsetU": 0.1, "offsetV": 0.2},
}
mat, applied = mod.build_material(spec, "AMTest_Mat")
bsdf = principled(mat)
check("material_built", mat is not None and bsdf is not None)
check("material_channels", set(applied) == {"baseColor", "ao", "roughness", "metallic", "normal", "height", "emissive", "opacity"}, sorted(applied))
for slot, inp in (("基础色", "Base Color"), ("粗糙度", "Roughness"), ("金属度", "Metallic"),
                  ("法线", "Normal"), ("不透明度", "Alpha"), ("自发光", "Emission Color")):
    check("linked_" + inp.replace(" ", "_"), bsdf.inputs[inp].is_linked, inp)
check("emission_strength", abs(bsdf.inputs["Emission Strength"].default_value - 2.0) < 1e-4,
      bsdf.inputs["Emission Strength"].default_value)
check("alpha_mode", getattr(mat, "surface_render_method", "") == "DITHERED", getattr(mat, "surface_render_method", "—"))
check("node_count", len(mat.node_tree.nodes) >= 14, len(mat.node_tree.nodes))
check("link_count", len(mat.node_tree.links) >= 16, len(mat.node_tree.links))
tex_nodes = [n for n in mat.node_tree.nodes if n.type == "TEX_IMAGE"]
check("image_nodes", len(tex_nodes) >= 6, len(tex_nodes))
# 打包图（ARM 同时给 AO / 粗糙 / 金属三处用）只应建一个贴图节点（0.1.4 的贴图缓存）
arm_nodes = [n for n in tex_nodes if n.image and "T_ARM" in n.image.name]
check("packed_map_shared", len(arm_nodes) == 1, len(arm_nodes))
check("noncolor_maps", all(n.image.colorspace_settings.name in ("Non-Color", "非彩色")
                           for n in tex_nodes if "T_ARM" in (n.image.name if n.image else "") or "T_Height" in (n.image.name if n.image else "")),
      [n.image.colorspace_settings.name for n in tex_nodes])

empty_mat, empty_applied = mod.build_material({"name": "AMTest_Empty", "maps": {}}, "AMTest_Empty")
check("empty_spec_ok", empty_applied == [] and empty_mat is not None)


# ---------------------------------------------------------------- 3. 导出模型 + 导入

step("导出测试模型（FBX / GLB / OBJ / STL）")
os.makedirs(os.path.join(WORK, "models"), exist_ok=True)
wipe_scene()
bpy.ops.mesh.primitive_cube_add(size=2)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.6, location=(2.0, 0.0, 0.0))
models = {}
try:
    p = os.path.join(WORK, "models", "AMTest_Box.fbx")
    bpy.ops.export_scene.fbx(filepath=p, use_selection=False)
    models[".fbx"] = p
except Exception as e:
    print("AMTEST note FBX 导出失败：%s" % e)
try:
    p = os.path.join(WORK, "models", "AMTest_Box.glb")
    bpy.ops.export_scene.gltf(filepath=p, export_format="GLB")
    models[".glb"] = p
except Exception as e:
    print("AMTEST note GLB 导出失败：%s" % e)
try:
    p = os.path.join(WORK, "models", "AMTest_Box.obj")
    bpy.ops.wm.obj_export(filepath=p)
    models[".obj"] = p
except Exception as e:
    print("AMTEST note OBJ 导出失败：%s" % e)
for fn in ("wm.stl_export", "export_mesh.stl"):
    try:
        p = os.path.join(WORK, "models", "AMTest_Box.stl")
        getattr(bpy.ops, fn.split(".")[0]).__getattr__(fn.split(".")[1])(filepath=p)
        models[".stl"] = p
        break
    except Exception:
        continue
check("models_exported", len(models) >= 3, sorted(models))

step("走插件导入流程")
for ext, path in models.items():
    wipe_scene()
    bpy.context.scene.cursor.location = (1.0, 2.0, 3.0)
    payload = {
        "assetId": 0, "name": "AMTest_" + ext.strip("."),
        "modelPath": path, "ext": ext,
        "material": spec if ext == ".fbx" else None,
        "sourceDir": os.path.dirname(path),
    }
    before = set(bpy.data.objects)
    try:
        msg = mod._execute({"mode": "import", "payload": payload})
        err = None
    except Exception as e:
        msg, err = "", "%s: %s" % (type(e).__name__, e)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    check("import%s_ok" % ext.replace(".", "_"), err is None and len(meshes) > 0, err or msg)
    if err is None:
        col = bpy.data.collections.get(payload["name"])
        check("import%s_collection" % ext.replace(".", "_"), col is not None and len(col.objects) == len(new),
              "%s / %d" % (col.name if col else "—", len(col.objects) if col else 0))
        check("import%s_selected" % ext.replace(".", "_"),
              all(o.select_get() for o in new) and bpy.context.view_layer.objects.active in new)
        if new:
            check("import%s_cursor" % ext.replace(".", "_"),
                  abs(new[0].location.z - 3.0) < 1e-3 or any(abs(o.location.z - 3.0) < 1e-3 for o in new),
                  [tuple(round(v, 2) for v in o.location) for o in new[:3]])
        if ext == ".fbx":
            with_mat = [o for o in meshes if o.data.materials]
            check("import_material_applied", len(with_mat) == len(meshes), "%d/%d" % (len(with_mat), len(meshes)))


# ---------------------------------------------------------------- 4. 贴图任务 + 真实桥接协议

step("贴图任务")
try:
    msg = mod._execute({"mode": "texture", "payload": {"files": [tex["base"], tex["normal"]]}})
    check("texture_task", "2 张" in msg, msg)
except Exception as e:
    check("texture_task", False, "%s: %s" % (type(e).__name__, e))

step("搭临时素材库并通过服务端跑任务")
lib = os.path.join(WORK, "lib")
matdir = os.path.join(lib, "Material", "AMTest_Concrete")
mdldir = os.path.join(lib, "Model", "AMTest_Box")
os.makedirs(matdir, exist_ok=True)
os.makedirs(mdldir, exist_ok=True)
for tag, src in (("BaseColor", tex["base"]), ("Roughness", tex["arm"]), ("Normal", tex["normal"]),
                 ("AO", tex["arm"]), ("Height", tex["height"])):
    shutil.copy(src, os.path.join(matdir, "AMTest_Concrete_%s.png" % tag))
if ".fbx" in models:
    shutil.copy(models[".fbx"], os.path.join(mdldir, "AMTest_Box.fbx"))

http("/api/libraries", {"root": lib})
deadline = time.time() + 30
while time.time() < deadline:
    if not http("/api/scan").get("running"):
        break
    time.sleep(0.3)
state = http("/api/state")
libs = state.get("libraries") or []
check("library_added", len(libs) >= 1, [l.get("name") for l in libs])
lib_id = libs[-1]["id"] if libs else 0

deadline = time.time() + 20
assets = []
while time.time() < deadline:
    assets = http("/api/assets?lib=%d&limit=100" % lib_id).get("assets") or []
    if assets:
        break
    time.sleep(0.3)
by_name = {a["name"]: a["id"] for a in assets}
check("assets_scanned", "AMTest_Concrete" in by_name and "AMTest_Box" in by_name, sorted(by_name))


def pump(job_id, seconds=40):
    """主线程泵：后台模式没有事件循环，手动调用插件的 timer"""
    end = time.time() + seconds
    last = None
    while time.time() < end:
        mod._timer()
        job = http("/api/bridge/job/%d" % job_id)
        last = job
        if job and job.get("status") in ("done", "failed"):
            return job
        time.sleep(0.2)
    return last


if "AMTest_Concrete" in by_name:
    r = http("/api/bridge/send", {"assetId": by_name["AMTest_Concrete"], "mode": "material", "target": "blender"})
    job = pump(r["id"])
    check("bridge_material_job", job and job.get("status") == "done",
          "%s / %s" % (job.get("status") if job else "?", job.get("message") if job else ""))

if "AMTest_Box" in by_name:
    wipe_scene()
    r = http("/api/bridge/send", {"assetId": by_name["AMTest_Box"], "mode": "import", "target": "blender"})
    job = pump(r["id"])
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    check("bridge_import_job", job and job.get("status") == "done", job.get("message") if job else "?")
    check("bridge_import_mesh", len(meshes) > 0, len(meshes))

status = http("/api/bridge/status")["targets"].get("blender") or {}
check("heartbeat_online", status.get("connected") is True, status.get("lastSeen"))
check("heartbeat_version", status.get("version") == mod.BL_VERSION, status.get("version"))
check("heartbeat_host", bool(status.get("host")), status.get("host"))


# ---------------------------------------------------------------- 5. 端口跟随（0.1.2）
# 软件重启 / 便携版每次解压到不同路径都会换端口，插件必须跟着 %LOCALAPPDATA%\AssetManager\bridge.json 走，
# 否则就会出现「软件说未检测到 Blender」。这里用一个假服务 + 假定位文件验证。
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
    check("locator_read", mod._locator_port() == fake_port, "读到的端口 %s / 期望 %s" % (mod._locator_port(), fake_port))
    check("locator_notice_switch", mod._follow_locator() is True, "端口没变时不会切换")
    check("locator_switched", int(mod._state["port"]) == fake_port, mod._state["port"])
    check("locator_no_loop", mod._follow_locator() is False, "同一端口不应反复切换")
finally:
    if real_localappdata is None:
        os.environ.pop("LOCALAPPDATA", None)
    else:
        os.environ["LOCALAPPDATA"] = real_localappdata
    fake.shutdown()
    fake.server_close()
    # 切回真端口，后面的收尾不报错
    mod._state["port"] = PORT
check("locator_restored", int(mod._state["port"]) == PORT, mod._state["port"])


# ---------------------------------------------------------------- 6. 材质原地重建（0.1.3）
step("材质原地重建（同名材质不堆 .001，已赋对象的材质跟着更新）")
wipe_scene()
bpy.ops.mesh.primitive_cube_add(size=1)
cube = bpy.context.active_object
m1, a1 = mod.build_material(spec, "AMTest_Reuse")
cube.data.materials.clear()
cube.data.materials.append(m1)
n_after_first = len([m for m in bpy.data.materials if m.name.startswith("AMTest_Reuse")])
m2, a2 = mod.build_material(spec, "AMTest_Reuse")
n_after_second = len([m for m in bpy.data.materials if m.name.startswith("AMTest_Reuse")])
check("reuse_same_datablock", m1 == m2, "%s / %s" % (m1.name, m2.name))
check("reuse_no_duplicates", n_after_first == 1 and n_after_second == 1, "%d → %d" % (n_after_first, n_after_second))
check("reuse_channels_again", set(a2) == set(a1), sorted(a2))
bsdf2 = principled(m2)
check("reuse_relinked", bsdf2 is not None and bsdf2.inputs["Base Color"].is_linked, "重建后基础色仍连着")
check("reuse_output_linked", any(n.type == "OUTPUT_MATERIAL" for n in m2.node_tree.nodes), "重建后要有材质输出节点")
# 再发一次材质任务：对象槽位不该增长
msg = mod._apply_material(dict(spec, assetName="AMTest_Reuse"))
check("reuse_object_slots", len(cube.data.materials) == 1 and cube.data.materials[0] == m2,
      [m.name if m else None for m in cube.data.materials])
check("reuse_message", "原地更新" in msg, msg)
# 别人的同名材质不能被我们覆盖
foreign = bpy.data.materials.new("AMTest_Foreign")
foreign_mat, _ = mod.build_material({"name": "x", "maps": {}}, "AMTest_Foreign")
check("reuse_not_hijack_user_material", foreign_mat != foreign, "%s / %s" % (foreign_mat.name, foreign.name))


# ---------------------------------------------------------------- 收尾

mod._stop()
print("AMTEST SUMMARY fails=%d %s" % (len(FAILS), ",".join(FAILS)))
if FAILS:
    sys.exit(1)
print("AMTEST ALL GREEN")
