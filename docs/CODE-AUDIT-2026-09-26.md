# Super Time 深度代码审查报告

- 日期：2026-09-26
- 版本基线：`package.json` version 1.0.7
- 方法：5 路并行只读审查（架构耦合 / 代码质量 / 安全隐私 / 性能资源 / 错误处理+依赖+可测试性）→ 对每条高危结论**回读真实代码交叉验证**（本报告所有 ✅ 标记项均已亲眼复核）
- 口径：统计一律为实测（Grep / Glob / 逐文件读取），未估算；`src/backend/deps/**` 为 vendored 上游代码，单列不计入自有代码统计

---

## 先读这里：本轮整改状态（2026-09-26 同日，逐条对到 §七）

口径：**每条都是「修复 + 行为守卫 + 棘轮/接线守卫 + 变异自证」四件套齐全才记完成**；
`check:mutation` 与全量 `vitest` 当场跑过（终态：**313 文件 / 3200 用例**全绿（其中 9 文件/14 用例按环境跳过），
5 套 typecheck 全绿，变异 155 条全咬红、逐字节还原，登记到 M158）。

| 清单项 | 状态 | 落点（提交） | 备注 |
|---|---|---|---|
| 第一批 #1 P0-1 DB 句柄泄漏 | ✅ 完成（超出清单） | `75f5057` | 报告列 9 处，AST 复查后同一批文件实为 16 处；新增 `query/db-open.ts#withDb` + `query-db-lifetime.spec.ts`（用「跑完之后库文件可删」量泄漏，含故意不 close 的反例哨兵）+ 变异 M56。**报告未列出的同类站点**：AST 全仓扫出 69 处候选 → 逐条回读后 **35 处**是真漏（分布在 22 个文件），已建成**只能变小的棘轮清单**（`KNOWN_UNFIXED`），后续每修一处必须删条目 |
| 第一批 #2 P0-2 三处出网漏闸 | ✅ 完成 | `dd837d3` | 三个点各补 `privacyBlocked`/`blockOutbound`；**判据已按第 3 条换掉**：新增 `outbound-site-coverage.spec.ts` 枚举全仓 15 个 `fetch`/`fetchWithRetry` 调用点成台账（新出网点不登记就红）；行为验收 `outbound-gates.spec.ts`（开关打开 ⇒ 一次请求都不发 + 反例）+ `ipc-wechat.spec.ts`（`wechat:llm-models` 被拦时不漏 Key、拿不到开关时 fail-closed）；变异 M26（既有，复跑仍咬）/M57/M58/M59 |
| 第一批 #3 P0-3 cachedFetch 真 SWR | ✅ 完成 | `8638199` | 命中即回 + 后台刷新；**两个收敛条件**（同键并发只发一次、值没变不写不广播，否则订阅者自转成环）；判据取「永不 resolve 的 fetcher」不量时间；`chats-thread` 订阅 `:messages` 族事件把「通知」补齐成闭环；变异 M60 |
| 第一批 #4 P2-4 ledger 缓存 + 收窄失效 | ✅ 完成（**打法与报告不同**） | `9ca21b2` | ① `apiGetLedger` 加 `cachedGet`（按月分键）＝报告原方案；② **没有**把 `invalidateSnapshotCache()` 改成按前缀收窄 —— 数据事件的语义就是「全部快照都旧了」，收窄会漏刷该刷的键，真正的代价在「清表 ⇒ 下次全部回源」，所以改成**标记陈旧**（旧值立刻可画、复验进后台、成功才写回并通知、超 5 分钟的旧值丢弃）；判据 `cache-invalidate-stale.spec.ts` 8 条 + 接线两条，变异 M69/M70。**如实标注**：报告要求的「先真机打点」没做，每 10 秒重算这条账是读代码得出的因果链，不是实测数 —— 若日后打点发现账本重算不在这 10 秒里，这条要回头改 |
| 第一批 #5 P1-3 queryGraph | ✅ 完成 | `1b49ad4` | 分片只开一次库 + `cachedBySig`；验收是**开合数**（`[算料]` 3 会话 11 次 = 9 会话 11 次；旧形状是 6 vs 18 的形态）+「第二次一次库都不开」+ 反向「数据变了签名必须变」；变异 M63/M64 |
| 第一批 #6 P1-4 privacy 正则 + 缓存 | ✅ 完成 | `1b49ad4` | `SCAN_RES` 外提 + `cachedBySig`（`rowBudget` 进键）；验收是「扫描期间 `RegExp` 构造次数 == 0」；变异 M62 |
| 第一批 #7 P0-4 main.js 1000 行 | ✅ 完成 | `2c1c258` | 999 → **821 行**（余量 179）。窗口本体与守卫外提成 `src/backend/main-window.js`；**真机验收**：`ui-e2e-smoke` 改前改后都全绿、`security-guard:smoke` 10 项全绿（含 `did-create-window` 计数恒 0）；顺手补了 §五 那道空档——安全基线此前**只被人眼看过一次**，新增 `electron-security-baseline.spec.ts` + 变异 M61 |
| 第一批 #8 P3-1/P3-2 fmtTime/fmtBytes | ✅ 完成 | `275dbd4` | 4 份 `fmtTime` **全部删除**（单位写进名字：`fmtLocaleSec` / `fmtLocaleMs` / `fmtTodayOrLocaleMs`），5 份字节格式化收敛到两份唯一出处（渲染层 `utils/format.ts`、后端 `src/format.ts`，口径逐字一致）。守卫 `format-single-source.spec.ts` 按 AST 判「函数体里有没有单位换算本身」⇒ 薄适配器不误报；`NEVER_TWICE` 是零容忍档，`KNOWN_SECOND_TIME` 是**只能变小**的棘轮（还剩 7 份形状各异的日期函数）；判据本身有自证用例。行为守卫两份（`utils/format.spec.ts` 钉「单位喂错**必须**渲染成别的东西」——这是命名唯一的防线；`wechat-data/tests/format.spec.ts` 钉同一张字节表）；变异 M75/M76/M77 |
| 第二批 #13 之外的安全项 P2-6 路径限根 | ✅ 完成 | `348a70a` | `query/path-policy.ts`：`openPath` 只放行数据根之内或**应用自己写过产出的目录** + 可执行扩展名一律拒；导出两处落盘前过 `writeDenialReason`。被拒回理由（`error?` 新字段，`docs/API.md` 已重生成）。判据含「`openNativePath` 探针一次都没被调用」；变异 M65/M66 |
| 第二批（清单未列，同批做掉）P1-1 读失败契约 | ✅ 完成 | `e6f4b76` | 后端把「库打不开/读失败」与「确实没有条目」分成两件事（`DirListing.error` / 全域搜索的 `readError`），面板必须区分显示；守卫 `read-error-visibility.spec.ts` 从**类型**推「哪些快照带 `readError` ⇒ api 层哪些包装 ⇒ 调用它们的面板必须自己提到 `readError`」，新接口忘读就红；变异 M67/M68 |
| 第二批 #16 P2-5 readRenderCache | ✅ 完成 | `285c9ac` | 24 小时保质期 + 单条 1.5 MB 上限 + 写失败从静默变成「说一次并丢干净」（超大与配额两种原因分开记账，不互相静音）；判据 `render-cache-ttl.spec.ts`，变异 M73/M74 |
| 第二批 #17 P2-8 usePagedList 自动刷新 | ✅ 完成 | `aee1e6f` | 节流（30 秒内不重复起）+ 同键合并 + 页面不可见不发 + 上界装不下就**整轮跳过**（不再静默截断成前 8 页，那会把「已刷新」画成假话）；判据 `paged-list-refresh-gate.spec.ts`，变异 M71/M72 |
| 第二批 #13 P2-7 `wechat:call` 入参校验 | 🟡 ① 档硬拒已上线，② 档是**有证据要求的影子** | `92d37ca` | 新增宿主层 `wechat-args-guard.js`（+ `.d.ts`，按 H11 口径不给 `any`）：① **结构与体积**总是拒（参数个数/嵌套深度/数组项数/单串与累计体积/环/function/symbol/bigint/NaN/非纯对象），二进制按 `byteLength` 记账**不逐元素遍历**；接线在 `wechat-host.js` 的 `call()` 里、排在 `fn.apply` 之前，且归一化后的 `callArgs` 才是缓存键用的那份。② **形状**（生成的 114 份 zod schema）默认只记账，进了 `ENFORCED_SCHEMA_METHODS` 才拒 —— 因为这份生成物**从未被执行过**，没有证据就硬拒的结果是某个面板当场坏掉；`unrecognized_keys`（面板多发一个后端还不认的键）永远不算失败，保住向前兼容。**判据**：`wechat-args-guard.spec.ts` 12 条，含「被拒的调用一次都不许碰到 gateway」（把实现换成计数器来量，不靠读日志）、边界成对（防上界被悄悄调成无限）、8MB buffer 遍历耗时 <100ms、接线级判据、以及**覆盖账本 `[算料]`**：172 个 `@Remote` 里 schema 只覆盖 114，未覆盖 **58** 已钉成只能变小的棘轮（新加方法不生成 schema 就红）。变异 M82–M85 |
| 第二批 #14 P1-7 六个零 spec 模块 | ✅ 完成（并当场揪出 6 个真缺陷） | `fdd1f36` | 补 6 份 spec：`decrypt-all-tree`(13) / `payments-status`(8) / `drafts-clear`(8) / `calendar-daily-counts`(7) / `media-file-resolve`(9) / `gateway-read-shell`(26，覆盖 53 个 `@Remote` 壳的接线面)。**补测不是走形式**，撞出来的 6 条（详见「本轮新发现」⑨–⑫）：① `looksDecrypted` 那道解密有效性闸门**恒真**（10 处）⇒ 错密钥把乱码发布成快照；② drafts 早退分支双重 `close` ⇒ 人话错误被 `ERR_INVALID_STATE` 顶替；③ calendar 的存在性检查写在 try 之外 ⇒ 一个半写分片毁掉整个月 + 漏一条句柄（**P0-1 的 AST 判据抓不到这种形状**，因为 finally 里确实有一次 close）；④ media-file 负缓存**永久** ⇒ 「先点开、后下载」的文件不重启就永远打不开；⑤ media-file 缓存键不含数据根 ⇒ 换账号后同名同体积的文件读回**上一个账号**的字节；⑥ records 的 `combineWhere` 把 ` WHERE ` 的前导空格 trim 掉 ⇒ 拼成 `tableWHERE`，query 侧 catch 咽掉语法错误，用户侧表现是「记录页一搜就空」。变异 M86–M94 |
| 第二批 #14 顺带新增的全仓守卫 | ✅ 完成 | `fdd1f36` | `source-text-integrity.spec.ts`：源码里有字面 NUL/退格/ESC 就让 `grep` 把整个文件当二进制跳过 ⇒ **所有文本/AST 类判据对那个文件静默失效**（只让守卫变绿，不会变红）。扫 849 个文件，判据自带反例自证；变异 M89 |
| 第四批（部分）P3-3 / P3-4 两个「字面量散在多处」 | ✅ 完成 | `8a83972` | MD5 的 10 处 `[0-9a-f]{32}` 收进 `src/md5.ts`（`isMd5` 严格小写 / `isMd5Loose` 大小写都认 / `MD5_SEGMENT` 供拼进更大的模式 —— **两种口径刻意都留着**，差别写在名字里而不是散在十个字面量里）；AES 密钥字节化的 6 处收进 `keys/image-key.ts#normalizeAesKey`（4 处带 `length>0`、2 处不带的分歧并成一条：空串/全空白/空字节一律 `null` = 「没有密钥」，交给各调用方原本的退化分支）。守卫 `md5-image-key.spec.ts` 11 条：行为逐值钉 + **零容忍扫描**（全仓不许再出现这两个字面量的第三种写法）+ 反例自证 + 「共享正则实例不许带 `g` 标」这一条（十几个站点共用一个实例之后，`g` 会让 `lastIndex` 跨调用漂）。变异 M95/M96 |
| 工具修复：`check:mutation` 自己改坏了注入内容 | ✅ 完成 | `8a83972` | `String.replace(from, m.to)` 里替换串的 `$&` / `$'` / `` $` `` **是特殊序列** —— 一条 `to` 写成 `new RegExp('^' + X + '$', 'i')` 时，`$'` 被展开成「匹配之后的全部文本」，文件被写成垃圾后报「语法假咬」，看着像这条变异没意义，其实是工具自己变了形（M95 第一次就是这么红的）。改成**函数替换** + 让注入文本跟着锚点走行尾（CRLF 文件里不再塞进裸 LF）。自检 `--self-test` 三条判定路径仍成立，全表 93 条重跑全咬红、逐字节还原 |
| 第四批（部分）P3-7 / P3-12 / P3-13 / P3-19 | ✅ 完成 | `2570230` | 三处孤立 JSDoc 归位/删除；`getImageDataUrlsBatch` 进 `LONG_CALL_METHODS`（此前批量取图被 60s 误杀成整批失败）；`disposeLayoutWorker` 挂到图谱页签卸载；README 视图数 40 → 实测 90 |
| 第二批 #10 P1-6 xlsx | 🟡 改判据不动依赖 | `2570230` | 换 SheetJS CDN 源是**依赖面变更**（要联网重装 + 重验知识库链），本轮不擅自做；先把「这个项目会不会被那条路径打到」变成可执行判据：`xlsx-parse-hardening.spec.ts` 钉住每处 `sheet_to_json` 都是 `header: 1`（用户单元格永远当值不当键 ⇒ CVE-2023-30533 的键名入口是关着的）+ 真解析两份夹具前后对比 `Object.prototype` |
| 第二批 #15 P1-5 `file:` 依赖溯源 | ✅ 完成（**打法与报告不同**） | `382d66a` | 新增 `scripts/deps-provenance.mjs`（+ `.d.mts`，按 H11 口径不给 `any`；**`.mjs` 的宿主脚本必须配 `.d.mts`**，配 `.d.ts` 时 TS 根本不认，报的还是 TS7016）：`--write` 生成 `src/backend/deps/PROVENANCE.json`（19 行：`kind`/`path`/`declared`/`version`/`repository` + **整棵目录的内容 sha256** + 文件数 + 字节数），`--check` 复算比对并**以退出码 1 报出**，`--import <包名> <上游目录>` 拷入上游一份并顺手记下那一刻的 commit sha 与日期。报告点名的 `sync-deps.mjs` **没有单独成文件**：「同步」里能自动的只有拷贝，而「该不该拷」必须是人的判断，拆成两个脚本只会得到一个假装自动的拷贝器。人手维护的 `upstream`/`upstreamCommit`/`importedAt`/`upstreamWorkspace`/`note` 在 `--write` 时原样带过（现存 16 条 note、13 条来源工作区标记）；in-repo 的两个包**只登记不指纹** —— 它们本仓演进、`lib/` 每次构建重生成并由 CI 逐字节比对，再叠一层内容指纹是噪声不是溯源。**判据** `deps-provenance.spec.ts` 13 条：package.json ↔ 表**双向**对齐（漏一行、留一行已删的依赖都是问题）、四类漂移分开报（version / repository / 内容指纹 / 文件数 / kind）、**指纹口径与 mtime 和文件顺序无关**（否则换台机器就假红）、`node_modules`/`.git`/`*.tsbuildinfo` 不进指纹也不进拷贝清单、以及**起子进程**测 CLI 退出码（现状=0、漂移=1、表整个缺失=1、坏表拒绝覆盖=1）—— 纯函数全绿而门禁退 0 是两种不同的坏法，所以两头都要量。`npm run check:deps-provenance` 已进 package.json（现状复算 82ms，成本可以忽略）。变异 M97/M98/M99；另有一条 M97b **注定存活并已删除**，见 ⑬ |

| 第二批 #9 P1-1 后端读失败契约 | ✅ 完成（**打法与报告不同**） | `c07a13a` | 报告写的形状是「下沉成 `{ ok:false, error }`」，但本项目**已经有**一条同语义的契约：`readError`（`DirListing`、kb 那一族快照，加上从类型推判据的 `read-error-visibility.spec.ts`）——再造一个 `ok:boolean` 信封等于同一件事有两种形状。所以沿既有约定把**剩下的整面板级读失败点**补齐：① `getMomentsMonthly` 从裸数组改成具名快照 `MomentsMonthlySnapshot{months, readError?}`（"具名"不是洁癖：返回类型写成 `X[]` 时那道**类型驱动**的守卫根本看不见，面板漏读 `readError` 就不会红）；② `listExportHistory` 的 catch 不再回 `empty` 而是带原因（记录没丢，是那一页没读到，界面从「还没有导出记录」改成「导出记录读不出来 + 为什么」）；③ 朋友圈图片/视频：两份各自咽掉 `readdir` 失败的扫描口收进 `query/sns-scan.ts`，**没扫全就不许说「本机没有」**，也不许把这条结论记进 `misses`（旧形状会把一次临时的目录读不动**永久缓存**成「这条视频本机没有」，只有重启才恢复 —— 与 ⑨ 的负缓存同族）；④ 顺手把 moments 的 `new DatabaseSync` 收进 `withDb`（P0-1 棘轮清单少一条）。**复核实为正确降级、本轮没动的**（免得下一个人以为漏做）：`voice-transcribe.cachedTranscript`（单条转录缺失）、`queryStorageStats`（网关壳不 catch，读不动照实抛成 RPC 错误）、`region` 资源表（退回原始拼音是标签退化，不是空数据）、`recordExport`（best-effort，文件头注释已写明）。**判据** `read-failure-contract.spec.ts` 11 条：坏库/坏目录都是**真的造出来**（`sns.db` 写垃圾字节、把 `cache` 造成一个普通文件 —— Windows 上唯一可移植的「目录读不动」造法），正反两头都量（「确认空」那几条要求 `readError` **缺席**，否则「一律报读失败」也能全绿）；另有两条源级判据钉「扫描口只有一份实现」与「返回的是具名快照」。变异 M100–M104 |
| 判据收紧：「解对了没有」那道闸门自己撞上了报告算的余量 | ✅ 完成 | `c07a13a` | 见「本轮新发现」⑭ —— `plausibleSqliteHeader` 原来只看页大小（撞中率约 0.02%），本轮跑全量 `vitest` 时**真的红了一次**（`decrypt-all-tree` 里那个错密钥的 `bad.db` 被判成有效，单独重跑又绿）。现在把 SQLite 规范写死的另外三组字段也纳入：读/写格式（18/19 只能是 1 或 2）+ 三个 payload fraction（21/22/23 必须是 64/32/32），合起来约 10⁻¹²。刻意不看偏移 20 的 reserved（微信那类库里是 80 而不是 0，拿它当常数会把真库整批判成无效）。收紧当场撞出**夹具自己在撒谎**：`decrypt-all-tree` 的合成页 1 只填了页大小、其余是乱码填充，根本不是 SQLite 头部该有的样子（一次红 7 条）⇒ 抽出公共 `tests/helpers/sqlite-page1.ts`。变异 M105/M106 |

