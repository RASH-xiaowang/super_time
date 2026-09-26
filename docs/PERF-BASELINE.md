# Super Time 加载性能基线与优化方案

> 产出：2026-09-26。全部数字来自**本机真实解密库的实测**（脚本 `working/probe-perf*.ts`，可重跑），不是推算。
> 测量环境：Node 22.22.2 + 真实数据根（**290 个会话 / 247,925 条消息 / 14.75 GB 资源**），
> 直调 `query/**` 层函数（绕过 gateway 缓存），每个接口冷/热各跑一轮。
> 局限（如实标注）：① 未测 IPC 往返与渲染耗时（只测了后端取数）；② `getAnnualReport` /
> `getWordCloud` / 三个导出与备份类**未纳入**（单次过慢，会把整轮拖到十几分钟）；
> ③ 未在"多个重查询叠加"的真实排队场景下测量（那一项只有源码注释里的实测数字可用）。

---

## 一、一句话结论

**这个项目的加载瓶颈几乎全在后端同步 SQLite，而不是前端渲染。** 而且真正"每次都慢"的只有
**4 个接口**（隐私体检 1020ms、社交图谱 866ms、资金往来 125ms、存储分析 122ms）——
其余慢查询都已经被 30s 缓存兜住（热跑 **0ms**）。

同时实测**证伪**了两类常见优化方向（见第六节）：**前端并行化无效**、**OFFSET 深翻页不是瓶颈**。
这两条本来会是最容易"顺手做掉、看起来有产出"的工作。

---

## 二、实测数据（冷跑 = 用户第一次打开该面板）

| 模块 | 接口 | 冷跑 | 热跑（30s 内） | 有进程内缓存 |
|---|---|---|---|---|
| 隐私体检 | `queryPrivacyScan` | **1020ms** | **1020ms** | ❌ **无** |
| 社交图谱 | `queryGraph` | **866ms** | **795ms** | ❌ **无** |
| 概览 | `queryOverviewInsights` | 442ms | 0ms | ✅ 30s |
| 朋友圈洞察 | `queryMomentsInsights` | 206ms | 0ms | ✅ 30s |
| 年度报告 | `queryAnnual` | 170ms | 0ms | ✅ 30s |
| 收藏表情统计 | `queryAssetInsights` | 168ms | 0ms | ✅ 30s |
| 会话列表 | `querySessions(200)` | 140ms | 0ms | ✅ 30s |
| 概览 | `queryOverview` | 132ms | 0ms | ✅ 30s |
| 资金往来 | `queryLedger` | **125ms** | **120ms** | ❌ **无** |
| 存储分析 | `queryStorageStats` | **122ms** | **114ms** | ❌ **无** |
| 通话记录 | `queryCalls` | 98ms | 0ms | ✅ 30s |
| 公众号文章 | `queryOfficialAssets` | 42ms | 0ms | ✅ 30s |
| 搜索 | `searchUnified` | 38ms | 31ms | ❌ 无 |
| 群聊分析 | `queryGroupInsights` | 29ms | 27ms | ❌ 无 |
| 消息搜索 | `searchIndexMessages` | 28ms | 11ms | 负缓存 |
| 消息 | `queryMessages(首页 100)` | 23ms | 17ms | 部分 |
| 撤回消息 | `queryRevoked(50)` | 19ms | 15ms | ❌ 无 |
| 文件 | `queryFiles(100)` | 18ms | 3ms | ✅ 30s |
| 联系人 | `queryContact360` | 17ms | 16ms | ❌ 无 |
| 联系人 | `queryContacts(200)` | 15ms | 0ms | ✅ 30s |
| 地图 | `queryRegionMap` | 12ms | 9ms | ❌ 无 |
| 朋友圈 | `queryMoments(首页 100)` | 11ms | 9ms | ✅ 60s |
| 消息日历 | `getDailyCounts(月)` | 7ms | 7ms | ❌ 无 |
| 媒体资产 | `queryMediaAssets` | 5ms | 0ms | ✅ 30s |
| 收藏 | `queryFavorites(120)` | 4ms | 8ms | ✅ 60s |
| 搜索 | `searchWechatFts` | 4ms | 4ms | ❌ 无 |
| 表情包 | `queryEmoticons(200)` | 3ms | 0ms | ✅ 5s |
| 资金明细 | `queryRecords(50)` | 0ms | 0ms | ❌ 无 |

