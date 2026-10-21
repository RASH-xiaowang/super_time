# 08 · 实施记录（Phase 3）

> 实施分支：`perf/resource-lifecycle-v1`，隔离工作树 `D:\super-time-wechat\.worktrees\perf-v1`
> 基线提交：`70c3ca6`（= `release/v1.0.9` HEAD）。主工作区 132 个在途改动**全程未触碰**。
> 回滚：`git revert <sha>`（单包一提交，互不依赖）。

## 1. 提交清单

| # | sha | 主题 | 包 | 证据/验收 |
|---|---|---|---|---|
| 1 | `5586254` | perf(cache): 后端 4 处缓存补字节预算 + 2 处无界表加界 | A（内存） | 5 spec / 47 用例绿；`build:backend` 与源码一致；`tsc --noEmit` 0 错 |
| 2 | `4e702f2` | fix(perf): 摘掉折叠面板未释放的 MQL 监听 + 清 601.5KiB 死资源 + 远程图分块对齐后端 | B（泄漏/死资源） | 3 spec / 65 用例绿；client tsc 0 错；`build:ui` 成功 |
| 3 | `4d49359` | perf(ui): 首屏 CSS 去掉 83.5KB 无用 Bootstrap Utilities | E1（首屏） | 主 CSS 242KB/3163 条 → 165KB/1921 条，少 1270/多 0，**危险次序 0**；overview-layout 21/21 |
| 4 | `5978d87` | test(perf): 修正折叠面板监听用例的 React 18 act 用法 | B（补） | 该 spec 1/1 绿、client tsc 0 错 |
| 5 | `6786cf0` | fix(perf): 内存哨兵在生产只采一次 —— 把真实定时器接上 | C1（观测） | sentinel spec 9/9（含新增接线守卫） |
| 6 | `3e7b7b7` | perf(media): 图片批量链路复用 hint、fileOnly 零读字节、并发加界（30 张开库 33→3） | D（资源加载速度） | 6 spec / 36 用例绿；`build:backend` 一致；`tsc` 0 错；`measure:quick` 18 文件/21 用例 27.15s（基线 27.08s，无退化）；`npm run typecheck` 全绿 |

### A · 后端缓存字节预算（详细）
- 新增 `wechat-data/src/query/cache-budget.ts`：条数 + 总大小 + 单条大小三维上界，LRU 逐出（纯逻辑）。
- `remote-image.ts`：`memCache` → 300 条 / 32MiB / 单条 2MiB 不入；`failUntil` → 500 条且写前清过期。
- `sns-keystream.ts`：64 条 / 16MiB / 单条 4MiB；**删掉「超 64 条整表 clear」**（RSS 锯齿根因），改逐条逐出。
- `sns-image.ts`：朋友圈原图 dataURL 缓存 `md5UrlCache` → 300 条 / 32MiB / 单条 8MiB。
- `wechat-host.js`：`resultCache` 在 300 条 + 单条 512KiB 之上加**总字符 64MiB**；定向失效/LRU 语义不变。
- `messages.ts`：`statsCache` → `boundedSet(…, 512)`。
- 单元内实测（同 run）：远程图 40×1.5MiB 60→31.5MiB；密钥流 20×1.5MiB 30→15MiB；SNS 图 40×1.5MiB 60→31.5MiB；resultCache 129×512KiB 64.5→64MiB（`clearAll()` 后 chars=0）。

### B · 客户端泄漏/死资源/口径
- `kit-foldable.tsx`：cleanup 补 `mq.removeEventListener('change', onMq)`（此前 add=1/remove=0）。
- `graph-canvas-support.ts`：`avatarAssets` 改 800 条有界 LRU（此前只增不删，320 条 ≈5.2MB/账号）。
- 删除 `src/client/ui-app/public/onboarding/bg-stage-{0..3}.webp`（601.5KiB，全仓 0 引用；构建后 `ui-dist` 不再生成）。
- `api-media.ts`：`REMOTE_IMAGE_CHUNK` 40→20，与后端 `MAX_IMAGES_PER_CALL=20` 对齐（此前 >20 张时后半批被整批拒绝并重试）。

### E1 · 首屏 CSS
- 移除 `bootstrap-utilities.min.css`（全仓唯一使用处是 overview 的 `d-flex flex-column gap-2`）。
- 该处改为 `overview.module.css` 的局部类 `.cardStack`（数值与工具类逐字一致：flex / column / .5rem）。
- 栅格（`bootstrap-grid`）保留（`row/col-*` 仍在用），级联顺序说明同步更新。
- 用仓库自带 `scripts/css-bundle-diff.mjs --save/--check` 做穷尽式规则序列对比：**删掉的 1270 条全部是工具类规则，0 条新增、0 处危险次序变化**。

