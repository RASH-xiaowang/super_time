/**
 * 「打开网页」交接会话的**原生能力代理**（2026-10-19）。
 *
 * 浏览器没有 preload，但交接态要求「和桌面端同样的权限」：选本机目录/文件、保存路径、
 * 在资源管理器里显示、导出报告截图、许可证、诊断日志、检查更新、远程访问设置、模型配置。
 *
 * 这些动作全部在主进程执行（这里就是实现），HTTP 端点只负责把请求转进来
 * （`http-server.js` 的 `/api/native/<action>`，仅 fullAccess 会话可用）。
 * 返回形状沿用既有 IPC 的约定 —— 渲染层的 `api-*.ts` 一行都不用改。
 *
 * 动作按域拆成多个工厂（对话框 / 模型 / 许可证 / 诊断 / 更新 / 远程访问），
 * 分派函数只做查表，避免一个超长 switch 把 `function-size-ratchet` 顶穿。
 *
 * @module backend/handoff-native
 */
const path = require('node:path');
const fs = require('node:fs');
const { humanizeNetworkError, testLlmEndpoint, queryLlmBalance } = require('./llm-balance.js');
const { parseLlmBaseUrl, llmRequest } = require('./llm-http.js');

/** 对话框父窗口：只认**可见**的主窗口。主窗口隐藏（交接态）时用无父窗口的
 * 系统对话框 —— 给隐藏窗口挂一个模态子窗，在 Windows 上可能连对话框都看不见。 */
function parentOf(getMainWindow) {
  const win = getMainWindow();
  return win && !win.isDestroyed() && win.isVisible() ? win : undefined;
}

/** 主窗口隐藏时 capturePage 可能拿不到新帧：临时显示（不抢焦点）后再截，截完恢复隐藏。 */
async function captureMain(getMainWindow, rect) {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return { ok: false, message: '窗口不存在' };
  const wasVisible = win.isVisible();
  if (!wasVisible) { try { win.showInactive(); } catch { /* 忽略 */ } }
  try {
    return await win.webContents.capturePage({
      x: Math.max(0, Math.round(Number(rect?.x) || 0)),
      y: Math.max(0, Math.round(Number(rect?.y) || 0)),
      width: Math.max(1, Math.round(Number(rect?.width) || 0)),
      height: Math.max(1, Math.round(Number(rect?.height) || 0)),
    });
  } finally {
    if (!wasVisible) { try { win.hide(); } catch { /* 忽略 */ } }
  }
}

