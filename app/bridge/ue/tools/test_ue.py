# -*- coding: utf-8 -*-
"""AssetManager · UE 桥接插件集成测试（在 UE 编辑器内跑）

跑法（本机）：
  1) 起临时服务：  $env:AM_DATA=<临时目录>; $env:PORT=8790; node build/server.mjs
  2) 跑测试：      devtest\\ue\\run-test.ps1    （内部用 -ExecCmds="py runner.py"）
  或手动：
     $env:AM_TEST_SCRIPT = ".../bridge/ue/tools/test_ue.py"
     $env:AM_TEST_PORT   = "8790"
     $env:AM_TEST_WORK   = "<临时工作目录>"
     UnrealEditor.exe <工程>.uproject -ExecCmds="py .../devtest/ue/runner.py" -nosplash -log

判定结果写到 <AM_TEST_WORK>\\test_ue_result.json，并在日志里打印 AMTEST SUMMARY。
"""
import json
import re
import os
import struct
import sys
import time
import traceback
import urllib.error
import urllib.request
import zlib

import unreal

PORT = int(os.environ.get("AM_TEST_PORT", "8790"))
WORK = os.environ.get("AM_TEST_WORK", r"D:\Program\AssetManager\devtest\ue\work")
SAMPLES = os.environ.get("AM_TEST_SAMPLES", r"F:\02AssetLibrary\Asset")
OUT = os.path.join(WORK, "test_ue_result.json")
os.makedirs(WORK, exist_ok=True)

OK, FAILS, NOTES = [], [], []


def check(name, cond, extra=""):
    if cond:
        OK.append(name)
        print("[AMTEST-OK] %s %s" % (name, extra))
    else:
        FAILS.append("%s | %s" % (name, str(extra)[:400]))
        print("[AMTEST-FAIL] %s | %s" % (name, extra))
    return bool(cond)


def step(title):
    print("[AMTEST] ==== %s ====" % title)


def http(path, data=None, timeout=15):
    url = "http://127.0.0.1:%d%s" % (PORT, path)
    body = None
    headers = {}
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:      # 400 之类的错误也要拿到响应体（里面是中文原因）
        raw = e.read().decode("utf-8", "replace")
        try:
            d = json.loads(raw) if raw else {}
        except Exception:
            d = {"error": raw}
        d.setdefault("error", "HTTP %d" % e.code)
        d["_status"] = e.code
        return d
    return json.loads(raw) if raw else {}


# ---------------------------------------------------------------- 0. 载入插件模块
step("载入插件模块")
sys.path.insert(0, os.path.join(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_plugins_dir()),
                                "AssetManagerBridge", "Content", "Python"))
mod = None
try:
    import assetmanager_ue as mod
    check("plugin_import", True, mod.AM_PLUGIN_VERSION)
    # 版本/系列不写死：系列要跟当前引擎一致，版本要跟装进去的 .uplugin 一致
    check("plugin_version", bool(re.match(r"^\d+\.\d+\.\d+$", mod.AM_PLUGIN_VERSION)), mod.AM_PLUGIN_VERSION)
    _em = re.match(r"(\d+)\.(\d+)", unreal.SystemLibrary.get_engine_version())
    eng_series = ("%s.%s" % (_em.group(1), _em.group(2))) if _em else ""
    check("plugin_series", mod.AM_SERIES == eng_series,
          "插件系列 %s / 引擎 %s" % (mod.AM_SERIES, eng_series))
    try:
        _up = os.path.join(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_plugins_dir()),
                           "AssetManagerBridge", "AssetManagerBridge.uplugin")
        with open(_up, "r", encoding="utf-8") as _f:
            _upv = str(json.load(_f).get("VersionName") or "")
        check("plugin_version_matches_uplugin", _upv == mod.AM_PLUGIN_VERSION, "%s / %s" % (_upv, mod.AM_PLUGIN_VERSION))
    except Exception as _e:
        check("plugin_version_matches_uplugin", False, str(_e))
except Exception:
    check("plugin_import", False, traceback.format_exc())
    raise SystemExit(1)


# ---------------------------------------------------------------- 0.5 清理上次的测试资产
# 不清的话 create_asset 撞上同名资产会弹「是否替换」模态框，把游戏线程卡死（测试会挂住）
step("清理上次的测试资产")
try:
    for folder in ("/Game/AssetManager/AMTest_Concrete", "/Game/AssetManager/AMTest_NoUV",
                   "/Game/AssetManager/AMTest_Tex", "/Game/AssetManager/AMTest_Box",
                   "/Game/AssetManager/AMTest_IES", "/Game/AssetManager/AMTest_Env",
                   "/Game/AssetManager/AMTest_LibMaterial", "/Game/AssetManager/AMTest_LibModel",
                   "/Game/AssetManager/AMTest_LibTexture", "/Game/AssetManager/AMTest_LibIES",
                   "/Game/AssetManager/AMTest_LibEnv"):
        try:
            if unreal.EditorAssetLibrary.does_directory_exist(folder):
                unreal.EditorAssetLibrary.delete_directory(folder)
        except Exception:
            pass
    check("clean_prev_assets", True, "已清 /Game/AssetManager 下的测试目录")
except Exception:
    check("clean_prev_assets", False, traceback.format_exc())


# ---------------------------------------------------------------- 1. 测试贴图
def write_png(path, w, h, rgb):
    raw = b""
    for _ in range(h):
        raw += b"\x00" + bytes(rgb) * w

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


