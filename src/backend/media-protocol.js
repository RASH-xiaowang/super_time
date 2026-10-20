'use strict';

/**
 * `wechat-media://` 桌面媒体协议（2026-10-18）。
 *
 * 为什么需要它：聊天图片一直是后端解成 base64 data URL，再经「后端 → main → 渲染进程」
 * 两次结构化克隆送到 `<img src>`。一屏几十张图、每张几十到几百 KB 时，IPC 与渲染进程
 * 堆里各留一份 base64（体积 ≈ 原始字节 × 4/3），是当前最大的可控内存项之一。
 * 这里把「路径」而不是「字节」送过去：渲染层拿到相对路径后拼 `wechat-media://decoded/<rel>`，
 * Chromium 按需向 main 请求；main 只做「根目录内的白名单文件」校验后**流式**返回。
 *
 * 安全边界（与 `navigation-policy` 同一套信任模型）：
 *   · 只认 `decoded` 这一个 host，只读后端已解析的 decoded_images 根；
 *   · 只放行图片扩展名，拒绝 `..`、绝对路径、反斜杠、空段；
 *   · 不做任何网络请求、不执行内容、不带凭据。
 *
 * @module backend/media-protocol
 */

const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');

/** 协议名；渲染层与 main 必须一致。 */
const WECHAT_MEDIA_SCHEME = 'wechat-media';

/** 允许经协议暴露的扩展名（只读图片；视频/音频走各自既有链路）。 */
const MIME_BY_EXT = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
});

const NOT_FOUND = 'not found';

/**
 * 解析 `wechat-media://decoded/<relative-path>` 成 decoded 根的相对路径。
 * @param {string} rawUrl - 完整 URL（Chromium 传入 request.url）。
 * @returns {string | null} 规范化后的相对路径（`/` 分隔）；非法形状返回 null。
 */
function parseDecodedUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    return null;
  }
  if (parsed.protocol !== WECHAT_MEDIA_SCHEME + ':') return null;
  if (parsed.hostname !== 'decoded') return null;
  let rel;
  try {
    rel = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  rel = rel.replace(/^\/+/, '');
  if (rel === '' || rel.includes('\0') || rel.includes('\\')) return null;
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return null;
  }
  return rel;
}

/**
 * 把相对路径解析成 decoded 根内的真实文件；越界/类型不允许/不存在都返回 null。
 * @param {string} root - decoded_images 绝对路径。
 * @param {string} rel - `parseDecodedUrl` 的返回值。
 * @returns {string | null} 允许读取的绝对文件路径。
 */
function resolveDecodedFile(root, rel) {
  const base = String(root || '').trim();
  if (base === '') return null;
  if (typeof rel !== 'string') return null;
  const normalized = rel.replace(/^\/+/, '');
  if (normalized === '' || normalized.includes('\0') || normalized.includes('\\')) return null;
  for (const seg of normalized.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return null;
  }
  const rootAbs = path.resolve(base);
  const abs = path.resolve(rootAbs, normalized);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  const ext = path.extname(abs).toLowerCase();
  if (MIME_BY_EXT[ext] === undefined) return null;
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}

/**
 * 为一个 `wechat-media://` 请求构造流式响应。
 * @param {string} root - decoded_images 绝对路径。
 * @param {string} rawUrl - request.url。
 * @returns {Response} 200 流式图片，或 404 文本。
 */
function mediaResponse(root, rawUrl) {
  const rel = parseDecodedUrl(rawUrl);
  const abs = rel === null ? null : resolveDecodedFile(root, rel);
  if (abs === null) return new Response(NOT_FOUND, { status: 404 });
  const mime = MIME_BY_EXT[path.extname(abs).toLowerCase()];
  const headers = {
    'Content-Type': mime,
    'Cache-Control': 'no-store',
  };
  try {
    const stream = fs.createReadStream(abs);
    return new Response(Readable.toWeb(stream), { headers });
  } catch {
    return new Response(NOT_FOUND, { status: 404 });
  }
}

module.exports = {
  WECHAT_MEDIA_SCHEME,
  MIME_BY_EXT,
  parseDecodedUrl,
  resolveDecodedFile,
  mediaResponse,
};
