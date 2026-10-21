# 00 · Alpha 只读架构参照（资源加载 / 缓存 / 内存 / 模块边界）

> **范围声明**：只读 `D:\Alpha\_recon\asar\**` 解包快照与 `_recon\REPORT.md`、`_recon\E2E_REPORT.md`；未修改、未运行 Alpha 及其补丁。**授权/订阅/破解相关内容不在本报告范围**，一律排除；这里只取"资源加载、按需取用、缓存、内存、模块边界"可迁移的做法。
> 取证方式：静态读 esbuild 产物（保留函数名）与 Vite 产物；体积为 `Get-ChildItem` 实测。行号以 `_recon/asar` 快照为准（out/main/index.js 共 76065 行）。本文件 ≤250 行。

## 0. 结论（先看这 6 条）

1. **媒体链路与我们的方向一致但实现更重**：Alpha 用 `alpha-media://sha256/<64hex>` 内容寻址 URL + 主进程内存缓存（上限 128 MB / 512 条）+ 协议流式返回（`out/main/index.js:430-431,439-640`）；本仓已用 `wechat-media://decoded/<rel>` 流式读盘、字节不进 IPC（`src/backend/media-protocol.js:45-117`）——**本仓更省内存，不要照搬它的 128 MB 内存缓存**；值得借的是它的"并发 lane + 字节预算淘汰"控制手法。
2. **Alpha 为多窗口拆了 3 个 HTML 入口和 3 个独立 preload**（index / image-viewer / notification，preload 分别为 51.4 KB / 1.8 KB / 1.8 KB），图片查看器还有独立 session partition（`index.js:2623-2632,72991-72999,73735-73749`）。本仓单窗口 + 应用内查看器 + 473 B 交接 preload 已是更省内存的等价做法（`src/backend/handoff-preload.js`）——**"每窗口最小 preload"已具备，"多开窗口"不要学**。
3. **Alpha 前端是"一个大 chunk"**：主 chunk 2796.4 KB、全渲染进程 6 个 JS 共 3552.5 KB，主 chunk 内**动态 import 计数为 0**（`out/renderer/index.html:11-16`；实测 `Select-String 'import\('`）。本仓 31 个面板 `React.lazy`（`panel-loaders.tsx:12-46`）、主包约 354 KB ——**Alpha 在此项是反例，不要回归单体**。
4. **Alpha 的启动是"轻 splash 先出、主窗延后 reveal"**：splash 是 `data:` 内联页（`index.js:10078-10122`），主窗 `ready-to-show` 后**6 秒**才 reveal（`RENDER_GRACE_MS=6000`，`index.js:73593,73645-73647,73673-73682`）。本仓"先建窗（内联占位首帧）→ 再起后端"（`main.js:523-530`、`ui-dist/index.html:69-75`）用同一套首帧目标但**不额外开 renderer**；Alpha 的 splash 会多一个进程内存，**不采纳**，只借鉴"reveal 时机"的体验处理。
5. **Alpha 已把"按需取用"做到模型层**：语音模型/引擎有下载管理器与独立下载 IPC（`index.js:6126,9566-9625,10489-10491`；`REPORT.md:31` 记"按需 101 MB worker"）。本仓 whisper 引擎/模型**同样支持下载并可换目录**（`query/whisper.ts:35,543-604`），安装包里的 `ggml-tiny.bin` 74.1 MB 只是兜底 —— **能力已具备，剩余是"装包是否默认不带"的产品决策**，不列入本轮性能改造。
6. **Alpha 用"有界映射"防内存缓慢爬升**：图片 grant 512 条、播放 grant 256 条、流 URL 绑定 64 条、recent capability 512 条（`index.js:64,1453,1504,522`）。本仓多数长期 Map 已有条数上限（见 A11），缺口只在"大对象缓存按字节计量"；这一项与 A1 合并处理即可。

## 1. Alpha 结构速览（只作为对照基线）