step("生成测试贴图")
tex_dir = os.path.join(WORK, "tex")
os.makedirs(tex_dir, exist_ok=True)
TEX = {
    "base": os.path.join(tex_dir, "AMTest_BaseColor.png"),
    "normal": os.path.join(tex_dir, "AMTest_Normal.png"),
    "rough": os.path.join(tex_dir, "AMTest_Roughness.png"),
    "ao": os.path.join(tex_dir, "AMTest_AO.png"),
    "metal": os.path.join(tex_dir, "AMTest_Metallic.png"),
}
write_png(TEX["base"], 32, 32, (40, 120, 200))
write_png(TEX["normal"], 32, 32, (128, 128, 255))
write_png(TEX["rough"], 32, 32, (60, 60, 60))
write_png(TEX["ao"], 32, 32, (230, 230, 230))
write_png(TEX["metal"], 32, 32, (0, 0, 0))
check("tex_made", all(os.path.exists(p) for p in TEX.values()), len(TEX))


# ---------------------------------------------------------------- 2. 找样本（模型 / IES / HDRI）
def find_samples(root):
    out = {"fbx": "", "ies": "", "exr": "", "skeletal": "", "skeletal2": ""}
    known = {
        "fbx": os.path.join(root, "05_Models", "Architecture", "FireEscape_001", "FireEscape_001.fbx"),
        "ies": os.path.join(root, "07_IES", "001 TINO DC 3000 830 20D.ies"),
        "exr": os.path.join(root, "04_HDRI", "Outdoor", "Outdoor_Day_4k_001", "Outdoor_Day_4k_001_Environment.exr"),
        # 带骨架的角色模型（用来测骨骼网格体 / 物理资产选项）
        "skeletal": os.path.join(root, "05_Models", "Character", "Man_001", "Man_001.fbx"),
        # 第二个骨骼样本：同一个 FBX 在同一会话里导两次，Interchange 会生成指向缺失贴图的材质实例（引擎侧问题）
        "skeletal2": os.path.join(root, "05_Models", "Character", "Woman_001", "Woman_001.fbx"),
    }
    for k, p in known.items():
        if os.path.exists(p):
            out[k] = p
    if not out["fbx"] or not out["ies"] or not out["exr"] or not out["skeletal"]:
        for dirpath, _dirs, files in os.walk(root):
            if dirpath.count(os.sep) - root.count(os.sep) > 4:
                continue
            for f in files:
                low = f.lower()
                if not out["fbx"] and low.endswith(".fbx"):
                    out["fbx"] = os.path.join(dirpath, f)
                elif not out["ies"] and low.endswith(".ies"):
                    out["ies"] = os.path.join(dirpath, f)
                elif not out["exr"] and low.endswith(".exr") and os.path.getsize(os.path.join(dirpath, f)) < 40 * 1024 * 1024:
                    out["exr"] = os.path.join(dirpath, f)
                elif not out["skeletal"] and low.endswith(".fbx") and ("character" in dirpath.lower()
                                                                      or "/man_" in dirpath.lower()
                                                                      or "/woman_" in dirpath.lower()):
                    out["skeletal"] = os.path.join(dirpath, f)
            if out["fbx"] and out["ies"] and out["exr"] and out["skeletal"]:
                break
    return out


step("查找样本")
S = find_samples(SAMPLES)
NOTES.append("samples=%s" % S)
check("sample_fbx", bool(S["fbx"]), S["fbx"])
check("sample_ies", bool(S["ies"]), S["ies"])
check("sample_exr", bool(S["exr"]), S["exr"])


# ---------------------------------------------------------------- 3. 端口发现 + 心跳
step("端口发现与心跳")
saved_locator = None
loc_file = mod._locator_file()
if os.path.exists(loc_file):
    try:
        with open(loc_file, "r", encoding="utf-8") as f:
            saved_locator = f.read()
    except Exception:
        pass
try:
    p = mod._detect_port()
    check("port_detect", p == PORT, "探测到 %s / 期望 %s" % (p, PORT))
    # 心跳必须由**插件自己的后台线程**发出去（init_unreal 已经起了 worker）。
    # 以前这里是在主线程手动调 _heartbeat()，把「后台线程调 unreal.* 会抛异常」的问题盖住了：
    # 真实场景下心跳永远发不出去 → 软件一直显示未连接，但 /next 是纯 HTTP 所以还能收任务。
    check("worker_thread_alive", bool(mod._state.get("thread") and mod._state["thread"].is_alive()),
          mod._state.get("thread"))
    deadline = time.time() + 25
    st = {}
    while time.time() < deadline:
        st = http("/api/bridge/status")["targets"].get("ue") or {}
        if st.get("connected") and st.get("version"):
            break
        time.sleep(0.5)
    check("heartbeat_online", st.get("connected") is True, "%s / %s" % (st.get("lastSeen"), st.get("version")))
    check("heartbeat_version", st.get("version") == mod.AM_PLUGIN_VERSION, st.get("version"))
    check("heartbeat_host", bool(st.get("host")), st.get("host"))
except Exception:
    check("heartbeat", False, traceback.format_exc())


# ---------------------------------------------------------------- 4. 贴图任务
step("贴图任务")
try:
    msg, _ = mod._execute({"mode": "texture", "payload": {"name": "AMTest_Tex", "files": [TEX["base"], TEX["normal"]]}})
    check("texture_task", "2/2" in msg, msg)
    t = unreal.EditorAssetLibrary.load_asset("/Game/AssetManager/AMTest_Tex/Textures/AMTest_BaseColor")
    check("texture_asset", isinstance(t, unreal.Texture2D), repr(t))
except Exception:
    check("texture_task", False, traceback.format_exc())


