# Super Time 深度代码审查报告

- 日期：2026-09-26
- 版本基线：`package.json` version 1.0.7
- 方法：5 路并行只读审查（架构耦合 / 代码质量 / 安全隐私 / 性能资源 / 错误处理+依赖+可测试性）→ 对每条高危结论**回读真实代码交叉验证**（本报告所有 ✅ 标记项均已亲眼复核）
- 口径：统计一律为实测（Grep / Glob / 逐文件读取），未估算；`src/backend/deps/**` 为 vendored 上游代码，单列不计入自有代码统计

---

## 先读这里：本轮整改状态（2026-09-26 同日，逐条对到 §七）

口径：**每条都是「修复 + 行为守卫 + 棘轮/接线守卫 + 变异自证」四件套齐全才记完成**；
`check:mutation` 与全量 `vitest` 当场跑过（终态：**292 文件 / 2945 用例**全绿（其中 9 文件/14 用例按环境跳过），
5 套 typecheck 全绿，变异 82 条、登记到 M85）。

| 清单项 | 状态 | 落点（提交） | 备注 |
|---|---|---|---|
| 第一批 #1 P0-1 DB 句柄泄漏 | ✅ 完成（超出清单） | `75f5057` | 报告列 9 处，AST 复查后同一批文件实为 16 处；新增 `query/db-open.ts#withDb` + `query-db-lifetime.spec.ts`（用「跑完之后库文件可删」量泄漏，含故意不 close 的反例哨兵）+ 变异 M56。**报告未列出的同类站点**：AST 全仓扫出 69 处候选 → 逐条回读后 **35 处**是真漏（分布在 22 个文件），已建成**只能变小的棘轮清单**（`KNOWN_UNFIXED`），后续每修一处必须删条目 |
| 第一批 #2 P0-2 三处出网漏闸 | ✅ 完成 | `dd837d3` | 三个点各补 `privacyBlocked`/`blockOutbound`；**判据已按第 3 条换掉**：新增 `outbound-site-coverage.spec.ts` 枚举全仓 15 个 `fetch`/`fetchWithRetry` 调用点成台账（新出网点不登记就红）；行为验收 `outbound-gates.spec.ts`（开关打开 ⇒ 一次请求都不发 + 反例）+ `ipc-wechat.spec.ts`（`wechat:llm-models` 被拦时不漏 Key、拿不到开关时 fail-closed）；变异 M26（既有，复跑仍咬）/M57/M58/M59 |
| 第一批 #3 P0-3 cachedFetch 真 SWR | ✅ 完成 | `8638199` | 命中即回 + 后台刷新；**两个收敛条件**（同键并发只发一次、值没变不写不广播，否则订阅者自转成环）；判据取「永不 resolve 的 fetcher」不量时间；`chats-thread` 订阅 `:messages` 族事件把「通知」补齐成闭环；变异 M60 |
| 第一批 #4 P2-4 ledger 缓存 + 收窄失效 | ✅ 完成（**打法与报告不同**） | `9ca21b2` | ① `apiGetLedger` 加 `cachedGet`（按月分键）＝报告原方案；② **没有**把 `invalidateSnapshotCache()` 改成按前缀收窄 —— 数据事件的语义就是「全部快照都旧了」，收窄会漏刷该刷的键，真正的代价在「清表 ⇒ 下次全部回源」，所以改成**标记陈旧**（旧值立刻可画、复验进后台、成功才写回并通知、超 5 分钟的旧值丢弃）；判据 `cache-invalidate-stale.spec.ts` 8 条 + 接线两条，变异 M69/M70。**如实标注**：报告要求的「先真机打点」没做，每 10 秒重算这条账是读代码得出的因果链，不是实测数 —— 若日后打点发现账本重算不在这 10 秒里，这条要回头改 |
| 第一批 #5 P1-3 queryGraph | ✅ 完成 | `1b49ad4` | 分片只开一次库 + `cachedBySig`；验收是**开合数**（`[算料]` 3 会话 11 次 = 9 会话 11 次；旧形状是 6 vs 18 的形态）+「第二次一次库都不开」+ 反向「数据变了签名必须变」；变异 M63/M64 |
| 第一批 #6 P1-4 privacy 正则 + 缓存 | ✅ 完成 | `1b49ad4` | `SCAN_RES` 外提 + `cachedBySig`（`rowBudget` 进键）；验收是「扫描期间 `RegExp` 构造次数 == 0」；变异 M62 |
| 第一批 #7 P0-4 main.js 1000 行 | ✅ 完成 | `2c1c258` | 999 → **821 行**（余量 179）。窗口本体与守卫外提成 `src/backend/main-window.js`；**真机验收**：`ui-e2e-smoke` 改前改后都全绿、`security-guard:smoke` 10 项全绿（含 `did-create-window` 计数恒 0）；顺手补了 §五 那道空档——安全基线此前**只被人眼看过一次**，新增 `electron-security-baseline.spec.ts` + 变异 M61 |
| 第一批 #8 P3-1/P3-2 fmtTime/fmtBytes | ✅ 完成 | `本次` | 4 份 `fmtTime` **全部删除**（单位写进名字：`fmtLocaleSec` / `fmtLocaleMs` / `fmtTodayOrLocaleMs`），5 份字节格式化收敛到两份唯一出处（渲染层 `utils/format.ts`、后端 `src/format.ts`，口径逐字一致）。守卫 `format-single-source.spec.ts` 按 AST 判「函数体里有没有单位换算本身」⇒ 薄适配器不误报；`NEVER_TWICE` 是零容忍档，`KNOWN_SECOND_TIME` 是**只能变小**的棘轮（还剩 7 份形状各异的日期函数）；判据本身有自证用例。行为守卫两份（`utils/format.spec.ts` 钉「单位喂错**必须**渲染成别的东西」——这是命名唯一的防线；`wechat-data/tests/format.spec.ts` 钉同一张字节表）；变异 M75/M76/M77 |
| 第二批 #13 之外的安全项 P2-6 路径限根 | ✅ 完成 | `348a70a` | `query/path-policy.ts`：`openPath` 只放行数据根之内或**应用自己写过产出的目录** + 可执行扩展名一律拒；导出两处落盘前过 `writeDenialReason`。被拒回理由（`error?` 新字段，`docs/API.md` 已重生成）。判据含「`openNativePath` 探针一次都没被调用」；变异 M65/M66 |
| 第二批（清单未列，同批做掉）P1-1 读失败契约 | ✅ 完成 | `e6f4b76` | 后端把「库打不开/读失败」与「确实没有条目」分成两件事（`DirListing.error` / 全域搜索的 `readError`），面板必须区分显示；守卫 `read-error-visibility.spec.ts` 从**类型**推「哪些快照带 `readError` ⇒ api 层哪些包装 ⇒ 调用它们的面板必须自己提到 `readError`」，新接口忘读就红；变异 M67/M68 |
| 第二批 #16 P2-5 readRenderCache | ✅ 完成 | `285c9ac` | 24 小时保质期 + 单条 1.5 MB 上限 + 写失败从静默变成「说一次并丢干净」（超大与配额两种原因分开记账，不互相静音）；判据 `render-cache-ttl.spec.ts`，变异 M73/M74 |
| 第二批 #17 P2-8 usePagedList 自动刷新 | ✅ 完成 | `aee1e6f` | 节流（30 秒内不重复起）+ 同键合并 + 页面不可见不发 + 上界装不下就**整轮跳过**（不再静默截断成前 8 页，那会把「已刷新」画成假话）；判据 `paged-list-refresh-gate.spec.ts`，变异 M71/M72 |
| 第二批 #13 P2-7 `wechat:call` 入参校验 | 🟡 ① 档硬拒已上线，② 档是**有证据要求的影子** | `本次` | 新增宿主层 `wechat-args-guard.js`（+ `.d.ts`，按 H11 口径不给 `any`）：① **结构与体积**总是拒（参数个数/嵌套深度/数组项数/单串与累计体积/环/function/symbol/bigint/NaN/非纯对象），二进制按 `byteLength` 记账**不逐元素遍历**；接线在 `wechat-host.js` 的 `call()` 里、排在 `fn.apply` 之前，且归一化后的 `callArgs` 才是缓存键用的那份。② **形状**（生成的 114 份 zod schema）默认只记账，进了 `ENFORCED_SCHEMA_METHODS` 才拒 —— 因为这份生成物**从未被执行过**，没有证据就硬拒的结果是某个面板当场坏掉；`unrecognized_keys`（面板多发一个后端还不认的键）永远不算失败，保住向前兼容。**判据**：`wechat-args-guard.spec.ts` 12 条，含「被拒的调用一次都不许碰到 gateway」（把实现换成计数器来量，不靠读日志）、边界成对（防上界被悄悄调成无限）、8MB buffer 遍历耗时 <100ms、接线级判据、以及**覆盖账本 `[算料]`**：172 个 `@Remote` 里 schema 只覆盖 114，未覆盖 **58** 已钉成只能变小的棘轮（新加方法不生成 schema 就红）。变异 M82–M85 |
| 第四批（部分）P3-7 / P3-12 / P3-13 / P3-19 | ✅ 完成 | `2570230` | 三处孤立 JSDoc 归位/删除；`getImageDataUrlsBatch` 进 `LONG_CALL_METHODS`（此前批量取图被 60s 误杀成整批失败）；`disposeLayoutWorker` 挂到图谱页签卸载；README 视图数 40 → 实测 90 |
| 第二批 #10 P1-6 xlsx | 🟡 改判据不动依赖 | `上一提交` | 换 SheetJS CDN 源是**依赖面变更**（要联网重装 + 重验知识库链），本轮不擅自做；先把「这个项目会不会被那条路径打到」变成可执行判据：`xlsx-parse-hardening.spec.ts` 钉住每处 `sheet_to_json` 都是 `header: 1`（用户单元格永远当值不当键 ⇒ CVE-2023-30533 的键名入口是关着的）+ 真解析两份夹具前后对比 `Object.prototype` |