**读法**：`热跑 0ms` = 30 秒内再打开不用等；`冷跑` 才是用户第一次点开那一屏的等待。

---

## 三、逐个瓶颈定位

### 瓶颈 1 · 隐私体检（`queryPrivacyScan`）—— 1020ms，且**每次都要等**

- **现象**：冷热都是 1000ms 左右，**完全没有缓存**。
- **根因**：`query/privacy.ts:107` 设 `rowBudget = 600000`，逐分片游标扫**全部** `local_type=1` 的消息，
  对每一条跑 6 类正则（`:157` 的 SQL 只有 `WHERE typeCol=1`，**该列无索引**）。
  它在导出路径（`export-flows.ts:325`）也被复用，所以"导出 CSV"选到隐私类型时会再等一次。
- **为什么没缓存**：同目录的 `getOverview` 用了 `cachedBySig(...)`，隐私扫描**没有**照做。

### 瓶颈 2 · 社交图谱（`queryGraph`）—— 866ms，且**每次都要等**

- **现象**：冷 866ms / 热 795ms。第二次甚至比第一次慢（无缓存，且有 GC 波动）。
- **根因**：三件事叠在一起 ——
  ① `graph.ts:88` `loadMessageCounts()` 对**每个分片的每张 `Msg_*` 表**（本机 304 张）各跑一次
  `SELECT COUNT(*) FROM <table>`；
  ② `:109` / `:142` 把 `contact` + `chat_room` + `chatroom_member` **三张表全量 `.all()`** 进内存；
  ③ 再在 JS 里解析 `ext_buffer` 建图。
- **同一份数据在 `getOverview` 里也是全扫**，但那边有缓存，所以只有图谱这块每次都痛。

### 瓶颈 3 · 资金往来 / 存储分析（125ms / 122ms）—— 也是**无缓存**

- `queryLedger`：`general.db` 两张表全量 + 跨全部 304 张消息表按 `server_id` 反查
  （第一轮走整型覆盖索引，第二轮 `CAST(server_id AS TEXT)` **索引失效**），**无缓存**。
- `queryStorageStats`：`MessageResourceDetail` 全表 `GROUP BY type` + 两张 JOIN 排行 + 扫
  `msg/file/<月>/` 全树 `stat`（后者有 10s 局部缓存），**整体无缓存**。
- 单独看 120ms 不算灾难，但**它们会和别的重查询叠在同一队列里**（见瓶颈 5）。

### 瓶颈 4 · 首次打开的固定税（132–442ms）

`overviewInsights` 442ms、`momentsInsights` 206ms、`annual` 170ms、`assetInsights` 168ms 等
**都有 30s 缓存**，第二次打开是 0ms —— 但**第一次**仍要等。
根因统一：跨全部消息分片的 `GROUP BY` / 逐表 `.all()` 物化 + JS 聚合
（`overview-insights.ts:162-164` 的 `GROUP BY t,h,d` 无法走索引）。
这部分不是"缺陷"（缓存策略是对的），而是**可预热的成本**。

### 瓶颈 5 · 同步 SQLite 的排队效应（结构性，最贵）

- **现象**（源码注释里的实测）：导出期间一次 `getSessions` 往返要 **2573ms**，空闲时只要 **1ms**
  （`export-format.ts:55-68`）。搜索旧兜底扫描单次 **621ms–2.5s**（`search-query.ts:242-250`）。
  媒体取数在缓存未命中时会退化成对整个 `cache/<月>/Sns` 做全量读+解密+哈希，**单次 12–21 秒**
  （`backend-rpc.js:40-43`）。
