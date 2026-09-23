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
const http = require('node:http');
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

  check(Boolean(probe), '探针产出了结果行', probeLine ? probeLine.trim().slice(0, 140) : '未找到');
  if (probe) {
    // ① 沙箱是否真的生效（行为事实：渲染层拿不到 Node 原语）
    check(probe.sandbox && probe.sandbox.require === 'undefined',
      'sandbox 生效：渲染层 typeof require === undefined', JSON.stringify(probe.sandbox));
    check(probe.sandbox && probe.sandbox.process === 'undefined',
      'sandbox 生效：渲染层 typeof process === undefined');
    check(probe.sandbox && probe.sandbox.electronAPIKeys > 0,
      'preload 的 contextBridge 仍然可用（沙箱没把桥一起关掉）');

    // ② 三类被禁协议：**安全判定看「有没有真开出窗口」，不看 window.open 的返回值**
    // 返回值当判据是不可靠的：处理器 `action:'deny'` 时 Chromium 仍可能回一个指向空窗的
    // WindowProxy（CI 上实测会看到 'window'），而守卫真的失效时才会触发 `did-create-window`。
    // 所以这里断言的是结果（窗口数），`result` 只在 detail 里留着当诊断。
    const opened = Array.isArray(probe.opened) ? probe.opened : [];
    check(opened.length === 3, '三次 window.open 都被调用到', JSON.stringify(opened.map(o => o.url)));
    check(opened.length === 3 && probe.popupWindows === 0 && opened.every((o) => o.windowsAfter === 0),
      '三次被禁开窗一个都没真开出来（did-create-window 计数恒为 0）',
      `popupWindows=${probe.popupWindows} windowsAfter=${JSON.stringify(opened.map((o) => o.windowsAfter))} result=${JSON.stringify(opened.map((o) => o.result))}`);
    // 探针自身的形状：返回值必须落在已知集合里（拿到 undefined / 别的字符串说明探针或序列化坏了，
    // 那要单独报红，不能和「守卫失效」混成一条）。
    check(opened.length === 3 && opened.every((o) => o.result === 'null' || o.result === 'window'),
      '探针回到的开窗形态在已知集合内（null=彻底拒绝，window=回了代理但未建窗）',
      JSON.stringify(opened.map((o) => o.result)));

    // ③ 外部导航被阻止
    check(probe.navigated === false, '页面未被导航到外站', `urlAfter=${probe.urlAfter}`);
    check(probe.urlAfter === probe.urlBefore && typeof probe.urlBefore === 'string'
      && probe.urlBefore.startsWith('file:'),
      '页面仍停在应用自己的 file: 页面');

    // ④ 关键行为事实：根本没调用 openExternal。
    //    这条取代了原先「grep 日志文案」的判据 —— 评审实测：把白名单放宽到 file:/smb: 时，
    //    window.open 仍返回 null、URL 也没变（因为 deny 分支还在），只有日志文案变了；
    //    真实环境那一次运行已经把 calc.exe 交给系统了。计数是行为，不是文案。
    check(probe.openExternalAttempts === 0,
      '未把任何 URL 交给系统浏览器（openExternal 调用次数为 0）', `count=${probe.openExternalAttempts}`);

    // ⑤ 探针动作执行完整性：导航那一步若因守卫失效把页面带走，会以 __timeout__ 暴露
    check(probe.navAttempt !== '__timeout__',
      '导航尝试有结果返回（不是「frame 被带走导致探针挂住」）', String(probe.navAttempt));
  }

  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }

  // ⑥ 打包态额外一项：危险的调试开关必须被忽略。
  //    fuses 只覆盖 `--inspect*`，`--remote-debugging-port` 没有任何 fuse —— 它一旦生效，
  //    任何能传参启动本 exe 的一方都能经 CDP 拿到渲染进程与整条 IPC 桥（评审实测
  //    `/json/list` 直接列出应用页面）。这里实测「带了也连不上」。
  const finish = async () => {
    if (packaged) {
      const port = 39321 + Math.floor(Math.random() * 200);
      const probe2 = spawn(exe, [`--remote-debugging-port=${port}`], {
        cwd,
        env: { ...process.env, SUPERTIME_SECURITY_PROBE: '1', SUPERTIME_USER_DATA_DIR: userData + '-cdp' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out2 = '';
      probe2.stdout.on('data', (d) => { out2 += String(d); });
      probe2.stderr.on('data', (d) => { out2 += String(d); });
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 6000);
        probe2.on('exit', () => { clearTimeout(t); resolve(); });
      });
      const reachable = await cdpReachable(port);
      check(reachable === false,
        '打包态忽略 --remote-debugging-port（CDP 端口不可达）', `port=${port} reachable=${reachable}`);
      check(out2.includes('[security] 已忽略启动参数 --remote-debugging-port'),
        '日志记录：忽略 --remote-debugging-port');
      try { probe2.kill(); } catch { /* 已退出 */ }
      try { fs.rmSync(userData + '-cdp', { recursive: true, force: true }); } catch { /* ignore */ }
    }

    if (failed === 0) {
      console.log('\n✅ 安全守卫冒烟通过');
      process.exit(0);
    }
    console.error(`\n❌ 安全守卫冒烟失败（${failed} 项）`);
    console.error('--- 应用输出 ---\n' + out);
    process.exit(1);
  };
  void finish();
});

/**
 * CDP 端口是否可达（可达 = 调试开关生效 = 不安全）。
 * @param {number} port - 端口。
 * @returns {Promise<boolean>} 是否返回了 200。
 */
function cdpReachable(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
