/**
 * 主进程 IPC：微信数据后端（M21 第二十一刀自 main.js 的 whenReady 回调里拆出）。
 *
 * 10 个频道：`wechat:list-methods` / `wechat:info` / `wechat:call` / `wechat:backend-state` /
 * `wechat:llm-get` / `wechat:llm-save` / `wechat:llm-profiles` / `wechat:llm-models` /
 * `wechat:llm-test` / `wechat:llm-balance`。
 * 后两个（2026-09-30 加）是「连接测试 / 余额查询」：地址推导与解析在 `llm-balance.js`
 * （纯函数、可单测），本文件只做 IPC 包装 —— 与 `llm-models` 同一条接缝，
 * 渲染页跨域会被 CORS 拦，主进程的 Node fetch 不受限。
 *
 * **原样搬出**：注册时机与闭包语义不变，只是把原来靠模块作用域拿到的东西改成从 `ctx` 传进来。
 * 三个**运行期会变**的量走 getter 而不是快照 —— `wechatBackend`（后端会重启）、`wechatBoot`
 * （启动 Promise）、`backendStatus`（状态机会推进）：读快照会拿到过期的对象/状态。
 * @param {object} ctx - 由 main.js 组装：ipcMain / app / licenseService / debugGates /
 *   awaitBackendReady / findModelCatalog / APP_VERSION / getWechatBackend / getWechatBoot / getBackendStatus /
 *   BACKEND_CALL_READY_WAIT_MS / scheduleWechatCall / getCallQueueStats / loadLlmConfig /
 *   saveLlmConfig / loadLlmStore / upsertLlmProfile / activateLlmProfile / deleteLlmProfile
 *   （后几个原来直接靠模块作用域，靠标识符审计才抓出来）。
 */
const { humanizeNetworkError, testLlmEndpoint, queryLlmBalance } = require('./llm-balance.js');
const { parseLlmBaseUrl, llmRequest } = require('./llm-http.js');
// 「一次后端调用要过哪几道闸」的唯一出处：HTTP 那条路（局域网远程访问）也调它，
// 两边不许各写一份 —— 最可能的漂法是少抄那个 catch，于是许可校验一抛异常就变成放行。
const { gatedWechatCall } = require('./call-gates.js');

