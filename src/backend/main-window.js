/**
 * 主窗口与 webContents 安全守卫（P0-4 自 `main.js` 外提，M21 的 1000 行闸门当时只剩 1 行余量）。
 *
 * **原样搬出**：行为逐字未改，只是把原先靠模块作用域拿到的东西改成从 `ctx` 传进来
 * （与 `ipc-misc.js` / `ipc-wechat.js` 同一套路）。运行期会变的量走 getter，不传快照。
 *
 * 为什么值得单独成模块：这里有两类东西一直长在一起 ——
 * 「窗口怎么开」（尺寸基准、图标、骨架屏参数）与「窗口能干什么」
 * （导航 / 开窗 / iframe / webview 四道默认拒绝的守卫，以及渲染进程日志转发与
 * 事件循环阻塞诊断的开关）。混在 `main.js` 里时，任何一侧的改动都在挤同一份行数预算。
 */

/** 应用入口 HTML：优先 vite 产物，缺失时回退到演示页。 */
function uiEntryHtml(ctx) {
  const built = ctx.path.join(ctx.rootDir, 'src', 'client', 'ui-dist', 'index.html');
  if (ctx.fs.existsSync(built)) return built;
  return ctx.path.join(ctx.rootDir, 'src', 'index.html');
}

/** 渲染进程崩溃后的自动恢复策略：只处理可恢复原因，并限制单个窗口的重载次数。 */
const RECOVERABLE_RENDER_GONE_REASONS = new Set(['oom', 'crashed']);
const RENDER_RECOVERY_DELAY_MS = 1500;
const MAX_RENDER_RECOVERIES = 2;

/**
 * 判断主窗口当前是否还能安全接收 IPC。
 *
 * `webContents.isDestroyed()` 不足以覆盖「窗口还在、渲染帧已经销毁」的 OOM 现场；
 * 此时直接 send 会由 Electron 反复打印 `Render frame was disposed ...`。主帧的
 * `isDestroyed()` 才是真正的发送边界。访问 mainFrame 本身也可能抛错，所以同样兜住。
 */
function canSendToWindow(win) {
  if (!win || win.isDestroyed()) return false;
  const contents = win.webContents;
  if (!contents) return false;
  try {
    if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return false;
    if (typeof contents.isCrashed === 'function' && contents.isCrashed()) return false;
    const frame = contents.mainFrame;
    if (!frame) return false;
    if (typeof frame.isDestroyed === 'function' && frame.isDestroyed()) return false;
    return true;
  } catch {
    // mainFrame getter 在帧销毁竞态里会抛错，这正是需要静默丢弃事件的时刻。
    return false;
  }
}

/**
 * 向可信主窗口发送一个通道（`wechat:event` / `update:event` 共用）。
 *
 * 主进程是唯一的事实来源，渲染层只是投影；进度类事件在 `update.js` 里已按 1% 阶梯节流，
 * 这里不再二次过滤。
 */
function broadcastToWindows(ctx, channel, payload) {
  const win = ctx.getMainWindow();
  if (!canSendToWindow(win)) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    /* 窗口可能刚销毁，忽略 */
  }
}

/**
 * 为一次 renderer 崩溃安排延迟 reload。
 *
 * OOM 后立刻 reload 往往会在资源尚未回收时再次撞上同一峰值；固定延迟给 Chromium
 * 留出回收窗口。计时器同时充当防重入门闩：崩溃事件在延迟期内重复到达不会叠加任务。
 * 次数按窗口生命周期封顶，避免坏页面形成 reload/crash 无限循环。
 */
