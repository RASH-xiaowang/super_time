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
 *   diagLog / STATE_DIR / APP_VERSION / debugGates / licenseService / getMainWindow / buildDiagnosticReport。
 */
function registerMiscIpc(ctx) {
  const { ipcMain, app, dialog, shell, path, fs, diagLog, STATE_DIR, APP_VERSION, debugGates, licenseService, getMainWindow, buildDiagnosticReport, installWebContentsGuards } = ctx;
  ipcMain.handle('diag:log-info', () => {
    const files = diagLog.files()
      .map((p) => {
        try { return { path: p, name: path.basename(p), size: fs.statSync(p).size } } catch { return null; }
      })
      .filter(Boolean);
    return { ok: true, dir: path.dirname(diagLog.path), current: diagLog.path, files };
  });
  ipcMain.handle('diag:export-log', async () => {
    try {
      // 旧 → 新拼接：用户只需要交出一个文件
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
  ipcMain.handle('diag:reveal-log', () => {
    try {
      shell.showItemInFolder(diagLog.path);
      return { ok: true, path: diagLog.path };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // 守卫必须在建窗**之前**注册，否则主窗口的 webContents 已经建好、错过事件。
  app.on('web-contents-created', (_event, contents) => installWebContentsGuards(contents));
  ipcMain.handle('app:versions', () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch
  }));

  ipcMain.handle('app:ping', () => `pong @ ${new Date().toISOString()}`);

  /**
   * 是否处于验收/自动化测试模式（`SUPERTIME_TEST_MODE=1`）。
   *
   * 验收脚本会用**本地 mock LLM** 替换模型，回答是固定文本而不是真实数据 ——
   * 曾经两次被误认成「应用在编造答案」。前端据此在窗口顶部挂一条醒目横幅。
   */
  ipcMain.handle('app:test-mode', () => process.env.SUPERTIME_TEST_MODE === '1');

  /**
   * 首启闸门豁免状态（N2）：`{ packaged, skipGates }`。
   *
   * 把 `app.isPackaged` **作为事实**回给渲染层 —— 渲染层据此决定要不要跳过
   * 「启动引导 / 授权 / 隐私同意」三道闸门，而打包态的 `skipGates` 恒为 false：
   * 环变量伪造不了 `app.isPackaged`，所以「打包版 + 设环变量」进不去主界面。
   * 未知的 `ipcMain` 调用者只会拿到这两个布尔值，拿不到判定权。
   */
  ipcMain.handle('app:debug-gates', () => {
    const gates = debugGates();
    if (gates.skipGates) {
      console.warn('[debug-gates] SUPERTIME_SKIP_ONBOARDING=1：跳过启动引导 / 授权 / 隐私同意（仅非打包态生效）');
    }
    return { packaged: gates.packaged, skipGates: gates.skipGates };
  });

  // —— License 授权（混合模式：本地验签为主）——
  ipcMain.handle('license:status', () => {
    try {
      return licenseService.getLicenseStatus(app.getPath('userData'), APP_VERSION);
    } catch (err) {
      return { state: 'error', licensed: false, reason: err.message, code: 'ERROR' };
    }
  });


  ipcMain.handle('license:export-request', async () => {
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

  ipcMain.handle('license:import', async () => {
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

  ipcMain.handle('license:import-text', (_e, text) => {
    try {
      return licenseService.importLicense(app.getPath('userData'), APP_VERSION, String(text ?? ''));
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('license:remove', () => {
    try {
      return { ok: true, status: licenseService.removeLicense(app.getPath('userData'), APP_VERSION) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });


  /**
   * 文件选择：只负责选路径，读盘与登记由后端做（选中的可能是几十 MB 的文件，
   * 不适合经 IPC 传字节；也与 `dialog:save-file` 同一个口径）。
   *
   * `opts.filters` **由调用方传**，主进程不写死白名单：写死一份就会与后端
   * `query/kb/types.ts` 的 `ACCEPTED_EXTS` 漂移成两份，症状是「对话框里看不到」
   * 或者更糟 ——「选得进来但登记被拒」（用户在两个地方各被拒一次，说不清哪边错了）。
   */
  ipcMain.handle('dialog:open-file', async (_event, opts) => {
    try {
      // 调试/自动化用：设了 SUPERTIME_OPEN_PATHS 就跳过原生对话框直接用它
      // （原生对话框在无头自动化里点不到，否则「添加文件」链路无法被测试覆盖）。
      // 多个路径用 `path.delimiter` 分隔 —— 与 SUPERTIME_SAVE_PATH 同款约定，
      // 不用 `,` 是因为 Windows 路径里逗号是合法字符（`我的资料,2019.pdf`）。
      const forced = (process.env.SUPERTIME_OPEN_PATHS || '').trim();
      if (forced) {
        const files = forced.split(path.delimiter).map(s => s.trim()).filter(Boolean);
        // 全空串视为「取消」而不是「选了一批空路径」——否则调用方会去登记一堆非法项
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

  ipcMain.handle('dialog:open-directory', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled) return { canceled: true, path: null };
    return { canceled: false, path: result.filePaths[0] ?? null };
  });

  /**
   * 保存对话框：只负责选路径，真正的写盘由后端做（视频有几十 MB，不适合经 IPC 传字节）。
   */
  ipcMain.handle('dialog:save-file', async (_event, opts) => {
    try {
      // 调试/自动化用：设了 SUPERTIME_SAVE_PATH 就跳过原生对话框直接用它
      // （原生对话框在无头自动化里点不到，否则「保存」按钮无法被测试覆盖）。
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

  ipcMain.handle('shell:show-item', (_event, filePath) => {
    if (typeof filePath === 'string' && filePath) {
      shell.showItemInFolder(filePath);
    }
    return true;
  });

  // —— 自绘标题栏窗口控制 ——
  ipcMain.on('window:minimize', () => {
    if (getMainWindow()) getMainWindow().minimize();
  });
  ipcMain.on('window:close', () => {
    if (getMainWindow()) getMainWindow().close();
  });
  ipcMain.on('window:fullscreen-toggle', () => {
    if (getMainWindow()) getMainWindow().setFullScreen(!getMainWindow().isFullScreen());
  });
  ipcMain.handle('window:is-fullscreen', () => getMainWindow()?.isFullScreen() ?? false);

  /**
   * 把渲染进程指定的矩形区域截成 PNG 保存（「导出报告 → 界面截图」）。
   *
   * 为什么放在主进程：`webContents.capturePage(rect)` 只有主进程能用；渲染端的
   * `getBoundingClientRect()` 给的正是 CSS 像素坐标，与 capturePage 的矩形同坐标系，
   * 因此「所见即所存」——不需要另写一套报告模板。
   * @param rect - { x, y, width, height }，相对渲染页视口。
   * @returns { ok, canceled? , path?, message? }
   */
  ipcMain.handle('window:capture-panel', async (_event, rect) => {
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
      // 调试/自动化用：设了 SUPERTIME_CAPTURE_PATH 就跳过保存对话框直接落盘
      // （原生对话框在无头自动化里点不到，否则导出无法被测试覆盖）。
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

module.exports = { registerMiscIpc };