| 第二批 #11 P1-2 让出 | ✅ **让出 5/5 完成**；🟡 取消仍等生成链 | `3928dca` + `d2d4f0a` + `8b1ba12` + `32ce84a` + `5b69d61` | 上面那两条实施前提 ① 已开工：先补两块基建 —— `withDbAsync`（连接要跨过 await 才关得掉；把 `await` 塞进同步 `withDb` 的回调里，连接会在**第一次让出时**就被关掉，表现是「小库恒绿、大库偶发 database is not open」，判据里有一正一反两条对照用例钉住这件事）与 `cachedBySigAsync`（异步版签名缓存 + **同键合流**：让出之后并发冷算真会撞在一起，不合流等于把 54 秒跑两遍；只有「仍在飞的那一份」才写回，防旧签名盖掉新数据）。改造的模块选 **`overview-insights`**（P1-2 里唯一有实测数字的那个：`analyzeVisibleMessages` 54,103ms）：消息分片之间各让一次、朋友圈整表扫每 2000 行让一次，`getOverviewInsights` 随之变 async（客户端一直是 `await` 的，无需改面板）。**按行数而不是按时钟**：CI 机器慢 20 倍，任何「跑够 25ms」的断言都会假红。**判据** `query-yield-discipline.spec.ts` 9 条用 `setImmediate` 探针与查询并发跑，量「探针拿到几个 tick」（同步实现一个都拿不到 ⇒ 必咬），`[算料]` 2 分片 ticks=3、1 分片 + 2001 条 ticks=4；`cachedBySigAsync` 的命中/合流/失败三态各一条。**剩下四个模块（`privacy`/`graph`/`ledger`/`storage`）钉成 `STILL_SYNC_ONLY` 棘轮**（只能变小，谁先改完谁删条目）—— 别让「做了一件」在台账里看起来像「做完了」。顺手两处：`contact.db` 的 open/close 收进 `withDb`（PRAGMA/SELECT 抛错时原本漏句柄，外面还是 `catch { ignore }`）、总览的 shell 探针改为 `await`（不 await 的话**每一个**异步端点都会被误判成「快照没形状」）。变异 M107–M110。**第二块收的是 `privacy`**（`d2d4f0a`）：探测阶段每分片一次 + 扫描阶段每表一次 + 每 5000 行一次的让出，整条链（`queryPrivacyScan` / `remotes+gateway.getPrivacyScan` / `exportCsv` 的 privacy 分支）随之 async。**顺手修的是判据本身**：原来「探针拿到几个 tick」的下界是**估**的，于是 M113（把行级让出关掉）照样全绿 —— 判据看着有、实际不咬。实测确认 `ticks == 让出次数 + 1` 是**结构性**的（探针每轮只排一个 `setImmediate`，队列里最多压着它一个回调，与机器快慢无关），所以下界直接取「让出次数 + 1」：三条用例的下界改成 3 / 4 / 6 之后，M107/M108/M111/M112/M113 逐条复跑全咬。**第三块是 `storage`**（`8b1ba12`）：`msg/file` 整树 stat 按月份目录让出 + 大文件列表逐条让出（后者不是凑数 —— `resolveFileTitle` 找不到名字时会**逐个消息分片开库**去找那条消息，100 条 × 全部分片就是几百次同步开库，那一页真正的长尾在这里）。判据加第三条用例（2 个月份目录 + 3 条大文件 ⇒ ticks=6，下界同样取「让出次数 + 1」），变异 M114/M115。**第四块是 `ledger`**（`32ce84a`）：最贵的一段是 `resolveMessagesByServerIds` —— 把 general.db 的转账/红包行还原成消息时，两趟扫描（整型等值走索引 + 文本 CAST 兜底）**每趟都把所有消息分片各开一遍库**，现在分片之间各让一次。探针同时收成公共零件 `helpers/tick-probe.ts`（账本那条用例挂在 `ledger.spec.ts` 里复用已有的 64 位/文本 id 夹具：1 分片 × 2 趟 ⇒ 让出 2 次 ⇒ 下界 3，实测 ticks=3 正好贴线），`STILL_SYNC_ONLY` 只剩 `graph`。变异 M116。**第五块是 `graph`**（`5b69d61`）：`loadMessageCounts` 每开一个分片库之前让一次（放在 `wanted` 判空之后 ⇒ 让出次数 == 实际开库次数），`queryGraph` / `getGraph` 随之 async；探针用例的下界写成 2 而不是 `opens + 1`，理由记在用例注释里（`countOpens` 数的是所有 `close`，里面含会话库/通讯录库这些**不该让出**的开合，拿它当让出次数会虚高）。**收完五个模块之后，那张剩余清单升级成零容忍清单**（`P1_2_MODULES` 逐个断言含 `yieldToLoop` + 「清单不许被清空」的长度哨兵）—— 棘轮走到 0 就该变成闸门，不然它悄悄退化成恒真。变异 M117。**顺带撞出一条工具事实**：这次改动让两条**旧**变异（M63/M64，第一批 #5 的 P1-3 判据）锚点失配 —— `cachedBySig`→`cachedBySigAsync` 改了函数名、循环里插了让出点。它是被 `--only` 复跑抓出来的，不是人眼看到的；M64 的 `from` 已改成**从源码里现截**（脚本取整段循环再 `JSON.stringify`），以后再动这个文件就不会再失配。**「取消」那一半仍按上面的 ② 等生成链**（P1-5 已结项，下一步是给 `@Remote` 的取消元数据接上可复现的生成） |

| 第三批 #21 P2-3 解循环依赖 | ✅ 完成（**超出清单，并纠正报告一处误报**） | `cf0840a` | 报告 §P2-3 点了 6 对双向边，AST 实测是 **5 个强连通分量**：`chats-thread.tsx ↔ Chats.tsx` 那一对**是误报**（互相提到的只是类型，编译期就擦掉，不构成运行期依赖）⇒ 守卫里专门留一条用例钉「口径不过宽」，防止清单混进假环后「只能变小」失去意义。真环逐个解开：① `export-format.ts:16` 的死 import（进来的成员全仓没用到）；② `api-core` → `api-config`/`api-status` 改 `import type`；③ `graph-canvas-theme` 的死 `bubbleText` + geometry 的三个类型改 `import type`；④ `chats-media` ↔ `chats-cards` ↔ `Chats` 把 `CardFoot` 拆成 `panels/chats-card-foot.tsx`；⑤ `search-build`/`search-query`/`search-scaffold` 三节点环，把五把纯展示帮手拆成 `query/search-display.ts` 叶子（它们不碰库、不碰索引，天然在最下面一层，拆完方向重新单向）。**守卫** `src/backend/tests/module-cycle-guard.spec.ts`：走 `ts.createSourceFile` 只取 `ImportDeclaration`/`export * from` 的**模块说明符字面量** —— 报告自己警告过本仓注释里大量 `from './x.ts'` 字样会让正则分析误报，实测确实如此（注释里的字样在语法树里根本不是节点）；Tarjan 迭代版求 SCC（递归版会爆栈）、`import type` 与全 `type` 成员不建边、只扫后端 + 渲染层两棵产物树。**清单清空之后改闸门**：`KNOWN_RINGS` 删掉，「值 import 环 == 0」变零容忍，而这条不是恒真 —— 由「临时造一个三方环，判据必须报出来」的反例自证 + 变异 M118（SCC 恒不 push）撑住；M119（把 type-only 当边 ⇒ 多报假环）、M120（只扫后端树 ⇒ 渲染层的环悄悄不查）、**M121（把 `search-scaffold.ts` 那条死 import 原样加回来 ⇒ 真回归点上必须在真文件上变红，而不是只在合成夹具上）**。终态 `[算料|cycles]`：节点 371 / 值 import 边 990 / **环 0 个**。**顺带撞出的第二条**：搬叶子时 `format-single-source` 的「清单不许腐烂」判据先报了路径漂移，回读发现 `formatFullTime` 与 `src/format.ts#fmtDateTimeSec` 输出**逐字节相同**（10 组对照含 0 / NaN / null / undefined / 负数）⇒ 删掉第二份实现、三处调用改指唯一出处，而不是只把登记路径挪一下，`KNOWN_SECOND_TIME` 7 → 6（这条同时是「棘轮清单被搬文件蒙混过去」的反例：路径变了也要红） |

| 第三批 #18 拆 `moments-panel.tsx` | 🟡 **第一步做完**（其余三族未完），并**修掉一个真缺陷** | 本次提交 | 报告说「单函数 917 行」，实测 `MomentsPanel` 占 929 行（文件 960 行）：JSX 早在 M21 竖切时就分给了 `moments-card/portals/sidebar`，剩下整块是**容器逻辑**（状态 + 副作用 + 回调），所以这一项的正解是抽自定义钩子而不是再切组件。第一刀切的是**筛选与派生**：原先连着七个 `useMemo`、每个依赖上一个的数组身份 —— **这形状已经真出过事故**：`scoped` 函数体读 `dateScoped`，依赖数组却写 `[monthFiltered, sortOrder]` ⇒ **只改日期范围时列表不动**，而侧栏那个日期选择器是用户点得到的（`moments-panel.tsx:371`，改前）。**改前没有任何用例覆盖日期筛选**，本仓又没装 eslint（#24 那条正是「装 eslint 才能自动拦」），所以「依赖数组漏一项」在这里连静态防线都没有。① 新增 `panels/moments-scope.ts`：筛选是**纯函数**（`scopeMoments`/`insightCounts`/`topAuthorRows`/`monthlyRows`/`monthKeyOfSec`），`useMomentsScope` 是全层**唯一**写依赖数组的地方；月份键刻意不叫 `fmt*`/`format*` —— 那前缀 + 单位换算会被 `format-single-source` 判成第二份实现（同名的 `fmtMonthKey` 会当场给自己登记一条棘轮）。② **判据** `moments-scope.spec.ts` 26 条分三层：纯函数表（八条件逐个正反例、搜索的九个入口、日期闭区间两端各验一次、并列时间戳的稳定序、不改入参，连 `nickname \|\| username` 那条短路口径也钉住）、**jsdom 真渲染**（只改 `dateFrom` 必须换结果 —— 正面打在那个缺陷上；反向钉「值没变、只是 criteria 换了对象身份」不许重算，否则「干脆不 memo」也能骗过第一条）、**AST 契约**（`MomentsCriteria` 每加一个字段，那次 `useMemo` 的依赖里就必须出现 `criteria.<字段>`，配形状哨兵：读不到字段清单或找不到 memo 就红，不许恒真）。③ 接线判据两条（面板必须走这层 + 面板里 criteria 八字段一个不能少），其中「痕迹清单」第一版写错被自己的空转哨兵抓住：`T00:00:00` 在面板里**合法存在**（导出日期范围要用它），拿它当筛选痕迹会误报 —— 痕迹清单只留筛选独有的三条。面板 929 → 837 行。④ 变异 M122–M125：抹掉 `criteria.dateFrom` 依赖（正是原缺陷形状，纯函数表全绿、只有真渲染与契约红）、结束日改 00:00:01、AST 契约认的钩子名改掉、月度分布回退时忽略作者。**剩下的三族仍未拆**（媒体懒解密 / 视频 / 灯箱 / 导出），别把这一条当整项结项 —— 报告估 1.5d，本轮做的是其中最大也最有害的一段。**读码时差点误报一条**：`mediaKeySpec` 在面板里只见读不见写，看着像「懒解密整条链是死的」，实为**卡片在 render 里登记 spec**（`moments-card.tsx:105/146/289`），那次 grep 被 `\| head -20` 截断才只见面板的十几行 ⇒ 否定式结论必须用不限流的搜索（已写进工具记忆 53）。 |

| 第三批 #18 第二步：媒体层 | ✅ 完成（后续三族见下一行，#18 已整体闭合） | `308f152` | `MomentsPanel` 里最大的一块是**离线媒体**：五个位置散着同一族状态（`snsImgs`/`snsFetched`/`articleCovers`/`coverAttempts`/`coverTick`/`mediaKeySpec`/`mediaQueue`/`mediaFetching`/`mediaObserved`），约 147 行，收进 `panels/moments-media.ts#useMomentsMedia`，面板 929 → **694 行**。这一族的危险性在于它是**三方约定**凑成的、断掉任何一条都不报错：卡片在 render 期间把 `{md5, timelineId…}` 登记进 `mediaKeySpec`、把同一个键挂到 DOM 的 `data-sns-key`，面板的观察器按 DOM 上的键反查那张表 —— 对不上时表现只是「图片永远停在缩略图」，而**这张表改前没有任何用例碰过**。**判据** `moments-media.spec.ts` 16 条全部数 RPC（不读源码形状）：兜底支（jsdom 没有 `IntersectionObserver` ⇒ 走整页解密那一支）逐个解登记过的键且不重复、先问 IndexedDB 命中就不许再调解密 RPC、一批 8 个之外的必须排空（`while` 不是一次 `splice`）、视频走视频封那个 RPC、IDB 捞过的键之后不再走单张 RPC、封面兜底**最多试 3 次**（否则一个永久失败的链接会一直出网）、灯箱缺图只解一次。两条接线判据：面板不许再自己持有那三份状态（`setSnsImgs`/`coverTick`/`drainMedia` 回填就红，且反向钉「这些痕迹在本层里确实找得到」，免得判据比的是编出来的字符串）；卡片的 `mediaKeySpec.current.set` **不许被挪进 `useEffect`**（挪进去就错过挂载时那一次兜底）—— 这条按 AST 认「这个调用表达式本身」，因为外层 `useEffect(...)` 的整段文本也含那段，按 substring 会自己骗过自己。**顺手收成一份出处**：视频键 `v:<md5>` / `v:<timelineId>:<id>` 原先在 `moments-card.tsx` 与 `moments-portals.tsx` 各写一遍（加上本层共三份），现统一走 `videoCoverKey`；`MediaKeySpec` 类型也从卡片挪进媒体层。**判据自己撞出来的两条口径纠正**：① 第一版把「spec 登记 vs 观察器读取」写成「卡片里 `set` 的行号 < 第一个 `useEffect` 的行号」，而卡片根本没有 `useEffect`（⇒ `indexOf` 得 -1，比出的「先后」是假的）；② 「DOM 契约」测试夹具把视频键按 `kind: 'img'` 登记，于是断的是错的那条 RPC。**变异 M126–M130**（`while`→`if`、忽略 IDB 命中、视频走图片 RPC、视频键丢掉 md5 优先、重试上界 3→4），另加一条工具事实：登记表涨到 1036 行撞上 `m21-file-size-ratchet` 的 1000 行硬闸门 ⇒ 按该文件头部早就写好的处置**切批次**（新增 `mutations-registry.batch3.mjs` 装 M118 起，主表停在 M117，末尾聚合成同一个 `MUTATIONS`），**没有放宽闸门**——这是「登记变异这个动作本身撞闸门」第二次发生（第一次见上面的工具修复条目） |
| 第四批（部分）剪贴板收成唯一出口 + 一条真缺陷 | ✅ 完成 | `8b4343c` | `utils/misc.ts#copyTextToClipboard` 本来就是本仓唯一的复制出口（异步 API 被拒收敛成 `false`，还会试 `execCommand('copy')` 退路），但 **`git grep` 实测有 8 个面板里的 10 处**各自手写 `navigator.clipboard.writeText` + `catch`（别名写法 `clip.writeText` 也算 —— 只搜 `writeText` 会漏掉 `moments-panel` 那两处，第一版就漏了、报成 9 处）：那些站点**没有退路**，窗口失焦/权限被挡这类常态下本可以复制成功却被报成失败；`moments-panel` 更把 `.catch(() => {})` 写成静默，用户看到的下一步建立在「什么都没发生」上。`ReplySuggest.tsx` 早就修对了这件事，但它的判据**只管自己那个文件**（`reply-suggest.wiring.spec.ts`）—— 正是「规则没有全仓化」的下场：修了一处，其余原地不动。本轮升成零容忍闸门。**顺带修一条真缺陷**：`execCommand` **抛异常**时（受限上下文里真会抛）改前会跳过 `document.body.removeChild(ta)`，外层 catch 只回 `false` ⇒ 每失败一次在 body 上留一个 `opacity:0`、且 `select()` 抢过焦点的隐藏 textarea；摘节点挪进 `finally`。这条是**新写的行为用例第一次跑就抓出来的**（P0-1「catch 分支漏 close」那一族的 DOM 版）。**判据** `utils/clipboard-single-source.spec.ts` 8 条：零容忍扫描走 AST 取成员访问（`ReplySuggest.tsx` 注释里就写着 `navigator.clipboard.writeText`，按文本匹配会误报 ⇒ 与 P2-3 那条同一个理由），实测全仓只剩唯一出处的 2 处命中；结构哨兵**不猜文件数下界**（195 是实测值，换机器就漂），改钉「`ui-wechat` 与 `ui-app` 两棵子树都在扫描面里」——第一版拿 `package.json` 当仓库根标记，结果停在 `ui-wechat` 子包上、只扫了半个仓，正是这条把它抓住的；助手行为四条（成功不碰退路 / 被拒走退路并如实回结果 / 两边都坏才 false / 没有 `navigator.clipboard` 也不炸）+ 退路抛异常时不泄漏节点，其中 jsdom **不实现** `document.execCommand`（`vi.spyOn` 直接报 does not exist），退路必须自己装假。**一条被既有守卫接住的返工**：`moments-panel` 第一版写成 `hold(ok ? '已复制' : '复制失败')`，`transient-notice.wiring.spec.ts` 当场红两条 —— 它按**调用点数**钉「提示功能没被顺手删」（Moments 族 9→7），并按**字面量**钉「失败类提示走 hold 不走 flash」。改回 `if (ok) hold('已复制'); else hold('复制失败')` 后两条都过：在这种源码级判据前，合并调用点不是简化。**变异 M131–M133**（回到「不摘节点」的改前形状 / 扫描判据恒不命中 ⇒「0 违规」立刻达成但判据瞎了 / 让 `Emoticons` 退回手写 ⇒ 真回归点上必须报出来） |

