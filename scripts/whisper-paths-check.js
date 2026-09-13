#!/usr/bin/env node
'use strict';

/**
 * 把 scripts/whisper-paths-check.ts 打包成临时 ESM 再执行。
 * 与 rag-retrieval-check 同一套路：项目没有 vitest/tsx，用 esbuild 现场 bundle。
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'scripts', 'whisper-paths-check.ts');
// 输出位置必须与运行时 bundle 同级深度：whisper.ts 靠 import.meta.url 上溯 4 级找项目根
// （运行时是 src/backend/wechat-data/lib/index.js）。放在仓库根目录的话会上溯到 D:\，
// 随包资产路径就找错了，测的也就不是真实逻辑。
const tmpDir = path.join(root, '.tmp-whisper-paths-check');
const out = path.join(tmpDir, 'src', 'backend', 'wechat-data', 'check.mjs');

(async () => {
  fs.mkdirSync(path.dirname(out), { recursive: true });
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
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(r.status === null ? 1 : r.status);
})().catch((e) => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  console.error('❌ 校验执行失败:', e && e.message ? e.message : e);
  process.exit(1);
});
