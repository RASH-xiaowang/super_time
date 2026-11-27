/**
 * 被托管应用的部署与进程托管（2026-11-24）。
 *
 * 只负责「把 SuperLanguage 放到实例目录、启动、探活、停止、代理 API」，
 * **授权判定不在这里**：启动前由 `ipc-apps` 过功能位，运行期由
 * `app-broker` 的票据控制 —— 两处都不依赖本模块的返回值。
 *
 * ## 实例目录
 * `<STATE_DIR>/apps/superlanguage/inst-<uuid>/`
 *   SuperLanguage.exe        同版本多份副本（`instance.lock` 与 queue.db 都在 exe 目录）
 *   instance.ini             绑定：实例 id、管道名、票据密钥
 *   api-enabled.txt = 1      HTTP API 必须开启，否则宿主管不到
 *   api-listen.txt  = loopback  只允许本机代理，避免局域网绕过授权
 *   api-token.txt   32 位 hex 由宿主预生成，令牌从第一秒就在宿主手里
 *   queue.db / resource-spool/ / *.log  由 SuperLanguage 自己维护
 *
 * ## 令牌纪律
 * Bearer 令牌只存在本模块的内存 Map 与实例目录文件里；`status()` 只回掩码。
 *
 * 实现刻意把每个动作写成模块级函数（`ctx` 显式传入），`createAppHost` 只做装配：
 * 单函数行数闸门要求「新增必须拆」，而这些动作本来就互不依赖。
 *
 * @module backend/app-host
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { restrictDir, restrictFile } = require('./secure-fs.js');
const { TICKET_TTL_MS } = require('./app-lease.js');
const { APP_DEFINITIONS } = require('./app-registry.js');

const START_TIMEOUT_MS = 25_000;
const STOP_TIMEOUT_MS = 6_000;
const LOG_TAIL_BYTES = 12_000;
const MAX_INSTANCES_RUNNING = 16;
/**
 * 局域网启动器的文件名。
 *
 * 部署时会把它和 exe 一起复制进实例目录：目标电脑上双击/开机自启这一份就够了。
 * 名字固定为 ASCII，避免 UNC 路径上出现编码差异。
 */
const LAUNCHER_NAME = 'superlanguage-launch-watch.cmd';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(16).toString('hex');
}

/** 只留首尾各 4 位；空串表示还没有令牌。 */
function maskToken(token) {
  return token.length > 10 ? token.slice(0, 4) + '***' + token.slice(-4) : '';
}

/**
 * 实例对外的 Webhook 地址（SuperTime 投递到它，它再驱动微信发送）。
 *
 * 端口是**系统分配的**，每次启动可能不同（见 SuperLanguage README），所以调用方
 * 必须现取，不能把上一次的地址当成长期配置。未运行/令牌缺失时返回空串。
 */
function instanceWebhookUrl(ctx, instance) {
  const port = readPort(ctx, instance);
  const token = readToken(ctx, instance);
  if (port <= 0 || token === '') return '';
  return 'http://' + instanceHost(instance) + ':' + String(port) + '/webhook/' + token;
}

/**
 * 地址脱敏：只保留 origin 与路径骨架（令牌变 `***`）。
 *
 * 与渲染层 `redactWebhookEndpoint` 同口径，但主进程是 CJS、拿不到那个 TS 模块，
 * 所以这里保留一份最小实现 —— 令牌绝不能以明文回到渲染层。
 */
function redactInstanceEndpoint(url) {
  if (typeof url !== 'string' || url === '') return '';
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname.replace(/(\/webhook\/)[^/]+/i, '$1***');
  } catch {
    return '';
  }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function writeText(file, text) {
  fs.writeFileSync(file, text, 'utf8');
}

/** 实例配置：SuperLanguage 用最朴素的 `key=value` 读它（避免在 C++ 里塞 JSON 解析）。 */
function instanceIniText(input) {
  return [
    'v=1',
    'app=superlanguage',
    'instance=' + input.instanceId,
    'broker=' + input.broker,
    'key=' + input.key,
    'exeSha256=' + input.exeSha256,
    '',
  ].join('\r\n');
}

