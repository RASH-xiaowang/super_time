#!/usr/bin/env node
'use strict';

/**
 * H7 端到端验证：后端 worker 被杀后能否自愈。
 *
 * 覆盖验收标准「手动杀掉后端 worker 进程 → 进程被自动重建，功能恢复（无需重启应用）」。
 * 必须在真实 Electron 里跑：这段逻辑住在主进程（utilityProcess + ipcMain），
 * 纯 Node 环境复现不出来。
 *
 * 分工说明：**调用超时不在这里验证**。它是「响应与超时的竞态」，用 1ms 窗口去赌
 * 谁先到会时红时绿；那条路径已抽到 src/backend/backend-rpc.js，
 * 由 src/backend/tests/backend-rpc.spec.ts 用假 child 确定性覆盖
 * （永不回包 / 回包晚于超时 / 中途退出 / 死后调用）。
 *
 * 关键隔离措施：预设一份**空**的 `<userData>/wechat/config.json`。
 * 否则开发态配置迁移会把仓库里 wechat/config.json 的 db_dir + db_enc_key 带进来，
 * 后端随即把真实微信库解密到这个临时目录（实测约 282MB）——既慢又是在动真实数据。
 * 空配置下 db_dir 缺失，realtime sync 会自行暂停，不产生任何解密。
 *
 * 用法：node scripts/backend-restart-smoke.js
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const ELECTRON = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

let failed = 0;
function check(label, ok, extra = '') {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 为本机指纹签一张临时许可证，写进指定 userData（业务调用要过许可闸门）。 */
function seedLicense(userDataDir) {
  const { signPayload } = require(path.join(root, 'src', 'license', 'crypto'));
  const { PRODUCT_ID, KNOWN_FEATURES } = require(path.join(root, 'src', 'license', 'schema'));
  const { getDeviceFingerprint } = require(path.join(root, 'src', 'license', 'fingerprint'));
  const pem = fs.readFileSync(path.join(root, 'vendor-keys', 'license-private.pem'), 'utf8');
  const now = new Date();
  const payload = {
    product: PRODUCT_ID,
    licenseId: crypto.randomUUID(),
    edition: 'pro',
    issuedTo: { name: 'H7 smoke', company: '', email: '' },
    device: { fingerprint: getDeviceFingerprint().fingerprint },
    issuedAt: now.toISOString(),
    notBefore: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
    features: [...KNOWN_FEATURES],
    seats: 1,
    appVersionMin: '1.0.0',
    notes: 'backend-restart-smoke',
  };
  fs.writeFileSync(
    path.join(userDataDir, 'license.json'),
    JSON.stringify({ payload, signature: signPayload(payload, pem), importedAt: now.toISOString() }, null, 2),
    'utf8',
  );
}

/** 预设空配置，阻止开发态配置迁移（否则会把真实库解密进来，见文件头注释）。 */
function seedEmptyStateConfig(userDataDir) {
  const dir = path.join(userDataDir, 'wechat');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    dataRoot: '', decryptedDir: '', decodedImagesDir: '', sourceDir: '', baseDir: '', selfWxid: '', silkBinary: '',
  }, null, 2), 'utf8');
}

/**
 * 当前存活的后端 worker 进程 PID。
 *
 * 识别方式：utilityProcess.fork 出来的子进程命令行里**不含脚本路径**
 * （拿 wechat-worker.js 去匹配会空手而归），而 serviceName 也不会出现在命令行里。
 * 它必然是唯一的 `--utility-sub-type=node.mojom.NodeService` 进程。
 */
function workerPids() {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | "
    + "Where-Object { $_.CommandLine -like '*node.mojom.NodeService*' } | "
    + 'Select-Object -ExpandProperty ProcessId';
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    return out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function killPid(pid) {
  try { spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* 已退出 */ }
}

/**
 * 起一个 Electron 实例，收集 stdout/stderr。
 * @returns {{ child, out, stop }}
 */
function launchElectron(env) {
  const child = spawn(ELECTRON, ['.'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });
  const stop = () => {
    try { child.kill(); } catch { /* 已退出 */ }
    for (const pid of workerPids()) killPid(pid);
  };
  return { child, get out() { return out; }, stop };
}

/** 轮询直到 stdout 里出现某个片段（或超时）。 */
async function waitForOutput(view, needle, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (view.out.includes(needle)) return true;
    await sleep(250);
  }
  return false;
}

/** 轮询直到 worker 数量达到期望（或超时）。 */
async function waitForWorkerCount(n, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (workerPids().length === n) return true;
    await sleep(250);
  }
  return false;
}

async function main() {
  if (!fs.existsSync(ELECTRON)) {
    console.error(`找不到 Electron：${ELECTRON}\n请先 npm ci`);
    process.exit(2);
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'st-h7-'));
  seedEmptyStateConfig(userData);
  seedLicense(userData);

  // ── ① 崩溃重启 ─────────────────────────────────────────────────
  console.log('\n杀掉后端 worker 进程，验证自动重建');
  const app = launchElectron({ SUPERTIME_USER_DATA_DIR: userData });
  try {
    const ok = await waitForOutput(app, '微信+后端已就绪', 90_000);
    check('后端已就绪', ok, ok ? '' : app.out.slice(-400));
    if (ok) {
      const before = workerPids();
      check('恰好一个 worker 进程', before.length === 1, `实际 ${JSON.stringify(before)}`);

      if (before.length === 1) {
        killPid(before[0]);
        const restarted = await waitForOutput(app, '后端已恢复', 60_000);
        check('被杀后自动重启并恢复（主进程日志出现「后端已恢复」）', restarted, restarted ? '' : app.out.slice(-600));
        const revived = await waitForWorkerCount(1, 30_000);
        const after = workerPids();
        check('重建出新的 worker 进程', revived && after.length === 1, `实际 ${JSON.stringify(after)}`);
        check('新进程不是原 PID', after.length === 1 && after[0] !== before[0], `before=${before[0]} after=${after[0]}`);
        check('重建过程中没有重复拉起（worker 始终 ≤1）', after.length <= 1, '');
      }
    }
  } finally {
    app.stop();
    await sleep(1500);
  }

  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* 删不掉不致命 */ }

  if (failed > 0) { console.log(`\n❌ H7 冒烟失败：${failed} 项`); process.exit(1); }
  console.log('\n✅ H7 后端崩溃自愈冒烟通过');
}

main().catch((e) => { console.error('❌ 冒烟异常:', e); process.exit(1); });
