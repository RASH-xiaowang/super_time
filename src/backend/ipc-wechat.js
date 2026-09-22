/**
 * 主进程 IPC：微信数据后端（M21 第二十一刀自 main.js 的 whenReady 回调里拆出）。
 *
 * 8 个频道：`wechat:list-methods` / `wechat:info` / `wechat:call` / `wechat:backend-state` /
 * `wechat:llm-get` / `wechat:llm-save` / `wechat:llm-profiles` / `wechat:llm-models`。
 *
 * **原样搬出**：注册时机与闭包语义不变，只是把原来靠模块作用域拿到的东西改成从 `ctx` 传进来。
 * 三个**运行期会变**的量走 getter 而不是快照 —— `wechatBackend`（后端会重启）、`wechatBoot`
 * （启动 Promise）、`backendStatus`（状态机会推进）：读快照会拿到过期的对象/状态。
 * @param {object} ctx - 由 main.js 组装：ipcMain / app / licenseService / debugGates /
 *   awaitBackendReady / findModelCatalog / APP_VERSION / getWechatBackend / getWechatBoot / getBackendStatus /
 *   BACKEND_CALL_READY_WAIT_MS / loadLlmConfig / saveLlmConfig / loadLlmStore / upsertLlmProfile /
 *   activateLlmProfile / deleteLlmProfile（后几个原来直接靠模块作用域，靠标识符审计才抓出来）。
 */
function registerWechatIpc(ctx) {
  const { ipcMain, app, licenseService, debugGates, awaitBackendReady, findModelCatalog, APP_VERSION,
    getWechatBackend, getWechatBoot, getBackendStatus,
    BACKEND_CALL_READY_WAIT_MS, loadLlmConfig, saveLlmConfig, loadLlmStore, upsertLlmProfile, activateLlmProfile, deleteLlmProfile } = ctx;
  ipcMain.handle('wechat:list-methods', () => {
    if (!getWechatBoot()) return { ok: false, error: { message: 'Super Time 后端未初始化' } };
    return { ok: true, value: getWechatBoot().methods };
  });

  ipcMain.handle('wechat:info', () => {
    if (!getWechatBoot()) return { ok: false, error: { message: 'Super Time 后端未初始化' } };
    return { ok: true, value: getWechatBoot().info };
  });

  ipcMain.handle('wechat:call', async (_event, method, args) => {
    // 后端还在启动/重启时**等待**，而不是立刻回一句假错误（见 awaitBackendReady）。
    const ready = await awaitBackendReady(BACKEND_CALL_READY_WAIT_MS);
    if (!ready || !getWechatBackend()) {
      return {
        ok: false,
        error: {
          message: getBackendStatus().lastError
            ? `Super Time 后端暂不可用：${getBackendStatus().lastError}`
            : 'Super Time 后端仍在启动中，请稍候重试',
          code: 'BACKEND_NOT_READY',
          details: { method, state: getBackendStatus().state },
        },
      };
    }
    // N2：调试闸门豁免。放开的是「授权」这道闸门 —— 验收脚本要用真实后端跑 UI 全链路，
    // 而它拿不到厂商签发的许可证。条件来自主进程的 `debugGates()`（打包态恒不成立）、
    // **不**接受渲染层传来的任何参数，且必须放在下面的 `authorizeCall` 之前。
    // 放在 `try` 之外是刻意的：`getWechatBackend().call` 同步抛错时不该被误报成「许可校验失败」。
    if (debugGates().skipGates) {
      console.warn('[debug-gates] 已跳过许可证校验（method=%s）', method);
      return getWechatBackend().call(method, args);
    }
    try {
      const lic = licenseService.getLicenseStatus(app.getPath('userData'), APP_VERSION);
      const gate = licenseService.authorizeCall(lic, method);
      if (!gate.ok) {
        return {
          ok: false,
          error: {
            message: gate.message,
            code: gate.code,
            details: { licenseState: lic.state, method, feature: licenseService.METHOD_FEATURE[method] || 'wechat-data' },
          },
        };
      }
    } catch (e) {
      // 授权检查**自身**失败时必须拒绝，而不是放行。
      // 许可 JSON 损坏、readLicenseFile 读盘失败、指纹采集异常等都会落到这里；
      // 原实现只 warn 一句就继续调用后端，等于「许可闸门一旦出异常就完全失效」。
      console.error('[license] 授权校验异常，已拒绝本次调用:', e?.message ?? e);
      return {
        ok: false,
        error: {
          message: `许可校验失败，已拒绝本次调用：${e?.message ?? String(e)}`,
          code: 'LICENSE_CHECK_FAILED',
          details: { method },
        },
      };
    }
    return getWechatBackend().call(method, args);
  });


  /**
   * 后端状态快照。
   *
   * 之所以要有主动查询：渲染端订阅事件是在模块加载时注册的，而首启期间
   * 后端可能先于订阅就报出 down/ready/failed —— 那些事件会丢失。
   * 界面挂载后用这个接口补一次状态，才能保证「该提示的一定提示到」。
   */
  ipcMain.handle('wechat:backend-state', () => ({ ok: true, value: { ...getBackendStatus() } }));

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
  /**
   * 已保存的模型配置集（profiles）。
   *
   * 为什么与 `wechat:llm-save` 分成两条通道：切换是**一次轻动作**（改 activeProfileId +
   * 把该套字段摊平到顶层，一个原子写），而 llm-save 走的是「提交整个表单」。
   * 混在一起会逼着界面为了「换个模型」先构造一份完整表单 —— 那正是「切换要点两次、
   * 还容易把别家 Key 一起提交」的老毛病。
   *
   * op：list / activate / save / delete（未识别的 op 明确报错，不静默当 list）。
   */
  ipcMain.handle('wechat:llm-profiles', (_event, opts = {}) => {
    try {
      const op = String((opts && opts.op) || 'list');
      if (op === 'list') return { ok: true, value: loadLlmStore() };
      if (op === 'activate') return { ok: true, value: activateLlmProfile(String((opts && opts.id) || '')) };
      if (op === 'save') return { ok: true, value: upsertLlmProfile(opts || {}) };
      if (op === 'delete') return { ok: true, value: deleteLlmProfile(String((opts && opts.id) || '')) };
      return { ok: false, error: { message: `未知的模型配置操作：${op}` } };
    } catch (e) {
      return { ok: false, error: { message: e && e.message ? e.message : String(e) } };
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
}

module.exports = { registerWechatIpc };
