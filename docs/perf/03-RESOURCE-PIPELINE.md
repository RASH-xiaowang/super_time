# 03 · 资源加载链路审计与分级策略

> 角色：资源加载优化负责人（task-3）。范围：`D:\super-time-wechat` 只读审计（产品代码零改动、未启动应用、未跑全量测试）。
> 证据口径：源码 `文件:行号` + 构建产物实测字节 + 仓库既有真机记录（标注来源）；未运行实测的收益一律标「待测」并给测量方法。
> 原始命令与清单：`working/perf/resource/evidence.md`。

## 0. 结论（先看这 6 条）

1. **聊天图片链已是「路径 + 协议流式」，但批量入口仍逐张走单张解码**：30 张图 ≈ 30 次消息分片库开合（批量 md5 只在预热段合并，62→33 次的开合优化只省一半，`media-image.ts:164-182`）；`fileOnly` 模式下 worker 仍把每张缓存图 `readFile + base64` 后丢掉（`media-image-async.ts:47-66`、`gateway-media-ops.ts:125`、`remotes/media.ts:662-667`）——首屏图片链路最大一笔白工。
2. **首屏 CSS 241.7KB 里 134.1KB（55.5%）是 Bootstrap**：Grid 50.6KB + Utilities 83.5KB（`ui-entry.tsx:25-26`）；而 Utilities 全仓只有 1 处 3 个类在用（`overview-panel.tsx:241`）。字体 0（无 `@font-face`）、图标全内联 SVG，这两块没有浪费。
3. **默认首屏（数据总览）首帧后还要拉 441.6KB 的 echarts**：`CalendarHeatmap` 是 lazy chunk，但 `HeatmapSection` 未像世界地图那样 `LazyMount`（`overview-sections.tsx:90-96` vs `:104-114`；chunk 见 `overview-export.ts:22`），其解析与首屏取数/图片解码抢主线程。
4. **`decoded_images` 与 `<decoded>/voices` 没有容量上限/TTL/淘汰**，只在图片密钥变更时整体清空（`wechat-config.ts:347-357`、`:365-378`）；朋友圈原图另有三层有界预算（IDB 512MB / 2GB / 8GB）。聊天图片与语音解码产物随使用单调增长。
5. **远程取回有白名单 + 有界重试 + 逐点超时 + 有界缓存，但两处口径不一致**：前端攒批 40 vs 后端单次上限 20（`api-media.ts:396` vs `remote-image.ts:44`），同窗口 >20 个地址会有一半直接拿到「单次最多 20 张」；桌面图片协议 `Cache-Control: no-store`（`media-protocol.js:109`）与浏览器端 `/api/media` 的 `private, max-age=60`（`http-server.js:482`）不一致。
6. **共享简报里「`query/cdn-policy.ts` 是唯一出网口径」已过期**：该文件 2026-09-30 已删除（`gateway-privacy-gate.spec.ts:76-81` 断言其必须不存在）。现行唯一出网边界是主机白名单 `cdn-hosts.ts:31-87`（判在发请求之前）+ `net/fetch-retry.ts` 的有界重试。

## 1. 静态资源：ui-dist 如何进首屏

