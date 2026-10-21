# 05 · 低效代码候选清单与替换方案（可度量）

> 角色：业务逻辑重构负责人（task-refactor / task-5）。产品代码**只读**，本文只给候选与替换方案。
> 原始数据与可复跑脚本在 `working/perf/refactor/`：`bench-smells.mjs`、`bench-results.json`、
> `scan-sync-in-loop.mjs`、`scan-algo.mjs`、`scan-client-and-infra.mjs`、`raw-*.json`。

## 0. 度量口径

- 机器/运行时：本机 Windows x64，Node v24.20.0（与产品同版本），2026-10-21 单次运行内前后对照。
- **没有真实用户数据参与测量**：所有基准用合成库（24 个 `message_N.db` 分片、每个 3 张 `Msg_*` 表 / 2000 行；
  `decoded_images` 3000 条目）复刻**访问形态**，报的是「形态成本」而非某个库的体积效应。
- 计数口径：`src/backend/**` 与 `src/client/**` 中排除 `*.spec.ts` / `tests/`（1477 + 594 个源文件）。
- 基准噪声：单次运行内对照，同 case 预热 3 次后取均值；倍率 <2× 的结论一律标「待测」不作依据。

## 1. 结论（先看这 6 条）

1. **聊天视频消息每挂载一次要做一遍「全分片开库扫描」，实测 2.43 ms/条**（24 分片、目标在最后一个），
   而正确形态 0.089 ms/条 ⇒ **27.4×**。位置 `media-video.ts:84-101`。图片链路早已改掉同一形态
   （`media-image.ts:115` 用 `shardCatalogDirs`），视频/语音没跟上。
2. **同一个调用还额外付 ~0.57 ms/条**：`findVideoArtifacts` 对每个月份目录各做 2 次 `existsSync`
   （`media-video.ts:107-126`，实测每个 miss 的 `existsSync` ≈ 0.0118 ms，24 个月 ⇒ 48 次）。
   于是**单条视频消息的后端成本 ≈ 3.0 ms，全部落在事件循环上**。
3. **解码图缓存命中判定是 14 次 `existsSync`/图、双槽 28 次**（`media-image.ts:418-434` + `:549`）。
   实测未命中 0.165 ms vs 目录索引 0.0014 ms ⇒ **115×**；60 张首屏 ≈ 9.9 ms 阻塞 → 0.08 ms。
4. **客户端视频/语音是逐条 RPC，无合并**（`chats-media.tsx:452` / `:353`）；而**朋友圈视频封面早就有批量入口**
   （`getSnsVideoCoversBatch`，`gateway-media-ops.ts:382` + 客户端攒批队列 `api-media.ts:426`），
   聊天视频/语音没有 ⇒ 基建漏用，且滚动重挂载会**重复**付第 1、2 条的成本。
5. **渲染侧只有 1 处 `React.memo`，却有 340 处 `useCallback` / 91 处 `useMemo`**（594 个客户端源文件）。
   `useCallback` 在子组件未 memo 时完全无效 ⇒ 现有回调记忆化是**仪式性开销**；高开销面板的重渲无人拦。
   这条的收益必须用 React Profiler 采样才能定量，本节标「待测」。
6. **同步 sqlite 的原子成本已量化**：`open+close` 0.029 ms、单次索引命中 `get` 0.0201 ms、
   常量 `prepare+get` 0.0021 ms。据此可判定：任何「每行一次同步查询」的循环，1000 行 = 20 ms 事件循环阻塞；
   本仓 `cachedBySig`(78) / `cachedBySigAsync`(44) / `withDbAsync`(19) / `yieldToLoop`(122，46 文件) 已覆盖大部分，
   **未覆盖的只有第 1、2 条的逐消息媒体解析**。

## 2. 实测常量表（`bench-results.json`，同一次运行）

