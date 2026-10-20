/**
 * 浏览器交接（2026-10-19）：「打开网页」把操作权交给系统默认浏览器，桌面端缩成右下角卡片。
 *
 * ## 为什么复用「远程访问（手机）」
 *
 * 浏览器里的应用必须和桌面端**同一份构建、同一套后端**。仓库里唯一已具备这条性质的是
 * 局域网远程访问：它把 `src/client/ui-dist` 原样提供出去，`/api/wechat/call` 走的是
 * 与 IPC 相同的那道 `gatedWechatCall`，SSE 事件也走同一张映射表。另起一套「本机网页服务」
 * 只会多一份权限面，且两边行为会逐渐漂移。
 *
 * 所以「打开网页」= 确保远程访问在跑 → 签发一次性配对码 → 拼出 `/?t=<code>` →
 * 交给 `shell.openExternal`。浏览器用配对码换 12 小时会话 Cookie，之后与手机访问完全同权。
 *
 * ## 桌面端为什么先隐藏再弹卡片
 *
 * 用户的要求是「操作权限全部给浏览器」—— 主窗口还留在屏幕上（哪怕只是最小化）就仍然
 * 可以被点、被键盘操作，会出现两个窗口同时改同一份数据。因此：
 *   ① 主窗口 `hide()`（不是 `minimize()`：任务栏里也不该留一个能点开的入口）；
 *   ② 另建一个**无边框、置顶、可拖动**的小卡片，只保留一个「返回桌面」按钮；
 *   ③ 卡片点回去时先 `setEnabled(false)` 停掉 HTTP 服务（`stop()` 会作废全部会话），
 *      浏览器下一次请求就是 401，界面自动回到令牌门 —— 这就是「浏览器自动断开」。
 *
 * 卡片没有加载任何业务界面，只有一段静态 HTML；它拿不到 `electronAPI`，因此即使
 * 被脚本注入也没有操作权限。这点与主窗口的 preload 桥是两套东西。
 *
 * @module backend/browser-handoff
 */
const { createRemoteAccessControl } = require('./http-control.js');

/** 卡片尺寸与右下角留白（与 Windows 任务栏留一点呼吸）。 */
const CARD_WIDTH = 256;
const CARD_HEIGHT = 108;
const CARD_MARGIN = 18;

/**
 * 生成卡片页面的 HTML（深/浅色由系统主题决定）。
 * @param {boolean} dark - 是否深色。
 * @returns {string} data URL 页面（内联样式与一段只调 `window.handoff.restore()` 的脚本）。
 */
