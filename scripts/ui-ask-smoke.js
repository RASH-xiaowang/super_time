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