| 形态 | 实测 |
|---|---|
| 同步 sqlite：`new DatabaseSync(ro)+close` | 0.029 ms/次 |
| 同步 sqlite：索引命中 `SELECT … LIMIT 1`（2000 行表） | 0.0201 ms/次 |
| 同步 sqlite：常量 `prepare+get` | 0.0021 ms/次 |
| 视频 MD5 解析·现状（逐分片开库，24 分片，目标最后） | **2.428 ms/次** |
| 视频 MD5 解析·替换（目录缓存已建 + 只开 1 个分片） | **0.0887 ms/次** ⇒ 27.4× |
| 分片目录一次性构建（24 分片） | 2.55 ms/一次（可被签名缓存摊销） |
| `cachedImage`·命中（前几个 ext 就中） | 0.023 ms/次 |
| `cachedImage`·未命中（14 次 `existsSync`） | **0.165 ms/次** |
| 目录索引（`readdirSync` 3000 条目）+ `Set` 查 | 0.83 ms/一次 + **0.0014 ms/次** ⇒ 115× |
| `Buffer→base64` | 32KB 0.013 / 128KB 0.091 / 512KB 0.441 ms |
| O(n²) 去重（`includes`+`push`）n=2000 | 2.078 ms vs `Set` 0.1425 ms ⇒ 15× |
| 循环内 `new RegExp` ×2000 | 0.165 ms vs 预编译 0.052 ms ⇒ 3.2×（绝对值 0.08 µs/次） |
| 循环内重复 `JSON.parse`（200×90KB） | 40.75 ms vs 复用 0.0011 ms |

## 3. Top 10（按 收益/风险 排序）

### T1 · 视频消息 MD5：逐分片开库，且无任何缓存
- **现状**：`media-video.ts:84-101` `resolveVideoMd5`：`messageShardFiles()`(`:20-24`) 后对**每个**分片
  `new DatabaseSync`(`:88`) → `sqlite_master` 查表(`:90`) → `PRAGMA table_info`(`:92`) → `SELECT … WHERE local_id`(`:95`)。
  入口 `remotes/media.ts:166-171 getVideoInfo`，被 `chats-media.tsx:452` 的 `MessageVideo` 挂载 effect 逐条调用；
  该调用**没有 cachedFetch/无客户端缓存**（`api-export-ops.ts:178` 直通），滚动重挂载即重复付费。
- **替换方案**：改用同仓已有的分片目录 `meta.ts:331 shardCatalogDirs` / `:359 shardCatalog`（已含 `tables`→分片
  与列名，`shard.tables.get(table)` 已在 `media-image.ts:115-121` 验证可用）：按表定位到**唯一**分片再开库；
  外加按 `(username, localId)` 的小 LRU（媒体解析结果是纯函数，`bumpDataGeneration` 时失效）。
- **预期收益**：2.43 ms → 0.089 ms（**27.4×**，实测）；含 T2 后单条 3.0 ms → 0.10 ms 量级。
  20 条可见视频 ≈ 60 ms 事件循环阻塞 → ≈2 ms。
- **风险**：低。定位逻辑是对 `shardCatalogDirs` 的复用；失效口径必须跟 `bumpDataGeneration`/目录签名一致，
  否则会返回上一次的 md5（`dataGenerationSig` 已有语义，`meta.ts:311-316` 注释说明该层缓存的口径）。
- **验证**：现**无**视频 spec（`tests/` 只有 `media-voice.spec.ts`）。需新增：
  ① 参数化「表在第 k 个分片」k=0..N，断言解析出的 md5 与旧实现逐值相同；② 分片新增/替换后缓存失效；
  ③ 端到端对比打开含视频会话时的封面 data URL 与 `videoPath` 字段不变（可复用 `media-resolve-batch.measure.spec.ts:61` 的夹具手法）。

### T2 · 视频封面定位：每月目录 2 次 `existsSync`，最坏 48 次/条
- **现状**：`media-video.ts:107-126 findVideoArtifacts`：`readdirSync(root)` 后对每个月目录
  `existsSync(md5 + '_thumb.jpg')` + `existsSync(md5 + '.mp4')`；没封面时**全扫完**。
  实测 miss `existsSync` 0.0118 ms ⇒ 24 个月 ≈ 0.57 ms/条。