| 项 | Alpha 0.3.5（`_recon/asar` 快照） | 本仓（对照） | 证据 |
|---|---|---|---|
| 主进程 | 单文件 `out/main/index.js` 3.03 MB / 76065 行（esbuild 保留函数名） | `main.js` 581 行 + `src/backend/*.js` 42 个宿主模块（另有手写 .d.ts） | 实测；`main.js` 行数 |
| 重活进程 | 外部原生二进制（engine/data-host/security-host），经长度前缀帧 RPC | `utilityProcess` worker 跑 JS bundle（1.88 MB） | `REPORT.md:39-56`；`backend-supervisor.js:150-160` |
| preload | 3 个：`index.js` 51.4 KB / 761 行；`image-viewer.js`、`notification.js` 各 1.8 KB | 主 `preload.js` 179 行；交接卡 `handoff-preload.js` 473 B | 实测；`preload.js:19,179` |
| renderer | 5.12 MB / 164 文件：6 JS（3552.5 KB）、4 CSS（623.5 KB）、150 PNG（1060.3 KB）、3 HTML | `ui-dist` 4.42 MB：60 JS（2222.6 KB）、35 CSS（673.3 KB）、148 PNG（921.5 KB）、1 HTML | 实测 |
| renderer 入口 | `index.html`、`image-viewer.html`、`notification.html` 三入口 | 单入口 `ui-dist/index.html` + 31 个懒加载面板 | `out/renderer/*.html`；`panel-loaders.tsx` |
| asar 内 node_modules | 4 个包 / 204 文件 / 1.43 MB（protobuf、liquid-glass 等） | 42.5 MB app.asar（vendor 依赖 + 资源） | 实测 |
| 媒体协议 | `alpha-media://` 三路子路由（moment/av/默认），按 session 各挂一份 handler | `wechat-media://decoded/<rel>` 单路由 + 根白名单 | `index.js:362,72990,73737-73749`；`media-protocol.js:45-66` |

## 2. 值得借鉴的具体做法（逐条判定）

### A1. 双阈值内存缓存 + FIFO 淘汰（**建议借鉴**）
- **Alpha 做法**：`MAX_CACHE_BYTES = 128 MB`、`MAX_CACHE_ENTRIES = 512`，每写入一张图就 `bytes += len`，超任一阈值即从 Map 头部淘汰并回减字节（`index.js:430-431,564-572`）。
- **本仓现状**：图片主缓存是磁盘 `decoded_images/<username>/<md5>.<ext>`（`query/media-image.ts:5-6`），`wechat-media://` 直接流式读盘（`media-protocol.js:102-117`），不占主进程内存。但**内存层已存在且只按条数封顶**：远程图 data URL 内存层 `MAX_MEM_ENTRIES = 300`（`query/remote-image.ts:90-117`，注释自认"data URL 是原图字节的 ~1.33 倍，攒多会抬高常驻"）；签名缓存有按 key 族的访问计时 LRU + per-family cap（`query/meta.ts:62-109`），**没有按字节计量**。
- **判定/落地**：适用（内存治理方向，不改业务行为）。把"按条目数"的 base64/data URL 缓存升级为"字节预算 + 条目上限"双阈值（Alpha 的 128 MB/512 条是量级参考，本仓按实测定）；不要引入主进程媒体字节缓存（本仓流式读盘更省）。

### A2. 按资源类型分并发 lane + 有界等待队列（**建议借鉴**）
- **Alpha 做法**：`photo` lane 并发 4 / 排队 60，`emoji` lane 并发 2 / 排队 30；空位由等待队列补位，单次下载 60 s 超时且 `unref`（`index.js:452-455,549-581`，超时在 `:557`）。注释明确：表情可能在 engine 侧挂数秒，专用小池可避免它长期占用大图下载槽（`:450-451`）。
- **本仓现状**：全局一把 HTTP 队列（并发 2 / 排队 32 / 重活排队 4，`src/backend/http-queue.js:36-58`）；表情批量另有并发上限（`remotes/media.ts:64-67` 提到 `EMOTICON_FETCH_CONCURRENCY`）。原图/封面/表情仍共享同一调度面。
- **判定/落地**：部分适用。建议给"小图（表情/头像）"与"大图（原图/封面/视频封面）"分 lane 并各自设队列上限，防止表情洪峰挤占原图；改动面在 worker 取图链路，需补测。

