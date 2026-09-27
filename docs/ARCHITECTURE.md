# 架构总览

面向"第一次接手这个仓库的人"：进程怎么分、依赖允许往哪个方向走、一次界面调用到底经过谁、
以及**哪些不变量有机检**（写在这里的每条都能在仓库里找到对应判据；没有判据的会标明）。

- 隐私边界与出网点清单：[`PRIVACY.md`](PRIVACY.md)
- Remote 接口逐条参考：[`API.md`](API.md)（由 `docs:api` 生成，CI 校验一致性）
- 上线状态与未闭环项：[`RELEASE-PLAN.md`](RELEASE-PLAN.md)
- 加代码/改判据的规矩：[`CONTRIBUTING.md`](CONTRIBUTING.md)
- 错误怎么传回来、有哪些码：[`ERROR-CODES.md`](ERROR-CODES.md)

---

## 1. 三个进程

| 进程 | 入口 | 职责 |
|---|---|---|
| Electron 主进程 | [`../main.js`](../main.js) | 窗口与沙箱、IPC 分发、三道闸门（引导 → 隐私同意 → 授权）、后端进程监管与重启、诊断日志 |
| 后端 worker | [`../src/backend/wechat-worker.js`](../src/backend/wechat-worker.js) 加载 [`../src/backend/wechat-data/lib/index.js`](../src/backend/wechat-data/lib/index.js) | 真正的解密与查询；`wechat-data` 包以 esbuild 打成单文件 bundle 后由 worker 载入 |
| 渲染进程 | [`../src/client/ui-app/ui-entry.tsx`](../src/client/ui-app/ui-entry.tsx) | 壳与启动三站 + 数据面板（[`../src/client/ui-wechat/`](../src/client/ui-wechat/)） |

三者之间只有两条通道：渲染 ↔ 主进程走 `contextBridge`（[`../preload.js`](../preload.js)），
主进程 ↔ worker 走 `utilityProcess` 的消息通道（[`../src/backend/backend-rpc.js`](../src/backend/backend-rpc.js)：
请求/响应配平、按方法分级超时、进程死亡时把在途请求全部摘除）。
**渲染层从不直接读盘、也从不 import 后端实现** —— 它拿到的只有 `@Remote` 方法的返回。

宿主层的模块清单与设计取舍（含平台支持为何只有 win32-x64）在
[`../src/backend/README.md`](../src/backend/README.md)。

## 2. 依赖方向（有判据）

```
main.js / src/backend/*.js        宿主层（CommonJS）
        │ 只往下：
        ├─ src/backend/wechat-data/    后端包（gateway.ts 是方法面）
        │      ├─ src/query/**         查询层
        │      ├─ src/keys/**          密钥获取（含 win32 进程内存扫描）
        │      └─ src/query/retrieval/ RAG 检索层
        └─ src/license/**             许可证：指纹、签名、状态
src/client/**                      前端（ESM + React）
```

三条被机检的规矩：

1. **后端/宿主不许 import 前端源码**。判据：[`../src/backend/tests/layer-direction.spec.ts`](../src/backend/tests/layer-direction.spec.ts)
   —— 扫 `src/backend/**` 加上根上的 `main.js`/`preload.js`，认静态 `import`、`export … from`、
   `await import()`、`require()` 四种会进模块图的形状；解析后落在 `src/client` 就是违规。
   **读前端源码的文本做断言是允许的**（棘轮与接线守卫都靠它），那是守卫手段不是依赖。
2. **门禁脚本不许走测试接缝**。同一份判据的另一条：`scripts/**` 里不许出现 `__internals`
   —— 接缝是给单测开后门的（有些内部状态只有测试需要），脚本走它会让"真 API 改名"静默漏过门禁。
3. **纯函数与钩子分家**。`ui-wechat` 的算术/派生一律能脱离 React 测：
   形如 `chats-calendar.ts`（纯）+ `chats-calendar-dialog.tsx`（渲染）+ `*.wiring.spec.ts`（接线）。

## 3. 一次界面调用的完整路径

```
面板事件 → preload 暴露的 wechat.call(method, args)
        → ipc-wechat.js：等后端就绪 → 调试闸门豁免（打包态恒不成立）→ 许可证 authorizeCall
        → backend-rpc.js：分配序号 + 超时窗口 → postMessage
        → worker：gateway.ts 的 @Remote 分派 → src/query/** 读 SQLite / 文件
        → 原路回包（渲染层只看 { ok } / { ok:false, error:{ message, code } }）
```

要点：

- **方法面只有一个出处**：`gateway.ts` 的 `@Remote` 装饰器 + `remotes/**` 分域壳。
  `docs/API.md` 从它生成，数量对不上就红（`npm run docs:api:check`）。
- **超时是分级的**，且必须宽于被包住的长任务（LLM 120s、批量取原图按张数放大），
  否则一次正常的慢调用会被误报成失败。
- **取消不是人人都有的**：本仓自己的 `@Remote` 方法面**没有**取消元数据 —— 能在调用中被打断的
  只有两类：显式收 `signal: AbortSignal` 的方法（`gateway-read.ts` 的 `openPath` 与
  `gateway-data-ops.ts` 的 `openConfig`，宿主层限根打开用的就是这一条），以及带 `jobId` 的长任务
  （导出/搜索靠 `cancelExportJob` 与 `cancelSearch` 两个方法自己打断）。**没有令牌的方法只能等它跑完。**
  顺带记一句免得被人误认：`cancellation: { parameter: 'signal' }` 这份形状住在随包的
  `src/backend/deps/dsh-llm`（vendored 生成物）里，不是本仓方法面的属性 —— 报告 §P1-2 说的
  「取消要先接上生成链」欠账登记在 [`RELEASE-PLAN.md`](RELEASE-PLAN.md) 的 #11。

