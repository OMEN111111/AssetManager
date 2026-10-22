# AssetManager · Blender 桥接插件

在 Blender 里直接接收 AssetManager 的素材：模型导入、材质重建、贴图。协议与 3ds Max 插件完全一致，只是 `target=blender`。

> **范围**：只做「从 AssetManager 导入」，**不做回库（pack）、不做拖放**。
> 想把 Blender 里的东西收进库，目前用 Blender 自己的导出 + 软件里的导入功能。

## 目录结构（按 Blender 版本分槽）

```
app/bridge/blender/
├── 5.2/assetmanager_blender.py     # Blender 5.2 LTS+（✅ 已在 5.2.0 LTS 实测）
├── 4.0/assetmanager_blender.py     # Blender 4.0 – 4.x
├── 3.6/assetmanager_blender.py     # Blender 3.3 – 3.6 LTS
├── tools/sync-blender-bridge.mjs   # 系列同步工具（开发用，不装进 Blender）
├── tools/test_blender.py           # Blender 内的集成测试（装插件→材质→导入→协议）
├── tools/smoke_test.py             # 没有 Blender 时的冒烟测试
├── CHANGELOG.md                    # 插件版本日志
└── README.md
```

- **一个 Blender 系列一个目录**：以后接 5.0/5.1、或把 4.2+ 改成扩展（`blender_manifest.toml` + zip）时，新增目录即可，互不影响。
- **目录里的文件名固定**叫 `assetmanager_blender.py`（Blender 的「从磁盘安装」按文件名识别，改名的历史版本另存即可）。
- 每个文件内部仍是单文件插件，不依赖同目录其他文件，可以单独拷走安装。
- 实测情况：**5.2.0 LTS 已通过后台 + GUI 双模式端到端测试**；4.x 与 3.3–3.6 共用同一实现主体（只差头部元数据），但本机没有这两个版本的 Blender，未真机验证。

## 版本规则

| 对象 | 规则 |
|---|---|
| 插件版本 | **与软件版本解耦**。第一版 `0.1.0`，之后每次改动只递增**第三位**：`0.1.1`、`0.1.2`… |
| 系列之间 | 所有 Blender 系列目录**共用同一个插件版本号**，一次改动递增一次（各目录一起更新） |
| 软件版本 | 只改插件时**不动软件版本号**；若把插件打包进软件测试，打包产物的软件版本号也保持不变 |
| 版本写在哪 | 文件头部 `bl_info["version"]`（Blender 插件列表显示）+ `BL_VERSION`（心跳上报，软件面板显示） |

心跳里带 `{plugin, series, blender}`，AssetManager 的 `targets.blender.version` 就是插件版本号，能直接看出对面装的是哪个系列。

## 安装

1. 启动 AssetManager（本地服务默认 8787，被占用会漂移到 8788–8805；实际端口写在 `%LOCALAPPDATA%\AssetManager\bridge.json`）。
2. 按你的 Blender 版本选文件：

   | Blender | 选哪个 |
   |---|---|
   | 5.2 LTS 及以上 | `5.2/assetmanager_blender.py` |
   | 4.0 / 4.1 / 4.2 / 4.3 / 4.4 / 4.5 | `4.0/assetmanager_blender.py` |
   | 3.3 – 3.6 LTS | `3.6/assetmanager_blender.py` |

3. Blender → `编辑 > 偏好设置 > 插件（5.x 在「获取扩展」旁边的插件页）> 从磁盘安装…`，选中上一步的 `assetmanager_blender.py`，勾选 **AssetManager Bridge**。
4. 3D 视图按 `N` → 侧栏 **AssetManager** 标签：
   - 端口会自动探测（先读 `bridge.json`，再扫 8787–8805）；
   - 面板顶部会显示「桥接插件 v0.1.1 · Blender 5.2 系列」这类信息，确认装的是对的文件。
5. 软件里 `设置 > Blender 插件 > 打开 Blender 插件文件夹` 会把这几个系列目录整份复制到 `%APPDATA%\assetmanager-app\plugins\blender`，资源管理器打不开安装包内部路径时从这里取。

### 更省事：一键安装

软件 → 插件管理 → Blender 卡片 → 「**安装/更新插件到 Blender**」：会扫
`%APPDATA%\Blender Foundation\Blender\<版本>\scripts\addons`，按每个 Blender 版本自动挑对应系列写进去
（5.2 → `5.2/`，4.2 → `4.0/`，3.6 → `3.6/`）。装完到 偏好设置 → 插件 里勾选一次；
已经在用的直接重启 Blender 就换成新版本。

## 用法

AssetManager 里选中素材 → 右键「发送到 Blender」（或详情/右键菜单的「→ Blender」）：

- **模型**：导入到 3D 光标处，放进以素材命名的集合，并按素材贴图重建 PBR 材质。
- **材质**：赋给当前选中的网格（没选中则场景里所有网格）。
- **贴图**：把素材贴图载入为图像数据块，并在图像编辑器里显示第一张。