- **根因**：`node:sqlite` 的 `DatabaseSync` 是**同步 API**，一次查询跑完前，worker 事件循环
  被独占 —— 后面所有请求（包括本该 1ms 的 `getSessions`）全部排队。
- **为什么最贵**：它把"单接口 120ms"放大成"用户感受到的 1–3 秒"，而且**只有长任务让出**
  （`yieldToLoop()` / `setImmediate`）才缓解，目前只有搜索索引、KB 向量、导出、全量解密、
  KB 队列这几条路径做了让出。

### 瓶颈 6 · 前端 `cachedFetch` **没有做到它注释里写的 SWR**

`cache.ts:162-189` 的注释写着「命中缓存时先返回缓存作早显，随后前台等待新鲜值并写回」，
但实现是：

```ts
if (hit !== null && !isEmptySnapshot(hit)) {
  const fresh = await timedFetch(key, fetcher)   // ← 仍然 await 完整请求
  cacheSet(key, fresh); return fresh             // ← 只有请求失败时才 return hit
}
```

也就是说**localStorage 缓存目前只起"失败兜底"的作用**，命中了照样要等。
真正做了早返回的是内存快照层的 `cachedGet`（`cache.ts:51-59`），而它只覆盖少数几个接口。

### 瓶颈 7 · `readRenderCache`（首屏渲染缓存）**无 TTL、无上限**

`cache.ts:100-118` 的 `wxdata-render-cache:` 读写没有过期与容量控制，只靠 `try/catch` 吞掉
配额错误。localStorage 上限约 5–10MB，长期使用后写入会**静默失败** —— 表现为"某些面板的
首屏加速突然没了"，且没有任何日志。

### 瓶颈 8 · 前端零散问题（按影响排序）

| 位置 | 问题 | 影响 |
|---|---|---|
| `DailySummary.tsx:124-131` | 两个接口**串行** `await`，都无缓存、无分页，每次挂载全量重取 | 每次进"总结"都要等两轮 |
| `usePagedList`（`hooks.tsx:404-406`） | 自动订阅 `dsh-wechat-data-updated` → 每次数据更新最多刷新 **16 页**请求 | 后台同步期间反复打请求 |
| 分页/虚拟化覆盖 | **只有 Chats 消息流**用了 `useVirtualizer`；朋友圈/文件/收藏/表情都是"渐进渲染"（`useProgressiveList` 首屏 25–200 条） | 长列表滚动时 DOM 增长 |
| 地图 GeoJSON | `world-map-data.ts` 每次会话首次进地图才拉 CDN，模块级 ref 缓存（跨会话有效） | 首次进地图有网络等待，且受 `blockMapTiles` 开关约束 |

---

## 四、优化方案（按维度）

### 4.1 缓存策略

| # | 方案 | 落点 | 预期效果 | 成本 | 优先级 |
|---|---|---|---|---|---|
| C1 | **给 `queryPrivacyScan` 加进程内缓存**，按 `dataGenerationSig()`（`meta.ts:366`）失效 | `query/privacy.ts` | 1020ms → **0ms**（数据未变时） | 低（照 `getOverview` 的 `cachedBySig` 抄） | **P0** |
| C2 | **给 `queryGraph` 加同款缓存** | `query/graph.ts` | 866ms → **0ms** | 低 | **P0** |
| C3 | **给 `queryLedger` / `queryStorageStats` 加缓存**（ledge 另可缓存 `general.db` 两表快照） | `query/ledger.ts` `storage.ts` | 125/122ms → **0ms** | 低-中 | **P1** |
| C4 | **把 `cachedFetch` 改成真 SWR**：命中即返回 hit，后台刷新并通过订阅触发重渲染（订阅机制可复用 `cache.ts#subscribeSnapshot` 的设计） | `cache.ts` | 有缓存的 9 个接口**二次打开 0 等待**（现在是等完整请求） | 中（要加订阅 + 通知） | **P0** |
| C5 | **给 `readRenderCache` 加 TTL（建议 24h）+ 容量上限**（超过就淘汰最旧），并在写入失败时 `console.info` 一次（现在是静默） | `cache.ts` | 消除"首屏加速莫名消失"；避免配额被撑爆 | 低 | **P1** |
| C6 | **后端加统一的耗时观测**：`operation_log` 表加 `duration_ms` 列，`op()` 记录耗时 | `query/operation-log.ts` + `gateway-core.ts` | 从此可统计"哪个接口最慢"的真实分布，不用每次写探针 | 低 | **P1** |

