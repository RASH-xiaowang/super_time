#!/usr/bin/env node
'use strict';

/**
 * 把 scripts/ui-ask-smoke.tsx 打包成临时 ESM 再执行（无浏览器 SSR 冒烟）。
 *
 * 关键配置：
 *   · `loader: { '.css': 'text' }` —— CSS Modules 在 node 下没有处理管线，
 *     用 text loader 让 `import css from './x.module.css'` 拿到字符串
 *     （`css.someClass` 求值为 undefined，不影响「是否崩溃 / 条件是否命中」的断言）。
 *   · **external 只留 CJS/原生依赖**：react-dom 是 CJS、内部 `require('stream')`，
 *     打进 ESM bundle 会变成「Dynamic require is not supported」；Radix 的传递依赖
 *     里也有 CJS。因此 react / react-dom / @radix-ui / @tanstack / clsx 走 external，
 *     其余（含本地 TS 源码的 @deepseek-ai/dsh-client-ui-primitives）一起打包 ——
 *     后者入口是 `src/index.ts`，Node 24 拒绝为 node_modules 下的文件做类型剥离，
 *     留作 external 会报 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING。
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
/**
 * 与 `vite.config.js` 的 `resolve.alias` **同一份口径**（M17 / 手机端 M0–M4）。
 *
 * 为什么必须在这里也写一遍：`@deepseek-ai/dsh-client-ui-wechat/*` 是**子路径导出**，
 * 而 npm 对 `file:` 依赖装的是真实目录拷贝 —— 子路径能不能解析取决于那份拷贝的
 * `exports` 字段，而不是源码树。Vite 侧靠 alias 绕开了它，本脚本（esbuild）原先没有，
 * 于是 2026-10-15 手机端新增 `notice` 导出后，`privacy-gate:smoke` 在 CI 上直接
 * `Could not resolve "@deepseek-ai/dsh-client-ui-wechat/notice"` 而红。
 *
 * 口径与 vite 一致：**直接指向源码文件**，不走 node_modules 里那份拷贝。
 * 新增子路径导出时，两处都要加（`vite.config.js` 与这里）。
 */
const UI_WECHAT_SRC = path.join(root, 'src', 'client', 'ui-wechat', 'src', 'client');
const SHIM_SRC = path.join(root, 'src', 'client', 'ui-primitives-shim', 'src');
const ALIAS = {
  '@deepseek-ai/dsh-client-ui-primitives': path.join(SHIM_SRC, 'index.ts'),
  '@deepseek-ai/dsh-client-ui-wechat/contracts': path.join(UI_WECHAT_SRC, 'contracts.ts'),
  '@deepseek-ai/dsh-client-ui-wechat/host': path.join(UI_WECHAT_SRC, 'public', 'host.ts'),
  '@deepseek-ai/dsh-client-ui-wechat/notice': path.join(UI_WECHAT_SRC, 'public', 'notice.tsx'),
  '@deepseek-ai/dsh-client-ui-wechat/theme': path.join(UI_WECHAT_SRC, 'public', 'theme.ts'),
};
/** esbuild 的 alias 插件：把上面那张表按**精确匹配**改写导入路径。 */
const aliasPlugin = {
  name: 'supertime-alias',
  setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-(primitives|wechat)\// }, (args) => {
      const hit = ALIAS[args.path];
      return hit ? { path: hit } : null;
    });
    build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: ALIAS['@deepseek-ai/dsh-client-ui-primitives'] }));
  },
};
/**
 * 入口可用第一个参数覆盖（默认「微信问答」那份）。
 *
 * 这样同一个 harness 能跑多份 SSR 冒烟：esbuild 的 external/loader 配置对它们完全一样，
 * 再抄一份 runner 只会让两处配置各自漂移（例如将来给 CSS Modules 换 loader 时漏改一处）。
 * 例：`node scripts/ui-ask-smoke.js scripts/privacy-consent-ssr.tsx`
 */
const entryArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const entry = entryArg
  ? path.resolve(root, entryArg)
  : path.join(root, 'scripts', 'ui-ask-smoke.tsx');
const out = path.join(root, '.tmp-' + path.basename(entry).replace(/\.tsx?$/, '') + '.mjs');

(async () => {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: [
      'react', 'react-dom', 'react-dom/server', 'react/jsx-runtime', 'react/jsx-dev-runtime',
      '@radix-ui/*', '@tanstack/*', 'clsx', 'echarts', 'echarts/*',
    ],
    outfile: out,
    logLevel: 'error',
    jsx: 'automatic',
    jsxImportSource: 'react',
    loader: { '.css': 'text' },
    plugins: [aliasPlugin],
    tsconfigRaw: { compilerOptions: { target: 'ES2022', jsx: 'react-jsx', useDefineForClassFields: false } },
  });
  const r = spawnSync(process.execPath, [out], { stdio: 'inherit' });
  try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
  // esbuild 在处理 CSS 导入时可能额外产出一个同名 .css（即使 loader=text），一并清掉。
  try { fs.rmSync(out.replace(/\.mjs$/, '.css'), { force: true }); } catch { /* ignore */ }
  process.exit(r.status === null ? 1 : r.status);
})().catch((e) => {
  console.error('❌ UI 冒烟执行失败:', e && e.message ? e.message : e);
  process.exit(1);
});
