# 07 · 性能优化实施方案（Phase 2）

> 依据：`docs/perf/00-ALPHA-REFERENCE.md`、`01-PROJECT-MAP.md`、`02-BASELINE.md`、`03-RESOURCE-PIPELINE.md`、
> `04-MEMORY-AUDIT.md`、`05-CODE-SMELLS.md`、`06-VERIFY-PLAYBOOK.md`。
> 总原则：**业务行为、对外契约、用户可见逻辑不变**；先量后改；一主题一提交；每步可回滚。

## 0. 裁定与边界（Lead）

- 实施在独立 git worktree `D:\st-perf`，分支 `perf/resource-lifecycle-v1`（从 `70c3ca6` 拉出）。
  主工作区 `D:\super-time-wechat` 的 132 个在途改动**不碰**；回滚 = worktree 内 `git revert <sha>` 或整体丢弃分支。
- **不做**：`getVideoInfosBatch` / `getVoiceInfosBatch` 等新增 Remote 方法（调用方代理 T4 提议）——属对外契约增面，
  本轮排除；需要时单独立项。
- **不做**：图片解码/索引/词云搬 `worker_threads`（`kb/parse-pdf.ts:12-13` 真机记录 Electron 主进程 `new Worker` 抛错）；
  `article-cover.ts` trace 分支、`settings-state.tsx` 只读 gBCR、`api-clawbot`/`api-task-center` 套 `cachedFetch` 等假阳性项。
- **不动**：`image-cache.ts` 48MB 上限、`meta.ts` 家族限界、`wechat-host` 定向失效策略、导出流式/搜索 iterate 等历史已修形态。

## 1. 量化目标（可验证口径）

| # | 指标 | 现状（证据） | 目标 | 验证方式 |
|---|---|---|---|---|
| G1 | 后端三处"条数有界、字节无界"缓存的**理论上限** | 341MB（remote-image 300×8MB×1.33 + resultCache 300×512KB + 密钥流 64×1.5MB） | ≤112MB（32+64+16） | 新增单测直接断言上限；`docs/perf/04` §3 量级表复算 |
| G2 | 典型负载下上述三层常驻 | ≈59.2+36+96 = **191MB**（`04` §9 实测同形） | ≤112MB，且**不再有无限增长路径** | 同上（单测 + `measure:quick` 无退化） |
| G3 | 确定性无界小缓存 | `statsCache` 无 delete/clear/max；`failUntil` 永久驻留；`avatarAssets` 只增不删 | 全部加界（512/500/800） | 新增单测断言容量上限 |
| G4 | 视频消息后端解析 | 2.428ms/条 + 封面定位 0.57ms/条（`05` §2 实测） | ≤0.15ms/条（**≥20×**） | 新增参数化对拍 spec（表在第 k 分片）+ 同 run 计时断言 |
| G5 | 解码图缓存命中判定 | 0.165ms/图（14×existsSync，双槽 28 次） | ≤0.01ms/图（**≥15×**） | 目录索引 vs existsSync 对 3000 条全等 + 同 run 计时 |
| G6 | 搜索窗口定位 | 最坏 24 分片 × 0.029ms ≈ 0.7ms/次 | ≤0.05ms/次 | 新旧实现对拍 + 计时 |
| G7 | 安装包体积 | 4 张死资源 601.5KiB（`bg-stage-{0..3}.webp`，全仓 0 引用） | 删除，包体 −601.5KiB | `npm run pack` 产物对比 / `check:package-content` |
| G8 | 内存泄漏（确定性缺陷） | `kit-foldable.tsx:70` MQL 监听未摘除 | 卸载时摘除 | 单测断言 removeEventListener 被调用 |
| G9 | 回归 | — | `measure:quick` 18 项全绿且无 >5% 退化；相关 spec 全绿；typecheck 5 项绿 | `06-VERIFY-PLAYBOOK.md` 矩阵 |

> 说明：G1/G2 是**上界**而非实测常驻；G4–G6 的倍率来自 `05` 同 run 合成数据实测，真实规模按公式线性缩放，
> 报告里只报倍率与同 run 绝对 ms，不跨机器外推。

## 2. 工作包（按收益/风险排序，一包一提交）

