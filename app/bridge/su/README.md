# AssetManager · SketchUp 桥接插件

把 AssetManager 素材库里的**模型、材质、贴图、HDRI** 直接送进 SketchUp。

## 目录结构（按 SketchUp 版本分系列）

```
bridge/su/
  2024/ 2025/ 2026/ 2027/   每个 SketchUp 年份一个系列（插件 0.1.3）
    assetmanager_su.rb           加载器（注册扩展 + 读版本号 + AM_SERIES）
    assetmanager_su/main.rb      实现主体（各系列内容一致，能力按版本自适应）
  tools/
    test_su.rb                   在 SketchUp 里跑的集成测试（37 / 45 项，见下）
    sync-su-bridge.mjs           系列同步（2026 是 canonical；--check 只检查；--new 2028 新建系列）
```

`2026/` 是 **canonical**：改插件只改它，然后 `node tools/sync-su-bridge.mjs` 同步到其余系列
（各系列的加载器保留自己的 `AM_SERIES`，只有 `main.rb` 被同步）。

## 各版本能力差异（同一份实现，运行时探测）

| SketchUp | Ruby | PBR 材质槽 | HDRI 环境 | GLB / GLTF 导入 | 断言 |
|---|---|---|---|---|---|
| 2024 (24.0.594) | 3.2.2 | ✗ | ✗ | ✔ | 37 |
| 2025 (25.0.660) | 3.2.2 | ✔ | ✔ | ✔ | 45 |
| 2026 (26.1.185) | 3.2.2 | ✔ | ✔ | ✔ | 45 |
| 2027 (27.0.264) | 3.4.9 | ✔ | ✔ | ✔ | 45 |

- **2024**：材质只套基础色（`texture`）+ UV 平铺；法线 / 粗糙度 / 金属度 / AO 没有槽位，
  结果消息里会写明「本版本没有 PBR 材质槽，X 未套用（需要 2025 及以上）」；HDRI 也会报明确错误
  （`SketchUp 24.0.594 没有「环境」（environments）…需要 2025 及以上`），不会静默失败。
- **只支持 2024 及以上**：2024 起才有 GLB 导入器（`glbimporter.dll`），FBX/OBJ/PLY 才能由软件转 GLB 后导入。
  更老的 2022 / 2023 已不再支持（它们的 DAE 导入器实测不可用：`model.import` 对 DAE 返回 true 却不进对象，
  连 SketchUp 自己导出的 DAE 都会让 2022 崩溃）。
- 能力探测都在 `main.rb` 顶部：`Bridge.pbr?` / `Bridge.env?` / `Bridge.supported_import_exts`
  （后者读安装目录 `Importers/*.dll`），**不按版本号硬编码**，新版本自动继承。
- 心跳会把 `pbr` / `env` / `glb` / `import` 一起上报，软件据此决定要不要转 GLB。

`assetmanager_su/` 子目录必须与加载器同名 —— 这是 SketchUp 扩展的固定结构：
加载器 `assetmanager_su.rb` 注册 `SketchupExtension`，指向 `assetmanager_su/main.rb`。

## 安装

**推荐**：AssetManager → 插件面板 → **安装/更新插件到 SketchUp**。
它会扫 `%APPDATA%\SketchUp\SketchUp <年份>\SketchUp\Plugins`，
按各 SketchUp 版本挑对应系列（2025 → `2025/`、2026 → `2026/`…）写进去，然后**重启 SketchUp**。

