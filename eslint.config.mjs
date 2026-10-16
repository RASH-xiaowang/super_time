/**
 * 只装一条纪律：**一条连接只能有一个所有者**（CODE-AUDIT-2026-09-26 §七 #24，用户 2026-09-27 授权）。
 *
 * ## 报告给的原话是「用 ESLint `no-restricted-syntax` 固化 P0-1 那条 DB 纪律」——做不到，实测为证
 *
 * P0-1 的形状是「`try` 里打开连接、close 只写在成功路径上」，异常路径必然漏
 * （本机 Node 24 / win32 实测：同进程只要还剩一条连接开着，`unlinkSync` 就 EBUSY 且重试无效，
 * 所以「漏 close」不是抽象的资源问题，而是「解密目录 / 备份再也替换不掉」）。
 * 要判它必须回答「这条句柄在 catch / finally 里**够不够得着**」—— 那是**作用域与数据流**问题，
 * 而 `no-restricted-syntax` 只有语法树。把选择器按直觉写成
 * `TryStatement > BlockStatement NewExpression[callee.name="DatabaseSync"]` 会得到
 * **68 处命中**（收窄成「try 块里直接声明」也还有 **32 处**），而它们大多是本项目**推荐**的写法：
 *
 *     try { const db = new DatabaseSync(p); try { …干活… } finally { db.close() } } catch { … }
 *
 * 外层 try 负责「打开失败就别进来」，内层 try/finally 负责「进来了就一定关」——这是对的。
 * 所以那一条闸门真装上，第一件事就是把 32 份正确代码判成缺陷，然后被人 `--no-verify` 掉。
 * **账本仍然在** `src/backend/wechat-data/tests/query-db-lifetime.spec.ts`（三层：真跑行为 /
 * AST 棘轮 / 反脆弱清单），它做的是「close 出现在哪条路径上」的分析，语法工具做不了。
 *
 * ## 那这里这两条买的是什么
 *
 * 挑的是**纯语法就判得准、今天零命中、且 spec 完全没有覆盖**的两个形状（都属 P0-1 同族）：
 *   R1 `withDb(...)` 的回调里又自己 `new DatabaseSync(...)` —— 同一次读有两个连接所有者，
 *      而 withDb 只关它自己那一个 ⇒ 多开的那条没人关。spec 的棘轮认的是「close 放在哪」，
 *      对这种「压根没有 try」的站点只给出「函数里根本没有 close」这一格，不如这条直说。
 *   R2 把 `async` 回调交给**同步版** `withDb` / `withWritableDb` —— 这是账本里为 `withDbAsync`
 *      写明的坑：回调一 `await`，控制流就交回事件循环，而 withDb 的 `finally` 不会等它，
 *      连接在**第一次让出时**就被关掉；表现是「小库恒绿、大库偶发 database is not open」。
 *      TypeScript 拦不住（`T` 会推成 `Promise<…>`，签名照样成立），所以这条有真活干。
 * 两条都是**保存时就响**：编辑器与 `npm run lint:db` 在写的那一刻挡下，而不是等一次几分钟的 `npm test`。
 *
 * ## 作用域为什么只有生产源码
 *
 * `src/backend/wechat-data/tests/**` 里的夹具有正当理由写出奇怪形状（造一条注定失败的连接、
 * 直接开库验锁行为）；`lib/` 是构建产物、`deps/` 是 vendored 上游包（改它们要走上游，不是本仓纪律）。
 *
 * ## 为什么 CI 不另开一步
 *
 * `npm test` 里的 `eslint-db-discipline.spec.ts` 用 ESLint 的 API 把**这份配置**跑在真实生产树上
 * （并断言它覆盖到的文件数、正反例都各验一遍），所以这一步在不在 `ci.yml` 里都拦得住；
 * 单开一步只会让 CI 多装一次解析器。要人手工跑着玩，才有 `npm run lint:db`。
 */
import tsParser from '@typescript-eslint/parser'

/** 生产后端那棵树；`eslint-db-discipline.spec.ts` 会核对配置里的这条 glob 与它期望的一致。 */
export const DB_DISCIPLINE_FILES = ['src/backend/wechat-data/src/**/*.ts']

/** 三个「连接由 withDb 一族负责」的入口名（R1 要全覆盖，R2 只许覆盖两个同步版）。 */
const WITH_DB = '^(withDb|withDbAsync|withWritableDb)$'
const WITH_DB_SYNC = '^(withDb|withWritableDb)$'

export default [
  {
    name: 'supertime/db-handle-ownership',
    files: DB_DISCIPLINE_FILES,
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    linterOptions: {
      // 本仓有两处 `// eslint-disable-next-line no-control-regex`（剥控制字符的正则确实需要它），
      // 而这份配置刻意**只**装 DB 这一条纪律、不开 `no-control-regex`。
      // 于是那两条注释会被报成「没用上的豁免」。它们记的是**作者的意图**，不是噪声，
      // 等哪天把 no-control-regex 装进来，它们就自动变成承重件。
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `CallExpression[callee.name=/${WITH_DB}/] NewExpression[callee.name="DatabaseSync"]`,
          message:
            'withDb / withWritableDb 的回调里不许再自己 new DatabaseSync：外层那条连接由 withDb 负责关，你多开的这条没人关（同一次读出现两个所有者，正是 P0-1 那一族）。要读另一个库就在外面再套一层 withDb；要同一连接做两件事，把它作为参数传进回调。',
        },
        {
          // `:matches(箭头函数, 函数表达式)`：只写 ArrowFunctionExpression 会漏掉 `async function (db) {}`
          // 那种写法（实测漏），而漏掉的那半恰好是最容易顺手写出来的。
          selector: `CallExpression[callee.name=/${WITH_DB_SYNC}/] :matches(ArrowFunctionExpression[async=true], FunctionExpression[async=true])`,
          message:
            '同步版 withDb / withWritableDb 不接受 async 回调：一 await 就把控制流交回事件循环，而 withDb 的 finally 不等它 —— 连接在第一次让出时就被关掉，表现是「小库恒绿、大库偶发 database is not open」（TypeScript 拦不住，T 会推成 Promise）。改用 withDbAsync，它就是为了跨 await 还关得掉连接而存在的。',
        },
      ],
    },
  },
]
