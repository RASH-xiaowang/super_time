/**
 * 主进程 IPC：应用自动更新（electron-updater + GitHub Releases）。
 *
 * 从 `main.js` 的 `app.whenReady()` 回调里原样搬出。更新服务的懒加载、自动检查
 * 调度与退出清理仍留在 main.js；这里只收敛渲染层触发的五条通道：
 *
 *   update:state   —— 渲染层挂载时补一次状态（可能已经错过早先的事件）
 *   update:check   —— 用户手动触发；自动检查由 main.js 的 scheduleAutoCheck 安排
 *   update:install —— 重启并安装已下载的更新
 *   update:skip    —— 跳过某个版本（空串 = 取消跳过）
 *   update:retry   —— 手动重试下载（不受自动重试的次数上限约束）
 *
 * `update:event` 不在这里：它是主进程 → 渲染层的广播，发送端仍由 main.js 持有。
 *
 * @param {object} ctx - 由 main.js 组装：ipcMain / updateService。
 */
function registerUpdateIpc(ctx) {
  const { ipcMain, ipcTrust, updateService } = ctx;
  const handleIpc = (channel, handler) => ipcMain.handle(channel, ipcTrust.wrap(channel, handler));

  handleIpc('update:state', () => ({ ok: true, value: updateService.getState() }));
  handleIpc('update:check', async (_event, opts) => {
    try {
      // 只收 `manual` 这一个布尔：渲染层决定不了「要不要真的出网」—— 那只由主进程的
      // 打包态判定与环境变量决定（见 update.js 的 isSupported）。
      const next = await updateService.check({ manual: !!(opts && opts.manual === true) });
      return { ok: true, value: next };
    } catch (err) {
      return { ok: false, error: { message: err?.message || String(err) } };
    }
  });
  handleIpc('update:install', () => {
    const r = updateService.install();
    return r.ok ? { ok: true } : { ok: false, error: { message: r.error } };
  });
  /**
   * 跳过某个版本 / 手动重试下载。
   *
   * 与 `update:check` 同一条纪律：渲染层只传「跳哪个版本号」这一个字符串，
   * **不参与**任何「要不要出网」的判定。`skipVersion` 传空串就是取消跳过（可反悔）。
   */
  handleIpc('update:skip', (_event, version) => {
    try {
      const v = typeof version === 'string' ? version : '';
      return { ok: true, value: updateService.skipVersion(v) };
    } catch (err) {
      return { ok: false, error: { message: err?.message || String(err) } };
    }
  });
  handleIpc('update:retry', async () => {
    try {
      const next = await updateService.retryDownload();
      return { ok: true, value: next };
    } catch (err) {
      return { ok: false, error: { message: err?.message || String(err) } };
    }
  });
}

module.exports = { registerUpdateIpc };
