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

/**
 * 向所有窗口广播一个通道（`wechat:event` / `update:event` 共用）。
 *
 * 主进程是唯一的事实来源，渲染层只是投影；进度类事件在 `update.js` 里已按 1% 阶梯节流，
 * 这里不再二次过滤。
 */
function broadcastToWindows(ctx, channel, payload) {
  for (const win of ctx.BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(channel, payload);
    } catch {
      /* 窗口可能已销毁，忽略 */
    }
  }
}

/**
 * 开主窗口。**返回**窗口对象，`mainWindow` 这个模块状态仍由 `main.js` 持有 ——
 * 单实例锁的「二次启动只唤起已有窗口」那段要在外层读到它。
 * @param {object} ctx - 见文件头；需要 `app` / `BrowserWindow` / `screen` / `fs` / `path` / `rootDir` / `env`。
 * @returns {Electron.BrowserWindow} 建好的窗口（尚未 show，等 `ready-to-show`）。
 */
function createMainWindow(ctx) {
  const { app, BrowserWindow, screen, fs, path, rootDir, env } = ctx;
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
    // 标题栏是自绘的（frame:false），最大化/全屏都由自绘按钮触发，所以这里要放开，
    // 否则那两个按钮点了没反应。
    maximizable: true,
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
      spellcheck: false,
      backgroundThrottling: true
    }
  });

  // 全屏状态也要回传：标题栏那个按钮的图标要跟着切换（进入/退出全屏图标不同）
  win.on('enter-full-screen', () => win?.webContents.send('window:fullscreen-changed', true));
  win.on('leave-full-screen', () => win?.webContents.send('window:fullscreen-changed', false));

  // 调试：SUPERTIME_SKELETON=1 时加载 ?skeleton=1，Overview 强制展示骨架屏。
  const loadQuery = env.SUPERTIME_SKELETON === '1' ? { query: { skeleton: '1' } } : undefined;
  win.loadFile(uiEntryHtml(ctx), loadQuery);

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
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[render-process-gone]', JSON.stringify(details));
  });
  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error('[did-fail-load]', code, desc, url);
  });

  // 事件循环阻塞诊断（SUPERTIME_ELD=1）。主进程里所有 Remote 方法都用同步的
  // node:sqlite，一旦某个查询跑得久，窗口消息泵就被卡住 —— 这正是
  // 「应用未响应」的来源。这里按 5 秒窗口统计事件循环延迟的最大值。
  if (env.SUPERTIME_ELD === '1') {
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
    if (timer.unref) timer.unref();
  }

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