- **加载路径**：`main.js` 建窗 → `createMainWindow`（`main-window.js:43-109`）用 `win.loadFile(uiEntryHtml())` 从 `file://` 加载 `src/client/ui-dist/index.html`；产物缺失时回退 `src/index.html`（`main-window.js:14-18`）。同目录产物也由 LAN 服务原样提供（`main.js:387-390`、`http-static.js:12-13`），哈希文件名走 `immutable` 一年缓存（`http-static.js:97-103`）——桌面端不经过这层。
- **首屏字节**：`index.html` 只引 1 个 module script + 1 个 stylesheet（`ui-dist/index.html:19-20`），`file://` 无压缩 ⇒ 首屏原始字节 ≈ **595.9KB**（JS 354.2 + CSS 241.7；CSP 在 `index.html:17`）。
- **没有 preload/prefetch**：全仓 `grep modulepreload|rel="prefetch"` 为 0；面板 chunk 全部 `React.lazy`（`panel-loaders.tsx:12-46`）+ Suspense（`WechatDataPanel.tsx:906-908`），首次切页签才请求并解析。Vite 配置只有 `chunkSizeWarningLimit: 550`（`vite.config.js:24-33`），无 manualChunks。
- **首屏 CSS 构成**（原始体积，压缩/去重后合入 241.7KB）：Bootstrap Grid 50.6KB + Utilities 83.5KB（`ui-entry.tsx:25-26`）、bridge 7.7、主题 49.6+6.1、`wechat-data.module.css` 20.4、`kit.module.css` 37.4、壳层 ~22KB（titlebar/scrollbars/mobile/titlebar-status）；面板 CSS 已按面板拆文件（如 `Chats-*.css` 42.2KB），不在首屏。
- **字体/图标全量首屏？** 否：无 `@font-face`、无字体文件、无图标字体；导航图标是配置里的 SVG path（`nav-config.ts:59-246`）、标题栏图标内联在 HTML（`index.html:25-66`）。`wxemoji/` 148 个 PNG（921.5KB）按消息文本 `<img>` 按需加载（`utils/wechat-emojis.ts:2-9`、`message-text.tsx:195-197`）。
- **随包死资源**：`ui-dist/onboarding/*.webp` 4 张 601.6KB 在源码中 **0 引用**（grep `bg-stage`/`webp` 无命中）——只影响安装包/磁盘，不影响运行期加载。
- **主窗口开关**：`backgroundThrottling: true`（`main-window.js:97`）——后台窗口会降频，与「后台静默刷新」的既有事件驱动模型配套。

## 2. 图片链路：协议 → 解码 → 上屏

### 2.1 分层与真实成本

| 层 | 实现 | 证据 | 成本/风险 |
|---|---|---|---|
| 磁盘解码缓存 | 双槽 `<md5>.<ext>`（最好）/`<md5>.t.<ext>`（缩略兜底），按 md5 内容寻址 | `media-image.ts:405-434`、`:443-457` | **无上限/TTL**，仅密钥变更清空 |
| 批量预热 | 唯一触发点 = 批量取图入口；每批 ≤200；md5 一次 IN + .dat 路径一次 IN | `remotes/media.ts:61,645`、`image-warm.ts:46-88` | 命中检查每张最多 14 次 `access`（`image-warm.ts:73-78`） |
| 单张解码 | 先 `resolveImageResourceHint` 开分片库查 md5，再读缓存/解 `.dat` | `media-image.ts:108-162`、`media-image-async.ts:133-190` | **每张一次库开合**；慢机 70-110ms/次（`media-image.ts:167-182` 引 N36） |
| fileOnly 剥 url | 网关删 base64 字段 | `gateway-media-ops.ts:122-126`、`remotes/media.ts:662-667` | 只省 IPC；worker 仍读盘+base64（`media-image-async.ts:58`） |
| 批量合并 | 同 tick 合并、chunk 200 | `image-batch.ts:29-71`、`api-media.ts:721-750` | 后端 `Promise.all` 200 张无并发界（`remotes/media.ts:647-651`） |
| 渲染层缓存 | 48MB / 512 条 / 单条 8MB 的 LRU（键 `username:localId`） | `image-cache.ts:28-39,90-116` | 命中即一个请求都不发（`chats-media.tsx:593-628`） |
| 释放 | 切页签按会话释放；keep-alive 仅 chats/taskinfo | `use-release-images-on-tab.ts:57-60`、`keep-alive.tsx:19` | 48MB 上限对当前 40B 级 URL 实际只受 512 条约束 |
| 预取 | 可见窗口 ±8 行、滚动停 150ms、`requestIdleCallback` 发、命中/失败不重复 | `use-image-preload.ts:41-45,83-134` | 量小且低优先，方向正确 |
| 协议 | `wechat-media://decoded/<rel>` 白名单+扩展名+流式；`no-store`、无 Content-Length | `main.js:15-18,337-338`、`media-protocol.js:45-117` | 渲染层 LRU 未命中的重挂载（切页签释放后回来/灯箱重开）必重新读盘+解码；影响面待测 |

