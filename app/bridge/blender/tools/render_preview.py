# -*- coding: utf-8 -*-
"""用真实素材在 Blender 里建材质 + 渲染预览图（无头，验证观感）

    blender --background --python tools/render_preview.py -- <assetId> <端口> <输出png>

做的事：向运行中的 AssetManager 发一次「材质」任务拿到真实 MaterialSpec（顺手把任务结果回传，
不占用队列），再用插件的 build_material 建材质，套一个球体，Cycles 渲一张预览图，
最后读回图片算平均亮度，确认不是全黑。
"""
import bpy
import sys
import json
import math
import urllib.request

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ASSET_ID, PORT, OUT = int(ARGS[0]), int(ARGS[1]), ARGS[2]

import assetmanager_blender as am  # 由外部 --python 先启用插件后可用


def http(path, data=None, timeout=20):
    url = "http://127.0.0.1:%d%s" % (PORT, path)
    body = json.dumps(data).encode("utf-8") if data is not None else None
    headers = {"Content-Type": "application/json"} if body else {}
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw.decode("utf-8")) if raw else None


print("RPREV 取真实材质载荷 assetId=%d" % ASSET_ID)
job = http("/api/bridge/send", {"assetId": ASSET_ID, "mode": "material", "target": "blender"})
payload = http("/api/bridge/blender/next")["payload"]
http("/api/bridge/blender/result", {"id": job["id"], "ok": True, "message": "render_preview 取载荷"})
print("RPREV 通道：%s" % sorted((payload.get("maps") or {}).keys()))

mat, applied = am.build_material(payload, payload.get("name") or "Preview")

# 场景：球 + 相机 + 灯 + 世界
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=64, ring_count=32)
ball = bpy.context.active_object
bpy.ops.object.shade_smooth()
ball.data.materials.append(mat)

bpy.ops.object.camera_add(location=(0.0, -5.2, 1.6), rotation=(math.radians(74), 0, 0))
cam = bpy.context.active_object
bpy.context.scene.camera = cam
cam.data.lens = 60

bpy.ops.object.light_add(type="AREA", location=(-2.6, -3.4, 3.4))
key = bpy.context.active_object
key.data.energy = 900
key.data.size = 3.0
key.rotation_euler = (math.radians(50), 0, math.radians(-35))

world = bpy.data.worlds.new("AMWorld")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.05, 0.05, 0.06, 1.0)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
bpy.context.scene.world = world

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 32
scene.render.resolution_x = 420
scene.render.resolution_y = 420
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = OUT

print("RPREV 渲染中 -> %s" % OUT)
bpy.ops.render.render(write_still=True)

img = bpy.data.images.load(OUT)
px = list(img.pixels)
rgb = [px[i] for i in range(len(px)) if i % 4 != 3]
mean = sum(rgb) / max(1, len(rgb))
print("RPREV 平均亮度 %.4f（>0.02 说明不是全黑）" % mean)
assert mean > 0.02, "渲染结果接近全黑，材质/灯光可能有问题"
print("RPREV OK 通道=%s" % "/".join(applied))
