# Super Time 系统架构图

面向「接手这个仓库的人」：**进程怎么分、模块怎么划、数据从哪来到哪去、边界守在哪**。
所有数字与结论都对着当前工作树核对过，核对口径见 §6；没核对到的一律标注「推测」。

> 与 [`../ARCHITECTURE.md`](../ARCHITECTURE.md) 的分工：
> 那份是**文字版**的架构总览（依赖方向、五条机检规矩）；
> 这份是**图 + 可重建的源文件**，重点是层级、边界、调用链的可视化。

---

## 1. 产物清单

| 文件 | 内容 | 形态 |
|---|---|---|
| `system-architecture.svg` | **主图**：六层系统架构，含调用下行与数据上行 | 矢量源文件（可编辑） |
| `system-architecture.png` | 同上，1.4× 位图导出（贴文档/PPT 用） | 643 KB |
| `request-data-flow.svg` / `.png` | **一次调用的 14 步** + 反向实时刷新链（6 步） | 矢量 / 位图 |
| `build-pipeline.svg` / `.png` | 构建链：源码 → 产物 → 一致性闸门 → 发布 | 矢量 / 位图 |
| `*.html` | 可缩放/拖拽的交互查看器（滚轮缩放、双击复位） | 自包含，离线可用 |
| `architecture.mmd` | Mermaid 源（可移植版本，供其他工具重渲染） | 文本 |
| `gen-arch.py` | **生成器**：改数据 → 重跑 → 三张图一起更新 | Python 3，零第三方依赖 |
| `refresh.py` | **每日刷新**：重画 + 指标漂移对比 + 过时文件候选清单 | Python 3，零第三方依赖 |
| `baseline.json` | 指标基线（首次刷新时自动生成，供漂移对比） | JSON |

重建：

```bash
python docs/architecture/gen-arch.py       # 只重画
python docs/architecture/refresh.py        # 重画 + 重导 PNG + 指标对比 + 过时扫描
```

> Windows 上若 `python` 不在 PATH，用托管解释器：
> `C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe gen-arch.py`

### 每日自动刷新

已配置定时任务「每日架构图刷新 + 过时文件扫描」，每天 **09:00** 执行 `refresh.py`，
报告写到 `.workbuddy/reports/arch-refresh-YYYY-MM-DD.md`。

它做三件事，**都不含删除**：

1. 重画三张 SVG 并用 Chrome headless 重导 PNG；
2. 采集 16 项关键指标，与 `baseline.json` 比对，报告漂移（代码变了但图没跟上）；
3. 扫描 `working/` 与备份残留，输出**候选清单**——删除等人工逐项确认。

指标漂移只报告、不自动改文案：图里的数字是给人看的结论，自动改写会把「图错了」变成「图悄悄变了」。


---

## 2. 三张图怎么分工

```
system-architecture.svg   看「有哪些东西、边界在哪」   → 静态结构
request-data-flow.svg     看「一次点击经过谁」         → 动态链路
build-pipeline.svg        看「改了代码怎么变成产物」   → 交付链路
```

主图从上到下是**调用方向**（入口 → 渲染 → 主进程 → worker → 数据 → 外网），
左侧色条标识层级；层与层之间的箭头标的是**实际走的通道名**，不是泛泛的「调用」。

---

## 3. 系统全景

### 3.1 六个层