### 2.2 关键结论

- **最贵的一笔是「批量入口仍逐张走单张入口」**：`getImageDataUrlsBatch` 先用 `resolveImageMd5sBatch` 批量算 md5 写缓存，但返回值仍由 `imageWithAutoUpgrade`→`decodeImageDataUrlAsync` 逐张产出，每张再开一次分片库（`remotes/media.ts:635-651`、`media-image.ts:164-182` 注释自认「剩下 30 次是刻意保留的复用」）。**只要把批量结果传进内部解码（接受已知 md5）就能把 30 张的库开合从 33 次降到个位数**（1 次 md5 IN + 1 次路径 IN + 少量回落），且不改返回值形状。
- **fileOnly 白算 base64**：命中磁盘缓存时 `cachedImageAsync` 仍 `readFile` + `toDataUrl`（内存 ≈ 图片 1.33×），随后被网关删除。桌面端只需要 `file` 字段；应给解码层加「只 stat、不读字节」的模式。
- **批量无并发界**：200 张 `Promise.all` 在单事件循环 worker 上同时压 200 个 `DatabaseSync` 打开 + 读文件；与 RPC 闸并发 2（`http-queue.js:36`）叠加时会长时间占住交互请求。建议有界 8-16。
- **磁盘无淘汰**：`decoded_images`（含 `remote-images/`、`sns-media/`、`voices/` 子目录）与 `moments-media` 的预算不同——前者**完全没有**，后者有 2GB/2 万文件与 8GB 预算（`sns-media-store.ts:48-71,276-279`）。
- **头像/路径批量化现状良好**：头像走 200 条攒批 + 未命中退回单张（`api-config.ts:207-236`），实测 200 头像 34.18ms→6.15ms、省 199 次 IPC（`api-config.ts:199-202` 引基准）；通讯录进面板预热前 300（`contacts-avatar-prewarm.ts:43-67`），缓存 300 条有界（`chats-support.tsx:199`、`misc.ts:70`）。**文件缩略图是缺口**：每格一次 RPC、无批量无渲染层缓存（`Files.tsx:173-190`、`api-media.ts:175-177`），只有 60 条 LRU（`thumb-cache.ts:15`）。
- **CSP 与代理**：`img-src 'self' data: blob: file: wechat-media:`、`media-src ... wechat-media:`（`index.html:17`），无 https 通配——渲染层不直连远端；远端图片由后端代取回 data URL（`remote-image.ts:202-252`），浏览器/LAN 走同源 `/api/media`（`wechat-media.ts:34-38`、`http-server.js:455-482`）。

## 3. 媒体与导出

- **语音**：`<decoded>/voices/<svr>.wav` 命中即读，否则 wx_silk 解码（`voice.ts:209-251`，实测 13ms/条、45s≈2.1MB）；临时 silk 在 `finally` 删除（`:199-202`）；播放是点击才取 data URL（`chats-media.tsx:387-405`），但**每行挂载固定打 2 个 RPC**（VoiceInfo + Transcript，无批量无缓存，`chats-media.tsx:351-360`）；voices 目录无预算/淘汰。
- **聊天视频**：不落临时文件，`shell.openPath` 交系统播放器（`chats-media.tsx:443-471`）；每行挂载 1 RPC 取封面+路径（`:450-462`、`media-video.ts:43-81`）。
- **朋友圈视频**：内联播放把整段 MP4 读进内存→base64 data URL（`sns-video.ts:544-578`，超时 60s），**下载侧无大小上限**；缓存有界（封面 300 条、data URL 64MB，`sns-video.ts:65,70,83-100`），前端只保留 3 条（`moments-support.tsx:25`）且关闭即删（`moments-videos.ts:96-102`）。
- **文件卡「下载」**：后端整文件 `readFileSync`→base64（`media-file.ts:122-124`），前端 `<a download>`（`chats-support.tsx:275-292`）；fileCache 只限 300 条、**字节无上限**（`media-file.ts:17`、`meta.ts:480`）——大附件会同时抬高 worker 堆、IPC 与渲染堆。
- **导出**：流式 zip + 原子 `.partial` 落地，失败即删（`export-io.ts:33-46,58-80`、`zip.ts:149-154`）；媒体条数 5000 上限（`export-io.ts:24`）；导出在重活车道（`remote-policy.js:17`）。半成品只在进程硬崩时残留。
- **释放/虚拟化**：消息/收藏/文件/朋友圈列表均已虚拟化（`Chats.tsx:414`、`Favorites.tsx:64`、`Files.tsx:160`、`moments-panel.tsx:196`），DOM 与解码量只跟视口相关；语音播放对象随组件卸载暂停（`chats-media.tsx:379-381`）。