function installRendererRecovery(win, contents) {
  let recoveryTimer = null;
  let recoveryAttempts = 0;
  let disposed = false;

  const clearRecoveryTimer = () => {
    if (recoveryTimer === null) return;
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  };

  const scheduleReload = (details) => {
    const reason = details && details.reason;
    if (!RECOVERABLE_RENDER_GONE_REASONS.has(reason)) return;
    if (recoveryTimer !== null) return;
    if (win.isDestroyed() || contents.isDestroyed()) return;
    if (recoveryAttempts >= MAX_RENDER_RECOVERIES) {
      console.error(`[renderer-recovery] ${reason}: 已达到 ${MAX_RENDER_RECOVERIES} 次自动恢复上限，停止 reload`);
      return;
    }

    recoveryAttempts += 1;
    const attempt = recoveryAttempts;
    console.error(
      `[renderer-recovery] ${reason}: ${RENDER_RECOVERY_DELAY_MS}ms 后执行第 ${attempt}/${MAX_RENDER_RECOVERIES} 次 reload`
    );
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (win.isDestroyed() || contents.isDestroyed()) return;
      try {
        contents.reload();
        console.warn(`[renderer-recovery] 第 ${attempt}/${MAX_RENDER_RECOVERIES} 次 reload 已触发`);
      } catch (error) {
        console.error('[renderer-recovery] reload 失败：' + String(error && error.message ? error.message : error));
      }
    }, RENDER_RECOVERY_DELAY_MS);
    if (typeof recoveryTimer.unref === 'function') recoveryTimer.unref();
  };

  const onRenderProcessGone = (_event, details) => {
    console.error('[render-process-gone]', JSON.stringify(details));
    scheduleReload(details);
  };
  contents.on('render-process-gone', onRenderProcessGone);

  // closed 与 destroyed 都要监听：不同关闭路径上的触发顺序并不固定。清理时同时
  // 移除监听器，避免窗口对象或已经销毁的 webContents 继续保留崩溃恢复闭包。
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearRecoveryTimer();
    contents.removeListener('render-process-gone', onRenderProcessGone);
    win.removeListener('closed', dispose);
    contents.removeListener('destroyed', dispose);
  };
  win.once('closed', dispose);
  contents.once('destroyed', dispose);
  return dispose;
}

/**
 * 安装可选的事件循环延迟诊断，并返回幂等清理函数。
 *
 * `unref()` 只保证计时器不单独撑住进程，不会在窗口关闭时解绑消息泵；窗口重建后
 * 每套 interval/histogram 都会继续存活。诊断必须跟窗口生命周期绑定。
 */
function installEventLoopDiagnostics(win, contents, env) {
  if (!env || env.SUPERTIME_ELD !== '1') return () => {};
  const { monitorEventLoopDelay } = require('node:perf_hooks');
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    const max = histogram.max / 1e6;
    const p99 = histogram.percentile(99) / 1e6;
    if (max > 200) {
      console.log(`[eld] 主进程事件循环阻塞 ${max.toFixed(0)}ms (p99=${p99.toFixed(0)}ms) @ ${new Date().toISOString()}`);
    }
    histogram.reset();
  }, 5000);
  if (typeof timer.unref === 'function') timer.unref();

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    try {
      histogram.disable();
    } catch {
      // 已经关闭或运行时正在销毁，清理失败不影响窗口退出。
    }
    win.removeListener('closed', dispose);
    contents.removeListener('destroyed', dispose);
  };
  win.once('closed', dispose);
  contents.once('destroyed', dispose);
  return dispose;
}

/**
 * 开主窗口。**返回**窗口对象，`mainWindow` 这个模块状态仍由 `main.js` 持有 ——
 * 单实例锁的「二次启动只唤起已有窗口」那段要在外层读到它。
 * @param {object} ctx - 见文件头；需要 `app` / `BrowserWindow` / `screen` / `fs` / `path` / `rootDir` / `env`。
 *   可选 `entryHtml`：由 main.js 预先解析好的入口，IPC 信任 URL 必须和它同源同值。
 * @returns {Electron.BrowserWindow} 建好的窗口（尚未 show，等 `ready-to-show`）。
 */
