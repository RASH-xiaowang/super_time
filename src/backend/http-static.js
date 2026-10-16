/**
 * 远程访问的**静态资源服务**（把渲染层产物发给手机浏览器）。
 *
 * ## 为什么自己写而不是引一个静态服务包
 *
 * 本仓的运行时依赖要逐个登记进打包白名单（`package.json` 的 `build.files`），
 * 而需求只有三件事：按路径读文件、给对 MIME、别被 `../` 读出根目录。
 * 为一个 `createReadStream` 多带一个包（以及它的传递依赖与 asar 兼容性问题）不划算。
 *
 * ## 服务的是哪一份产物
 *
 * `src/client/ui-dist` —— vite 的输出目录（`vite.config.js:24`），也是 Electron 自己
 * `loadFile` 的同一份（`src/backend/main-window.js:14-18`）。**手机与桌面加载的是同一个
 * 构建产物**，所以不存在「手机版是另一套代码」这种要分别维护的东西。
 *
 * 打包态它位于 asar 内：Electron 给 `fs` 打了补丁，`statSync` / `createReadStream`
 * 对 asar 里的路径照常工作，因此开发态与打包态走的是**同一条代码路径**（无需分支）。
 * 它在 `build.files` 白名单里（`src/` 全量收录，只排除 `.ts` 源码与 `src/client/ui-app/`）。
 *
 * ## 路径穿越
 *
 * 这是本模块唯一的真安全面：`GET /../../secrets.json` 这类请求必须被拒。
 * 做法是**先 resolve 再验前缀**，而不是先替换 `..` 再拼（后者会被 `..%2f`、
 * 反斜杠、以及 `a/../..` 这类组合绕开）。Windows 上还要额外当心反斜杠与盘符。
 *
 * @module backend/http-static
 */
const fs = require('node:fs');
const path = require('node:path');

/** 扩展名 → MIME。缺省按 `application/octet-stream`（浏览器会当下载，不会误渲染）。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * 把一个 URL 路径解析成根目录内的**绝对**文件路径。
 *
 * @param {string} rootDir - 静态根（`ui-dist` 的绝对路径）。
 * @param {string} urlPath - 已 `decodeURIComponent` 的 URL 路径（以 `/` 开头）。
 * @returns `{ ok: true, file: string }` 或 `{ ok: false, reason: 'outside' | 'missing' | 'dir' }`。
 */
function resolveStaticFile(rootDir, urlPath) {
  const root = path.resolve(rootDir);
  // 反斜杠先归一：Windows 上 `path.resolve` 认反斜杠，而 URL 里出现反斜杠意味着有人在试穿越。
  const rel = urlPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(root, rel);
  // 前缀判定必须带分隔符：`root='C:\a\ui'` 时 `C:\a\ui-secret\x` 也满足 startsWith(root)，
  // 但那已经不在根目录里了。
  if (target !== root && !target.startsWith(root + path.sep)) return { ok: false, reason: 'outside' };
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (st.isDirectory()) return { ok: false, reason: 'dir' };
  return { ok: true, file: target };
}

/**
 * 取一个 URL 路径的 MIME。
 * @param {string} file - 文件路径。
 * @returns `Content-Type` 的值。
 */
function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * 缓存头口径。
 *
 * vite 的产物文件名带内容哈希（`index-DxNJ5MK-.js`），内容变了名字就变 ⇒ 可以永久缓存。
 * 但 **`index.html` 必须 no-cache**：它是唯一名字不变的入口，缓存住它等于升级后手机
 * 仍然加载旧的一份 JS（而旧 JS 引用的哈希文件已经不存在了，表现是白屏）。
 * @param {string} file - 文件路径。
 * @param {string} urlPath - URL 路径。
 * @returns `Cache-Control` 的值。
 */
function cacheControlFor(file, urlPath) {
  if (urlPath === '/' || urlPath === '' || path.extname(file).toLowerCase() === '.html') {
    return 'no-cache';
  }
  return 'public, max-age=31536000, immutable';
}

/**
 * 把一个文件写进响应（流式，不整份读进内存）。
 *
 * 为什么用流：`ui-dist` 里最大的 JS 产物约 1.9 MB，图片产物可能更大；
 * 手机同时开几个面板时，整份读进内存会把主进程的堆顶上去 —— 而主进程还管着窗口与后端。
 *
 * @param {object} res - `http.ServerResponse`。
 * @param {string} file - 绝对路径。
 * @param {string} urlPath - URL 路径（决定缓存头）。
 * @returns 无（异步写；出错时销毁响应）。
 */
function sendFile(res, file, urlPath) {
  res.writeHead(200, {
    'Content-Type': mimeOf(file),
    'Cache-Control': cacheControlFor(file, urlPath),
    // 手机浏览器（尤其 iOS Safari）会预取与嗅探；我们发的类型是准的，不许它猜。
    'X-Content-Type-Options': 'nosniff',
  });
  const stream = fs.createReadStream(file);
  stream.on('error', (err) => {
    // 头已经发出去了，改不了状态码 —— 只能销毁连接，让浏览器当成一次失败的重载。
    console.warn('[remote-access] 静态文件读取失败 %s: %s', file, err?.message ?? err);
    res.destroy();
  });
  stream.pipe(res);
}

module.exports = { resolveStaticFile, mimeOf, cacheControlFor, sendFile };