function registerWechatIpc(ctx) {
  // 闸门相关的那几个字段（app / licenseService / debugGates / awaitBackendReady /
  // getWechatBackend / BACKEND_CALL_READY_WAIT_MS / APP_VERSION）**刻意不在这里解构**：
  // `wechat:call` 已经把整个 ctx 交给 `gatedWechatCall`，那份实现是 IPC 与 HTTP
  // （局域网远程访问）两条路共用的唯一出处（见 call-gates.js）。
  // 在这儿再解构一遍只会多出一份「看起来还在用、其实已经搬走」的绑定。
  const { ipcMain, ipcTrust, findModelCatalog, getWechatBoot, getBackendStatus,
    scheduleWechatCall, getCallQueueStats, getRpcStats,
    loadLlmConfig, saveLlmConfig, loadLlmStore, upsertLlmProfile, activateLlmProfile, deleteLlmProfile } = ctx;
  const handleIpc = (channel, handler) => ipcMain.handle(channel, ipcTrust.wrap(channel, handler));

  handleIpc('wechat:list-methods', () => {
    if (!getWechatBoot()) return { ok: false, error: { message: 'Super Time 后端未初始化' } };
    return { ok: true, value: getWechatBoot().methods };
  });

  handleIpc('wechat:info', () => {
    if (!getWechatBoot()) return { ok: false, error: { message: 'Super Time 后端未初始化' } };
    return { ok: true, value: getWechatBoot().info };
  });

  // 桌面与手机共用同一个单线程 worker，所以这里也进同一把调用闸。测试 ctx 不传
  // scheduleWechatCall 时退回直接调用，保持各 IPC 判据的轻量夹具可用。
  const scheduleCall = scheduleWechatCall || ((task) => task());
  handleIpc('wechat:call', (_event, method, args) => scheduleCall(
    () => gatedWechatCall(ctx, method, args),
    { channel: 'desktop', method: String(method ?? '') },
  ));


  /**
   * 后端状态快照。
   *
   * 之所以要有主动查询：渲染端订阅事件是在模块加载时注册的，而首启期间
   * 后端可能先于订阅就报出 down/ready/failed —— 那些事件会丢失。
   * 界面挂载后用这个接口补一次状态，才能保证「该提示的一定提示到」。
   */
  handleIpc('wechat:backend-state', () => ({
    ok: true,
    value: {
      ...getBackendStatus(),
      callQueue: typeof getCallQueueStats === 'function' ? getCallQueueStats() : undefined,
      rpc: typeof getRpcStats === 'function' ? getRpcStats() : undefined,
    },
  }));

  // —— 微信问答模型配置（wechat/llm.json） ——
  handleIpc('wechat:llm-get', () => {
    try {
      return { ok: true, value: loadLlmConfig() };
    } catch (e) {
      return { ok: false, error: { message: e.message } };
    }
  });
  handleIpc('wechat:llm-save', (_event, cfg) => {
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
  handleIpc('wechat:llm-profiles', (_event, opts = {}) => {
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
  handleIpc('wechat:llm-models', async (_event, opts = {}) => {
    const baseUrl = String(opts.baseUrl || '').trim();
    const apiKey = String(opts.apiKey || '');
    try {
      const parsed = parseLlmBaseUrl(baseUrl);
      const host = parsed.host;
      const url = parsed.base + '/models';
      /** 未填 Key 时的兜底：命中内置清单则返回清单而非报错。
       *  填了 Key 的失败不发生回退 —— 用户已有凭据，真错误更有价值。 */
      const catalogFallback = (note) => {
        if (apiKey) return null;
        const hit = findModelCatalog(parsed.base);
        if (!hit) return null;
        return { ok: true, value: { models: hit.models, source: 'catalog', vendor: hit.vendor, note } };
      };
      /**
       * 出网拦截已于 2026-09-30 随开关一起移除：这个频道照常请求模型列表。
       * 它仍会带上用户填的 API Key（`Authorization: Bearer`），destination 也是用户自己配的地址。
       */
      let res;
      try {
        res = await llmRequest(url, {
          apiKey,
          timeoutMs: 30_000,
          maxAttempts: 1,
        });
      } catch (e) {
        const fb = catalogFallback('当前网络无法直连该地址，已改用内置清单');
        if (fb) return fb;
        throw new Error(humanizeNetworkError(e, host));
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
  // —— 连接测试（2026-09-30）：按端点类型各测各的 —— `kind: 'chat' | 'embed' | 'rerank'`。
  //     主模型 / 向量 / 精排是三套地址·Key·路径，只测 /models 覆盖不到后两者（实测就有
  //     「主模型 DeepSeek、向量与精排指向 SiliconFlow」这种组合）。 ——
  handleIpc('wechat:llm-test', async (_event, opts = {}) => {
    try {
      const probe = {
        baseUrl: String(opts.baseUrl || '').trim(),
        apiKey: String(opts.apiKey || ''),
        kind: opts.kind,
        model: opts.model,
      };
      // 端点路径用**赋值**而不是对象字面量键：`path` 同时是宿主 ctx 的字段名，
      // 写成字面量键会被 `ipc-ctx-wiring.spec.ts` 的「不许裸用 ctx 名字」判据当成裸标识符
      // （那条判据按标识符扫，分不清对象键与变量）。契约本身仍是 `path`。
      if (opts.path) probe.path = opts.path;
      return { ok: true, value: await testLlmEndpoint(probe) };
    } catch (e) {
      return { ok: false, error: { message: e?.message || String(e) } };
    }
  });
  // —— 余额查询（2026-09-30）：按厂商惯例探 `/user/balance`（DeepSeek）或 `/user/info`。
  //     主界面左下角会按 5 分钟定时刷新它（新出网点，已写进 docs/PRIVACY.md 与同意屏）。 ——
  handleIpc('wechat:llm-balance', async (_event, opts = {}) => {
    try {
      return { ok: true, value: await queryLlmBalance(String(opts.baseUrl || '').trim(), String(opts.apiKey || '')) };
    } catch (e) {
      return { ok: false, error: { message: e?.message || String(e) } };
    }
  });
}

module.exports = { registerWechatIpc };