## 4. 数据与缓存

| 位置 | 内容 | 谁写 |
|---|---|---|
| `<userData>/wechat/` | `config.json`、`llm.json`、`secrets.json`、`logs/` | 宿主层（原子写：同目录 tmp + rename） |
| `<userData>/wechat-data/decrypted/` | 解密后的 SQLite 分库 | `src/query/decrypt-all.ts` |
| `.../decoded_images/` | 图片解码缓存（全局槽 + 按用户名槽、缩略带 `.t.`） | `src/query/media-image.ts` |
| `.../wechat_search.db`、`wechat_rag_vectors.db` | 派生索引（可随时从 `contact.db` / 消息重算） | `src/query/search-*.ts`、`retrieval/**` |

三条被机检的纪律：

- **连接生命周期**：只读用 `withDb`、写用 `withWritableDb`、要跨 `await` 用 `withDbAsync`
  （[`../src/backend/wechat-data/src/query/db-open.ts`](../src/backend/wechat-data/src/query/db-open.ts)）。
  判据是"跑完之后整棵树仍可删"（Windows 上句柄没关就是 EBUSY/EPERM），不是数源码里有没有 `close`：
  [`../src/backend/wechat-data/tests/query-db-lifetime.spec.ts`](../src/backend/wechat-data/tests/query-db-lifetime.spec.ts)。
- **出网闸门在后端**：渲染层不直接向远程主机要任何东西（含头像、原图、封面、地图底图），
  统一走后端代理（主机白名单 + 开关 + 操作记录 + 本机缓存）。
- **缓存是 SWR**：`cachedBySig` / `cachedFetch` 以"文件签名"为键，过期先回旧值再后台刷新；
  签名必须覆盖**真正被读到的东西**（只签 `sns.db` 而实际还读了 `contact.db` 就是错的键）。

## 5. 不让事件循环卡住

后端 worker 是同步串行的：一个长任务会把后面所有调用排队（实测有单次 54 秒的分析任务）。
所以重读查询一律按"行数 + 字符数 + 时间预算"三档让出（`yieldToLoop`），
判据是**探针真的拿到过 tick**：
[`../src/backend/wechat-data/tests/query-yield-discipline.spec.ts`](../src/backend/wechat-data/tests/query-yield-discipline.spec.ts)。
新增大表扫描时没有让出点，这条会红。

## 6. 前端结构

- `ui-app`：窗口壳、启动引导三站、同意屏、授权面板 —— **打包入口那一层**，单独有一份 typecheck。
- `ui-wechat/src/client/pages/wechat-data/panels/`：数据面板，按功能分片（`chats-*`、`graph-*`、
  `world-map-*`、`overview-*` …）。面板的状态在 `hooks/` 与 `chats-*.tsx` 的钩子里，
  渲染树切成 `*-dialog.tsx` / `*-view.tsx`，两半各自有用例。
- 测试辅助（读盘的那三份）住在 [`../src/client/ui-wechat/src/client/test-helpers/`](../src/client/ui-wechat/src/client/test-helpers/)，
  **不在** `panels/` 里 —— 判据同上（layer-direction），另有一条"不许把 node 内建 import 回 pages/**"。
- **长列表一律虚拟化**（#22）：消息流、收藏、文件网格、朋友圈时间线四处都只挂载视口附近的行，
  DOM 节点数与已加载条数解耦。这不是风格选择 —— 原先的"渐进窗口"只增不减，滚一遍历史就把整段留在页面上。
  量它的地方是 [`../scripts/longlist-virtualization-e2e.mjs`](../scripts/longlist-virtualization-e2e.mjs)
  （真实 Electron + 合成夹具，26 项断言：节点上界、两端可达、日期标签与悬浮头、文本里没有 CDATA 外壳）。

## 7. 构建与产物

| 产物 | 生成方式 | 一致性门禁 |
|---|---|---|
| 前端静态资源 | `npm run build:ui`（vite，入口是 `ui-app/ui-entry.tsx`） | — |
| 后端 bundle | `npm run build:backend` → `wechat-data/lib/index.js` | CI 重建后 `git diff` 必须为空 |
| `lib/types/**.d.ts` | `npm run build:types` | 同上（前端只从这里取后端类型） |
| `docs/API.md` | `npm run docs:api` | `npm run docs:api:check` |

改后端 `src` 必须把 `lib/` 与（方法面变化时的）`docs/API.md` 一起提交，否则 CI 的差异门禁会红。

## 8. 还没有机检的部分（如实说）

- 界面行为本身（是否真的看得见某个面板）只有 SSR 冒烟 + 少量真机 e2e（Playwright 驱动真实 Electron）；
  其余靠源码级接线判据 —— 它能证明"接上了"，不能证明"渲染对了"。
- 打包态才成立的行为（许可证真签、asar 内容、`app.isPackaged` 闸门）由
  `npm run package:smoke` / `security-guard:smoke:packaged` 覆盖，不在单测里。
- 性能类事实（N36 的耗时口径、真机打点）见 [`PERF-BASELINE.md`](PERF-BASELINE.md) 与
  [`RELEASE-PLAN.md`](RELEASE-PLAN.md)，它们依赖具体机器，不做零容忍门禁。
