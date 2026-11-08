'use strict';

/**
 * 微信原生 OCR 的主进程服务。
 *
 * 这里只做三件事：定位用户机器上的微信 OCR 插件、把受支持的图片来源变成
 * worker 可读的文件、调度一次性 utilityProcess。原生 MMMojo/Koffi 不在主进程
 * 加载 —— 它有自己的线程与退出握手，必须隔离；每个请求结束后由父进程 kill。
 *
 * 隐私边界：不打印 OCR 正文、不把图片内容写日志；data URL 只落到随机临时目录，
 * 且无论成功、失败还是超时都在 finally 中删除。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseDecodedUrl, resolveDecodedFile } = require('./media-protocol');

const MAX_DATA_URL_LENGTH = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_QUEUE = 4;
const OCR_PLUGIN_NAME = 'WeChatOcr';
const REGISTRY_INSTALL_PATH_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$v = (Get-ItemProperty -LiteralPath "HKCU:\\Software\\Tencent\\Weixin" -Name InstallPath -ErrorAction Stop).InstallPath',
  '[Console]::Out.Write([string]$v)',
].join('; ');
const MIME_TO_EXT = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/avif': '.avif',
});

function ocrError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function listDirSafe(dir, fsApi = fs) {
  try {
    return fsApi.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function findChildCaseInsensitive(parent, name, fsApi = fs) {
  if (!parent || !name) return null;
  const wanted = String(name).toLowerCase();
  const hit = listDirSafe(parent, fsApi).find((entry) => String(entry.name).toLowerCase() === wanted);
  return hit ? path.join(parent, hit.name) : null;
}

function isFileSafe(file, fsApi = fs) {
  try {
    return fsApi.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectorySafe(dir, fsApi = fs) {
  try {
    return fsApi.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function findDirectoriesNamed(root, name, maxDepth = 5, fsApi = fs) {
  const wanted = String(name).toLowerCase();
  const found = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > maxDepth) continue;
    for (const entry of listDirSafe(current.dir, fsApi)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const abs = path.join(current.dir, entry.name);
      if (String(entry.name).toLowerCase() === wanted) {
        found.push(abs);
        continue;
      }
      stack.push({ dir: abs, depth: current.depth + 1 });
    }
  }
  return found;
}

function versionKey(name) {
  const parts = String(name).match(/\d+/g);
  return parts ? parts.map((part) => Number(part)) : [0];
}

function compareVersionLike(a, b) {
  const left = versionKey(a);
  const right = versionKey(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return String(a).localeCompare(String(b), 'en');
}

/**
 * 在 `%APPDATA%\Tencent\xwechat` 下查找最新的 WeChatOcr 插件。
 * 路径各级都不区分大小写，兼容 `XPlugin`/`xplugin` 与 `Plugins`/`plugins`。
 * @returns {string | null} 最新可用 `wxocr.dll` 的绝对路径。
 */
function findWeChatOcrDll(options = {}) {
  const fsApi = options.fsApi || fs;
  const appData = options.appData || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const tencent = findChildCaseInsensitive(appData, 'Tencent', fsApi);
  const xwechat = tencent ? findChildCaseInsensitive(tencent, 'xwechat', fsApi) : null;
  if (!xwechat) return null;

  const candidates = [];
  for (const pluginRoot of findDirectoriesNamed(xwechat, OCR_PLUGIN_NAME, 5, fsApi)) {
    const versionDirs = listDirSafe(pluginRoot, fsApi)
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(pluginRoot, entry.name));
    for (const versionDir of versionDirs) {
      const extracted = findChildCaseInsensitive(versionDir, 'extracted', fsApi);
      const dll = extracted ? findChildCaseInsensitive(extracted, 'wxocr.dll', fsApi) : null;
      if (dll && isFileSafe(dll, fsApi)) {
        candidates.push({ dll, version: path.basename(versionDir) });
      }
    }
    const directDll = findChildCaseInsensitive(pluginRoot, 'wxocr.dll', fsApi);
    if (directDll && isFileSafe(directDll, fsApi)) {
      candidates.push({ dll: directDll, version: path.basename(pluginRoot) });
    }
  }
  candidates.sort((a, b) => compareVersionLike(b.version, a.version));
  return candidates[0] ? candidates[0].dll : null;
}

function readRegistryInstallPath(options = {}) {
  if (typeof options.runRegQuery === 'function') {
    return String(options.runRegQuery() || '').trim();
  }
  try {
    // reg.exe 写入管道的文本使用系统代码页，直接按 UTF-8 解码会让中文
    // 安装路径变成乱码。PowerShell 显式切到 UTF-8 后再读取同一个注册表值。
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', REGISTRY_INSTALL_PATH_SCRIPT],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
    );
    return String(out || '').trim();
  } catch {
    return '';
  }
}