function createMainWindow(ctx) {
  const { app, BrowserWindow, screen, fs, path, rootDir, env } = ctx;
  const entryHtml = ctx.entryHtml || uiEntryHtml(ctx);
  /**
   * 窗口图标。**打包态这个路径不存在**（`build/` 是 electron-builder 的 buildResources，
   * 不在 `files` 白名单里），于是 `icon` 为 undefined，Windows 会退回用 exe 内嵌的图标 ——
   * 而那个图标就是同一份 `build/icon.ico`（`win.icon` 会在打包时烘进 exe；实测取出两者
   * 的 32×32 帧是同一张图）。即 dev 与打包态的窗口/任务栏图标一致，**不存在「打包版没图标」**。
   *
   * 所以别把 `build/` 加进 `files`：那会白带一份 83KB，并把图标改成走
   * `nativeImage.createFromPath` 读 asar 内的 .ico（打包态未验证的路径），收益为零。
   * 相关取证见 docs/RELEASE-PLAN.md 的 M19。
   */
  const appIcon = path.join(rootDir, 'build', 'icon.ico');
  // 启动尺寸取固定基准 1440×900，再按主屏工作区收敛：写死一个较大的尺寸时
  // （历史上是 1664×1066），1366×768 或 1080p@125% 的机器上窗口会比屏幕还大
  // （审计 P0-2）。窗口本身始终可缩放，下限取实测能容下
  // 「会话列表 + 消息区 + 群聊信息抽屉」三列的值。
  const MIN_W = 960;
  const MIN_H = 640;
  const BASE_W = 1440;
  const BASE_H = 900;
  const work = screen.getPrimaryDisplay().workAreaSize;
  const initialWidth = Math.max(MIN_W, Math.min(BASE_W, work.width));
  const initialHeight = Math.max(MIN_H, Math.min(BASE_H, work.height));
  const win = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: MIN_W,
    minHeight: MIN_H,
    useContentSize: true,
    resizable: true,
    // 标题栏是自绘的（frame:false），铺满屏幕由自绘「全屏」按钮显式
    // setBounds(当前显示器工作区) 完成（见 ipc-misc.js 的 window:fullscreen-toggle）。
    // 这里**关掉系统最大化**：无边框窗口 maximize() 的 bounds 会溢出 8px
    // （实测 2560×1440 屏上变成 -8,-8,2576,1416），右/下越界 8px 反而压住任务栏 ——
    // 用户 2026-10-18 报的「全屏挡住任务栏」正是这一类。铺满只由自绘按钮触发。
    maximizable: false,
    fullscreenable: true,
    show: false,
    frame: false,
    backgroundColor: '#0f172a',
    title: 'Super Time',
    icon: fs.existsSync(appIcon) ? appIcon : undefined,
    webPreferences: {
      preload: path.join(rootDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true —— 渲染进程只经 preload 暴露的 contextBridge 说话，
      // 而 preload.js 只 require('electron')（沙箱下允许），因此可以直接开。
      // 开着的意义：渲染进程即使是 XSS 也在 OS 级沙箱里，拿不到 Node 原语。
      // 回归由 scripts/packaged-smoke.js 兜（它会真的启动打包产物断言后端就绪+出图）。
      sandbox: true,
      // 发行包不提供 DevTools 入口。打包态的远程调试开关还会被 main.js 剥掉；
      // 两处一起收紧，避免“能改快捷方式就能挂 CDP”。
      devTools: !app.isPackaged,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      backgroundThrottling: true
    }
  });

  // 全屏状态也要回传：标题栏那个按钮的图标要跟着切换（进入/退出全屏图标不同）。
  // 2026-10-18：按钮改走「铺满工作区」，状态由 ipc-misc.js 主动发 window:fullscreen-changed；
  // 这两条只兜 OS 级全屏（例如页面内视频 requestFullscreen）引起的窗口状态变化。
  win.on('enter-full-screen', () => win?.webContents.send('window:fullscreen-changed', true));
  win.on('leave-full-screen', () => win?.webContents.send('window:fullscreen-changed', false));

  // 调试：SUPERTIME_SKELETON=1 时加载 ?skeleton=1，Overview 强制展示骨架屏。
  const loadQuery = env.SUPERTIME_SKELETON === '1' ? { query: { skeleton: '1' } } : undefined;
  win.loadFile(entryHtml, loadQuery);

  // DevTools 按需开启：实测打开 DevTools 会额外拉起一个 renderer 进程并常驻
  // 约 200MB（独立窗口 + 自己的 V8 堆），因此不再默认打开。
  // 需要调试时设 SUPERTIME_DEVTOOLS=1。
  if (!app.isPackaged && env.SUPERTIME_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  // 渲染进程日志转发（默认关闭，用 SUPERTIME_RENDERER_LOG=1 打开）。
  //
  // 之前是无条件转发，而「朋友圈」面板会为大量被 CSP 拦下的 http 图片各打一条
  // console 消息，一次访问就是成百上千行 —— 每条都要跨 IPC 到主进程再写 stdout，
  // 在 stdout 未被及时消费时会堆在 Node 的写缓冲里。这里改成按需开启，
  // 并对单条消息截断、对总量设上限。
  if (env.SUPERTIME_RENDERER_LOG === '1') {
    const MAX_RELAYED = 500;
    let relayed = 0;
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (relayed >= MAX_RELAYED) return;
      relayed += 1;
      if (relayed === MAX_RELAYED) {
        console.log(`[renderer] 已达转发上限 ${MAX_RELAYED} 行，后续渲染进程日志不再转发`);
      }
      console.log(`[renderer:${level}]`, String(message).slice(0, 500), `(${sourceId}:${line})`);
    });
  }
  installRendererRecovery(win, win.webContents);
  installEventLoopDiagnostics(win, win.webContents, env);
  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error('[did-fail-load]', code, desc, url);
  });

  win.once('ready-to-show', () => {
    win.show();
  });
  return win;
}