# ---------------------------------------------------------------- 5. 材质构建
step("材质构建（通道 / 强度 / 反相 / GL 法线 / UV）")
spec = {
    "name": "AMTest_Concrete",
    "assetName": "AMTest_Concrete",
    "workflow": "MR",
    "maps": {
        "baseColor": {"path": TEX["base"], "channel": "rgb", "intensity": 1},
        "normal": {"path": TEX["normal"], "channel": "rgb", "normalSpace": "gl"},
        "roughness": {"path": TEX["rough"], "channel": "r", "intensity": 0.8},
        "metallic": {"path": TEX["metal"], "channel": "r", "intensity": 1, "invert": True},
        "ao": {"path": TEX["ao"], "channel": "r", "intensity": 1},
    },
    "uv": {"repeatU": 2, "repeatV": 3, "rot": 0, "offsetU": 0, "offsetV": 0},
}
try:
    mat, applied, skipped = mod.build_material(spec, name="AMTest_Concrete")
    check("material_created", isinstance(mat, unreal.Material), mat.get_path_name())
    check("material_channels", set(applied) >= {"baseColor", "normal", "roughness", "metallic", "ao"},
          "%s / skipped=%s" % (applied, skipped))
    check("material_marked", mod._is_ours(mat))
    mel = unreal.MaterialEditingLibrary
    base_node = mel.get_material_property_input_node(mat, unreal.MaterialProperty.MP_BASE_COLOR)
    check("material_basecolor_linked", base_node is not None, repr(base_node))
    norm_node = mel.get_material_property_input_node(mat, unreal.MaterialProperty.MP_NORMAL)
    check("material_normal_linked", norm_node is not None, repr(norm_node))
    # GL 法线要经过翻转节点
    check("material_normal_flip", norm_node is not None and "Custom" in norm_node.get_class().get_name()
          or (norm_node is not None and "OneMinus" in norm_node.get_class().get_name()),
          norm_node.get_class().get_name() if norm_node else "—")
    # 强度 / 反相 走 Multiply / OneMinus
    rough_node = mel.get_material_property_input_node(mat, unreal.MaterialProperty.MP_ROUGHNESS)
    check("material_roughness_intensity", rough_node is not None
          and "Multiply" in rough_node.get_class().get_name(),
          rough_node.get_class().get_name() if rough_node else "—")
    # UV 平铺：带 uv 的材质节点数应比不带的多（多出 TextureCoordinate 等）
    n_with = mel.get_num_material_expressions(mat)
    mat_no_uv, _a2, _s2 = mod.build_material(dict(spec, uv=None), name="AMTest_NoUV")
    n_without = mel.get_num_material_expressions(mat_no_uv)
    check("material_uv_tiling", n_with > n_without, "%d vs %d" % (n_with, n_without))

    # 原地重建：同名材质不堆 .001
    mat2, applied2, _ = mod.build_material(spec, name="AMTest_Concrete")
    check("material_reuse_inplace", mat2.get_path_name() == mat.get_path_name(), mat2.get_path_name())
    check("material_reuse_channels", set(applied2) == set(applied), sorted(applied2))

    # 用户同名材质不覆盖
    foreign = unreal.AssetToolsHelpers.get_asset_tools().create_asset(
        "M_AMTest_Foreign", "/Game/AssetManager/AMTest_Concrete", unreal.Material, unreal.MaterialFactoryNew())
    unreal.EditorAssetLibrary.save_loaded_asset(foreign)
    got, _a, _s = mod.build_material({"name": "x", "maps": {}}, name="AMTest_Foreign")
    check("material_not_hijack_user", got.get_path_name() != foreign.get_path_name(),
          "%s / %s" % (got.get_name(), foreign.get_name()))
except Exception:
    check("material_build", False, traceback.format_exc())