手动安装：把 `<年份>/assetmanager_su.rb` 和 `<年份>/assetmanager_su/` 一起拷进
`%APPDATA%\SketchUp\SketchUp <年份>\SketchUp\Plugins\`。

装好后：**扩展程序 → AssetManager**（有状态面板 / 重连 / 暂停），工具栏多一组按钮。

> 注意：SketchUp 启动后要先**打开或新建一个模型**插件才会加载；
> 停在「欢迎使用 SketchUp」窗口时所有插件都不会跑（这是 SketchUp 自身行为）。
> 本机冷启动到插件上线大约 20–30 秒。

## 版本规则

- 插件**独立编号**：第一版 `0.1.0`，之后只递增第三位（`0.1.0` → `0.1.1`…），当前 **0.1.3**。
- 只改插件、软件本体没动时**不动软件版本号**；把插件打包进软件时打包产物版本号也不变。
- 各 SketchUp 系列目录**共用同一个插件版本号**。
- 版本号只写在加载器 `assetmanager_su.rb` 的 `AM_PLUGIN_VERSION`（安装器也读这一行）。

## 协议

与 3ds Max / Blender 插件完全一致（见 `docs/06-桥接插件设计.md`）：

| 方向 | 接口 |
|---|---|
| 插件 → 软件 | `GET /api/bridge/su/next`（0.8s，空闲 16s 后降到 2s） |
| 插件 → 软件 | `POST /api/bridge/su/heartbeat`（5s，带插件版本 / 系列 / SketchUp 版本） |
| 插件 → 软件 | `POST /api/bridge/su/result`（ok / message / detail） |

端口发现：先读 `%LOCALAPPDATA%\AssetManager\bridge.json`（并探活），失败再扫 8787–8805；
每 5 秒复核一次定位文件，软件换端口就跟着切。

线程模型（SketchUp 的硬约束）：**后台 Ruby 线程只做 HTTP 取任务**，
所有改模型的动作都在主线程的 `UI.start_timer` 回调里执行。

## 能做什么

### 1. 模型导入（`import`）

调 SketchUp 自带的导入器，整段包在一个撤销点里（Ctrl+Z 能整块撤回）：

| 格式 | 说明 |
|---|---|
| `.skp .dae .glb .gltf .stl .3ds .dwg .dxf .ifc .kmz .usdz .trb` | SketchUp 2026 自带导入器（见安装目录 `Importers/*.dll`） |
| `.fbx .obj .ply` | 插件本身读不了，但**软件会先临时导出成 GLB 再发过来**（见下） |
| `.blend .max` | 软件也转不了，发送时会直接提示 |

**FBX / OBJ / PLY 自动转 GLB（软件侧 0.3.3+）**：库里 90% 的模型是 FBX，而 SketchUp 没有 FBX 导入器。
用户点「发送到… → SketchUp」时，软件（渲染端，用 three.js）把模型读出来、导出成 GLB：

- 单位按 FBX 的 `UnitScaleFactor` 折成米（厘米场景的模型也能得到正确尺寸）
- 贴图嵌进 GLB（最长边 2048），没有贴图的网格套用素材材质
- 临时文件写在**数据目录** `converted\`（素材文件不动），「清除任务记录」或超过 24 小时自动删除
- 任务标题会标注来源，例如 `Gate_001 · 导入模型（FBX→GLB）`

导入后如果几何**一个材质都没有**，而素材带了基础色贴图，会自动建材质给这些面套上。

> 注意：SketchUp 的 glTF 导入有时要等回到事件循环才把实例落进模型，
> 所以插件是「提交后再统计对象数」，大文件还会延后收尾（最多 10 秒）再回传结果。

### 2. 材质重建（`material`）

用 SketchUp **原生 PBR 材质**（不是外部渲染器的材质）：

| 素材通道 | SketchUp | 备注 |
|---|---|---|
| 基础色 baseColor | `material.texture` | 一张材质只能有一张贴图 |
| 粗糙度 roughness | `roughness_texture` + `roughness_factor` | 打包图自动**抽通道**成灰度 PNG |
| 金属度 metallic | `metallic_texture` + `metallic_factor` | 同上 |
| 环境光遮蔽 ao | `ao_texture` + `ao_strength` | 同上 |
| 法线 normal | `normal_texture` + `normal_style` + `normal_scale` | GL/DX 按素材自动设（SketchUp 默认 DirectX） |
| 透明度 opacity | ✗ | SketchUp 材质没有独立透明度通道 |
| 自发光 emissive | ✗ | 同上 |
| 高度 height | ✗ | 同上 |

- **单通道抽取**：素材里 roughness/metallic/AO 常常是同一张 ARM/ORM 打包图的不同通道，
  插件用 `Sketchup::ImageRep` 按通道重采样成灰度 PNG（最长边 1024，带强度/反相烘焙），
  缓存在 `%TEMP%\AssetManager\su_maps\`。
- **UV**：`repeatU/repeatV` → 贴图尺寸（SketchUp 的贴图尺寸单位是英寸，默认 10×10，重复 N 次即 10/N）；
  旋转/偏移 SketchUp 材质不支持，会在结果里说明。
- **原地重建**：同一素材重复发送时在原材质上重建，不会堆 `.001`；带 `assetmanager` 标记的才是"自己的"，
  用户同名材质不覆盖（会另起唯一名）。
- 完整材质规格（含 SketchUp 用不上的通道路径）写进材质的 `assetmanager` 属性字典，便于以后取用。

### 3. 贴图（`texture`）

每张贴图建一个同名材质（`Bamboo_4k_Basecolor` …），并设为当前材质，油漆桶可直接刷。
SketchUp 贴图不支持 `.exr/.hdr/.tga/.webp`（会跳过并说明）；读不出来的坏图不会留下空材质。

### 4. HDRI（`hdri`）

用 SketchUp 2026 的**环境（Environments）**：`environments.add(path)` → 设为当前 →
`use_as_skydome` + `use_for_reflections` 打开。只认 `.hdr / .exr`。
旋转 / 曝光在 SketchUp 的「环境」面板里调。

## 面板

**扩展程序 → AssetManager → 桥接状态面板**：连接状态、端口、队列、当前任务、最近 6 条事件，
以及「重连 / 探测端口 / 打开 AssetManager / 暂停」四个按钮（HtmlDialog，深色主题）。

## 集成测试

`tools/test_su.rb` 在 SketchUp 内部跑（需要一个 AssetManager 服务在跑）：

```ruby
# SketchUp 的 Ruby 控制台（窗口 → Ruby 控制台）里：
load "D:/Program/AssetManager/app/bridge/su/tools/test_su.rb"
```

脚本会造基础色贴图、单通道打包图、HDRI 环境、非法扩展名等用例，逐条断言并把结果打印到控制台。

## 已知限制

1. `.blend` / `.max` 既不能转 GLB 也不能直接导入（three 没有对应 loader）；FBX/OBJ/PLY 已由软件自动转换。
2. 透明度 / 自发光 / 高度三个通道 SketchUp 原生材质没有位置，只记录不套用。
3. 打开 HDRI（`environments.add`）在 4K EXR 上约 1–3 秒，大文件更久，期间 SketchUp 界面会卡住。
4. 模型导入是同步的，几十 MB 的 GLB 会让 SketchUp 卡 20–40 秒（状态栏有提示）。
5. 转换出来的 GLB 是临时文件，**不写回素材库**；要长期用请自己在软件里另存。
