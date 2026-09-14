#!/usr/bin/env node
'use strict';

/**
 * H10 验收：Electron 安全守卫的**端到端**探针。
 *
 * 为什么需要它：`src/backend/tests/navigation-policy.spec.ts` 证明的是**判定函数**，
 * 但「守卫到底有没有挂到 webContents 上」只能在真渲染进程里验证
 * （`web-contents-created` 的注册时机、`sandbox:true` 下的实际行为）。
 *
 * 做法：以 `SUPERTIME_SECURITY_PROBE=1` 启动应用，探针会在渲染进程里尝试
 *   ① 新窗口打开 `file:///C:/Windows/System32/calc.exe`（能直接拉起本地可执行文件）
 *   ② 新窗口打开 `smb://attacker/share`（UNC 凭据外连）
 *   ③ 新窗口打开自定义协议 `ms-msdt:/id`
 *   ④ 把页面导航到 `https://example.com/`
 * 然后打出一行 `[security-probe] {…}` 并退出。本脚本断言：
 *   · 三次 `window.open` 都拿到 null（= 被 deny，而不是开了个窗口）；
 *   · 页面 URL 没有变化（导航被阻止）；
 *   · 主进程日志里出现对应的三条拒绝记录；
 *   · **没有**出现「交给系统打开失败」—— 即根本没走到 openExternal，
 *     而不是「调用失败但已经交给系统了」。
 *
 * 用法：
 *   node scripts/security-guard-smoke.js                     # 开发态（node_modules 里的 electron）
 *   SECURITY_SMOKE_TARGET=packaged node scripts/security-guard-smoke.js
 *                                                            # 打包产物（需先 npm run pack）
 * 打包态更值得跑一次：它同时带着 asar 完整性校验、OnlyLoadAppFromAsar 与 sandbox:true，
 * 是「守卫在真实安装包里也生效」的唯一证据。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const packaged = process.env.SECURITY_SMOKE_TARGET === 'packaged'
  || process.argv.includes('--packaged');
const exe = packaged
  ? path.join(root, 'dist', 'win-unpacked', 'Super Time.exe')
  : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const cwd = packaged ? path.dirname(exe) : root;
const uiDist = path.join(root, 'src', 'client', 'ui-dist', 'index.html');

let failed = 0;
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) failed += 1;
};

if (!fs.existsSync(exe)) {
  console.error('❌ 找不到可执行文件：' + exe + (packaged ? '\n   请先 npm run pack' : '\n   请先 npm ci'));
  process.exit(2);
}
if (!packaged && !fs.existsSync(uiDist)) {
  console.error('❌ 找不到前端产物：' + uiDist + '\n   请先 npm run build:ui');
  process.exit(2);
}
console.log('·  目标：' + (packaged ? '打包产物' : '开发态') + '  ' + exe);

// 一次性 userData：不碰真实目录（与 packaged-smoke 同一做法）。
const userData = path.join(os.tmpdir(), `supertime-secprobe-${Date.now()}`);

const child = spawn(exe, packaged ? [] : ['.'], {
  cwd,
  env: {
    ...process.env,
    SUPERTIME_SECURITY_PROBE: '1',
    SUPERTIME_USER_DATA_DIR: userData,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => { out += String(d); });
child.stderr.on('data', (d) => { out += String(d); });

const done = new Promise((resolve) => {
  child.on('exit', () => resolve());
  setTimeout(() => {
    try { child.kill(); } catch { /* 已退出 */ }
  }, 60_000);
});

done.then(() => {
  const probeLine = out.split(/\r?\n/).find((l) => l.includes('[security-probe]'));
  let probe = null;
  if (probeLine) {
    try {
      probe = JSON.parse(probeLine.slice(probeLine.indexOf('{')));
    } catch { /* 解析失败按缺失处理 */ }
  }

  check(Boolean(probe), '探针产出了结果行', probeLine ? probeLine.trim().slice(0, 120) : '未找到');
  if (probe) {
    check(Array.isArray(probe.opened) && probe.opened.length === 3,
      '三次 window.open 都被调用到', JSON.stringify(probe.opened));
    check(Array.isArray(probe.opened) && probe.opened.every((v) => v === 'null'),
      'window.open 三次全部被拒（返回 null，没有开出窗口）');
    check(probe.navigated === false,
      '页面未被导航到外站', `urlAfter=${probe.urlAfter}`);
    check(probe.urlAfter === probe.urlBefore && typeof probe.urlBefore === 'string'
      && probe.urlBefore.startsWith('file:'),
      '页面仍停在应用自己的 file: 页面');
  }

  check(out.includes('[security] 已拒绝打开外部链接：file:///C:/Windows/System32/calc.exe'),
    '日志记录：拒绝 file:// 链接');
  check(out.includes('[security] 已拒绝打开外部链接：smb://attacker/share'),
    '日志记录：拒绝 smb:// 链接');
  check(out.includes('[security] 已阻止页面导航：https://example.com/'),
    '日志记录：阻止外部导航');
  check(!out.includes('[security] 交给系统打开失败'),
    '未调用 shell.openExternal（是「拒绝」而不是「调用后失败」）');

  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }

  if (failed === 0) {
    console.log('\n✅ 安全守卫冒烟通过');
    process.exit(0);
  }
  console.error(`\n❌ 安全守卫冒烟失败（${failed} 项）`);
  console.error('--- 应用输出 ---\n' + out);
  process.exit(1);
});
