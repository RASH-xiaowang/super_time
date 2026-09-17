import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** shim 源码目录（M17）：构建直接读这里，绕开 node_modules 里那份 npm 拷贝。 */
const SHIM_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src/client/ui-primitives-shim/src')

/**
 * Super Time —— 前端构建配置
 *
 * root 指向 src/client/ui-app（React 入口），构建产物输出到
 * src/client/ui-dist，Electron 主进程加载该目录的 index.html。
 */
export default defineConfig({
  root: 'src/client/ui-app',
  base: './',
  esbuild: {
    // ui-app 目录没有自己的 tsconfig，若不显式指定，部分 .tsx 会退回
    // classic（React.createElement），在未 `import React` 时运行时崩溃。
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  build: {
    outDir: '../ui-dist',
    emptyOutDir: true,
    target: 'chrome120',
    reportCompressedSize: false,
    chunkSizeWarningLimit: 6000,
  },
  resolve: {
    // M17：shim 包直接解析到**源码目录**，不走 node_modules 里那份 `file:` 拷贝。
    // 为什么：npm 对 `file:` 依赖装的是真实拷贝，改源码后必须手工同步才生效（历史上因此
    // 丢过 Button 的焦点环等改动，且构建日志毫无提示）。alias 之后「改源码 → 构建」直接生效，
    // 「构建静默用旧副本」在结构上不可能发生。
    // 保留 scripts/sync-ui-shim.js 作为「磁盘上那份拷贝」的一致性检查（不再是构建的前提）。
    alias: [
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: path.join(SHIM_SRC, 'index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-primitives\/src\/(.*)$/, replacement: path.join(SHIM_SRC, '$1') },
    ],
    // 与上游一致的扩展名优先级（源码 import 显式带 .ts/.tsx，保持兼容）
    extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
    // React 必须只有一份实例。
    //
    // 踩过的坑：`@deepseek-ai/dsh-client-ui-primitives` 是 `file:src/client/ui-primitives-shim`
    // 依赖，npm 会把它装成**真实目录拷贝**（不是符号链接）。只要 shim 目录或安装副本下
    // 出现第二份 react/react-dom（子目录跑过 npm install、或依赖提升残留），Vite 就会把
    // React 与 ReactDOM 各打包两份。结果是 hooks 拿到的 dispatcher 为 null，运行时报
    //   TypeError: Cannot read properties of null (reading 'useRef')
    // React 整棵渲染树当场崩溃 → #root 全空 → 窗口只剩 backgroundColor，即「启动后黑屏」。
    // 该症状在构建日志里毫无提示（vite 照样 ✓ built），只能靠运行时 console 抓到。
    // dedupe 强制 react/react-dom 只解析到顶层 node_modules 那一份，从源头杜绝。
    dedupe: ['react', 'react-dom'],
  },
})