### 4.2 资源加载 / 预加载

| # | 方案 | 落点 | 预期效果 | 成本 | 优先级 |
|---|---|---|---|---|---|
| R1 | **空闲预取"首页级"重数据**：首屏渲染完、`requestIdleCallback` 里预热 `getOverview` + `getOverviewInsights`（这两份数据总览和资金往来都要用，仓库已有 `readOverviewLedger` 这种复用先例） | `Overview.tsx` / `overview-panel.tsx` | 切到总览时 442ms → **0ms** | 低（已有 `use-image-preload` 的 idle 范式可抄） | **P1** |
| R2 | **面板打开前预取**：侧栏 hover / `mousedown` 时预取该面板的主接口（比 `click` 早 100–200ms） | `WechatDataPanel.tsx` 的 `renderTab` | 观感延迟 −100~200ms | 中 | P2 |
| R3 | **补齐首屏渲染缓存**：给 `DailySummary`（任务/记录两份）、`Revoked`、`PeriodSummary` 加 `readRenderCache` | 对应面板 | 二次进面板首屏**瞬时出内容** | 低 | **P1** |
| R4 | **地图 GeoJSON 预取**：进「朋友圈洞察」时就预取世界/中国 GeoJSON（而不是等切到地图视图） | `MomentsInsights.tsx` | 首次看地图省一次网络往返 | 低 | P2 |

### 4.3 网络 / 请求（这里要特别小心：见第六节）

| # | 方案 | 落点 | 预期效果 | 成本 | 优先级 |
|---|---|---|---|---|---|
| N1 | **合并请求而不是并行化**：`DailySummary` 的两个接口、`DailySummary`+`listSummaryRecords`、总览的多个统计——后端加一个组合接口（一次 IPC 返回多份快照）。**理由：并行实测无收益（40ms vs 39ms），但请求数减少是实打实省 IPC 往返** | `gateway-*.ts` + `api-*.ts` | 每个面板省 1–2 次 IPC 往返 | 中（要新增 Remote，走 5 步同步） | **P1** |
| N2 | **`usePagedList` 的自动刷新加节流 + 页数上限调低**（现在最多 16 页/次） | `hooks.tsx:352-406` | 后台同步期间请求量下降 | 低 | P1 |
| N3 | **`getMessages` 的 `messageStats()` 全表 COUNT 独立成单独接口**，别挂在首页取数上 | `query/messages.ts:567-596` | 消息首页少一次全表扫 | 中 | P2 |
| N4 | 出网类（地图 CDN / 语音模型下载）保持现有开关语义，**不新增预取**（隐私承诺优先） | — | — | — | 维持 |

### 4.4 渲染流程

| # | 方案 | 落点 | 预期效果 | 成本 | 优先级 |
|---|---|---|---|---|---|
| V1 | **把 `useVirtualizer` 推广到朋友圈 / 文件 / 收藏**（这三处是长列表且只做了渐进渲染） | 对应面板 | 长列表滚动帧率稳定、DOM 节点数封顶 | 中 | P2 |
| V2 | **骨架与真实布局同形**（本轮 B1 已给 Files/Contacts 做过，可按同一范式补齐其余面板） | 各面板 | 减少"数据到了跳一下" | 低 | P2 |
| V3 | **面板级三态统一**（本轮 U14 已把空态统一到 `EmptyState`）——把加载态也统一到「走秒 + 骨架 + 为什么慢」 | 各面板 | 感知等待变短（`useElapsedSeconds` 已就位） | 低 | P2 |
| V4 | **重计算下沉**：`Overview` / `Annual` 里的排序聚合加 `useMemo`，并考虑搬进 Worker（仓库已有 graph 布局 Worker 的先例） | `overview-panel.tsx` 等 | 减少主线程卡顿 | 中 | P2 |