| 第三批 #18 第三～五步（导出/视频、灯箱、取数） | ✅ **#18 至此按报告口径做完**：`MomentsPanel` 929 → **357 行**（文件 960 → 393） | `41e9a9d` `2badd42` `766c05a` | 剩下三族一次搬干净，每一族都是「纯函数 + 钩子 + 判据 + 变异」四件套。**导出**（`moments-export.ts`）：弹窗七个表单字段 + 四个进行中标志 + 手动重同步，重点是那颗纯函数 `buildExportOptions` —— 它决定「导出的文件里有什么」，写错时界面毫无征兆（屏幕筛的是「只看我的+九月+有图」，导出来可能是全部），所以逐键钉「给了才带、没给就不许这个键出现」（`media=all`/`mine=all`/空白搜索都不许发出去），并钉住最容易写反的一对：`username`（微信用户名，深链带的）与 `authorName`（作者显示名，作者牌选的）。**视频**（`moments-videos.ts`）：四份互相跟着走的状态 + 取本体/全屏/收起/保存，改前**一条用例都没有**；同键连点两次只发一次 RPC、后端回「取不到」必须留**原因**（未缓存/CDN 加密流/出站被拦是三种不同处置）。**灯箱**（`moments-viewer.ts`）：四个变换量 + 四个 ref + 四个 effect，三条失败方式属「说不清的怪」的规则收成纯函数（`zoomFor` 下限恒为 1、`clampIndex` 两端都钳、`imageExtOf` 只认 2–5 位扩展名否则退回 `jpg` —— 不校验就会写出 `.1688486141` 这种文件名）。**取数**（`moments-data.ts`）：分页 + 渲染缓存秒开 + 全量 + 静默增量刷新 + 三份侧栏附赠数据。**搬运过程中撞出/接住的四件事**（都有落点，不是流水账）：① `saveVideo` 里「选路径」那步在 `try` 之外 ⇒ 主进程对话框起不来时既没提示又留一条未接住的 rejection（搬的时候顺手修）；② 我把 `saveVideo` 成功后「把落盘路径记回面板」这一步**搬丢了** ⇒ 靠 `onSavedPath` 回调补回，并专门加一条变异 M140 盯它 —— **重构丢副作用**是这类搬运的典型失手，所以每族都写了「接线判据」（面板里不许再出现被搬走的状态/调用，同时反向钉「这些痕迹在本层里确实找得到」）；③ 两条**判据自己错**：`loadAll` 失败那条没先造出「还有下一页」（游标已追上总数时直接返回是正确行为）、滚轮那条把 ref 就位与 viewer 变化拆成两次 React 提交（产品里是同一提交，于是监听永远装不上）—— 都改夹具、不动代码；④ `read-error-visibility.spec.ts`（P1-1 的类型驱动守卫）**当场红了**：它只扫 `panels/*.tsx`，而 `apiGetMomentsMonthly` 现在住在 `moments-data.ts` ⇒ 判据以为接口已死。放宽到 `panels/*` 的 `.ts`（根目录那层不放宽，否则 `api-*.ts` 的函数**定义行**会被当成调用点）。我先给它开了一条「钩子转发、由导入者读」的例外还配了自证，实测那条例外**是死代码**（钩子自己在失败分支写了 `readError`，「谁调谁读」原口径就够）⇒ 例外连同自证删掉，换成一条有用的哨兵（放宽后必须真扫到 `.ts` 调用方）。另清掉 9 条搬完就死的 import（「导入了但不用」正是 P2-3 那几个环的成因形状）。变异 M134–M153（二十条），逐条 `--only` 全咬红 |
| 新守卫：单函数行数棘轮（#18 的防回归 + #19/#20 的前置） | ✅ 完成 | `766c05a` | 拆完顺手把全仓量了一遍（AST 取 `FunctionDeclaration` 与 `const X = 箭头/function`，按起止行计），**报告点名的那一处不是孤例**：超过 250 行的具名函数有 **32 个**，最长的是 `settings-state.tsx#useSettingsState` **840 行**（`kb-files-panel` 788、`chats-view` 752、`Graph` 728、`Chats.tsx#ChatsPanel` 555、`chats-thread#useChatsThread` 458…）。做成**只能变小**的台账：新长出一个超标函数 ⇒ 红；登记的变长了 ⇒ 红；变短了 ⇒ 也红，但要求把数字改成实测值（成果要记账）。清单**由脚本从实测灌进源码**，不手抄 —— 手抄过一次：`| head -30` 把 32 条截成 30 条，我照着"补齐"的四条里有一多半是编出来的（工具记忆 53 的复发）。配反例自证：合成 303 行的函数必须量出 303，四种坏法（新增/消失/长大/变短）分得开；变异 M151–M153（阈值抬到十万 / 「没登记」那格写死 / 「长大」那格写死）。 |

| 第三批 #23 P2-4 ③ 统一失效契约 | ✅ 完成 | `d19fff6` | 新增唯一出口 `cache.ts#invalidateAndNotify(前缀 \| 前缀[])`，一次做完三件事：① 清 `localStorage` 两层（值缓存 + 渲染缓存）、② 丢掉命中前缀的**内存快照**、③ **通知订阅者**。改数据的写入侧从此只调这一个函数。**这不是整理代码**：两层缓存的通知能力不一样 —— `invalidateWechatCache(prefix)` 只清持久层、**一个订阅者都不通知**，而 `invalidateSnapshotCache()`/`snapshotDelete()` 会连着订阅者一起动。实测这样的写入点有 **11 处、跨 7 个接口**（改消息 / 重置改回原文 / 清草稿 ×2 / 删收藏 / 改隐私开关 / 恢复备份），全部只做第①件 ⇒「我清过缓存了」和「正在看这一页的人看到了新数据」是两件事；最刺眼的是 `apiRestoreBackup`：**整库被换掉，界面还是恢复前的样子**。**判据** `cache-invalidate-contract.spec.ts` 11 条：三件事各钉一条（含「只活在持久层的键也要被通知」—— 只看快照表的话 ③ 是假动作，这条专打它）、前缀不许越界伤别人（清 `sessions:` 不能把 `messages:` 打冷；多前缀取并集）、`''` 走既有的「标陈旧 + 通知所有」而不是清表（P2-4 记着的那场风暴）、一个订阅者抛错不许饿死后面的、两层持久缓存都要清。外加两条契约扫描：白名单之外不许直接调 `invalidateWechatCache`（`api-kb.ts` 那 5 处合法，因为它们紧跟着调 `invalidateKbCaches()`/`invalidateKnowledgeCaches()`，那两个组合器自己就把 ②③ 做了 —— **白名单逐条写理由，并要求白名单里的文件"确实还在用"，不再用了就得删**），以及七个接口逐个点名。另钉一条口径事实：写入侧用的前缀必须在读取侧真是同样的键前缀，否则「清 `messages:`」匹配不到任何快照。变异 M154–M158（拿掉①/②/③、全量分支不通知、让 `apiRestoreBackup` 什么都不清 —— 真回归点；刻意不写成"改回 `invalidateWechatCache`"，因为那个名字已从该文件 import 里删掉，会变成收集期 ReferenceError 而不是断言失败）。**三条自我纠正**：① 我自己写的解释性注释「原来只 `invalidateWechatCache('')`」被自己的零容忍扫描当成违规调用报红 —— 本仓**第三次**踩「注释里的代码字样被当代码」（前两次：`module-cycle-guard` 的 `from './x.ts'`、`clipboard-single-source` 的 `navigator.clipboard`），于是这条扫描一开始就走 AST 取 `CallExpression`；② 接口数先写错成「九个」，不限流重扫才知道是 11 处 / 7 个函数；③ 白名单自查那条我先写成 `ALLOW.has(p)`（`p` 是元组，typecheck 抓住）+ 用 `toBeDefined()` 断"存在"（等于什么都没验），改成按**调用次数 > 0** 断。**还有一条要如实记的**：本轮改动把一条**早就登记在案**的变异（M54 `apiSetPrivacyState` 的地图开关镜像）锚点撞断了 —— 全表复跑报「锚点失效 / 未执行」而不是"守卫没咬住"，按源码现状重算锚点后 M54 复跑仍咬红。这正是 §八 要求收尾跑全表的原因（人眼看不见这种断裂，工具记忆 52）。 |

| 成员搜索的 FTS 路径（P3 附带，第 97 轮） | ✅ 完成，并**拆掉一条幻影引用** | 本次提交 | `gateway-read.ts:116` 与 `query/members.ts` 的注释都写着「由 `scripts/check-members-search.js` 对着真实库把关」，而**那个脚本从来不存在**（`scripts/` 里没有、全仓 grep 也没有）—— 一个不存在的"把关者"比没有把关者更坏，它会让下一个读代码的人以为这件事已经防住了。查一遍才知道它声称把关的那件事**根本没被任何用例碰过**：`contact_fts` 建表时只有 `name` 是可检索列（`username/remark/alias/quanpin` 全 `UNINDEXED`），而 `name` 装的是 `remark ‖ nick_name ‖ username` ⇒「按备注全拼 / 别名搜人」在**索引健康时永远搜不到**，只有降级走 LIKE 才搜得到。第 96 轮那次修复只补到了两条 LIKE SQL 上，而 FTS 才是默认路径 —— 于是同一句查询因索引在不在给出不同结果（比"两边都搜不到"更难查：用户偶尔搜得到、偶尔搜不到，日志一切正常）。**修法**：`contact_fts` 升 **schema 2**（`alias`/`quanpin` 建成可检索列），查询显式点名三列 `name:"词" OR alias:"词" OR quanpin:"词"`（只写 `"词"` 会退化成只搜 `name`），并给派生索引记版本号 —— 认不出旧版本就等于没修（存量用户的库还是 v1）。旧表是派生数据，版本不对直接 `DROP` 重建（索引库任何时候可从 `contact.db` 重算）。**判据** `members-search-columns.spec.ts` 8 条分三组：三种列各自命中且 `source === 'fts'`（钉住"没静默降级"，否则降级会把缺陷盖住）、**FTS 与 LIKE 给出同一批人**（这才是"结果不随索引状态漂移"的硬要求）、v1 形状必须先被认成过期再重建（`aliasSearchable` 前后各验一次 + 版本号落在 `meta` + 重建不丢行）。**反向也钉一条**：FTS5 是整词匹配，半截全拼命中为空时**必须让 LIKE 兜住** —— 我第一版把这条判据写反（"空命中也该报 fts"），回读源码才发现那个"看着像静默降级"的 `if (rows.length > 0)` 是**有意的**：改掉它会让装了索引反而比没装搜得更少，于是补注释说明代价（每次空命中多扫一遍 `contact.db`）并把它写成用例。**夹具踩到的事实**：`contact_fts` 只在索引库文件已存在时才会被建（`searchGlobalMembers` 的入口闸门），光造 `contact.db` 的用例必然落在 LIKE 支上 —— 前三条用例一度全绿是因为它们验的就是降级支。变异 **M159–M162**（少点名一列 / schema 缺键算当前版本 / 认旧不重建 / 抹掉 LIKE 兜底），逐条 `--only` 全咬红、逐字节还原。**同一条缺陷在群内路径的对照**：`searchRoomMembers` 只有 LIKE，没有 FTS 分支，所以第 96 轮的修复对它已经足够；这条差异记在 `members.ts` 注释里，免得下一轮又去给一条不存在的路径补索引。**没做完的部分如实说**：本条只清了这一处幻影引用；全仓「注释指向不存在的东西」的清单尚未跑完（§七 第四批 #25 那条守卫的前置），已测得 64 个不可解析标记，多数是解析口径造成的，剩一处待判。

| 第三批 #19 第一步：拆 `useChatsThread` 的轮询族 | 🟡 **第一刀做完**（`ChatsPanel` / `ChatsView` 未动） | 本次提交 | 报告 #19 说的是「三个巨函数 + 一个 150 字段的 state 袋」。第一刀切在 **`chats-thread.tsx#useChatsThread`（458 行）里唯一会自己动的那一族**：增量轮询、就地改对账、可见性周期切换、宿主推送 / SWR 广播订阅 —— 四条入口往同一份 `messages` 上写，共用两个在途闸门（`inFlightRef` / `reconcileRef`）和一套会话归属令牌（`sessionAlive`）。这一族**改前一条用例都没有**（同目录只有读源码文本的 `chats-*.wiring.spec.ts`），而它写错的后果全是"看不见"那一类：上一个会话的消息画进当前会话、渲染缓存被污染后重开还是错的、状态栏写着上一个会话的失败。① 新增 `panels/chats-polling.ts`（钩子调用顺序逐个对齐拆前位置：`useCallback`→`useRef`→`useCallback`→`useEffect`→`useEffect`，且仍坐在「会话切换复位」那个 effect 之前）。② **行为判据** `chats-polling.spec.ts` 17 条，全部数 RPC / 看数组身份 / 看写进缓存的那一份：水位为 0 不许问后端、闸门开着不许问第二次、令牌失效要**既不写消息也不写状态栏**、去重命中必须**保持原数组身份**（否则每秒白重渲染一次）、缓存要写合并后的整列表（只写增量 ⇒ 下次打开旧消息全丢）、可见/隐藏两套周期各验一次、`visibilitychange` 立刻补一次、卸载后定时器与监听都不许还活着、`dsh-wechat-data-updated` 与 `<SNAPSHOT_REFRESHED_EVENT>:messages` 两个事件都要同时触发增量与对账。夹具上补了三个坑：jsdom 不实现 `scrollIntoView`；`requestAnimationFrame` 改同步执行（否则异步帧落在 `act` 之外）；**`setMessages` 必须延后执行 updater** —— 立即执行的话产品代码里「外层查一遍、updater 里再查一遍」那道二次检查永远测不到（第一版就是这么写的，那条用例当场红给我看）。③ **接线判据** `chats-polling.wiring.spec.ts` 5 条：钩子真的挂着（`useChatsPolling(` 带括号 —— 只查函数名会被 import 行蒙过去）、五件指纹不许在 `useChatsThread` 里再长一遍、`chats-polling.ts` 自己五件齐全、外加空读哨兵与合成违例自证。扫描一律走 `readStripped`（剥注释）：新模块的头注释里就写着 `setInterval`、`visibilitychange`。④ **撞出一条口径漏洞并补掉**：`chats-source.ts` 的联合只扫 `chats-*.tsx`，把逻辑搬到 `.ts` 就会让所有读这份联合的守卫**静默失去靶子** —— 这次是 `sessions-list-refresh.wiring.spec.ts` 用「找不到 onUpdated」报出来的（它钉的是"实时处理器不许刷会话列表"那条真回归，改名/搬家的哨兵救对了），联合现在收 `.tsx` 与 `.ts` 两种后缀并排除 `chats-source.ts` 自己。⑤ **顺手清掉四处"注释挂在错代码上"**（都在这一族附近）：`renderMsgItem` 的文档挂在 `messagesMatchSession` 上、`closeCurrentSession` 的文档挂在 `renderMsgItem` 上、`beginSession` 的文档挂在 `closeCurrentSession` 上、`sessionAlive` 的文档下面根本没有函数 —— 全部搬回各自定义处，并删掉一句漂到 `copyMsgText` 头上的 "Incremental poll"。这四处是**上一轮拆件时留下的**（拆走函数没搬注释），也是 §六 幻影引用清单里"注释指向不存在之物"的同一族。棘轮记账：`useChatsThread` 458 → **339**、`ChatsPanel` 555 → **550**（注释搬家净减 5 行；这一格是 `function-size-ratchet` 逼着改的，见工具记忆 53：数字必须实测回填）。变异 **M163–M168**（去掉水位闸门 / 去掉 updater 里的二次令牌检查 / 去重写死 / 可见与隐藏周期互换 / 缓存只写增量 / **把钩子从面板里摘掉**——最后一条打的是接线判据），逐条 `--only` 全咬红、逐字节还原。**没做完的部分**：`Chats.tsx#ChatsPanel` 550 行与那个 50 字段的输入袋原样未动（`renderMsgItem` 是下一个自然的刀口：它是纯渲染，却住在逻辑钩子里、捕获六份闭包状态），`chats-view.tsx#ChatsView` 752 行也未动。 |

| 第三批 #19 第二步：消息行拆成组件 | ✅ 与第一步同轮 | 本次提交 | 第二刀切 `useChatsThread` 里的 **`renderMsgItem`**（68 行 JSX，捕获六份闭包状态）。它是**纯渲染**，住在逻辑钩子里既没法单测、又让那个钩子看着像"什么都做"。拆成 `panels/chats-msg-row.tsx#makeMsgRow(deps)` —— 给一份渲染项 + 六份依赖，回一个元素。这里的价值不在行数，在**那条规则第一次有了用例**：头像的身份键三条分支各不相同（自己 = 登录 wxid / 群成员 = 消息里的 sender / 私聊对方 = 会话 username），拿错键的表现只是「两个人显示同一张头像」，不报错、不告警。注释里明写着当年 fallback 到 `curSession.username` 就把「我」键到了对方身上 —— **这条事故只有注释在守**。① **行为判据** `chats-msg-row.spec.ts` 16 条：三个子组件装假（本文件断"传给了它们什么"，不断它们画成什么样），`renderKindOf` **用真的**（「哪一类走居中行」正是本组件依赖的分类口径，mock 掉等于把契约从测试里删掉）；用例含日期分隔无 id、四类居中行（系统/撤回/拍一拍/无内容）不画头像、`msg-<localId>` 的 id 契约（深链与 `locateMessage` 靠它）、居中行的正文**不带**聊天纪录入口而普通消息**带**、自己 wxid 未知时留空、群成员没 sender 时不许用昵称当键、发言人标只在「群 + 别人 + 有 sender」时出现、连拍图组只画一行且把 `username`/`onOpenAt` 透传、空图组不炸、已编辑标记、右键把 `(ev, 这一条, 种类)` 交回面板。② **接线判据** `chats-msg-row.wiring.spec.ts` 5 条：`makeMsgRow(` 真被调用 + 五件 JSX 指纹不许长回 `useChatsThread`（`readStripped` 先剥注释，同上一条守卫的理由）+ 空读哨兵 + 合成违例自证。③ **一条被工具抓出来的真实约束**：工厂把依赖**当参数**传，而 `openChatlog` 定义在文件后头 —— 拆前那是函数声明、提升让"晚定义的回调"在调用时才解析，所以原地不动就没事；搬成调用立刻 TS2448/TS2454。落点移到 `openChatlog` 之后并把这条写进注释（**这类"重构前不存在的使用顺序约束"是拆钩子最常踩的坑**：typecheck 是唯一能看见它的地方，运行时只在特定点击路径上炸）。④ **既有守卫又接住一次漂移**：`chats-css-split.wiring.spec.ts` 的消费者表里还登记着 `chats-thread.tsx`，而它这一刀之后不再引用任何 chats 样式 ⇒ 那条"每个消费者至少 import 一份"的防空转哨兵当场报红，登记表按实际改（把 `chats-thread.tsx` 换成 `chats-msg-row.tsx`）。**这是本仓守卫设计的又一次兑现**：手维护的清单不会因为"文件还在"就免检。⑤ 棘轮记账：`useChatsThread` 339 → **269**（第一刀 458 → 339）；剪掉 6 条搬完就死的 import。变异 **M169–M174**（把自己头像改回 `selfWxid \|\| curSession.username` —— 就是当年那条事故形状 / 群成员键换成昵称 / 居中行清单漏 `pat` / 已编辑写死 false / 图组退成单条正文 / **把工厂从钩子里摘掉**打接线判据），逐条 `--only` 全咬红、逐字节还原。⑥ 收尾撞到的**假红一条**：`atomic-json.spec.ts` 的「跨进程观察中间态」在全量并跑里红过一次，单独复跑 33/33 绿 ⇒ 按既定的有条件重跑政策处理（只重跑一次、在此留记录，不改判据也不放宽）。全量终态 **309 文件 / 3237 用例**、`build:ui` 通过、client typecheck 0 错。 |

