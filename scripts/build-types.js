#!/usr/bin/env node
'use strict';

/**
 * 干净地重建 `src/backend/wechat-data/lib/types/**`。
 *
 * 直接用 tsc 往既有目录里写有一个隐藏缺陷：文件删除/改名后，旧 `.d.ts` 会一直
 * 留在 outDir。`check:types` 的整树比对能发现这类残留，但如果每次构建前不清空，
 * 开发者就永远没有一条命令可以“回到与当前源码完全一致”的状态。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkgRoot = path.join(root, 'src', 'backend', 'wechat-data');
const outDir = path.join(pkgRoot, 'lib', 'types');
const tsconfig = path.join(pkgRoot, 'tsconfig.types.json');

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) files.push(abs);
    }
  };
  walk(dir);
  return files;
}

fs.rmSync(outDir, { recursive: true, force: true });

const tsc = require.resolve('typescript/lib/tsc.js');
const result = spawnSync(process.execPath, [tsc, '-p', tsconfig, '--pretty', 'false'], {
  stdio: 'inherit',
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`✅ lib/types 已干净重建: ${path.relative(root, outDir)} (${String(listFiles(outDir).length)} files)`);