function resolveWechatVersionDir(root, fsApi = fs) {
  const candidate = String(root || '').trim();
  if (!candidate || !isDirectorySafe(candidate, fsApi)) return '';
  const directMojo = findChildCaseInsensitive(candidate, 'mmmojo_64.dll', fsApi);
  if (directMojo && isFileSafe(directMojo, fsApi)) return path.resolve(candidate);

  const versions = listDirSafe(candidate, fsApi)
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(candidate, entry.name))
    .filter((dir) => {
      const mojo = findChildCaseInsensitive(dir, 'mmmojo_64.dll', fsApi);
      return mojo !== null && isFileSafe(mojo, fsApi);
    })
    .sort((a, b) => compareVersionLike(path.basename(b), path.basename(a)));
  return versions[0] ? path.resolve(versions[0]) : '';
}

/**
 * 选择含 `mmmojo_64.dll` 的微信版本目录。
 * `explicitDir` 可以是版本目录本身，也可以是安装根（如 `D:\Tencent\Weixin`）。
 */
function findWechatInstallDir(options = {}) {
  const fsApi = options.fsApi || fs;
  const explicit = String(options.explicitDir || '').trim();
  if (explicit) {
    const found = resolveWechatVersionDir(explicit, fsApi);
    if (found) return found;
  }
  const registryRoot = typeof options.registryPath === 'string'
    ? options.registryPath.trim()
    : readRegistryInstallPath(options);
  const fromRegistry = registryRoot ? resolveWechatVersionDir(registryRoot, fsApi) : '';
  if (fromRegistry) return fromRegistry;
  throw ocrError(
    '未找到微信运行目录（需要 mmmojo_64.dll）。请确认已安装微信 4.x，并先启动微信后重试。',
    'OCR_WECHAT_DIR_NOT_FOUND',
  );
}

function parseImageDataUrl(source, maxDataUrlLength = MAX_DATA_URL_LENGTH) {
  const raw = String(source || '');
  if (raw.length > maxDataUrlLength) {
    throw ocrError('图片数据过大（上限 32 MB），请换一张较小的图片。', 'OCR_IMAGE_TOO_LARGE');
  }
  const comma = raw.indexOf(',');
  if (comma < 0) throw ocrError('图片 data URL 格式无效。', 'OCR_SOURCE_INVALID');
  const meta = raw.slice(5, comma);
  if (!raw.slice(0, 5).toLowerCase().startsWith('data:')) {
    throw ocrError('图片 data URL 格式无效。', 'OCR_SOURCE_INVALID');
  }
  const chunks = meta.split(';');
  const mime = String(chunks.shift() || '').trim().toLowerCase();
  const ext = MIME_TO_EXT[mime];
  if (!ext || !chunks.some((part) => part.trim().toLowerCase() === 'base64')) {
    throw ocrError('仅支持 base64 编码的常见图片格式。', 'OCR_SOURCE_INVALID');
  }
  const encoded = raw.slice(comma + 1).replace(/\s+/g, '');
  if (encoded === '' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw ocrError('图片 base64 数据无效。', 'OCR_SOURCE_INVALID');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0) throw ocrError('图片内容为空。', 'OCR_SOURCE_INVALID');
  return { bytes, ext };
}

/**
 * 校验并物化图片来源。只接受 data:image/*;base64 与 wechat-media://decoded/<rel>。
 * @returns {{ imagePath: string, cleanup: () => void }}
 */
