# AssetManager · Autodesk Maya 桥接插件

纯 Python 插件，**不用编译、不改 Maya 安装目录、不写 `Maya.env`**。
装法是标准的 Maya 模块（`.mod` + `scripts/`），软件里点
「插件 → Maya → **安装/更新插件到 Maya**」就写进：

```
%USERPROFILE%\Documents\maya\<年份>\modules\AssetManagerBridge.mod      ← 模块声明（指向同目录下的插件文件夹）
%USERPROFILE%\Documents\maya\<年份>\modules\AssetManagerBridge\scripts\
    userSetup.py             Maya 启动时自动执行：起轮询线程 + 建菜单
    assetmanager_maya.py     全部实现（轮询 / 导入 / 材质 / 贴图 / HDRI / IES）
```

**重启 Maya 生效**，之后主菜单栏出现「AssetManager（已连接 · v0.1.0）」。
手工装也简单：把 `bridge/maya/2025/` 整个拷进 `Documents\maya\2025\modules\` 即可。

```
bridge/maya/
  2025/                       Maya 2025（CANONICAL：开发/测试都在这里做）
    AssetManagerBridge.mod    模块声明（版本号只是显示用）
    scripts/userSetup.py      启动钩子
    scripts/assetmanager_maya.py   全部实现
  tools/sync-maya-bridge.mjs  系列同步（--check 只检查）
  tools/test_maya.py          mayapy 集成测试（92 项断言）
  tools/probe_env.py          环境探针（加新系列 / 排查前先跑）
devtest/maya/
  run-test.ps1                一键：临时服务 + 临时素材库 + mayapy 跑测试
  gui-verify.ps1              真机：拉起 GUI Maya 验证（Arnold / 菜单 / 自动启动）
