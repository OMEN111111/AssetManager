# AssetManager · Unreal Engine 桥接插件

纯 Python 编辑器插件，不需要编译 C++。装在 **UE 工程的 `Plugins/` 目录**里
（不是引擎目录）。软件里点「插件 → Unreal Engine → **安装 / 卸载插件（UE 工程）**」，
弹窗按工程列出（**勾选 = 装进该工程、取消勾选 = 从该工程移除**；工程不在列表里就点
「＋ 手动选择 .uproject…」，选过一次会记住）；或在插件面板里「打开 UE 插件文件夹」手动拷贝。

```
bridge/ue/
  5.6/AssetManagerBridge/                 UE 5.6
  5.7/AssetManagerBridge/                 UE 5.7（CANONICAL：开发/测试都在这里做）
  5.8/AssetManagerBridge/                 UE 5.8
    AssetManagerBridge.uplugin            # Type=Editor，无模块，只带 Content/Python
    Content/Python/init_unreal.py         # 编辑器启动钩子（UE 会自动执行已启用插件的这份文件）
    Content/Python/assetmanager_ue.py     # 全部实现
  tools/sync-ue-bridge.mjs                # 系列同步（--check 只检查）
  tools/test_ue.py                        # 在 UE 里跑的集成测试（89 项断言）
```

各系列共用同一份实现主体（文件里 `# >>> AM_BODY >>>` 之后的部分），只有头部
`AM_PLUGIN_VERSION` / `AM_SERIES` 与说明文字不同。**改实现只改 `5.7/`，然后同步**：

```bash
cd app/bridge/ue
node tools/sync-ue-bridge.mjs            # 5.7（CANONICAL）→ 5.6 / 5.8
node tools/sync-ue-bridge.mjs --check    # 提交前检查是否已同步（不同步会报错）
```
真需要分叉时（某引擎 API 变了），在该系列文件头部写 `# SYNC: skip`，同步会跳过它。

## 版本

插件版本独立编号：首版 `0.1.0`，之后只递增第三位（0.1.1、0.1.2…），**不跟软件版本走**。
同一 UE 大版本的系列目录（`5.7/`、以后 `5.6/`…）共用同一个插件版本号；
升级并实测通过后打标签 `git tag -f ue-plugin-v<版本>`。

| 系列目录 | 适用引擎 | 插件版本 | 状态 |
| --- | --- | --- | --- |
| `5.6/` | UE 5.6 | 0.1.7 | ✅ 已在 5.6.1 真机通过 89 项断言 |
| `5.7/` | UE 5.7 | 0.1.7 | ✅ 已在 5.7.4 真机通过 89 项断言（CANONICAL） |
| `5.8/` | UE 5.8 | 0.1.7 | ✅ 已在 5.8.1 真机通过 89 项断言 |

> 三个版本的 Python API 完全一致（`AssetImportTask` / `MaterialEditingLibrary` /
> `TextureLightProfile` / `Interchange` 都没变），所以主体不需要分叉。

> **0.1.1 修的关键 bug**：心跳原来在后台线程里调 `unreal.Paths.get_project_file_path()`，
> UE 会抛 `Attempted to access Unreal API from outside the main game thread`，
> 心跳永远发不出去 → 软件显示「未连接」，但 `/next` 是纯 HTTP 所以任务照收。
> 现在引擎版本/工程路径在导入时（主线程）缓存成常量，**后台线程一律不碰 `unreal.*`**。