### A3. 数据代际（epoch/generation）一次性失效 + 取消在途请求（**建议借鉴**）
- **Alpha 做法**：代际变化时清空 senders/issued/cache/pending、把 bytes 归零、取消等待队列、`abort()` 全部控制器（`index.js:459-470,474-497`）；`download()` 里每步前后都 `assertAccess`/`valid`，代际一变立即抛 `MOMENT_MEDIA_REVOKED`（`:544-548,560-565`）。
- **本仓现状**：后端有 `bumpDataGeneration()` / `dataGenerationSig()` 与 `cachedBySig` 失效（共享简报 §4；`query/meta.ts:58`），前端 `cachedFetch` 是 SWR（`cache.ts:74`）；但渲染层在途 `fetch` 没有统一的"代际切换即 abort"。
- **判定/落地**：适用。给 `cachedFetch` 的请求挂 `AbortController`，在 `dataGenerationSig` 变化/`wechat-data/updated` 时 abort 在途旧请求，避免旧响应回填缓存（需保持 SWR 语义）。

### A4. 内容寻址 URL 作为缓存键（**不改造协议，只借鉴思路**）
- **Alpha 做法**：媒体 URL 是 `alpha-media://sha256/<64hex>`，同一内容天然同键、可做不可变缓存；读取时校验文件 identity（dev/ino/mtime/ctime/nlink，`index.js:54-66,112-120`）。
- **本仓现状**：`wechat-media://decoded/<username>/<md5>.<ext>`（`media-protocol.js:45-66`），路径含 md5 已天然去重；协议目前 `Cache-Control: no-store`（`:109`）。
- **判定/落地**：不适用（改协议风险大、收益需先量）。可借鉴的是"URL 即缓存键"：若将来给协议加 ETag/immutable，key 用 `<md5>` 即可，无需新协议。

### A5. 每窗口最小 preload + 独立 session partition（**部分适用**）
- **Alpha 做法**：图片查看器独立窗口，独立 `IMAGE_VIEWER_PARTITION`、独立 1.8 KB preload、独立 HTML 入口（`index.js:2623-2632`）；viewer session 单独挂媒体 handler 且禁权限（`:73738-73749`）；另有 `alpha-ai-network`、`alpha-system-proxy-probe` 隔离 session（`:73814-73815`）；清理 Web 缓存只清 default+desktop 两个分区（`:75472-75474`）。
- **本仓现状**：单主窗口；交接卡片用独立 473 B preload（`main.js:407-420`）；无多 session partition；媒体协议不经过 Chromium HTTP 缓存（`no-store`），隔离 session 无收益。
- **判定/落地**：仅"每窗口最小 preload"已具备（`handoff-preload.js` 473 B），无需改。**不要引入多窗口图片查看器**：本仓已实测多一个 renderer 约 200 MB 量级（`src/backend/main-window.js:111-113` 的 DevTools 观测），与降内存目标相反。

### A6. 多入口 HTML + modulepreload（**不采纳**）
- **Alpha 做法**：3 个 HTML 入口，`index.html` 用 `modulepreload` 预取共享 chunk（`out/renderer/index.html:11-14`），但页面级仍是单 chunk（2.8 MB、0 动态 import）。
- **本仓现状**：单入口 + 31 个面板懒加载 + 60 个产物 chunk（`panel-loaders.tsx:12-46`；`ui-dist` 实测）。
- **判定/落地**：不采纳。Alpha 的页面级未拆包是反例；本仓多入口只在"新增独立窗口"时才需要，本轮没有该需求。