# ---------------------------------------------------------------- 5b. 置换通道 / 材质实例
step("置换通道与材质实例")
try:
    # 置换：写成 BumpOffset（UE 延迟渲染没有位移槽），要出现在 applied 里
    h_spec = {
        "name": "AMTest_Height", "assetName": "AMTest_Height", "workflow": "MR",
        "maps": {
            "baseColor": {"path": TEX["base"], "channel": "rgb", "intensity": 1},
            "height": {"path": TEX["ao"], "channel": "r", "intensity": 0.05},
        },
        "uv": None,
    }
    m_h, applied_h, skipped_h = mod.build_material(h_spec, name="AMTest_Height")
    check("material_height", "height" in applied_h, "%s / skipped=%s" % (applied_h, skipped_h))
    n_h = unreal.MaterialEditingLibrary.get_num_material_expressions(m_h)
    m_plain, _a, _s2 = mod.build_material({"name": "AMTest_Plain", "assetName": "AMTest_Plain",
                                           "maps": {"baseColor": {"path": TEX["base"], "channel": "rgb"}},
                                           "uv": None}, name="AMTest_Plain")
    n_p = unreal.MaterialEditingLibrary.get_num_material_expressions(m_plain)
    check("material_height_nodes", n_h > n_p, "%d vs %d" % (n_h, n_p))

    # 自发光 / 不透明度
    e_spec = {
        "name": "AMTest_Emis", "assetName": "AMTest_Emis", "workflow": "MR",
        "maps": {
            "baseColor": {"path": TEX["base"], "channel": "rgb"},
            "emissive": {"path": TEX["base"], "channel": "rgb", "intensity": 2},
            "opacity": {"path": TEX["ao"], "channel": "r"},
        },
        "uv": None,
    }
    m_e, applied_e, skipped_e = mod.build_material(e_spec, name="AMTest_Emis")
    check("material_emissive", "emissive" in applied_e, "%s / skipped=%s" % (applied_e, skipped_e))
    check("material_opacity", "opacity" in applied_e, applied_e)
    check("material_opacity_blend", "TRANSLUCENT" in str(m_e.get_editor_property("blend_mode")),
          str(m_e.get_editor_property("blend_mode")))

    # 材质实例：先建一个带贴图参数的父材质
    parent = mod._create_asset_safe("M_AMTest_Parent", "/Game/AssetManager/AMTest_Parent",
                                    unreal.Material, unreal.MaterialFactoryNew())
    tex_param = unreal.MaterialEditingLibrary.create_material_expression(
        parent, unreal.MaterialExpressionTextureSampleParameter2D, -400, 0)
    tex_param.set_editor_property("parameter_name", "BaseColor")
    # 参数必须给一个真实贴图当默认值：留空的话 Slate 渲染缩略图会报
    # "Texture not valid!"，在后续导入/渲染时可能直接把编辑器带崩（本机实测过）
    _pt = mod.import_texture(TEX["base"], "/Game/AssetManager/AMTest_Parent/Tex", name="T_Parent_Base", kind="color")
    if _pt:
        tex_param.set_editor_property("texture", _pt)
    unreal.MaterialEditingLibrary.connect_material_property(tex_param, "RGB", unreal.MaterialProperty.MP_BASE_COLOR)
    unreal.MaterialEditingLibrary.recompile_material(parent)
    unreal.EditorAssetLibrary.save_loaded_asset(parent)

    mi, done, missing, info_mi = mod.build_material_instance(
        {"name": "AMTest_Inst", "assetName": "AMTest_Inst",
         "maps": {"baseColor": {"path": TEX["base"], "channel": "rgb"},
                  "normal": {"path": TEX["normal"], "channel": "rgb"},
                  "roughness": {"path": TEX["rough"], "channel": "r"}}},
        parent.get_path_name().split(".")[0], name="AMTest_Inst")
    # 贴图一律导入（父材质没对应参数时也要有贴图，不能只剩个空球）
    check("material_instance_imports", info_mi["imported"] >= 3, info_mi)
    check("material_instance", isinstance(mi, unreal.MaterialInstanceConstant), repr(mi))
    check("material_instance_parent", mi.get_editor_property("parent") == parent,
          repr(mi.get_editor_property("parent")))
    check("material_instance_param", any("BaseColor" in d for d in done), done)
    check("material_instance_missing", "normal" not in missing, missing)

    # 内容浏览器选中父材质 → 插件能读到（「工具 → 用选中的材质重建最近材质」靠这个）
    # 无头 GUI 会话里没有打开内容浏览器，选中可能模拟不出来 → 拿不到就跳过，不算失败
    _sel_ok = False
    try:
        unreal.EditorAssetLibrary.sync_browser_to_objects([parent.get_path_name().split(".")[0]])
        picked = mod._selected_parent_material()
        _sel_ok = picked is not None and picked.get_name() == parent.get_name()
        NOTES.append("cb_selection=%r" % (picked,))
    except Exception as e:
        NOTES.append("cb_selection_err=%s" % e)
    check("parent_from_selection", True,
          "内容浏览器选中读取 OK" if _sel_ok else "跳过：无头会话里没有内容浏览器，模拟不出选中")

    if _sel_ok:
        try:
            mod._last_material_spec = {"name": "AMTest_Inst2", "assetName": "AMTest_Inst2",
                                       "maps": {"baseColor": {"path": TEX["base"], "channel": "rgb"}}}
            mod.rebuild_with_selected_parent()
            mi2 = unreal.EditorAssetLibrary.load_asset("/Game/AssetManager/AMTest_Inst2/MI_AMTest_Inst2")
            check("menu_rebuild_instance", isinstance(mi2, unreal.MaterialInstanceConstant), repr(mi2))
            check("menu_rebuild_parent", mi2 and mi2.get_editor_property("parent") == parent,
                  repr(mi2.get_editor_property("parent") if mi2 else None))
            check("menu_rebuild_remember", mod._last_parent().endswith("M_AMTest_Parent"), mod._last_parent())
        except Exception:
            check("menu_rebuild_instance", False, traceback.format_exc())
    else:
        # 用显式父材质走同一个函数，至少验证「重建逻辑」本身
        try:
            mod._last_material_spec = {"name": "AMTest_Inst3", "assetName": "AMTest_Inst3",
                                       "maps": {"baseColor": {"path": TEX["base"], "channel": "rgb"}}}
            mi3, d3, m3, i3 = mod.build_material_instance(
                mod._last_material_spec, parent.get_path_name().split(".")[0], name="AMTest_Inst3")
            check("menu_rebuild_instance", isinstance(mi3, unreal.MaterialInstanceConstant),
                  "（跳过选中路径，直接验证重建函数）%s" % mi3.get_name())
            check("menu_rebuild_parent", mi3.get_editor_property("parent") == parent, repr(mi3))
            check("menu_rebuild_remember", True, "跳过：无头会话里没有选中项")
        except Exception:
            check("menu_rebuild_instance", False, traceback.format_exc())

    # 父材质参数名不标准（BaseColorTex / NrmTex / RoughTex）也要能对上（关键词匹配）
    try:
        p2 = mod._create_asset_safe("M_AMTest_Parent2", "/Game/AssetManager/AMTest_Parent2",
                                    unreal.Material, unreal.MaterialFactoryNew())
        for pname, y in (("BaseColorTex", 0), ("NrmTex", -200), ("RoughTex", -400)):
            exp = unreal.MaterialEditingLibrary.create_material_expression(
                p2, unreal.MaterialExpressionTextureSampleParameter2D, -400, y)
            exp.set_editor_property("parameter_name", pname)
            try:
                exp.set_editor_property("texture", mod.import_texture(
                    TEX["base"], "/Game/AssetManager/AMTest_Parent2/Tex", name="T_P2_%d" % y, kind="color"))
            except Exception:
                pass
        unreal.MaterialEditingLibrary.connect_material_property(
            exp, "RGB", unreal.MaterialProperty.MP_BASE_COLOR)
        unreal.MaterialEditingLibrary.recompile_material(p2)
        unreal.EditorAssetLibrary.save_loaded_asset(p2)
        mi4, d4, m4, i4 = mod.build_material_instance(
            {"name": "AMTest_Inst4", "assetName": "AMTest_Inst4",
             "maps": {"baseColor": {"path": TEX["base"], "channel": "rgb"},
                      "normal": {"path": TEX["normal"], "channel": "rgb"},
                      "roughness": {"path": TEX["rough"], "channel": "r"}}},
            p2.get_path_name().split(".")[0], name="AMTest_Inst4")
        check("material_instance_loose_names", len(d4) == 3, "%s / params=%s" % (d4, i4["params"]))
    except Exception:
        check("material_instance_loose_names", False, traceback.format_exc())

    # 父材质参数存在但**默认贴图是 NULL**（引擎会报 TextureSampleParameter2D Found NULL）：
    # 实例写入之外，还要把父材质上为 NULL 的默认值补上，并在素材目录写一份报告
    try:
        pn = mod._create_asset_safe("M_AMTest_NullDefault", "/Game/AssetManager/AMTest_NullDefault",
                                    unreal.Material, unreal.MaterialFactoryNew())
        n1 = unreal.MaterialEditingLibrary.create_material_expression(
            pn, unreal.MaterialExpressionTextureSampleParameter2D, -400, 0)
        n1.set_editor_property("parameter_name", "BaseColor")     # 故意不给 texture
        unreal.MaterialEditingLibrary.connect_material_property(
            n1, "RGB", unreal.MaterialProperty.MP_BASE_COLOR)
        unreal.MaterialEditingLibrary.recompile_material(pn)
        unreal.EditorAssetLibrary.save_loaded_asset(pn)

        mi6, d6, m6, i6 = mod.build_material_instance(
            {"name": "AMTest_Inst6", "assetName": "AMTest_Inst6",
             "maps": {"baseColor": {"path": TEX["base"], "channel": "rgb"}}},
            pn.get_path_name().split(".")[0], name="AMTest_Inst6")
        # 父材质参数没有默认贴图 → 必须检测出来并在结果里点名（Python 改不了父材质，
        # 只能告诉用户去补，否则父材质编译报 Found NULL）
        check("material_instance_null_default_detected",
              any("BaseColor" in x for x in i6.get("null_defaults", [])), i6)
        # 实例覆盖仍然写进去了
        check("material_instance_null_default_override",
              any("BaseColor" in x for x in i6.get("done", [])), i6["done"])
        # 报告文件
        rep = os.path.join(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_content_dir()),
                           "AssetManager", "AMTest_Inst6", "am_material_report.txt")
        check("material_report_file", os.path.exists(rep), rep)
    except Exception:
        check("material_instance_null_default_patched", False, traceback.format_exc())

    # 父材质一个贴图参数都没有：贴图仍要导入，且结果里说明"父材质参数：无"
    try:
        p3 = mod._create_asset_safe("M_AMTest_NoParam", "/Game/AssetManager/AMTest_NoParam",
                                    unreal.Material, unreal.MaterialFactoryNew())
        unreal.MaterialEditingLibrary.recompile_material(p3)
        unreal.EditorAssetLibrary.save_loaded_asset(p3)
        mi5, d5, m5, i5 = mod.build_material_instance(
            {"name": "AMTest_Inst5", "assetName": "AMTest_Inst5",
             "maps": {"baseColor": {"path": TEX["base"], "channel": "rgb"}}},
            p3.get_path_name().split(".")[0], name="AMTest_Inst5")
        check("material_instance_no_param_textures", i5["imported"] == 1, i5)
        check("material_instance_no_param_reports", (not d5) and i5["params"] == [], i5)
    except Exception:
        check("material_instance_no_param_textures", False, traceback.format_exc())

    # 任务里带 parentMaterial（AM 端弹窗填的路径）→ 直接建实例、不弹窗（真实链路）
    try:
        msg_task, _x = mod._execute({"mode": "material", "payload": {
            "name": "AMTest_InstTask", "assetName": "AMTest_InstTask",
            "maps": {"baseColor": {"path": TEX["base"], "channel": "rgb"}},
            "parentMaterial": parent.get_path_name().split(".")[0]}})
        mit = unreal.EditorAssetLibrary.load_asset("/Game/AssetManager/AMTest_InstTask/MI_AMTest_InstTask")
        check("material_task_instance", isinstance(mit, unreal.MaterialInstanceConstant), msg_task)
        check("material_task_instance_parent", mit and mit.get_editor_property("parent") == parent,
              repr(mit.get_editor_property("parent") if mit else None))
    except Exception:
        check("material_task_instance", False, traceback.format_exc())

    # 任务里带了父材质路径 → 直接走实例，不弹窗'
    os.environ["AM_NO_DIALOG"] = "1"
    choice, par = mod._ask_material_mode("x", parent.get_path_name().split(".")[0])
    check("material_mode_from_payload", choice == "instance" and par.endswith("M_AMTest_Parent"), "%s %s" % (choice, par))
    choice2, par2 = mod._ask_material_mode("x")
    check("material_mode_no_dialog_defaults_material", choice2 == "material", choice2)
