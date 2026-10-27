# 3ds Max 桥接插件（AssetManagerBridge）

AssetManager 里的模型 / 材质 / 贴图可以一键送进 3ds Max；改好的东西也能按 UUID 导回素材库。

## 目录（按 3ds Max 版本分系列）

```
bridge/max/
  2023/AssetManagerBridge_0.2.1.ms    3ds Max 2023
  2024/AssetManagerBridge_0.2.1.ms    3ds Max 2024
  2025/AssetManagerBridge_0.2.1.ms    3ds Max 2025
  2026/AssetManagerBridge_0.2.1.ms    3ds Max 2026
  2027/AssetManagerBridge_0.2.1.ms    3ds Max 2027（canonical）
  tools/test_max.ms             集成测试（3dsmaxbatch 里跑，30 项断言）
  tools/probe_env.ms            环境探针（只读，排查用）
  tools/sync-max-bridge.mjs     系列同步（以 2027/ 为真源；--check 提交前跑）
```

各系列**目前内容完全一致**（同一份 MAXScript，2023 / 2024 / 2025 / 2026 / 2027 实测都通过）。文件名带插件版本。
以后 Max 新版若 MAXScript 有变化，只改最新系列，其它用 `node tools/sync-max-bridge.mjs` 同步；
某系列真要分叉就在文件头部写 `-- SYNC: skip`。

## 安装

**推荐**：AssetManager 顶部「插件」→ 3ds Max 卡片 →「安装到 3ds Max」。
它会扫本机所有已存在的 Max 用户配置，**按各自的 Max 版本挑对应系列**写入：

```
%LOCALAPPDATA%\Autodesk\3dsMax\2027 - 64bit\CHS\scripts\startup\AssetManagerBridge_0.2.1.ms   <- 2027/
%LOCALAPPDATA%\Autodesk\3dsMax\2026 - 64bit\CHS\scripts\startup\AssetManagerBridge_0.2.1.ms   <- 2026/
%LOCALAPPDATA%\Autodesk\3dsMax\2025 - 64bit\CHS\scripts\startup\AssetManagerBridge_0.2.1.ms   <- 2025/
%LOCALAPPDATA%\Autodesk\3dsMax\2024 - 64bit\CHS\scripts\startup\AssetManagerBridge_0.2.1.ms   <- 2024/
%LOCALAPPDATA%\Autodesk\3dsMax\2023 - 64bit\CHS\scripts\startup\AssetManagerBridge_0.2.1.ms   <- 2023/
```

装完**重启 3ds Max**。插件随 Max 启动自动轮询，5 秒内 AssetManager 面板显示「已连接」。

**手动**：把对应版本的 `AssetManagerBridge_0.2.1.ms` 复制到上面的 startup 目录；或在 Max 里
`fileIn @"...\2027\AssetManagerBridge_0.2.1.ms"`。

## 测试（改完插件必跑）

```powershell
# 1) 系列是否一致（提交前）
cd app\bridge\max
node tools/sync-max-bridge.mjs --check

# 2) 一键真机集成测试（推荐）：起临时服务 + 按年份把插件装进各 Max 的 startup + 3dsmaxbatch 跑断言
cd D:\Program\AssetManager
pwsh -File devtest\max\run-test.ps1 -Series all          # 2023/2024/2025/2026/2027 全跑
pwsh -File devtest\max\run-test.ps1 -Series 2024         # 只跑一个版本
# 明细：devtest\max\work\test_max_<年份>.txt

# 3) 手工跑（服务已起、插件已装进 startup 时）
$env:AMB_TEST_URL = "http://127.0.0.1:8790"      # 可选：临时服务地址，验证 HTTP
& "D:\Software\01_DCC\01_Autodesk\3ds Max 2027\3dsmaxbatch.exe" `
   "D:\Program\AssetManager\app\bridge\max\tools\test_max.ms"
# 结果：%TEMP%\AssetManager\max_test.txt

# 4) 环境探针（版本 / 端口 / startup 是否装了插件）
& "D:\Software\01_DCC\01_Autodesk\3ds Max 2027\3dsmaxbatch.exe" `
   "D:\Program\AssetManager\app\bridge\max\tools\probe_env.ms"
```