function cardHtml(dark) {
  const bg = dark ? '#0d1720' : '#f7fbfe';
  const fg = dark ? '#e7f1f8' : '#0b2b3c';
  const sub = dark ? '#7f9bab' : '#587687';
  const border = dark ? 'rgba(84, 174, 214, 0.32)' : 'rgba(16, 100, 135, 0.22)';
  const buttonBg = dark
    ? 'linear-gradient(135deg, #1f8fb5, #2bb3c9)'
    : 'linear-gradient(135deg, #0d7fa3, #18a7bd)';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;overflow:hidden;background:transparent}
    body{font-family:"Microsoft YaHei UI","Segoe UI",system-ui,sans-serif;user-select:none}
    .card{height:100%;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;
      border-radius:14px;background:${bg};color:${fg};border:1px solid ${border};
      box-shadow:0 12px 34px rgba(0,0,0,0.34)}
    .drag{flex:0 0 36px;display:flex;align-items:center;gap:8px;padding:0 14px;
      -webkit-app-region:drag;cursor:grab}
    .drag:active{cursor:grabbing}
    .logo{width:18px;height:18px;flex:0 0 auto;color:#22a7c4}
    .name{font-size:12px;font-weight:600;letter-spacing:0.2px}
    .state{margin-left:auto;font-size:10px;color:${sub};white-space:nowrap}
    .dot{width:6px;height:6px;border-radius:50%;background:#25b9a8;box-shadow:0 0 7px rgba(37,185,168,0.8)}
    button{flex:1 1 auto;margin:0 9px 9px;border:0;border-radius:10px;cursor:pointer;
      background:${buttonBg};color:#fff;font-size:12px;font-weight:600;font-family:inherit;
      -webkit-app-region:no-drag;letter-spacing:0.3px}
    button:hover{filter:brightness(1.08)}
    button:active{filter:brightness(0.94)}
    .hint{margin:-4px 12px 8px;font-size:10px;color:${sub};text-align:center;-webkit-app-region:drag}
  </style></head><body><div class="card">
    <div class="drag">
      <svg class="logo" viewBox="0 0 24 24" fill="none"><path d="M9.5 3.5C4.8 3.5 1 6.8 1 10.9c0 2.3 1.2 4.4 3.2 5.8L3 20l3.7-1.6c.9.3 1.8.4 2.8.4 4.7 0 8.5-3.3 8.5-7.9S14.2 3.5 9.5 3.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="6.2" cy="10.8" r="1" fill="currentColor"/><circle cx="9.7" cy="10.8" r="1" fill="currentColor"/><circle cx="13.2" cy="10.8" r="1" fill="currentColor"/></svg>
      <span class="name">Super Time</span>
      <span class="state"><span class="dot" style="display:inline-block;vertical-align:middle;margin-right:5px"></span>网页控制中</span>
    </div>
    <button id="restore" type="button">点击返回桌面应用</button>
    <div class="hint">可拖动卡片 · 返回后浏览器自动断开</div>
  </div><script>
    document.getElementById('restore').addEventListener('click', function () {
      try { window.handoff.restore() } catch (e) { /* 预加载缺失时静默：卡片仍可拖动 */ }
    })
  </script></body></html>`;
}

/**
 * 建浏览器交接控制面。
 * @param {object} deps - 主进程注入。
 * @param {object} deps.ipcMain - Electron ipcMain。
 * @param {object} deps.ipcTrust - 来源守卫（主窗口入口）。
 * @param {Function} deps.BrowserWindow - Electron BrowserWindow 构造器。
 * @param {object} deps.screen - Electron screen。
 * @param {object} deps.nativeTheme - Electron nativeTheme。
 * @param {string} deps.rootDir - 应用根（卡片 preload 路径）。
 * @param {object} deps.remoteAccess - HTTP 服务句柄。
 * @param {Function} deps.backendCall - 调后端（控制面写配置用）。
 * @param {Function} deps.openExternal - `shell.openExternal` 的注入（单测可替换）。
 * @param {Function} deps.getMainWindow - 取主窗口。
 * @returns `{ open, restore, state, dispose }`。
 */
function createBrowserHandoff(deps) {
  const control = createRemoteAccessControl({ backendCall: deps.backendCall, remoteAccess: deps.remoteAccess });
  let card = null;
  let active = false;
  /** 本次交接是否由我们启动了 HTTP 服务（决定收尾时「关配置」还是「只作废会话」）。 */
  let startedService = false;

  /** 取一个能用的配对码并拼出本机可打开的地址。 */
  async function ensureSession() {
    const before = deps.remoteAccess.getState();
    const wasRunning = before.running === true && before.hasToken === true;
    let state = before;
    let pairingCode = '';
    if (!wasRunning) {
      const rotated = await control.rotate({ fullAccess: true });
      if (!rotated.ok) return { ok: false, error: rotated.error || '启用网页访问失败' };
      state = rotated.state || deps.remoteAccess.getState();
      pairingCode = rotated.pairingCode || '';
    } else {
      pairingCode = deps.remoteAccess.issuePairingCode({ fullAccess: true });
    }
    if (!state.running) return { ok: false, error: '网页访问服务没有启动（端口可能被占用）', startedHere: !wasRunning };
    const host = state.address || (Array.isArray(state.addresses) ? state.addresses[0] : '');
    if (!host || !state.port || !pairingCode) {
      return { ok: false, error: '拿不到可用的访问地址（请检查本机网络）', startedHere: !wasRunning };
    }
    return {
      ok: true,
      url: `http://${host}:${state.port}/?t=${encodeURIComponent(pairingCode)}&mode=desktop`,
      startedHere: !wasRunning,
    };
  }

  /** 在右下角显示卡片（已存在则只保证可见）。 */
  function showCard() {
    if (card && !card.isDestroyed()) { card.showInactive(); return; }
    const area = deps.screen.getPrimaryDisplay().workArea;
    const x = Math.round(area.x + area.width - CARD_WIDTH - CARD_MARGIN);
    const y = Math.round(area.y + area.height - CARD_HEIGHT - CARD_MARGIN);
    card = new deps.BrowserWindow({
      x, y, width: CARD_WIDTH, height: CARD_HEIGHT,
      frame: false, transparent: true, resizable: false, movable: true,
      minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: true,
      show: false,
      webPreferences: {
        preload: require('node:path').join(deps.rootDir, 'src', 'backend', 'handoff-preload.js'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false,
      },
    });
    card.setAlwaysOnTop(true, 'screen-saver');
    card.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    card.on('closed', () => { card = null; });
    card.once('ready-to-show', () => {
      if (card && !card.isDestroyed()) card.showInactive();
    });
    void card.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(cardHtml(deps.nativeTheme.shouldUseDarkColors === true)));
  }

  function closeCard() {
    if (!card) return;
    const w = card;
    card = null;
    try { if (!w.isDestroyed()) w.destroy(); } catch { /* 已销毁 */ }
  }

  function showDesktop() {
    const main = deps.getMainWindow();
    if (!main || main.isDestroyed()) return;
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  }

  /**
   * 打开默认浏览器并把操作权交出去。
   * @returns `{ ok: boolean, error?: string }`。
   */
  async function open() {
    if (active) return { ok: true };
    const main = deps.getMainWindow();
    if (!main || main.isDestroyed()) return { ok: false, error: '主窗口不可用' };
    let session;
    try {
      session = await ensureSession();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!session.ok) {
      if (session.startedHere) { try { await control.setEnabled(false); } catch { /* 回滚尽力而为 */ } }
      return { ok: false, error: session.error };
    }
    try {
      await deps.openExternal(session.url);
    } catch (e) {
      // 系统没有默认浏览器 / 打开被拒绝：不要让桌面端“消失”在一个打不开的网页后面。
      if (session.startedHere) { try { await control.setEnabled(false); } catch { /* 回滚尽力而为 */ } }
      return { ok: false, error: `打开默认浏览器失败：${e instanceof Error ? e.message : String(e)}` };
    }
    active = true;
    startedService = session.startedHere === true;
    try {
      main.hide();
      showCard();
    } catch (e) {
      active = false;
      startedService = false;
      closeCard();
      showDesktop();
      return { ok: false, error: `创建悬浮卡片失败：${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true };
  }

  /**
   * 收回到桌面：停服务（会话全部作废）→ 关卡片 → 显示主窗口。
   * @returns `{ ok: boolean }`。
   */
  async function restore() {
    if (!active && !card) {
      // 幂等：重复点击 / 卡片已销毁时仍然把主窗口叫回来，避免“点了没反应”。
      showDesktop();
      return { ok: true };
    }
    active = false;
    closeCard();
    try {
      if (startedService) {
        // 这次交接自己开的服务：连配置一起关掉，别让端口留到下次启动。
        await control.setEnabled(false);
      } else {
        // 用户原本就开着远程访问（手机）：保留配置，但 stop() 会作废**全部**会话，
        // 重启后浏览器手里的 Cookie 已经无效 —— 这就是「浏览器自动断开」。
        await deps.remoteAccess.stop();
        await deps.remoteAccess.syncWithConfig();
      }
    } catch { /* 停服失败也必须把桌面还回去 */ }
    startedService = false;
    showDesktop();
    return { ok: true };
  }

  /** 当前是否处于浏览器交接态。 */
  function state() {
    return { active };
  }

  /** 退出前收尾：关卡片即可，HTTP 服务由 main.js 的 quit 路径负责停。 */
  function dispose() {
    active = false;
    startedService = false;
    closeCard();
  }

  // ── IPC 接线 ──────────────────────────────────────────────────────────
  deps.ipcMain.handle('browser-handoff:open', deps.ipcTrust.wrap('browser-handoff:open', async () => open()));
  deps.ipcMain.handle('browser-handoff:restore', deps.ipcTrust.wrap('browser-handoff:restore', async () => restore()));
  deps.ipcMain.handle('browser-handoff:state', deps.ipcTrust.wrap('browser-handoff:state', () => state()));
  // 卡片是另一个 webContents，入口不是主窗口的 file: URL ⇒ 不能走 ipcTrust；
  // 只接受“当前卡片自己”的消息，别的窗口发来的一律忽略。
  deps.ipcMain.on('browser-handoff:restore', (event) => {
    if (!card || event.sender !== card.webContents) return;
    void restore();
  });

  return { open, restore, state, dispose };
}

module.exports = { CARD_WIDTH, CARD_HEIGHT, CARD_MARGIN, cardHtml, createBrowserHandoff };