| 第三批 #19 第三步：日历那一族拆出面板 | ✅ 完成（面板 550 → **486**） | 本次提交 | 第三刀切 `ChatsPanel` 里的**消息日历**（A8）：四个 `useState` + 六个派生值 + `openCalendar`/`switchCalMonth`/`jumpToDay`，共 68 行，收进 `panels/chats-calendar.ts`（纯函数 `deriveCalendar`/`calHeatOf` + 钩子 `useChatsCalendar`）。选它的理由：这一族**每个数字都是画错了也没人报**的算术 —— 首行空格要按周一起排（1 号是周日时挪满 6 格）、当月天数含闰年 2 月、**日均的分母是活跃天数而不是整月天数**、并列最活跃取先见到的那个、热力色到 140 条封顶在 0.85。原先一条用例都没有，而日历是点开才看见的弹窗。① **行为判据** `chats-calendar.spec.ts` 19 条：纯函数用表格钉边界（含 `{'1':10}` 日均必须是 10 而不是 0、`{x:99}` 这种非数字键不进「最活跃」但仍进总量、2028-02 是 29 天），钩子只数 RPC 与看 setter 收到什么（跨年前后翻月、无会话不发请求、失败要把错误写出去且 loading 收尾）。② **搬的时候第一次给这条规则留下证据**：翻月**在飞期间网格必须是空的** —— 若留着上个月的计数，那 100~500ms 里界面是「用旧月的颜色画新月的标题」，看着像数据其实是隔壁月的。这条改前就是对的（原代码先 `setCalCounts({})` 再发请求），但没有用例说过它是有意的，下一次"优化成等数据回来再一次性换掉"的顺手改动就会把它抹掉。夹具用延迟 promise 把"在飞"这一态真的造出来（第一版在 RPC 里读快照是读不到的 —— React 还没提交）。③ **接线判据** `chats-calendar.wiring.spec.ts` 6 条：面板真挂着 `useChatsCalendar(`、旧形状五件指纹（`Object.entries(calCounts)`、`new Date(calYear, calMonth, 0)`、`Math.min(0.15`…）不许长回面板、模块里五个标记必须齐全（**防「两边都没有」**——只断"面板里没有"的话，把代码删了也算重构成功）、两张清单非空、空读哨兵、合成违例自证。④ 又一次踩到并写进注释的那条约束：**钩子必须调用在 `openSessionAndLocate` 之后**（`useChatsThread` 那一行下面）—— 面板里那一段原本是就地闭包，换成参数就撞 TDZ；这也是 `jumpToDay` 的依赖数组里那个多余 `calOpen` 的处理位置（函数体读的是 `setCalOpen`，多余依赖只会让回调每次开关都换身份）。⑤ 棘轮记账：`ChatsPanel` 555 → 550 → **486**（三步各自实测回填）；`calOpen` 刻意**留在** `useChatsMsgSearch` 里（那几个弹窗互相排他，搬走就把「谁开着什么」拆成两处真相），故新钩子的返回类型里没有它。变异 **M175–M181**（周日不挪格 / 天数算成上个月 / 日均分母换成键数 / 并列取后者 / 热力封顶抬到 1.0 / 在飞不清空 / **把钩子从面板上摘掉**），逐条 `--only` 全咬红、逐字节还原。全量终态 **311 文件 / 3262 用例**、client typecheck 0 错、`build:ui` 通过。**#19 剩下**：`chats-view.tsx#ChatsView` 752 行（纯 JSX 的竖向切片：日历弹窗、群信息抽屉、导出弹窗、右键菜单）与那个 150 字段的 `state` 袋。 |

| 第三批 #20 第一步：隐私闸拆成 GatewayCore 的协作者 | 🟡 **第一个协作者做完**（LLM 工厂 / 调度未动） | 本次提交 | 报告 §P2-2 说 `GatewayCore` 是 god-object（实测 986 行、`@Remote` 装配 + 判断 + 调度混在一起），给的方向是「LLM 工厂 / 隐私闸 / 调度各成协作者（**组合而非继承**）」。第一刀切**隐私闸**：`outboundBlocked` / `privacyBlocked` / `privacyGate` 三处接缝（78 行）搬进 `gateway-privacy.ts`，类里留同样签名的 `protected` 薄委托 ⇒ **十几个子类与 remotes 一行都不用改**（这是"组合"这一步里风险最低的一半）。① **先跑报告要求的那个探针**（§风险表点名：「拆出协作者后 172 个 `@Remote` 是否仍被发现」）：`npm run docs:api` 前后都是 **172 个 Remote 方法**、`gateway-remote-surface.spec.ts` 全绿 ⇒ 协议面没被动到。② **判据** `tests/gateway-privacy-gate.spec.ts` 13 条：这次不是"给搬走的代码补测"，而是**第一次能把判断本身四态各喂一次** —— 开关开 / 关 / 库读不动 / **两次读之间坏掉（竞态）**；改前那些 catch 住在 986 行的类里，要断就得起整个网关（本仓既有覆盖正是那个级别，`outbound-gates.spec.ts`）。逐条钉住的方向：`outboundBlockedAt` 读不到 ⇒ **true**（拦），`privacyBlockedAt` 读不到 ⇒ 给"读不到所以拦下"的专门文案而不是 null，竞态那次失败 ⇒ 不许按"没开脱敏"继续发原文，开了脱敏 ⇒ 发出去的是副本**且审计记的也是副本字符数**，被拦 ⇒ **一条审计都不记**。再加一条**唯一出处**扫描：除该模块与 settings 自己的读写处，谁都不许再直接 `readPrivacySettings(`（否则下一个人就地再读一次开关，就回到"同一个开关三处各自解释"，第 59 轮那批漏闸正是这么来的）。③ **既有守卫接住这次搬家**：`privacy-gate-direction.spec.ts`（AST 查三处接缝的 catch 方向）当场红在「`outboundBlocked` 里没有 catch 子句」—— 因为 catch 跟着判断搬走了。改法是**扩大覆盖面**而不是缩小：那份扫描现在读「类 + 协作者模块」，接缝名 (`outboundBlocked`/`privacyBlocked`/`privacyGate`) 仍必须在类里存在（包装被删掉也算坏），函数声明与 `<接缝>At` 两种名字都认，`catches` 与违例两说。④ 顺手清掉三条**搬完就死的 import**（`dirs.ts`、`query/privacy-audit.ts` 的部分名字、`wechat-tasks.ts`）—— typecheck 0 错证明它们在本文件里确实没人用；这正是 §P2-3 记过的「导入了但不用」那个成因形状，本次是它自己长出来的残留。⑤ `gateway-core.ts` 986 → **941 行**（1000 行硬棘轮的余量从 14 涨到 59）。变异 **M182–M187**（catch 改放行 / 文案版改返回 null / 脱敏不作用 / 审计记原文长度 / 不记审计 / 竞态按默认放行），逐条 `--only` 全咬红、逐字节还原。**没做完的部分**：LLM 工厂那一族（`makeEmbedFn`/`makeChatAsker`/`makeRerankFn`/`kbModel`/`embedModelName`/`globalModelName`，约 150 行）与调度那一族（`_streamJobs`/`streamControl`/`finishStreamJob`/`_schedBusy`）仍在类里；14 个 `*Remotes()` 懒装配 accessor 也还占着文件后半 —— 那部分是纯装配，报告说「只保留 `_ctx/_dirs` 与装配」，所以留着是对的，要动的是前面两族。 |

| 新守卫：变异登记表的锚点不许腐烂 | ✅ 完成（并**当场验证 184 条全命中一次**） | 本次提交 | 补一条纪律层的机检，起因是这一轮搬家时又撞见同类问题：`privacy-gate-direction.spec.ts` 靠"方法名 + catch 子句"定位接缝，实现一搬就走。而**登记表本身**更严重 —— 本仓已有三次「改了代码 ⇒ 某条早就登记的变异锚点悄悄失配」（M63/M64 因 `cachedBySig`→`cachedBySigAsync` 改名、M54 因写入侧改动、M124 因空白差异），三次都不是人眼发现的，是有人手动跑了**全表**才报出「锚点失效 / 未执行」。全表一次两百多次 vitest，事实上没人每轮都跑 ⇒ 「这条守卫到底会不会咬」这个事实在两轮之间**没人守着**：锚点失配 = 那条反证静默失效 = 下一轮以为还防着（比从没写过反证更坏）。**判据** `src/backend/tests/mutation-registry-anchors.spec.ts` 6 条：每条的 `from` 必须在目标文件里**恰好命中一次**（0 次 ⇒ 腐烂；≥2 次 ⇒ 跑手无法确定改哪一处）；`from` 不得等于 `to`（改了等于没改）；`spec` 文件必须还在（否则红被记到不存在的文件上，表看上去全绿其实什么都没跑）；`file` 必须还在；id 不得重复（重号会让 `--only` 与结果账本错位）；每条字段非空 —— 但 **`to` 允许为空**（实测有七条是「把这段删掉」型变异，第一版把这条判成缺陷，是自己口径写窄了）。防空转的老规矩照配：表长度 >150 的哨兵、id 数与行数对齐，外加**反例自证**——同一 `anchorDefects()` 喂五种坏法（腐烂/不唯一/noop/判据不存在/目标不存在），逐类必须分得出来。**踩到的两条**：① 命中数的口径必须与跑手 `mutation-check.mjs#locate` **完全一致**（先按 LF 找、找不到再按 CRLF 找）—— 第一版只按 LF 数，于是把 `voicellm.ts`/`storage.ts` 那几条**本来能命中**的锚点报成腐烂（工具记忆里那条 CRLF 陷阱在判据侧的镜像）；② 自指：判据里如果把样例锚点写成字面量，**那段字面量就存在于本文件里**，于是"命中一次"的对照条目自己判成不唯一、"全仓不存在"的腐烂样例自己判成命中一次 —— 五条样例里有四条得用拼接构造。为让 TS 侧读这份 `.mjs` 表，补了 `scripts/mutations-registry.d.mts`（只写形状）：测试树没开 `allowJs`，静态与动态导入都会报 TS7016；声明与数据对不对，由「每条字段非空」那条运行时断言兜住 ⇒ 声明写错不会让守卫静默变宽。变异 **M188–M190**（「命中 0 次」那格写不成 / from==to 那格写死 / 不再检查判据文件存在），逐条全咬红。**这一条的价值当场就兑现了**：首跑就对出三条"缺陷"，核对后确认其中真值得修的是口径（CRLF）而不是登记表。 |

| 第三批 #20 第二步：模型名解析拆成第二个协作者 | 🟡 两刀 done（LLM 工厂 / 调度族未动） | 本次提交 | 第二个协作者 = **模型名解析**（`embedModelName` / `globalModelName` / `kbModel`），搬进 `gateway-models.ts`，类里同样只留 `protected` 薄委托 ⇒ 子类与 remotes 零改动。**为什么这一族值得第二刀**：它守的是报告里点名的 §7 F1 —— 实错不是"解析写错"，而是**同一个优先级被两处各算一遍**（网关这边记 `'default'`、宿主那边发 `llm.json` 的值），于是"换没换嵌入模型"的判定永远不触发重建、旧向量被当成新模型的用。判断住在 986 行的类里时，要测它就得起整个网关，所以这条红线以前**只有一句注释**在守。① **判据** `tests/gateway-model-resolution.spec.ts` 15 条（假桥逐格喂，不需要 electron）：记账名必须把收到的 override 原样交回桥、桥回答 null/undefined ⇒ **空串**而不是字面量 `'null'`、桥缺席（测试桩）才退回 override、embed 的 override 取自检索配置、rerank 优先桥再退 config、**选择器明确回空串时不再退 config（`??` 与 `||` 的差就钉在这）**、三个角色各读各的库级引用字段（串位=覆盖悄悄失效）、`m:` 空名字仍算继承但原始引用串要留给界面回填、**每次调用都重读**（缓存住就会让库级覆盖比全局还难改）。`resolveModelRef` **用真的**（只 mock 读库那一步）—— 把组合律本身 mock 掉就只剩"函数被调用了"这种空断言。② **唯一出处守卫** `tests/model-name-single-source.spec.ts`：全树扫（剥注释）除该模块外谁都不许直接调桥的 `embeddingModelName(` / `rerankModelName(` —— 这是 §7 F1 的**形态学**版本：只要还允许就地问桥，下一个加 AI 功能的人就会再复制一份那条链。实测现仓零违例（`remotes/askdeep.ts` 走的是包装，口径要分得开这两种写法，反例自证就专门验这一对）。③ 探针再跑一次：`docs:api` 仍是 **172 个 Remote 方法**、`gateway-remote-surface.spec.ts` 全绿。④ `gateway-core.ts` 941 → **917 行**（本轮第一刀 986 → 941），并剪掉一条搬完就死的 `loadRetrievalConfig` import。变异 **M191–M197**（不把 override 交回桥 / null 不再回落 / 忽略检索配置 / rerank 跳过桥 / `??` 换成 `||` / 三角色引用串位 / **把委托拆成自己回空串**——最后一条打唯一出处守卫），逐条全咬红、逐字节还原。**登记表锚点守卫当场兑现价值**：它在这轮登记完 7 条后立刻逐条核对全部 **194** 条，全部恰好命中一次。⑤ **两条自己踩的**：往表里写 `why` 时用了裸双引号 ⇒ 文件加载不了（`node -e import` 是唯一能看见这错的地方，已顺手用 `「」` 或单引号统一）；反例自证的样例锚点若写成字面量，而判据扫的又是**另一棵树**，"抓住违例"那一步会恒过 —— 改成把两条样本喂给同一段 `includes` 口径。**剩下的**：LLM 工厂族（`makeEmbedFn`/`makeChatAsker`/`makeRerankFn`，它们要同时吃隐私闸 + 模型解析，正好是"组合"能显出价值的地方）与调度族（`_streamJobs`/`streamControl`/`finishStreamJob`）仍在类里。 |

| 第三批 #20 第三步：LLM 工厂拆成第三个协作者 + #20 装配面守卫 | 🟡 三族 done（调度族与 14 个装配 accessor 未动） | 本次提交 | 第三个协作者 = **LLM 工厂**（`makeEmbedFn` / `makeChatAsker` / `makeRerankFn`）→ `gateway-llm-factory.ts`，依赖显式注入（桥 + 前两个协作者的入口），类里留 `private llmFactoryDeps()` 现凑一份依赖袋 —— **不缓存**：`_dirs.decrypted` 会随换数据根变，缓存这份对象就等于让隐私闸指向**上一个**数据根的库（读到旧设置 = 按旧的同意范围发新数据）。这一步才是"组合而非继承"真正想换来的东西：三条出站纪律原先要验就得**起一个真网关**，现在假桥 + 假闸门即可，`gateway-llm-factory.spec.ts` **一个 `vi.mock` 都没有**。① **判据 16 条**逐条钉住：发出去的是**闸门返回的副本**而不是原文（开了脱敏却没生效就长这样）、空模型名不许带 `{model:''}` 出去、功能名三种 `*_embed` 原样透传（写死一个 ⇒ 用户只对其中一类给过同意也分不出来）、**拦截判在过闸之前**（那条用例钉的是"闸门都没走到"：早退文案会把「拦截生效了」盖掉）、模型名读的是**本库该用的那个角色**、精排**整批一起过闸**（只 gate 查询词 = N 条正文裸发出去而审计记成「已脱敏」）、被拦/被拒一律抛出不吞。② **新守卫** `gateway-collaborators.spec.ts`（#20 的装配面）：三个模块各自声明了约定的入口、类里九个委托标记都在、七枚"只有实现里才有"的指纹不许长回类里，配空读哨兵与合成违例自证。③ **这条守卫当场抓出一条真漏洞**：`gateway-source.ts` 的 `gatewaySource()`（"实现搬到哪儿都算"那份联合）此前只含类 + `remotes/**`，三族搬出去之后**读它的守卫静默失去靶子** —— `privacy-statement.spec.ts` 的 H14（精排两条硬纪律）是撞上去才红的。改法是把 `gateway-*.ts` 用 readdir 全收进联合（**不是**再手写一份文件名清单：手写清单必然漏，这次漏的就是它），并加一条哨兵钉"联合必须真含这三个模块的声明"。H14 也随之改成"两处都找、认那段真过闸的实现，找不到就红"——委托本身不再被当成"接线还在"的证据。④ **一次口径纠正**：指纹判据先写成 `new \w+\(` / `resolve\w+\(` 这种形状匹配，结果现仓的类里有合法的 `new`/`resolve*` 调用 ⇒ 判据恒红；只能按具体 token 写，代价（漏掉没列进清单的实现）写在判据注释里。⑤ 又清掉两条**搬完就死的 import**（`readKbModelSettings`、`resolveModelRef`）——它们藏在**多行 import 块**里，而搬运脚本按行匹配 `^import` 去判"这个名字还有人用吗"，于是永远剪不掉；包的 tsconfig 又没开 `noUnusedLocals` ⇒ typecheck 也不报，靠 `grep` 才发现。⑥ `gateway-core.ts` 986 → 941 → 917 → **864 行**；探针第三次照跑：`docs:api` 仍是 **172 个 Remote 方法**。变异 **M198–M203**（把原文交给桥 / 空 model 也带出去 / 去掉出网前的早判 / 忽略库级模型名 / 精排只 gate 查询词 / **把工厂委托摘成恒返回 undefined** 打装配守卫），逐条全咬红、逐字节还原；登记表涨到 **200 条**，锚点守卫逐条核对全部恰好命中一次。**#20 剩下的**：调度族（`_streamJobs`/`streamControl`/`finishStreamJob`/`_schedBusy`/`recoverInterrupted`）与后半 14 个 `*Remotes()` 懒装配 accessor —— 后者按报告口径本就该留在类里（「只保留 `_ctx/_dirs` 与装配」）。 |