function defOf(appId) {
  return APP_DEFINITIONS[appId] || null;
}

/** 源 exe：打包后在 resources/apps/superlanguage，开发态在仓库 apps/superlanguage/build。 */
function sourceExe(ctx) {
  const packed = ctx.deps.isPackaged
    ? path.join(String(ctx.deps.resourcesPath || ''), 'apps', 'superlanguage', 'SuperLanguage.exe')
    : '';
  if (packed !== '' && fs.existsSync(packed)) return packed;
  const dev = path.join(String(ctx.deps.repoRoot || ''), 'apps', 'superlanguage', 'build', 'SuperLanguage.exe');
  return fs.existsSync(dev) ? dev : '';
}

/**
 * 局域网启动器（`.start-request` 的消费方）的源文件。
 *
 * 解析顺序（任一命中即用）：
 *   ① `deps.launcherPath` —— 显式指定，测试与特殊打包布局用；
 *   ② 打包态：`resources/apps/superlanguage/`（由 `scripts/stage-superlanguage.mjs` 暂存）；
 *   ③ `deps.repoRoot/scripts/` —— 开发态的正常位置；
 *   ④ **本模块相对位置**：`src/backend/app-host.js` → `<repo>/scripts/`。
 *      这一条是给「repoRoot 被改写」的调用方（单测、外部嵌入）兜底的，
 *      否则会出现「exe 找得到、启动器找不到」这种半截部署。
 * 全都没命中返回空串 —— 部署仍会成功，只是结果里 `launcher: false` 说明要手工补。
 */
