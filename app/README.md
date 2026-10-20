# AssetManager App（一期骨架）

Electron/Node 侧的库服务 + React 网格。当前跑通：**添加库 → 扫描 → 索引 → 浏览 / 搜索 / 筛选 → 详情**。

## 运行

```bash
pnpm install
pnpm build                 # 构建前端到 dist/
pnpm exec tsx src/cli/scan.ts "F:\02AssetLibrary\Asset"   # 建库并扫描
pnpm exec tsx src/server/index.ts                          # http://127.0.0.1:8787
```

数据默认写到 `data/library.db`（SQLite，`node:sqlite`，不污染素材库）。

## 目录

| 路径 | 作用 |
|---|---|
| `src/core/db.ts` | SQLite schema（libraries / assets / files / tags） |
| `src/core/scan.ts` | 目录遍历、素材集成组、预览图匹配 |
| `src/server/index.ts` | 本地 HTTP API + 静态站点 |
| `src/renderer/` | React 网格、目录树、详情、主题 |
| `src/cli/scan.ts` | 命令行建库/扫描 |

## API

| 路由 | 说明 |
|---|---|
| `GET /api/state` | 库列表、总数、扫描状态 |
| `POST /api/libraries` | 添加库并异步扫描 |
| `GET /api/assets?lib&q&type&dir&recursive&sort&limit` | 素材查询 |
| `GET /api/asset/:id` | 详情 + 文件清单 |
| `PATCH /api/asset/:id` | 评分 / 收藏 |
| `GET /api/thumb/:id` | 缩略图（优先 `_Preview`，否则贴图原图） |
| `GET /api/tree?lib` | 目录树与计数 |
| `GET /api/stats?lib` | 按类型计数 |

## 一期已完成 / 待做

- [x] 多库数据结构、目录扫描（4301 文件 / 0.5s）、素材集识别（材质 / 模型 / 贴图 / HDRI / 场景）
- [x] 预览图规则：优先 `_Preview`，贴图回落到原图
- [x] 网格、目录树、搜索、类型筛选、排序、详情、评分、收藏
- [x] 五套主题令牌
- [ ] 模型/材质缺图时的 three.js 缩略图生成
- [x] 3D 查看器（three.js 实时 PBR）
- [x] 两级标签（创建 / 打标 / 按标签筛选）
- [ ] 标签管理器（合并 / 改色 / 改父级）
- [ ] 文件监听、断链检查、整理模板
- [x] Electron 壳（原生窗口/菜单/打包配置）
- [x] 材质组装器（通道映射、打包图取通道、MR/SG、导出 .mtlx）





## 桌面应用（Electron）

```bash
pnpm build:all    # 构建前端 dist/ + 服务端 build/server.mjs
pnpm app          # 启动 Electron；主进程会自动拉起本地服务
pnpm dist         # 打包 NSIS 安装包 + 便携版到 release/
```

- 主进程 `electron/main.cjs`：探测 8787 端口，没有服务就用 `ELECTRON_RUN_AS_NODE` 拉起 `build/server.mjs`；退出时一并结束。
- 原生菜单：文件（添加库 / 重新扫描）、视图（重载 / 开发者工具 / 缩放 / 全屏）、帮助。
- 素材库路径与数据目录由 `AM_ROOT` 传给服务端，打包后指向 `resources/app`。