| 第三批 #20 第四步：长任务槽位拆成第四个协作者 | 🟡 **报告点名的三族全拆完**（调度里剩下的忙闲标志与 14 个装配 accessor 按口径留在类里） | 本次提交 | 第四个协作者 = **长任务槽位**（`streamControl` / `finishStreamJob`）→ `gateway-jobs.ts`。这一族每条规则错的后果都是"某一次操作诡异地失败"而不是任何报错：复用槽时留着上一轮的 `finished`/`error` ⇒ 新一轮还没跑，进度查询就答复"已完成/用户取消"；复用那把**已经 abort 的** AbortController ⇒ 导出刚起步就抛「已取消」（注释里写着这是真踩过的）；到上限时把**正在复用的**那个槽挤掉 ⇒ 进度与取消令牌一起丢。**那张槽表仍由类持有**并原样交给 remotes —— 协作者只操作传进来的表，不另起一份状态，否则会有两个"进度视图"。① **判据** `tests/gateway-jobs.spec.ts` 11 条：空白/非字符串 jobId ⇒ 空控制（旧调用方行为不变，且不占槽）；键是规整后的那个（trim + 截 64，带空白的同一个 id 复用同一个槽）；每次调用换新且**未取消**的令牌（用例真把第一轮 abort 掉再取第二轮）；复用时擦掉 progress/finished/error；`onProgress` 同时写槽 + 发带 jobId 的事件；**事件发不出去不影响任务**（IPC 抛错时槽里仍有进度）；到上限淘汰最早那个；**复用已存在的 id 时一个都不淘汰**；未知 jobId 收尾静默返回；收尾后槽位留着不删（迟到的 `getExportProgress` 要能读到终态）。② 装配守卫同步到四个协作者：十一个委托标记 + 三枚新实现指纹（`keys().next()`、`this._streamJobs.set(`、`delete job.error`）。**其中一枚差点写错**：本想用 `new AbortController()` 当指纹，但类里**另有合法的**一处（搜索任务的取消令牌）⇒ 命中会假红；换成只属于这一族的形状。**这正是"实现指纹"的固有代价**：清单窄就漏、宽就假红，所以注释里写着"新搬一族时要往这里加一条"。③ 又一处类型口径：`ctx.emit` 的第一参数是 `keyof Events`，模块里拿 `string` 调它类型不成立 ⇒ 事件名留在装配那一侧，协作者只接 `(detail) => void` 的注入 —— 这不是妥协，事件名本来就属于装配。④ `gateway-core.ts` 864 → **840 行**（986 → 941 → 917 → 864 → 840）；探针第四次照跑：`docs:api` 仍是 **172 个 Remote 方法**。变异 **M204–M208**（沿用上一轮的令牌 / 不清终态 / 进度只发事件不写槽 / 复用时也淘汰 / **把委托摘成恒返回空控制**），逐条全咬红、逐字节还原；登记表 **205 条**，锚点守卫逐条核对全部恰好命中一次。**#20 剩下的**：`_schedBusy` 那个忙闲标志（4 处读写，是装配态不是判断）与后半 14 个 `*Remotes()` 懒装配 accessor —— 报告口径本就是「`GatewayCore` 只保留 `_ctx/_dirs` 与装配」，这两样都属于装配。 |

| 新守卫：幻影引用（§七 第四批 #25 的前置那条） | ✅ 完成，并**当场清掉 9 处** | 本次提交 | §六 记过一条复发现象：注释写着「这条由 X 把关」而 X 不存在，本轮之前已数到四次（`scripts/check-ui-consistency.js`、`audit-a11y-clickable`、`scripts/check-members-search.js`、以及下面新抓的那些）。共同点不是写错文件名，而是**注释替代码许了一个代码没兑现的诺** —— 读代码的人以为防住了，就不再补判据。`src/backend/tests/phantom-reference.spec.ts` 把这件事变成机检：扫手写源码的注释（`src/backend` + `src/client`，排除 vendored `src/backend/deps/**`、生成物 `**/lib/**` 与 `.d.ts`），带 `#符号` 的还要求符号真在被指文件里；本文件排除在外（它**必须**写下那些幻影名字作为记录，且反例自证的样例是字符串字面量 —— 两个理由都写在注释里）。① **口径只能窄**：第一版扫全部注释里的路径样 token，扫出 **100+ 条**，真幻影只有几条，其余全是样例名、被删文件的回顾、glob 模式说明 —— 那种信噪比的闸门活不过第二天，而"被关闭的守卫"比没有守卫更糟（它给出已经管过的错觉）。终版只在**承诺语境**里查：路径前后各 40 字内出现承诺词（由/见/判据/守卫/把关/守/锁定/钉）才算许愿，另设三格豁免（历史记录词、占位名、外部包路径）。② **抓到 9 处真东西**（逐条改了，不是登记成例外）：`docs/wechat-schema.md §B.16/§B.19`（那份勘查笔记不存在，被两处面板注释当作出处）、`docs/ui-audit.md`（旧审计文档，已改指 `format-single-source.spec.ts` 那张台账）、`working/…`/`output/…` 里四篇一次性真机探针与快照（`working/`、`output/` 本就不入库 ⇒ 指过去等于没人能核对；改成把结论抄在原地并写明"脚本不入库、那一半不可复跑"）、两处**写错的用例名**（`sync-publish.spec.ts` → 实际守 `atomicReplace` 的是 `sync-wal.spec.ts`；`physics.spec.ts` → `graph-physics.spec.ts`）、一处 `privacy-consent-ssr.tsx`（没有这个 SSR 用例，真判据是 `consent.spec.ts` 含「ui-entry 真的渲染本组件」那条）。③ **一格豁免差点是死代码**：`M210`（把占位名豁免写死）第一次跑**没咬住** —— 占位名的样例本来就被"外部包路径"那一格先豁免掉了，那一格根本不执行；按「别留着不会走的分支」的旧教训，把自证 ⑤ 换成**带仓库根前缀**的占位样例（`src/client/tests/xxx.spec.ts`）让这格真正承重，改完 M210 才咬红。④ 写这份判据时自己踩的两个坑都记在注释里：文档注释里出现 `**/x.spec.ts`、`deps/*/lib` 这种串会**提前闭合块注释**（同一轮踩两次，都是 esbuild 的 Transform failed 报出来的，而报的是"找不到 ;"，看不出原因）；后缀交替式里 `js` 排在 `json` 前面会把 `tsconfig.tests.json` 截成 `.js` ⇒ 报两条假幻影，补了 `(?![\w])` 边界。⑤ 变异 **M209–M212**（关掉历史豁免 / 关掉占位名豁免 / 关掉外部包豁免 / 去掉"按结尾匹配"的解析），每条都必须咬红 —— 前三条证明豁免不是随手放宽，第四条证明那条解析是承重的。⑥ 全量 `319 文件 / 3337 用例` 绿、typecheck 5 棵树 0、`docs:api` 仍是 172 个方法（本轮只动注释与 .d.ts 重生成）。**没做的一部分**：`docs/**` 里同类引用的清单（早前测得 64 个不可解析标记，多数是解析口径造成的）—— 文档体量大、误报率更高，先不纳零容忍；要纳的话照本条同一套「承诺语境 + 豁免」形状做。 |
| 第三批 #19 第四步：导出弹窗拆出渲染树 | ✅ 完成（`ChatsView` 752 → **639** 行，`chats-view.tsx` 953 → 842 行） | 本次提交 | 第四刀切的是**「导出消息」那一屏**（`chats-export-dialog.tsx`，186 行）。为什么是它而不是更大的块：它是本面板里唯一一处「用户填了半天、一个动作全丢」的地方，而它的全部规矩原先**一条用例都没有**（只有一份 `chats-export-hook.spec.ts` 管数据那一半）—— 遮罩点击要判 `e.target === e.currentTarget`、一个类型都没选=**全部**（不是 0 类）、`expCount` 的 `0` 那格代表「全部」、`total<=0` 只能是不确定态、导出中必须锁主按钮并给「中止」。四件套：① 18 条行为用例（jsdom 真挂载真点）；② 8 条接线判据（`chats-export-dialog.wiring.spec.ts`：旧形状不许长回渲染树 + 新模块八件齐全 + 调用点仍从 `state` 袋取时间/类型/进度）；③ 变异 **M213–M221** 九条，逐条咬红并逐字节还原；④ 顺手把这一族带出来的三件小事收干净 —— 8 个**死 import**（`DateRangeField`/`ProgressBar`/六个图标，搬完 JSX 后没人用而 `package.json` 那颗 tsconfig 没开 `noUnusedLocals` ⇒ 静默）、`'txt' \| 'html' \| …` 那串字面量联合从三处收成一份出处（`ExpFormat`，并立判据「只许出现一次」= M221）、三处过期数字声明（「面板剩 ~1600 行」「调用点是 155 行道具字面量」—— 前者 610 行、后者早已收成 `state={viewState}`）。**两条本机口径记进 memory**：jsdom 里 React 对复选框听的是 `click` 不是 `change`（派发 `change` 得到一次静默空点）；改受控 `<input>` 必须走 `HTMLInputElement.prototype` 的 value setter，直写 `el.value` 会被 React 的 value tracker 判成「值没变」而吞掉 `input` 事件。**一条变异是等价变异、换了靶子**：M217 原本注入「百分比不封顶」，跑完全绿 —— 因为 `ProgressBar` 内部自己 `Math.max(0, Math.min(100, value))`，封顶那一半根本不承重；换成「比值算反 `total/done`」才咬到 `aria-valuenow=25` 那条。**两条旧守卫因搬家失去靶子，当场改指**：`m3-export-progress.wiring.spec.ts` 的「进度条按 done/total 显示」改成同时认 `pctOf` 里的算式（比值可以住在小函数里，但必须是同一个对象的 done/total），「总量未知走不定量态」从死读 `chats-view.tsx` 改成读 `readChatsSource()` 联合 —— 这正是 `chats-source.ts` 注释里预言过的那类静默失靶。全量 **321 文件 / 3362 用例** 绿、typecheck 5 棵树 0、`build:ui` 通过；本轮没动后端 `src` ⇒ `lib/` 与 `docs/API.md` 无变化。 |
| 第三批 #19 第五步：群聊信息抽屉拆出渲染树 + 成员算术收成纯函数 | ✅ 完成（`ChatsView` 639 → **538** 行，`chats-view.tsx` 842 → 742 行），**并当场修掉两个真 bug** | 本次提交 | 第五刀切的是群聊信息抽屉（整块 110 行、整族零用例）。拆法与日历那一族一样是"两层"：JSX 进 `chats-group-info-view.tsx`，算术进 `chats-member-view.ts`（七个导出口：`memberQueryOf` / `filterMembers` / `memberLimitOf` / `hasMoreMembers` / `memberMoreLabel` / `showsAddTile` / `profileAnchor`），钩子只留状态与副作用。**① 第一个 bug（搜索态「展开更多匹配」收不回来）**：旧写法在搜索态比的是 `filteredMembers.length > memberLimit`，而 `memberLimit` 展开后从 24 涨到 200 ⇒ 命中 100 位时点下去按钮整颗消失，用户**退不回折叠态**（非搜索态一直比总数，没这个洞 —— 不对称才是它的成因）。修法是把"还有没有更多"收进 `hasMoreMembers`，两种模式一律跟折叠门槛比，函数签名里**故意不接受 `expanded`**（接受了这个 bug 就能长回来）。**② 第二个 bug 是真读代码读出来的**：`openGroupInfo` 的 `catch` 原先只 `setGroupInfoErr(...)` 而不清 `groupInfo`，而 `groupInfo` 是**上一次成功那个群**的快照 ⇒ 在 B 群点开抽屉、请求失败，界面会在错误文案下面挂着 A 群的成员与群名（消息流那边早就有「归属不符只给骨架」的同一条规矩）。两侧都断：源头 catch 里 `setGroupInfo(null)`，抽屉侧 `!groupInfoErr && groupInfo`；抽屉那条形成为例，源头那条只有文本判据 + M235。**③ 那颗「＋ 添加」是故意的死控件**（L13：本应用只读本机库、没有邀请通道，保留只为布局保真）：它必须**不是 `<button>`**、不挂 `onClick`、带 `aria-disabled="true"`，这种"看着像 bug 的设计"最需要用例钉着 —— 一条行为用例证它点不动且不改任何状态，一条文本判据证它没长成 button，M232 把 `aria-disabled` 改成 false 必须咬红。**④ 四件套**：11 条算术用例 + 22 条抽屉行为用例 + 9 条接线判据（含"钩子里不许再留旧算术"那一组）+ 变异 **M222–M235** 十四条逐条咬红、逐字节还原。**⑤ 棘轮的两种改法**：`useChatsThread` 因为我在 catch 前加了两行注释而 269 → 271 报"长大" —— 棘轮只许变小，而**把注释删掉是错的方向**（那条 why 正是下一轮判断的依据），改成把说明压成同一行尾注释、长理由挪到抽屉模块与守卫注释里 ⇒ 函数回到 269、理由一个字没少。**⑥ jsdom 第三条口径**：React 不监听原生 `mouseenter`/`mouseleave`，它把这两个合成在冒泡的 `mouseover`/`mouseout` 上并按 `relatedTarget` 判进出 ⇒ 按原名派发得到 0 次调用（看起来像"组件没接线"），换成派发 over/out + `relatedTarget: document.body` 才对，已并入 memory 第 68 条。全量 **324 文件 / 3405 用例** 绿、typecheck 5 棵树 0、`build:ui` 通过；未动后端 `src` ⇒ `lib/` 与 `docs/API.md` 无变化。 |
| 第三批 #19 第六步：聊天记录查看器拆出渲染树（栈式抽屉 + 出网纪律接线） | ✅ 完成（`ChatsView` 538 → **481** 行，`chats-view.tsx` 742 → 686 行） | 本次提交 | 第六刀切的是「聊天记录」嵌套卡片查看器（64 行、整族零用例）。三份新文件：`chats-chatlog.ts`（一条记录怎么读成一行：`chatlogKindOf` / `chatlogLinkOf` / `chatlogNestedCount` / `chatlogFallbackChar` / `chatlogNestedLabel` / `chatlogBodyOf` + 栈帧形状 `ChatlogFrame`）、`chats-chatlog-dialog.tsx`（栈式抽屉）、两份判据（9 + 14 条用例与 9 条接线判据）。**① 抽屉的 DOM 名字是承重的**：`chats-msg-search.tsx` 里 `useDialogFocus(chatlogStack.length > 0, '[data-st-dialog="chats-chatlog"]')` 按字符串找焦点宿主 —— 搬动时改掉这个名字不会有任何编译错误，只会让抽屉打开时焦点还留在后面的消息流上（键盘用户）。所以接线判据把**两处字符串一起钉**（找的那头与挂的那头必须一字不差）。**② 出网纪律**：内层记录的 `<sourceheadurl>` 是**未校验的原始地址**（实测 360 条里 193 条是 http），只能交给 `RemoteImg` 走后端代理；判据三条（import 在、`<RemoteImg src={r.head` 在、整个模块不许出现 `<img` 与 `apiGetRemoteImageUrl`），变异 M247 把地址交空串必须咬红 —— 那正是"看起来只是头像没了"的静默降级。**③ 语音时长与视频时长的单位不一样**（语音是 20 毫秒一格、视频是毫秒），`chatlogBodyOf` 里两个除数各占一行并写明理由；M238 把语音按毫秒除 ⇒ 5 秒写成 0 秒，用例当场红。这是"改错不会报错、只会看到假数字"的那一类。**④ 栈式退路**：`depth > 1` 才给「返回上一级」，「关闭」与点遮罩都是**清整个栈**（只弹一层的话下次打开会莫名落在三层深里）；三条各配一条变异（M241/M242/M243）。**⑤ `ChatlogFrame` 收成一份出处**：这个形状原先在 6 个文件的 8 处字面量里各写一遍（`Array<{ title: string; records: ChatlogRecord[] }>`），加字段时必然漏改一处 ⇒ 全部改指 `ChatlogFrame`，判据是「联合里 `title: string; records:` 出现 0 次」+ M249 抄回字面量必咬红。**⑥ 顺带撞出来的闸门**：登记变异这件事本身把 `mutations-registry.batch3.mjs` 顶到 **1073 行**，穿破「单文件 1000 行」硬棘轮 ⇒ 按 `mutations-registry.mjs` 文件头早就写明的办法处理（"表再涨到上限时切一个文件由这里聚合，不要靠放宽闸门解决"），M222 起切出 `batch3b.mjs`，主表聚合三份（114 + 104 + 28 = 246 条），并把"分界点是闸门容量决定的、不是批次决定的"写回文件头。**⑦ 命名教训**：一度把纯函数模块与组件模块起成同名不同扩展（`chats-chatlog-view.ts` / `.tsx`），两份 `chats-chatlog-view*.spec.ts` 立刻分不清谁测谁 ⇒ 改成 `chats-chatlog.ts` + `chats-chatlog-dialog.tsx`（与 `chats-export.tsx` / `chats-export-dialog.tsx` 同一套命名）。全量 **327 文件 / 3437 用例** 绿、typecheck 5 棵树 0、`build:ui` 通过、`docs:api` 仍是 172 个方法。 |
| 第四批（合批）P3-11 / P3-14 / P3-15 / P3-6 | ✅ 四条做完，其中 **P3-6 纠正报告一处并列**、P3-14 的修法与报告不同 | 本次提交 | §七 说第四批"建议与相邻功能改动合批"，这一轮就是合批（跟着 #19 第六刀之后剩下的余量做）。**P3-11（whisper 解压兜底的 PowerShell 串）**：报告写的是"字符串插值，改参数化/转义"。读下来根因是 `powershell.exe -Command <一段脚本>` 拿到的是**脚本**不是 argv ⇒ 路径里一个撇号（`C:\Users\O'Brien\…` 是真实形状）就提前终结那个单引号字面量，后面的内容变成要执行的代码；而 `tar.exe` 那一路走参数数组不过 shell ⇒ 全仓只有这一处需要转义。修法照抄本仓 vendored `dsh-native-command` 里 `powershellLiteral` 的口径（单引号内唯一的转义规则就是把 `'` 翻倍），并加两道闸：① 行为用例按 PowerShell 引号规则**扫一遍命令文本**算出"代码区"，证明注入的 `Format-Volume` 落在字面量内（只断字符串相等的话，下次换一种拼法还可能绿着）；② `powershell-quoting.spec.ts` 全仓扫 `-Command`，任何插值没经过 `powershellLiteral` 就红 —— 这条要在**下一处**有人拼这种串时才值钱。另把 `extractZip` 导出（否则那条命令拼出来的东西不可测）。**P3-14（图谱统计条每渲染扫 7 遍）**：报告的数字是 6、实测 7；报告给的方"合并为单次 reduce + useMemo"**没照做** —— `GraphPanel` 728 行登记在"单函数只许变小"的棘轮上，为一次合并往它身上再加两行是反方向的，而"每种节点多少个"本来就是这张图的属性 ⇒ 计数搬到 `BuiltGraph.kindCounts`（跟着图构建算一次），组件那边只读、一行都不加（`GraphPanel` 因此 728 → 726）。判据两道：文本面"构造处必须都带 `kindCounts`"+"组件不再自己数"；**行为面**用真夹具跑 `buildGraph` / `localGraph`，断言计数与结果节点数组自洽 —— 因为文本判据只能证明"写了这个键"，证明不了"带的是自己那份"（M255 就是那个空壳变异）。**P3-15（`css-cascade.ts` 单字母名）**：把报告点名的密集处（`lineOf`/`startLine`/`walk`/`makeFind`/`commentLines`/`normDecl`/簇分桶）换成语义名，32 条既有用例全绿证明行为未变；剩下的一处没扫干净的东西按本仓惯例装成**只许变小的棘轮**（实测基线 52 处），并当场验过它咬人（注入一处 `const q = 1` ⇒ 53 红，之后逐字节还原、sha256 对得上）。**P3-6（同概念三名）—— 这条报告说错了一半**：实测 `MomentEntry.author` **不是**第三个名字，它是「备注 → 昵称 → ID 逐级回退」的**显示名**（`query/moments.ts:424`），真正与 `username` 同概念的是 `talker`（问答链，沿用 SQLite 列名）与 `authorUsername`（朋友圈过滤参数）；把显示名当 ID 去 join 会话是查不到的，所以类型层的注释按实测写（正主 `WechatSession.username` 一处说清三名 + `author` 的差别），并配一条守卫要求**每个 `talker` 声明处都指回正主**（9 处全覆盖，漏一处当场红；反例自证是把注释删掉必须红）。四道变异 M250–M255 逐条咬红。顺带把登记表撞破的 1000 行闸门按主表文件头写明的办法切了 `batch3b`（不放宽闸门）。全量 **331 文件 / 3463 用例** 绿、typecheck 5 棵树 0、`build:backend`/`build:types`/`build:ui`/`docs:api`(172) 全过；本轮动了后端 `src` ⇒ `lib/index.js` 与 `lib/types/**` 一起提交。 |