### 剩余（按 §七 的批次，未在本轮）

- 第一批：**已全部做完**（#1–#8）。
- 第二批 #9 后端 `Result<T>` 契约（`sync.ts:47` 优先）、#10 xlsx 换源（需授权）、#11 重读查询注入 `AbortSignal`、
  #14 六个零 spec 模块补测、#15 `file:` 依赖溯源表。
- 第二批 #13 的**后半**：`ENFORCED_SCHEMA_METHODS` 目前是空集 —— ② 档（按 schema 硬拒）要等
  `info().argGuard.mismatched` 在真实使用里稳定为空才升级，这是刻意留下的证据门槛，不是漏做。
- 第三批 #18–#25（拆巨型组件、`GatewayCore` 职责拆分、解循环依赖、长列表虚拟化、统一失效契约、
  DB 纪律 ESLint 固化、四份新文档 + README 索引）。
- 第四批其余 P3（`isMd5` 10 处、`normalizeAesKey` 6 处、图片解码三兄弟、同概念三名、地图开关镜像…）；
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
4. 变异条目（`scripts/mutation-check.mjs` 的 `MUTATIONS`）：把 `withDb` 的 `finally` 改成「只在成功路径 close」，**必须变红**。

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
4. **变异**：条目加进 `scripts/mutation-check.mjs` 的 `MUTATIONS`（`from` 必须唯一），跑 `npm run check:mutation` 确认**必须变红**且**逐字节还原**。

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