### A7. 启动 splash + 延迟 reveal（**不采纳 splash，借鉴 reveal 体验处理**）
- **Alpha 做法**：先开 `data:` URL 的内联 splash（`index.js:10078-10122,73728`），主窗 `ready-to-show` 后再等 `RENDER_GRACE_MS=6000` 才 `show()` 并关 splash（`:73593,73645-73647,73673-73682`）；重初始化（gateway/agent/通知等）都在 splash 期间完成（`:73750-73840`）。
- **本仓现状**：窗口先建、内联占位（`ui-dist/index.html:69-75`），后端 init 在窗口之后（`main.js:523-530`），首帧不等后端 —— 目标相同且**不额外开 renderer**。
- **判定/落地**：不采纳 splash（多一个 renderer 进程）。可借鉴"reveal 时机"：量一次 `ready-to-show → 首屏可交互` 的间隔，若首帧仍有闪烁再考虑延迟 reveal（需数据支撑）。

### A8. 可迁移缓存目录 + 分类清理（**低优先级借鉴**）
- **Alpha 做法**：`CacheDirectory`（`index.js:72533`）把媒体缓存目录持久化到 settings，支持用户换盘、`staged` 复制迁移、失败回退（`:72575-72599`），启动时 `applyPending()` 后才挂协议（`:73731`）；清理接口按 category 分类（`media-cache`/`voice-models`，`:72504-72530`）。
- **本仓现状**：`decoded_images` 固定在 `<userData>/wechat-data` 下（`main.js:172` 的默认数据根 + 后端路径配置），无迁移/分类清理接口。
- **判定/落地**：低优先级（磁盘治理，不影响内存/首屏）。若要动，先与"数据根由后端解析"的现状对齐（`wechat-paths.js`），避免出现两套缓存根。

### A9. 按需下载模型/引擎（**已有能力，不作为本轮项**）
- **Alpha 做法**：语音模型有下载管理、下载状态/取消 IPC、可换模型目录（`index.js:6126,9566-9625,10483-10491`）；`REPORT.md:31` 记"按需 101 MB worker"。
- **本仓现状**：`query/whisper.ts:35,57,543-604` 已实现引擎/模型下载、代理基址、断点/校验与目录迁移；安装包仍带 `ggml-tiny.bin` 74.1 MB 兜底（asarUnpack）。
- **判定/落地**：能力已具备。是否"装包默认不带模型"属产品/离线体验决策，收益只在安装包体积（74.1 MB），不影响运行时内存/首屏；**不建议在本轮纯性能专项里改**。

### A10. 单一 frozen bridge（**已具备，无需改**）
- **Alpha 做法**：preload 内先建 `IPC_CHANNELS` 常量表（`out/preload/index.js:14`），再 `Object.freeze` 分层冻结整个 bridge（`:299` 起逐命名空间冻结），共 761 行 / 51.4 KB。
- **本仓现状**：`preload.js:10-17` 的 `deepFreeze` 递归冻结 + `:179` 单次 `exposeInMainWorld`，179 行；注释已注明"Alpha 的 single frozen bridge 做法"（`preload.js:4`）。
- **判定/落地**：已同构且更简洁，保持现状。

### A11. 有界映射防内存爬升（**部分已具备，缺口是按字节计量**）
- **Alpha 做法**：图片授权 512 条上限、播放授权 256 条、播放 URL 绑定 64 条、最近 capability 512 条（`index.js:64,1453,1504,522`），均在写入时 `while (size > N) delete(first)`。
- **本仓现状**：签名缓存 `msg-by-sid:` cap 200 / `contacts:` cap 96 + 访问计时 LRU（`query/meta.ts:79-109`）、远程图内存层 300 条（`query/remote-image.ts:100`）、`sns-video.ts` FIFO、`wxgf-ffmpeg.ts` 按内容 sha256 LRU —— 多数长期 Map **已有条数上限**，缺的是"大对象缓存按字节计量"。
- **判定/落地**：适用。请内存治理负责人补一份"存 Buffer/base64 的缓存清单"（本报告不越界给具体改动），与 A1 合并处理。

