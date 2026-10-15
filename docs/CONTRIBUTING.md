# 贡献指南

这个仓库的"规矩"大多不是风格偏好，而是**某次踩坑之后加的判据**。下面按"改之前要知道什么"来排，
每条都给出对应的机检位置（能在仓库里跑到的命令或文件）；没有机检的会写"仅约定"。

## 1. 起步

```bash
npm ci          # 含 file: 内联依赖，别用 npm install
npm run dev     # 构建前端 + 后端 bundle + 类型声明后启动 Electron
npm test        # 单测（不联网、不依赖真实微信数据）
```

平台只有 Windows x64（原生依赖只有一份 win32-x64），Node 22（与 CI 同版）。
本机跑起来还需要一份许可证，签法见 README「本地跑起来需要一份许可证」；
调试期也可以用 `SUPERTIME_SKIP_ONBOARDING=1` **仅在非打包态**跳过三道闸门（[`../src/backend/debug-gates.js`](../src/backend/debug-gates.js)）。

## 2. 提交前的收口链

按这个顺序跑，每步都给出"为什么在后面"：

```bash
npm run typecheck          # 5 棵树：后端 / ui-wechat / ui-app / checks / tests
npm test                   # 全量 vitest
npm run build:backend      # 改了后端 src 就必须重建 bundle
npm run build:types        # 改了后端导出就必须清空并重生成 lib/types
npm run docs:api:check     # 方法面变了要先跑 npm run docs:api 再检
npm run check:shim         # 前端 shim 与源码逐字节一致
npm run lint:db            # 唯一一条 ESLint 闸门：连接的所有权（1.7 秒）
```

`lint:db` 只管**语法判得准、且今天零命中**的那两种形状（`withDb` 回调里再开一条、把 `async` 回调交给同步版 `withDb`）。
它不接管"close 放在哪条路径上"那本账 —— 那是作用域分析，`no-restricted-syntax` 表达不了，
账本仍在 [`../src/backend/wechat-data/tests/query-db-lifetime.spec.ts`](../src/backend/wechat-data/tests/query-db-lifetime.spec.ts)
（为什么这么分工、以及按直觉写会误伤哪 32 处推荐写法，都记在 [`../eslint.config.mjs`](../eslint.config.mjs) 的头注里）。
CI 不另开这一步：`npm test` 里的 `eslint-db-discipline.spec.ts` 会用 ESLint 的 API 把同一份配置跑在真实生产树上。

CI 会重跑同一套并把"临时目录重建后与当前工作树逐字节一致"当门禁 —— **改后端 `src` 就要把 `lib/`（和 `docs/API.md`）一起提交**，
否则门禁红。

## 3. 每个修复要交四件东西

1. **修复本身**（不是只加判据绕过）；
2. **行为判据**：断言"用户可观察的结果"，而不是断言源码里有某个字符串。
   例：DB 句柄泄漏的判据是"跑完之后整棵数据树仍可删"（Windows 上句柄没关就是 EBUSY），
   见 [`../src/backend/wechat-data/tests/query-db-lifetime.spec.ts`](../src/backend/wechat-data/tests/query-db-lifetime.spec.ts)；
3. **棘轮或接线守卫**：新增不许变多、搬出去的不许没人挂。
   接线守卫最容易失手的地方是"搬完失去靶子"——组件搬进新文件后，按文件名死读源码的守卫会静默变绿，
   所以守卫要么读**联合**（`test-helpers/chats-source.ts` 那类前缀扫描），要么显式列出所有分片；
4. **变异自证**：把修复改回坏形状，判据必须红。

```bash
npm run check:mutation -- --only M5   # 前缀匹配；--only 省略则跑全表
```

登记表在 [`../scripts/mutations-registry.mjs`](../scripts/mutations-registry.mjs)（主表 + 按主题拆分的 `mutations-registry.batch3*.mjs` 多份分片）。
切一份就要在 `MUTATIONS` 里聚合一份 —— **忘了聚合不报任何错**，只会让那批条目悄悄消失；
兜它的是 `mutation-registry-anchors.spec.ts` 里那个只许涨的 `REGISTRY_MIN`，所以**每登记一条就把那个数抬上去**。
写变异条目的四条硬规矩（都被实际踩过）：

- 锚点在目标文件里**恰好命中一次**，且指定的判据文件还在（[`../src/backend/tests/mutation-registry-anchors.spec.ts`](../src/backend/tests/mutation-registry-anchors.spec.ts) 机检）；
- 多行锚点在 CRLF 文件里命中 0 次 —— 看起来像"锚点腐烂"，其实是行尾符；**新锚点一律收成单行**；
- `why` 文本里不要放裸的 ASCII 双引号（会崩掉整份 JS 登记表），要引用就用「」；
- 注入后的 `to` 必须**让文件还加载得了**，否则报出来的是"语法假咬"，测不到任何东西。

