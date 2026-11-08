'use strict';

/**
 * 浏览器态写请求的 Origin 边界。
 *
 * `SameSite=Lax` 只按“站点”而不是“源”隔离：同一 IP 的不同端口仍可能被同一
 * 浏览器视为同站。对会改变状态或触发原生能力的 POST，要求 Origin 的 host
 * 与已通过 Host 白名单的请求 Host 完全一致；没有 Origin 的非浏览器客户端
 *（curl、RPA、脚本）仍按既有令牌/白名单逻辑处理。
 */

/**
 * @param {string | undefined} origin - 请求的 Origin 头。
 * @param {string | undefined} host - 请求的 Host 头（已由上层做白名单校验）。
 * @returns {boolean}
 */
function isAllowedBrowserOrigin(origin, host) {
  if (origin === undefined) return true;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== '') return false;
  const requestHost = typeof host === 'string' ? host.trim().toLowerCase() : '';
  return requestHost !== '' && parsed.host.toLowerCase() === requestHost;
}

/**
 * `Sec-Fetch-Site` 是浏览器附加的请求上下文。没有 Origin 时也要拒绝明确跨站/同站
 * 请求，避免隐私策略或旧浏览器省略 Origin 后绕过同源判断。
 * @param {string | undefined} site
 * @returns {boolean}
 */
function isAllowedFetchSite(site) {
  if (site === undefined) return true;
  const value = String(site).toLowerCase();
  return value === 'same-origin' || value === 'none';
}

/**
 * 给路由用的薄包装：不通过时直接写 403。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {(res: object, status: number, payload: object) => void} sendJson
 * @param {string} label
 * @returns {boolean} true = 继续处理。
 */
function allowBrowserRequest(req, res, sendJson, label) {
  if (isAllowedBrowserOrigin(req.headers.origin, req.headers.host)
    && isAllowedFetchSite(req.headers['sec-fetch-site'])) return true;
  sendJson(res, 403, {
    ok: false,
    error: { message: `${label}仅接受同源浏览器请求`, code: 'ORIGIN_DENIED' },
  });
  return false;
}

module.exports = { isAllowedBrowserOrigin, isAllowedFetchSite, allowBrowserRequest };
