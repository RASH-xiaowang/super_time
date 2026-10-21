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
 *
 * ## 为什么「先校验、已收紧就跳过」（2026-10-21 性能专项）
 *
 * `/inheritance:r` + `/grant:r (OI)(CI)F` 不只是改目标目录那一行 ACE：Windows 必须
 * 把新的继承 ACE **传播给已存在的全部子对象**。数据根下 `decoded_images` 实测
 * 48,539 个文件 / 3.81GiB，于是每次启动都白付一次全树 ACL 重写（本机实测 2.65s，
 * 占「后端 ready」的 87%，且跑在主进程事件循环上）。
 *
 * 但该操作是**幂等**的：第一次收紧后，目录级 ACE 会持续继承给之后新建的文件。
 * 所以每次只需**只读**地验一次当前 ACL 形状（本机实测 `icacls <dir>` 4.8ms）：
 *   · 没有任何继承来的 ACE（`(I)`）；
 *   · 只有一条 ACE 行，且完整权限里同时有 `(OI)(CI)(F)`，主体是当前进程身份；
 * 满足就跳过递归传播；不满足（换账号、被别的工具改过、目录新建）才重跑。
 * `SUPERTIME_FORCE_ACL=1` 可强制走完整加固（诊断/事故恢复用）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** 当前进程身份的缓存（令牌身份在进程生命周期内不会变）。 */
let cachedIdentity;

/**
 * 当前进程身份：`{ name: 'DOMAIN\\user', sid: 'S-1-5-…' }`（取不到的字段为空串）。
 *
 * 为什么不用 `process.env.USERNAME`：它在本机实测是 `SYSTEM`，而进程实际以
 * `Administrator` 运行 —— 照环境变量授权会把目录锁成**连自己都进不去**的状态
 * （实测：授权后连自己的 rmSync 都 EPERM）。`whoami /user` 读的是进程令牌，
 * 用 `*S-1-5-…` 形态还能免掉域/本地名字解析的问题。
 * @returns {{ name: string, sid: string }} 当前身份。
 */
function currentUserIdentity() {
  if (cachedIdentity !== undefined) return cachedIdentity;
  let name = '';
  let sid = '';
  try {
    const out = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    // 形如："SK-20260906XION\\administrator","S-1-5-21-…"
    const m = out.match(/"([^"]*\\[^"]*)","(S-1-[0-9-]+)"/);
    if (m) {
      name = String(m[1] ?? '').trim();
      sid = String(m[2] ?? '').trim();
    }
  } catch { /* 退回到用户名 */ }
  if (name === '') {
    try {
      name = String(os.userInfo().username || '').trim();
    } catch { /* 取不到就空着 */ }
  }
  cachedIdentity = { name, sid };
  return cachedIdentity;
}

/**
 * 当前进程身份的 icacls 授权串，优先用 **SID**。
 * @returns {string} 形如 `*S-1-5-…` 或用户名；取不到时返回空串。
 */
function currentUserGrant() {
  const id = currentUserIdentity();
  if (id.sid !== '') return '*' + id.sid;
  return id.name;
}