function materializeImageSource(source, options = {}) {
  const fsApi = options.fsApi || fs;
  const raw = typeof source === 'string' ? source.trim() : '';
  if (raw === '') throw ocrError('缺少图片地址。', 'OCR_SOURCE_INVALID');

  if (/^data:/i.test(raw)) {
    const parsed = parseImageDataUrl(raw, options.maxDataUrlLength || MAX_DATA_URL_LENGTH);
    const tempRoot = options.tempRoot || os.tmpdir();
    const tempDir = fsApi.mkdtempSync(path.join(tempRoot, 'super-time-wechat-ocr-'));
    const imagePath = path.join(tempDir, crypto.randomUUID() + parsed.ext);
    let cleaned = false;
    try {
      fsApi.writeFileSync(imagePath, parsed.bytes, { mode: 0o600 });
    } catch (error) {
      try { fsApi.rmSync(tempDir, { recursive: true, force: true }); } catch { /* 已尽力清理 */ }
      throw error;
    }
    return {
      imagePath,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        try { fsApi.rmSync(tempDir, { recursive: true, force: true }); } catch { /* 已尽力清理 */ }
      },
    };
  }

  const rel = parseDecodedUrl(raw);
  if (rel === null) {
    throw ocrError('图片地址无效，只支持 data:image/* 或微信媒体地址。', 'OCR_SOURCE_INVALID');
  }
  const decodedRoot = String(options.decodedRoot || '').trim();
  if (!decodedRoot) {
    throw ocrError('尚未解析到微信图片目录，请等待微信数据加载完成后重试。', 'OCR_MEDIA_ROOT_MISSING');
  }
  const imagePath = resolveDecodedFile(decodedRoot, rel);
  if (!imagePath) {
    throw ocrError('图片文件不存在、已过期或不是受支持的图片格式。', 'OCR_IMAGE_NOT_FOUND');
  }
  return { imagePath, cleanup: () => {} };
}

function normalizeOcrResult(rawJson, elapsedMs = 0) {
  let parsed;
  try {
    parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  } catch {
    throw ocrError('微信原生 OCR 返回了无法解析的结果，请重试。', 'OCR_RESULT_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw ocrError('微信原生 OCR 返回了无法解析的结果，请重试。', 'OCR_RESULT_INVALID');
  }
  const errcode = Number(parsed.errcode ?? 0);
  if (!Number.isFinite(errcode)) {
    throw ocrError('微信原生 OCR 返回了无法解析的结果，请重试。', 'OCR_RESULT_INVALID');
  }
  if (errcode !== 0) {
    throw ocrError(
      `微信原生 OCR 识别失败（错误码 ${String(errcode)}），请确认图片格式后重试。`,
      'OCR_ENGINE_ERROR',
    );
  }
  const sourceLines = Array.isArray(parsed.ocr_response) ? parsed.ocr_response : [];
  const lines = [];
  for (const item of sourceLines) {
    if (!item || typeof item !== 'object') continue;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (text === '') continue;
    const line = { text, left: 0, top: 0, right: 0, bottom: 0, rate: 0 };
    for (const key of ['left', 'top', 'right', 'bottom', 'rate']) {
      const value = Number(item[key]);
      if (Number.isFinite(value)) line[key] = value;
    }
    lines.push(line);
  }
  const width = Number(parsed.width);
  const height = Number(parsed.height);
  return {
    engine: 'wechat-native',
    text: lines.map((line) => line.text).join('\n'),
    lines,
    width: Number.isFinite(width) && width >= 0 ? width : 0,
    height: Number.isFinite(height) && height >= 0 ? height : 0,
    elapsedMs: Math.max(0, Number(elapsedMs) || 0),
  };
}

function unpackedAware(assetPath) {
  const raw = path.resolve(assetPath);
  const marker = 'app.asar';
  const at = raw.indexOf(marker);
  if (at < 0) return raw;
  const rest = raw.slice(at + marker.length).replace(/^[\\/]+/, '');
  return path.join(raw.slice(0, at), 'app.asar.unpacked', rest);
}

function defaultWrapperPath() {
  return unpackedAware(path.join(__dirname, 'wechat-data', 'native', 'wcocr', 'win32-x64', 'wcocr.dll'));
}

function drain(stream) {
  if (stream && typeof stream.resume === 'function') stream.resume();
}

function runOneShotWorker(deps, payload) {
  const { utilityProcess, workerPath, timeoutMs } = deps;
  let child;
  try {
    child = utilityProcess.fork(workerPath, [], {
      serviceName: 'super-time-wechat-ocr',
      stdio: 'pipe',
      env: process.env,
    });
  } catch {
    throw ocrError('无法启动微信原生 OCR 子进程，请重启 Super Time 后重试。', 'OCR_WORKER_START_FAILED');
  }
  drain(child.stdout);
  drain(child.stderr);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof child.removeListener === 'function') {
        child.removeListener('message', onMessage);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
      }
      fn(value);
    };
    const onMessage = (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'error' && typeof message.message === 'string') {
        finish(reject, ocrError(message.message, 'OCR_WORKER_ERROR'));
        return;
      }
      if (message.type === 'result' && typeof message.json === 'string') {
        finish(resolve, message.json);
      }
    };
    const onExit = () => finish(
      reject,
      ocrError('微信原生 OCR 子进程提前退出，请重启微信后重试。', 'OCR_WORKER_EXIT'),
    );
    const onError = () => finish(
      reject,
      ocrError('微信原生 OCR 子进程启动失败，请重启 Super Time 后重试。', 'OCR_WORKER_START_FAILED'),
    );
    const timer = setTimeout(() => finish(
      reject,
      ocrError(`微信原生 OCR 超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试。`, 'OCR_TIMEOUT'),
    ), timeoutMs);
    child.once('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
    try {
      child.postMessage({ type: 'ocr', payload });
    } catch {
      finish(reject, ocrError('无法向微信原生 OCR 子进程发送请求。', 'OCR_WORKER_START_FAILED'));
    }
  }).finally(() => {
    try { child.kill(); } catch { /* 子进程可能已退出 */ }
  });
}

