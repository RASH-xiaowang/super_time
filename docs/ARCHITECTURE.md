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
| Electron 主进程 | [`../main.js`](../main.js) | 组合根：窗口与沙箱、IPC 分发、三道闸门（引导 → 隐私同意 → 授权）、依赖装配与诊断日志 |
| 后端 worker | [`../src/backend/wechat-worker.js`](../src/backend/wechat-worker.js) 加载 [`../src/backend/wechat-data/lib/index.js`](../src/backend/wechat-data/lib/index.js) | 真正的解密与查询；`wechat-data` 包以 esbuild 打成单文件 bundle 后由 worker 载入 |
| 渲染进程 | [`../src/client/ui-app/ui-entry.tsx`](../src/client/ui-app/ui-entry.tsx) | 壳与启动三站 + 数据面板（[`../src/client/ui-wechat/`](../src/client/ui-wechat/)） |

三者之间只有两条通道：渲染 ↔ 主进程走 `contextBridge`（[`../preload.js`](../preload.js)），
主进程 ↔ worker 走 `utilityProcess` 的消息通道（[`../src/backend/backend-rpc.js`](../src/backend/backend-rpc.js)：
请求/响应配平、按方法分级超时、进程死亡时把在途请求全部摘除）。
**渲染层从不直接读盘、也从不 import 后端实现** —— 它拿到的只有 `@Remote` 方法的返回。

后端 utilityProcess 的拉起、init、状态广播、有界退避重启、设置回灌、密钥迁移与退出收尾，
作为独立状态机住在 [`../src/backend/backend-supervisor.js`](../src/backend/backend-supervisor.js)：
Electron、文件与配置依赖全部从 `main.js` 注入，因此这些原本只能靠真机观察的分支可由
`tests/backend-supervisor.spec.ts` 确定性覆盖；`main.js` 只保留「何时启动/停止」与「事件发给谁」两个编排点。

宿主层的模块清单与设计取舍（含平台支持为何只有 win32-x64）在
[`../src/backend/README.md`](../src/backend/README.md)。

## 2. 依赖方向（有判据）

```
main.js / src/backend/*.js        宿主层（CommonJS）
        │ 只往下：
        ├─ src/backend/wechat-data/    后端包（gateway*.ts 继承链是方法面）
        │      ├─ src/query/**         查询层
        │      ├─ src/keys/**          密钥获取（含 win32 进程内存扫描）
        │      └─ src/query/retrieval/ RAG 检索层
        └─ src/license/**             许可证：指纹、签名、状态
src/client/**                      前端（ESM + React）
```

五条被机检的规矩：

1. **后端/宿主不许 import 前端源码**。判据：[`../src/backend/tests/layer-direction.spec.ts`](../src/backend/tests/layer-direction.spec.ts)
   —— 扫 `src/backend/**` 加上根上的 `main.js`/`preload.js`，认静态 `import`、`export … from`、
   `await import()`、`require()` 四种会进模块图的形状；解析后落在 `src/client` 就是违规。
   **读前端源码的文本做断言是允许的**（棘轮与接线守卫都靠它），那是守卫手段不是依赖。
2. **门禁脚本不许走测试接缝**。同一份判据的另一条：`scripts/**` 里不许出现 `__internals`
   —— 接缝是给单测开后门的（有些内部状态只有测试需要），脚本走它会让"真 API 改名"静默漏过门禁。
3. **纯函数与钩子分家**。`ui-wechat` 的算术/派生一律能脱离 React 测：
   形如 `chats-calendar.ts`（纯）+ `chats-calendar-dialog.tsx`（渲染）+ `*.wiring.spec.ts`（接线）。
4. **宿主 CommonJS 的声明与实现双向对齐**。宿主 JS 没有进入生成链，公开面靠手写 `.d.ts`
   描述；`host-decl-alignment.spec.ts` 对 `module.exports` 与声明导出做双向差集，
   漏一个导出或多发明一个成员都会红。手写声明的语法与导入解析收在 `tsconfig.checks.json`。
