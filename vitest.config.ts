import { defineConfig } from 'vitest/config'

import { collectTestTimings, fileAccounts, formatBaselineBoard, formatBoard, formatFileAccounts, formatTestBoard, type FileTiming, type ReportTask, type TestTiming } from './src/backend/tests/helpers/slowest-files.ts'

/**
 * 跑完把「最慢的测试文件榜」+「最慢的用例榜」打出来（N36）。
 *
 * 为什么值得占报告器这个位置：CI 那条「用例全过、退出码却是 1」的假红，判据是**单个文件的耗时**
 * 有没有逼近 vitest 硬编码的 60 秒（birpc `DEFAULT_TIMEOUT = 6e4`）。以前这个数只能去 Actions
 * 下日志 zip、解压、去 ANSI、再人肉排序才知道 —— 于是「离线还有多远」这件事没人主动去看。
 * 现在每次运行自己打，并且同一份日志里也有测试自己吐的 `[算料]` 行，倍率能在同一次运行里算
 * （跨运行比出来的是机器容量，不是机制 —— 这条教训见 RELEASE-PLAN 的 N36）。
 *
 * 第二张榜（用例）是被 2026-09-24 那次运行逼出来的：文件榜第一次喊出「`overview.spec.ts` 104.5 秒
 * 已越线」，而它 3 个用例、本机整个文件 68 毫秒 —— 只知道「哪个文件」下一步依然无从下手。
 */
const slowestBoardReporter = {
  onFinished: (files: ReportTask[] = []) => {
    // duration 在 vitest 的不同版本里一会儿挂在 task 上、一会儿挂在 task.result 上；
    // 读错字段的后果是「全 0 的榜看着像没有慢文件」，所以 formatBoard 会自己识破并改打警告。
    const rows: FileTiming[] = files.map((f) => ({
      name: f.name ?? '(无名文件)',
      ms: Math.max(0, f.result?.duration ?? f.duration ?? 0),
    }))
    for (const line of formatBoard(rows, 10)) console.log(line)
    const tests: TestTiming[] = []
    for (const f of files) collectTestTimings(f.tasks ?? [], [f.name ?? '(无名文件)'], tests)
    const fileMs = new Map(rows.map((r) => [r.name, r.ms]))
    for (const line of formatTestBoard(tests, fileMs, 10)) console.log(line)
    // 第三张小表：慢文件的「文件总时长 vs 用例合计」——N36 口径 ② 要的那句「时间不在这次的代码里」
    // 从此对任何文件都拿得出来，不再只有手写过分段墙钟的那一个。
    for (const line of formatFileAccounts(fileAccounts(rows, tests))) console.log(line)
    // 采集「本机基线」时（`npm run ci:baseline` 设这个环境变量）才把**全部**文件打出来：
    // 平时 235 行是噪声，而口径 ① 要把 CI 的数按 A/B 分类，缺的就是这份串行的本机数。
    if (process.env.SUPERTIME_BASELINE === '1') for (const line of formatBaselineBoard(rows)) console.log(line)
  },
}

/**
 * 单测配置（与 vite.config.js 分开）。
 *
 * 为什么不能复用 vite.config.js：那份配置的 root 指向 src/client/ui-app（前端构建），
 * vitest 若加载它会把测试文件的解析根也挪过去，后端 spec 全部找不到。
 *
 * 测试范围：后端包 + 宿主层 + 前端**纯逻辑**模块。都用合成的 sqlite 夹具或假 child，
 * 不依赖真实微信数据、不联网，任何机器上都能稳定跑。前端组件级测试仍只有 SSR 冒烟
 * （scripts/ui-ask-smoke），但状态机类的纯逻辑（如 ask-gate）可以放 *.spec.ts。
 */