> **0.1.3 修的两个坑**
> - 导入的静态网格体「阴影像烘在贴图上、怎么动灯都不受影响」：`spawn_actor_from_object` 生成的是 **Static mobility**，
>   关卡默认灯光是 Stationary、没烘焙过它 → 现在导入后演员和组件的 mobility 统一改成 **MOVABLE**（天空球组件同样）。
> - HDRI 上下颠倒：UE 贴图 `v=0` 在图片**顶部**（跟 OpenGL 相反），天空球材质的等距柱状 UV 写成了 
>   `v = 1 - acos(z)/π`，仰角 90° 取到图片最底行。改成 `v = acos(z)/π`；天空材质带版本标记，版本变了就重建。
>
> **0.1.4 的改动**
> - 导入默认**不往视口放演员**（之前每次导入都在视口相机位置生成一个 StaticMeshActor，重复导入还堆一堆）；
>   弹窗新增「导入后放到视口」，勾了才放并复用同名演员。
> - 材质补齐特殊通道：置换/高度 → `BumpOffset`（UE 延迟渲染没有位移槽）、自发光额外把 `emissive_color` 设白、
>   不透明度 → `BLEND_TRANSLUCENT` + 双面。
> - 材质任务在 UE 端弹窗选「独立材质 / 父材质实例 / 跳过」；选实例时取内容浏览器选中的材质当父材质
>   （UE 没给 Python 资产选择器），只写父材质声明过的贴图参数。
>
> **0.1.5 的改动**：UE 端的模态框会挡住内容浏览器，所以「在弹窗里去选父材质」这条路走不通
> （无头会话里 `get_selected_assets()` 也读不到内容浏览器选中项）。
> 现在父材质改由 **AM 端发送前弹窗填路径**（留空=独立材质，粘 `/Game/.../M_X` 即可，
> AM 会记住上次填的）；UE 端不再弹模态框。想事后改成实例：
> 内容浏览器选中父材质 → **工具 → AssetManager → 用选中的材质重建最近材质**（非模态）。

## 协议

与 3ds Max / Blender / SketchUp 插件完全相同（`src/core/bridge.ts`）：

| 接口 | 用途 |
| --- | --- |
| `GET /api/bridge/ue/next` | 取任务（30s 租约，超时退回 pending） |
| `POST /api/bridge/ue/result` | 回传 `{ id, ok, message, detail }` |
| `POST /api/bridge/ue/heartbeat` | 5 秒心跳，带 `version` / `host` / `info{engine,series,project}` |
| `GET /api/state` | 端口探活（返回里有 `appRoot` 就是本软件） |

端口发现：先读 `%LOCALAPPDATA%\AssetManager\bridge.json`，探不通再扫 8787–8805；
运行中每 5 秒核对该文件，软件换端口自动跟过去。

## 线程模型（UE 的硬约束）

- 后台线程只做 HTTP 轮询/心跳，取到的任务塞进队列；
- **后台线程绝对不能调 `unreal.*`**（`SystemLibrary` / `Paths` / `EditorAssetLibrary` 跨线程都抛
  `Attempted to access Unreal API from outside the main game thread`；实测只有 `unreal.log` 安全）。
  需要的东西（引擎版本、工程路径）在导入时（主线程）缓存成模块常量；
- 所有 `unreal.*` 资产操作都在主线程的 `register_slate_post_tick_callback` 里执行；
- 结果在主线程执行完后回传。`pump_once()` 是执行入口（tick 回调与测试脚本共用）。

## 能做的事

| 模式 | 实现 |
| --- | --- |
| `import` 模型 | `AssetImportTask` 走 Interchange 管线（FBX / GLB / OBJ / USD / ABC / STL / PLY），导入到 `/Game/AssetManager/<素材名>/`，并把网格放到视口；素材带贴图时顺手用软件里的材质覆盖模型自带材质。**导入类型可选**（`importOptions`：静态网格体 / 骨骼网格体 / 物理资产，默认只静态；没勾的导完删掉，缺物理资产时用 `create_physics_asset` 补）；**默认不往视口放演员**（`placeInViewport`，勾了才放且复用同名演员）。演员一律设成 Movable，否则静态网格体不吃未烘焙的关卡灯光 |
| `material` 材质 | 父材质由 **AM 端发送前弹窗填路径**（`payload.parentMaterial`，留空=独立材质）；给了就建 `MaterialInstanceConstant`：**贴图一律先导入** `<素材名>/Textures/`，参数名先归一化精确匹配、再按关键词兜底（`BaseColorTex`/`NrmTex`/`T_Rough` 都能对上），对不上时消息列出父材质参数；否则用 `MaterialEditingLibrary` 建 `Material`：BaseColor / Roughness / Metallic / AO / Emissive / Opacity / Specular / Normal / Height(BumpOffset)，通道用 `ComponentMask` 抽 R/G/B，强度用 `Multiply`，反相用 `OneMinus`，GL 法线用 `Custom` 节点翻转 G，UV 平铺/旋转用 `TextureCoordinate` + `Rotator`；同名材质**原地重建**，用户同名材质不覆盖 |
| `texture` 贴图 | 逐张导入 `Texture2D` 到 `/Game/AssetManager/<素材名>/Textures/` |
| `hdri` 环境 | 导入 `.hdr`/`.exr` → 建 `MaterialInstanceConstant` → 复用天空球（`/Engine/BasicShapes/Sphere`，Unlit 双面 + 等距柱状投影材质 `M_AM_SkyEquirect`）+ `SkyLight` 实时捕捉 |
| `ies` 灯光 | 导入 `TextureLightProfile` → 生成 `SpotLight` 并挂上 `IESTexture`（UE 原生支持配光文件，这是相对 three.js 的优势） |