5. **宿主 CommonJS 的函数大小也只许变小**。`function-size-ratchet.spec.ts` 除三棵 TS/TSX 树外，
   还量 `src/backend/*.js` 直属文件；当前已登记的长函数拆小后要回来改账，重新长大或新增未登记项都会红。

## 3. 一次界面调用的完整路径

```
面板事件 → preload 暴露的 wechat.call(method, args)
        → ipc-wechat.js：共享调用闸 → 等后端就绪 → 调试闸门豁免（打包态恒不成立）→ 许可证 authorizeCall
        → backend-rpc.js：分配序号 + 超时窗口 → postMessage
        → worker：gateway*.ts 继承链的 @Remote 分派 → src/query/** 读 SQLite / 文件
        → 原路回包（渲染层只看 { ok } / { ok:false, error:{ message, code } }）
```

要点：

- **方法面只有一个出处**：`gateway*.ts` 继承链的 `@Remote` 装饰器 + `remotes/**` 分域壳。
  `docs/API.md` 从它生成，数量对不上就红（`npm run docs:api:check`）。
- **入参守卫分两档**：结构/体积由 `guardCallArgs` 总是硬拒；生成 schema 的形状校验只对
  `ENFORCED_SCHEMA_METHODS` 白名单硬拒，其余先记进 `info().argGuard.mismatched`。
  `deleteTask` 是 2026-10-15 的第一个试点，加名字前必须人工核对生成 schema 与 `@Remote`
  声明逐字一致。
- **超时是分级的**，且必须宽于被包住的长任务（LLM 120s、批量取原图按张数放大），
  否则一次正常的慢调用会被误报成失败。
- 所有 LLM 出网（chat/embed/rerank、模型列表、连接测试、余额查询）共用
  [`../src/backend/llm-http.js`](../src/backend/llm-http.js) 这一条传输：地址卫生、
  JSON 请求头、超时与 `fetchWithRetry` 都只有一个实现；内容型调用仍由上游
  `privacyGate` 决定是否发出，探针类请求只携带 Key 或固定测试串。
- **取消不是人人都有的**：本仓自己的 `@Remote` 方法面**没有**取消元数据 —— 能在调用中被打断的
  只有两类：显式收 `signal: AbortSignal` 的方法（`gateway-read.ts` 的 `openPath` 与
  `gateway-config-ops.ts` 的 `openConfig`，宿主层限根打开用的就是这一条），以及带 `jobId` 的长任务
  （导出/搜索靠 `cancelExportJob` 与 `cancelSearch` 两个方法自己打断）。**没有令牌的方法只能等它跑完。**
  顺带记一句免得被人误认：`cancellation: { parameter: 'signal' }` 这份形状住在随包的
  `src/backend/deps/dsh-llm`（vendored 生成物）里，不是本仓方法面的属性 —— 报告 §P1-2 说的
  「取消要先接上生成链」欠账登记在 [`RELEASE-PLAN.md`](RELEASE-PLAN.md) 的 #11。
  RPC 超时后的行为与「用户主动点取消」不同：主进程会在超时那一刻向 worker 发一条
  `cancel` 消息，worker 只对仍在 active 的那次调用尝试按 `method + args` 找 jobId 并唤醒
  对应取消 Remote（策略表在 [`../src/backend/wechat-cancel.js`](../src/backend/wechat-cancel.js)）。
  调用方没有传 jobId 时，宿主会用当次 RPC 序号给可取消方法补一个内部 jobId，
  超时后按同一序号找回它；真正没有取消槽的方法、或取消回执为 `ok:false` 的任务仍会继续跑；
  主进程保留幽灵账，等迟到回包到达时
  计入 `orphanCompletions`。因此「界面已经报超时」不等于「worker 已经停下来」，
  `wechat:backend-state` 的 `rpc` 字段就是这一差异的可见诊断。

## 4. 数据与缓存