### 剩余（按 §七 的批次，未在本轮）

- 第一批：**已全部做完**（#1–#8）。
- 第二批 #10 xlsx 换源（需授权）、#11 剩下的「取消」：`@Remote` 的取消元数据只活在不可复现的
  生成物里（见上面 ②），要先接上生成链才能给这五个查询注入 `AbortSignal`；让出一半已完成。
- **关于 #11（P1-2）的两条实施前提**（本轮读代码 + 读生成物确认，别再当「加个 signal 参数」那么小）：
  ① 这五个查询（`privacy` / `graph` / `ledger` / `storage` / `overview-insights`）现在全是**同步函数**，
     要按行让出就必须改成 `async`，连带 `cachedBySig`（同步签名缓存）要加 async 版 + 同键并发合流、
     `withDb` 要加 `withDbAsync`（连接要跨过 await 才能关），两个调用方（`remotes/opslog.ts`、
     `query/export-flows.ts`）跟着改 —— 是一个 5 模块 + 2 处的整体改造，不该顺手塞在别的提交里。
  ② **「取消」这一半被 P1-5 卡住**：`@Remote` 的取消是生成物里的元数据
     （`lib/typert.host.js` 中 `cancellation: { parameter: 'signal' }`，`openPath` 就是这么拿到 signal 的），
     而那份生成物**不是本仓能重生成的**（`sourceLocation` 指向另一棵树，见上面 ⑧）。
     只在壳上声明 `signal: AbortSignal` 而生成物不知道，运行期拿到的是 `undefined` —— 那是假接线。
     所以顺序只能是：先做 ① 的让出（它不依赖任何生成物，直接解掉「排队放大器」），
     取消等 P1-5 把生成链接回来之后再开。

- 第二批 #13 的**后半**：`ENFORCED_SCHEMA_METHODS` 目前是空集 —— ② 档（按 schema 硬拒）要等
  `info().argGuard.mismatched` 在真实使用里稳定为空才升级，这是刻意留下的证据门槛，不是漏做。
- 第三批 #19、#20、#22、#24、#25（拆 `chats-view.tsx`/`Chats.tsx` 的逻辑、`GatewayCore` 职责拆分、
  长列表虚拟化、DB 纪律 ESLint 固化、四份新文档 + README 索引）。
  **#18（拆 `moments-panel.tsx`）、#21（解循环依赖）、#23（统一失效契约）已完成**，见上表。
- 第四批其余 P3（`isMd5` 10 处、`normalizeAesKey` 6 处、图片解码三兄弟、同概念三名、地图开关镜像…）；
  **剪贴板那一处已做完**（8 个面板 10 处收进唯一出口，见上表 `8b4343c`），同概念多处的清单又长出两条：
  视频键（已并成 `videoCoverKey`）与「面板自己 `setTimeout` 弹提示」（已有 `useTransientNotice` 守着）。
  `KNOWN_SECOND_TIME` 里剩下的 7 份日期函数（各有显示形状，要逐个改文案再核对既有用例）。
- 本轮新发现的候选守卫（还没写）：「注释里引用的脚本/用例/文档路径必须真的存在」——见 ⑤。
- 本轮新发现（不在本报告内）：
  ① `query/**` 里同类「catch 分支漏 close」比报告列出的多 4 倍（已进棘轮清单，只能变小）；
  ② `defaultWhisperModelsDir` 在数据根里还没有 whisper 目录时**退回随包资产目录**，
     开发态那个目录就在仓库里（`src/wechat/whisper`）—— 装到 `Program Files` 时同样会写失败；
     测试夹具已改为钉住模型目录并留了「用例不许往仓库写」的哨兵，产品侧的回退路径待单独处置；
  ③ 出网台账实测 15 个调用点，其中 `wechat-host.js` 的 4 个 LLM 出口此前没有任何清单登记过。
  ④ §五 那些「✅ 未发现问题」里，Electron 安全基线一项**没有任何用例守着**（本轮已补 `electron-security-baseline.spec.ts`）。
  ⑤ **「注释里写着有守卫，而守卫不在仓库里」是复现的**：`utils/format.ts` 与 `message-text.tsx` 都写着
     「这条由 `scripts/check-ui-consistency.js` / `audit-a11y-clickable` 把关」，而**两个脚本都不存在**
     （`scripts/` 里没有，`package.json` 里没有，全仓没有同名文件）。本轮把两处约定都补成了真用例
     （`format-single-source.spec.ts`、`message-text-clickable.spec.ts`）；
     **仍未做**：一条「注释里引用的脚本/用例路径必须真的存在」的全仓守卫 —— 这正是本条能被反复踩的原因。
  ⑥ **第二类假绿：用例文件扩展名不在 runner 的 include 里**。根 `vitest.config.ts` 只收 `.spec.ts`，
     而含 JSX 的用例天然会被写成 `.spec.tsx` —— 那种文件在 `npm test` 里**安静地不存在**（只有手工
     指名时才报 `No test files found`）。本轮写守卫时当场踩到。已补 `spec-file-discoverability.spec.ts`
     （从配置读 include 再逐个匹配，含 `.ts`/`.tsx` 反例与「`**/` 接受零层目录」自证）+ 变异 M80；
     顺带把 `ci-script-isolation` 的 spec 扫描从 `endsWith('.spec.ts')` 放宽到全扩展名。
  ⑦ M24 分层守卫的白名单**理由没被守着**：`dirs.ts`/`asar-path.ts` 之所以能进 `query`/`keys` 的放行清单，
     注释说的是「它们不 import 包内任何模块」，而这句话没有任何用例验证 —— 往清单里加一个反向依赖
     上层的文件，守卫不会有任何反应。本轮新增后端唯一格式化出处 `src/format.ts` 时正要走这条路，
     于是把它连同那两个文件一起升成 **`base` 层**并加硬判据「base 不许依赖包内任何模块」+ 变异 M81
     （清单从「靠注释解释的例外」变成「有牙齿的下界」）。
  ⑧ **`@Remote` 方法 172 个，生成的 schema 只覆盖 114 个**（差集 58，`[算料]` 打在
     `wechat-args-guard.spec.ts` 里，已钉成只能变小的棘轮）。这份差集同时是 P1-5 的实锤：
     `wechat-data/lib/typert.host.js` 的 `sourceLocation` 写着 `packages/host/wechat-data/src/gateway.ts` ——
     **不是本仓库的路径**，也就是说这份生成物是从另一棵树里签出来的，没有任何脚本能在这里重现它。
  ⑨ **「解密结果有效」这道闸门从来没拒过任何东西**（补 P1-7 第一条 decrypt-all 用例时撞出来的）。
     `sync.ts#looksDecrypted` 只比对新产物的前 15 字节是不是 `SQLite format 3`，而 `decryptPage`
     给页 1 是**无条件**贴上这段魔数的（磁盘上那 16 字节是 salt）⇒ 判据恒真：
     密钥错也照样「解密成功」，乱码被发布成快照，面板表现为「读不到数据」而日志一片绿。
     受影响的闸门有 10 处（实时同步 message/session/contact/媒体 9 处 + 全量解密 1 处）。
     修法：判据改看页 1 头部里**不能被合成**的字段 —— 偏移 16-17 的页大小必须是 `[512,65536]`
     内的 2 的幂（`65536` 在头部里编码成 1），随机明文撞上约 0.02%；并把两份副本收成一个主人
     `sync.ts#plausibleSqliteHeader`（导出，`decrypt-all.ts` 改为引用它）。
  ⑩ `query/drafts.ts` 两个导出函数的「表不存在」早退分支**在 `finally` 之外又 close 一次** ⇒
     `node:sqlite` 抛 `ERR_INVALID_STATE`，把函数准备返回的人话错误（`SessionTable 不存在`）
     顶替成「database is not open」，而面板把 `error.message` 原样渲染进 `role="alert"`。
     同样是补测时撞出来的（P1-7 说这几个模块「无回归保护」，代价就是这两条）。
  ⑪ **一个新发现的「守卫失明」机制**：源码文件里只要混进一个**字面 NUL**，`grep` 就把它当二进制
     文件（打印 `Binary file matches` 并跳过逐行输出），于是本仓所有基于文本/AST 的扫描对那个文件
     **静默失效** —— 不是报错，是「查无此类」。本轮我自己制造过一次（写注释时把 `\0` 写成了真字节），
     靠 `git show HEAD:<path> > <path>` 逐字节复原。**已补**：`source-text-integrity.spec.ts`
     （扫 849 个源码文件：不许出现 NUL/退格/ESC 等会让 `grep` 判二进制的字节、不许 BOM、
     UTF-8 必须往返一致）+ 变异 M89。判据自己带反例自证（喂它一段带 NUL 的内容必须报出位置）。
  ⑫ `light-theme.css` 的注释里有 8 个 U+FFFD（历史上某次编码转换把「）」「、」这类全角标点
     弄坏了）。**内容问题，不是二进制问题** —— 上面那条守卫特意用「UTF-8 往返一致」而不是
     「不许出现替换字符」做判据，就是为了让这类既有乱码不伪装成「文件坏了」。留给界面文案的
     一轮一起清（改注释会动 CSS 分块，要过 `css:bundle-diff`，不该塞进整改提交里）。
  ⑬ 落地 P1-5（溯源表）时撞出的三条，都不在报告里：
     **① `--write` 会把人手写的来源说明冲成零。** `readTable()` 对「JSON 语法坏了」和
     「根本没有表」回的是同一个 `null`，而 `--write` 原本把 `null` 当「首次 bootstrap」
     ⇒ 谁手抖打坏一个逗号，下一次刷新就把 16 条 `note`/`upstreamCommit` 全丢掉 —— 而这 16 条
     恰好是整张表里**唯一不可再生**的部分（17 个包的指纹能从磁盘重算，上游 commit sha 不能）。
     已修：表存在却读不出 `packages` 时**拒绝覆盖并退出 1**，原文件一字不动；「表压根不存在」
     仍然放行（那是合法的首次生成）。变异 M99。
     **② `files` 那一维不是独立判据。** 单独把它的比对关掉，13 条用例全绿（增删文件必然改变
     `treeSha256`）。这条变异（M97b）已删而不是留着：登记表的前提是「每条都必须咬红」，
     塞一条注定存活的进去，以后真出现「某条不知为何不咬了」时就分不清了。结论记在这里：
     `files` 只是让人看懂差异的数字，别把它当成第二道闸。
     **③ 变异登记表自己撞了 1000 行闸门。** 第 96 条把 `scripts/mutation-check.mjs` 顶到
     1012 行 ⇒ `m21-file-size-ratchet.spec.ts` 红（白名单只许变短，所以不能靠加例外解决）。
     已把**表**搬进 `scripts/mutations-registry.mjs`（数据 789 行 / 跑手 237 行）：这条债本来就在，
     只是「登记一条变异」这个动作从来没想过会让**登记本身**失败。表再涨到上限时按批次切开聚合，
     不要放宽闸门。
  ⑭ 落地 #9 的时候，**报告算的那个余量自己撞上门来** —— 这一条值得单独记，因为它把「约 0.02%」
     从估算变成了观测。⑨ 里收紧过的 `plausibleSqliteHeader` 只看偏移 16-17 的页大小，撞中率约
     0.02%；本轮跑全量 `vitest` 时 `decrypt-all-tree` 真的红了一次：那个用**错密钥**加密的 `bad.db`
     被这道闸门判成"解对了"，单独重跑又是绿的。
     **为什么会抖**：CBC 下页 1 最前那块明文 = `D(C₁) XOR IV`，而夹具每轮给页 1 换一个随机 IV
     ⇒ 错密钥解出来的**头两个字节每轮都不同**，正好落进 512/1024/…/65536 那一小组值时就放行。
     这不是抽象风险：一次全量解密要判几百个库，每 10 秒的同步还会再判一遍。
     **已收紧**：除页大小外还看 SQLite 规范写死的三组字段 —— 读/写格式（偏移 18/19，只能是 1 或 2）
     与三个 payload fraction（偏移 21/22/23，必须是 64/32/32），合起来撞中率约 10⁻¹²；
     变异 M105/M106。刻意**没看**偏移 20 的 reserved：微信那类 SQLCipher 库里它是 80 而不是 0，
     把它当常数校验会把真库整批判成无效（那比 0.02% 坏得多）。
     **顺带撞出第二个问题：夹具自己在撒谎。** 收紧之后 `decrypt-all-tree` 一次红 7 条，全在合成库
     那边 —— 它的页 1 只填了页大小、其余按 `0x5a` 填充，也就是说这份号称"好库"的东西根本不长
     SQLite 头部的样子；以前的判据太松，假夹具一直过得去。已抽公共
     `src/backend/tests/helpers/sqlite-page1.ts`（写规范常数；页大小或缓冲长度不合法就直接抛），
     下一个加密类夹具不必再猜要填哪几个字节。
  ⑮ **拆组件这件事本身抓出了一条用户可点到的缺陷**（第三批 #18，不在本报告内）：
     `moments-panel.tsx` 里 `scoped` 那个 memo 的函数体读 `dateScoped`，依赖数组却写
     `[monthFiltered, sortOrder]` ⇒ **在侧栏选日期范围，列表不动**（要等到别的条件变了才一次性补上）。
     两个条件让它活到今天：**没有任何用例覆盖日期筛选**，而本仓没装 eslint
     （§七 #24 那条「用 ESLint 固化 DB 纪律」正是同一件事的另一半 —— 没有静态检查时，
     「依赖数组漏一项」这类缺陷没有任何自动防线）。修法是「七段链收成纯函数 + 唯一一处 memo」，
     并加一条 **AST 契约**：`MomentsCriteria` 每加一个字段，那次 `useMemo` 的依赖里就必须出现
     `criteria.<字段>`（漏了当场红，不等人眼读）。
  ⑯ **共享助手存在，却被绕过**（P3「第二份实现」同族，不在本报告内）：
     `utils/misc.ts#copyTextToClipboard` 是唯一的复制出口（异步 API 被拒会转成 `false`，
     还会试 `execCommand('copy')` 退路），而 `git grep` 实测有 **8 个面板里的 10 处**各自手写
     `navigator.clipboard.writeText` —— 那些站点没有退路，窗口失焦/权限被挡时本可以复制成功却报成失败，
     `moments-panel` 更把 `.catch(() => {})` 写成静默。更值得记的是**为什么没人发现**：
     `ReplySuggest.tsx` 早就修对了，还留了一条判据，但那条判据**只管它自己那个文件** ——
     「规则没有全仓化」就等于没有规则。本轮把它升成零容忍扫描（AST 取成员访问，注释里的字样不算，
     `ReplySuggest.tsx` 的注释里恰好就写着那句），并顺手修掉一条真缺陷：`execCommand` **抛异常**时
     改前会跳过 `document.body.removeChild(ta)` ⇒ 每失败一次就在 body 上留一个抢过焦点的隐藏 textarea
     （P0-1「catch 分支漏 close」那一族的 DOM 版；这条是新写的行为用例第一次跑就抓出来的）。



## 〇、总体结论

工程化水平**显著高于同类 Electron 项目**，本次未发现可直接远程利用的高危漏洞。以下先给三条最重要的判断：

1. **最确定、最可复现的高危项是「DB 连接在 catch 分支漏 close」**。项目自己在 `src/backend/tests/helpers/temp-db.ts:8-18` 写明了病因（「`try/catch` 的 catch 分支忘了 close」），但修复只落在测试助手，生产 `query/` 层仍在犯同一个错。已验证 `unified-search.ts`、`voice.ts` 多处实锤。
2. **隐私承诺与实现存在 3 处不一致**：`installWhisperEngine`（GitHub 下载引擎 zip）、`downloadLayaModel`（HuggingFace 下载 1.26GB）、`wechat:llm-models`（设置页拉模型列表，还带 Bearer Key）**都不受 `blockOutbound` 总闸约束**。尤其讽刺的是 `remotes/voicellm.ts:87-88` 紧邻的 `downloadWhisperModel` 有闸，注释还写着「从 2026-09-26 起那句话不成立：开关真的管到它了」——同族方法漏了一个。
3. **性能瓶颈的根因不是「某接口慢」，而是「后端单队列 + 重读查询不让出事件循环」**。`PERF-BASELINE.md` 已记录世界板块自身 13ms 被前序 15s 词云拖到 17,008ms；本次确认结构未变，且新增发现 `overview-panel.tsx` 每约 10s 重算两个无缓存重查询，放大了排队效应。

另有两项「非问题但需处置」：`main.js` 实测已 **1000 行**（闸门 `LIMIT=1000`、`ALLOWLIST` 已空）⇒ **零余量，下一次改动极可能直接红**，建议先核实 `check:mutation` / 全量 vitest 当前状态。

---

## 一、P0 — 建议立即修（高危 × 低成本）

### P0-1 DB 连接在 catch 分支泄漏（最高优先）

**位置（已复核 ✅）**

| 文件:行 | 证据 |
|---|---|
| `src/backend/wechat-data/src/query/unified-search.ts:42-70` | `const db = new DatabaseSync(p, { readOnly: true })` 在 try 内；成功路径 `db.close()`；`catch { return [] }`（L68-70）**不 close**（且 `db` 是 try 内 const，catch 作用域拿不到） |
| `unified-search.ts:78-104` | 同上模式（moments），`catch { /* try next path */ }` 无 close |
| `unified-search.ts:113-132` / `142-166` | 同上模式（favorites / files） |
| `query/voice.ts:26-34` | `usernameByChatId`：`catch { /* db unavailable */ }` 不 close |
| `query/voice.ts:74-92` | `svrIdByChatLocal`：`db`（L77）catch 分支漏 close（`db2` 反而在 finally 里关了） |
| `query/search-scaffold.ts:148-155 / 174-180 / 213-221` | `indexReady` / `countIndexMatches` / `searchIndexBatch` 同模式 |

