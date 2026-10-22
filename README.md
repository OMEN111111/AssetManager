# AssetManager

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/OMEN111111/AssetManager)](https://github.com/OMEN111111/AssetManager/releases)

本地 3D 资产库管理器：把散落在硬盘里的 **模型 / 材质 / 贴图 / 图纸 / HDRI / IES** 统一索引，提供预览、检索、标签与整理能力。纯本地运行，不上传任何文件。

![素材网格](prototype/shots/01-grid-dark.png)

## 功能

- **本地索引**：扫描素材库目录，识别材质（.mtlx / 贴图文件夹）、模型（.fbx 等）、贴图、CAD 图纸、HDRI、IES，写入本地 SQLite；文件监听让外部改动自动重扫。
- **素材网格**：缩略图、类型/格式/评分/收藏/标签筛选、目录树、分页、多选批量操作、双击放大与滚轮缩放。
- **实时预览**：
  - 模型：FBX 加载、PBR 贴图、白膜/法线/粗糙/金属/AO/颜色/自发光/棋盘格通道、线框叠加、UV 视口（多材质分格、UDIM、UV 集切换）、材质球与贴图面板、HDRI 照明、光照球。
  - 材质组装器：通道拼装、整体 UV（平铺/旋转/位移）、强度（−1…1，负数反相）、HSL、法线 GL/DX、贴图缩略图、通道预览、贴图导出与降级、.mtlx 导出。
  - HDRI 全景预览、IES 灯光预览。
- **标签体系**：两级标签、资源管理器式多选（Ctrl/Shift）、多标签 AND 筛选、批量改色/移动/删除。
- **库维护**：库体检（缺失贴图/预览/断链）、问题素材标记与忽略、整理（规范化目录）、导入去重、缩略图补全。
- **外观**：多主题（深色/浅色/透明/玻璃/图片）、无边框窗口与自绘标题栏、插件管理面板。

| 模型预览 | 材质组装器 |
| --- | --- |
| ![模型](prototype/shots/03-viewer.png) | ![材质](prototype/shots/02-assembler.png) |

## 发送到 DCC

详情页和右键统一一个入口「**→ 发送到…**」，弹层列出已连接的软件（未连接的也能发，任务排队等它启动）。
队列走本地 HTTP：插件每 0.8 秒轮询取任务、5 秒心跳、执行后回传结果；软件换端口时插件自动跟随
（读 `%LOCALAPPDATA%\AssetManager\bridge.json`，探不通则回退扫描 8787–8805）。

| 目标 | 插件 | 能做的事 |
| --- | --- | --- |
| 3ds Max | `bridge/max/`（MaxScript） | 拖放导入放置、打包选中、材质重建 |
| Blender | `bridge/blender/<Blender 版本>/`（Python，5.2 / 4.0 / 3.6） | 模型导入、PBR 材质重建、发送贴图 |
| SketchUp | `bridge/su/<SketchUp 版本>/`（Ruby，2026） | 模型导入、原生 PBR 材质、发送贴图、**HDRI 环境** |

- 插件按 DCC 版本分目录、各自独立编号（与软件版本解耦），插件面板里可一键安装到本机所有版本。
- **FBX/OBJ 自动转 GLB**：SketchUp 没有 FBX 导入器，发这类模型时软件先用 three.js 临时导出成 GLB
  （单位按 FBX 的 `UnitScaleFactor` 折成米、贴图随 GLB 嵌入），再交给 SketchUp 导入。
  转换只写数据目录 `converted\`，素材文件不动。
- **材质重建用各 DCC 的原生材质**：SketchUp 走原生 PBR（基础色 / 粗糙度 / 金属度 / AO / 法线 + UV 平铺），
  打包图（ARM/ORM）会按通道抽成灰度 PNG；同名材质原地重建不堆 `.001`，用户同名材质不覆盖。
- **HDRI**：只有 SketchUp 走 `hdri` 模式（天空盒 + 反射），其它 DCC 收到会明确回「不支持」。

## 技术栈

- Electron 35（`frame: false` 自绘标题栏）+ React 18 + TypeScript
- Vite 6 构建渲染层，esbuild 打包本地 HTTP 服务（Electron 以 `ELECTRON_RUN_AS_NODE=1` 拉起）
- three.js r186：PBR、PMREM、IES、UV/通道预览、FBX→GLB 转换（loader + GLTFExporter）
- `node:sqlite`（Node 22 内置 `DatabaseSync`）保存索引，无需额外数据库
- 桥接：本地 HTTP 队列 + 文件路径传递（大文件不走 HTTP），只监听 `127.0.0.1`

## 代码地图

| 文件 | 职责 |
| --- | --- |
| `app/electron/main.cjs` | 主进程：窗口/托盘/菜单、拉起本地服务、拖拽导出、自动更新 |
| `app/src/server/index.ts` | 全部 HTTP API：assets / asset / thumb / file / tree / stats / texture / variants / issues / tags / update / bridge / geometry |
| `app/src/core/bridge.ts` | DCC 队列、心跳、载荷（MaterialSpec）、路径反查、插件安装 |
| `app/src/core/db.ts` | SQLite 结构与访问 |
| `app/src/core/scan.ts` | 目录分类、素材集识别、预览匹配（优先同名） |
| `app/src/renderer/App.tsx` | 主界面：网格/详情/标签/设置/右键菜单/插件面板/发送到 DCC |
| `app/src/renderer/Viewer.tsx` | 模型、HDRI、IES 预览器（通道预览、UV、光照） |
| `app/src/renderer/Assembler.tsx` | 材质组装器：混合贴图、UV、强度/HSL、自定义基本体、导出 |
| `app/src/renderer/matlib.ts` | 材质构建、通道 patch、强度（1=原图，0=黑，>1 增亮） |
| `app/src/renderer/geometries.ts` | 程序化几何 + 自定义基本体 UV 重算（三向投影、圆柱摆正） |
| `app/src/renderer/thumbnailer.ts` | 透明底材质球预览、包围球取景 |
| `app/src/renderer/glbconvert.ts` | 把 FBX/OBJ/PLY 用 three 读进来再导成 GLB（给 SketchUp 用） |
| `app/bridge/max/` | 3ds Max 插件（MaxScript） |
| `app/bridge/blender/<系列>/` | Blender 插件：轮询/导入/材质/贴图，面板在 3D 视图侧栏 |
| `app/bridge/su/<系列>/` | SketchUp 插件：加载器 + 实现（轮询/导入/原生 PBR 材质/贴图/HDRI 环境/HtmlDialog 面板） |

## 目录结构

```
app/               应用本体
  electron/        主进程与 preload
  src/server/      本地 HTTP API + 静态服务
  src/core/        数据库、扫描器、桥接队列
  src/renderer/    React 界面（App / Viewer / Assembler / matlib / geometries / glbconvert）
  bridge/          DCC 插件：max/（MaxScript）、blender/<版本>/（Python）、su/<版本>/（Ruby）
  build/           构建产物与图标（server.mjs 由构建生成）
prototype/         早期界面原型与截图
devtest/           开发期的 CDP 验证脚本与测试页
```

> 需求/设计文档与版本记录只保留在本地开发环境，不随仓库与安装包发布。

## 开发

需要 Node.js 22+、pnpm。

```bash
cd app
pnpm install
pnpm build:all        # 构建渲染层 + 本地服务
pnpm app              # 启动 Electron
```

浏览器内调试（无 Electron 外壳）：

```bash
pnpm dev:api          # http://127.0.0.1:8787
pnpm dev:web          # Vite 开发服务器（可用 AM_API 指向别的实例）
```

插件测试：

```bash
# Blender：系列同步检查 + 无 Blender 冒烟（需要 Blender 的机器上再跑真机集成测试）
cd app/bridge/blender && node tools/sync-blender-bridge.mjs --check && python tools/smoke_test.py

# SketchUp：装进 Plugins 后，在 SketchUp 的 Ruby 控制台里
#   load "<仓库路径>/app/bridge/su/tools/test_su.rb"
```

## 打包

```bash
cd app
pnpm build:all
pnpm dist             # electron-builder：NSIS 安装版 + 便携版
```

产物在 `app/release/`。Windows 未签名，首次运行可能触发 SmartScreen。

> 打包/自动化环境里若父进程带了 `ELECTRON_RUN_AS_NODE=1`，双击 exe 会被当成 node 跑完立刻退出
> （无窗口、退出码 0、无日志）——打包脚本里先清掉这个变量。

## 运行环境与已知限制

- **端口复用**：主进程校验 `/api/state.appRoot`，不一致自动换端口（8787 → 8799/8805）。
- **数据目录**：开发 `app/data/`；安装版 `%APPDATA%\assetmanager-app\`
  （其中 `converted\` 是给 DCC 临时导出的模型，清除任务记录或超过 24 小时自动删除）。
- **素材文件永远只读**：软件只写索引与缩略图。
- **高 DPI**：three.js canvas 必须 `renderer.setSize(w, h, true)`。
- **无边框窗口**：预览层要 `-webkit-app-region: no-drag`，并让出 32px 标题栏。
- **SketchUp 插件加载时机**：启动后要先打开/新建模型，插件才会加载（停在欢迎窗口时所有插件都不跑）；
  冷启动到插件上线约 20–30 秒。
- 多尺寸素材按独立素材显示（不合并），尺寸角标各自显示。
- 标签只有两级。
- Max 桥接未接 AO（Physical Material 无 AO 槽）；组装器强度/HSL 未传给 Max。
- SketchUp 原生材质没有透明度 / 自发光 / 高度槽（只记录不套用）；UV 只做平铺次数，旋转/偏移不支持。
- `.blend` / `.max` 无法导入 SketchUp（three 没有对应 loader）；FBX/OBJ/PLY 已由软件自动转 GLB。
- 几十 MB 的模型转换 + 导入时 SketchUp 会卡 30–50 秒（状态栏有提示，无进度条 API）。
- 预览图透明底需重新渲染旧素材才会更新（右键「重新渲染预览图」）。
- 在线更新下载依赖镜像（gh-proxy / ghproxy）。

## 数据位置

- 开发/便携运行：`app/data/library.db`、`app/data/thumbs`
- 安装版：`%APPDATA%\assetmanager-app\`

素材文件本身始终留在原目录，软件只写索引与缩略图。

## 许可

[MIT](LICENSE)

## MCP（AI 客户端接入）

软件内置 MCP Server（默认开启，设置 → MCP 可关）：

- HTTP：`http://127.0.0.1:8787/mcp`
- stdio：`设置里显示的 mcp-stdio.mjs`（给 Claude Desktop 等只支持 stdio 的客户端）

支持的工具：`search_assets`、`get_asset`、`list_tags`、`assign_tags`、`update_asset`、
`send_to_dcc`（max / blender / su）、`rescan_library`、`bridge_status`。
默认**只读**，写操作需在设置里勾选「允许 AI 修改」。