- **替换方案**：同一次 `readdirSync` 建 `Map<month, Set<basename>>`，按目录签名（`fileSigOf`）缓存；
  命中判定变 `Set.has`。或直接复用 `sns-image.ts:353-378 refreshAttach` 的「索引 + 签名 + 闸门」手法。
- **预期收益**：0.57 ms → ~0.005 ms/条（按 T1 同款 100× 量级），与 T1 叠加。
- **风险**：低。唯一语义点是「新视频落盘后必须可见」——索引缓存必须带 mtime/签名闸门（`sns-image.ts:346` 的
  `SNS_MONTH_REFRESH_MIN_MS = 2_000` 就是同一问题的既有答案，可直接照抄口径）。
- **验证**：与 T1 同 spec；补一条「新增封面文件后下一次调用能看见」的时序用例。

### T3 · 解码图缓存判定：14 次 `existsSync`（双槽 28 次）/图
- **现状**：`media-image.ts:418-434 cachedImage` 双层循环 `[false,true] × RENDERABLE_EXTS`(`:402`, 7 个 ext)，
  命中判定是 `existsSync`(`:422`)；调用点 `:549` 连调两次（全局槽 + 按用户名槽）。
  实测未命中 0.165 ms/图；60 张首屏 ≈ 9.9 ms。
- **替换方案**：`decoded_images` 目录级索引（`readdirSync` 一次 + 目录签名缓存，命中查 `Set`），
  `readFileSync` 保持不变（字节必须读）。索引失效挂 `fileSigOf`/`bumpDataGeneration`。
- **预期收益**：0.165 → 0.0014 ms/图（**115×**，实测）；首屏 60 张 −9.8 ms。
  注意**命中场景只有 0.023 ms**，所以真实收益集中在「首屏/冷缓存/未命中」那一批。
- **风险**：中。两个槽位（原图 / 缩略）与「谁先解出来谁占位」的语义是修过的缺陷（`:404-412` 注释），
  索引只能加速**查找**，不能改变**槽位选择顺序**；缓存失效漏了会让新解出的原图看不见。
- **验证**：`image-upgrade.spec.ts`、`media-image.spec.ts`、`image-path-batch.spec.ts`、`gateway-image-batch.spec.ts` 全绿；
  另加对拍断言：索引判定结果与「逐个 `existsSync`」对 3000 条合成目录**完全一致**（含 .t. 槽、坏条目）。

### T4 · 客户端视频/语音逐条 RPC，未复用既有攒批队列
- **现状**：`chats-media.tsx:452`（视频）与 `:353`（语音）在每条消息组件里各发一次单条 RPC
  （`api-export-ops.ts:178/162` 直通 `remote()`，无 `cachedFetch`）。同类问题**朋友圈视频封面已解决**：
  `gateway-media-ops.ts:382 getSnsVideoCoversBatch` + 客户端攒批 `api-media.ts:398-426`；
  图片更早：`api-media.ts:739-774` + `image-batch.ts:29 createImageLoadQueue`。
  `createImageLoadQueue` 已被复用 **5 次**（`api-media.ts:227` 表情 / `:431` 朋友圈封面 / `:542` 远端图 / `:741` 聊天图 /
  `api-config.ts:207` 头像），**唯独聊天视频与聊天语音没有队列**；`api-export-ops.ts:162/178` 是纯直通。
- **替换方案**：新增 `getVideoInfosBatch` / `getVoiceInfosBatch`（**只加不改**，单条入口保留，与
  `gateway-remote-surface.spec.ts` 的「单条入口保留」口径一致），客户端复用 `createImageLoadQueue` 的合并窗口。
- **预期收益**：同屏 N 条并发 RPC 合成 1 次（N=20 ⇒ RPC 次数 20→1）；批量实现内部可**一次性**建分片目录
  （T1/T2 的一次性成本从「每条」变「每批」），单条解析 3.0 ms → 0.1 ms 量级。
  **注意**：攒批只解决"同屏并发"；滚动重挂载的**重复**请求要靠客户端结果缓存（照 `use-image-preload.ts:95 recallImage`
  那种「已有结果就不再发」），两者不是同一件事，别混为一谈。
