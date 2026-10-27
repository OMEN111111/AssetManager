# 3ds Max 插件 · 变更记录

## 0.2.1（2026-10-27）

- `macroScript AssetManagerToolbar` 宏体加保护：插件未安装/已卸载时只打印提示，不再抛
  「类型错误: 调用需要函数或类，得到的是: undefined」。
  （Max 会把宏持久化到 `usermacros\AssetManager-AssetManagerToolbar.mcr`，卸载插件后这份文件仍在。）
- 软件侧同步：安装/卸载时清理该 `.mcr`。

## 系列化（2026-10-27）

- 目录按 3ds Max 版本拆分：`2026/`、`2027/`（两份内容一致，插件版本仍 0.2.0）。
- **2027 实测通过**：`tools/test_max.ms` 17 项断言全绿
  （插件加载 / `amb_max_version` 识别 2027 / 15 个关键函数齐全 / JSON 解析 / UUID 打标与回收 /
  `amb_nodes_deep` 遍历 / `amb_maps_target` 两种情形 / `amb_sanitize_name` / HTTP `GET /api/state`、
  `GET /api/bridge/max/next`、`POST /api/bridge/max/heartbeat` / 端口探测）；2026 同脚本 17 项亦全绿。
- 安装改为**按 Max 版本挑系列**：`%LOCALAPPDATA%\Autodesk\3dsMax\<年份> - 64bit\<语言>\scripts\startup`。
- 新增 `tools/sync-max-bridge.mjs`（以最新系列为真源，`--check` 提交前跑）、`tools/probe_env.ms`。

## 0.2.0（2026-10-24）

- **导回**：按 AssetManager 下发的 UUID 收集对象，覆盖写回素材源目录（FBX/OBJ 覆盖原文件，
  其它格式另存 `<名字>_fromMax.fbx`），同时把贴图复制进素材目录、写 `asset_maps.json`，
  并 POST `/api/bridge/max/exported` 通知软件重扫。
- UUID 归属：导入时给对象打 `#ambUuid/#ambName/#ambDir/#ambModel`，子对象继承父 UUID。

## 0.1.12（2026-10-20）

- 范围收敛为三件事：拖模型进视口放置 / 打包选中 / 材质重建进紧凑编辑器。

## 0.1.x

- 拖放导入与放置对话框、打包（可选材质 + 贴图）、材质重建、HDRI、工具栏、队列轮询。
