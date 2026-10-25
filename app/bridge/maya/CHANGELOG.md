# Changelog · Maya 桥接插件

> 插件版本独立编号：首版 `0.1.0`，之后只递增第三位（0.1.1、0.1.2…）；不跟软件版本走。
> 新增功能也同步写进 `README.md`（对外）与 `Logs/Maya插件更新.md`（历史）。

## 0.1.0（2026-10-23 · 首版）

### 新增
- **Maya 2025 桥接**（纯 Python 模块，装进 `Documents\maya\2025\modules`，重启生效，不改 Maya 安装目录、不写 `Maya.env`）。
- 主菜单栏 **AssetManager** 菜单：状态 / 重连 / 断开 / 立即处理队列 / 清理本插件建的材质 / 打开软件页面。
- 模式支持：
  - `import`：FBX / OBJ / MA / MB / ABC / USD；导入后选中新对象；素材带贴图时按素材重建材质并套给导入的网格。
  - `material`：原生 **`standardSurface`** 全通道（baseColor / AO / roughness / metalness / normal / height /
    emission / opacity），打包图按 R/G/B 抽通道且**只建一个 file 节点**，强度 / 反相 / DX 法线翻转 / UV 平铺旋转偏移，
    同名材质**原地重建**、不覆盖用户同名材质。
  - `texture`：一图一 `file` 节点（自动猜 `Raw` / `sRGB`）。
  - `hdri`：装了 Arnold 走 `aiSkyDomeLight`；没装 Arnold 退化成内翻面环境球（只当背景）。
  - `ies`：Arnold `aiPhotometricLight` + 配光文件；没有可用 Arnold 时明确报错，`.ldt` 明确报错。
- 端口发现与跟随（`%LOCALAPPDATA%\AssetManager\bridge.json` + 8787–8805 扫描）。
- 后台线程只做 HTTP、任务进队列、主线程 `pump_once()` 执行（Qt 定时器驱动，无 Qt 时退回 `evalDeferred`）。
- 服务端接入：`/api/bridge/maya/*`、`install-maya` / `maya-where`、发送目标 `maya`（含 MCP `send_to_dcc`）。
- 工具：`tools/sync-maya-bridge.mjs`（系列同步）、`tools/test_maya.py`（92 项断言）、`tools/probe_env.py`（环境探针）、
  `devtest/maya/run-test.ps1`、`devtest/maya/gui-verify.ps1`。

### 已知限制（详见 README）
- 本机 Arnold 安装不完整（`arnold.dll` 缺失）→ HDRI 只能环境球、IES 不可用。
- glTF/GLB 没有导入器；置换未接；法线与高度同时存在时只接法线。