- **风险**：中高。**新增远程方法 = 对外契约增面**，需 Lead 明确许可（简报 §1「不改变接口契约」对「新增」是否放行；
  既有 `gateway-image-batch.spec.ts` 是同类新增的先例）。
- **验证**：新增 batched vs 单条对拍 spec（逐条结果字段完全相等）；`gateway-remote-surface.spec.ts` 守住 remote 清单。

### T5 · 语音 `svr_id` 回退分支：同样全分片扫
- **现状**：`media-voice.ts:32-49 messageServerId`，形态与 T1 相同（`:34` 循环 / `:36` 开库 / `:37` sqlite_master /
  `:40` 查询），由 `:81` 在「`VoiceInfo` 直查无行」时调用。
  **注意**：主路径（`Name2Id` + `local_id`）只开 1 个库，**不是**逐条全扫；只有回退才付 2.43 ms 级成本。
- **替换方案**：同 T1（`shardCatalogDirs` 定位 + LRU）。
- **预期收益**：回退场景 2.43 ms → 0.089 ms；触发率待测（需真机统计 `getVoiceInfo` 走回退的比例）。
- **风险**：低。回退语义（`svr_id` 命中后按 `create_time DESC` 取最新）必须保持不变。
- **验证**：`media-voice.spec.ts` 已存在，直接作为等价性基线；补一条「直查无行 → 回退命中」的用例。

### T6 · 搜索结果窗口加载：表存在性已缓存，但每分片仍开一次库
- **现状**：`search-query.ts:62-84 loadMessageWindow`：`windowTableCache`(`:64-76`) 已缓存「该分片有没有这张表」，
  但命中后仍 `new DatabaseSync(shard)`(`:80`) 逐分片试，直到查到行才 break(`:99` 注释)。
- **替换方案**：用 `shardCatalogDirs` 的 `tables` 直接定位持有该会话表的分片，只开 1 个库；`windowTableCache` 可作为
  二次兜底保留。
- **预期收益**：最坏 24 分片 × 0.029 ms ≈ 0.7 ms → 0.03 ms/次（按实测 open 常量）。搜索是主交互路径，每次检索都会走。
- **风险**：低。定位信息来自同一份目录缓存，`meta.ts` 已是对外稳定接口。
- **验证**：新增「同一会话窗口结果与旧实现逐字段相等」对拍；`search-*` 既有 spec 全绿。

### T7 · 渲染侧：`useCallback` 340 处但 `React.memo` 仅 1 处
- **现状**：客户端 594 个源文件里 `useEffect` 292、`useMemo` 91、`useCallback` 340、`memo` **1**
  （唯一一处在 `MomentsOptimized.tsx`）。`chats-media.tsx:343 MessageVoice` / `:446 MessageVideo` /
  `:585 MessageImage` / `:705 MessageEmoticon` 均为普通函数组件，且各自持有 2–6 个 state + effect。
- **替换方案**：先给「行内高频、props 稳定」的 4 个消息块加 `memo` 并保持 props 引用稳定
  （`m` 对象在 `chats-polling.ts:160` 的 `[...prev, ...add]` 里旧元素引用不变，具备 memo 生效条件）；
  **不要**全仓铺 `memo`，也不要删现有 `useCallback`。
- **预期收益**：**待测**（需 React Profiler 采样 commit 次数与 commit 耗时）。定性依据：父层每次状态变化都会重渲
  整棵消息 subtree，而 `MessageVideo`/`MessageVoice` 渲染体里包含 base64 data URL 拼装（T3 的产物是几百 KB 字符串），
  重渲即重复引用比对与 DOM props diff。