材质带上：通道抽取（R/G/B/打包图）、强度、反相、法线 GL/DX、AO 相乘、高度凹凸、自发光、不透明度、UV 平铺/旋转（弧度）/位移、HSL。

## 支持

| 功能 | 状态 |
|---|---|
| 轮询 / 心跳 / 结果回传 | ✅ |
| 导入 FBX / GLB / glTF / OBJ / DAE / STL / PLY / USD / Alembic | ✅（3.6 之外的格式看 Blender 自带导入器） |
| 材质重建（基础色、粗糙、金属、法线、AO、自发光、不透明度、高度、HSL、强度、反相） | ✅ |
| 发送贴图 | ✅ |
| 自动发现端口（`bridge.json` + 扫描） | ✅ |
| 端口跟随（软件重启/换端口后自动重连，0.1.2 起） | ✅ |
| 材质原地重建（同一素材重发不堆 `.001`，引用它的对象跟着更新，0.1.3 起） | ✅ |
| 一键安装到 Blender（软件里的按钮，按版本挑系列） | ✅ |
| 拖放（拖素材进 Blender） | ❌ 不做（Blender 无外部拖放接口；需要时用右键「发送到…」） |
| 打包选中对象回素材库（`pack`） | ❌ 不做（插件只做导入方向） |

> 5.2 系列已在 Blender 5.2.0 LTS 上跑过完整集成测试（后台 + GUI）：装插件 → 材质 8 个通道全接上 → FBX/GLB/OBJ/STL 导入归类 → 贴图 → 真实队列任务三条（材质 / 导入 / 贴图）全部 done。
> 3.6 / 4.0 系列与 5.2 共用同一实现主体（只差头部元数据），未在本机真机验证。

## 改插件（开发者）

实现主体（`# >>> AM_BODY >>>` 之后）**所有系列共用**，只有文件头部（`bl_info`、`BL_VERSION`、`BL_SERIES`）按系列不同。

```bash
cd app/bridge/blender
# 1) 只改 4.0/assetmanager_blender.py 的主体
# 2) 同步到其他系列（保留各自头部）
node tools/sync-blender-bridge.mjs
# 3) 提交前检查是否已同步（不一致时退出码 1）
node tools/sync-blender-bridge.mjs --check
```

- 插件版本号要**手工**在每份文件的头部改（工具会提示版本不一致，不自动改号）。
- 某个系列真要分叉时，在它头部加一行 `# SYNC: skip`，同步工具就不再覆盖它。
- 主体里涉及 Blender 版本差异的节点/操作符统一收在「节点兼容层」一段（`ShaderNodeMix` vs `MixRGB`、`Emission Color` vs `Emission`、`Fac` vs `Factor`、`surface_render_method` vs `blend_method`、`wm.obj_import` vs `import_scene.obj`、BSDF 节点名本地化…），新增系列时优先在那里补分支。

## 测试

```bash
# 没有 Blender 也能跑（假 bpy，抓结构性错误）
python tools/smoke_test.py

# 真机集成测试：先起一个临时数据目录的服务（端口 8790），再让 Blender 跑测试
blender --background --python tools/test_blender.py -- <插件路径> 8790 <工作目录>
```

`test_blender.py` 会自己做：装并启用插件（`addon_install` + `addon_enable`）、校验 `bl_info`/注册项/端口自动发现、
用真实贴图重建材质并逐个断言 BSDF 插槽、导出 FBX/GLB/OBJ/STL 再走导入流程、载入贴图、
最后建临时素材库并通过服务端发三条真实任务（材质 / 导入 / 贴图）检查 `done` 与心跳版本号。

GUI 端到端（验证 timer 在真实事件循环里执行）：用 `--python` 跑一个只做
`bpy.ops.preferences.addon_enable(module="assetmanager_blender")` 的脚本，然后从软件侧发任务、看 `/api/bridge/status`。

## 排查

- **一直「未连接」**：确认 AssetManager 在运行；点面板放大镜重新探测端口。
  0.1.2 起会自动跟随软件的端口定位文件（`%LOCALAPPDATA%\AssetManager\bridge.json`），
  软件重启/换端口后约 5 秒自动重连；定位文件指向死端口时会回退扫描 8787–8805。
- **软件说「未检测到 Blender」**：软件和插件必须连同一个实例。插件 0.1.2 已自动跟随，
  若仍不对，看面板里显示的「端口」和软件面板的「服务端口」是否一致。
- **导入报错**：对应格式的导入插件没启用（`偏好设置 > 插件` 里勾 FBX / glTF），或版本低于该系列要求。
- **材质发黑**：贴图文件被移动/改名（插件按绝对路径读原文件，不复制）；法线是 DX 时会自动翻转绿通道。
- **面板看不到结果**：`窗口 > 切换系统控制台` 里会有完整堆栈（也会显示在面板的最近事件里）。
