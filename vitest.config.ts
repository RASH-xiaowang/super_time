import { defineConfig } from 'vitest/config'

/**
 * 单测配置（与 vite.config.js 分开）。
 *
 * 为什么不能复用 vite.config.js：那份配置的 root 指向 src/client/ui-app（前端构建），
 * vitest 若加载它会把测试文件的解析根也挪过去，后端 spec 全部找不到。
 *
 * 测试范围刻意只覆盖后端包：这些 spec 用 mkdtempSync 造合成的 sqlite 夹具，
 * 不依赖真实微信数据、不联网，任何机器上都能稳定跑。前端目前只有 SSR 冒烟
 * （scripts/ui-ask-smoke），组件级测试缺失，属 H3/H4 的后续项。
 */
export default defineConfig({
  test: {
    include: ['src/backend/wechat-data/tests/**/*.spec.ts'],
    environment: 'node',
    // spec 里会建库、写文件、跑 PBKDF2，比默认 5s 宽松些。
    testTimeout: 30000,
    hookTimeout: 30000,
    // 这些用例都在临时目录里各建各的夹具，彼此无共享状态，可并行。
    fileParallelism: true,
  },
})