/**
 * 创建串行、有界排队的微信 OCR 服务。
 * @param {object} options
 * @param {object} options.utilityProcess Electron utilityProcess（测试可注入假实现）
 * @param {() => string} [options.getDecodedRoot] 当前 decoded_images 根
 */
function createWechatOcrService(options = {}) {
  const utilityProcess = options.utilityProcess;
  if (!utilityProcess || typeof utilityProcess.fork !== 'function') {
    throw new Error('createWechatOcrService: missing utilityProcess');
  }
  const fsApi = options.fs || fs;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxQueue = Number(options.maxQueue) > 0 ? Number(options.maxQueue) : DEFAULT_MAX_QUEUE;
  const workerPath = options.workerPath || path.join(__dirname, 'wechat-ocr-worker.js');
  const wrapperDllPath = options.wrapperDllPath || defaultWrapperPath();
  const findPlugin = options.findWeChatOcrDll || (() => findWeChatOcrDll({ appData: options.appData, fsApi }));
  const findWechatDir = options.findWechatInstallDir || (() => findWechatInstallDir({
    explicitDir: options.wechatDir,
    fsApi,
  }));
  const runWorker = options.runWorker || ((payload) => runOneShotWorker({
    utilityProcess,
    workerPath,
    timeoutMs,
  }, payload));

  let queueTail = Promise.resolve();
  let queued = 0;
  let discoveryCache = null;

  async function execute(source) {
    const startedAt = Date.now();
    if (
      discoveryCache === null
      || !isFileSafe(discoveryCache.wxocrDll, fsApi)
      || !isFileSafe(path.join(discoveryCache.wechatDir, 'mmmojo_64.dll'), fsApi)
    ) {
      const wxocrDll = findPlugin();
      if (!wxocrDll) {
        throw ocrError(
          '未找到微信原生 OCR 组件。请先启动并登录微信 4.x，等待 OCR 插件下载完成后重试。',
          'OCR_PLUGIN_NOT_FOUND',
        );
      }
      discoveryCache = { wxocrDll, wechatDir: findWechatDir() };
    }
    const { wxocrDll, wechatDir } = discoveryCache;
    if (!isFileSafe(wrapperDllPath, fsApi)) {
      throw ocrError('随包 OCR 组件缺失，请重新安装 Super Time。', 'OCR_WRAPPER_NOT_FOUND');
    }
    const prepared = materializeImageSource(source, {
      decodedRoot: typeof options.getDecodedRoot === 'function' ? options.getDecodedRoot() : '',
      tempRoot: options.tempRoot,
      maxDataUrlLength: options.maxDataUrlLength,
      fsApi,
    });
    try {
      const rawJson = await runWorker({
        wxocrDll,
        wechatDir,
        wrapperDllPath,
        imagePath: prepared.imagePath,
      });
      return normalizeOcrResult(rawJson, Date.now() - startedAt);
    } finally {
      prepared.cleanup();
    }
  }

  function recognize(source) {
    if (queued >= maxQueue) {
      return Promise.reject(ocrError('图片文字识别排队已满，请稍后重试。', 'OCR_BUSY'));
    }
    queued += 1;
    const job = queueTail.then(() => execute(source));
    queueTail = job.catch(() => {});
    return job.finally(() => { queued -= 1; });
  }

  return {
    recognize,
    stats: () => ({ queued, maxQueue, timeoutMs }),
  };
}

module.exports = {
  MAX_DATA_URL_LENGTH,
  DEFAULT_TIMEOUT_MS,
  findChildCaseInsensitive,
  findDirectoriesNamed,
  findWeChatOcrDll,
  readRegistryInstallPath,
  resolveWechatVersionDir,
  findWechatInstallDir,
  parseImageDataUrl,
  materializeImageSource,
  normalizeOcrResult,
  unpackedAware,
  createWechatOcrService,
};