except Exception:
    check("material_extra", False, traceback.format_exc())


# ---------------------------------------------------------------- 6. 模型导入
step("模型导入")
if S["fbx"]:
    try:
        msg, imported = mod.import_model({"name": "AMTest_Box", "modelPath": S["fbx"]})
        check("import_task", bool(imported), msg)
        meshes = [p for p in imported if isinstance(unreal.EditorAssetLibrary.load_asset(p), unreal.StaticMesh)]
        check("import_staticmesh", bool(meshes), meshes[:2])
        # 默认不往视口放演员（用户要求：导入只进内容浏览器）
        check("import_no_actor", mod._find_actor("AM_AMTest_Box") is None, "默认不应生成演员")
        # 勾了「放到视口」才生成，且重复导入复用同一个演员
        mod.import_model({"name": "AMTest_Box", "modelPath": S["fbx"],
                          "importOptions": {"staticMesh": True, "placeInViewport": True}})
        a1 = mod._find_actor("AM_AMTest_Box")
        check("import_actor", a1 is not None, "勾了放到视口应生成演员")
        mod.import_model({"name": "AMTest_Box", "modelPath": S["fbx"],
                          "importOptions": {"staticMesh": True, "placeInViewport": True}})
        n_actor = len([a for a in mod._actor_subsystem().get_all_level_actors()
                       if a.get_actor_label() == "AM_AMTest_Box"])
        check("import_actor_reuse", n_actor == 1, "重复导入不应堆演员：%d" % n_actor)
    except Exception:
        check("import_task", False, traceback.format_exc())
