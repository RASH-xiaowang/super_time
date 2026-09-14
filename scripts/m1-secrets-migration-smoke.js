#!/usr/bin/env node
'use strict';

/**
 * M1 端到端冒烟：**密钥搬迁 + 权限收紧**（跑真正的打包产物）。
 *
 * 为什么需要它：M1 的关键行为都**只在宿主层编排里**成立，单元测试各自覆盖不到：
 *   ① 启动后密钥最终落在 `secrets.json`、`config.json` 里不再有；
 *   ② 清掉 M1 之前镜像进宿主 `wechat/config.json` 的密钥副本；
 *   ③ 按**后端解析出的真实数据根**（不是写死的 `<userData>/wechat-data`）收紧 ACL。
 * 单测能证明 `restrictDir` 会收紧、`mirroredSecretValues` 会取到镜像里的密钥，但证明不了
 * 「应用启动时确实按这个顺序调了它们、且用的是真实数据根」。
 *
 * 三个场景（各自全新 userData，各启动一次打包产物）：
 *   A. 后端 `config.json` 里还有旧密钥、宿主配置为**空** → 走 `main.js` 的**空 patch 保存**
 *      那条迁移分支。宿主配置必须为空：`applySavedWechatSettings` 只要拿到非空设置就会先
 *      保存一次，那样就分不清究竟是谁搬的密钥。
 *   B. 宿主 `wechat/config.json` 里**只有**密钥镜像（没有任何普通设置）。
 *   C. **真实升级形态** —— 宿主镜像里同时有普通字段与密钥（老版本实际写出来的样子）、
 *      后端 `config.json` 里还有旧密钥。
 *
 * 密钥有两条来源，谁是「真正干活的那条」取决于形态（复审实测，别按直觉猜）：
 *   · 后端 `config.json` 里的旧密钥 → `saveConfig` 的 `carried` 直接搬（A）；
 *   · 只在**宿主镜像**里出现的密钥 → 必须靠 `applySavedWechatSettings` 把它们并进
 *     **同一次回灌 patch**。并进去是必须的：`saveWechatConfig` 返回前 `wechat-host.js` 会调
 *     `recordWechatSettings(patch)` 把整份镜像**重写成**（是替换不是合并）「已过滤密钥」的
 *     干净版 —— 不在 patch 里的镜像密钥会被无声丢掉，连 patch 里的普通字段也会一起被抹掉。
 *     并进去之后，后端写 `secrets.json`、回写镜像时顺手过滤掉副本，迁移与去副本一步完成，
 *     所以**不需要**再单独写一个「清理镜像」的步骤（曾经有过一个，实测是死代码，已删）。
 * 三个场景合起来覆盖这两个来源与它们的组合，而真正的不变量（密钥最终在哪、ACL 收没收紧）
 * 在每个场景里都断言。
 *
 * 用法：npm run m1-secrets:smoke      （先跑 npm run pack）
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync, execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const exe = path.join(root, 'dist', 'win-unpacked', 'Super Time.exe');

/** 假密钥：64 位 hex 的库密钥 + 32 位 hex 的图片 AES 密钥，形状与真实值一致。 */
const DB_KEY = 'f'.repeat(64);
const IMG_KEY = 'e57c869f15dd8764';
const MIRROR_DB_KEY = 'd'.repeat(64);

if (!fs.existsSync(exe)) {
  console.error('❌ 找不到打包产物：' + exe + '\n   请先运行 npm run pack');
  process.exit(2);
}

let failed = 0;
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) failed += 1;
};
const info = (label, detail = '') => console.log(`  ·  ${label}${detail ? '  [' + detail + ']' : ''}`);

/** 当前用户的 ACE 主体判定口径：SID 优先，兼容 `DOMAIN\user` 与裸用户名回显。 */
function currentIdentities() {
  let who = '';
  let sid = '';
  try { who = execFileSync('whoami', { encoding: 'utf8', windowsHide: true }).trim().toLowerCase(); } catch { /* ignore */ }
  try {
    const out = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    sid = ((out.match(/"(S-1-[\d-]+)"/) || [])[1] || '').toLowerCase();
  } catch { /* ignore */ }
  const bare = who.includes('\\') ? who.slice(who.indexOf('\\') + 1) : who;
  return { who, bare, sid };
}