function launcherSource(ctx) {
  // 显式覆盖是**排他**的：给了路径就只认它（找不到即视为没有），
  // 否则「我想验证缺启动器的情形」会被下面的兜底悄悄补上。
  const explicit = String(ctx.deps.launcherPath || '');
  if (explicit !== '') return fs.existsSync(explicit) ? explicit : '';
  const candidates = [
    ctx.deps.isPackaged
      ? path.join(String(ctx.deps.resourcesPath || ''), 'apps', 'superlanguage', LAUNCHER_NAME)
      : '',
    path.join(String(ctx.deps.repoRoot || ''), 'scripts', LAUNCHER_NAME),
    path.join(__dirname, '..', '..', 'scripts', LAUNCHER_NAME),
  ];
  for (const candidate of candidates) {
    if (candidate !== '' && fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function instanceDirOf(ctx, instance) {
  // 局域网实例的目录由用户在部署时给出（通常是 B 机器上的共享目录）。
  if (instance.mode === 'lan' && instance.dir !== '') return instance.dir;
  const def = defOf(instance.appId);
  if (!def) return '';
  return path.join(ctx.deps.stateDir, 'apps', def.dirName, 'inst-' + instance.id);
}

/** 实例所在电脑：本机实例恒为 127.0.0.1（监听也强制 loopback）。 */
function instanceHost(instance) {
  return instance.mode === 'lan' && instance.host !== '' ? instance.host : '127.0.0.1';
}

function exePathOf(ctx, instance) {
  const dir = instanceDirOf(ctx, instance);
  return dir === '' ? '' : path.join(dir, defOf(instance.appId).exeName);
}

function readPort(ctx, instance) {
  const raw = readText(path.join(instanceDirOf(ctx, instance), 'api-port.txt')).trim();
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
}

function readToken(ctx, instance) {
  const cached = ctx.tokens.get(instance.id);
  if (typeof cached === 'string' && cached !== '') return cached;
  const raw = readText(path.join(instanceDirOf(ctx, instance), 'api-token.txt')).trim();
  if (/^[0-9a-f]{32}$/i.test(raw)) {
    ctx.tokens.set(instance.id, raw);
    return raw;
  }
  return '';
}

/**
 * 调用实例的 HTTP API。
 * @param {object} ctx - 托管器上下文。
 * @param {object} instance - 注册表里的实例。
 * @param {string} method - `GET` / `POST`。
 * @param {string} route - 以 `/api/` 开头。
 * @param {object} [body] - POST 请求体。
 * @returns {Promise<{ ok: boolean, status?: number, data?: unknown, error?: string }>}
 */
async function callApi(ctx, instance, method, route, body) {
  const port = readPort(ctx, instance);
  const token = readToken(ctx, instance);
  if (port <= 0) return { ok: false, error: '实例尚未就绪（缺少 API 端口）' };
  if (token === '') return { ok: false, error: '实例令牌缺失，请重新部署' };
  const timeout = Number(ctx.deps.fetchTimeoutMs) > 0 ? Number(ctx.deps.fetchTimeoutMs) : 6_000;
  try {
    const response = await fetch('http://' + instanceHost(instance) + ':' + String(port) + route, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    let data = null;
    try { data = text === '' ? null : JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data,
        error: (data && (data.message || data.error)) || ('HTTP ' + String(response.status)),
      };
    }
    return { ok: true, status: response.status, data };
  } catch (e) {
    const message = e && e.name === 'TimeoutError' ? '实例响应超时' : (e && e.message ? e.message : String(e));
    return { ok: false, error: message };
  }
}

async function waitHealthy(ctx, instance, deadline) {
  while (Date.now() < deadline) {
    const port = readPort(ctx, instance);
    if (port > 0) {
      const health = await callApi(ctx, instance, 'GET', '/api/health');
      if (health.ok) return health;
    }
    await sleep(250);
  }
  return { ok: false, error: '等待实例启动超时' };
}

/**
 * 把局域网启动器复制进实例目录。
 *
 * 用户的原话是「点部署的时候直接把启动器一起部署过去」—— 目标电脑上只需要
 * 双击这一份 `.cmd`，不需要再回仓库里找。复制失败（只读共享、杀软拦截）**不**让
 * 整个部署失败：exe 与授权绑定已经落地，用户可以手工补一次。
 * @param {object} ctx - 托管器上下文。
 * @param {string} dir - 实例目录（可能是 UNC）。
 * @returns {{ launcher: boolean, launcherError?: string }} 结果字段（直接并入部署返回值）。
 */
function copyLauncher(ctx, dir) {
  const source = launcherSource(ctx);
  if (source === '') return { launcher: false, launcherError: '未找到启动器源文件（scripts/' + LAUNCHER_NAME + '）' };
  try {
    const target = path.join(dir, LAUNCHER_NAME);
    const tmp = target + '.tmp';
    fs.copyFileSync(source, tmp);
    fs.renameSync(tmp, target);
    return { launcher: true };
  } catch (e) {
    return { launcher: false, launcherError: '启动器复制失败：' + (e && e.message ? e.message : String(e)) };
  }
}

/** 部署（或重新部署）一个实例：复制 exe、写配置、登记摘要。 */
function deploy(ctx, instanceId, options = {}) {
  const instance = ctx.registry.get(instanceId);
  if (!instance) return { ok: false, error: '实例不存在' };
  const def = defOf(instance.appId);
  if (!def) return { ok: false, error: '不支持的应用' };
  const source = String(options.source || sourceExe(ctx));
  if (source === '' || !fs.existsSync(source)) {
    return {
      ok: false,
      error: '未找到 ' + def.exeName + '；请先在仓库中构建 apps/superlanguage，或安装随包发布的版本',
      code: 'EXE_MISSING',
    };
  }
  const dir = instanceDirOf(ctx, instance);
  if (dir === '') return { ok: false, error: '实例目录无效' };
  const lan = instance.mode === 'lan';
  try {
    fs.mkdirSync(dir, { recursive: true });
    // UNC 共享目录上跑 icacls 会按远端 ACL 语义办事，可能把 A 自己锁在外面，跳过。
    if (!lan) restrictDir(dir);
    const target = path.join(dir, def.exeName);
    if (options.keepExe !== true || !fs.existsSync(target)) {
      const tmp = target + '.tmp';
      fs.copyFileSync(source, tmp);
      fs.renameSync(tmp, target);
    }
    const exeSha256 = sha256File(target);
    const key = ctx.registry.instanceKey(instance.id);
    if (key === '') return { ok: false, error: '实例密钥缺失，请重新创建实例' };
    writeText(path.join(dir, 'instance.ini'), instanceIniText({
      instanceId: instance.id,
      // 局域网实例拿不到本机命名管道，票据改由主进程推送（broker=push）。
      broker: lan ? 'push' : ctx.deps.brokerPipe,
      key,
      exeSha256,
    }));
    writeText(path.join(dir, 'api-enabled.txt'), '1');
    // 本机实例只许回环；局域网实例必须对外监听，由 B 的防火墙按来源 IP 收口。
    writeText(path.join(dir, 'api-listen.txt'), lan ? 'lan' : 'loopback');
    // 托管部署跳过「首次启动请把发送键设为 Ctrl+Enter」的提示窗：无人值守启动时
    // 它会挡住托盘启动，而且这个设置由部署方统一负责。
    writeText(path.join(dir, 'shortcut-tip.txt'), '1');
    if (!fs.existsSync(path.join(dir, 'send-timeout.txt'))) {
      writeText(path.join(dir, 'send-timeout.txt'), '45');
    }
    let token = readText(path.join(dir, 'api-token.txt')).trim();
    if (!/^[0-9a-f]{32}$/i.test(token)) {
      token = randomToken();
      writeText(path.join(dir, 'api-token.txt'), token);
    }
    ctx.tokens.set(instance.id, token);
    for (const name of ['instance.ini', 'api-enabled.txt', 'api-token.txt']) {
      if (!lan) restrictFile(path.join(dir, name));
    }
    // 启动器与 exe 一起落地：局域网实例的「远程拉起」靠它消费 `.start-request`。
    // 找不到源文件不算部署失败（本机实例根本用不到它），但要把事实回给界面。
    const launcher = copyLauncher(ctx, dir);
    ctx.registry.update(instance.id, { exeSha256, lastError: '' });
    return {
      ok: true,
      dir,
      exeSha256,
      tokenMasked: maskToken(token),
      mode: lan ? 'lan' : 'local',
      ...launcher,
    };
  } catch (e) {
    return { ok: false, error: '部署失败：' + (e && e.message ? e.message : String(e)) };
  }
}

function isRunning(ctx, instanceId) {
  const child = ctx.children.get(instanceId);
  return child !== undefined && child.exitCode === null && child.killed !== true;
}

/** 启动超时：单测可压到几百毫秒，生产用默认 25 秒。 */
function startTimeoutMs(ctx) {
  const value = Number(ctx.deps.startTimeoutMs);
  return value > 0 ? value : START_TIMEOUT_MS;
}

async function status(ctx, instanceId) {
  const instance = ctx.registry.get(instanceId);
  if (!instance) return { ok: false, error: '实例不存在' };
  const childAlive = isRunning(ctx, instanceId);
  // 判活一律以 API 为准：SuperTime 重启后实例还在跑，但主进程手里没有子进程句柄
  // （「接手」来的）。只看 children 会把活的实例显示成「已停止」。
  const health = await callApi(ctx, instance, 'GET', '/api/health');
  let details = null;
  if (health.ok) {
    const snapshot = await callApi(ctx, instance, 'GET', '/api/status');
    if (snapshot.ok) details = snapshot.data;
  }
  return {
    ok: true,
    running: health.ok,
    adopted: health.ok && !childAlive,
    deployed: fs.existsSync(exePathOf(ctx, instance)),
    health: health.ok ? health.data : null,
    details,
    tokenMasked: maskToken(readToken(ctx, instance)),
    error: health.ok ? '' : (childAlive ? '实例进程在运行但 API 不可用' : '实例未运行'),
  };
}

/**
 * 接手一个**已经在跑**的实例。
 *
 * 场景：SuperTime 升级/崩溃后重启，实例进程不会跟着退（它握着队列与单实例锁）。
 * 这时再 spawn 一份副本会被单实例锁拒绝并立即退出，界面只剩一句「已退出」。
 * 所以启动前先探活：健康的就直接接手，不再拉起第二个进程。
 * @returns 接手成功时返回启动结果；没在跑返回 null。
 */
async function adoptIfHealthy(ctx, instance) {
  const health = await callApi(ctx, instance, 'GET', '/api/health');
  if (!health.ok) return null;
  const snapshot = await callApi(ctx, instance, 'GET', '/api/status');
  const data = snapshot.ok && snapshot.data && typeof snapshot.data === 'object' ? snapshot.data : {};
  ctx.registry.update(instance.id, {
    lastSeenAt: Date.now(),
    lastError: '',
    ...(typeof data.version === 'string' ? { exeVersion: data.version } : {}),
  });
  try { ctx.deps.onEvent?.({ type: 'adopt', instanceId: instance.id }); } catch { /* 面板刷新尽力而为 */ }
  return { ok: true, adopted: true, status: await status(ctx, instance.id) };
}

/**
 * 子进程退出后的收口。
 *
 * 退出码 5（本版本新增）= 「本目录已有一份在跑」；退出码 0 秒退是旧版的同一情形。
 * 两种都先探活：如果那条实例其实还活着，就接手它并清掉错误，
 * 而不是把界面钉在「已停止 + 实例进程已退出」。
 */
async function handleChildExit(ctx, instanceId, code, signal) {
  const instance = ctx.registry.get(instanceId);
  if (!instance) return;
  const health = await callApi(ctx, instance, 'GET', '/api/health');
  if (health.ok) {
    ctx.registry.update(instanceId, { lastSeenAt: Date.now(), lastError: '' });
    try { ctx.deps.onEvent?.({ type: 'adopt', instanceId }); } catch { /* 同上 */ }
    return;
  }
  const base = '实例进程已退出（code=' + String(code) + (signal ? ', signal=' + signal : '') + '）';
  const reason = (code === 5 || code === 0)
    ? base + '：本目录已有一份 SuperLanguage 在运行（单实例锁）或启动后立即退出；点「启动」会重新接手'
    : base;
  ctx.registry.update(instanceId, { lastError: reason, lastSeenAt: Date.now() });
  try { ctx.deps.onEvent?.({ type: 'exit', instanceId, code }); } catch { /* 同上 */ }
}

/** 推送票据的间隔：票据 TTL 的一半，保证到期前一定有一次成功推送。 */
function pushIntervalMs(ctx) {
  const override = Number(ctx.deps.ticketPushIntervalMs);
  return override > 0 ? override : Math.max(30_000, Math.floor(TICKET_TTL_MS / 2));
}

function stopTicketPush(ctx, instanceId) {
  const timer = ctx.pushes.get(instanceId);
  if (timer === undefined) return;
  clearInterval(timer);
  ctx.pushes.delete(instanceId);
}

/**
 * 推一次票据给局域网实例。
 *
 * 签名在**主进程**完成（`deps.issueTicket` 背后是许可证状态），所以实例那边
 * 只需要验签；令牌与私钥都不出主进程。
 * @returns {Promise<{ ok: boolean, error?: string, code?: string }>} 推送结果。
 */
async function pushTicketOnce(ctx, instance) {
  if (typeof ctx.deps.issueTicket !== 'function') {
    return { ok: false, error: '未配置票据签发器' };
  }
  let built;
  try {
    built = ctx.deps.issueTicket(instance);
  } catch (e) {
    built = { ok: false, error: e && e.message ? e.message : String(e) };
  }
  if (!built || built.ok !== true) {
    const reason = '票据签发被拒绝：' + String(built && built.error ? built.error : '未知原因');
    ctx.registry.update(instance.id, { lastError: reason });
    return { ok: false, error: reason, ...(built && built.code ? { code: built.code } : {}) };
  }
  const posted = await callApi(ctx, instance, 'POST', '/api/license/lease', {
    claim: built.claimHex,
    mac: built.mac,
  });
  if (!posted.ok) {
    const reason = '票据推送失败：' + String(posted.error || '实例未接受');
    ctx.registry.update(instance.id, { lastError: reason });
    return { ok: false, error: reason };
  }
  ctx.registry.update(instance.id, {
    lastLeaseAt: Date.now(),
    lastSeenAt: Date.now(),
    lastError: '',
  });
  try { ctx.deps.onEvent?.({ type: 'lease', instanceId: instance.id }); } catch { /* 同上 */ }
  return { ok: true };
}

function startTicketPush(ctx, instance) {
  stopTicketPush(ctx, instance.id);
  void pushTicketOnce(ctx, instance).catch(() => undefined);
  const timer = setInterval(() => {
    void pushTicketOnce(ctx, instance).catch(() => undefined);
  }, pushIntervalMs(ctx));
  if (typeof timer.unref === 'function') timer.unref();
  ctx.pushes.set(instance.id, timer);
}

/** B 机器上的启动器会盯着这个文件（见 scripts/superlanguage-launch-watch.cmd）。 */
const REMOTE_START_FILE = '.start-request';

/**
 * 局域网实例的启动：本机 spawn 不了别的电脑上的 exe。
 *
 * 约定：A 往实例目录（共享）写一个请求文件，B 上的一次性启动器看到就拉起 exe。
 * 这条路径不新增任何网络监听，A 需要的权限与「能在共享里写文件」完全相同 ——
 * 而它本来就必须能写，否则部署也做不了。
 */
async function startRemote(ctx, instance) {
  const adopted = await adoptIfHealthy(ctx, instance);
  if (adopted !== null) {
    startTicketPush(ctx, instance);
    return adopted;
  }
  const dir = instanceDirOf(ctx, instance);
  let queued = false;
  try {
    writeText(path.join(dir, REMOTE_START_FILE), String(Date.now()));
    queued = true;
  } catch {
    queued = false;
  }
  if (!queued) {
    return {
      ok: false,
      code: 'REMOTE_START_UNAVAILABLE',
      error: '写入启动请求失败：共享目录不可写。请检查 ' + dir + ' 的权限，'
        + '或在那台电脑上直接双击 ' + LAUNCHER_NAME,
    };
  }
  const healthy = await waitHealthy(ctx, instance, Date.now() + startTimeoutMs(ctx) * 2);
  if (!healthy.ok) {
    const hint = '已写入启动请求，但实例没有响应：请在目标电脑（'
      + instanceHost(instance) + '）上双击实例目录里的 '
      + LAUNCHER_NAME + '（「部署」已把它一起带过去），并确认防火墙允许本机访问该端口';
    ctx.registry.update(instance.id, { lastError: hint });
    return { ok: false, code: 'REMOTE_START_TIMEOUT', error: hint };
  }
  startTicketPush(ctx, instance);
  return { ok: true, remote: true, status: await status(ctx, instance.id) };
}

/** 启动实例；已在运行则直接探活。 */
async function start(ctx, instanceId) {
  const instance = ctx.registry.get(instanceId);
  if (!instance) return { ok: false, error: '实例不存在' };
  if (!instance.enabled) return { ok: false, error: '实例已停用，请先启用' };
  if (isRunning(ctx, instanceId)) return status(ctx, instanceId);
  const pending = ctx.starts.get(instanceId);
  if (pending) return pending;
  const exe = exePathOf(ctx, instance);
  if (exe === '' || !fs.existsSync(exe)) {
    return { ok: false, error: '实例尚未部署，请先点「部署」', code: 'NOT_DEPLOYED' };
  }
  const adopted = await adoptIfHealthy(ctx, instance);
  if (adopted !== null) {
    // 接手来的局域网实例同样需要继续推票据（否则到期后停发）。
    if (instance.mode === 'lan') startTicketPush(ctx, instance);
    return adopted;
  }
  // 局域网实例的 exe 不在这台机器上：走共享目录请求 + 推送票据。
  if (instance.mode === 'lan') return startRemote(ctx, instance);
  if (ctx.children.size >= MAX_INSTANCES_RUNNING) {
    return { ok: false, error: '同时运行的实例过多（上限 ' + String(MAX_INSTANCES_RUNNING) + '）' };
  }
  const run = (async () => {
    try {
      const spawnChild = ctx.deps.spawnFn || spawn;
      const child = spawnChild(exe, [], {
        cwd: path.dirname(exe),
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          // 明确的实例标识：SuperLanguage 优先用它，其次读 instance.ini。
          SUPERTIME_APP_INSTANCE: instance.id,
          SUPERTIME_BROKER_PIPE: ctx.deps.brokerPipe,
        },
      });
      ctx.children.set(instanceId, child);
      child.once('exit', (code, signal) => {
        ctx.children.delete(instanceId);
        void handleChildExit(ctx, instanceId, code, signal);
      });
      child.once('error', (e) => {
        ctx.registry.update(instanceId, { lastError: '启动失败：' + (e && e.message ? e.message : String(e)) });
      });
      const healthy = await waitHealthy(ctx, instance, Date.now() + startTimeoutMs(ctx));
      if (!healthy.ok) {
        ctx.registry.update(instanceId, { lastError: healthy.error || '启动超时' });
        return { ok: false, error: healthy.error || '实例启动超时', code: 'START_TIMEOUT' };
      }
      const data = healthy.data && typeof healthy.data === 'object' ? healthy.data : {};
      ctx.registry.update(instanceId, {
        lastSeenAt: Date.now(),
        lastError: '',
        ...(typeof data.version === 'string' ? { exeVersion: data.version } : {}),
      });
      return { ok: true, status: await status(ctx, instanceId) };
    } catch (e) {
      return { ok: false, error: '启动失败：' + (e && e.message ? e.message : String(e)) };
    } finally {
      ctx.starts.delete(instanceId);
    }
  })();
  ctx.starts.set(instanceId, run);
  return run;
}

async function stop(ctx, instanceId) {
  const instance = ctx.registry.get(instanceId);
  if (!instance) return { ok: false, error: '实例不存在' };
  const child = ctx.children.get(instanceId);
  // 没有子进程句柄不代表没在跑：SuperTime 重启后，实例是「接手」来的。
  // 这时也要真的把它停掉（/api/stop 会关队列、删端口文件），否则按钮点了没反应。
  if (child === undefined) {
    if (!(await callApi(ctx, instance, 'GET', '/api/health')).ok) return { ok: true, already: true };
    await callApi(ctx, instance, 'POST', '/api/stop', {}).catch(() => undefined);
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await callApi(ctx, instance, 'GET', '/api/health')).ok) {
        return { ok: true, adopted: true };
      }
      await sleep(200);
    }
    return { ok: false, error: '已请求停止，但实例仍在响应；请稍后刷新，或手动结束该进程' };
  }
  // 先走优雅停止（SuperLanguage 的 /api/stop 会关队列、删端口文件），再兜底杀进程。
  await callApi(ctx, instance, 'POST', '/api/stop', {}).catch(() => undefined);
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { ok: true };
    await sleep(150);
  }
  try { child.kill(); } catch { /* 已退出 */ }
  return { ok: true, forced: true };
}