### C1 · 内存哨兵
- 基线实测 80s 运行只有 1 条 `[mem]`：`createMemSentinel` 缺省 `setIntervalFn` 是空函数（单测友好），而 `wechat-worker.js` 只传了 `log`。
- 修法：调用点传真实 `setInterval/clearInterval`；新增**接线守卫**（源码级截块断言两行都在）——单测里的假定时器只能证明逻辑，证明不了调用点。
- 意义：此后 `docs/perf/02-BASELINE.md` §9-2 那条「worker 内存时间序列测不到」才具备修复前提。

### D · 图片批量链路（资源加载速度，Codex 执行 / Lead 复核）
- **D1 hint 复用**：新增 `resolveImageResourceHintsBatch`（md5 + data_index，保留单张解析优先级），批量入口把 hint 透传给 `decodeImageDataUrlAsync`；`resolveImageMd5sBatch` 保留为兼容包装，预热路径不变。
- **D2 fileOnly 零读字节**：命中磁盘缓存时只 `access + stat`，返回 `format/file/thumb`，**不 readFile、不 base64**；`.dat` 解码可跳过 data URL（落盘失败仍按旧行为回退）。
- **D3 有界并发**：批量入口 200 张 `Promise.all` → `mapWithConcurrency(…, 8)`，按索引回填、结果顺序不变（选 8 是为限制大 base64 结果的峰值内存）。
- 守卫测试：`openCounter()` 对 `DatabaseSync.prototype.close` 计数并设上界；断言「批量段里不再出现逐张 `local_id = ?`」；fileOnly 断言 `fs/promises.readFile` 0 次；并发 spec 断言峰值 ≤8 且顺序保持。
- 实测（同 fixture 同 run）：30 张句柄开合 **33 → 3**；第二条对拍用例 **35 → 5**；fileOnly 预热后 `readFile` **0** 次。
- 未改任何 Remote 方法签名/返回字段/错误文案；双槽位（原图/缩略）选择顺序与原图升级语义保持。

## 2. 已评估但**本轮未做**（附理由，避免被误读成遗漏）

| 项 | 证据/收益 | 为什么不做 |
|---|---|---|
| 新增 `getVideoInfosBatch` / `getVoiceInfosBatch`（refactor T4、resource #11/#12） | 20 条视频/语音：20→1 RPC | **新增 Remote 方法属对外契约增面**，与「不改契约」冲突；需单独立项（`docs/API.md`/契约测试同步） |
| 热力图 `LazyMount`（resource #4） | Overview 首开不拉 441.6KB echarts | 热力卡在首屏可视区内，IntersectionObserver 会立即触发；占位文案可能造成「加载中」闪烁，且基线「落定」判据会把占位算作未落定 ⇒ 指标可能反向。需先真机截图/时序验证再定 |
| `decoded_images` + `voices` 磁盘预算/淘汰（resource #8） | 磁盘占用可预测 | 属**磁盘**治理，不改运行时内存/首屏；淘汰后需重新解码（13ms/语音、图片一次解码），需单独开关与回滚设计 |
| `queryStorageStats` 跨重启磁盘缓存 | 冷启动单次 2.25s（基线慢调用日志） | 已有签名缓存（`cachedBySigAsync`），冷算才是 2.25s；落盘缓存需处理签名口径（当前 sig 未含 contacts 库，见 `storage.ts:152-162` 注释与代码不一致）→ 先修口径再谈持久化 |
| data URL 图片全面迁 `wechat-media://`（baseline §11-5） | 渲染 WS 峰值 286MB | 面板图片是**已解码位图**占大头（CDP JS 堆仅 31MB，base64 字符串不是主因）；原型面广（moments/contacts/favorites/头像各自取数链），需先做 heap snapshot 归因 |
| `React.memo`（refactor T7） | 未定量 | 报告明确要求「先 Profiler 采样再决定」，本轮无采样 |
| 四份 avatarCache 合并（memory §5-8） | ≈5MB | 改动面 4 文件、收益小，排后 |
| `worker_threads` 搬解码/索引 | — | 项目已实测 Electron 主进程 `new Worker` 抛 `Cannot transfer object of unsupported type`（`kb/parse-pdf.ts:12-13`）；正解是既有 `yieldToLoop` |

## 3. 已知基线红（**不是本轮引入**）
- `npm run ui:smoke`：45/47，2 项失败（SessionAsk 空态文案、朋友圈面板 desc）。已在**纯净 HEAD `70c3ca6`** 的独立 worktree 复跑，同样 2 项失败 → 既有基线。
- qa 记录的 `test:affected` 15 个失败 spec / `ui:loading-e2e` 2/10 / `ui:nav-e2e` 5/28：来自主工作区在途脏树 + 并发探针，与本分支无关（本分支从干净 HEAD 拉出）。

## 4. 改动范围与风险
- 只改 11 个产品文件 + 6 个测试文件；未新增依赖、未改任何 Remote 方法签名/返回字段/错误文案。
- 风险最高的是 A 的缓存上限：只影响命中率，理论上可能让「长时间不看的图」重新读盘/解码一次；上限按实测典型批的 8 倍以上设定，且既有 spec 覆盖回归。
- 逐包回滚命令：`git revert 6786cf0 4d49359 4e702f2 5586254`（或按需单个）。
