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
const { bumpMutationEpoch } = require('./mutation-gate.js');

/** 许可证变化会改变可写范围；成功后开新代际，阻挡旧代际的排队写。 */
function bumpLicenseEpoch(result) {
  if (result && typeof result === 'object' && result.ok === true) bumpMutationEpoch('license-changed');
  return result;
}
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
      return bumpLicenseEpoch(licenseService.importLicense(app.getPath('userData'), APP_VERSION, content));
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  reg.handleIpc('license:import-text', (_e, text) => {
    try {
      return bumpLicenseEpoch(licenseService.importLicense(app.getPath('userData'), APP_VERSION, String(text ?? '')));
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  reg.handleIpc('license:remove', () => {
    try {
      return bumpLicenseEpoch({ ok: true, status: licenseService.removeLicense(app.getPath('userData'), APP_VERSION) });
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
  const { getMainWindow, screen, dialog, fs, shell } = deps;

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

  /**
   * 「全屏」= **铺满当前显示器的工作区**（保留任务栏），不是 OS 全屏。
   *
   * 为什么不用 `setFullScreen(true)`：Windows 上那是真全屏，2560×1440 的屏上 bounds 变成
   * `0,0,2560,1440`，把底部 40px 任务栏整个盖住（用户 2026-10-18 报的就是它）。
   *
   * 为什么不用 `maximize()`：本窗口是 `frame:false`。实测 maximize 后 bounds 是
   * `-8,-8,2576,1416` —— Windows 把不可见的窗口缩放边框算到可视区外面，右/下各越界 8px，
   * 仍会压住任务栏上沿；而且**这两种状态之后再 setBounds 都会被 Electron 忽略**
   * （实测 A/B 两组都是原 bounds 不变），没法事后修正。
   *
   * 显式 `setBounds(display.workArea)` 是实测唯一精确的路径：`0,0,2560,1400`，
   * 屏幕铺满、任务栏保持可见、退出时把进入前的 bounds 还回去。若进入前本身已经接近
   * 铺满（或被系统/Win32 最大化过），退出时改用启动基准 1440×900 居中，否则用户会觉得
   * 「点了退出全屏还是全屏」。
   * 代价是窗口不算「OS 最大化态」（本窗口本来就没有系统标题栏，铺满只由自绘按钮触发）。
   */
  let savedBounds = null;
  const liveWindow = () => {
    const win = getMainWindow();
    return win && !win.isDestroyed() ? win : null;
  };
  /** 退出全屏时用的「合适尺寸」：启动基准 1440×900，按当前显示器工作区留 10% 边距并居中。 */
  const SUITABLE_W = 1440;
  const SUITABLE_H = 900;
  const MIN_W = 960;
  const MIN_H = 640;
  const suitableBounds = (display) => {
    const wa = display.workArea;
    const width = Math.max(MIN_W, Math.min(SUITABLE_W, Math.floor(wa.width * 0.9)));
    const height = Math.max(MIN_H, Math.min(SUITABLE_H, Math.floor(wa.height * 0.9)));
    return {
      x: wa.x + Math.max(0, Math.round((wa.width - width) / 2)),
      y: wa.y + Math.max(0, Math.round((wa.height - height) / 2)),
      width,
      height,
    };
  };
  reg.onIpc('window:fullscreen-toggle', () => {
    const win = liveWindow();
    if (!win) return;
    if (savedBounds) {
      const restore = savedBounds;
      savedBounds = null;
      // 进入全屏前的窗口如果本身已经接近铺满（例如上一次被 Win32/系统最大化，或直接
      // 从旧版本残留的大尺寸启动），原样还回去等于"退出全屏但看起来还是全屏"。
      // 这种情况改用启动基准尺寸并居中；用户自己拖出来的正常尺寸仍原样保留。
      const display = screen.getDisplayMatching(win.getBounds());
      const wa = display.workArea;
      const nearlyFull = restore.width >= Math.round(wa.width * 0.95)
        && restore.height >= Math.round(wa.height * 0.95);
      const outside = restore.width > wa.width || restore.height > wa.height;
      win.setBounds(nearlyFull || outside ? suitableBounds(display) : restore);
      win.webContents.send('window:fullscreen-changed', false);
      return;
    }
    // 多屏：按窗口**当前所在**显示器取工作区，而不是主屏。
    const display = screen.getDisplayMatching(win.getBounds());
    savedBounds = win.getBounds();
    win.setBounds(display.workArea);
    win.webContents.send('window:fullscreen-changed', true);
  });
  reg.handleIpc('window:is-fullscreen', () => {
    const win = liveWindow();
    if (!win) return false;
    return savedBounds !== null || win.isFullScreen();
  });

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
  const { ipcMain, ipcTrust, app, screen, clipboard, dialog, shell, path, fs, diagLog, STATE_DIR, APP_VERSION, debugGates, licenseService, getMainWindow, buildDiagnosticPreview, buildDiagnosticReport, installWebContentsGuards } = ctx;
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
  registerShellWindowIpc(reg, { getMainWindow, screen, dialog, fs, shell });
}


module.exports = { registerMiscIpc };