## 3. 明确不适用/反例（附原因）

1. **单 chunk 2.8 MB、0 动态 import**（`out/renderer/index.html:11-16`，实测）→ 本仓已 31 面板懒加载，不能回归单体。
2. **把媒体字节缓存在主进程内存（128 MB 上限）**（`index.js:430,564-572`）→ 与"降内存"目标冲突；本仓流式读盘更省。
3. **多 session partition 隔离**（`index.js:72991,73735-73815`）→ 本仓 file:// 单页 + 自定义协议 `no-store`，没有可隔离的 HTTP 缓存收益，只增复杂度。
4. **按"已加载消息"登记的图片 grant 模型**（`E2E_REPORT.md:59-63` 记录媒体页 6 条 `IMAGE_CACHE_NOT_AUTHORIZED`）→ Alpha 的 grant 是与加载状态强绑定的访问控制；本仓 `wechat-media` 只做根白名单（`media-protocol.js:45-94`），简单且不阻塞翻页浏览，**不要引入**。
5. **通知窗口 `backgroundThrottling:false`**（`index.js:65388`，为保证隐藏时定时器照跑）→ 本仓主窗 `backgroundThrottling:true`（`main-window.js:97`）是省 CPU/电量的正确取舍，保持。
6. **外部原生 engine 多进程架构**（`REPORT.md:39-56`）→ 本仓 `utilityProcess` + 单 bundle 已等价隔离；重构成原生不在性能专项范围、风险极高。

## 4. 风险与边界

- **只读静态观察**：未运行 Alpha、未测其 RSS/首屏/帧率；文中所有数字均为文件体积或源码定位，不是运行时性能数据。跨产品比较只能作方向参考。
- **版本边界**：快照为 Alpha 0.3.5（`_recon/asar` 解包），打包形态/依赖可能随版本变化；行号基于该快照。
- **排除范围**：Alpha 的授权/订阅/许可相关机制不在本次任务内，未作为参照；相关文件未在报告中展开。
- **本仓侧**：报告中引用的本仓机制以当前工作树（含 192 行在途改动）为准；`cdn-policy.ts` 已删除等偏差见 `01-PROJECT-MAP.md` §8。

## 5. 给优化方案的建议（按价值排序）

| 序 | 可借做法 | 落点（本仓） | 预期价值 | 风险/改动面 |
|---|---|---|---|---|
| 1 | 双阈值（字节+条目）缓存上限与统一淘汰（A1） | worker/renderer 内图片/封面/表情缓存；先出清单再改 | 高（直接压内存峰值/防泄漏） | 中；需先量后改，不改行为 |
| 2 | 代际切换 abort 在途请求（A3） | `pages/wechat-data/cache.ts` 的 `cachedFetch` | 中高（防旧响应回填、减无效 IO） | 中；保持 SWR 语义 |
| 3 | 按资源类型分并发 lane（A2） | worker 取图链路（原图 vs 表情/头像） | 中（防表情洪峰拖慢可见区大图） | 中；需基准数据支撑 |
| 4 | 有界映射纪律排查（A11） | worker + renderer 长期存活 Map | 中（防缓慢爬升） | 低（只排查/加 cap） |
| 5 | reveal/首帧体验测量（A7 的"量"） | `ready-to-show → 可交互` 打点 | 中低（体验） | 低 |
| 6 | 缓存目录可迁移（A8） | `decoded_images` / 数据根配置 | 低（磁盘治理） | 中；与后端路径解析耦合 |

> 若需要，Alpha 侧更细的坐标（本报告引用的每一处）可直接按 `_recon/asar` 路径复核；本仓测量原始数据见 `working/perf/project-map/raw-measurements.md`。