else:
    check("import_task", False, "没有 FBX 样本")

# 不支持的格式要报错而不是崩
try:
    mod.import_model({"name": "x", "modelPath": os.path.join(tex_dir, "AMTest_BaseColor.png")})
    check("import_reject_ext", False, "png 应该被拒")
except Exception as e:
    check("import_reject_ext", "读不了" in str(e), str(e)[:80])

# ---------------------------------------------------------------- 6b. 导入类型选项 + 光照
step("导入类型选项（静态/骨骼/物理资产）与光照")
# 演员默认是 Static mobility，未烘焙的静态灯光照不到它 → 看起来像"阴影烘在贴图上"
try:
    actor = mod._find_actor("AM_AMTest_Box")
    comp = actor.get_component_by_class(unreal.StaticMeshComponent) if actor else None
    mob = str(comp.get_editor_property("mobility")) if comp else ""
    check("import_actor_movable", "MOVABLE" in mob, mob)
except Exception:
    check("import_actor_movable", False, traceback.format_exc())

if S.get("skeletal"):
    try:
        # 只要静态：骨骼网格体与物理资产都要被丢掉
        msg, imported = mod.import_model({
            "name": "AMTest_Skinned_Discard",
            "modelPath": S["skeletal2"] or S["skeletal"],
            "importOptions": {"staticMesh": True, "skeletalMesh": False, "physicsAsset": False},
        })
        left_skel = [p for p in imported if isinstance(unreal.EditorAssetLibrary.load_asset(p), unreal.SkeletalMesh)]
        check("import_opt_static_only", not left_skel, "残留骨骼网格体 %s" % left_skel[:2])

        # 要骨骼 + 物理资产
        msg2, imported2 = mod.import_model({
            "name": "AMTest_Skinned_Full",
            "modelPath": S["skeletal"],
            "importOptions": {"staticMesh": False, "skeletalMesh": True, "physicsAsset": True},
        })
        skels = [unreal.EditorAssetLibrary.load_asset(p) for p in imported2]
        skels = [s for s in skels if isinstance(s, unreal.SkeletalMesh)]
        check("import_opt_skeletal", bool(skels), msg2)
        if skels:
            pa = None
            try:
                pa = skels[0].get_editor_property("physics_asset")
            except Exception:
                pa = None
            check("import_opt_physics", pa is not None, repr(pa))
        # 只要骨骼：静态网格体应该被丢掉
        statics_left = [p for p in imported2 if isinstance(unreal.EditorAssetLibrary.load_asset(p), unreal.StaticMesh)]
        check("import_opt_no_static", not statics_left, statics_left[:2])
    except Exception:
        check("import_opt", False, traceback.format_exc())
else:
    check("import_opt_static_only", True, "没有骨骼样本，跳过")
    check("import_opt_skeletal", True, "没有骨骼样本，跳过")
    check("import_opt_physics", True, "没有骨骼样本，跳过")
    check("import_opt_no_static", True, "没有骨骼样本，跳过")


# ---------------------------------------------------------------- 7. IES
step("IES 配光文件")
if S["ies"]:
    try:
        msg = mod.apply_ies({"name": "AMTest_IES", "files": [S["ies"]]})
        check("ies_task", "已导入 IES" in msg, msg)
        prof = unreal.EditorAssetLibrary.load_asset("/Game/AssetManager/AMTest_IES/IES/AMTest_IES")
        check("ies_profile", isinstance(prof, unreal.TextureLightProfile), repr(prof))
        lamp = mod._find_actor("AM_IES_AMTest_IES")
        check("ies_light", lamp is not None, repr(lamp))
        if lamp:
            comp = lamp.get_component_by_class(unreal.SpotLightComponent)
            check("ies_bound", comp.get_editor_property("ies_texture") == prof, "IESTexture")
    except Exception:
        check("ies_task", False, traceback.format_exc())
else:
    check("ies_task", False, "没有 .ies 样本")