/** 清空身份缓存（仅供测试：单测要换身份夹具时用）。 */
function resetUserIdentityCacheForTest() {
  cachedIdentity = undefined;
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

/**
 * 从 `icacls <dir>` 的**只读**输出判断「该目录已经只对当前身份开放」。
 *
 * 判据刻意从严（任何一条不满足都返回 false ⇒ 调用方会重跑完整加固）：
 *   ① 输出里不许出现 `(I)`（继承来的 ACE 说明没做过 `/inheritance:r`，或又被父目录影响）；
 *   ② 只允许**一条** ACE 行（`<主体>:(权限)`）——多出来的显式授权无法用本地化名字可靠识别，
 *      宁可重跑一次也不放过；
 *   ③ 这条 ACE 的权限要同时含 `(OI)(CI)(F)`，且主体是当前身份（SID / 域名\用户 / 裸用户名任一匹配）。
 * @param {string} aclText - `icacls <dir>` 的 stdout。
 * @param {{ name?: string, sid?: string }} [identity] - 当前身份（缺省取 {@link currentUserIdentity}）。
 * @returns {boolean} true = 已收紧，可跳过递归传播。
 */
function parseAclLockedForUser(aclText, identity = currentUserIdentity()) {
  const text = String(aclText ?? '');
  if (text.trim() === '') return false;
  if (/\(I\)/.test(text)) return false;
  const aceLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && /:\(/.test(line));
  if (aceLines.length !== 1) return false;
  const line = aceLines[0];
  const permsAt = line.indexOf(':(');
  if (permsAt < 0) return false;
  const perms = line.slice(permsAt + 1);
  if (!/\(OI\)/.test(perms) || !/\(CI\)/.test(perms) || !/\(F\)/.test(perms)) return false;
  if (/\(I\)/.test(perms)) return false;
  const target = line.slice(0, permsAt).trim().toLowerCase();
  const sid = String(identity?.sid ?? '').trim().toLowerCase();
  const name = String(identity?.name ?? '').trim().toLowerCase();
  if (sid !== '' && target.includes(sid)) return true;
  if (name === '') return false;
  if (target.includes(name)) return true;
  const bare = name.includes('\\') ? name.slice(name.lastIndexOf('\\') + 1) : name;
  return bare !== '' && (target === bare || target.endsWith('\\' + bare));
}

/**
 * 该目录当前是否已经「只对当前身份开放」。
 *
 * Windows：一次只读 `icacls`（本机实测 ~5ms，与子对象数量无关）后交给
 * {@link parseAclLockedForUser}；POSIX：读 mode 是否为 0700。
 * 任何异常都返回 false（调用方会退回完整加固，安全侧的错误方向）。
 * @param {string} dir - 目标目录。
 * @returns {boolean} true = 可跳过收紧。
 */
function isDirAclLocked(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false;
    if (process.platform === 'win32') {
      const identity = currentUserIdentity();
      if (identity.name === '' && identity.sid === '') return false;
      const out = execFileSync('icacls', [dir], { encoding: 'utf8', windowsHide: true });
      return parseAclLockedForUser(out, identity);
    }
    const st = fs.statSync(dir);
    return (st.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

/** 含密钥的文件名（放在状态目录或数据根下时都要收紧）。 */
const SENSITIVE_FILES = ['config.json', 'secrets.json', 'keys.json', 'llm.json', 'all_keys.json'];

/**
 * 收紧「Super Time」全部敏感位置：状态目录、数据根，以及两者下的已知密钥文件。
 *
 * 目录先做**只读校验**：已收紧就跳过递归传播（见文件头注释），只补做文件级收紧。
 * @param {{ stateDir?: string, dataRoot?: string }} paths - 要处理的位置。
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   existsSync?: (p: string) => boolean,
 *   restrictDir?: (dir: string) => { ok: boolean, detail?: string },
 *   restrictFile?: (file: string) => { ok: boolean, detail?: string },
 *   isDirAclLocked?: (dir: string) => boolean,
 * }} [deps] - 注入点（缺省用真实实现；单测用来构造夹具，避免真的改 ACL）。
 * @returns {{ ok: boolean, failures: string[], skipped: string[], elapsedMs: number }} 汇总（失败不抛）。
 */
function restrictWechatState(paths = {}, deps = {}) {
  const startedAt = Date.now();
  const env = deps.env ?? process.env;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const restrictDirFn = deps.restrictDir ?? restrictDir;
  const restrictFileFn = deps.restrictFile ?? restrictFile;
  const isLockedFn = deps.isDirAclLocked ?? isDirAclLocked;
  const force = String(env.SUPERTIME_FORCE_ACL ?? '') === '1';
  const failures = [];
  const skipped = [];
  for (const dir of [paths.stateDir, paths.dataRoot]) {
    if (!dir) continue;
    if (!force && isLockedFn(dir)) {
      // 已收紧：目录级 ACE 会持续继承给新建子对象，无需再重写整棵子树。
      skipped.push(dir);
    } else {
      const r = restrictDirFn(dir);
      if (!r.ok && r.detail !== 'empty path') failures.push(`${dir}: ${r.detail}`);
    }
    for (const name of SENSITIVE_FILES) {
      const f = path.join(dir, name);
      if (!existsSync(f)) continue;
      const rf = restrictFileFn(f);
      if (!rf.ok && rf.detail !== 'missing') failures.push(`${f}: ${rf.detail}`);
    }
  }
  return { ok: failures.length === 0, failures, skipped, elapsedMs: Date.now() - startedAt };
}

module.exports = {
  SENSITIVE_FILES,
  currentUser,
  currentUserGrant,
  currentUserIdentity,
  isDirAclLocked,
  parseAclLockedForUser,
  resetUserIdentityCacheForTest,
  restrictDir,
  restrictFile,
  restrictWechatState,
};