**反例佐证（同项目内的正确写法，可作为模板）**：`query/voice.ts:57-71` 的 `voiceDataBySvr` 就**在 catch 里 close 了**；`query/wordcloud.ts:98,126`、`query/members.ts:91,183`、`laya/store.ts:93,121,139` 用了 `finally { db.close() }`。⇒ 同一文件内两种模式并存，属**纪律未统一**，不是「不会写」。

**影响**：查询抛错（库损坏 / SQLITE_BUSY / 缺表）即泄漏一个 SQLite 句柄。Windows 下**只要有一条连接还开着，`rmSync` 就确定性报 EPERM 且重试无效**（项目自己在 `temp-db.ts` 注释里已记录此结论）⇒ 长跑泄漏 + 解密目录/备份无法删除替换。

**优化方向（可落地）**

1. 抽生产助手 `query/db-open.ts`：
   ```
   export function withDb<T>(path: string, fn: (db: DatabaseSync) => T): T
   ```
   内部 `try { return fn(db) } finally { db.close() }`，句柄登记册直接照搬 `tests/helpers/temp-db.ts:20-26` 已验证的模式。
2. 用带「恰好 N 次」断言的批量替换脚本（见 §七 工具纪律）逐处改造上表 6 个文件；**不要用多个 Edit 改同一文件**。
3. 加守卫 `panels/`… 实为 backend spec：`query-db-lifetime.spec.ts`，断言 `query/**` 下 `new DatabaseSync(` 的出现次数 == `withDb(` 调用次数（或白名单化已知安全的少数几处）。
4. 变异条目（`scripts/mutations-registry.mjs` 的 `MUTATIONS`，跑手是 `mutation-check.mjs`）：把 `withDb` 的 `finally` 改成「只在成功路径 close」，**必须变红**。

---

### P0-2 三个出网点未受隐私总闸约束

**位置（已复核 ✅）**

| 文件:行 | 证据 |
|---|---|
| `src/backend/wechat-data/src/remotes/voicellm.ts:63-84` | `installWhisperEngine` 全程**无 `rc.privacyBlocked(...)`**；而紧邻的 `downloadWhisperModel`（L86-107）第 89 行有 `const blocked = rc.privacyBlocked('voice_model_download', …)` ✅ 形成对照 |
| `src/backend/wechat-data/src/remotes/laya.ts:144-169` | `downloadLayaModel` 无 `privacyBlocked`；`createLayaRemotesInputs` 甚至没注入该依赖 |
| `src/backend/ipc-wechat.js`（`wechat:llm-models`，约 L167） | 主进程 `fetch(url, { headers: { authorization: 'Bearer ' + apiKey } })` 不经任何开关，也不在 license `METHOD_FEATURE` / `NON_AI_OUTBOUND` 清单内（该清单只扫 gateway 的 `@Remote` 方法） |

**影响**：用户开启「禁止 AI 出网 / 彻底离线」后，仍可向 GitHub / HuggingFace / 用户配置的任意 API 主机发请求；`llm-models` 还会把 API Key 发给该主机。不泄漏聊天内容，但**直接违背 `docs/PRIVACY.md` 的明示承诺**，且现有 `license-outbound-coverage.spec.ts` 因「按 privacy 接缝扫描」而**天然看不到这三处**——正是漏网无法被发现的原因。

**优化方向**

1. 给 `installWhisperEngine` / `downloadLayaModel` 补 `rc.privacyBlocked(...)`（照抄 `voicellm.ts:89` 的写法与文案口径）。
2. `wechat:llm-models` 也判 `blockOutbound`；把它登记进出网功能位清单。
3. **改造覆盖测试的判据**：从「找 privacy 接缝」改为「枚举所有 `fetch(` / `https.request(` 调用点」，逐个要求「要么经过闸门、要么在豁免清单里」——否则下一个新出网点仍会静默逃逸。
4. 变异：删掉 `voicellm.ts:89` 那行 `privacyBlocked`，`s07-outbound-switches` 必须变红（确认现有守卫真的咬得住「同族漏一个」）。

---

### P0-3 `cachedFetch` 不是真 SWR（命中仍等完整请求）

**位置（已复核 ✅）**：`src/client/ui-wechat/src/client/pages/wechat-data/cache.ts:175-189`

```
const hit = cacheGet(key, ttlMs) as T | null
if (hit !== null && !isEmptySnapshot(hit)) {
  try {
    const fresh = await timedFetch(key, fetcher)   // ← 命中仍 await 完整后端请求
    cacheSet(key, fresh); return fresh
  } catch { return hit }                            // ← 只有失败才用缓存
}
```

**影响**：所有走 `cachedFetch` 的接口**二次打开仍要等完整后端**——`sessions`(30s) / `messages`(5s) / `moments` / `records` / `privacy` / `group` / `pay` / `daily` / `kb-model` 共 9 处。这是「切回面板还要转圈」的直接原因。

**优化方向**：命中即 `return hit`，随后后台 `fetcher()` 完成后 `cacheSet` 并通过 `_snapshotListeners` 通知订阅者重渲染（`cache.ts:62-73` 的 subscribe 机制已就绪，只差触发点）。**注释里已写「先渲染缓存，后台刷新后再写回」——实现与注释不符，属未完成**。

---

### P0-4 `main.js` 已顶到 1000 行硬闸门（零余量）

**位置（已复核 ✅）**：`D:\super-time-wechat\main.js` 实测非空行 **1000**（`Read` 到第 1000 行仍有内容）；闸门 `src/backend/tests/m21-file-size-ratchet.spec.ts:24` `LIMIT = 1000`，`:47` `ALLOWLIST = {}`（已清空），`:64` `SCAN_FILES` 含 `main.js`。

**影响**：零余量。任何新增 IPC / 功能都会立刻触发 M21 棘轮红。同类风险：`gateway-core.ts` 991 行、`chats-view.tsx` 953、`Ask.tsx` 951、`moments-panel.tsx` 949、`gateway-data-ops.ts` 913。

**优化方向**：按 M21 既有刀法继续外提（`main.js` 的 window / updater / IPC 各自成模块，用桶文件转发）；**先核实当前 m21 是否绿**（若非绿，说明口径已变，需按实测行数重新确认）。

---

## 二、P1 — 本迭代修（高危 / 中危，成本中等）

### P1-1 「读取失败」被渲染成「没有数据」

**位置（已复核）**：`unified-search.ts:68/104/132/166`、`query/sync.ts:47-49`（`cachedDirEntries` 的 `catch { return [] }` ⇒ 目录不可读时同步判定「无变化」，UI 表现为**数据永远不更新**）、`query/region.ts:95-99`、`query/moments-monthly.ts:83-85`、`query/sns-video.ts:56/100/375/385`、`query/sns-image.ts:152`、`query/voice-transcribe.ts:49`、`query/storage.ts:75`、`query/export-history.ts:128/138`。

**实测规模**：自有代码**真空 catch 0 处**（治理良好），但「catch 内只有注释」**249 行**、「catch 同行 return 空值」**14 处**。

**反例佐证（项目已有正确契约）**：`query/media-file.ts:104-107`、`query/kb-files-mutate.ts:111-113`、`query/image-original.ts:155-158` 返回 `{ error: '…' }`；前端已有 `read-error-visibility.spec.ts` 守卫「不许把读失败当没有数据」。⇒ **契约存在，但后端返回值层未跟齐**。

**优化方向**：把前端的 `Result<T>` 契约下沉到后端返回值：读取失败必须 `{ ok:false, error }`，只有确认空集才 `ok:true + []`。优先改 `sync.ts:47`（影响最大：静默停摆）与 `unified-search.ts` 四处。守卫扩到后端 spec。

### P1-2 后端重读查询不让出事件循环（排队放大器）

**位置**：`query/{privacy,graph,ledger,storage,overview-insights}.ts` 三处均不受 `yieldToLoop` 覆盖（协作式让出只覆盖搜索 / KB 向量 / 导出 / 全量解密 / PDF 解析 / 同步）。

**已实测的后果**：`docs/PERF-BASELINE.md` 记录「世界板块自身 13ms，排在 15s 词云后面时实测等到 17,008ms」；生产 `app.log` 有 `analyzeVisibleMessages` 54,103ms、`getRemoteImages` 各 45-51s。

**优化方向**：仿 `query/search-query.ts:412-426`（`signal.aborted` + `setImmediate` 让出）给这些查询注入可选 `AbortSignal`，每 N 行 / 每分片让出一次；顺带解决「用户切走面板后查询仍在占队列」。这是「某块一直转圈」的总根源。

### P1-3 `queryGraph` N+1：逐表重开同一分片库

**位置（已复核 ✅）**：`query/graph.ts:92-104` —— `for (sh of shardCatalog)` 内层 `for (t of sh.tables)` 每张表都 `new DatabaseSync(sh.file, { readOnly: true })`。本机 290 会话 / 304 张 `Msg_*` 表 ⇒ 对同一批文件开合数百次 + 数百次全表 `COUNT(*)`。

**基线数字**：`queryGraph` 冷 866ms / 热 795ms（后端无缓存）。前端 `apiGetGraph` 走 `cachedGet`（30s 内切回 0ms），但**首次打开 / 超 30s 仍要完整等 866ms**。

**优化方向**：① 每个分片只开一次库，`prepare` 后复用 → 开库数 304 降为分片数；② 后端加 `cachedBySig(... dataGenerationSig())`（照 `overview.ts:104` 抄）。①+②后冷跑应降到 ~100ms 级、二次 0ms。

### P1-4 `queryPrivacyScan`：每行重建正则 + 无缓存

**位置（已复核 ✅）**：`query/privacy.ts:107-190` —— `WHERE ${typeCol}=1` 列**无索引**；L171 在**每一行 × 每一类别**里 `spec.insensitive ? new RegExp(spec.re.source, 'gi') : spec.re` ⇒ email/password 两类每行都重新编译正则。`rowBudget=600000`。

**基线数字**：1020ms 冷/热都是 ~1000ms（后端无缓存）；前端 `apiGetPrivacyScan` 用 `cachedFetch`，而它**不早返回**（P0-3）⇒ **每次打开隐私体检都要等约 1 秒**。

**优化方向**：① insensitive 正则预编译在 `CATEGORIES` 里（或循环外建一次）；② 后端加 `cachedBySig`；③ 依赖 P0-3 解决前端层。

### P1-5 19 个 `file:` 本地依赖无版本溯源

**位置**：`package.json:72-101`（14 个 `@deepseek-ai/*` + `fzstd`/`koffi`/`zod`/`@standard-schema/spec` + devDeps 2 个）。版本多为 `0.1.x-alpha` / `0.1.1-rc.2`。

**影响**：无法用 npm 解析/升级；上游改动需手工拷贝进 `src/backend/deps/**`；`lib/*.js` 与 `src/*.ts` 并存极易漂移。`VENDORED-LICENSES.md` 只覆盖许可，**不含 commit 溯源**。

**优化方向**：建「上游仓库 + commit sha + 拷贝日期」溯源表；写 `scripts/sync-deps.mjs` 半自动同步；长期收敛为私有 registry。

### P1-6 `xlsx@0.18.5` 已知原型污染且无 npm 修复

**位置**：`package.json` 依赖 `xlsx ^0.18.5`；使用点 `query/kb/parse-xlsx.ts:134` `XLSX.read(bytes, { type: 'array' })` 读**用户选入知识库的任意 xlsx**。

**影响**：受 CVE-2023-30533（原型污染，<0.19.3）、CVE-2024-22363（ReDoS，<0.20.2）影响；SheetJS 已停止向 npm 发布，修复版只在其自有 CDN。`kb/container-guard.ts` 挡 zip 炸弹但不挡解析期原型污染。

**优化方向**：依赖源换成 `https://cdn.sheetjs.com/xlsx-0.20.x`；或迁维护中的替代库；至少对解析出的键名做 `__proto__ / constructor / prototype` 过滤。

### P1-7 6 个后端模块零 spec 引用

| 模块 | 风险 |
|---|---|
| `query/decrypt-all.ts` | 核心解密流程无回归保护 |
| `query/payments.ts` | 转账/红包金额解析无测（资金相关） |
| `query/calendar.ts` | 日历统计无测 |
| `query/drafts.ts` | 草稿 |
| `query/media-file.ts` | 本地文件定位（含池选择逻辑）无测 |
| `gateway-read.ts` | 28KB 读接口无独立 spec |

**优先补**：`decrypt-all` → `payments` → `calendar`。

---

## 三、P2 — 排期修（中危或成本较大）

### P2-1 少数巨型 React 组件（可维护性主要债）

| 文件 | 体量 | 具体 |
|---|---|---|
| `panels/moments-panel.tsx` | 949 行 | **`MomentsPanel`（L33）单函数 ≈917 行**，含约 20 个 `useEffect`、10+ `useMemo`、`loadAll/drainMedia/doSync/doExport` 内联 ✅ 已复核起始行 |
| `panels/chats-view.tsx` | 953 行 | `ChatsView`（L202）≈752 行，**一次性解构 150+ 个 state 字段**；内嵌 `renderMsgItem`（L711）≈244 行 |
| `panels/Ask.tsx` | 951 行 | `AskPanel`（L459）≈493 行 |
| `panels/settings-state.tsx` | 872 行 | `useSettingsState`（L33）≈840 行（单 hook 覆盖整设置状态机） |
| `panels/kb-files-panel.tsx` 819 / `Graph.tsx` 816 | — | `KbFilesPanel` ≈788 / `GraphPanel` ≈728 |

全仓函数体统计：**≥120 行 95 个 / >150 行 77 个 / >200 行 45 个**。

**注**：`gateway-core.ts`（991 行）反而**不是**超长函数问题——它由大量短方法组成，无单方法 >150 行；其规模来自「172 个 `@Remote` 必须同属一个类」的协议约束（`gateway-core.ts:5-8`）⇒ **属可接受复杂度，别乱拆**。

**优化方向**：按现有 M21 刀法按「簇」外提；优先 `moments-panel.tsx`（单函数 = 整文件，最极端）。

### P2-2 `GatewayCore` god-object（架构层最大单点）

**位置**：`src/backend/wechat-data/src/gateway-core.ts:64-991`，45 个 import、45 个方法，混合约 15 类职责：12+ 实例状态字段（`:81-136`）、生命周期与实时同步接线（`:205-263`）、隐私闸+操作日志+流控（`:270-347`）、LLM/模型工厂（`:393-527`）、14 个域处理器装配（`:550-756`）、调度 + 图片批量解码并写盘（`:882-990`，含 `readFileSync/writeFileSync`）。

**优化方向（协议约束下的可行路径）**：
1. 「LLM 工厂」「隐私闸」「流控槽/调度」各拆为独立协作者（组合而非继承），`GatewayCore` 只保留 `_ctx/_dirs` 与装配；
2. `warmDecodedImages` 这类含 fs 写的能力下沉回 `query/media-image.ts`，core 只做编排；
3. 用「handler 注册表」替代 14 个 `xxxRemotes()` 方法，压掉约 200 行样板。

### P2-3 循环依赖（真实值 import 双向边）

| 环 | 证据 |
|---|---|
| `query/export-format.ts:16` ↔ `query/export-flows.ts:25` | 仅因成员都在函数体内使用才侥幸可跑 |
| `query/search-scaffold.ts:17-18` ↔ `search-build.ts:13` / `search-query.ts:14` | 3 节点强连通，M21 竖切遗留 |
| `api-core.ts:149-150` ↔ `api-config.ts:120` / `api-status.ts:109` | 类型与值混在同一环 |
| `graph-canvas-theme.ts:12` ↔ `graph-canvas-render.ts:12`；`chats-media.tsx:13` ↔ `chats-cards.tsx:16`；`chats-thread.tsx:18` ↔ `Chats.tsx:25` | 组件互引 |

⚠️ **注意**：本仓文档注释里大量出现 `from './xxx.ts'` 字样（如 `export-io.ts:5`、`api-core.ts:153`），会让任何正则静态分析**误报假环** ⇒ 写检测脚本时**必须先 `stripComments`**（`panels/wiring-kit.ts` 已有该 helper）。

> **2026-09-26 复核（第三批 #21 已闭合）**：上表 6 对里 `chats-thread.tsx ↔ Chats.tsx` 是**误报** ——
> 两侧互相引用的只是类型（`import type` 编译期擦除，不构成运行期依赖），所以 AST 口径下实测是
> **5 个强连通分量**而不是 6 个。其余 5 个已全部解开，守卫按 `ts.createSourceFile` 取边
> （比 `stripComments` 更彻底：注释在语法树里根本不是节点），落点与判据见顶部状态表。

**优化方向**：`api-core` 的 `remote/unwrap` 下沉为叶子 `api-runtime.ts`，类型抽 `api-types.ts`；`export`/`search` 家族明确单向依赖方向。

### P2-4 缓存失效语义不统一（三套并存）

`cache.ts` 的 `subscribeSnapshot/invalidate*` + DOM 事件总线（`dsh-wechat-data-updated` / `-notes-updated` / `-kbs-updated`）+ `PollRegistry` 定时轮询，三者互不相知。

**新发现（需真机打点确认）**：`panels/overview-panel.tsx:105-106` 在每次 `dsh-wechat-data-updated` 触发 `load()`，而 `load()`（`:92-95`）`Promise.all([apiGetLedger(), apiGetStorageStats()])`——`apiGetLedger`（`api-read.ts:363`）**无任何缓存**，`apiGetStorageStats` 走 `cachedGet` 但每次事件都 `invalidateSnapshotCache()` 全清 ⇒ **同步活跃期约每 10s 重算约 250ms 的无缓存重查询**。

**优化方向**：① 给 `apiGetLedger` 加 `cachedGet`；② `invalidateSnapshotCache()` 收窄为按键失效；③ 定义统一 `invalidate + notify` 组合（写入侧只调一个函数）。

### P2-5 `readRenderCache` 无 TTL / 无上限 / 写失败静默

**位置（已复核 ✅）**：`cache.ts:103-118`。`JSON.stringify` 大对象（全量消息、朋友圈）易撑爆 localStorage 5-10MB 配额，之后**静默失败**，表现为「某些面板首屏加速莫名消失」。

**优化方向**：加 TTL（建议 24h）+ 容量上限 + 失败时 `console.info` 一次。

### P2-6 安全：路径未限根