---

## 五、推荐处理顺序

按**「收益 ÷ 成本」**排序，四批：

### 第 1 批（立刻做，收益最大、成本最低）
1. **C1 + C2**：给 `privacy` 与 `graph` 加缓存 —— **消灭两个"每次都要等 1 秒"的接口**
2. **C4**：把 `cachedFetch` 改成真 SWR —— 一处改动让 9 个接口的**二次打开变 0 等待**

> 这一批做完，用户感知最明显的两类卡顿（"隐私体检/图谱每次都要等"、"切回来还是要等"）就没了。
> 预计改动集中在 3 个文件，且都有现成范式可抄。

### 第 2 批（紧接着，堵住静默降级）
3. **C5**：`readRenderCache` 加 TTL + 上限 + 写入失败日志
4. **C6**：后端 `operation_log` 加 `duration_ms` —— **先有观测，再谈后续优化**
5. **C3**：`ledger` / `storage` 加缓存

### 第 3 批（结构性改善）
6. **N1**：合并请求（减少 IPC 往返），从 `DailySummary` 开始
7. **R1 + R3**：空闲预取总览数据 + 补齐 3 个面板的首屏渲染缓存
8. **N2**：`usePagedList` 自动刷新节流

### 第 4 批（打磨）
9. **V1** 虚拟化推广 10. **V3** 加载态统一 11. **R2/R4** 悬停预取与地图预取 12. **N3/V4** 剩余两项

---

## 六、明确**不要做**的两类（本轮实测证伪）

这两条本来最像"该做的优化"，实测却证明**没有收益**，写在这里免得下一轮又去做：

### ✖ 前端并行化 / 加 worker 池

**实测**：用同一接口的两个不同参数（避开缓存干扰）各测一次 ——
**顺序 39ms，`Promise.all` 40ms**，完全没有加速。

**根因**：`node:sqlite` 的 `DatabaseSync` 是**同步 API**，`Promise.all` 里的调用会在微任务
队列里依次跑完，只省了"结果收集"的等待，没省查询本身。换成 worker 池也只是把排队挪个位置
（同一份 SQLite 文件还有写锁竞争）。

**正确方向**：**减少请求数**（合并 RPC，见 N1），或**把后端换成异步驱动**
（那是量级更大的改造，不在本轮建议内）。

### ✖ OFFSET 深翻页改造（keyset 分页）

**实测**：`offset=5000` 相对首页 —— 朋友圈 `0.2×`、文件 `0.2×`、收藏 `1.7×`。
深页**并不慢**，因为这几张表在本机只有几千行（`SnsTimeLine`、`fav_db_item`、资源表），
OFFSET 的代价远小于一次 IPC。

**结论**：改 keyset 是**纯成本、零收益**。真正需要 keyset 的只有消息流，而它**已经**是
keyset（`messages.ts:374-385` 的 `WHERE sort_seq < ? OR (sort_seq = ? AND local_id < ?)`）。

---

## 七、观测建议（让下次不用再写探针）

1. **后端**：`operation_log` 加 `duration_ms`（C6），并把 `op()` 的调用点补全到所有 Remote 入口。
2. **前端**：把 `timedFetch` 从"只在 `cachedFetch` 里"推广到**每个 api 包装函数**
   （现在覆盖 9/193 个），阈值从 250ms 降到 100ms，并把结果攒进一个内存环形缓冲，
   在「操作日志」或「数据库健康」页暴露一个"最近慢调用 Top 20"。