## 4. 远程资源：出网口径、超时/重试/并发/降级

- **口径更正**：`query/cdn-policy.ts` 已删除（2026-09-30），见 §0.6。现行边界：① 主机白名单 `cdn-hosts.ts:31-87`（`qq.com`/`wechat.com`/`wechatcdn.cn`/`qpic.cn`/`weixin.qq.com`/`qlogo.cn`；文章页单独只认 `mp.weixin.qq.com`）；② 白名单判定一律在发请求前（`remote-image.ts:214`、`remotes/media.ts:442`）。
- **重试/超时**：`fetchWithRetry` 3 次、只重试网络异常/408/429/5xx、`Retry-After` ≤5s、退避 500/1500/4500ms+抖动、每次尝试单独计时（`net/fetch-retry.ts:49-59,110-175`）。逐点超时：远程图 8s（`remote-image.ts:58`）、原图 15s（`image-original.ts:151`）、表情 10s（`media-image.ts:697`）、朋友圈视频 60s（`sns-video.ts:559`）。例外：第三方原图服务用裸 `AbortSignal.timeout`（`wxcdn-original.ts:160,242`）。
- **并发/上限**：远程图单次 20、并发 10、单张 8MB、失败 60s 冷却、落盘 `remote-images/` + 内存 300 条（`remote-image.ts:36-52,100-119,259-286`）；前端 80ms 攒批、内存 600 条/3M 字符、失败表 500/60s（`api-media.ts:459-515`）。
- **失败降级**：后端返回可读 error（主机不在清单/超时/格式不可渲染）；前端 `RemoteImg` 4s 超时即回落本地 fallback，并区分 pending/failed（`remote-img.tsx:40,87-104`）；离线短路不发请求（`:81-84`）。
- **全局背压**：RPC 闸并发 2、排队 32、重活 1 跑+4 排、等待 240s（`http-queue.js:36,39,48,58`）；媒体取数在重活名单里（`remote-policy.js:21-27`），在线时朋友圈取图降为 NORMAL（`call-priority.js:117-138`）。真机记录：一屏 30 张朋友圈图会被串行、第 6 张起「重任务排队已满」（`call-priority.js:93-99`）。
- **两处不一致（建议尽快对齐）**：① 前端 `REMOTE_IMAGE_CHUNK = 40`（`api-media.ts:396`）注释称与后端对齐，实际后端 `MAX_IMAGES_PER_CALL = 20`（`remote-image.ts:44`），超出部分被 `fetchRemoteImages` 以 overflow error 返回（`:271-273`）⇒ 群成员头像/链接卡一屏 >20 张时半批失败并反复重试；② 同一图片，桌面协议 `no-store`、浏览器路由 `max-age=60`（`media-protocol.js:109` vs `http-server.js:482`）。

## 5. 面板数据：首开 IPC/查询、缓存上界与失效