/**
 * 给每个 webContents 装导航 / 开窗守卫。
 *
 * 渲染的是**聊天与朋友圈内容**，即不可信输入 —— 所以这里默认拒绝：
 *   · 新窗口一律不开（`action:'deny'`），只有 http(s) 才交给系统浏览器
 *     （`file:` 能直接拉起本地可执行文件，`smb:`/UNC 会带着凭据外连）；
 *   · 页面导航只允许应用自己的 `file:` 页面（本应用是单页，正常不会导航）；
 *   · 不允许挂 `<webview>`（本应用不用它）。
 * 用 `app.on('web-contents-created')` 统一安装，而不是只在主窗口上挂一遍 ——
 * 否则将来任何新建的 webContents（预览窗、开发者工具）都绕过了守卫。
 * 判定逻辑在 `src/backend/navigation-policy.js`，有单测覆盖（含默认拒绝）。
 *
 * `counters` 是**共享的可变对象**：`security-guard-smoke.js` 要通过探针通道读到
 * 「有没有真把 URL 交给系统浏览器」「有没有真开出过窗口」，那两条判据是
 * 「能区分『坏了』和『没坏』的观测量」，不是返回值。
 * @param {Electron.WebContents} contents - 新建的 webContents。
 * @param {object} ctx - 需要 `shell` / `path` / `rootDir` / `decideNavigation` / `decideWindowOpen` / `counters`。
 */
function installWebContentsGuards(contents, ctx) {
  const { shell, decideNavigation, decideWindowOpen, counters, rootDir } = ctx;
  contents.setWindowOpenHandler(({ url }) => {
    if (decideWindowOpen(url) === 'external') {
      counters.openExternalAttempts += 1;
      // 系统没有对应处理程序时 openExternal 会 reject —— 不接住就是未处理拒绝。
      shell.openExternal(url).catch((e) => {
        console.warn('[security] 交给系统打开失败：' + String(e && e.message ? e.message : e));
      });
    } else {
      console.warn('[security] 已拒绝打开外部链接：' + String(url));
    }
    return { action: 'deny' };
  });
  // 判定「有没有真开出窗口」的唯一可靠依据：`did-create-window` 只在窗口真的建出来时触发。
  contents.on('did-create-window', () => { counters.popupWindowsCreated += 1; });
  contents.on('will-navigate', (event, url) => {
    if (decideNavigation(url, rootDir) === 'allow') return;
    event.preventDefault();
    console.warn('[security] 已阻止页面导航：' + String(url));
  });
  // will-redirect 是**独立事件**：主框架的 HTTP 重定向只走它（实测 will-navigate 拦下
  // 第一步后它就不会触发，所以当前只是「单点依赖」—— 一旦 decideNavigation 放宽，
  // 重定向立刻成为绕过路径）。判定函数是现成的，这里补上零成本。
  contents.on('will-redirect', (event, url) => {
    if (decideNavigation(url, rootDir) === 'allow') return;
    event.preventDefault();
    console.warn('[security] 已阻止重定向：' + String(url));
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    console.warn('[security] 已阻止挂载 webview');
  });
  // will-frame-navigate 与 will-navigate 不是一对：它还覆盖**子框架**的导航。
  // 本应用不渲染任何 iframe（源码里 0 处 <iframe>），所以这条正常永远不该放行；
  // 但一旦有人将来加了 iframe，缺了这条守卫就等于给「子框架里加载任意外部页」开门。
  contents.on('will-frame-navigate', (event, details) => {
    const url = typeof details === 'string' ? details : (details && details.url);
    if (typeof url === 'string' && decideNavigation(url, rootDir) === 'allow') return;
    event.preventDefault();
    console.warn('[security] 已阻止框架导航：' + String(url));
  });
}

module.exports = { uiEntryHtml, broadcastToWindows, createMainWindow, installWebContentsGuards };