| 位置 | 内容 | 谁写 |
|---|---|---|
| `<userData>/wechat/` | `config.json`、`llm.json`、`secrets.json`、`logs/` | 宿主层（原子写：同目录 tmp + rename） |
| `<userData>/wechat-data/decrypted/` | 解密后的 SQLite 分库 | `src/query/decrypt-all.ts` |
| `.../decoded_images/` | 图片解码缓存（全局槽 + 按用户名槽、缩略带 `.t.`） | `src/query/media-image.ts` |
| `.../sync-state.json` | 同步签名账：哪个目标的**源**签名已成功解密 | `src/query/sync-state.ts` |
| `.../wechat_search.db`、`wechat_rag_vectors.db` | 派生索引（可随时从 `contact.db` / 消息重算） | `src/query/search-*.ts`、`retrieval/**` |

宿主配置写入分两层：路径/微信设置镜像由 `wechat-paths.js` 负责，LLM 当前配置与
profile 集合由 `llm-config-store.js` 负责；两者的 JSON 原子写、损坏备份与告警去重
共用 `atomic-json.js`。旧导入面仍从 `wechat-paths.js` 转发，避免调用方一次拆两层。

四条被机检的纪律：

- **连接生命周期与连接策略分两层**：只读用 `withDb`、写用 `withWritableDb`、要跨 `await` 用
  `withDbAsync`（[`../src/backend/wechat-data/src/query/db-open.ts`](../src/backend/wechat-data/src/query/db-open.ts)）；
  页缓存策略与 `DatabaseSync` 构造器唯一实现住在
  [`../src/backend/wechat-data/src/sqlite-connection.ts`](../src/backend/wechat-data/src/sqlite-connection.ts)，
  生产代码不再直接 import `node:sqlite`，宿主在 bundle 加载后显式调用 `configureSqliteCachePolicy`。
  判据是"跑完之后整棵树仍可删"（Windows 上句柄没关就是 EBUSY/EPERM），不是数源码里有没有 `close`：
  [`../src/backend/wechat-data/tests/query-db-lifetime.spec.ts`](../src/backend/wechat-data/tests/query-db-lifetime.spec.ts)。
- **媒体/地图等产品出网走后端**：头像、原图、封面、地图底图等统一走后端代理
  （主机白名单 + 操作记录 + 本机缓存），渲染层的 `<img>` 也只放行本机来源。
  CSP 的 `connect-src` 同样只放行本机来源；远程图片与地图数据分别经
  `query/remote-image.ts` / `query/map-geo.ts` 由后端代取。渲染层剩余的 `fetch` 只允许
  同源 API 与 `blob:`/`file:` 本机资源，调用点台账（`outbound-site-coverage.spec.ts`）继续
  对每一个 `fetch` 收口。
  ⚠️ 这里**没有"用户可关的开关"** —— 应用内的出网开关已于 2026-09-30 整体移除
  （`privacyGate` 现在只做「按设置脱敏 + 写一条审计行」两件事）。要彻底断网只能靠系统防火墙。
  出网点清单见 [`PRIVACY.md`](PRIVACY.md)。
- **同步签名账跨进程**：`lastState` 是进程内存里的 Map，重启即空 ⇒ 源没变也会被误判成"变了"
  而整库重解密（`message_1` 一次 ≈ 147 MB / 37456 页）。`sync-state.json` 把它落盘，
  首 tick 播种，于是冷启动命中既有的"未变就跳过"分支。**判定逻辑一行没改** ——
  实时同步的新鲜度不受影响的只有"启动不必白解一遍"。
  判据：落盘只取**成功子集**（`takeSyncSuccesses()`，绝不直接写乐观记录的 `lastState`）；
  账本读不出来 / 版本不认识 / 条目形状不对 / 产物被删，**一律回到整库重解密** ——
  少解一遍只是慢几秒，跳过一次是永久显示旧数据。见
  [`../src/backend/wechat-data/src/query/sync-state.ts`](../src/backend/wechat-data/src/query/sync-state.ts)。