| 面板 | 首开 RPC（静态计数） | 证据 | 缓存/失效 |
|---|---|---|---|
| 数据总览 | 4（overview+insights 并行 → ledger+storage） | `overview-panel.tsx:87-120` | localStorage render cache 24h/1.5MB；首帧读缓存秒开（`:69-80`） |
| 聊天会话 | sessions 1 + messages 1 + 头像批量 1 + 图片批量（可见窗口）+ idle 预取 | `api-read.ts:155,188`、`api-config.ts:233-236`、`api-media.ts:741-763` | snapshot 30s；消息缓存 5s；keep-alive 试点 |
| 通讯录 | contacts 1 + 类目计数 1 + 头像预热 1 批（≤300） | `Contacts.tsx:326,341,365` | snapshot 30s；avatarCache 300 |
| 朋友圈 | 4（moments 500 + monthly + self + authors）+ 媒体逐条 | `moments-data.ts:89,97,114,119` | 列表用 render cache 仅失败兜底（`:101-107`）；图片 IDB 512MB |
| 文件与存储 | files 页 30 1 + 全量重复统计 1 + 每可见缩略图 1（约 15-30） | `Files.tsx:99,132,173-190` | 列表无 snapshot 复用；缩略图 60 条 |
| 收藏与表情 | favorites 1 + 每个 part 1-2 + 表情批量（200/次） | `Favorites.tsx:89-125`、`favorites-media.tsx:88-104`、`api-media.ts:227-274` | 表情 snapshot；收藏无渲染缓存 |
| 年度报告 | annual 1 + years 1 + review 1 + avatars 批量 1 | `Annual.tsx:626,636,647,681` | 各接口 snapshot 30s |
| 社交图谱 | graph 1 + knowledgeGraph 1 + avatars 批量 1 | `Graph.tsx:104,108,307` | snapshot 30s；头像预算 ≤320 |
| 总结 | tasks 1 + records 1 + sessions(500) 1 + llm 1 | `DailySummary.tsx:138-165` | snapshot 30s |
| 设置（弹窗） | configFull + keys + path + whisper(idle) + detect(idle) + diag ≈ 6 | `settings-state.tsx:356-362,375-398,410-412,432,460` | 无统一缓存；idle 延后 3 项 |
| 任务信息 | listTaskInfos 1 + scanTriggers 1（其余 8 个为动作） | `TaskCenter.tsx:357,412-445` | snapshot 30s |

- **缓存层上界明确**：内存快照 TTL 30s、最多 60 键（`cache.ts:12-19,56`）；localStorage render cache TTL 24h、单条 ≤1.5MB（`:168-170,217`）；失效 = 数据世代 `bumpDataGeneration` + `invalidateSnapshotCache`/`invalidateWechatCache`（`:135-166,273-330`），面板用 `useWechatDataUpdated` 监听约 10s 一次的数据事件（`moments-data.ts:161-176`）。
- **口径限制**：上表是**静态调用点计数**，不是运行时 IPC 计数；实际首开次数需真机确认（方法见 §7）。

## 6. 资源分级表（现状 → 策略 → 收益 → 风险）

> 分级维度：关键首屏必需 / 非关键 / 可远程实时取 / 大资源 / 高频复用。策略编码（表中使用）：
> 预加载=#5/#13；懒加载=#4/#5；可见性触发=#4/#13；分块=#6/#15；流式=#9/#10/#16；LRU=#7/#8/#11/#12；引用计数/及时释放=#10/#11（前端 `closeVideo`/卸载暂停已落地：`moments-videos.ts:96-102`、`chats-media.tsx:379-381`）。