| 层 | 职责 | 规模 | 关键文件 |
|---|---|---|---|
| **入口层** | 三类调用来源：桌面窗口 / 手机浏览器 / RPA·Webhook | 3 个入口 | `main-window.js`、`http-server.js`、`query/rpa/**` |
| **渲染进程** | React 18 面板、启动三站、前端缓存与图表 | 602 个 ts/tsx，约 12.2 万行 | `ui-app/ui-entry.tsx`、`WechatDataPanel.tsx`、`api-core.ts` |
| **主进程（宿主层）** | 窗口与安全、IPC、三道闸、RPC、并发、配置、LLM 传输、更新、许可 | 42 个模块 / 10,787 行 | `main.js`(581)、`call-gates.js`、`backend-rpc.js`、`backend-supervisor.js` |
| **后端 worker** | 219 个 `@Remote` 方法、业务查询、密钥、检索、本地模型 | 158 个 query 模块 / 46,545 行 | `wechat-worker.js`、`wechat-host.js`、`gateway*.ts` |
| **数据层** | 解密快照、派生索引、媒体缓存、配置与密钥 | 22 个解密库 + 14 个派生库 | `query/decrypt-all.ts`、`query/sync.ts`、`query/db-open.ts` |
| **外部接口** | LLM、微信 CDN、地图、模型下载、更新、RPA | 16 个出网点 | `llm-http.js`、`query/cdn-hosts.ts`、`query/map-geo.ts` |

### 3.2 进程模型（只有三块，没有第四块）

```
┌─────────────────┐  contextBridge   ┌──────────────────┐  postMessage   ┌──────────────────┐
│  渲染进程        │ ───────────────▶ │  Electron 主进程  │ ─────────────▶ │  utilityProcess  │
│  sandbox: true  │  46 个 IPC 通道   │  组合根 + 闸门    │  RPC seq 配平  │  后端 worker      │
└─────────────────┘ ◀─────────────── └──────────────────┘ ◀───────────── └──────────────────┘
                                              │                                    │
                                              │ HTTP + SSE（手机端，默认不监听）      │ node:sqlite
                                              ▼                                    ▼
                                        手机浏览器                          解密快照 / 派生索引
```

- **渲染层从不直接读盘**，也从不 import 后端实现；它拿到的只有 `{ ok, value }` / `{ ok:false, error }`。
- 主进程与 worker 之间**只有一条**消息通道，请求/响应按 `seq` 配平。
- 后端是独立进程的原因写在 `wechat-worker.js` 头部：同步 `node:sqlite` 曾有单次 45.6 秒的事件循环阻塞。

### 3.3 Gateway 继承链（方法面的唯一出处）

```
TypertRemoteService
  └─ GatewayCore          运行时状态 / 构造 / 实时同步接线
      └─ GatewayRead     58 个 @Remote（读）
          └─ GatewayAskOps        44（问答）
              └─ GatewayMediaOps  30（媒体）
                  └─ GatewayExportOps 17（导出/备份）
                      └─ GatewayVoiceOps 8（语音）
                          └─ GatewayConfigOps 34（配置/任务）
                              └─ GatewayLayaOps 9（本地模型）
                                  └─ GatewayTaskCenter 12（任务中心）
                                      └─ GatewayDbHealth 3（体检）
                                          └─ GatewayClawbot 16（ClawBot）
                                              └─ WechatDataGateway（叶子，空类）
```

**为什么要这么拆**：协议层按「最派生原型的自有描述子」枚举方法面，所以方法壳可以放在任意一层的基类里，
对外接口一字不变。`gateway.ts` 只剩一个空叶子类。总数 **219**，由 `docs:api:check` 守住。

---

## 4. 三条关键链路

### 4.1 启动链

```
app.whenReady()
  ├─ 注册 wechat-media:// 协议（必须早于 ready）
  ├─ userData 隔离（安装版 → %APPDATA%\Super Time）
  ├─ 单实例锁 → 诊断日志 → 密钥目录 ACL 收紧
  ├─ 解析入口 HTML → 建 ipcTrust（绑定入口 URL）
  ├─ 注册 46 个 IPC 通道（全部 ipcTrust.wrap 收口）
  ├─ createWindow()                     ← 先建窗，首帧不等后端
  ├─ backendSupervisor.bootstrap()      ← 拉 utilityProcess + init
  └─ updateService.scheduleAutoCheck()  ← 延迟 30s
```

首屏三站（在**渲染层**串行判定，豁免口只有两个）：

```
引导四页 → 隐私同意 → 许可证授权 → 主界面
                （同意必须早于授权，由 e2e:h14-consent 真机钉住）
```

