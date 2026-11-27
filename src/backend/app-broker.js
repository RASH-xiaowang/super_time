/**
 * 授权代理（本机命名管道）—— SuperTime 对 SuperLanguage 的唯一授权出口。
 *
 * ## 为什么是命名管道
 *  · 不开端口、不出网、不触发防火墙；局域网里的其它机器根本连不上；
 *  · 默认 DACL 由创建进程的用户令牌决定（当前用户 + 管理员），比自建 HTTP 鉴权少一层错。
 *
 * ## 授权判定的唯一来源
 * 这里**不自己读 license.json**，而是每次向注入的 `entitlement()` 要结论。
 * 那个函数背后是 `licenseService.getLicenseStatus` + `getAppEntitlement` ——
 * 许可证过期、换机、功能位被收走、席位降配，都会在下一次续期时立刻生效。
 *
 * ## 协议
 * 单行文本，收发都按 `\n` 切分（见 `app-lease.js` 顶部注释）：
 *   HELLO 1 <instanceId> <exeSha256> <proofHex>
 *   RENEW <instanceId> <proofHex>
 *   TICKET <claimHex> <macHex>
 *   DENY <code> <message...>
 *
 * 任何无法识别的报文一律回 DENY 并断开 —— 失败方向永远是拒绝。
 *
 * @module backend/app-broker
 */
const net = require('node:net');
const crypto = require('node:crypto');
const {
  LICENSE_GRACE_MS,
  TICKET_TTL_MS,
  clientProof,
  issueTicket,
  isHex,
  safeEqualHex,
} = require('./app-lease.js');

const MAX_LINE_BYTES = 4096;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 管道名带 userData 摘要：同一台电脑上多个用户/多个数据目录互不串线。 */
function pipeNameFor(stateDir) {
  const digest = crypto.createHash('sha256').update(String(stateDir), 'utf8').digest('hex').slice(0, 10);
  return '\\\\.\\pipe\\supertime-app-v1-' + digest;
}

function deny(code, message) {
  return 'DENY ' + code + ' ' + String(message || '').replace(/[\r\n]+/g, ' ').slice(0, 300);
}

/** 把授权结论翻译成票据；失败时返回 DENY 报文与机器码。 */
function ticketFor(ctx, instance, input) {
  const ent = ctx.entitlement();
  if (!ent.ok) {
    return { line: deny(ent.code || 'FEATURE_DENIED', ent.message || '当前授权不允许托管应用'), code: ent.code };
  }
  if (!instance.enabled) {
    return { line: deny('INSTANCE_DISABLED', '该实例已被停用，请在应用托管面板中启用'), code: 'INSTANCE_DISABLED' };
  }
  if (instance.seat > ent.maxInstances) {
    return {
      line: deny('SEAT_EXHAUSTED', '席位已降配到 ' + String(ent.maxInstances) + '，请释放该实例'),
      code: 'SEAT_EXHAUSTED',
    };
  }
  const exeSha256 = String(input.exeSha256 || instance.exeSha256 || '').toLowerCase();
  if (instance.exeSha256 !== '' && exeSha256 !== '' && exeSha256 !== instance.exeSha256) {
    return { line: deny('EXE_CHANGED', '程序文件与登记不一致，请重新部署'), code: 'EXE_CHANGED' };
  }
  const key = ctx.instanceKey(instance.id);
  if (key === '') return { line: deny('UNKNOWN_INSTANCE', '实例密钥缺失'), code: 'UNKNOWN_INSTANCE' };
  const ticket = issueTicket({
    secret: key,
    app: instance.appId,
    instanceId: instance.id,
    seat: instance.seat,
    licenseId: ent.licenseId || '',
    ...ticketGrants(ent, instance),
    exeSha256,
    ttlMs: TICKET_TTL_MS,
  });
  ctx.onLease(instance.id, ticket.payload);
  return { line: 'TICKET ' + ticket.claimHex + ' ' + ticket.mac, ticket: ticket.payload };
}

/**
 * 票据里的能力与配额：**证书是上限，实例登记只能更窄**。
 *
 * 管道模式（ticketFor）与推送模式（main.js 的 issueTicket）共用这一份口径，
 * 不然两条路的权限会各漂各的。
 * @param {object} entitlement - `getAppEntitlement` 的成功结果。
 * @param {object} instance - 注册表里的实例。
 * @returns {{ caps: string[], maxJobsPerHour: number }} 票据授权字段。
 */
function ticketGrants(entitlement, instance) {
  const instanceCaps = new Set(Array.isArray(instance.caps) ? instance.caps : []);
  const caps = (Array.isArray(entitlement.caps) ? entitlement.caps : [])
    .filter((cap) => instanceCaps.has(cap));
  const quota = Number(instance.maxJobsPerHour) > 0
    ? Math.min(Number(instance.maxJobsPerHour), entitlement.maxJobsPerHour)
    : entitlement.maxJobsPerHour;
  return { caps, maxJobsPerHour: quota };
}

/**
 * 处理一条客户端报文。
 * @param {object} ctx - `{ registry, entitlement, instanceKey, onLease }`。
 * @param {string} line - 一行文本。
 * @returns {{ reply: string|null, code?: string }}
 */