| # | 资源 | 分级 | 现状（证据） | 建议策略 | 预期收益 | 风险 |
|---|---|---|---|---|---|---|
| 1 | index.js 354.2KB + index.css 241.7KB | 关键首屏 | `ui-dist/index.html:19-20`，file:// 无压缩 | 保持；先砍 CSS（见 #2） | 基线已量 | 低 |
| 2 | Bootstrap Utilities 83.5KB | 关键首屏（实为死重） | 全仓仅 `overview-panel.tsx:241` 用 3 个类；`ui-entry.tsx:26` 全量引入 | 移除 import；把 3 个类写成局部 CSS（放在 bridge 之前保持级联） | **首屏 CSS −83.5KB（−34.5%）**；解析耗时待测 | 中：级联顺序/遗漏工具类（用 `css:bundle-diff` + 面板截图验收） |
| 3 | Bootstrap Grid 50.6KB | 关键首屏（仅 Overview 用） | 只有 Overview/RegionBoard 用 `row/col-*`（`overview-sections.tsx:59-328`） | 暂留（跨 chunk 级联风险大）；后续可迁到局部 CSS grid | 若迁出 −50.6KB；待测 | 中高：栅格规则必须早于主题加载（`ui-entry.tsx:15-24` 注释） |
| 4 | echarts CalendarHeatmap 441.6KB | 非关键首屏 | 懒 chunk（`overview-export.ts:22`）但热力卡无条件渲染（`overview-sections.tsx:90-96`） | 套 `LazyMount`（照抄 `:104-114` 世界地图）+ 空闲触发 | 首屏少 441.6KB chunk 的下载/解析（解析量级最大）；耗时待测 | 中：图表晚出现；弱机收益最大 |
| 5 | 面板 chunk（Chats 174.7/Graph 175.7/Settings 133.2） | 非关键（按需） | `panel-loaders.tsx:12-46` + Suspense；无预取 | 维持 lazy；可选 hover/idle 预取下一个 tab | 待测（本地盘 fetch 快，瓶颈在解析/首屏竞争） | 中：提前占内存与解析主线程 |
| 6 | 聊天图片（批量入口） | 关键首屏 + 高频复用 | 逐张开库 + fileOnly 仍 base64（§2.2） | 批量 md5 复用、fileOnly 跳过读字节、`Promise.all` 有界 8-16 | **30 图开库 33→个位数**（1 次 md5 IN + 1 次路径 IN + 少量回落；基线 62→33 见 `media-image.ts:167-182`）；耗时/内存改善待测 | 低：返回形状不变；加等价性用例 |
| 7 | wechat-media 协议响应 | 高频复用 | 流式 200/404、`no-store`、无 Content-Length（`media-protocol.js:102-117`） | 改可缓存：短 `max-age`（对齐 HTTP 的 60s）或加版本参数（mtime/size）+ 条件请求 | 重复请求/重解码下降，量级待测（用 protocol.handle 计数） | 中：`<md5>.<ext>` 会被升级/收割原地覆盖（`image-upgrade.ts:255`），必须带版本或短 TTL |
| 8 | decoded_images 磁盘（含 remote-images/sns-media/voices） | 大资源 | 无上限/无 TTL（`wechat-config.ts:347-378`，`db-health.ts:106` 只统计） | 复用 `sns-media-store` 的字节预算+按 mtime 淘汰（默认 8-16GB、env 可覆盖），保留最近 N；`voices/` 单列预算 | 磁盘可控；避免长期运行涨到几十 GB；重解成本待测 | 中：淘汰后重解（图片 1 次解码/语音 13ms/条）；需开关与日志 |
| 9 | 文件卡整文件 data URL | 大资源 | 整文件 base64 过 IPC（`chats-support.tsx:275-292`、`media-file.ts:122-124`）；fileCache 300 条无字节界 | >8MB 改「后端路径 + 主进程流式复制到用户选定路径」（已有 `saveFileDialog`/`openPath` 先例）；小文件保留 data URL | 消除大附件 OOM；单次内存从 O(文件) 降到流式缓冲 | 中：新增返回字段/IPC；保存语义不变 |
| 10 | 朋友圈视频内联播放 | 大资源 + 可远程实时取 | 整段 MP4 进内存→base64（`sns-video.ts:544-578`），下载侧无上限 | 加大小上限（如 128MB）+ 超限提示改用系统播放器（对齐聊天视频）；可选流式落临时文件后播放 | 防 OOM；大视频仍可看 | 中：产品交互变化（内联→外部播放器） |
| 11 | 语音 | 大资源 + 高频复用 | wav 缓存无预算；每行 2 RPC；data URL 点击才取 | voices 纳入 #8 预算；VoiceInfo/Transcript 合并成批量接口（同图片/表情的攒批手法） | 20 条语音行 40→2 RPC（静态可推导）；耗时待测 | 低：纯读接口；注意失败语义 |
| 12 | 文件缩略图 | 高频复用 | 每格 1 RPC、无批量无渲染缓存（`Files.tsx:173-190`） | 新增 `getFileImageDataUrlsBatch`（或复用 image 批量入口）+ 缩略图 LRU 提到 200 | 30-60 RPC → 1-2；首开文件面板明显 | 低中：接口新增需契约测试 |
| 13 | 头像 | 高频复用 | 200 条攒批 + 未命中单张回落；缓存 300（`api-config.ts:207-236`） | 保持；预热改可见性触发（通讯录搜索态已跳过） | 已量：200 头像 34.18→6.15ms、省 199 IPC | 低 |
| 14 | 远程图片（链接卡/群头像） | 可远程实时取 | 白名单+重试+8s+10 并发+60s 冷却+双层缓存；chunk 40 vs 20 | `REMOTE_IMAGE_CHUNK` 改 20（或后端放宽到 40，二选一但必须一致） | 消除半批 overflow 失败与重试；失败率可测 | 低：改 1 个常量 + 对齐用例 |
| 15 | 面板查询（RPC） | 关键首屏 | snapshot 30s/60 键 + render cache 24h/1.5MB + 事件失效；重活车道 1+4 | 首开 >3 RPC 的面板（朋友圈/文件/设置）按「可见分片」错峰：首屏 1-2 个查询，其余 idle；勿缩 TTL | 首开 RPC 峰值下降，待测 | 中：数据新鲜度/骨架屏体验 |
| 16 | 导出 | 大资源 | 流式 + 原子 + 失败清理（`export-io.ts:33-80`） | 保持；启动时清理残留 `.partial-*` | 磁盘残留可控 | 低 |

