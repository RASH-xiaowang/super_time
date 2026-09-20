import { defineConfig } from 'vitest/config'

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
    // CI 上把并行度压到 2（2026-09-20）：runner 核少且与别的任务共享，几个重文件同时跑时
    // 会有 worker 长时间抢不到 CPU，vitest 的内部 RPC（`onTaskUpdate`）因此超时 ——
    // 症状是「用例全部通过、退出码却是 1」加 3 条 `[vitest-worker]: Timeout calling`，
    // 在本地（核多）复现不出来。不彻底串行，是因为夹具改成单事务插入后整批已快约 4 倍
    // （本机 35s → 8.5s），限到 2 就够把 CPU 还给正在跑的那一个。
    maxWorkers: process.env.CI ? 2 : undefined,
  },
})