## 菜单

`工具 → AssetManager（已连接/未连接）`：状态… / 重连 / 断开 / 打开 AssetManager 页面。

## 已知限制

1. **`create_asset` 撞名会弹模态框**：同名资产（不是我们打的 `AssetManager` 标签）存在时，
   直接 `create_asset` 会弹「是否替换」，**游戏线程被卡住**（tick 不再跑、任务永不结束、编辑器看着还活着）。
   现在统一走 `_create_asset_safe()`：撞名时用 `create_unique_asset_name` 起唯一名，绝不弹框。
2. **导入走 Interchange，无法关掉 FBX 内嵌材质/贴图**：`ImportAssetParameters.override_pipelines`
   只接受 pipeline 资产软引用，Python 里构造不了，所以内嵌贴图仍会被导入（体积大、偶发命名冲突）。
   素材带贴图时软件会在导入后覆盖材质，所以观感不受影响。
3. **个别 FBX 会让编辑器崩**：例如素材库里的 `Gate_001.fbx`（网格名与材质实例名相同 + 法线贴图参数无效），
   导入时 Interchange 报命名冲突、随后材质编译触发 `EXCEPTION_ACCESS_VIOLATION`。
   这是引擎侧问题，编辑器里手动导入同样会崩；测试统一用 `FireEscape_001.fbx`。
4. **HDRI 不走 cubemap**：SkyLight 用 `SLS_CAPTURED_SCENE` 实时捕捉天空球，反射质量取决于捕捉分辨率；
   没有做 equirect→cubemap 烘焙。
5. **UE 只认 `.ies`**：`.ldt` 会明确报错（需先在软件里转换）。
6. 材质节点连接过程中 UE 会按中间态编译，日志里可能出现 `Failed to compile Material`；
   最终 `recompile_material` 后是正确的（已用探针逐条核对属性输入）。

## 测试

```powershell
# 一键：起临时服务（8790）+ 临时素材库 + 真机 UE，跑完自动关（默认 5.7）
pwsh -File D:\Program\AssetManager\devtest\ue\run-test.ps1
pwsh -File D:\Program\AssetManager\devtest\ue\run-test.ps1 -Engine 5.6    # 换引擎版本
pwsh -File D:\Program\AssetManager\devtest\ue\run-test.ps1 -Engine 5.8

# 或手动
$env:AM_TEST_SCRIPT = "D:/Program/AssetManager/app/bridge/ue/tools/test_ue.py"
$env:AM_TEST_PORT = "8790"; $env:AM_TEST_WORK = "<临时目录>"
UnrealEditor.exe <工程>.uproject -ExecCmds="py .../devtest/ue/runner.py" -nosplash -log
```

为什么不用 `-run=pythonscript`：那是 commandlet，没有 Slate 应用，Interchange 导入 FBX 时
会断言 `CurrentApplication.IsValid()` 直接崩；所以测试用 GUI 编辑器 + `-ExecCmds="py runner.py"`，
runner 等 Slate 起来后在 tick 回调里执行测试并 `quit_editor()`。

两个跑批上的坑（都写进脚本了）：
- `Start-Process -ArgumentList` 传**数组**时会把 `-ExecCmds="py D:/x.py"` 里的空格拆开，UE 只看到
  `-ExecCmds=py`，脚本根本不执行 → 必须拼成一整条字符串传。
- 万一 UE 里弹了模态框（比如资产撞名），游戏线程卡住、tick 不再跑，测试永远结束不了 →
  脚本给编辑器设 900 秒硬超时，超时直接杀掉并报错。