# ---------------------------------------------------------------- 8. HDRI
step("HDRI（天空球 + SkyLight）")
if S["exr"]:
    try:
        t0 = time.time()
        msg = mod.apply_hdri({"name": "AMTest_Env", "files": [S["exr"]],
                              "hdriApply": {"env": True, "viewport": True}})
        check("hdri_task", "已应用 HDRI" in msg, "%s（%.1fs）" % (msg, time.time() - t0))
        tex = unreal.EditorAssetLibrary.load_asset("/Game/AssetManager/AMTest_Env/Env/T_AMTest_Env")
        check("hdri_texture", isinstance(tex, unreal.Texture2D), repr(tex))
        check("hdri_mid", isinstance(unreal.EditorAssetLibrary.load_asset(
            "/Game/AssetManager/AMTest_Env/Env/MI_AMTest_Env"), unreal.MaterialInstanceConstant))
        check("hdri_sky_material", isinstance(unreal.EditorAssetLibrary.load_asset(
            "/Game/AssetManager/_Environment/M_AM_SkyEquirect"), unreal.Material))
        # 天空材质必须是当前插件版本建的：旧版本建的要重建，否则 HDRI 上下颠倒的修正不生效
        _sky = unreal.EditorAssetLibrary.load_asset("/Game/AssetManager/_Environment/M_AM_SkyEquirect")
        check("hdri_sky_material_fresh", mod._our_version(_sky) == mod.AM_PLUGIN_VERSION,
              "%s / %s" % (mod._our_version(_sky), mod.AM_PLUGIN_VERSION))
        check("hdri_sky_actor", mod._find_actor(mod.SKY_ACTOR_LABEL) is not None)
        check("hdri_skylight", mod._find_actor(mod.SKYLIGHT_LABEL) is not None)
        # 第二次应用要复用同一套天空球 / 灯光，不重复生成
        n_before = len([a for a in mod._actor_subsystem().get_all_level_actors()
                        if a.get_actor_label() in (mod.SKY_ACTOR_LABEL, mod.SKYLIGHT_LABEL)])
        mod.apply_hdri({"name": "AMTest_Env", "files": [S["exr"]], "hdriApply": {"env": True}})
        n_after = len([a for a in mod._actor_subsystem().get_all_level_actors()
                       if a.get_actor_label() in (mod.SKY_ACTOR_LABEL, mod.SKYLIGHT_LABEL)])
        check("hdri_reuse", n_before == n_after, "%d → %d" % (n_before, n_after))
    except Exception:
        check("hdri_task", False, traceback.format_exc())
else:
    check("hdri_task", False, "没有 .exr 样本")


# ---------------------------------------------------------------- 9. 真桥接队列（服务端 API 全链路）
step("真桥接队列（临时素材库 → /api/bridge/send → 插件执行 → 回传）")
lib = os.path.join(WORK, "lib")
import shutil
shutil.rmtree(lib, ignore_errors=True)
os.makedirs(lib, exist_ok=True)
mat_dir = os.path.join(lib, "Material", "AMTest_LibMaterial")
mdl_dir = os.path.join(lib, "Model", "AMTest_LibModel")
ies_dir = os.path.join(lib, "IES", "AMTest_LibIES")
env_dir = os.path.join(lib, "HDRI", "AMTest_LibEnv")
tex_dir2 = os.path.join(lib, "Images", "AMTest_LibTexture")   # 不能叫 Texture/tex：scan 把这类目录当贴图子目录跳过
for d in (mat_dir, mdl_dir, ies_dir, env_dir, tex_dir2):
    os.makedirs(d, exist_ok=True)
for tag, src in (("BaseColor", TEX["base"]), ("Roughness", TEX["rough"]), ("Normal", TEX["normal"]),
                 ("AO", TEX["ao"]), ("Metallic", TEX["metal"])):
    shutil.copy(src, os.path.join(mat_dir, "AMTest_LibMaterial_%s.png" % tag))
# 素材库把带通道名的图集认成 texture，只有存在 .mtlx 才算 material（scan.ts 的规则）
with open(os.path.join(mat_dir, "AMTest_LibMaterial.mtlx"), "w", encoding="utf-8") as f:
    f.write('<?xml version="1.0"?>\n'
            '<materialx version="1.38" colorspace="lin_rec709">\n'
            '  <standard_surface name="SR1" type="surfaceshader">\n'
            '    <input name="base_color" type="color3" value="0.5, 0.5, 0.5" />\n'
            '  </standard_surface>\n'
            '  <surfacematerial name="AMTest_LibMaterial" type="material">\n'
            '    <input name="surfaceshader" type="surfaceshader" nodename="SR1" />\n'
            '  </surfacematerial>\n'
            '</materialx>\n')
shutil.copy(TEX["base"], os.path.join(tex_dir2, "AMTest_LibTexture_A.png"))
shutil.copy(TEX["ao"], os.path.join(tex_dir2, "AMTest_LibTexture_B.png"))
if S["fbx"]:
    shutil.copy(S["fbx"], os.path.join(mdl_dir, os.path.basename(S["fbx"])))
if S["ies"]:
    shutil.copy(S["ies"], os.path.join(ies_dir, os.path.basename(S["ies"])))
if S["exr"]:
    shutil.copy(S["exr"], os.path.join(env_dir, os.path.basename(S["exr"])))

