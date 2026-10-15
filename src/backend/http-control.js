/**
 * 远程访问（手机端）的**控制面**：开关、轮换令牌。
 *
 * ## 为什么单独一个模块
 *
 * 这两件事都要「改配置 → 让服务重新对齐」，而改配置必须走后端的 `saveWechatConfig`
 * （它负责原子写、写前备份、以及把 `api_token` 这类密钥字段分流进 `secrets.json`
 * 并收紧 ACL —— 见 `config/wechat-config.ts` 的 `SECRET_FIELDS`）。主进程自己写文件
 * 就会绕过那一整套语义，所以这里统一委托给后端。
 *
 * 放在 `main.js` 里也行，但 `main.js` 已经 900 多行（仓库有每文件 ≤1000 行的棘轮），
 * 而这段逻辑值得被单测直接覆盖 —— 尤其「轮换令牌必须让旧会话立刻失效」这一条。
 *
 * ## 轮换令牌为什么要顺带清会话
 *
 * 轮换的唯一现实理由是「旧令牌可能已经泄漏」（手机丢了、二维码被人拍过、
 * 屏幕共享时露过）。如果只换令牌不作废会话，那么**已经拿到会话 Cookie 的设备
 * 在 12 小时内照样能进** —— 轮换就只是换了个字符串，安全上什么都没变。
 * 所以 rotate 之后必须调 `remoteAccess.stop()`/`syncWithConfig()` 把内存里的会话表清掉
 * （`stop()` 内部会 `revokeAll()`）。
 *
 * @module backend/http-control
 */
const { generateAccessToken } = require('./http-auth.js');

/**
 * @typedef {object} ControlDeps
 * @property {(method: string, args: unknown[]) => Promise<{ ok: boolean, value?: unknown, error?: unknown }>} backendCall - 调后端（走 worker）。
 * @property {{ stop: () => Promise<unknown>, syncWithConfig: () => Promise<unknown>, getState: () => object, issuePairingCode: () => string }} remoteAccess - 服务句柄。
 */

/**
 * 把一组配置补丁写进后端配置（密钥字段会自动分流到 secrets.json）。
 * @param {ControlDeps} deps
 * @param {Record<string, unknown>} patch
 * @returns `{ ok, error? }`。
 */
async function savePatch(deps, patch) {
  try {
    const r = await deps.backendCall('saveWechatConfig', [{ patch }]);
    // 后端回的是信封；`value.ok === false` 表示「保存过程有问题」，也要当失败处理
    if (!r || r.ok === false) return { ok: false, error: r?.error?.message ?? r?.value?.error ?? '保存配置失败' };
    if (r.value && r.value.ok === false) return { ok: false, error: r.value.error ?? '保存配置失败' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * 建控制面。
 * @param {ControlDeps} deps
 * @returns `{ rotate, setEnabled, state }`。
 */
function createRemoteAccessControl(deps) {
  return {
    /**
     * 生成一个新令牌并**同时打开**开关（用户点「启用 / 轮换」时的动作）。
     *
     * 令牌原文只在这一次的返回值里出现（界面用它拼二维码与可复制的链接），
     * 之后的所有状态查询都只给掩码 —— 见 `http-auth.js` 的 `maskToken`。
     * @returns `{ ok, token?, state?, error? }`。
     */
    async rotate() {
      const token = generateAccessToken();
      const saved = await savePatch(deps, { api_token: token, api_enabled: true });
      if (!saved.ok) return { ok: false, error: saved.error };
      // 先停再对齐：stop() 会 revokeAll()，把旧令牌换来的会话一并作废。
      // 只调 syncWithConfig 的话，服务在「已经在跑」时不会重启，旧会话就还活着。
      try {
        await deps.remoteAccess.stop();
      } catch { /* 没在跑就算了 */ }
      const state = await deps.remoteAccess.syncWithConfig();
      // 配对码必须在 stop()/syncWithConfig() 之后签发：停服会先作废内存里的旧码，
      // 顺序反了会把刚刚发出的这个码一起清掉。
      const pairingCode = deps.remoteAccess.issuePairingCode();
      return { ok: true, token, pairingCode, state };
    },

    /**
     * 打开 / 关闭监听。
     *
     * 关闭时**不动令牌**（下次打开还是同一个，二维码不用重发）；
     * 但会 stop()，因此所有在连的手机立刻断开。
     * @param {boolean} enabled
     * @returns `{ ok, state?, error? }`。
     */
    async setEnabled(enabled) {
      const saved = await savePatch(deps, { api_enabled: enabled === true });
      if (!saved.ok) return { ok: false, error: saved.error };
      if (enabled !== true) {
        try { await deps.remoteAccess.stop(); } catch { /* 没在跑就算了 */ }
      }
      const state = await deps.remoteAccess.syncWithConfig();
      return { ok: true, state };
    },

    /** 当前状态（不含令牌原文）。 */
    state() {
      return deps.remoteAccess.getState();
    },
  };
}

module.exports = { createRemoteAccessControl };