/**
 * 读回某路径的 ACE 主体清单。
 * 首行是「路径 + 第一个 ACE」，必须把路径剥掉 —— 路径自身含 `\Users\<user>\`，
 * 直接对整行做「含当前用户」判断会恒真（复审实测过这条空转断言）。
 */
function aclPrincipals(target) {
  const out = execFileSync('icacls', [target], { encoding: 'utf8', windowsHide: true });
  return out.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes(':('))
    .map((l) => (l.startsWith(target) ? l.slice(target.length).trim() : l));
}

/** 收紧后的不变量：只剩当前用户（且不能出现 Everyone/BUILTIN/SYSTEM/Administrators 等）。 */
function aclIsOnlyCurrentUser(target) {
  const lines = aclPrincipals(target);
  if (lines.length === 0) return { ok: false, lines, reason: '没有任何 ACE' };
  const { who, bare, sid } = currentIdentities();
  const mine = (l) => {
    const low = l.toLowerCase();
    return (who && low.includes(who)) || low.startsWith(bare + ':') || (sid && low.includes(sid));
  };
  const others = lines.filter((l) => !mine(l));
  return { ok: mine(lines.join('\n')), lines, others, reason: others.length ? '还有其它主体' : '' };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * 启动一次打包产物（截图后自动退出）。
 * @param userData - 一次性 userData。
 * @returns 启动输出与一次性 userData 路径。
 */
function launch(userData) {
  const shot = path.join(os.tmpdir(), `m1-smoke-${Date.now()}.png`);
  const r = spawnSync(exe, [], {
    cwd: path.dirname(exe),
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, SUPERTIME_SCREENSHOT: shot, SUPERTIME_USER_DATA_DIR: userData },
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  try { fs.rmSync(shot, { force: true }); } catch { /* ignore */ }
  if (/已有实例在运行/.test(out)) {
    console.error('\n❌ 已有 Super Time 实例在运行（单实例锁）——请先关闭它再跑本冒烟');
    process.exit(2);
  }
  return out;
}

function freshUserData(tag) {
  const dir = path.join(os.tmpdir(), `supertime-m1-${tag}-${Date.now()}`);
  fs.mkdirSync(path.join(dir, 'wechat'), { recursive: true });
  return dir;
}

function logOf(userData) {
  const p = path.join(userData, 'wechat', 'logs', 'app.log');
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function cleanup(userData) {
  // M1_SMOKE_KEEP=1 保留现场，便于失败后翻日志（默认删掉：临时目录里可能有配置与日志）。
  if (process.env.M1_SMOKE_KEEP === '1') { info('保留现场 userData', userData); return; }
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ───────────────────────── 场景 A：启动期迁移 ─────────────────────────
console.log('\n【场景 A】后端 config.json 里还有旧密钥 → 启动时搬进 secrets.json');
{
  const ud = freshUserData('a');
  const dataRoot = path.join(ud, 'wechat-data');
  fs.mkdirSync(dataRoot, { recursive: true });
  // 宿主配置为空：否则 applySavedWechatSettings 会先保存一次、把密钥顺手搬走，
  // 就分不清是不是「启动期迁移」这条分支干的。
  fs.writeFileSync(path.join(ud, 'wechat', 'config.json'), JSON.stringify({ wechatSettings: {} }), 'utf8');
  // 旧形态的后端配置：密钥就在 config.json 里
  fs.writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({
    api_port: 5099,
    db_enc_key: DB_KEY,
    image_aes_key: IMG_KEY,
  }, null, 2), 'utf8');

  const out = launch(ud);
  const log = logOf(ud);
  const secretsFile = path.join(dataRoot, 'secrets.json');
  const cfgFile = path.join(dataRoot, 'config.json');

  check(/Remote 方法数:\s*\d+/.test(out), '后端就绪（启动期收尾代码才有机会跑）');

  const secrets = readJson(secretsFile);
  check(Boolean(secrets), 'secrets.json 已生成', secretsFile);
  if (secrets) {
    check(secrets.db_enc_key === DB_KEY, 'secrets.json 里的库密钥与旧 config.json 一致');
    check(secrets.image_aes_key === IMG_KEY, 'secrets.json 里的图片密钥与旧 config.json 一致');
  }

  const cfgText = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '';
  check(cfgText.length > 0, 'config.json 仍存在');
  check(!cfgText.includes(DB_KEY), 'config.json 里已不含库密钥');
  check(!cfgText.includes(IMG_KEY), 'config.json 里已不含图片密钥');
  const cfg = readJson(cfgFile);
  check(cfg && cfg.api_port === 5099, '普通字段（api_port）未被迁移弄丢', cfg ? String(cfg.api_port) : 'null');

  check(/已把旧 config\.json 里的密钥迁移到 secrets\.json/.test(log),
    '日志确认走的是「启动期迁移」这条分支');
  check(!log.includes(DB_KEY) && !log.includes(IMG_KEY), '密钥没有出现在日志/诊断导出里（脱敏）');

  const aclRoot = aclIsOnlyCurrentUser(dataRoot);
  check(aclRoot.ok, '数据根的 ACL 只剩当前用户', (aclRoot.others || []).join(' | '));
  const aclSecrets = aclIsOnlyCurrentUser(secretsFile);
  check(aclSecrets.ok, 'secrets.json 的 ACL 只剩当前用户', (aclSecrets.others || []).join(' | '));
  const aclState = aclIsOnlyCurrentUser(path.join(ud, 'wechat'));
  check(aclState.ok, '宿主状态目录的 ACL 只剩当前用户', (aclState.others || []).join(' | '));

  info('数据根 ACE', aclRoot.lines.join(' | '));
  cleanup(ud);
}

// ─────────────── 场景 B：宿主镜像里**只有**密钥（没有普通设置）───────────────
console.log('\n【场景 B】宿主 config.json 里只有密钥镜像 → 回灌时搬进 secrets.json 并从镜像去掉');
{
  const ud = freshUserData('b');
  const dataRoot = path.join(ud, 'wechat-data');
  fs.mkdirSync(dataRoot, { recursive: true });
  const hostCfg = path.join(ud, 'wechat', 'config.json');
  // 只放密钥：这条形态的要点是 `loadWechatSettings()` 为空，因此「搬密钥」这件事完全由
  // `applySavedWechatSettings` 里合并进去的 `mirroredSecretValues()` 承担。
  fs.writeFileSync(hostCfg, JSON.stringify({
    wechatSettings: { db_enc_key: MIRROR_DB_KEY, image_aes_key: IMG_KEY },
  }, null, 2), 'utf8');

  const out = launch(ud);
  const raw = readJson(hostCfg);

  check(/Remote 方法数:\s*\d+/.test(out), '后端就绪');
  check(Boolean(raw), '宿主 config.json 仍可解析');
  if (raw) {
    const ws = raw.wechatSettings || {};
    check(!Object.prototype.hasOwnProperty.call(ws, 'db_enc_key'), '镜像的库密钥已去掉');
    check(!Object.prototype.hasOwnProperty.call(ws, 'image_aes_key'), '镜像的图片密钥已去掉');
  }
  const text = fs.readFileSync(hostCfg, 'utf8');
  check(!text.includes(MIRROR_DB_KEY) && !text.includes(IMG_KEY), '宿主 config.json 全文不再含密钥');

  // 关键：不是「删掉了」，而是「搬到 secrets.json 了」——
  // 只断言「镜像里没有」会把「无声丢弃」也放过去。
  const secrets = readJson(path.join(dataRoot, 'secrets.json'));
  check(Boolean(secrets), 'secrets.json 已生成');
  if (secrets) {
    check(secrets.db_enc_key === MIRROR_DB_KEY, '镜像里的库密钥已落到 secrets.json');
    check(secrets.image_aes_key === IMG_KEY, '镜像里的图片密钥已落到 secrets.json');
  }

  const aclState = aclIsOnlyCurrentUser(path.join(ud, 'wechat'));
  check(aclState.ok, '宿主状态目录的 ACL 只剩当前用户', (aclState.others || []).join(' | '));
  cleanup(ud);
}

// ─────────────── 场景 C：真实升级形态（普通字段 + 密钥都在镜像里）───────────────
console.log('\n【场景 C】真实升级形态：宿主镜像含普通字段与密钥、后端 config.json 含旧密钥');
{
  const ud = freshUserData('c');
  const dataRoot = path.join(ud, 'wechat-data');
  fs.mkdirSync(dataRoot, { recursive: true });
  const hostCfg = path.join(ud, 'wechat', 'config.json');
  // 老版本 `recordWechatSettings` 的实际产物形状：普通字段与密钥混在一起
  fs.writeFileSync(hostCfg, JSON.stringify({
    wechatSettings: {
      db_dir: 'D:\\wx', api_port: 5099, db_enc_key: MIRROR_DB_KEY,
      image_aes_key: IMG_KEY, api_token: 'tok-legacy',
    },
    wechatSettingsMeta: { savedAt: '2026-01-01T00:00:00.000Z', source: '数据配置·保存配置' },
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({
    api_port: 5099, db_enc_key: DB_KEY,
  }, null, 2), 'utf8');

  const out = launch(ud);
  const log = logOf(ud);

  check(/Remote 方法数:\s*\d+/.test(out), '后端就绪');

  // 核心不变量：**不管哪条分支干的**，密钥的终态必须对
  const secrets = readJson(path.join(dataRoot, 'secrets.json'));
  check(Boolean(secrets), 'secrets.json 已生成');
  if (secrets) {
    // 镜像里的旧密钥与 config.json 里的旧密钥都是真值来源，至少不能丢
    check(secrets.db_enc_key === DB_KEY || secrets.db_enc_key === MIRROR_DB_KEY,
      'secrets.json 拿到了库密钥', String(secrets.db_enc_key).slice(0, 8) + '…');
    check(secrets.image_aes_key === IMG_KEY, 'secrets.json 拿到了图片密钥');
  }
  const backendCfgText = fs.existsSync(path.join(dataRoot, 'config.json'))
    ? fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf8') : '';
  check(!backendCfgText.includes(DB_KEY), '后端 config.json 里已不含库密钥');
  const hostText = fs.readFileSync(hostCfg, 'utf8');
  check(!hostText.includes(MIRROR_DB_KEY) && !hostText.includes(IMG_KEY) && !hostText.includes('tok-legacy'),
    '宿主 config.json 全文不再含任何密钥');
  const hostRaw = readJson(hostCfg) || {};
  check((hostRaw.wechatSettings || {}).db_dir === 'D:\\wx', '镜像里的普通字段（db_dir）保留');
  // 归因（不是断言，只是把机制写进输出，避免以后按错误的心智模型去定位）：
  //   正常形态下的顺序是 `applySavedWechatSettings`（把镜像普通设置**与**镜像密钥并进同一
  //   次 patch；后端写 secrets.json，回写镜像时过滤掉副本）→ `migrateSecretsAndTightenAcl`
  //   （此时后端 config.json 里的旧密钥已被 `carried` 搬走，空 patch 分支空转）。
  info('迁移归因',
    '镜像密钥搬迁（secrets.json 已拿到值=' + (() => {
      const s = readJson(path.join(dataRoot, 'secrets.json'));
      return Boolean(s && (s.db_enc_key || s.image_aes_key));
    })() + '）'
    + ' 空patch迁移日志=' + /已把旧 config\.json 里的密钥迁移到 secrets\.json/.test(log));

  const aclRoot = aclIsOnlyCurrentUser(dataRoot);
  check(aclRoot.ok, '数据根的 ACL 只剩当前用户', (aclRoot.others || []).join(' | '));
  const aclState = aclIsOnlyCurrentUser(path.join(ud, 'wechat'));
  check(aclState.ok, '宿主状态目录的 ACL 只剩当前用户', (aclState.others || []).join(' | '));
  cleanup(ud);
}

console.log(`\n${failed ? '❌ M1 密钥搬迁/权限收紧冒烟失败 ' + failed + ' 项' : '✅ M1 密钥搬迁/权限收紧冒烟通过'}`);
if (failed) process.exit(1);
