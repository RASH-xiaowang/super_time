'use strict';

/**
 * 消息列表局域网 Webhook 的宿主路由（2026-10-27）。
 *
 * 与 RPA 图片直链一样，这条路由排在会话 Cookie 校验之前：外部系统拿不到 Cookie，
 * 凭据放在 URL 路径里。路径令牌由 `api_token` 域分离派生，轮换令牌后旧地址立即失效。
 * 路由只做验签、读请求体与转调 `ingestMessageListWebhook`；清洗/落库/投递都在后端。
 *
 * 失败统一返回 404 的情况只包括「令牌不存在或无效」；合法的入站请求即使下游投递失败，
 * 也会返回 200 + accepted，因为记录已经落库，调用方重放会造成重复记录。
 *
 * @module backend/message-webhook
 */

/** 路径前缀，与 `wechat-data/src/net/message-webhook.ts` 保持一致。 */
const MESSAGE_WEBHOOK_PATH_PREFIX = '/api/message-webhook/';

function defaultTokenModuleLoader() {
  return import('./wechat-data/lib/net/message-webhook.js');
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function notFound(res) {
  sendJson(res, 404, { ok: false, error: { message: 'Webhook 不存在或令牌已失效', code: 'WEBHOOK_NOT_FOUND' } });
}

/**
 * 入站接口只需要让调用方知道落库/投递台账结果，不能回传完整记录。
 * 记录里的 webhookUrl、replyId 等字段可能包含下游地址或业务标识，必须在此收口。
 */
function publicRecordOf(value, record) {
  const out = { id: record.id };
  if (typeof record.status === 'string') out.status = record.status;
  if (typeof record.created === 'boolean') out.created = record.created;
  else if (typeof value.created === 'boolean') out.created = value.created;
  if (Number.isSafeInteger(record.attempts) && record.attempts >= 0) out.attempts = record.attempts;
  return out;
}

function publicDeliveryError(error) {
  if (typeof error !== 'string') return error;
  return error.replace(/\b(https?:\/\/[^\s"'<>]+)/gi, (raw) => {
    try {
      const url = new URL(raw);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      url.pathname = url.pathname
        .replace(/(\/webhook\/)[^/]+/i, '$1***')
        .replace(/(\/api\/message-webhook\/)[^/]+/i, '$1***');
      return url.toString();
    } catch {
      return '[已隐藏地址]';
    }
  }).slice(0, 500);
}

/**
 * @param {object} deps
 * @param {() => string} deps.getApiToken - 每次现取 `secrets.json` 的 api_token。
 * @param {(payload: object) => Promise<unknown>} deps.ingest - 过闸后调用后端。
 * @param {object} [options]
 * @param {() => Promise<object>} [options.loadTokenModule] - 测试注入。
 */
function createMessageWebhookHandler(deps, options = {}) {
  const loadTokenModule = options.loadTokenModule || defaultTokenModuleLoader;
  let tokenModulePromise = null;

  function tokenModule() {
    if (tokenModulePromise === null) {
      tokenModulePromise = Promise.resolve(loadTokenModule()).catch((e) => {
        tokenModulePromise = null;
        throw e;
      });
    }
    return tokenModulePromise;
  }

  async function verifiedModule(token) {
    const apiToken = String(deps.getApiToken() || '');
    if (apiToken === '' || typeof token !== 'string' || token === '') return null;
    try {
      const mod = await tokenModule();
      return mod.verifyMessageWebhookToken(apiToken, token) ? mod : null;
    } catch {
      return null;
    }
  }

  async function handleGet(res, token) {
    const mod = await verifiedModule(token);
    if (mod === null) {
      notFound(res);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      service: mod.MESSAGE_WEBHOOK_SERVICE,
      version: mod.MESSAGE_WEBHOOK_VERSION,
      api: mod.MESSAGE_WEBHOOK_API,
    });
  }

  async function handlePost(res, token, payload) {
    const mod = await verifiedModule(token);
    if (mod === null) {
      notFound(res);
      return;
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      sendJson(res, 400, { ok: false, error: { message: '请求体必须是 JSON 对象', code: 'BAD_WEBHOOK_BODY' } });
      return;
    }
    let gated;
    try {
      gated = await deps.ingest(payload);
    } catch (e) {
      sendJson(res, 503, {
        ok: false,
        error: { message: e && e.message ? e.message : String(e), code: 'WEBHOOK_BACKEND_FAILED' },
      });
      return;
    }
    if (gated === null || typeof gated !== 'object') {
      sendJson(res, 503, { ok: false, error: { message: '后端没有返回结果', code: 'WEBHOOK_BACKEND_FAILED' } });
      return;
    }
    if (gated.ok !== true) {
      const message = gated.error && typeof gated.error.message === 'string'
        ? gated.error.message
        : 'Webhook 写入失败';
      sendJson(res, 503, { ok: false, error: { message, code: 'WEBHOOK_BACKEND_FAILED' } });
      return;
    }
    const value = gated.value && typeof gated.value === 'object' ? gated.value : {};
    const record = value.record && typeof value.record === 'object' ? value.record : null;
    if (!record || !Number.isInteger(record.id) || record.id <= 0) {
      sendJson(res, 400, {
        ok: false,
        error: { message: value.error || 'Webhook 记录写入失败', code: 'WEBHOOK_INVALID' },
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      accepted: true,
      delivered: value.ok === true,
      record: publicRecordOf(value, record),
      ...(value.ok === true || !value.error ? {} : { deliveryError: publicDeliveryError(value.error) }),
    });
  }

  return { handleGet, handlePost };
}

module.exports = {
  MESSAGE_WEBHOOK_PATH_PREFIX,
  createMessageWebhookHandler,
};
