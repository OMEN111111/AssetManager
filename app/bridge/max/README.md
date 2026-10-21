# 3ds Max 桥接插件（AssetManagerBridge）

AssetManager 里的模型 / 材质 / 贴图可以一键送进 3ds Max，也能把 Max 里改好的东西回写进素材库。

## 安装

**推荐**：AssetManager 顶部「插件」→ 3ds Max 卡片 →「安装到 3ds Max」，会自动写入所有已存在的 Max 用户配置：

```
%LOCALAPPDATA%\Autodesk\3dsMax\2026 - 64bit\CHS\scripts\startup\AssetManagerBridge.ms
%LOCALAPPDATA%\Autodesk\3dsMax\2025 - 64bit\ENU\scripts\startup\AssetManagerBridge.ms
...
```

装完**重启 3ds Max**。插件随 Max 启动自动开始轮询，AssetManager 的插件面板会在 5 秒内显示「已连接」。

**手动**：把 `AssetManagerBridge.ms` 复制到上面的 startup 目录；或者在 Max 里执行
`fileIn @"...\AssetManagerBridge.ms"`。

## 工具栏

- 主菜单栏的 **AssetManager → 打开桥接工具栏**
- 或者把「自定义 → 自定义用户界面 → 工具栏 → 类别 AssetManager → AssetManager」拖到任意工具栏
- 或者 MaxScript 侦听器里 `AssetManagerBridge_Toolbar()`

工具栏里有：连接状态 / 当前素材与源目录 / 回写按钮 / 拖放接收区 / 母版重建 / 「导入后询问摆放」开关。

### 回写素材

| 按钮 | 行为 |
|---|---|
| 覆盖源文件 | 把选中的对象导出成 FBX 覆盖素材原来的模型文件，原文件备份为 `.bak`；素材里的贴图若不在源目录会被复制进去 |
| 另存副本 | 导出为 `<名字>_fromMax.fbx`，原文件不动 |
| 打包到指定位置 | 选父目录 + 输入文件夹名，生成 `<名字>/<名字>.fbx`、`<名字>/maps/*`、`pack_info.txt` |

导出的是**当前选中的对象**；什么都没选时导出场景里所有几何体。

## 拖拽素材

在 AssetManager 里把素材卡片直接拖出来：

| 拖到 | 结果 |
|---|---|
| Max 视口（模型） | Max 原生导入；插件认出是哪个素材，自动接 AssetManager 的贴图材质，并询问是否放到世界中心 |
| 材质编辑器（贴图 / 材质里的贴图） | 变成位图材质节点（和从资源管理器拖进来一致） |
| 插件工具栏的接收区 | 模型 → 导入；材质 → 弹母版列表重建；HDRI → 设为环境贴图；贴图 → 成位图 |

> 3ds Max 的 MAXScript 没有「文件拖进视口/材质编辑器」的回调，所以视口里只走 Max 原生导入 + 导入后询问摆放；要完全接管拖放（弹母版菜单、按拖放点定位），需要确认 Max 会不会执行拖进去的 `.ms`——测试文件见仓库 `devtest/max-ms-drop-test.ms`。

## 用法

在 AssetManager 里右键素材：

| 素材类型 | 菜单 | Max 端动作 |
|---|---|---|
| 模型 / 场景 | 发送到 3ds Max | 导入 FBX/OBJ…，选中新对象；模型自带材质时保留，缺材质时按贴图建 Physical Material |
| 材质 | 在 3ds Max 中创建材质 | 建 Physical Material 并接好贴图，赋给当前选中对象；没选中就放进材质编辑器 |
| 贴图 | 发送贴图到 3ds Max | 以该贴图作基础色建材质，赋给选中对象或放进材质编辑器 |

材质映射：

| AssetManager 通道 | Max |
|---|---|
| Base Color | `base_color_map`（sRGB） |
| Roughness | `roughness_map`，按通道取 R/G/B（打包图 ARM 取 G） |
| Metallic | `metalness_map`，按通道取（打包图 ARM 取 B） |
| Normal | `bump_map` → Normal Bump（DX 法线自动 Flip Green） |
| Height | 没有法线贴图时用作凹凸（有法线时让位） |
| Emissive | `emit_color_map` |
| Opacity | `transparency_map` |
| AO | Physical Material 没有独立 AO 通道，忽略并在结果里说明 |
| UV 平铺 | 组装器里设过平铺/重复时写入 bitmap 的 U/V Tiling |

## 手动命令（MaxScript 侦听器）

```maxscript
AssetManagerBridge_Status()       -- 弹窗：版本/端口/连接/最近任务
AssetManagerBridge_Poll()         -- 立刻轮询一次（batch 调试用）
AssetManagerBridge_Start()        -- 启动轮询（700ms）
AssetManagerBridge_Stop()         -- 停止轮询
AssetManagerBridge_Heartbeat()    -- 立刻发一次心跳
```

## 排错

- **面板一直「未连接」**
  1. Max 是否在运行？插件是否在 startup 目录（或手动 fileIn 过）？
  2. AssetManager 是否在运行？端口见插件面板「服务端口」。
  3. 插件靠 `%LOCALAPPDATA%\AssetManager\bridge.json` 找端口，读不到时会试默认 8787。
  4. 在 Max 里跑 `AssetManagerBridge_Status()` 看端口与最近错误。
- **任务一直排队**：Max 端报错会写进「最近任务」；也可以看 MaxScript 侦听器。
- **导入后没有贴图**：FBX 自带材质时不会覆盖；模型目录里的贴图要能被 Max 找到（同名同目录）。
- **重复发送同一个模型**：插件会把 FBX 导入设为「创建」模式，每次都是一份新对象（不会合并进旧对象）。
- **离线时会不会卡 Max**：不会。连不上时每 8 秒才探一次端口，单次探测超时 300ms。

## 协议

```
GET  /api/bridge/max/next            取任务（204 = 没有任务），取到即加 90s 租约
POST /api/bridge/max/result          { id, ok, message, detail }
POST /api/bridge/max/heartbeat       { version, host, protocol, script }
GET  /api/bridge/status              面板状态（connected = 6s 内有心跳）
```

任务载荷只包含**文件绝对路径**与固定字段，插件不执行任何来自队列的代码。