export default defineConfig({
  test: {
    include: [
      'src/backend/wechat-data/tests/**/*.spec.ts',
      // 宿主层（main.js 用到的那部分）：CommonJS、不依赖 Electron，可一起跑。
      // 把「调用超时 / 进程死亡收敛」这类只能靠手工 taskkill 观察的分支变成回归用例。
      'src/backend/tests/**/*.spec.ts',
      // 前端**纯逻辑**模块（不 import react / 不碰 DOM，如 chunks/ask-gate 这类状态机）：
      // 组件级测试仍只有 SSR 冒烟，但这些逻辑值得有真正的回归用例。
      'src/client/ui-wechat/src/client/**/*.spec.ts',
      // ui-app 侧的纯逻辑（隐私同意状态、启动引导状态）：同样不 import react、不碰 DOM。
      // 组件本身仍只有 SSR 冒烟，但「未同意就不放行」这类判定必须有回归。
      'src/client/ui-app/**/*.spec.ts',
    ],
    environment: 'node',
    /**
     * `default` 之外再加一份「最慢文件榜」（见上面 `slowestBoardReporter` 的注释）。
     * 报告器抛错会让整轮测试红，所以它只做纯计算与打印 —— 排序与格式化都在
     * `tests/helpers/slowest-files.ts` 里，那边有 7 项单测钉住。
     */
    reporters: ['default', slowestBoardReporter],
    /**
     * spec 里会建库、写文件、跑 PBKDF2，比默认 5s 宽松些。
     *
     * 2026-09-20 由 30s 提到 180s：GitHub 的 windows runner（2 核、共享、带实时扫描）上
     * 同一批用例的整体耗时是本机的 20 倍（整批 1119s vs 本机 50s），于是 `contacts`、
     * `search-cursor`、`gateway-export-stream-progress` 里十几条**本地 <1s** 的用例
     * 齐刷刷报 `Test timed out in 30000ms` —— 30s 把「runner 慢」误报成了「挂死」。
     * 取 180s 是按本机最慢的一条算余量：`search-cursor.spec.ts` 的重夹具用例本机 8.1s，
     * 放大 20 倍即 160s，120s 都可能不够。
     * 代价要说清：真出现死循环时，失败会晚 3 分钟才报出来；换来的是不再把环境噪声当回归。
     * （死锁仍然是红的 —— 只是红得慢一点，不是被放过。）
     */
    testTimeout: 180000,
    hookTimeout: 180000,
    // 这些用例都在临时目录里各建各的夹具，彼此无共享状态，本机可并行。
    fileParallelism: true,
    /**
     * CI 上把并行度压到 **1**（2026-09-21 的 `3337ed6`；此前 09-20 的 `fe8e451` 限到 2）。
     *
     * 症状：「用例全部通过、退出码却是 1」+ 若干条 `[vitest-worker]: Timeout calling "onTaskUpdate"`。
     * 机制（2026-09-24 读的是装进仓库的那份代码，不是推测）：birpc 的 `DEFAULT_TIMEOUT = 6e4` 写死在
     * `node_modules/vitest/dist/chunks/index.B521nVV-.js:3`，而 vitest 传给 worker 的 rpc 选项
     * （`chunks/utils.CAioKnHs.js` 的 `createThreadsRpcOptions`）里**不带** `timeout` ⇒ **60 秒硬编码、
     * 无配置项可调**。`onTaskUpdate` 不在 `eventNames` 里，是一次 await 调用，而那个计时器跑在
     * **worker 自己的**事件循环上 —— 所以「主进程 60 秒没回话」和「worker 自己有 60 秒卡在同步段里、
     * 连回包都来不及处理」两种都会红。本注释早期写的版本只讲了前一种，那是**不完整的**。
     *
     * 更要紧的一处纠正：**「唯一的杠杆是拿掉争抢」这句被后来的事实推翻了**。串行化之后症状照样出现 ——
     * 运行 218 与 220（2026-09-22 12:45 / 12:50）各命中一次，而这两个提交都含 `3337ed6`
     * （逐个用 `git merge-base --is-ancestor` 核过），当值的是跑了 98.6 秒与 60.1 秒的两个文件。
     * 把 45 次失败运行各自的「最大单文件耗时」排开看：**8 次命中每一次都有一个 ≥52.7 秒的文件**，
     * 而 37 次未命中里 35 次的最大值 ≤46 秒（另两次 83s / 62.1s 没命中）⇒ 必要但不充分，正对应
     * 「要真的不把事件循环交还出来」这个机制。真正的杠杆是**缩短单文件里那段同步不让出的时间**
     * （`docs/RELEASE-PLAN.md` 的 N36 记着名单与验收口径）。
     *
     * 那这条为什么还留着：09-20~09-21 那六次都发生在并行期，串行确实把**争抢型**的那一批消掉了，
     * 命中面在变小 —— 但它不是「已修」。代价照旧：整批墙钟更长（作业预算 45 分钟，实测 test 步约
     * 10 分钟量级）。
     */
    maxWorkers: process.env.CI ? 1 : undefined,
  },
})