- **风险**：中。memo 依赖 props 引用稳定；一旦某处传内联对象/数组，memo 退化为无效且增加比对开销。
- **验证**：`npm run ui:interactive-budget` / `ui:longlist-e2e`（`scripts/longlist-virtualization-e2e.mjs`）作为门禁；
  另用 Profiler 采集「滚动 5 屏」的 commit 数与最长 commit，改动前后同机同脚本对比。

### T8 · O(n²) 去重：`!arr.includes(x)` 后 `push`
- **现状**：`favorites.ts:178`（`if (user && !out.includes(user)) out.push(user)`）、
  `group-info.ts:129/136/138`（`!parts.includes(t)` 后 push）。实测 n=2000 时 2.078 ms vs `Set` 0.1425 ms（15×）。
- **替换方案**：改用 `Set` 收集 + 一次 `[...set]` 保序输出。
- **预期收益**：实际 n 多为百级 ⇒ 单次 0.02–0.5 ms；15× 倍率但绝对量小。**不建议单独立项**，随该文件其它改动顺手做。
- **风险**：极低（保序 + 去重语义不变；注意 `Set` 对 `NaN`/对象引用与 `includes` 的 SameValueZero 一致，无差异）。
- **验证**：`favorites`/`group-info` 既有 spec 对拍输出数组逐元素相等。

### T9 · 循环内 `new RegExp`：已有 `cachedRe` 基建未用
- **现状**：`moments-insights.ts:169`（`new RegExp(n + '="([^"]*)"')` 在每个 moment 上重建）、
  `retrieval/aggregate.ts:126`、`css-cascade.ts:530`；而 `parse-xml.ts:29 cachedRe` 就是为这件事写的
  （`parse-system.ts:54-56` 注释：「原先 14 次 `new RegExp` 都是同一个模式」）。
- **替换方案**：改走 `cachedRe(key, build)`（`RE_CACHE_MAX = 128`，`parse-xml.ts:27`）。
- **预期收益**：3.2×（实测），但绝对值仅 **0.08 µs/次** ⇒ 只有在 1e5 级循环才有意义。当前调用规模（moments 数千条）下
  只能省 0.1–0.4 ms。**列在此处是为了「基建一致性」，不是收益项**。
- **风险**：极低；注意 `cachedRe` 带 `g` 标志的正则共享 `lastIndex`，必须确认不复用带 `g` 的实例（`css-cascade.ts:530` 那条就是 `g`，
  改之前要改成非 `g` 或 `matchAll`）。
- **验证**：对应解析模块既有 spec 对拍；`RE_CACHE_MAX` 溢出行为已有单测。

### T10 · 同步 fs/sqlite 常量的**用法规则**（非改造项，用于复核剩余热点）
- **现状**：生产代码同步 fs 调用按文件计：`whisper.ts` 39、`sync.ts` 35、`backup.ts` 30、`media-image.ts` 22、
  `sns-media-store.ts` 18、`media-video.ts` 15；落在**循环体内**的同步 fs 共 **117 处**（`raw-sync-in-loop.json`）。
  其中 `sync.ts`/`backup.ts`/`decrypt-all.ts`/`whisper.ts` 属**冷路径**（用户显式触发的解密/备份/转写），
  不应按热路径口径改。
- **替换方案**：以第 2 节常量为判据——**循环内同步 sqlite 累计 >5 ms 或同步 fs >50 次**的才纳入改造候选，
  并要求同一循环里 `await yieldToLoop()`（`query-yield-discipline.spec.ts` 的 P1-2 清单 + `guard-coverage-ledger.spec.ts`
  已把「修过的模块必须有让出」变成守卫，新改的模块要同步进台账）。
- **预期收益**：避免把冷路径改造误当成收益项（历史上这类误判在 `RELEASE-PLAN.md` 出现过）。
- **风险**：若把冷路径也改成分片异步，会引入「导出/备份过程中状态可见性」问题（`backup-atomic.spec.ts`/`export-cancel-82.spec.ts` 守的就是这类边界）。
- **验证**：改造后必须过 `guard-coverage-ledger.spec.ts`（否则 CI 红）。

## 4. 「不要做」的 5 个诱惑项

