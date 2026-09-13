#!/usr/bin/env node
'use strict';

/**
 * 把 scripts/sns-video-check.ts 打包成临时 ESM 再执行。
 * 与 rag-retrieval-check / whisper-paths-check 同一套路：项目没装 vitest/tsx，
 * 用 esbuild 现场 bundle 一个 TS 入口交给 node 跑。
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'scripts', 'sns-video-check.ts');
// 输出位置与运行时 bundle 同级：sns-keystream.ts 按「构建产物在 lib/ 下」定位 vendored 的
// WxIsaac64 WASM 资产（见该模块的 resolveAssetDir）。放在仓库根会找不到资产。
const out = path.join(root, 'src', 'backend', 'wechat-data', 'lib', '.tmp-sns-video-check.mjs');

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