function handleLine(ctx, line) {
  const text = String(line || '').trim();
  if (text === '') return { reply: null };
  const parts = text.split(' ');
  const op = parts[0];
  if (op === 'HELLO') {
    if (parts.length < 5 || parts[1] !== '1') {
      return { reply: deny('BAD_REQUEST', 'HELLO 需要版本、实例 id、程序摘要与证明'), code: 'BAD_REQUEST' };
    }
    const instanceId = parts[2];
    const exeSha256 = parts[3].toLowerCase();
    const proof = parts[4];
    if (!UUID_PATTERN.test(instanceId)) {
      return { reply: deny('BAD_REQUEST', '实例 id 格式无效'), code: 'BAD_REQUEST' };
    }
    if (!isHex(exeSha256, 64)) {
      return { reply: deny('BAD_REQUEST', '程序摘要格式无效'), code: 'BAD_REQUEST' };
    }
    const instance = ctx.registry.get(instanceId);
    if (!instance) {
      return { reply: deny('UNKNOWN_INSTANCE', '该实例未在 Super Time 登记'), code: 'UNKNOWN_INSTANCE' };
    }
    const key = ctx.instanceKey(instanceId);
    if (key === '' || !isHex(proof, 64) || !safeEqualHex(clientProof(key, 'hello', instanceId, exeSha256), proof)) {
      return { reply: deny('BAD_PROOF', '实例密钥不匹配，请重新部署'), code: 'BAD_PROOF' };
    }
    const issued = ticketFor(ctx, instance, { exeSha256 });
    return { reply: issued.line, ...(issued.code === undefined ? {} : { code: issued.code }) };
  }
  if (op === 'RENEW') {
    if (parts.length < 3) {
      return { reply: deny('BAD_REQUEST', 'RENEW 需要实例 id 与证明'), code: 'BAD_REQUEST' };
    }
    const instanceId = parts[1];
    const proof = parts[2];
    if (!UUID_PATTERN.test(instanceId)) {
      return { reply: deny('BAD_REQUEST', '实例 id 格式无效'), code: 'BAD_REQUEST' };
    }
    const instance = ctx.registry.get(instanceId);
    if (!instance) {
      return { reply: deny('UNKNOWN_INSTANCE', '该实例未在 Super Time 登记'), code: 'UNKNOWN_INSTANCE' };
    }
    const key = ctx.instanceKey(instanceId);
    // 程序摘要沿用登记值：续期不信任客户端自报，避免「换 exe 后自动续期」。
    if (key === '' || !isHex(proof, 64) || !safeEqualHex(clientProof(key, 'renew', instanceId, instance.exeSha256), proof)) {
      return { reply: deny('BAD_PROOF', '实例密钥不匹配，请重新部署'), code: 'BAD_PROOF' };
    }
    const issued = ticketFor(ctx, instance, { exeSha256: instance.exeSha256 });
    return { reply: issued.line, ...(issued.code === undefined ? {} : { code: issued.code }) };
  }
  return { reply: deny('BAD_OP', '未知报文'), code: 'BAD_OP' };
}

/**
 * 监听管道。
 * @param {object} deps - `{ stateDir, registry, entitlement, onLease, onEvent }`。
 * @returns {{ pipePath: string, start: Function, stop: Function, status: Function }} 代理句柄。
 */
function createAppBroker(deps) {
  const registry = deps.registry;
  const pipePath = pipeNameFor(deps?.stateDir);
  const stats = { connections: 0, tickets: 0, denied: 0, lastDeniedCode: '', lastTicketAt: 0 };
  let server = null;
  const sockets = new Set();

  const ctx = {
    registry,
    entitlement: () => deps.entitlement(),
    instanceKey: (id) => registry.instanceKey(id),
    onLease: (id, payload) => {
      stats.tickets += 1;
      stats.lastTicketAt = Date.now();
      registry.update(id, { lastLeaseAt: Date.now(), lastSeenAt: Date.now() });
      try {
        deps.onEvent?.({ type: 'lease', instanceId: id, seat: payload.seat, exp: payload.exp });
      } catch {
        // 事件只用于面板刷新，失败不影响票据签发。
      }
    },
  };

  function start() {
    if (server !== null) return { ok: true, already: true };
    server = net.createServer((socket) => {
      stats.connections += 1;
      sockets.add(socket);
      socket.setEncoding('utf8');
      socket.setTimeout(IDLE_TIMEOUT_MS);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > MAX_LINE_BYTES * 4) {
          socket.end(deny('BAD_REQUEST', '报文过长') + '\n');
          return;
        }
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const result = handleLine(ctx, line);
          if (result.code !== undefined) {
            stats.denied += 1;
            stats.lastDeniedCode = result.code;
            try {
              deps.onEvent?.({ type: 'denied', code: result.code });
            } catch {
              // 同上：观测失败不影响拒绝本身。
            }
          }
          if (result.reply !== null) {
            socket.write(result.reply + '\n');
            if (result.reply.startsWith('DENY ')) {
              socket.end();
              return;
            }
          }
          index = buffer.indexOf('\n');
        }
      });
      socket.on('timeout', () => { socket.destroy(); });
      socket.on('error', () => { /* 客户端断开是常态 */ });
      socket.on('close', () => { sockets.delete(socket); });
    });
    server.on('error', (e) => {
      console.warn('[apps] 授权管道不可用：' + (e && e.message ? e.message : String(e)));
    });
    server.listen(pipePath);
    return { ok: true, pipePath };
  }

  function stop() {
    for (const socket of sockets) {
      try { socket.destroy(); } catch { /* 已关闭 */ }
    }
    sockets.clear();
    if (server !== null) {
      try { server.close(); } catch { /* 已关闭 */ }
      server = null;
    }
  }

  return {
    pipePath,
    start,
    stop,
    status: () => ({
      running: server !== null,
      pipePath,
      ...stats,
      graceMs: LICENSE_GRACE_MS,
    }),
  };
}

module.exports = {
  MAX_LINE_BYTES,
  IDLE_TIMEOUT_MS,
  createAppBroker,
  handleLine,
  pipeNameFor,
  ticketGrants,
};
