#!/usr/bin/env node
'use strict';

/**
 * 把 scripts/rag-retrieval-check.ts 打包成临时 ESM 再执行。
 *
 * 项目没有装 vitest / tsx，但装了 esbuild —— 用 esbuild 现场 bundle 一个 TS 入口
 * 再交给 node 跑，就能在没有测试框架的环境里做真实断言（见 package.json 的 rag:check）。
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'scripts', 'rag-retrieval-check.ts');
const out = path.join(root, '.tmp-rag-check.mjs');

(async () => {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    outfile: out,
    logLevel: 'error',
    tsconfigRaw: { compilerOptions: { target: 'ES2022', useDefineForClassFields: false } },
  });
  const r = spawnSync(process.execPath, [out], { stdio: 'inherit' });
  try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
  process.exit(r.status === null ? 1 : r.status);
})().catch((e) => {
  console.error('❌ 校验执行失败:', e && e.message ? e.message : e);
  process.exit(1);
});
