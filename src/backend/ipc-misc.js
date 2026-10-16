/**
 * 主进程 IPC：诊断 / 应用元信息 / 许可 / 文件对话框 / 系统外壳 / 窗口（M21 第二十刀自 main.js 拆出）。
 *
 * 从 `main.js` 的 `app.whenReady()` 回调里**原样搬出**，行为不变：这些 handler 的注册时机
 * （whenReady 之后、单实例锁获得之后）与闭包语义都保持一致，只是把原来靠模块作用域拿到的
 * 依赖改成从 `ctx` 传进来 —— 原来读 `mainWindow` 的地方改读 `getMainWindow()`（窗口可能重建）。
 *
 * 为什么单列一个模块：这些频道与「微信数据后端」无关，是宿主层的基础设施；
 * 分开之后 `main.js` 只剩编排。
 * @param {object} ctx - 由 main.js 组装：ipcMain / app / dialog / shell / path / fs /
 *   diagLog / STATE_DIR / APP_VERSION / debugGates / licenseService / getMainWindow /
 *   buildDiagnosticReport / installWebContentsGuards（后两个原来直接靠模块作用域，靠标识符审计才抓出来）。
 */
/** 诊断日志的查询、导出、预览、复制与定位。 */
function registerDiagnosticIpc(reg, deps) {
  const {
    app, dialog, shell, path, fs, clipboard, diagLog, APP_VERSION,
    buildDiagnosticPreview, buildDiagnosticReport, getMainWindow,
  } = deps;

  reg.handleIpc('diag:log-info', () => {
    const files = diagLog.files()
      .map((p) => {
        try { return { path: p, name: path.basename(p), size: fs.statSync(p).size } } catch { return null; }
      })
      .filter(Boolean);
    return { ok: true, dir: path.dirname(diagLog.path), current: diagLog.path, files };
  });

  reg.handleIpc('diag:export-log', async () => {
    try {
      const parts = diagLog.files().slice().reverse()
        .filter((p) => { try { return fs.statSync(p).size > 0; } catch { return false; } });
      if (parts.length === 0) return { ok: false, error: '当前没有日志内容可导出' };
      let dest = (process.env.SUPERTIME_SAVE_PATH || '').trim();
      if (!dest) {
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const result = await dialog.showSaveDialog(getMainWindow(), {
          title: '导出诊断日志',
          defaultPath: `supertime-diagnostic-${stamp}.log`,
          filters: [{ name: '日志', extensions: ['log', 'txt'] }],
        });
        if (result.canceled || !result.filePath) return { ok: false, canceled: true };
        dest = result.filePath;
      }
      const report = buildDiagnosticReport(diagLog, {
        app: APP_VERSION,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        packaged: app.isPackaged,
      });
      fs.writeFileSync(dest, report, 'utf8');
      diagLog.write('info', ['诊断日志已导出到', dest]);
      return { ok: true, path: dest, bytes: fs.statSync(dest).size };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  reg.handleIpc('diag:preview-log', () => {
    try {
      return { ok: true, ...buildDiagnosticPreview(diagLog, {
        app: APP_VERSION,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        packaged: app.isPackaged,
      }) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  reg.handleIpc('diag:copy-log-path', () => {
    try {
      const target = path.dirname(diagLog.path);
      clipboard.writeText(target);
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  reg.handleIpc('diag:reveal-log', () => {
    try {
      shell.showItemInFolder(diagLog.path);
      return { ok: true, path: diagLog.path };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

/** 应用元信息与运行模式。 */
function registerAppIpc(reg, deps) {
  const { app, fs, path, STATE_DIR, APP_VERSION, debugGates } = deps;

  reg.handleIpc('app:versions', () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    app: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  }));

  reg.handleIpc('app:ping', () => `pong @ ${new Date().toISOString()}`);
  reg.handleIpc('app:test-mode', () => process.env.SUPERTIME_TEST_MODE === '1');

  reg.handleIpc('app:run-mode', () => {
    let dataRoot = '';
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'config.json'), 'utf8'));
      dataRoot = String(cfg?.resolved?.dataRoot ?? cfg?.dataRoot ?? '');
    } catch { /* 没写过就留空 */ }
    return {
      test: process.env.SUPERTIME_TEST_MODE === '1',
      llmMock: process.env.SUPERTIME_LLM_MOCK === '1',
      dataRoot,
    };
  });

  reg.handleIpc('app:debug-gates', () => {
    const gates = debugGates();
    if (gates.skipGates) {
      console.warn('[debug-gates] SUPERTIME_SKIP_ONBOARDING=1：跳过启动引导 / 隐私同意 / 授权（仅非打包态生效）');
    }
    return { packaged: gates.packaged, skipGates: gates.skipGates };
  });
}

/** 许可证状态、请求导出、导入与移除。 */
function registerLicenseIpc(reg, deps) {
  const { app, dialog, fs, getMainWindow, licenseService, APP_VERSION } = deps;

  reg.handleIpc('license:status', () => {
    try {
      return licenseService.getLicenseStatus(app.getPath('userData'), APP_VERSION);
    } catch (err) {
      return { state: 'error', licensed: false, reason: err.message, code: 'ERROR' };
    }
  });

  reg.handleIpc('license:export-request', async () => {
    try {
      const req = licenseService.getActivationRequest(app.getPath('userData'), APP_VERSION);
      const result = await dialog.showSaveDialog(getMainWindow(), {
        title: '导出激活请求',
        defaultPath: `activation-request-${req.fingerprint.slice(0, 8)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(result.filePath, JSON.stringify(req, null, 2), 'utf8');
      return { ok: true, path: result.filePath, request: req };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  reg.handleIpc('license:import', async () => {
    try {
      const picked = await dialog.showOpenDialog(getMainWindow(), {
        title: '导入许可证',
        properties: ['openFile'],
        filters: [{ name: 'License', extensions: ['json', 'lic'] }],
      });
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
      const content = fs.readFileSync(picked.filePaths[0], 'utf8');
      return licenseService.importLicense(app.getPath('userData'), APP_VERSION, content);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  reg.handleIpc('license:import-text', (_e, text) => {
    try {
      return licenseService.importLicense(app.getPath('userData'), APP_VERSION, String(text ?? ''));
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  reg.handleIpc('license:remove', () => {
    try {
      return { ok: true, status: licenseService.removeLicense(app.getPath('userData'), APP_VERSION) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

/** 文件与目录选择、保存路径。 */
function registerDialogIpc(reg, deps) {
  const { dialog, getMainWindow, path } = deps;

  reg.handleIpc('dialog:open-file', async (_event, opts) => {
    try {
      const forced = (process.env.SUPERTIME_OPEN_PATHS || '').trim();
      if (forced) {
        const files = forced.split(path.delimiter).map((s) => s.trim()).filter(Boolean);
        return files.length ? { canceled: false, files } : { canceled: true, files: [] };
      }
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: typeof opts?.title === 'string' && opts.title ? opts.title : '选择文件',
        properties: ['openFile', 'multiSelections'],
        filters: Array.isArray(opts?.filters) && opts.filters.length ? opts.filters : undefined,
      });
      if (result.canceled) return { canceled: true, files: [] };
      return { canceled: false, files: result.filePaths };
    } catch (e) {
      return { canceled: true, files: [], error: e?.message ?? String(e) };
    }
  });

  reg.handleIpc('dialog:open-directory', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled) return { canceled: true, path: null };
    return { canceled: false, path: result.filePaths[0] ?? null };
  });

  reg.handleIpc('dialog:save-file', async (_event, opts) => {
    try {
      const forced = (process.env.SUPERTIME_SAVE_PATH || '').trim();
      if (forced) return { canceled: false, path: forced };
      const result = await dialog.showSaveDialog(getMainWindow(), {
        title: typeof opts?.title === 'string' && opts.title ? opts.title : '保存文件',
        defaultPath: typeof opts?.defaultName === 'string' && opts.defaultName ? opts.defaultName : 'export.bin',
        filters: Array.isArray(opts?.filters) ? opts.filters : undefined,
      });
      if (result.canceled || !result.filePath) return { canceled: true, path: null };
      return { canceled: false, path: result.filePath };
    } catch (e) {
      return { canceled: true, path: null, error: e?.message ?? String(e) };
    }
  });
}

/** 系统外壳与自绘窗口控制。 */
function registerShellWindowIpc(reg, deps) {
  const { getMainWindow, dialog, fs, shell } = deps;

  reg.handleIpc('shell:show-item', (_event, filePath) => {
    if (typeof filePath === 'string' && filePath) {
      shell.showItemInFolder(filePath);
    }
    return true;
  });

  reg.onIpc('window:minimize', () => {
    if (getMainWindow()) getMainWindow().minimize();
  });
  reg.onIpc('window:close', () => {
    if (getMainWindow()) getMainWindow().close();
  });
  reg.onIpc('window:fullscreen-toggle', () => {
    if (getMainWindow()) getMainWindow().setFullScreen(!getMainWindow().isFullScreen());
  });
  reg.handleIpc('window:is-fullscreen', () => getMainWindow()?.isFullScreen() ?? false);

  reg.handleIpc('window:capture-panel', async (_event, rect) => {
    try {
      if (!getMainWindow()) return { ok: false, message: '窗口不存在' };
      const x = Math.max(0, Math.round(Number(rect?.x) || 0));
      const y = Math.max(0, Math.round(Number(rect?.y) || 0));
      const width = Math.max(1, Math.round(Number(rect?.width) || 0));
      const height = Math.max(1, Math.round(Number(rect?.height) || 0));
      const image = await getMainWindow().webContents.capturePage({ x, y, width, height });
      const png = image.toPNG();
      if (!png || png.length === 0) return { ok: false, message: '截图内容为空' };
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const suggested = typeof rect?.filename === 'string' && rect.filename.trim()
        ? rect.filename.trim()
        : `wechat-report-${stamp}.png`;
      const forced = process.env.SUPERTIME_CAPTURE_PATH;
      if (forced) {
        fs.writeFileSync(forced, png);
        return { ok: true, path: forced, bytes: png.length, width: image.getSize().width, height: image.getSize().height };
      }
      const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), {
        title: '导出报告截图',
        defaultPath: suggested,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      });
      if (canceled || !filePath) return { ok: true, canceled: true };
      fs.writeFileSync(filePath, png);
      return { ok: true, path: filePath, bytes: png.length, width: image.getSize().width, height: image.getSize().height };
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    }
  });
}

function registerMiscIpc(ctx) {
  const { ipcMain, ipcTrust, app, clipboard, dialog, shell, path, fs, diagLog, STATE_DIR, APP_VERSION, debugGates, licenseService, getMainWindow, buildDiagnosticPreview, buildDiagnosticReport, installWebContentsGuards } = ctx;
  const handleIpc = (channel, handler) => ipcMain.handle(channel, ipcTrust.wrap(channel, handler));
  const onIpc = (channel, listener) => ipcMain.on(channel, ipcTrust.wrapOn(channel, listener));
  const reg = { handleIpc, onIpc };

  // 守卫必须在建窗之前注册，否则主窗口的 webContents 已经建好、错过事件。
  app.on('web-contents-created', (_event, contents) => installWebContentsGuards(contents));
  registerDiagnosticIpc(reg, {
    app, dialog, shell, path, fs, clipboard, diagLog, APP_VERSION,
    buildDiagnosticPreview, buildDiagnosticReport, getMainWindow,
  });
  registerAppIpc(reg, { app, fs, path, STATE_DIR, APP_VERSION, debugGates });
  registerLicenseIpc(reg, { app, dialog, fs, getMainWindow, licenseService, APP_VERSION });
  registerDialogIpc(reg, { dialog, getMainWindow, path });
  registerShellWindowIpc(reg, { getMainWindow, dialog, fs, shell });
}


module.exports = { registerMiscIpc };
