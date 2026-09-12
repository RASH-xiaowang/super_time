const { app, BrowserWindow, ipcMain, dialog, shell, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { applyConfig, recordResolved, loadWechatSettings, loadLlmConfig, saveLlmConfig, configPath } = require('./src/backend/wechat-paths');
const { findByBaseUrl: findModelCatalog } = require('./src/backend/llm-model-catalog');

// ── 单实例锁：同一时间只允许一个应用实例 ────────────────────────────────
// 拿到锁的实例：监听 second-instance，把已有窗口拉到前台（提示用户）。
// 没拿到锁的重复实例：立即退出（拦截），不做任何初始化 —— 避免出现
// 两个窗口/两份后端进程互相打架（2026-09-11 实测发生过 12 进程双实例）。
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  console.log('[single-instance] 已有实例在运行，本实例退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('[single-instance] 检测到重复启动，已拦截并聚焦现有窗口');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

let mainWindow = null;
let wechatBackend = null;
/** 后端进程启动时返回的 { info, methods }。 */
let wechatBoot = null;

/**
 * 把「微信+」后端放进独立进程。
 *
 * 所有 Remote 方法都是同步 node:sqlite，个别方法单次就要 12–21 秒
 * （getSnsImageDataUrl 会全量解密扫描 Sns/Img 与 msg/attach）。跑在主进程里会
 * 卡死窗口消息泵 —— 实测单次阻塞 45.6 秒，Windows 直接判定「应用未响应」。
 * 放进 utilityProcess 后主进程只转发 IPC，重活不再影响窗口响应。
 */
function createBackendProcess(userDataPath) {
  const child = utilityProcess.fork(
    path.join(__dirname, 'src', 'backend', 'wechat-worker.js'),
    [],
    { serviceName: 'super-time-wechat-backend', stdio: 'inherit' }
  );
  /** @type {Map<number, {resolve: Function, reject: Function}>} */
  const pending = new Map();
  let seq = 0;
  let deadReason = null;

  const failAll = (reason) => {
    deadReason = reason;
    for (const { reject } of pending.values()) reject(new Error(reason));
    pending.clear();
  };

  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'event') {
      broadcastWechatEvent(msg.name, msg.args);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.value);
  });
  child.on('exit', (code) => failAll(`微信+后端进程已退出 (code=${code})`));

  const request = (type, payload) => new Promise((resolve, reject) => {
    if (deadReason) {
      reject(new Error(deadReason));
      return;
    }
    seq += 1;
    pending.set(seq, { resolve, reject });
    child.postMessage({ id: seq, type, payload });
  });

  return {
    init: () => request('init', { userDataPath }),
    call: (method, args) => request('call', { method, args }),
    dispose: () => {
      try { child.postMessage({ id: ++seq, type: 'dispose', payload: {} }); } catch { /* 进程可能已退出 */ }
      try { child.kill(); } catch { /* 退出时尽力而为 */ }
    },
  };
}

/** 微信+前端构建产物（npm run build:ui 生成）；缺失时回退到演示页。 */
function uiEntryHtml() {
  const built = path.join(__dirname, 'src', 'client', 'ui-dist', 'index.html');
  if (fs.existsSync(built)) return built;
  return path.join(__dirname, 'src', 'index.html');
}

function broadcastWechatEvent(name, args) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('wechat:event', { name, args });
    } catch {
      /* 窗口可能已销毁，忽略 */
    }
  }
}