> **坑**：`3dsmaxbatch` 里 `fileIn` 插件后**不会留下脚本里的 global**（2024+ 实测；只 `fileIn` 不行），
> 必须把 `.ms` 放进该 Max 的 `scripts\startup` 让 Max 启动时自己加载 —— `devtest\max\run-test.ps1` 会自动做这一步。
> 实测结论：**2024 / 2025 / 2026 / 2027 各 30 项断言全绿**（2026-10-27）；
> 2023 因本机许可未检出（`ADLSKDK_STATUS_LICENSE_NOT_CHECKED_OUT`）batch 跑不了，
> 改在**真机 GUI 2023** 验证：插件从 startup 正常加载、心跳上报 version 2023；
> 代码与 2024 系列逐字节相同。

## 真机联调（GUI 里跑真实任务）

`3dsmaxbatch` 拿不到许可、或想验证「真实 GUI 会话」时用这条（临时服务 + 临时素材库 + 发一条真实材质任务）：

```powershell
pwsh -File devtest\max\live-test.ps1          # 需要独占 8787（先关掉正在运行的 AssetManager）
```

它要求目标 Max 已打开、插件在 `scripts\startup`；脚本会等插件心跳上来、发 `material` 任务、核对回报结果，
跑完还原 `%LOCALAPPDATA%\AssetManager\bridge.json`。

## 工具栏

- 主菜单栏 **AssetManager → 打开桥接工具栏**；或 `自定义 → 自定义用户界面 → 工具栏 → 类别 AssetManager`
- 或 MaxScript 侦听器 `AssetManagerBridge_Toolbar()`

工具栏含：连接状态 / 当前素材与源目录 / **导回到源目录**（按 UUID 覆盖模型 + 贴图）/ 拖放接收区 /
母版重建 / 打包选中 / 「导入后询问摆放」开关。

## 用法

| 素材类型 | AssetManager 端 | Max 端动作 |
|---|---|---|
| 模型 / 场景 | 发送到 3ds Max | 导入 FBX/OBJ…，自动接贴图材质；按设置询问摆放位置 |
| 材质 | 发送到 3ds Max | 建 Physical Material 接贴图，赋给选中对象或放进材质编辑器 |
| 贴图 | 发送到 3ds Max | 以该图作基础色建材质 |
| HDRI | 发送到 3ds Max | 环境贴图 / 视口背景（可同时） |
| 改好的模型 | 导回到源目录（覆盖模型 + 贴图） | 按 `#ambUuid` 找回源目录，覆盖原格式并更新贴图 |

材质通道映射：

| AssetManager 通道 | 3ds Max |
|---|---|
| Base Color | `base_color_map`（sRGB） |
| Roughness | `roughness_map`（打包图 ARM 取 G） |
| Metallic | `metalness_map`（打包图 ARM 取 B） |
| Normal | `bump_map` → Normal Bump（DX 自动 Flip Green） |
| Height | 无法线时作凹凸 |
| Emissive / Opacity | `emit_color_map` / `transparency_map` |
| AO | Physical Material 无独立 AO 通道，忽略并在结果里说明 |
| UV 平铺 | 写入 bitmap 的 U/V Tiling |

## 手动命令（MaxScript 侦听器）

```maxscript
AssetManagerBridge_Status()       -- 版本/端口/连接/最近任务
AssetManagerBridge_Poll()         -- 立刻轮询一次（batch 调试用）
AssetManagerBridge_Start() / _Stop()
AssetManagerBridge_Heartbeat()
```

## 排错

- **面板一直「未连接」**：Max 是否在跑？插件是否在 startup（或 `fileIn` 过）？AssetManager 是否在跑？
  端口从 `%LOCALAPPDATA%\AssetManager\bridge.json` 读，读不到试 8787；`AssetManagerBridge_Status()` 看详情。
- **导入后没贴图**：FBX 自带材质时不会覆盖；贴图要能被 Max 找到（同名同目录）。
- **导回提示「选中对象没有素材来源（UUID）」**：对象不是从 AssetManager 导入的（或复制过丢了用户属性）。
- 离线不会卡 Max：连不上时每 8 秒才探一次，单次超时 300ms。

## 协议

```
GET  /api/bridge/max/next            取任务（204 = 无任务），取到即加 90s 租约
POST /api/bridge/max/result          { id, ok, message, detail }
POST /api/bridge/max/heartbeat       { version, host, protocol, script }
POST /api/bridge/max/exported        导回后通知 AssetManager 重扫
GET  /api/bridge/status              面板状态（connected = 6s 内有心跳）
```

任务载荷只含**文件绝对路径**与固定字段，插件不执行任何来自队列的代码。