变异不咬时先问一句"这处代码到底承不承重"：下游有第二层 clamp 时，你注入的是一个**等价变异**，
该换靶子而不是放宽判据。

## 4. 棘轮只许变小

清单类判据（`KNOWN_UNFIXED`、函数行数棘轮、文件体积棘轮、测试目录零类型错误…）的口径是
**只能变小、不能变大**，且"改代码把某项修好了"必须**同时把清单改小**——
留在清单里的数字是按文件记账的，把清单清空不等于代码修好了。

反过来，函数因为加了两行注释而"长大"被拦时，**删注释是错的方向**（那条 why 正是下一个人判断的依据）：
把理由压到行尾或挪到模块头，让函数回到原来的尺寸、一个字不少。

## 5. 判据的写法

- **一律走 AST**，不走正则扫文本：注释里出现 `from './x.ts'`、`db.close()`、`node:fs` 这类字样会误报，
  本仓已三次栽在这里。剥注释的文本判据要写明"先归一 CRLF 再去注释"（两处顺序反了就对不上锚点）。
- **存在性断言等于没断言**：任何"清单为空 ⇒ 全绿"的判据必须配一格反例自证
  （合成的坏源码必须被抓到）。豁免分支同理——写一格豁免就先证明它会被走到。
- **幻影引用有守卫**：注释里写"这条由 X 把关"，X 必须真的存在
  （[`../src/backend/tests/phantom-reference.spec.ts`](../src/backend/tests/phantom-reference.spec.ts)）。
  只在"承诺语境"里查（前后 40 字内出现 由/见/判据/守卫/把关/钉 等词），否则信噪比会让闸门被关掉。
  写文档时同样适用：指不出真文件的说法，就写成说法，别写成引用。
- **文档里的引用也机检**：相对链接目标、反引号里按仓库根写的路径、文中出现的 `npm run X`、
  错误码表登记的机器码与逐字中文串，四类都必须能在仓库里落到实处
  （[`../src/backend/tests/docs-index.spec.ts`](../src/backend/tests/docs-index.spec.ts)）。
  改了错误文案或删了某个码，这份会红 —— 那是**提醒你把文档一起改**，不是判据写错了。
- **批量改写注释/文档里的引用要当高危操作**（2026-10-08 实测连踩三次）：
  正则能匹配"形状"但**不知道哪一部分是内容**。三种坏法各出现过一次 ——
  ① 只删掉文件路径、把 `§2.4` / `通道④` 这类**章节号**留下来 ⇒ 变成"见 §2.4"这种指向虚无的引用，
     比原引用更有害；② 连带吃掉闭合括号 ⇒ 改坏 `describe()` 之类的调用（`npm run typecheck` 会抓到，
     但那是运气好）；③ 空反引号 ` `` ` 与空括号 `（）` 残留，读起来像写坏了。
  正确姿势：**手改**；非用脚本不可时，把「路径 + 尾随章节号」当**一个整体**匹配，
  改完**逐行审 `git diff`**（不是看统计行数），并跑一遍「孤立章节号 / 空括号 / 空反引号」的残留检查。
  再加一条：这类活最容易被自己的机器检查漏掉 —— `phantom-reference.spec.ts` 只查"承诺语境"，
  而 `§2.4` 这种残留在它眼里根本不是一个路径。
- **一次性脚本放 `working/`**（已 gitignore，目录不存在时自己 `mkdir`）。它们不进 CI，
  产物必须 `git diff` 回读；"脚本报成功"不算——它可能 exit 0 而一个字没改。
  ⚠️ `working/` 里的东西**不入库**，所以它随时可以被清掉；清掉前确认没有还想留的产物
  （它历史上堆过 1.29 GB：13 个 `_trash-*`、全量测试日志、`.asar` 探针产物）。

## 6. 分层与目录

见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 第 2 节。两条被机检的：

- 后端/宿主不许 `import` 前端源码（读源码文本做断言可以）；
- 读盘的测试辅助住在 [`../src/client/ui-wechat/src/client/test-helpers/`](../src/client/ui-wechat/src/client/test-helpers/)，
  `pages/**` 的非 spec 文件不许出现 `node:` 内建 import。

面板目录（`panels/`）的分工约定：状态与副作用在钩子里、纯算术在 `.ts`、渲染在 `.tsx`，
三份各自有 spec；`*.wiring.spec.ts` 只负责"接上了没有"。