1. **不要把图片解码 / 索引 / 词云搬到 `worker_threads`。** `kb/parse-pdf.ts:12-13` 记录了真机结论：
   在 Electron 主进程里 `new Worker(...)` 直接抛 `Cannot transfer object of unsupported type`（实测）。
   本仓对 CPU 密集段的正确解法是 `yieldToLoop` 分片（46 个文件、122 处），继续沿用它。
   且**图谱布局早已不在主线程**：`graph-layout.ts:516 new Worker(new URL('./graph-layout-worker.ts'))` —— 别重复改造。
2. **不要给 `api-clawbot.ts`（15 个函数）/`api-task-center.ts`（9 个）整体套 `cachedFetch`。** 这些几乎都是动作/变更
   （`apiCreateClawbotInstance`、`apiSendClawbotMessage`、`apiDeleteClawbotInstance`…），缓存即改语义。
   `cachedFetch` 的正确用法已示范在 `api-read.ts:155/188/214`（只包幂等读 + 明确 TTL）。
3. **不要动 `article-cover.ts:435-441` 的 `existsSync` 循环**：整段在 `if (trace)`（`:416`，环境变量 `SUPERTIME_COVER_TRACE`）里，
   生产不执行。这是 grep 计数最容易骗人的一类。
4. **不要动 `settings-state.tsx:317-319` 的 `getBoundingClientRect` 循环**：全部是**读**、无读写交错（无强制布局），
   且已包在 `requestAnimationFrame`(`:300`) 与 `spyRaf` 闸门里。真·强制布局的例子 `wordcloud-layout.ts:206` 注释已自证并改过。
5. **不要重做这些已到位项**：图集攒批 `api-media.ts:739-774`+`image-batch.ts:29`；滚动钉底/对账限频
   `chats-polling.ts:105-126,228-257`（修订闸门 + 2 s 对账限频）；sns 索引 2 s 闸门
   `sns-image.ts:340-346`（注释里有 61–69 ms 实测）；冷启动预热 `startup-prewarm.ts`；
   分片目录 `meta.ts:331`。它们"看起来慢"，但都已有实测读数与守卫。

## 5. 风险、边界与验不了的部分

- **未测真实规模**：本机真实分片数、每会话视频/语音条数、`getVideoInfo` 的回退触发率均**未取真实数据**
  （简报禁止读真实库内容）。T1 的 2.43 ms 是「24 分片最坏情况」；实际按 **≈0.10 ms/分片** 线性缩放，公式可直接代入。
- **T4 涉及对外契约增面**，不是纯内部重构，必须 Lead 拍板是否在「不改契约」范围内（新增 methods 是加法，风险可估但非零）。
- **T7 的收益完全未定量**，只有静态计数。若 Profiler 采样显示 commit 耗时占比 <3%，应整条放弃。
- **等价性验证的硬缺口**：视频链路**没有 spec**（`tests/` 里只有 `media-voice.spec.ts`），T1/T2 必须先补测试再改代码；
  这是本清单里唯一「必须先写测试」的一项。
- 本文所有倍率都来自合成数据同一运行内对照；跨运行只能比倍率并带噪声带（简报 §6），不要把绝对 ms 当跨机器结论。

## 6. 给实施阶段的建议顺序（收益/风险比）

1. **T1+T2（同一文件、同一个 spec 覆盖、风险低、收益 27×）** —— 唯一"高收益低风险"组合，优先。
2. **T6（搜索窗口，风险低）** 与 **T5（语音回退，有现成 spec）** —— 小改动、可独立验证。
3. **T3（图片索引，风险中）** —— 收益集中在首屏未命中；必须先补对拍断言再动。
4. **T4（批量接口）** —— 需 Lead 先确认契约口径；确认后再做，否则跳过（跳过也不阻塞 1–3）。
5. **T7（memo）** —— 先只做 Profiler 采样，**采样后再决定是否改代码**；不采样就不改。
6. **T8/T9** —— 随文件其它改动顺手做，不单独立项。**T10** 只作为复核规则使用。