/** 代理一次受控调用；令牌不经过调用方。 */
async function proxy(ctx, instanceId, action, payload) {
  const instance = ctx.registry.get(instanceId);
  if (!instance) return { ok: false, error: '实例不存在' };
  const body = payload && typeof payload === 'object' ? payload : {};
  switch (action) {
    case 'status': return callApi(ctx, instance, 'GET', '/api/status');
    case 'health': return callApi(ctx, instance, 'GET', '/api/health');
    case 'job': {
      const id = String(body.id || '').trim();
      if (!/^[0-9a-zA-Z_-]{1,64}$/.test(id)) return { ok: false, error: '任务 id 无效' };
      return callApi(ctx, instance, 'GET', '/api/jobs/' + id);
    }
    case 'sendMessage': return callApi(ctx, instance, 'POST', '/api/send-message', body);
    case 'sendAttachments': return callApi(ctx, instance, 'POST', '/api/send-attachments', body);
    case 'stop': return callApi(ctx, instance, 'POST', '/api/stop', {});
    default: return { ok: false, error: '不支持的代理动作：' + String(action) };
  }
}

function logs(ctx, instanceId, tailBytes = LOG_TAIL_BYTES) {
  const instance = ctx.registry.get(instanceId);
  if (!instance) return { ok: false, error: '实例不存在' };
  const file = path.join(instanceDirOf(ctx, instance), 'flow-debug.log');
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - Math.max(1024, Number(tailBytes) || LOG_TAIL_BYTES));
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return { ok: true, path: file, text: buffer.toString('utf8') };
  } catch {
    return { ok: true, path: file, text: '' };
  }
}