## 7. 测试里的环境口径

- 单测**不联网、不碰真实微信数据**：数据一律用临时目录里的合成 SQLite（`node:sqlite`）。
- Windows 特有：句柄没关 → `unlinkSync` EBUSY / `rmSync` EPERM，且重试无效 —— 这是泄漏探针的基础。
- jsdom 三条：复选框要派发 `click` 不是 `change`；受控 `<input>` 改值必须走
  `HTMLInputElement.prototype` 的 value setter；`mouseenter/mouseleave` 是合成在冒泡的
  `mouseover/mouseout` 上按 `relatedTarget` 判进出的。
- 需要看中间态的用例不许依赖事件循环推进（`await setImmediate` 在并发跑时会饿死采样）——
  用有界同步自旋 + deadline。
- **本机是 Windows PowerShell 5.1，两个坑实测踩过**（2026-10-08）：
  ① **`git show <ref>:<path> > file` 会写成 UTF-16LE**，随后 `node` / `fs.readFileSync(..., 'utf8')`
  读到的是乱码 —— 症状极具误导性：正则 `^\|` 一条都匹配不上、文件大小正常、报错指向"格式变了"。
  正确写法：`git show <ref>:<path> | Out-File -Encoding utf8 file`，或让 node 直接读
  `execFileSync('git', ['show', ...])` 的返回值。
  ② **PowerShell 5.1 没有 `Join-String`**，`%` 的 `ForEach-Object` 里拼路径会直接解析失败；
  这类活交给 node 脚本更稳。（另：`Get-Content | Measure-Object -Line` 数出来的行数与
  按 `\n` split 的行数**不一致**，别拿它当行数棘轮的判据。）
  ③ **`Set-Content -Encoding UTF8` 会写 BOM**（5.1 没有 `-Encoding utf8NoBOM`）——
  拿它写提交信息文件再 `git commit -F`，`git log --format=%s` 的标题就以一个
  不可见的 `U+FEFF` 开头，看着完全正常，只有把标题首字符取码点才看得见（`f` 应为 102）。
  改用 `[System.IO.File]::WriteAllText($p, $msg, (New-Object System.Text.UTF8Encoding($false)))`。
  同理，仓库里的源码与 `.mjs` 登记表现役换行是 **LF**（不是 CRLF）；写多行变异锚点时
  锚点里的换行也要用 `\n`，否则 `mutation-check.mjs` 会报「锚点命中 0 次」而拒绝执行。
- **模块级缓存 + spec 共用常量 = 假红**：同一进程里连着跑两轮、而某个"上次做过"的记录是模块级
  Map/计时器时，第二轮会被那道闸门静默吞掉。症状是"该红的没红"，而且方向相反
  （本轮实测：6 秒 full-decrypt 冷却让 4 条用例全部读到空结果，读起来像功能坏了）。
  用例之间共享模块状态时，**每条用例开头显式清干净**（本仓的做法是导出一组 `forget*()` 供测试调用）。

## 8. 提交信息

格式沿用 `type(范围): 摘要`，范围用报告条目号或模块名，摘要里给出**量化的结果**：

```
fix(#11 句柄棘轮): 清单 14 → 1 —— 余下能改的九份全改完，另抓到一处早退漏
refactor(P3-5): 图片解码三兄弟收成两份公共体，两处有意差异留在调用方
```

正文写"为什么"和"实测到什么"，不写"做了什么"（diff 会说）。审查整改的每一刀都要在
[`RELEASE-PLAN.md`](RELEASE-PLAN.md) 对应条目加一行台账
（含提交号、判据位置、没做完的部分如实写）。

## 9. 仓库里绝不能提交的东西

工作区里有**明文密钥**与签发私钥（`.gitignore` 已覆盖：`wechat/config.json`、`wechat/llm.json`、
`vendor-keys/`、`working/`、`output/`、`dist/`）。因此：

- **不用 `git add -A` / `git add .`**，按文件名显式 add；
- 不打包/备份整个工作区；
- 提交前 `git status --short` 看一遍被暂存的东西，任何像密钥/证书的文件出现就停下；
- 不要 `git reset`、`git stash`、`git checkout .` 这类全仓动作（工作区常有别的在途改动）。

## 10. 放宽一条判据之前

判据放宽 = 有一条缺陷以后可以静默通过。要做的是：

1. 说清它为什么**现在**挡不住任何东西（例：豁免分支根本不会被走到）；
2. 要么删掉那条判据并在台账记下原因，要么给它补一条变异证明它仍在承重；
3. 绝不留"看着红所以注释掉"的状态——被关闭的守卫比没有守卫更糟。