/** 对话框 / 打开路径 / 截图。 */
function dialogHandlers(deps, getParent, capture) {
  const { dialog, shell } = deps;
  return {
    'pick-directory': async () => {
      const result = await dialog.showOpenDialog(getParent(), { title: '选择目录', properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled) return { canceled: true, path: null };
      return { canceled: false, path: result.filePaths[0] ?? null };
    },
    'open-file': async (payload) => {
      const forced = (process.env.SUPERTIME_OPEN_PATHS || '').trim();
      if (forced) {
        const files = forced.split(path.delimiter).map((s) => s.trim()).filter(Boolean);
        return files.length ? { canceled: false, files } : { canceled: true, files: [] };
      }
      const opts = payload.opts && typeof payload.opts === 'object' ? payload.opts : {};
      const result = await dialog.showOpenDialog(getParent(), {
        title: typeof opts.title === 'string' && opts.title ? opts.title : '选择文件',
        properties: ['openFile', 'multiSelections'],
        filters: Array.isArray(opts.filters) && opts.filters.length ? opts.filters : undefined,
      });
      if (result.canceled) return { canceled: true, files: [] };
      return { canceled: false, files: result.filePaths };
    },
    'save-file': async (payload) => {
      const forced = (process.env.SUPERTIME_SAVE_PATH || '').trim();
      if (forced) return { canceled: false, path: forced };
      const opts = payload.opts && typeof payload.opts === 'object' ? payload.opts : {};
      const result = await dialog.showSaveDialog(getParent(), {
        title: typeof opts.title === 'string' && opts.title ? opts.title : '保存文件',
        defaultPath: typeof opts.defaultName === 'string' && opts.defaultName ? opts.defaultName : 'export.bin',
        filters: Array.isArray(opts.filters) ? opts.filters : undefined,
      });
      if (result.canceled || !result.filePath) return { canceled: true, path: null };
      return { canceled: false, path: result.filePath };
    },
    'show-in-folder': async (payload) => {
      if (typeof payload.path === 'string' && payload.path) shell.showItemInFolder(payload.path);
      return true;
    },
    'capture-panel': async (payload) => {
      try {
        const image = await capture(payload.rect || {});
        const png = image.toPNG();
        if (!png || png.length === 0) return { ok: false, message: '截图内容为空' };
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const suggested = typeof payload.rect?.filename === 'string' && payload.rect.filename.trim()
          ? payload.rect.filename.trim()
          : `wechat-report-${stamp}.png`;
        const forced = process.env.SUPERTIME_CAPTURE_PATH;
        if (forced) {
          fs.writeFileSync(forced, png);
          return { ok: true, path: forced, bytes: png.length, width: image.getSize().width, height: image.getSize().height };
        }
        const { canceled, filePath } = await dialog.showSaveDialog(getParent(), {
          title: '导出报告截图', defaultPath: suggested,
          filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        });
        if (canceled || !filePath) return { ok: true, canceled: true };
        fs.writeFileSync(filePath, png);
        return { ok: true, path: filePath, bytes: png.length, width: image.getSize().width, height: image.getSize().height };
      } catch (e) {
        return { ok: false, message: e?.message || String(e) };
      }
    },
  };
}

/** 主进程侧的模型配置 / 模型列表 / 连接测试 / 余额。 */
function llmHandlers(deps) {
  const { loadLlmConfig, saveLlmConfig, loadLlmStore, activateLlmProfile, upsertLlmProfile,
    deleteLlmProfile, findModelCatalog } = deps;
  return {
    'llm-get': () => loadLlmConfig(),
    'llm-save': (payload) => saveLlmConfig(payload.config || {}),
    'llm-profiles': (payload) => {
      const op = String(payload.op || 'list');
      if (op === 'list') return loadLlmStore();
      if (op === 'activate') return activateLlmProfile(String(payload.id || ''));
      if (op === 'save') return upsertLlmProfile(payload.profile || {});
      if (op === 'delete') return deleteLlmProfile(String(payload.id || ''));
      throw new Error(`未知的模型配置操作：${op}`);
    },
    'llm-models': async (payload) => {
      const opts = payload.opts && typeof payload.opts === 'object' ? payload.opts : {};
      const baseUrl = String(opts.baseUrl || '').trim();
      const apiKey = String(opts.apiKey || '');
      const parsed = parseLlmBaseUrl(baseUrl);
      const host = parsed.host;
      const url = parsed.base + '/models';
      const catalogFallback = (note) => {
        if (apiKey) return null;
        const hit = findModelCatalog(parsed.base);
        if (!hit) return null;
        return { models: hit.models, source: 'catalog', vendor: hit.vendor, note };
      };
      let res;
      try {
        res = await llmRequest(url, { apiKey, timeoutMs: 30_000, maxAttempts: 1 });
      } catch (e) {
        const fb = catalogFallback('当前网络无法直连该地址，已改用内置清单');
        if (fb) return fb;
        throw new Error(humanizeNetworkError(e, host));
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 200);
        if (res.status === 401 || res.status === 403) {
          const fb = catalogFallback('该厂商列表接口需要 API Key，已改用内置清单');
          if (fb) return fb;
          const authHint = apiKey ? 'API Key 无效或无权限，请检查后重试' : 'API Key 为空，请先填写你的 API Key';
          throw new Error(`接口返回 ${res.status} ${res.statusText || ''}${body ? '：' + body : ''}（${authHint}）`.trim());
        }
        let hint = '';
        if (res.status === 404) hint = '（该地址可能缺少 /v1 后缀，或厂商不提供 /models 接口，可手动填写模型名）';
        throw new Error(`接口返回 ${res.status} ${res.statusText || ''}${body ? '：' + body : ''} ${hint}`.trim());
      }
      const data = await res.json().catch(() => null);
      const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
      const models = [...new Set(raw.map((m) => (typeof m === 'string' ? m : m?.id)).filter((id) => typeof id === 'string' && id))];
      return { models, source: 'live' };
    },
    'llm-test': (payload) => testLlmEndpoint({ ...(payload.opts && typeof payload.opts === 'object' ? payload.opts : {}) }),
    'llm-balance': (payload) => {
      const opts = payload.opts && typeof payload.opts === 'object' ? payload.opts : {};
      return queryLlmBalance(String(opts.baseUrl || '').trim(), String(opts.apiKey || ''));
    },
  };
}