## 7. 最该先做的 3 个（收益/风险排序）

1. **图片批量路径三件套（后端单点，低风险高收益）**：`getImageDataUrlsBatch` 内部把 `resolveImageMd5sBatch` 结果传给解码入口（新增内部参数，避免 30 次分片库开合）；`fileOnly` 时只 stat 不 `readFile`/不 base64；`Promise.all` 改有界 8-16。**收益**：30 张一屏开库 33→个位数（基线路径已在 `media-image.ts:167-182` 记录 62→33），base64 白工归零；耗时/内存降幅待测（慢机开库 70-110ms/次，收益更大）。**风险低**：返回形状不变，加「批量 vs 逐张」整批等价用例 + DB 开合计数断言即可验收。
2. **首屏减负（前端/构建，收益确定）**：移除 `bootstrap-utilities.min.css` 引用并把仅用的 3 个类本地化（首屏 CSS −83.5KB = −34.5%）；`HeatmapSection` 套 `LazyMount`+idle（Overview 首开不拉 441.6KB echarts）。**收益**：产物字节确定；主线程解析/编译下降预计几十 ms 量级（弱机更明显，待测）。**风险中**：CSS 级联顺序与图表出现时延——用 `npm run css:bundle-diff`、面板截图、首屏 chunk 清单三条一起验收。
3. **媒体口径与缓存收敛（小改动 + 可观测）**：远程图 chunk 40→20（或后端统一 40）消除半批失败；`wechat-media` 的 `no-store` 改「带版本短缓存/条件请求」；`decoded_images`+`voices` 加字节预算淘汰（复用 `sns-media-store` 现成 trim）。**收益**：远程图失败率与重复取数下降（可计数验证）、磁盘占用可预测；**风险中**：缓存正确性（升级原地覆盖需版本参数）与淘汰后重解。

## 8. 风险与边界（哪些是推断、哪些验不了）

- 本报告为**只读静态审计**：首开 RPC 次数、协议请求数、no-store 的重复解码耗时、各优化端到端收益均为「静态可推导/待测」，未启动应用（避免污染在途工作区）。
- 可推导的数字（如 30 图 33 次开库、首屏 CSS −83.5KB、echarts 441.6KB）以源码/产物为证据；标「待测」的收益需在基线机器上按 `docs/perf/README.md` 的测量纪律复测。
- 建议均不改业务语义/接口契约；涉及新增字段（`file`/批量缩略图）须同步 `api-module-split.spec`、`docs/API.md` 与契约测试。所有缓存建议都有显式上界，不引入「无界缓存」或「远程资源全本地化」。
- 未触碰 `D:\Alpha`；未运行 `npm test`/未提交 git；仅新增 `docs/perf/03-RESOURCE-PIPELINE.md` 与 `working/perf/resource/`。