function createWindow() {
  const appIcon = path.join(__dirname, 'build', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1664,
    height: 1066,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    frame: false,
    backgroundColor: '#0f172a',
    title: 'Super Time · 微信+',
    icon: fs.existsSync(appIcon) ? appIcon : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: true
    }
  });

  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-changed', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-changed', false));

  // 调试：SUPERTIME_SKELETON=1 时加载 ?skeleton=1，Overview 强制展示骨架屏。
  const loadQuery = process.env.SUPERTIME_SKELETON === '1' ? { query: { skeleton: '1' } } : undefined;
  mainWindow.loadFile(uiEntryHtml(), loadQuery);

  // DevTools 按需开启：实测打开 DevTools 会额外拉起一个 renderer 进程并常驻
  // 约 200MB（独立窗口 + 自己的 V8 堆），因此不再默认打开。
  // 需要调试时设 SUPERTIME_DEVTOOLS=1。
  if (!app.isPackaged && process.env.SUPERTIME_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // 渲染进程日志转发（默认关闭，用 SUPERTIME_RENDERER_LOG=1 打开）。
  //
  // 之前是无条件转发，而「朋友圈」面板会为大量被 CSP 拦下的 http 图片各打一条
  // console 消息，一次访问就是成百上千行 —— 每条都要跨 IPC 到主进程再写 stdout，
  // 在 stdout 未被及时消费时会堆在 Node 的写缓冲里。这里改成按需开启，
  // 并对单条消息截断、对总量设上限。
  if (process.env.SUPERTIME_RENDERER_LOG === '1') {
    const MAX_RELAYED = 500;
    let relayed = 0;
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (relayed >= MAX_RELAYED) return;
      relayed += 1;
      if (relayed === MAX_RELAYED) {
        console.log(`[renderer] 已达转发上限 ${MAX_RELAYED} 行，后续渲染进程日志不再转发`);
      }
      console.log(`[renderer:${level}]`, String(message).slice(0, 500), `(${sourceId}:${line})`);
    });
  }
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[render-process-gone]', JSON.stringify(details));
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error('[did-fail-load]', code, desc, url);
  });

  // 事件循环阻塞诊断（SUPERTIME_ELD=1）。主进程里所有 Remote 方法都用同步的
  // node:sqlite，一旦某个查询跑得久，窗口消息泵就被卡住 —— 这正是
  // 「应用未响应」的来源。这里按 5 秒窗口统计事件循环延迟的最大值。
  if (process.env.SUPERTIME_ELD === '1') {
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

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  // 未获单实例锁的重复实例不做任何初始化（app.quit 已在上面调用）。
  if (!singleInstanceLock) return;
  ipcMain.handle('app:versions', () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch
  }));

  ipcMain.handle('app:ping', () => `pong @ ${new Date().toISOString()}`);

  ipcMain.handle('dialog:open-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择文件',
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled) return { canceled: true, files: [] };
    return { canceled: false, files: result.filePaths };
  });

  ipcMain.handle('dialog:open-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled) return { canceled: true, path: null };
    return { canceled: false, path: result.filePaths[0] ?? null };
  });

  ipcMain.handle('shell:show-item', (_event, filePath) => {
    if (typeof filePath === 'string' && filePath) {
      shell.showItemInFolder(filePath);
    }
    return true;
  });

  // —— 自绘标题栏窗口控制 ——
  ipcMain.on('window:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });
  ipcMain.on('window:maximize-toggle', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window:close', () => {
    if (mainWindow) mainWindow.close();
  });
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);

  // —— 微信+后端（迁移自 @deepseek-ai/dsh-wechat-data，独立进程运行）——
  try {
    // 先读取 wechat/config.json 里的路径配置并映射到 DSH_WECHAT_* 环境变量
    // （必须在 fork 之前，子进程直接继承 process.env）。
    applyConfig();
    wechatBackend = createBackendProcess(app.getPath('userData'));
    wechatBoot = await wechatBackend.init();
    // 启动后将实际解析到的路径记录回 wechat/config.json。
    try {
      recordResolved(wechatBoot.info);
    } catch (e) {
      console.warn('[wechat] 记录路径配置失败:', e);
    }
    // 若 wechat/config.json 中已有保存过的微信设置（密钥等），启动时回写后端。
    try {
      const savedSettings = loadWechatSettings();
      if (Object.keys(savedSettings).length > 0) {
        const r = await wechatBackend.call('saveWechatConfig', [{ patch: savedSettings }]);
        if (!r.ok || r.value?.ok === false) {
          console.warn('[wechat] 应用 wechat/config.json 设置失败:', r.error || r.value?.error);
        }
      }
    } catch (e) {
      console.warn('[wechat] 应用 wechat/config.json 设置失败:', e);
    }
    console.log('[wechat] 微信+后端已就绪，Remote 方法数:', wechatBoot.methods.length);
    console.log('[wechat] 路径配置:', configPath());
  } catch (err) {
    console.error('[wechat] 微信+后端初始化失败:', err);
  }

  ipcMain.handle('wechat:list-methods', () => {
    if (!wechatBoot) return { ok: false, error: { message: '微信+后端未初始化' } };
    return { ok: true, value: wechatBoot.methods };
  });

  ipcMain.handle('wechat:info', () => {
    if (!wechatBoot) return { ok: false, error: { message: '微信+后端未初始化' } };
    return { ok: true, value: wechatBoot.info };
  });

  ipcMain.handle('wechat:call', (_event, method, args) => {
    if (!wechatBackend) return { ok: false, error: { message: '微信+后端未初始化' } };
    return wechatBackend.call(method, args);
  });

  ipcMain.handle('wechat:dispose', () => {
    if (wechatBackend) {
      wechatBackend.dispose();
      wechatBackend = null;
      wechatBoot = null;
      return { ok: true };
    }
    return { ok: true };
  });

  // —— 微信问答模型配置（wechat/llm.json） ——
  ipcMain.handle('wechat:llm-get', () => {
    try {
      return { ok: true, value: loadLlmConfig() };
    } catch (e) {
      return { ok: false, error: { message: e.message } };
    }
  });
  ipcMain.handle('wechat:llm-save', (_event, cfg) => {
    try {
      return { ok: true, value: saveLlmConfig(cfg || {}) };
    } catch (e) {
      return { ok: false, error: { message: e.message } };
    }
  });
  // —— 通过 base_url 拉取官方模型列表（OpenAI 兼容 GET {base_url}/models）。
  //     放在主进程执行：file:// 渲染页跨域 fetch 会被 CORS 拦，Node fetch 不受限。 ——
  ipcMain.handle('wechat:llm-models', async (_event, opts = {}) => {
    const baseUrl = String(opts.baseUrl || '').trim();
    const apiKey = String(opts.apiKey || '');
    /** 把 undici 的底层错误码翻译成用户能照做的中文提示。
     *  原始错误（如 "fetch failed"/UND_ERR_CONNECT_TIMEOUT）对用户毫无信息量。 */
    const humanizeNetworkError = (e, host) => {
      const code = e?.cause?.code || e?.code || '';
      if (e?.name === 'AbortError') return `请求超时（30 秒）：${host} 无响应，请检查网络或地址`;
      if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
        return `连接 ${host} 超时：网络不通或地址有误（国内网络通常无法直连 api.openai.com，可换 DeepSeek / 通义千问等国内厂商）`;
      }
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `域名解析失败（${host}）：请检查 API 地址拼写`;
      if (code === 'ECONNREFUSED') return `连接被拒绝（${host}）：端口未开放或已被防火墙拦截`;
      if (code === 'ECONNRESET') return `连接被重置（${host}）：可能被网络中间设备中断，请重试或换厂商`;
      if (/CERT|SELF_SIGNED|TLS|SSL/i.test(String(code))) return `TLS 证书校验失败（${host}）：${code}`;
      return `${e?.message || String(e)}（${host}）`;
    };
    try {
      if (!/^https?:\/\//i.test(baseUrl)) {
        throw new Error('API 地址需以 http:// 或 https:// 开头');
      }
      let host = baseUrl;
      try { host = new URL(baseUrl).host } catch { /* 保底用原文 */ }
      const url = baseUrl.replace(/\/+$/, '') + '/models';
      /** 未填 Key 时的兜底：命中内置清单则返回清单而非报错。
       *  填了 Key 的失败不发生回退 —— 用户已有凭据，真错误更有价值。 */
      const catalogFallback = (note) => {
        if (apiKey) return null;
        const hit = findModelCatalog(baseUrl);
        if (!hit) return null;
        return { ok: true, value: { models: hit.models, source: 'catalog', vendor: hit.vendor, note } };
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      let res;
      try {
        res = await fetch(url, {
          headers: {
            accept: 'application/json',
            ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}),
          },
          signal: ctrl.signal,
        });
      } catch (e) {
        const fb = catalogFallback('当前网络无法直连该地址，已改用内置清单');
        if (fb) return fb;
        throw new Error(humanizeNetworkError(e, host));
      } finally {
        clearTimeout(timer);
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
        if (res.status === 404) {
          hint = '（该地址可能缺少 /v1 后缀，或厂商不提供 /models 接口，可手动填写模型名）';
        }
        throw new Error(`接口返回 ${res.status} ${res.statusText || ''}${body ? '：' + body : ''} ${hint}`.trim());
      }
      const data = await res.json().catch(() => null);
      const raw = Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.models) ? data.models
        : [];
      const models = [...new Set(raw
        .map((m) => (typeof m === 'string' ? m : m?.id))
        .filter((id) => typeof id === 'string' && id))];
      return { ok: true, value: { models, source: 'live' } };
    } catch (e) {
      return { ok: false, error: { message: e?.message || String(e) } };
    }
  });

  createWindow();

  // 调试用：SUPERTIME_SCREENSHOT=path 时加载完成后截图并退出；
  // SUPERTIME_THEME=light|dark 可在截图前强制主题。
  if (process.env.SUPERTIME_SCREENSHOT) {
    setTimeout(async () => {
      try {
        if (process.env.SUPERTIME_THEME === 'light' || process.env.SUPERTIME_THEME === 'dark') {
          await mainWindow.webContents.executeJavaScript(`(() => {
            const wantLight = ${JSON.stringify(process.env.SUPERTIME_THEME)} === 'light';
            const isLight = document.documentElement.classList.contains('theme-light');
            if (isLight !== wantLight) {
              const btn = document.querySelector('[data-theme-toggle]');
              btn?.click();
            }
            window.scrollTo(0, 0);
            return true;
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        if (process.env.SUPERTIME_TAB) {
          await mainWindow.webContents.executeJavaScript(`(() => {
            const label = ${JSON.stringify(process.env.SUPERTIME_TAB)};
            const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === label);
            btn?.click();
            return true;
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (process.env.SUPERTIME_MAP_DEBUG === '1') {
          const mapInfo = await mainWindow.webContents.executeJavaScript(`(() => {
            const s = Array.from(document.querySelectorAll('section')).find(x => (x.textContent || '').includes('世界板块'));
            if (!s) return { found: false };
            const cs = getComputedStyle(s);
            const p = s.parentElement;
            const pc = p ? getComputedStyle(p) : null;
            return {
              found: true,
              text: s.textContent?.slice(0, 80),
              h: s.getBoundingClientRect().height,
              display: cs.display,
              flex: cs.flex,
              minH: cs.minHeight,
              overflow: cs.overflow,
              parentClass: p?.className,
              parentH: p?.getBoundingClientRect().height,
              parentDisplay: pc?.display,
              parentOverflow: pc?.overflow,
              parentMinH: pc?.minHeight,
              bodyH: s.children[1]?.getBoundingClientRect().height,
              bodyTextH: s.children[1]?.textContent?.length,
              canvasCount: s.querySelectorAll('canvas').length,
              hasEcharts: !!s.querySelector('.map, [class*="map"]'),
            };
          })()`);
          console.log('[map debug]', JSON.stringify(mapInfo));
        }
        const scrollTarget = Number(process.env.SUPERTIME_SCROLL);
        if (process.env.SUPERTIME_SCROLL === '1' || scrollTarget > 0) {
          const info = await mainWindow.webContents.executeJavaScript(`(() => {
            const c = document.querySelector('[class*="content"]');
            const p = c?.closest('[class*="panel"]');
            const scrollables = Array.from(document.querySelectorAll('*')).filter(el => el.scrollHeight > el.clientHeight + 10);
            return {
              innerHeight: window.innerHeight,
              rootH: document.getElementById('root')?.getBoundingClientRect().height,
              panelH: p?.getBoundingClientRect().height,
              contentClientH: c?.clientHeight,
              contentScrollH: c?.scrollHeight,
              contentOverflow: c ? getComputedStyle(c).overflow : null,
              scrollables: scrollables.slice(0, 5).map(el => ({ cls: el.className, client: el.clientHeight, scroll: el.scrollHeight })),
            };
          })()`);
          console.log('[scroll debug]', JSON.stringify(info));
          await mainWindow.webContents.executeJavaScript(`(() => {
            const candidates = Array.from(document.querySelectorAll('*')).filter(el => el.scrollHeight > el.clientHeight + 10);
            const target = candidates.slice().sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || candidates[candidates.length - 1];
            if (target) target.scrollTop = ${scrollTarget || 520};
            return candidates.length;
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(process.env.SUPERTIME_SCREENSHOT, image.toPNG());
        console.log('[screenshot] saved', process.env.SUPERTIME_SCREENSHOT);
      } catch (e) {
        console.error('[screenshot] failed', e);
      }
      app.quit();
    }, 9000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (wechatBackend) {
    try {
      wechatBackend.dispose();
    } catch {
      /* 退出时尽力释放 */
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});