### P0 · 后端缓存字节预算（内存，低风险）
| 文件 | 改动 | 上限 |
|---|---|---|
| `src/backend/wechat-data/src/query/remote-image.ts:100-119` | `memCache` 从"仅条数"改为"条数+总字符+单条"三维预算（LRU） | 300 条 / 32MB / 单条 2MB 不入 |
| `src/backend/wechat-data/src/query/remote-image.ts:87` | `failUntil` 加界（500）并顺手清过期 | 500 |
| `src/backend/wechat-host.js:76-78,136-147` | `resultCache` 增加总字符预算 | 300 条 / 单条 512KB / 总 64MB |
| `src/backend/wechat-data/src/query/sns-keystream.ts:139,183` | 淘汰从"超 64 条整表 clear"改为逐出最旧 + 字节预算 | 64 条 / 16MB / 单条 >4MB 不入 |
| `src/backend/wechat-data/src/query/messages.ts:576` | `statsCache` 用 `boundedSet` 加界 | 512 |
- 语义风险：仅影响**缓存命中率**，不改变任何返回值/错误/顺序。
- 验证：`remote-image.spec.ts`、`sns-keystream.spec.ts`、`result-cache.spec.ts` 全绿 + 新增预算单测。
- 回滚：单提交 revert。

### P1 · 客户端确定性泄漏与死资源（低风险）
| 文件 | 改动 |
|---|---|
| `src/client/.../ui/kit-foldable.tsx:70,96-100` | cleanup 里 `mq.removeEventListener('change', onMq)` |
| `src/client/.../panels/graph-canvas-support.ts:102` | `avatarAssets` 加 800 上限（LRU），账号切换可清 |
| `src/client/ui-app/public/onboarding/bg-stage-{0..3}.webp` | 删除（0 引用死资源，601.5KiB） |
- 验证：`kit-foldable` 相关 spec / `ui:longlist-e2e` 抽查；`npm run check:package-content`（若存在）+ 构建通过。
- 回滚：单提交 revert。

### P2 · 视频消息解析链路（速度，低风险但**先补测试**）
| 文件 | 改动 |
|---|---|
| `src/backend/wechat-data/src/query/media-video.ts:84-101` | 复用 `meta.ts:331 shardCatalogDirs` 定位单分片，不再逐分片开库；加 `(username,localId)` 小 LRU（挂 `bumpDataGeneration`） |
| `src/backend/wechat-data/src/query/media-video.ts:107-126` | `findVideoArtifacts` 一次 `readdirSync` 建 `Map<month, Set<basename>>` + 目录签名闸门（照抄 `sns-image.ts:340-346` 的 2s 闸门） |
| 新增 `tests/media-video.spec.ts` | 先写：表在第 k 分片参数化对拍、新增封面后可见、缓存随世代失效 |
- 语义风险：md5/封面/路径解析结果必须逐字节不变；失效口径必须随 `bumpDataGeneration`。
- 验证：新 spec + `media-voice.spec.ts`（同族）+ `measure:quick` 的 `MEASURE_MEDIA_RESOLVE` 无退化。
- 回滚：单提交 revert。

### P3 · 搜索窗口定位（速度，低风险）
`search-query.ts:62-84 loadMessageWindow` 用 `shardCatalogDirs.tables` 定位唯一分片；新旧对拍 spec。
- 验证：`search-*` spec 全绿 + 新对拍；回滚单提交。

### P4 · 解码图缓存目录索引（速度，中风险，最后做）
`media-image.ts:418-434` + `:549`：`decoded_images` 目录级索引 + 签名；**不得改变双槽位选择顺序**。
- 验证：`image-upgrade.spec.ts`、`media-image.spec.ts`、`image-path-batch.spec.ts`、`gateway-image-batch.spec.ts`
  全绿 + "索引 vs existsSync 对 3000 条全等"对拍断言。
- 若 P0–P3 已满足 G1–G8 且有回归风险，可延后到下一轮。

## 3. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| 缓存预算改小导致命中率下降 | 面板切换/滚动变慢 | 上限按实测典型值定（≥8× 典型批），`measure:quick` + e2e 滚动回归 |
| 索引缓存看不到新落盘文件 | 新视频/新图不显示 | 目录签名闸门（2s）+ 明确时序用例 |
| `bumpDataGeneration` 漏接 | 返回旧 md5/旧图 | 沿用 `meta.ts` 既有世代语义 + 定向失效用例 |
| 删除死资源误删 | 引导页背景 404 | 已全仓 grep 0 引用 + 构建/冒烟验证；单提交可回滚 |
| 实施与在途 WIP 冲突 | 合并困难 | 独立 worktree/分支；只改不与 WIP 重叠的文件；交付合并指引 |

## 4. 交付与合并

1. 每个工作包一个提交（中文 conventional commit，与仓库风格一致）。
2. 每包附「改动清单 + 命令输出 + 指标前后对比」写入 `docs/perf/08-IMPLEMENTATION-LOG.md`。
3. 全部完成后：`docs/perf/09-RESULT.md`（总账：G1–G9 达成情况、无法验证项、回滚命令）。
4. 合并：`git checkout <base> && git cherry-pick <sha...>`（或 PR）；**不自动合并**，由用户确认。