3. **回归**：把 `working/probe-perf.ts` 收进 `scripts/`，作为 `npm run perf:baseline`，
   在每次 UI 大改后排一次（它只读，跑一轮约 30 秒）。

---

## 附：可复现的测量命令

```sh
python working/run-probe.py probe-perf.ts    # 各模块冷/热耗时（29 个接口）
python working/run-probe.py probe-perf2.ts   # 并行有效性 + OFFSET 深翻页 + 缓存收益
python working/run-probe.py probe-perf3.ts   # 并行 vs 顺序的公平对比
python working/run-probe.py probe-wc.ts      # 词云 / 世界板块耗时 + 规模归因
python working/run-probe.py probe-queue.ts   # 同步 RPC 的排队效应（15 秒请求拖累同屏）
python working/run-probe.py probe-bench.ts   # countText 逐阶段分解
python working/run-probe.py probe-bench2.ts  # Aho-Corasick 原型 + 词表逐项对拍
```

输出落在 `working/probe-*.txt`。

---

## 八、已修复 · 「世界板块 + 全部热词」加载慢（2026-09-26）

> 用户报「世界板块，全部热词加载很慢」。实测后发现**这两者是同一个根因**。
> 而这一项恰好是第二节当初**明确跳过没测**的（`getWordCloud` 单次太慢，怕把整轮拖到十几分钟）——
> 所以这份补测也顺便证明了「跳过的代价是会漏掉最慢的那一个」。

### 8.1 实测（`working/probe-wc-out.txt` / `probe-queue-out.txt`）

| 接口 | 修复前 | 修复后 |
|---|---|---|
| `getWordCloud(scope='global')` 冷跑 | **15,312ms** | **3,013ms** |
| 同上，第二次（进程内缓存） | 15,876ms | **0ms** |
| `getWordCloud(scope='moments')` | 1,023ms | **183ms** |
| `getRegionMap`（世界板块自己） | 12ms | 12ms |

**「世界板块慢」的真身是排队，不是它自己慢**：它自身只要 13ms，但后端是同步 RPC，
排在热词后面时实测被推迟到 **17,008ms** 才拿到数据：

```
A. 热词在前  热词 开始 @0ms     → 完成 @16974ms
             世界板块 开始 @16974ms → 完成 @17008ms
B. 顺序反转  世界板块 完成 @13ms  ；热词 完成 @18018ms
```

### 8.2 瓶颈分解（`probe-bench.ts`）

15 秒里 **91%** 花在「每条正文 × 全部实体名做 `includes`」：

| 阶段 | 4000 条样本 | 外推全量 163,650 条 |
|---|---|---|
| 实体遮罩（旧） | 417ms | **~11.9s** |
| bigram 循环 | 42ms | ~1.7s |
| 合计 | 460ms | **~18.8s** |

量级：**163,650 条正文 × 1,979 个实体名 ≈ 3.2 亿次子串匹配**，
而且每次命中还带一次 `rest.split(e).join(' ')`（重建整个字符串）。

### 8.3 修法

| # | 修法 | 效果 |
|---|---|---|
| 1 | 实体遮罩改 **Aho-Corasick**（新模块 `query/word-match.ts`）：一遍 O(n) 扫描取代逐名 `includes` | 15.3s → **3.0s** |
| 2 | `queryWordCloud` 加 **`cachedBySig` 缓存**（签名 = 消息分片 mtime+size；朋友圈 = `sns.db`） | 二次 **0ms** |
| 3 | 前端 `WordCloudCard` 加**首屏渲染缓存**（`readRenderCache` / `writeRenderCache`） | 切回总览**立刻有词表** |
| 4 | 前端请求**延后一拍入队**（`setTimeout(…, 0)`） | 不再把同屏其它块堵在身后 |

**为什么第 4 条是必需的**：后端同步 ⇒ 谁先入队谁先跑。热词若与同屏其它块同时发起，
它就跑在别人前面。延后一拍让它**最后入队** —— 按上面 B 场景的实测，小块 13ms 就能出。