### 4.2 一次界面调用（14 步，见图二）

```
面板事件 → api-*.ts → preload(contextBridge) → ipc-wechat + ipcTrust
  → call-gates 三道闸 → http-queue → backend-rpc → worker 分派
  → Gateway @Remote → query/** → SQLite ─┐
                                          └→ 原路回包 → unwrap → setState
```

三道闸的顺序是刻意的（`call-gates.js` 文件头写了理由）：

| 闸 | 行为 | 为什么在这个位置 |
|---|---|---|
| ① 等后端就绪 | 最多等 20s，不立刻报错 | 立即回错会让首屏显示**假的**错误，渲染层分不清「还没好」与「坏了」 |
| ② 调试豁免 | `debugGates().skipGates` | 打包态恒 false；必须排在许可之前 |
| ③ 许可证授权 | `authorizeCall` | **校验自身抛异常时拒绝而不是放行** |

超时与取消：普通调用 60s、长任务 600s、dispose 握手 5s。超时不是「静默放弃」——
主进程会向 worker 发 `cancel`，并把这次调用登记成幽灵（上限 256 条），
迟到回包计入 `orphanCompletions`。所以「界面已报超时」不等于「worker 已停下」。

### 4.3 数据流：从微信原始库到界面

```
Weixin.exe（运行中）
   │ ① 内存扫描取密钥（koffi / ReadProcessMemory + YARA 特征 + PBKDF2 校验）
   ▼
rawKey ──────────────────────────────────┐
                                          │
xwechat_files/<wxid>/db_storage/*.db      │  SQLCipher 4
   │ ② PBKDF2-HMAC-SHA512(rawKey, salt, 256000) → AES-256-CBC 分页解密
   │    页面布局：16B salt + 4000B 密文 + 16B IV + 64B HMAC（4096B/页）
   ▼
<数据根>/decrypted/**   ← 原子 rename 发布，schema 必须与原始主库同构
   │ ③ 查询层读（withDb 只读 / withWritableDb / withDbAsync）
   ├──────────────▶ 直接聚合查询（消息、会话、联系人、朋友圈…）
   │ ④ 建派生索引（可随时重算）
   ▼
wechat_search.db · message_fts.db · wechat_kb_vectors.db · wechat_tasks.db …
   │ ⑤ 检索：稀疏 BM25 + 稠密向量 + fusion + rerank
   ▼
answer-runtime（intent → tool-loop → evidence 接地 → 引用）→ LLM（可选）
   │ ⑥ 回包
   ▼
@Remote → RPC → IPC → unwrap → 渲染
```

**实时刷新是反向的第二条链**（图二下半区）：

```
WAL 变更 → sync-watch → sync-trigger 合并器 → 页级补丁/尾部追加
  → sync-status 发布内存修订号 → wechat:event（桌面 IPC + 手机 SSE 同一份 payload）
  → 渲染层：EVENT_MAP → DOM CustomEvent → 缓存失效 → 只在该分片 messageChanged 时拉增量
```

为什么要「每秒一次内存读」而不是「每秒一次消息 SQL」：后者把 worker 的单线程打满。
`sync-state.json` 把「哪个源的签名已成功解密」落盘，冷启动才能命中「未变就跳过」——
否则每次启动都要白解一遍 `message_1`（约 147 MB / 37456 页）。

---

## 5. 边界与不变量

