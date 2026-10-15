/**
 * 主进程 IPC：局域网远程访问（手机端）的控制通道。
 *
 * 从 `main.js` 的 `app.whenReady()` 回调里原样搬出，注册时机与返回形状不变。
 * 服务本身的创建 / 启动 / 停止仍留在 main.js —— 那几处依赖后端就绪顺序；
 * 这里只负责渲染层能点到的四条控制通道，并把「轮换 / 开关」收敛到
 * `http-control.js` 的唯一控制面实现。
 *
 * @param {object} ctx - 由 main.js 组装：ipcMain / remoteAccess / backendCall。
 */
const { createRemoteAccessControl } = require('./http-control.js');

function registerRemoteAccessIpc(ctx) {
  const { ipcMain, ipcTrust, remoteAccess, backendCall } = ctx;
  const handleIpc = (channel, handler) => ipcMain.handle(channel, ipcTrust.wrap(channel, handler));

  // 界面改完「远程访问」设置后立即生效（不等 60s 的兜底复查）。
  handleIpc('remote-access:state', () => ({ ok: true, value: remoteAccess.getState() }));
  handleIpc('remote-access:apply', async () => {
    try {
      return { ok: true, value: await remoteAccess.syncWithConfig() };
    } catch (e) {
      return { ok: false, error: { message: e?.message ?? String(e) } };
    }
  });

  // 开关与令牌轮换：写配置一律走后端的 saveWechatConfig（它负责原子写、写前备份、
  // 以及把 api_token 这类密钥字段分流进 secrets.json 并收紧 ACL）。
  const control = createRemoteAccessControl({ backendCall, remoteAccess });
  handleIpc('remote-access:rotate', async () => {
    try {
      const r = await control.rotate();
      return r.ok ? { ok: true, value: r } : { ok: false, error: { message: r.error } };
    } catch (e) {
      return { ok: false, error: { message: e?.message ?? String(e) } };
    }
  });
  handleIpc('remote-access:toggle', async (_e, enabled) => {
    try {
      const r = await control.setEnabled(enabled === true);
      return r.ok ? { ok: true, value: r.state } : { ok: false, error: { message: r.error } };
    } catch (e) {
      return { ok: false, error: { message: e?.message ?? String(e) } };
    }
  });
}

module.exports = { registerRemoteAccessIpc };