### 8.4 等价性（换了算法最该问的问题）

把**旧实现原样复刻成 oracle**，在同一样本上逐词对拍
（常驻用例 `tests/word-match.spec.ts` + 真实全量 `working/probe-bench2.ts`）：

- 真实全量：2,891 个词 **逐项完全一致** ✅
- 单元对拍：13 组边界形态（重叠、前缀关系、相邻人名、句首句尾、空文本、随机语料）全部一致

**唯一已知差异**（刻意，且已被 spec 钉死）：旧实现用 `split(e).join(' ')`，
而 `split` 是**不重叠**匹配、且把命中压成**一个空格** —— 于是同一名字重叠出现时
（如 `王五王五王五`）**残余的 `王五` 会漏进 bigram**。新实现按匹配区间整段遮罩，
残余不再上榜。名字的任何部分都不该作为独立词条，这才是实体保护的本意；
真实数据里该形态极罕见（全量对拍零差异）。

### 8.5 还没做的（如实登记）

- 剩下 3 秒里约 **1.4s** 是 SQL 读 + zstd 解压 + 剥 XML，约 **1.6s** 是 AC 扫描 + bigram。
  再往下要动的是「把词频落库做增量」，但那会改口径（"全部"要不要含历史新增）并要做失效管理，本轮未做。
- 缓存是**进程内**的：**重启应用后第一次仍是 3 秒**（要跨重启就得落盘缓存）。
- `queryRegionMap` 只有 12ms，**故意没加缓存** —— 加缓存会引入「数据不刷新」的风险，收益不成比例。

### 8.7 追加 · 世界板块先出底图（2026-09-26 用户要求）

即便队列不再堵，世界板块仍会「先空白一段」：`WorldMap.tsx` 的**每一个**地图分支都以
`map &&` 为前置（`map` = `apiGetRegionMap()` 的结果），而世界层的底图 —— 经纬网格
`graticule` + 大陆轮廓 `backdropPaths` —— 是**静态常量、不依赖任何数据**。
明明能立刻画出来的东西在等数据。

改法 3 处（`WorldMap.tsx`）：

| # | 改动 | 为什么 |
|---|---|---|
| 1 | 世界层 SVG 分支去掉 `map &&` | 底图静态，先画；`located` 为空时自然只有底图 |
| 2 | `showWorldEcharts` 连带要求 `map !== null` | 否则 GeoJSON 比数据先到 → 切 ECharts，而那支又被 `map &&` 挡住 ⇒ **两边都不画，比改前更空** |
| 3 | `located.length === 0` 的提示加 `map !== null` | 否则「还在加载」被说成「没有可定位的地区数据」 |

**刻意保留**：下钻层级（ECharts 世界 / 中国 / 省 / 市）仍要求 `map` —— 那些视图渲染的就是数据本身。

守卫 `panels/world-map-first-paint.wiring.spec.ts`（7 例）+ 变异 M38–M40（退回等数据 /
ECharts 不等数据 / 加载中说成没有）全咬红。真机审计复核：全站**裁切 0**，数据总览
最大空白 62px（阈值 150px）。

### 8.6 守卫与反证

- `panels/wordcloud-perf.wiring.spec.ts`（16 例）：AC 三件套、禁用逐名 `includes`、
  out 必须继承 fail 链、命中按长度降序、按正文计数而非出现次数、bigram 热循环不许 `slice`+正则、
  后端必须走 `cachedBySig`、前端首屏缓存 + 延后一拍 + 加载态不许盖住缓存。
- `tests/word-match.spec.ts`（21 例）：13 组等价性对拍 + 8 条结构契约（纯函数、不就地改入参、
  空名单降级、跨条复用不串味）。
- 变异 **M30–M36** 共 7 条全部咬红、逐字节还原：退回逐名全遍历 / 去掉缓存 / out 不继承 fail 链 /
  不排序 / 按出现次数累加 / 不延后请求 / 加载态盖住缓存。