| 边界 | 怎么守 | 判据 |
|---|---|---|
| **渲染层拿不到 Node** | `sandbox:true` + `contextIsolation:true` + `nodeIntegration:false` | 安全探针在真实渲染进程里断言 `typeof require === 'undefined'` |
| **渲染层不能直连外网** | CSP `connect-src 'self'`；`img-src` 无 `https:` 通配，只 `self/data/blob/file/wechat-media:` | `privacy-statement.spec.ts` 逐指令核对 |
| **IPC 只认自己的窗口** | `ipc-trust.js` 校验 sender + 主 frame URL 必须是入口 HTML | 46 个通道全部经 `ipcTrust.wrap` |
| **导航默认拒绝** | `navigation-policy.js`：页面导航只允许 `file:` 且落在应用目录内 | `security-guard:smoke` 真机跑三类被禁行为 |
| **媒体只走白名单** | `cdn-hosts.ts`：6 条腾讯系后缀 + 文章页单独收窄到 `mp.weixin.qq.com` | 用 `new URL().hostname` 判后缀，不用 `endsWith`（否则放过 `evilqq.com`） |
| **密钥不落 config.json** | `saveConfig` 把密钥字段改写进 `secrets.json` 并删除原字段 | `getConfig` 从 secrets 读回，调用方无感 |
| **密钥文件只有本人可读** | `secure-fs.js` 用 `icacls /inheritance:r /grant:r <SID>:(OI)(CI)F` | 按进程令牌 SID 授权（`USERNAME` 在部分环境是错的） |
| **后端产物必须与源码一致** | `check:backend` / `check:types` 临时目录重建后逐字节比对 | 不一致即 CI 红 |
| **方法面只有一个出处** | `@Remote` 装饰器 + `docs/API.md` 自动生成 | `docs:api:check` |
| **不许绕过并发闸** | 桌面 IPC 与手机 HTTP 共用同一把 `http-queue` | 并发 2 / 排队 32 / 重活 4 / 等待 240s |

**已知的「没有开关」**：应用内**没有任何出网开关**（2026-09-30 移除）。
要彻底断网只能用系统防火墙。现存「默认关」的三处都不是全局闸：
`wxcdn_enabled`（第三方原图服务）、原图自动下载注入（`img_helper.dll`）、局域网扫码入口。

---

## 6. 事实核对表

每个数字都能在仓库里复查，核对命令在最后一列。

| 事实 | 值 | 出处 / 核对方式 |
|---|---|---|
| Remote 方法数 | **219** | `docs/API.md`（`npm run docs:api` 生成）；`grep -c @Remote gateway*.ts` |
| Gateway 继承层级 | **11 层基类 + 1 叶子** | `grep -n "class Gateway" src/backend/wechat-data/src/gateway*.ts` |
| `remotes/**` 域处理器 | 29 文件 | `ls src/backend/wechat-data/src/remotes/*.ts \| wc -l` |
| query 层 | 158 文件 / 46,545 行 | `ls src/.../query/*.ts \| wc -l`；`cat ... \| wc -l` |
| retrieval 层 | 15 文件 / 4,591 行 | `ls src/.../query/retrieval/` |
| 宿主层直属模块 | 42 文件 / 10,787 行 | `ls src/backend/*.js \| wc -l` |
| `main.js` | 581 行（体积棘轮 1000 行上限） | `wc -l main.js` |
| `preload.js` | 179 行 | `wc -l preload.js` |
| IPC 唯一通道 | **46**（47 个调用点，`browser-handoff:restore` 同时有 handle 与 on） | `grep -oE "handleIpc\('([^']+)'" ...` 去重 |
| 前端 ts/tsx | 602 文件 / 约 12.2 万行 | `find src/client/ui-wechat/src -name "*.ts*" \| wc -l` |
| panels 视图分片 | **171** 个 .tsx | `ls .../panels/*.tsx \| wc -l` |
| 导航 | 39 可路由 tab / 5 组 / 15 可见（+设置）/ 23 hidden | `nav-config.ts` 的 `WechatTab` 联合类型 |
| 前端 chunk | 37 个 `React.lazy` → 62 个 js chunk | `panel-loaders.tsx`；`ui-dist/assets` |
| 设计令牌 | 140 个 `--nm-*`；圆角 6 档 / 间距 7 档 | `scifi-theme.css` |
| 后端 bundle | `lib/index.js` 2.32 MiB / 2374 KB（ESM 单文件） | `du -h` |
| 解密参数 | PBKDF2-HMAC-SHA512 × 256000；页 4096B | `query/decrypt-all.ts`、`query/sqlcipher-page.ts` |
| 派生库 | 14 个（search / fts / kb / tasks / privacy / summary…） | `grep -rhoE "'[a-z_]+\.db'" query/*.ts \| sort -u` |
| 出网点 | **16** 个（台账 20 条，其中 4 条是同源相对路径） | `src/backend/tests/outbound-site-coverage.spec.ts` |
| RPA 适配器 | 8 家 | `ls src/.../query/rpa/vendors/` |
| 超时 | 普通 60s / 长任务 600s / dispose 5s | `backend-rpc.js:21-37` |
| 并发闸 | 并发 2 / 排队 32 / 重活 4 / 等待 240s | `http-queue.js:36-59` |
| 重启策略 | 最多 3 次，退避 500/1500/4500ms，就绪等待 20s | `backend-supervisor.js:15-17` |
| 随包语音资产 | whisper 84 MiB（ggml-tiny 74 MiB）+ 引擎 9.6 MiB | `du -sh wechat/whisper` |

