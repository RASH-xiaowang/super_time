#!/usr/bin/env node
'use strict';

/**
 * 把 scripts/packaged-sns-video-check.ts 打成临时 ESM，跑两遍并比对：
 *   ① 纯 `node`（开发态用的运行时）；
 *   ② 同版本的 `node_modules/electron/dist/electron.exe`（打包版跑的就是这份运行时）。
 * 再直接对两份 vendored 资产求 sha256：仓库里那份与打进 `app.asar.unpacked` 的那份必须
 * 逐字节相同 —— 于是「打包目录里那份字节」×「Electron 运行时」两件事一起被覆盖到。
 *
 * 为什么不干脆从 `Super Time.exe` 里跑：打包后的 exe 把应用烤进了 `resources/app.asar`，
 * 命令行再传脚本路径**不会**替换它（实测它照常启动主程序、去查更新）。
 *
 * 没有打包产物时资产比对跳过并退出，但**跳过要显式打印**（不能悄悄绿）。
 * 与 rag-retrieval-check / sns-video-check 同一套路：项目没装 tsx，用 esbuild 现场 bundle。
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'scripts', 'packaged-sns-video-check.ts');
// 输出到 lib/ 下：sns-keystream.ts 按「构建产物在 lib/ 下」定位 vendored 资产（见其 resolveAssetDir）。
const out = path.join(root, 'src', 'backend', 'wechat-data', 'lib', '.tmp-packaged-sns-video-check.mjs');
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const ASSET = path.join('src', 'backend', 'wechat-data', 'native', 'weflow-isaac64');
const devDir = path.join(root, ASSET);
const unpackedDir = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', ASSET);
const FILES = ['wasm_video_decode.wasm', 'wasm_video_decode.js'];

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** 从子进程输出里捞出那行 JSON；捞不到就把原始输出尾部报出来（只剩一个退出码没法查）。 */
function parseResult(stdout) {
  const line = (stdout || '').split(/\r?\n/).find((l) => l.startsWith('SNS-KEYSTREAM '));
  if (!line) return null;
  try { return JSON.parse(line.slice('SNS-KEYSTREAM '.length)); } catch { return null; }
}

function run(cmd, args, expectMode) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 180000, cwd: path.dirname(cmd) });
  const res = parseResult(r.stdout);
  if (!res) {
    console.error(`❌ ${expectMode} 那一遍没有产出结果行（退出码 ${String(r.status)}）\n`
      + `${(r.stdout || '')}\n${r.stderr || ''}`.slice(-1500));
    process.exit(1);
  }
  if (res.mode !== expectMode) {
    console.error(`❌ 期望模式 ${expectMode}，实际 ${res.mode}（运行时：${res.runtime}）`);
    process.exit(1);
  }
  console.log(`   ${expectMode.padEnd(8)} 运行时=${res.runtime}  密钥流 ${res.bytes} 字节  sha256=${res.sha256.slice(0, 16)}…`);
  return res;
}

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

  let failed = 0;
  try {
    const node = run(process.execPath, [out, '--mode=node'], 'node');
    const electron = run(electronExe, [out, '--mode=electron'], 'electron');
    if (node.sha256 !== electron.sha256 || node.bytes !== electron.bytes) {
      console.error(`❌ 同一份密钥流在 node 与 Electron 下不一致：${node.sha256} vs ${electron.sha256}`);
      failed = 1;
    }

    if (!fs.existsSync(path.join(unpackedDir, FILES[0]))) {
      console.log('⏭️  跳过资产字节比对：没有 dist/win-unpacked 下的 app.asar.unpacked 产物（先跑 npm run pack）');
      console.log('    这一条**不算通过** —— 只是本机暂时没有打包件可比。');
      process.exit(failed);
    }
    for (const f of FILES) {
      const a = sha256(path.join(devDir, f));
      const b = sha256(path.join(unpackedDir, f));
      const same = a === b;
      console.log(`   ${same ? '✅' : '❌'} 打包产物里的 ${f} 与仓库里那份${same ? '逐字节相同' : '**不同**'}（${a.slice(0, 12)}… vs ${b.slice(0, 12)}…）`);
      if (!same) failed = 1;
    }
    console.log(failed === 0
      ? '✅ 打包版加载的正是这份被验过的 WxIsaac64 资产，且它在 Electron 运行时下能实例化并产出与 node 相同的密钥流'
      : '❌ 见上面的不一致');
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
  }
  process.exit(failed);
})().catch((e) => {
  console.error('❌ 校验执行失败:', e && e.message ? e.message : e);
  try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
  process.exit(1);
});