- **缓存是 SWR**：`cachedBySig` / `cachedFetch` 以"文件签名"为键，过期先回旧值再后台刷新；
  签名必须覆盖**真正被读到的东西**（只签 `sns.db` 而实际还读了 `contact.db` 就是错的键）。

## 5. 不让事件循环卡住

后端 worker 是同步串行的：一个长任务会把后面所有调用排队（实测有单次 54 秒的分析任务）。
所以重读查询一律按"行数 + 字符数 + 时间预算"三档让出（`yieldToLoop`），
判据是**探针真的拿到过 tick**：
[`../src/backend/wechat-data/tests/query-yield-discipline.spec.ts`](../src/backend/wechat-data/tests/query-yield-discipline.spec.ts)。
新增大表扫描时没有让出点，这条会红。

worker 的两条入口（桌面 IPC 与手机 HTTP）共住 `main.js` 创建的同一把
[`../src/backend/http-queue.js`](../src/backend/http-queue.js) 并发闸：并发 2 + 排队上限 32，
统计里保留等待/执行时延与当前方法；远程服务停止时只排空 `remote` 通道，不连带拒绝桌面排队项。
长任务另有一个更小的排队上限（1 个在跑 + 4 个排队）：它们一条可能占住 worker 十分钟，
如果允许像轻读请求一样堆到 32 条，少数几个重活就能把两条入口堵死数小时。
这层闸解决的是「远程长任务无限叠加上来、桌面端自己还能无限插队」的背压不对称；它**不**把
worker 变成真并行，同步长任务不让出时后面的调用仍要等。

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
| 后端 bundle | `npm run build:backend` → `wechat-data/lib/index.js` | `npm run check:backend` 在临时目录重建后与当前工作树逐字节比对 |
| `lib/types/**.d.ts` | `npm run build:types` | `npm run check:types` 同上（前端只从这里取后端类型） |
| `docs/API.md` | `npm run docs:api` | `npm run docs:api:check` |

改后端 `src` 必须把 `lib/` 与（方法面变化时的）`docs/API.md` 一起提交，否则 CI 的产物一致性门禁会红。
一致性检查不再依赖 Git 索引干净：它把构建结果写到系统临时目录，比对的是当前工作树里的生成文件。

## 8. 还没有机检的部分（如实说）

- 界面行为本身（是否真的看得见某个面板）只有 SSR 冒烟 + 少量真机 e2e（Playwright 驱动真实 Electron）；
  其余靠源码级接线判据 —— 它能证明"接上了"，不能证明"渲染对了"。
- 打包态才成立的行为（许可证真签、asar 内容、`app.isPackaged` 闸门）由
  `npm run package:smoke` / `security-guard:smoke:packaged` 覆盖，不在单测里。
- 性能类事实（N36 的耗时口径、真机打点）见 [`RELEASE-PLAN.md`](RELEASE-PLAN.md) 的 N36 条目，
  它依赖具体机器，不做零容忍门禁。（原先那份独立的性能基线报告已随文档精简删除，
  其中的实测数字与测量口径保留在 git 历史里。）
- **2026-10-08 文档精简同时丢掉了两层"元检查"，如实记**：
  ① `audit:selftest`（12 条判据 × 双向负控，验"判据自身可不可信"）—— **没有等价替代**。
  这一层原本管的是"判据会不会自己坏掉"（例如清单变空 ⇒ 恒真、存在性断言等于没断言），
  现在只能靠写判据时人工配反例自证；
  ② `coverage:matrix` / `coverage:check`（174 接口 × 36 页签的性能矩阵与主题覆盖矩阵）
  及其生成脚本 —— 它们靠已删除的台账文档作为主体，文档没了工具没有意义。
  受影响的还有一条变异登记（`M375`，守台账行里的序号不许丢），按纪律删条目 +
  同步下调 `REGISTRY_MIN`（370 → 369）。