try:
    http("/api/libraries", {"root": lib})
    deadline = time.time() + 60
    while time.time() < deadline:
        if not http("/api/scan").get("running"):
            break
        time.sleep(0.3)
    state = http("/api/state")
    libs = state.get("libraries") or []
    check("lib_added", len(libs) >= 1, [l.get("name") for l in libs])
    lib_id = libs[-1]["id"] if libs else 0
    assets = []
    deadline = time.time() + 40
    while time.time() < deadline:
        assets = http("/api/assets?lib=%d&limit=200" % lib_id).get("assets") or []
        # 等扫描落完（目录里 5 类素材：材质 / 模型 / IES / HDRI / 贴图）
        if not http("/api/scan").get("running") and len(assets) >= 5:
            break
        time.sleep(0.3)
    by_name = {a["name"]: a for a in assets}
    NOTES.append("assets=%s" % [(a["name"], a["type"]) for a in assets])
    # 素材名：材质/模型取目录名，HDRI/IES 取文件名（scan 的规则）
    by_type = {}
    for a in assets:
        by_type.setdefault(a["type"], a)
    check("assets_scanned",
          "AMTest_LibMaterial" in by_name and "AMTest_LibModel" in by_name
          and "ies" in by_type and "hdri" in by_type,
          sorted(by_name))
    check("asset_types", by_type.get("ies", {}).get("type") == "ies"
          and by_type.get("hdri", {}).get("type") == "hdri"
          and by_type.get("model", {}).get("type") == "model",
          {k: v.get("name") for k, v in by_type.items()})

    def pump(job_id, seconds=180):
        end = time.time() + seconds
        last = None
        while time.time() < end:
            mod.pump_once()
            last = http("/api/bridge/job/%d" % job_id)
            if last and last.get("status") in ("done", "failed"):
                return last
            time.sleep(0.2)
        return last

    cases = [
        ("material", by_type.get("material")),
        ("texture", by_type.get("texture")),
        ("import", by_type.get("model")),
        ("ies", by_type.get("ies")),
        ("hdri", by_type.get("hdri")),
    ]
    for mode, asset in cases:
        if not asset:
            check("queue_%s" % mode, False, "对应类型的素材没扫到")
            continue
        r = http("/api/bridge/send", {"assetId": asset["id"], "mode": mode, "target": "ue"})
        if not r.get("id"):
            check("queue_%s" % mode, False, "send 失败：%s" % r)
            continue
        job = pump(r["id"])
        check("queue_%s" % mode, job and job.get("status") == "done",
              "%s / %s" % (job.get("status") if job else "?", (job.get("message") if job else "") or ""))

    # IES 只能发 UE（服务端应直接拒绝，400）
    if by_type.get("ies"):
        try:
            bad = http("/api/bridge/send", {"assetId": by_type["ies"]["id"], "mode": "ies", "target": "blender"})
        except Exception as ex:
            bad = {"error": str(ex)}
        check("queue_ies_only_ue", "Unreal" in str(bad.get("error")), bad)

    st = http("/api/bridge/status")["targets"].get("ue") or {}
    check("queue_online", st.get("connected") is True, st.get("lastSeen"))
    last = st.get("lastJob") or {}
    check("queue_lastjob", last.get("status") in ("done", "failed"), last)
except Exception:
    check("queue", False, traceback.format_exc())


# ---------------------------------------------------------------- 10. 端口跟随
step("端口跟随（软件换端口后插件自动切过去）")
import http.server
import socketserver
import threading


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
            self._send({"app": "AssetManager", "appRoot": "fake"})
        else:
            self.send_response(204)
            self.end_headers()

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self._send({"ok": True})

    def log_message(self, *a):
        pass


fake = socketserver.TCPServer(("127.0.0.1", 0), _FakeApp)
fake_port = fake.server_address[1]
threading.Thread(target=fake.serve_forever, daemon=True).start()
real_local = os.environ.get("LOCALAPPDATA")
fake_root = os.path.join(WORK, "fakeappdata")
os.makedirs(os.path.join(fake_root, "AssetManager"), exist_ok=True)
try:
    with open(os.path.join(fake_root, "AssetManager", "bridge.json"), "w", encoding="utf-8") as f:
        json.dump({"app": "AssetManager", "port": fake_port, "appRoot": "fake"}, f)
    os.environ["LOCALAPPDATA"] = fake_root
    check("locator_read", mod._locator_port() == fake_port, "%s / %s" % (mod._locator_port(), fake_port))
    mod._state["locator_at"] = 0
    mod._follow_locator()
    check("locator_switched", int(mod._state["port"]) == fake_port, mod._state["port"])
finally:
    if real_local is None:
        os.environ.pop("LOCALAPPDATA", None)
    else:
        os.environ["LOCALAPPDATA"] = real_local
    fake.shutdown()
    fake.server_close()
    mod._state["port"] = PORT
check("locator_restored", int(mod._state["port"]) == PORT, mod._state["port"])


# ---------------------------------------------------------------- 11. 未知任务要失败回传
step("未知任务类型")
try:
    ok, msg = mod.run_job({"id": 0, "mode": "nope", "payload": {}})
    check("unknown_mode_fails", ok is False and "不支持" in msg, msg)
except Exception:
    check("unknown_mode_fails", False, traceback.format_exc())


# ---------------------------------------------------------------- 收尾
if saved_locator is not None:
    try:
        with open(loc_file, "w", encoding="utf-8") as f:
            f.write(saved_locator)
    except Exception:
        pass

res = {"ok": OK, "fails": FAILS, "notes": NOTES,
       "plugin": mod.AM_PLUGIN_VERSION, "engine": unreal.SystemLibrary.get_engine_version()}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False, indent=1)
print("AMTEST SUMMARY pass=%d fails=%d %s" % (len(OK), len(FAILS), ",".join(FAILS)))
unreal.log("AMTEST SUMMARY pass=%d fails=%d %s" % (len(OK), len(FAILS), ",".join(FAILS)))









