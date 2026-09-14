'use strict';

/**
 * 把「含密钥的目录/文件」限制到当前用户可访问。
 *
 * 为什么需要：`config.json` / `keys.json` 里是微信库密钥与 API Key 的明文；
 * 默认权限下同机其它账户（或域内其它用户）都能读 —— H1 那条「跨机拷贝带走密钥」
 * 之外，还有一条「同机其它用户直接读」的路径。
 *
 * 策略：
 *   · Windows：`icacls <dir> /inheritance:r /grant:r "<user>:(OI)(CI)F"` —— 去掉继承来的
 *     ACE、只给当前用户完全控制，并**把这条权限继承给子对象**，于是目录里新建的文件
 *     也自动只对当前用户可见（不需要每写一个文件都调一次）。
 *   · POSIX：目录 0700；已存在/新写的敏感文件另用 `restrictFile` 设 0600。
 * 一律**尽力而为**：拿不到权限就记一条日志继续跑（不能因为加固失败让应用起不来）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * 当前进程身份的 icacls 授权串，优先用 **SID**。
 *
 * 为什么不用 `process.env.USERNAME`：它在本机实测是 `SYSTEM`，而进程实际以
 * `Administrator` 运行 —— 照环境变量授权会把目录锁成**连自己都进不去**的状态
 * （实测：授权后连自己的 rmSync 都 EPERM）。`whoami /user` 读的是进程令牌，
 * 用 `*S-1-5-…` 形态还能免掉域/本地名字解析的问题。
 * @returns {string} 形如 `*S-1-5-…` 或用户名；取不到时返回空串。
 */
function currentUserGrant() {
  try {
    const out = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = (out.match(/"(S-1-[\d-]+)"/) || [])[1];
    if (sid) return `*${sid}`;
  } catch { /* 退回到用户名 */ }
  return currentUser();
}

/** 当前用户名（日志/诊断用；取自进程令牌而不是环境变量）。 */
function currentUser() {
  try {
    return String(os.userInfo().username || '').trim();
  } catch {
    return '';
  }
}

/**
 * 收紧一个目录的权限。
 * @param {string} dir - 目标目录（不存在时先创建）。
 * @returns {{ ok: boolean, detail?: string }} 结果（失败不抛）。
 */
function restrictDir(dir) {
  try {
    if (!dir) return { ok: false, detail: 'empty path' };
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32') {
      const grant = currentUserGrant();
      if (!grant) return { ok: false, detail: 'unknown user' };
      execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${grant}:(OI)(CI)F`], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return { ok: true };
    }
    fs.chmodSync(dir, 0o700);
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e && e.message ? e.message : String(e) };
  }
}

/**
 * 收紧单个文件的权限（POSIX 上必要；Windows 靠目录的 (OI)(CI) 继承即可，这里也顺手设上）。
 * @param {string} file - 目标文件（不存在时直接返回）。
 * @returns {{ ok: boolean, detail?: string }} 结果（失败不抛）。
 */
function restrictFile(file) {
  try {
    if (!file || !fs.existsSync(file)) return { ok: false, detail: 'missing' };
    if (process.platform === 'win32') {
      const grant = currentUserGrant();
      if (!grant) return { ok: false, detail: 'unknown user' };
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${grant}:F`], { stdio: 'ignore', windowsHide: true });
      return { ok: true };
    }
    fs.chmodSync(file, 0o600);
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e && e.message ? e.message : String(e) };
  }
}

/** 含密钥的文件名（放在状态目录或数据根下时都要收紧）。 */
const SENSITIVE_FILES = ['config.json', 'secrets.json', 'keys.json', 'llm.json', 'all_keys.json'];

/**
 * 收紧「微信+」全部敏感位置：状态目录、数据根，以及两者下的已知密钥文件。
 * @param {{ stateDir?: string, dataRoot?: string }} paths - 要处理的位置。
 * @returns {{ ok: boolean, failures: string[] }} 汇总（失败不抛）。
 */
function restrictWechatState(paths = {}) {
  const failures = [];
  for (const dir of [paths.stateDir, paths.dataRoot]) {
    if (!dir) continue;
    const r = restrictDir(dir);
    if (!r.ok && r.detail !== 'empty path') failures.push(`${dir}: ${r.detail}`);
    for (const name of SENSITIVE_FILES) {
      const f = path.join(dir, name);
      if (!fs.existsSync(f)) continue;
      const rf = restrictFile(f);
      if (!rf.ok && rf.detail !== 'missing') failures.push(`${f}: ${rf.detail}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

module.exports = { SENSITIVE_FILES, currentUser, currentUserGrant, restrictDir, restrictFile, restrictWechatState };