**被这次核对纠正的两处**（原计划的旧口径，已按代码改）：

| 项 | 旧说法 | 实际 |
|---|---|---|
| 设计令牌 | 「7 档圆角 / 17 档间距」 | 圆角 **6 档**、间距 **7 档**（140 个 `--nm-*`） |
| IPC 通道 | 「39」 | **46** 个唯一通道 |
| 面板分族 | 「chats 63 · graph 33 · kb 28」 | 那是 `panels/` 下**所有文件类型**的计数；只看 `.tsx` 是 171 个，分族为 chats 22 · clawbot 8 · kb 7 · moments 7 |
| 出网点 | 「19 个」 | 台账 20 条，其中 4 条是同源相对路径 → 实际 **16** 个 |

---

## 7. 工具选型说明

仓库里没有 graphviz / mermaid CLI，`node_modules/.bin` 下也找不到 `mmdc`。
可用方案与取舍：

| 方案 | 结论 |
|---|---|
| Graphviz `dot` | 机器上没有；装二进制要联网，且分层盒式布局需要大量 rank 调教 |
| Mermaid CLI | 需 puppeteer + Chromium 下载（约 150 MB），且自动布局无法精确控制 6 层盒宽 |
| draw.io / 在线工具 | 源文件是二进制 XML，diff 不可读，违反本仓「产物入仓 + 可复查」的纪律 |
| **自写 SVG 生成器（采用）** | 零依赖、纯文本可 diff、坐标完全可控；改数据重跑即更新 |

校验用的是本机 Chrome 的 headless 截图（`--headless=new --screenshot`），
逐张人工比对盒宽与文字溢出；生成器里也内置了按框宽**自动缩字号 + 折行**的两级兜底
（`fit_size()` / `wrap()`），避免长路径把边框顶破。

`architecture.mmd` 是同一份结构的 Mermaid 版本，**不是渲染产物**，
而是给「想在自己工具里重画」的人一个可移植起点；它与 SVG 不共享代码，改结构要两边一起改。

---

## 8. 这张图没覆盖的部分

如实说明，避免把它当成全貌：

- **运行时行为**只有静态证据。界面「是否真的渲染对了」由 SSR 冒烟 + 少量真机 e2e 覆盖，图上无法体现。
- **错误码体系**（`docs/ERROR-CODES.md`）没有逐条画进去，只在回包处标了信封形状。
- **打包态才成立的分支**（许可证真签、asar 内容、`app.isPackaged` 闸门）在图上与开发态同形，实际有差异。
- **性能事实**（首屏后端 ready 中位 2806ms、导出内存峰值等）依赖具体机器，图上不标数字。
- **测试与门禁**只画了「一致性闸门」三条与 CI 三档，`vitest` 单测、变异自证、e2e 的完整矩阵见 `scripts/ci-tiers.mjs`。

---

*生成器：`gen-arch.py`（零依赖）· 图像核对：Chrome headless 截图 · 事实核对时间：2026-10-22*
