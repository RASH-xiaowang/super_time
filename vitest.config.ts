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
    ],
    environment: 'node',
    // spec 里会建库、写文件、跑 PBKDF2，比默认 5s 宽松些。
    testTimeout: 30000,
    hookTimeout: 30000,
    // 这些用例都在临时目录里各建各的夹具，彼此无共享状态，可并行。
    fileParallelism: true,
  },
})