```

## 版本

插件版本独立编号：首版 `0.1.0`，之后只递增第三位（0.1.1、0.1.2…），**不跟软件版本走**。
同一 Maya 的所有系列目录（`2025/`、以后 `2026/`…）共用同一个插件版本号；升级并实测通过后
`git tag -f maya-plugin-v<版本>`。

| 系列目录 | 适用 Maya | 插件版本 | 状态 |
| --- | --- | --- | --- |
| `2025/` | Maya 2025（25.0） | 0.1.0 | ✅ mayapy 92 项断言全绿 + GUI Maya 2025 真机验证（自动启动/菜单/导入/HDRI） |

## 协议

与 3ds Max / Blender / SketchUp / UE 插件完全相同（`src/core/bridge.ts`）：

| 接口 | 用途 |
| --- | --- |
| `GET /api/bridge/maya/next` | 取任务（30s 租约，超时退回 pending） |
| `POST /api/bridge/maya/result` | 回传 `{ id, ok, message, detail }` |
| `POST /api/bridge/maya/heartbeat` | 5 秒心跳，带 `version` / `host` / `info{series,maya}` |
| `GET /api/state` | 端口探活（返回里有 `appRoot` 就是本软件） |

端口发现：先读 `%LOCALAPPDATA%\AssetManager\bridge.json`，探不通再扫 8787–8805；
运行中每 5 秒核对该文件，软件换端口（重启 / 便携版换解压路径）自动跟过去。

## 线程模型（Maya 的硬约束）

- 后台线程**只做 HTTP**（轮询 / 心跳 / 端口跟随），任务丢进 `queue.Queue`；
- **后台线程绝不碰 `maya.cmds`**（Maya API 不是线程安全的，跨线程会随机崩）——
  连「刷新菜单标题」这种界面小事也是置 `ui_dirty` 标记，交给主线程做（UE 插件 0.1.1 踩过同样的坑）；
- 所有 `cmds.*` 都在主线程执行：GUI 下由 `QTimer(250ms)` 驱动 `pump_once()`，
  没有 Qt 就退回 `evalDeferred` 链；`mayapy` 里由测试脚本直接调 `pump_once()`。

## 能做的事

| 模式 | 实现 |
| --- | --- |
| `import` 模型 | **FBX**（`fbxmaya`）/ **OBJ** / **MA** / **MB** / **ABC**（`AbcImport`）/ **USD**（`mayaUsdPlugin`）。导入后选中新对象；素材带贴图时按素材重建材质并套到导入的网格上。Maya 的 FBX 导入按名称与场景已有对象**合并**（同名再导不新增网格，提示里会说明）；`.blend/.max/.glb/.gltf` 明确报「读不了」 |
| `material` 材质 | **`standardSurface`**（Maya 2024+ 原生节点，不依赖 Arnold，Viewport 2.0 直接能看）：baseColor（AO 用 `multiplyDivide` 乘进去）/ specularRoughness / metalness / emissionColor / opacity / normalCamera / 高度；打包图（ARM/ORM）**只建一个 file 节点**按 R/G/B 取通道；强度用 `multiplyDivide`、反相用 `reverse`；法线用 `multiplyDivide`(×2·强度) + `plusMinusAverage`(−1) 直接算切线空间向量（Maya 的 `bump2d` 切线模式只收 float，接不了彩色贴图），**DX 法线**用负的 Y 分量翻过来；UV 平铺/旋转/偏移走 `place2dTexture`；同名材质**原地重建**，用户同名材质不覆盖 |
| `texture` 贴图 | 每张图建 `file` + `place2dTexture` 并选中；色彩空间按扩展名/文件名猜（法线/粗糙/金属/AO/高度/EXR → `Raw`，其余 `sRGB`） |
| `hdri` 环境 | 装了 Arnold → `aiSkyDomeLight` + `file`（`Raw`）；没装 Arnold → 内翻面环境球 `amSkyDome` + 无光照 `surfaceShader`（只当背景，**不产生照明**），提示里会说明 |
| `ies` 灯光 | Arnold `aiPhotometricLight` + 配光文件（属性名按版本探测：`filename` / `intensityFile`）。**没有可用 Arnold 时明确报错**，`.ldt` 也明确报错 |

菜单：主菜单栏 → **AssetManager**（状态… / 重连 / 断开 / 立即处理队列 / 清理本插件建的材质 / 打开 AssetManager 页面）。

## 已知限制

1. **本机 Maya 2025 的 Arnold 坏了**（`C:\Program Files\Autodesk\Arnold\maya2025\bin\arnold.dll` 不存在，
   `mtoa.mll` 加载报「找不到指定的程序」）→ 这台机器上 HDRI 只能走环境球、IES 用不了。
   代码两条路都写了，Arnold 修好后即生效（`tools/probe_env.py` 可确认）。
2. **glTF/GLB 没有导入器**：本机 Maya 2025 没装 gltf 转换插件（`MAYA_PLUG_IN_PATH` 里没有 `gltf.mll`），
   所以模型导入只支持 FBX / OBJ / MA / MB / ABC / USD。
3. **FBX 导入按名称合并**：同一个模型往已经有同名节点的场景里再导，Maya 不会新建网格（提示会写「按名称合并」）。
4. **法线与高度同时存在时只接法线，高度忽略**（`normalCamera` 只能接一条链）——消息里会写明。
5. **置换（displacement）未接**：需要细分 + 置换节点，首版不做（消息里会说明）。
6. 材质只建场景里的节点，**不会自动给选中对象赋值以外的对象**；材质模式下会把选区里的网格换上新材质（和 Blender 插件一致）。
7. `MAYA_MODULE_PATH` 用系统默认（含 `Documents\maya\<年份>\modules`）；用户改过 `Maya.env` 时按自己的路径放。

## 测试

```powershell
# 一键：干净临时数据目录 + 临时服务(8790) + 临时素材库 + mayapy 跑 92 项断言
pwsh -File D:\Program\AssetManager\devtest\maya\run-test.ps1
pwsh -File D:\Program\AssetManager\devtest\maya\run-test.ps1 -NoRebuild   # 服务端没改时跳过打包

# 真机（GUI Maya，验证 Arnold / 菜单 / 自动启动 / 任务实跑；跑完自己退出）
pwsh -File D:\Program\AssetManager\devtest\maya\gui-verify.ps1

# 环境探针（加 2026 系列前先跑，确认节点和导入类型都在）
& "D:\Software\01_DCC\01_Autodesk\Maya2025\bin\mayapy.exe" tools\probe_env.py
```

断言覆盖：模块/版本、端口发现与跟随、**后台线程自己发心跳**、材质各通道（打包图共享 / UV / 强度 /
反相 / DX 法线 / 原地重建 / 不覆盖用户材质）、贴图、FBX+OBJ+USD+ABC 导入、素材材质套用、
不支持格式与缺失文件的报错、HDRI 环境球、IES 无 Arnold 的明确报错、五条真实队列任务、未知任务失败回传。

> 两个跑批坑（都写进脚本了）：
> ① `mayapy` 启动时会执行用户目录里的 `userSetup.py`（装了插件的那份会抢任务进它自己的队列，
> 而 mayapy 没有主线程泵 → 任务永远停在 running），测试会先把它停掉再按路径加载源码；
> ② 临时数据目录每次清空，否则上一轮没跑完的任务会被重新排队，混进这一轮断言。