/** 许可证。 */
function licenseHandlers(deps, getParent) {
  const { app, dialog, licenseService, APP_VERSION } = deps;
  return {
    'license-status': () => licenseService.getLicenseStatus(app.getPath('userData'), APP_VERSION),
    'license-export-request': async () => {
      const req = licenseService.getActivationRequest(app.getPath('userData'), APP_VERSION);
      const result = await dialog.showSaveDialog(getParent(), {
        title: '导出激活请求',
        defaultPath: `activation-request-${req.fingerprint.slice(0, 8)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(result.filePath, JSON.stringify(req, null, 2), 'utf8');
      return { ok: true, path: result.filePath, request: req };
    },
    'license-import-file': async () => {
      const picked = await dialog.showOpenDialog(getParent(), {
        title: '导入许可证', properties: ['openFile'],
        filters: [{ name: 'License', extensions: ['json', 'lic'] }],
      });
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
      return licenseService.importLicense(app.getPath('userData'), APP_VERSION, fs.readFileSync(picked.filePaths[0], 'utf8'));
    },
    'license-import-text': (payload) => licenseService.importLicense(app.getPath('userData'), APP_VERSION, String(payload.text ?? '')),
    'license-remove': () => ({ ok: true, status: licenseService.removeLicense(app.getPath('userData'), APP_VERSION) }),
  };
}

/** 诊断日志。 */
function diagHandlers(deps, getParent) {
  const { app, dialog, shell, clipboard, diagLog, APP_VERSION, buildDiagnosticPreview, buildDiagnosticReport } = deps;
  const diagCtx = () => ({
    app: APP_VERSION, electron: process.versions.electron, chrome: process.versions.chrome,
    node: process.versions.node, platform: process.platform, arch: process.arch, packaged: app.isPackaged,
  });
  return {
    'diag-log-info': () => {
      const files = diagLog.files().map((p) => {
        try { return { path: p, name: path.basename(p), size: fs.statSync(p).size }; } catch { return null; }
      }).filter(Boolean);
      return { ok: true, dir: path.dirname(diagLog.path), current: diagLog.path, files };
    },
    'diag-export-log': async () => {
      try {
        const parts = diagLog.files().slice().reverse().filter((p) => {
          try { return fs.statSync(p).size > 0; } catch { return false; }
        });
        if (parts.length === 0) return { ok: false, error: '当前没有日志内容可导出' };
        let dest = (process.env.SUPERTIME_SAVE_PATH || '').trim();
        if (!dest) {
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          const result = await dialog.showSaveDialog(getParent(), {
            title: '导出诊断日志',
            defaultPath: `supertime-diagnostic-${stamp}.log`,
            filters: [{ name: '日志', extensions: ['log', 'txt'] }],
          });
          if (result.canceled || !result.filePath) return { ok: false, canceled: true };
          dest = result.filePath;
        }
        fs.writeFileSync(dest, buildDiagnosticReport(diagLog, diagCtx()), 'utf8');
        diagLog.write('info', ['诊断日志已导出到', dest]);
        return { ok: true, path: dest, bytes: fs.statSync(dest).size };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    'diag-preview-log': () => ({ ok: true, ...buildDiagnosticPreview(diagLog, diagCtx()) }),
    'diag-copy-log-path': () => {
      const target = path.dirname(diagLog.path);
      clipboard.writeText(target);
      return { ok: true, path: target };
    },
    'diag-reveal-log': () => {
      shell.showItemInFolder(diagLog.path);
      return { ok: true, path: diagLog.path };
    },
  };
}

/** 更新与远程访问设置。 */
function updateHandlers(deps) {
  const { updateService, remoteAccess, control } = deps;
  return {
    'update-state': () => updateService.getState(),
    'update-check': (payload) => updateService.check({ manual: payload.opts?.manual === true }),
    'update-install': () => {
      const r = updateService.install();
      if (!r.ok) throw new Error(r.error || '安装更新失败');
      return { ok: true };
    },
    'update-skip': (payload) => updateService.skipVersion(typeof payload.version === 'string' ? payload.version : ''),
    'update-retry': () => updateService.retryDownload(),
    'remote-access-state': () => remoteAccess.getState(),
    'remote-access-apply': () => remoteAccess.syncWithConfig(),
    'remote-access-rotate': () => control.rotate({ fullAccess: true }),
    'remote-access-toggle': (payload) => control.setEnabled(payload.enabled === true),
  };
}

/**
 * 建原生能力代理。
 * @param {object} deps - main.js 注入的主进程服务。
 * @returns {(action: string, payload: object) => Promise<unknown>} 动作分发函数。
 */
function createHandoffNative(deps) {
  const getParent = () => parentOf(deps.getMainWindow);
  const capture = (rect) => captureMain(deps.getMainWindow, rect);
  const handlers = {
    ...dialogHandlers(deps, getParent, capture),
    ...llmHandlers(deps),
    ...licenseHandlers(deps, getParent),
    ...diagHandlers(deps, getParent),
    ...updateHandlers(deps),
    'wechat-info': () => {
      const boot = deps.getWechatBoot();
      if (!boot) throw new Error('Super Time 后端未初始化');
      return boot.info;
    },
  };
  return async function nativeCall(action, payload = {}) {
    const handler = handlers[action];
    if (typeof handler !== 'function') throw new Error(`未知的原生动作：${action}`);
    return handler(payload);
  };
}

module.exports = { createHandoffNative };