| 位置 | 证据 |
|---|---|
| `gateway-read.ts:414-423` `openPath` → `openNativePath(p, signal)` | 实现 `deps/dsh-native-command/lib/index.js#openWindowsPath` 用 `powershell.exe … Invoke-Item -LiteralPath '<path>'`（转义正确），但 `.exe` 会**直接执行** ⇒ 渲染层被控即 RCE 原语 |
| `query/export-flows.ts:143/152/335-339` | `exportDir = dir.trim()` / `join(exportDir, filenameOut)` / `mkdirSync(dirname(filepath)) + writeFileAtomicSync`，**目录未做「必须落在允许根内」约束** ⇒ 可向任意绝对路径写 |
| `src/backend/ipc-misc.js:221` `shell:show-item` | 接受任意 `filePath`（影响低） |

**优化方向**：`openPath` / 导出 `dest` 复用 `navigation-policy.js#isInsidePath` 限根；原生对话框授权过的路径作为一次性令牌传回后端。

### P2-7 `wechat:call` 无运行时入参校验，zod schema 未生效

**位置**：`src/backend/ipc-wechat.js:29` → `src/backend/wechat-host.js:642`，`await fn.apply(gateway, callArgs)` **直接展开，无任何校验**。生成的 `src/backend/wechat-data/lib/typert.host.js` 里每个方法都有完整 zod schema，但**`.parse(`/`.safeParse(` 出现 0 次**。

**说明**：方法名本身有白名单（`methodMap`），无法调用非 `@Remote` 方法——这点是好的。

**优化方向**：用已生成的 schema 对 `callArgs` 做 `safeParse`，失败即拒；至少对 `Array.isArray(args)` 与参数体积设上界。

### P2-8 `usePagedList` 自动刷新最多 16 页 + 长列表未虚拟化

- `panels/hooks.tsx:267` `MAX_REFRESH_PAGES = 16`，`:404-406` 订阅更新事件自动 `refresh()` ⇒ 实时同步活跃期每约 10s 最多 16 个后端请求，全进同一同步队列。
- 虚拟化**只覆盖聊天消息流**（`Chats.tsx:41,477`）；朋友圈/文件/收藏/表情仍是 `useProgressiveList` 渐进渲染（DOM 随滚动持续增长）。

**优化方向**：`refresh()` 节流 + 调低页数上限；把 `useVirtualizer` 推广到三处长列表。

---

## 四、P3 — 择机修（低危 / 卫生）

| # | 问题 | 位置 | 优化方向 |
|---|---|---|---|
| P3-1 | `fmtTime` **4 份同名、单位不一致**（2 份按秒、2 份按毫秒） | `query/moments.ts:385`(秒) / `panels/AskHistoryDialog.tsx:62`(毫秒) / `panels/Calls.tsx:50`(秒) / `panels/ExportHistoryDialog.tsx:67`(毫秒) | 统一到 `utils/format.ts` 的 `fmt*Sec` / `fmt*Ms`（单位写进名字）；秒传给毫秒版会得到 1970 年 |
| P3-2 | 字节格式化 **5 份、口径不一**（封顶 MB / 0 位小数 / 动态小数位…） | `utils/format.ts:30` / `query/kb-files-store.ts:275` / `laya/model-file.ts:110` / `panels/kb-files-support.tsx:199` / `panels/ExportHistoryDialog.tsx:67` | 后端也抽 `formatBytes`，并扩展一致性检查覆盖 |
| P3-3 | MD5 正则 `^[0-9a-f]{32}$` 散落 **10 处** | `media-image.ts:70/77/536/576`、`files.ts:165` 等 | 导出单一 `isMd5(s)` |
| P3-4 | `aesKey→Buffer` 表达式 **6 处**，空串行为不一致（4 处带 `length>0`、2 处不带） | `media-image.ts:333/482/505/610`、`gateway-core.ts:971`、`keys/image-key-resolver.ts:113` | 抽 `normalizeAesKey()` |
| P3-5 | 图片解码「三兄弟」结构复制 | `media-image.ts:452/527/567` | 抽 `probeDecodedCache` / `decodeDatToResult` |
| P3-6 | 同概念三名：`username`(2640) / `talker`(361) / `author`(384) | 问答链用 `talker`、朋友圈链用 `author` | 在类型层加别名注释 |
| P3-7 | 孤立/错配 JSDoc **3 处** | `gateway-core.ts:274-283`（文档说返回文案，实际函数返回 boolean）/ `:349-353`（"Session list" 无宿主）/ `:867-871` | 删除；可加 lint「JSDoc 块后必须紧跟声明」 |
| P3-8 | 12 个零引用导出（已验证 2 个 ✅） | `resolveImageMd5`（`media-image.ts:249`，已被批版取代）/ `isQueueRunning`（`kb-queue.ts:164`）/ `senderNameMap` / `embedOne` / `hammingDistance` / `PBKDF2_ITERATIONS` / `SALT_SIZE` 等 | 逐一确认后删或反向接线 |
| P3-9 | 地图开关 localStorage 镜像可被渲染层改写绕过 | `panels/world-map-data.ts:38-56` + `map-tiles-flag.ts` | 底图拉取前仍以后端真值为准（可缓存 + TTL）；影响小（拉的是公开 GeoJSON） |
| P3-10 | 许可证签名私钥明文 PEM 落在工作区 | `vendor-keys/license-private.pem`（已在 `.gitignore`、未进 `build.files` ✅） | 迁出仓库目录，签发机与开发机隔离 |
| P3-11 | whisper 解压兜底 PowerShell 字符串插值 | `query/whisper.ts:567` | 改参数化/转义（当前利用者为本人，低危） |
| P3-12 | `getImageDataUrlsBatch` 未列 `LONG_CALL_METHODS` | `backend-rpc.js:31-62` | 加入，避免大批 200 张时被 60s 误杀 |
| P3-13 | `disposeLayoutWorker()` 定义但**全仓无调用** | `panels/graph-layout.ts:551` | 在 `graph-canvas-host.tsx` 卸载时调用 |
| P3-14 | `Graph.tsx:470-480` 同 render 内 6 次 `filter().length` | 同一文件 | 合并为单次 `reduce` + `useMemo` |
| P3-15 | `css-cascade.ts` 单字母变量密集（`a/b/r/n/p/l`） | `css-cascade.ts:89/193/211/234` | 改语义名 |
| P3-16 | 客户端 3 个测试辅助混进 `panels/`（含 `node:fs`） | `panels/chats-source.ts:8` / `settings-source.ts:10` / `wiring-kit.ts:29` | 移入 `panels/__tests__/` 或加 `.test-` 前缀 |
| P3-17 | 测试/脚本反向依赖下层实现 | `backend/tests/debug-gates.spec.ts:35`（backend→client）；`scripts/rag-retrieval-check.ts:17`（用 `__internals`） | 抽共享纯模块 |
| P3-18 | 客户端状态机制 **5 种并存** | useState / Context / 模块级 store / window 事件 / 自定义 hook+轮询 | 见 P2-4（统一失效契约），方案数量本身可接受 |
| P3-19 | `CLEANUP.md` 现状与历史混排；`README.md:111` 视图数过时（写"约 40 个"，实测 `panels/*.tsx` 为 94） | `CLEANUP.md:60-73`、`README.md:111,118-128` | 历史段移 `docs/archive/`；更新视图数；把 16 个未索引文档补进 README |
| P3-20 | 缺架构总览 / 贡献指南 / 部署说明 / 错误码表 | `docs/`（现 23 个文件，设计文档很丰富） | 新增 4 份 |

---

## 五、已检查、未发现问题（正面确认）

| 维度 | 结论 | 证据 |
|---|---|---|
| Electron 安全基线 | ✅ 全部为安全值 | `main.js:564-575` `contextIsolation:true` / `nodeIntegration:false` / `sandbox:true`；全仓无 `webSecurity:false` / `allowRunningInsecureContent` / `webviewTag`；`electronFuses` 已关 `runAsNode`/`NODE_OPTIONS`/`NODE_CLI_INSPECT` |
| 导航/开窗守卫 | ✅ | `main.js:654-695` + `navigation-policy.js`（`isInsidePath` 空 root fail-closed） |
| SQL 注入 | ✅ 未发现 | 值全参数化；标识符走 `PRAGMA` / 白名单（`ask-history.ts:284`、`export-history.ts:210`）/ 常量；`ledger.ts:119` 有 `/^\d{4}-\d{2}$/` 强校验 |
| 任意命令执行 | ✅ 未发现外部可控注入 | `child_process` 全是固定命令 + 参数数组，无 `shell:true` |
| 日志泄漏 | ✅ 未发现 | `diag-log.js:29-55` 统一脱敏（`api-key/token/secret/password/…` + `sk-…` + `Bearer …` + ≥16 位十六进制）；无打印聊天正文 |
| 临时文件 | ✅ | 原子写 + 失败清理（`export-io.ts:33-46`）；whisper `.part` 有意保留用于续传 |
| 资源释放（事件/定时器） | ✅ 配对纪律极好 | 抽查全部 `setInterval/setTimeout/addEventListener/Observer` 均有对应清理 |
| Promise 未处理拒绝 | ✅ | `.then(` 共 8 处，全部带 catch 或 `(release, release)` 双参；worker + 主进程均注册 `uncaughtException`/`unhandledRejection` |
| 空 catch | ✅ 自有代码 0 处真空 catch（vendored deps 有 ≥21 处，属上游） |
| `@ts-ignore` | ✅ **0 处**；`@ts-expect-error` 12 处**全在测试**且同一句宿主 CJS 说明 |
| 生产 `: any` | ✅ 仅 2 处 |
| TODO/FIXME/HACK | ✅ 自有手写代码 **0 条** |
| 缓存有界性 | ✅ 图片 LRU `MAX_BYTES=48MB`（`image-cache.ts:29-31`）、IndexedDB `MEDIA_MAX_ENTRIES=4000`、快照缓存 `MAX=60`（`cache.ts:37`）、服务端 `meta.ts` 按 key 族设上限 |
| 边界覆盖 | ✅ 除零 / 空输入 / 数组下标 / 时间戳 NaN 系统性守卫（`annual-report.ts:222-229`、`vector-math.ts:121`、`gateway-core.ts:895`） |
| 依赖重复/未使用 | ✅ 无重复能力库，无未使用依赖（`unzipper` vs `fzstd`、`xlsx` vs `pdfjs-dist` 均为不同能力） |
| 打包白名单 | ✅ 与实际运行时依赖一致，且有 `kb-package-deps.spec.ts` + `bundle-size-report.spec.ts` 守卫 |
| 测试规模 | ✅ 297 个 spec，测试:源码 ≈ 1:1.97，含变异/measure 用例 |

---

## 六、本次审查新增（不在 `PERF-BASELINE.md` 台账内）

1. `installWhisperEngine` / `downloadLayaModel` / `wechat:llm-models` 三处出网漏闸（P0-2）。
2. `overview-panel.tsx` 每约 10s 重算无缓存 ledger + storage（P2-4，**需真机打点确认**）。
3. `disposeLayoutWorker()` 定义但无调用（P3-13）。
4. `getImageDataUrlsBatch` 未在 `LONG_CALL_METHODS`（P3-12）。
5. `main.js` 已到 1000 行零余量（P0-4）。
6. `gateway-core.ts` 三处孤立 JSDoc（P3-7）。
7. `unified-search.ts` 的 `catch { return [] }` 同时是「连接泄漏 + 读失败当空数据」双重问题（P0-1 ∩ P1-1）。

---

## 七、按优先级排序的改进清单

打分口径：影响（用户可感 / 数据正确性 / 安全）× 概率 × 修复成本。**「守卫先于实现」**：每条落地都应配 §八 的四件套。

### 第一批（建议本周内，全部为「低风险 × 高收益」）

| 序 | 动作 | 位置 | 工作量 | 验收 |
|---|---|---|---|---|
| 1 | 抽 `withDb()` 并改造 6 处泄漏点 | `unified-search.ts` ×4、`voice.ts` ×2、`search-scaffold.ts` ×3 | 0.5d | 新 spec + 变异必须咬住 |
| 2 | 补 3 处出网闸门 | `voicellm.ts:63`、`laya.ts:144`、`ipc-wechat.js` | 0.5d | `s07-outbound-switches` + 改造覆盖测试判据 |
| 3 | `cachedFetch` 改真 SWR | `cache.ts:175-189` | 0.5d | 9 个接口切回 0 等待；spec 断言命中不 await |
| 4 | `apiGetLedger` 加缓存 + 收窄 `invalidateSnapshotCache` | `api-read.ts:363`、`cache.ts:97` | 0.5d | 撤销条 #1（先真机打点确认） |
| 5 | `queryGraph` 分片只开一次库 + 加 `cachedBySig` | `graph.ts:92-104` | 1d | 冷跑 866ms → ~100ms；二次 0ms |
| 6 | `privacy.ts` 正则外提 + 后端加缓存 | `privacy.ts:171` | 0.5d | 1020ms → 二次 0ms |
| 7 | 核实并处理 `main.js` 1000 行 | `main.js` | 1d | M21 绿且有 ≥50 行余量 |
| 8 | 统一 `fmtTime` / `fmtBytes` | 9 处 | 0.5d | 一致性检查扩到后端 |

### 第二批（本迭代）

| 序 | 动作 | 位置 | 工作量 |
|---|---|---|---|
| 9 | 后端 `Result<T>` 契约（先 `sync.ts:47` + `unified-search.ts`） | 见 P1-1 | 1d |
| 10 | `xlsx` 换 CDN 版 | `package.json` | 0.5d |
| 11 | 重读查询注入 `AbortSignal` + 分片级让出 | `query/{privacy,graph,ledger,storage}.ts` | 2d |
| 12 | `openPath` / 导出路径限根 | `gateway-read.ts:414`、`export-flows.ts:143/335` | 0.5d |
| 13 | `wechat:call` 接 zod `safeParse` | `wechat-host.js:642` | 1.5d |
| 14 | 补 `decrypt-all` / `payments` / `calendar` spec | `query/` | 1.5d |
| 15 | `file:` 依赖溯源表 + `sync-deps.mjs` | `src/backend/deps/` | 1d |
| 16 | `readRenderCache` 加 TTL + 上限 + 失败可见 | `cache.ts:103-118` | 0.5d |
| 17 | `usePagedList` `refresh` 节流 + 页数上限下调 | `hooks.tsx:267,404` | 0.5d |

### 第三批（排期）

| 序 | 动作 | 工作量 |
|---|---|---|
| 18 | 拆 `moments-panel.tsx`（单函数 917 行） | 1.5d |
| 19 | 拆 `chats-view.tsx`（150+ state 解构） | 1.5d |
| 20 | `GatewayCore` 职责拆分（LLM 工厂 / 隐私闸 / 调度各成协作者） | 3d |
| 21 | 解开 3 组循环依赖（api / export / search 家族） | 1.5d |
| 22 | 长列表虚拟化推广（朋友圈/文件/收藏） | 2d |
| 23 | 统一缓存失效契约（`invalidate + notify`） | 1d |
| 24 | DB 连接纪律用 ESLint `no-restricted-syntax` 固化 | 0.5d |
| 25 | 补架构总览 / CONTRIBUTING / 部署说明 / 错误码表 + README 索引 | 1.5d |

### 第四批（择机 / 卫生）

P3-1 ~ P3-20 逐条清理（多数 0.2-0.5d/条），建议**与相邻功能改动合批**，不要单开一轮。

---

## 八、落地纪律（本项目既有约定的复用）

每条修复按项目已验证的「四件套」推进，缺一不可：

1. **锚点**：定位到**目标函数体内**，不要全文匹配——`privacy-audit.ts` 的孪生行曾让 M25 变异「没咬住」。
2. **契约**：spec 断言切片到分支（`sliceBetween`），跨花括号用 `[^}]`、**禁 `[\s\S]*?`**；每条配**反例 + 防空转哨兵**（`atLeast`）；注释里的字样不算代码（先 `stripComments`）。
3. **守卫**：新 spec 归位（`query/**` 归 `wechat-data/tests/`，`panels/` 归 `ui-wechat/**`）；**纯上色的 CSS 类不许声明 `display`**（改 UI 时）。
4. **变异**：条目加进 `scripts/mutations-registry.mjs` 的 `MUTATIONS`（`from` 必须唯一；表与跑手分文件是 2026-09-26 起的，见「本轮新发现」⑬③），跑 `npm run check:mutation` 确认**必须变红**且**逐字节还原**。

收口链：`typecheck`（5 套）→ 目标 spec → `build:ui`（**必跑**，CSS Modules 错只在 postcss 暴露）→ `build:backend` + `build:types` → 全量 `vitest run`（基线 = 12 failed 全为环境类，口径"不新增失败"）。

⚠️ 本机注意：改同一文件多处用**带「恰好 1 次」断言的批量脚本**（多个 Edit 会互相覆盖）；`git commit` 用 `-F <file>`。

---

## 九、未能确认 / 需实测

| 项 | 原因 | 建议 |
|---|---|---|
| `overview-panel.tsx` 每 10s 重算的实际代价 | 由实测数字 + 订阅逻辑推导，未真机打点 | 用 `python working/run.py probe-*` 或 `app.log` 的「慢调用」记录确认 |
| `pdfjs-dist@6.3.289` 的 CVE 状态 | 版本号非主流 npm 序列 | 以官方 advisory 复核 |
| `GatewayCore` 拆分是否触犯协议层约束 | 依据仓库内注释与守卫用例推断（`gateway-core.ts:5-8`、`tests/gateway-remote-surface.spec.ts`），**未运行协议层验证** | 动手前先跑一个「拆出协作者后 172 个 `@Remote` 是否仍被发现」的探针 |
| `app.asar.unpacked/**` 完整性覆盖 | `docs/RELEASE-PLAN.md` H10 遗留（改 wasm 一字节仍能启动）+ `signExecutable:false` | 采信文档，未在本机复现 |
| 6 个零 spec 模块的实际风险面 | 仅按「该模块名被任何 spec 引用次数 = 0」判定 | 补测时优先 `decrypt-all` / `payments` |
| 扇入统计口径 | 按 import 路径**末段**聚合，同名文件（`types.ts` / `api.ts`）会合并计数 | 需要精确数字时按完整路径重算 |

---

## 十、审查过程中的方法学备注

- 5 路并行审查中有 1 条结论被**证伪并修正**：`moments-panel.tsx` 曾被初判为「多个超长函数」，回读后确认是**单函数（`MomentsPanel`）跨整个文件**，报告已按实际修正。
- 另有 1 条被**限定范围**：循环依赖检测的初版脚本命中了 `export-io.ts:5`、`api-core.ts:153`、`search-scaffold.ts:5` 等「注释里的 `from '…'` 字样」假环，逐条回读后剔除，只保留真实值 import 双向边。⇒ **任何静态分析脚本在本仓都必须先剥注释**。
- 所有 ✅ 标记项均已用 `Read` / `Grep` 回读真实代码确认；未回读而采信 agent 结论的项，已在 §九 单列。
