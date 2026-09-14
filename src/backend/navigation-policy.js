'use strict';

/**
 * 窗口打开 / 页面导航的放行策略（纯函数）。
 *
 * 为什么抽成独立模块：渲染进程显示的**是聊天与朋友圈内容**，也就是不可信输入。
 * 「渲染层给什么 URL 就往系统浏览器里扔」这类判断只有手工点链接才能观察，
 * 一旦改错没人会立刻发现 —— 而 `file:` 能直接拉起本地可执行文件，`smb:`/UNC
 * 会带着凭据去连外部主机。抽出来之后，判定逻辑用单测就能穷举。
 *
 * 两条边界：
 *   ① `shell.openExternal` 只放行 `http:` / `https:`；
 *   ② 页面导航只允许 `file:` 且落在**应用目录内**（本应用是单页，正常不会导航）。
 * 其余一律拒绝并留日志。**默认拒绝**是这里的核心不变量：新增协议不会被意外放行。
 */

const { fileURLToPath } = require('node:url');
const path = require('node:path');

/** 允许交给系统浏览器打开的协议。 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 解析 URL，失败返回 null（绝不抛）。
 * @param {unknown} raw - 待解析的值。
 * @returns {URL | null} 解析结果。
 */
function parseUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

/**
 * `target` 是否在 `root` 目录内（含相等）。
 * @param {string} root - 允许的根目录。
 * @param {string} target - 目标文件路径。
 * @returns {boolean} 是否在根目录内。
 */
function isInsidePath(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 该 URL 是否可以交给系统浏览器打开。
 * @param {unknown} raw - 候选 URL。
 * @returns {boolean} 仅 http(s) 为 true。
 */
function isSafeExternalUrl(raw) {
  const url = parseUrl(raw);
  return url !== null && EXTERNAL_PROTOCOLS.has(url.protocol);
}

/**
 * 该 URL 是否属于「应用自己的页面」。
 * @param {unknown} raw - 候选 URL。
 * @param {string} appRoot - 应用目录（主进程的 `__dirname`）。
 * @returns {boolean} file: 且位于应用目录内才为 true。
 */
function isInternalNavigation(raw, appRoot) {
  const url = parseUrl(raw);
  if (url === null || url.protocol !== 'file:') return false;
  let filePath;
  try {
    filePath = fileURLToPath(url);
  } catch {
    return false;
  }
  return isInsidePath(appRoot, filePath);
}

/**
 * `setWindowOpenHandler` 的处置。
 * @param {unknown} raw - 渲染层请求打开的 URL。
 * @returns {'external' | 'deny'} external = 交给系统浏览器；deny = 只拒绝。
 */
function decideWindowOpen(raw) {
  return isSafeExternalUrl(raw) ? 'external' : 'deny';
}

/**
 * `will-navigate` 的处置。
 * @param {unknown} raw - 目标 URL。
 * @param {string} appRoot - 应用目录。
 * @returns {'allow' | 'deny'} allow = 放行（应用自身页面）；deny = 阻止。
 */
function decideNavigation(raw, appRoot) {
  return isInternalNavigation(raw, appRoot) ? 'allow' : 'deny';
}

module.exports = {
  EXTERNAL_PROTOCOLS,
  decideNavigation,
  decideWindowOpen,
  isInternalNavigation,
  isSafeExternalUrl,
  isInsidePath,
};