async function remove(ctx, instanceId, options = {}) {
  await stop(ctx, instanceId);
  const instance = ctx.registry.get(instanceId);
  if (!instance) return { ok: false, error: '实例不存在' };
  const dir = instanceDirOf(ctx, instance);
  if (options.purge === true && dir !== '' && fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 下次部署会覆盖 */ }
  }
  stopTicketPush(ctx, instanceId);
  ctx.children.delete(instanceId);
  ctx.tokens.delete(instanceId);
  ctx.registry.remove(instanceId);
  return { ok: true };
}

async function dispose(ctx) {
  for (const id of [...ctx.pushes.keys()]) stopTicketPush(ctx, id);
  await Promise.all([...ctx.children.keys()].map((id) => stop(ctx, id).catch(() => undefined)));
}

/**
 * 建托管器。
 * @param {object} deps - `{ stateDir, registry, brokerPipe, isPackaged, resourcesPath, repoRoot, onEvent, spawnFn }`。
 *   `spawnFn` 只给单测注入：默认用 `node:child_process.spawn`，这样「接手已运行实例」的
 *   分支可以不真的拉起进程地被断言。
 * @returns {object} 部署/生命周期/代理接口。
 */
function createAppHost(deps) {
  const ctx = {
    deps,
    registry: deps.registry,
    children: new Map(),
    tokens: new Map(),
    starts: new Map(),
    /** 局域网实例的票据推送定时器：instanceId → timer。 */
    pushes: new Map(),
  };
  return {
    sourceExe: () => sourceExe(ctx),
    instanceDirOf: (instance) => instanceDirOf(ctx, instance),
    exePathOf: (instance) => exePathOf(ctx, instance),
    deploy: (id, options) => deploy(ctx, id, options),
    start: (id) => start(ctx, id),
    stop: (id) => stop(ctx, id),
    status: (id) => status(ctx, id),
    proxy: (id, action, payload) => proxy(ctx, id, action, payload),
    logs: (id, tailBytes) => logs(ctx, id, tailBytes),
    remove: (id, options) => remove(ctx, id, options),
    dispose: () => dispose(ctx),
    isRunning: (id) => isRunning(ctx, id),
    callApi: (instance, method, route, body) => callApi(ctx, instance, method, route, body),
    // 「下游地址选托管应用」需要的两个只读/纯函数能力：
    webhookUrlOf: (instance) => instanceWebhookUrl(ctx, instance),
    redactEndpoint: (url) => redactInstanceEndpoint(url),
    /** 立即补推一次票据（面板「刷新」/改配额后用）。 */
    pushTicket: (id) => {
      const instance = ctx.registry.get(id);
      return instance ? pushTicketOnce(ctx, instance) : Promise.resolve({ ok: false, error: '实例不存在' });
    },
  };
}

module.exports = {
  START_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  createAppHost,
  instanceIniText,
  maskToken,
  instanceWebhookUrl,
  redactInstanceEndpoint,
};
