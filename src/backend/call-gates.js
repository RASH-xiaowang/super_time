/**
 * 「一次微信后端调用要过哪几道闸」的**唯一出处**。
 *
 * ## 为什么要抽出来
 *
 * 这段序列原先只住在 `ipc-wechat.js` 的 `wechat:call` 处理器里。加入局域网远程访问
 * （手机端）之后，HTTP 那条路也要过**完全相同**的闸 —— 而后端就绪等待、许可证校验、
 * 「闸门自身出异常时怎么办」这三件事，一旦两边各写一份，就一定会漂：
 * 最可能的漂法是 HTTP 那份少抄了 `catch` 分支，于是**许可校验一抛异常就变成放行**
 * （桌面端在 2026-09 修过这个洞，注释还留在原处）。
 *
 * 所以现在两边都调这里。`ipc-wechat.js` 的处理器与 `http-server.js` 的
 * `POST /api/wechat/call` 都只是「把信封原样回给各自的传输层」，闸门逻辑一行都不重复。
 *
 * ## 三道闸的顺序是刻意的
 *
 *   ① **后端就绪等待**（不是立刻报错）：后端启动被排在建窗之后，窗口一挂载就可能发请求。
 *      立刻回「后端未初始化」会让首屏显示一句**假的**错误，而渲染层分不清「还没好」与「坏了」。
 *   ② **调试闸门豁免**：放开的是「授权」这一道，条件来自主进程的 `debugGates()`
 *      （打包态恒不成立），**不接受调用方传来的任何参数**。必须排在 ③ 之前。
 *   ③ **许可证授权**：`getLicenseStatus` + `authorizeCall`。**校验自身抛异常时拒绝而不是放行**
 *      —— 许可 JSON 损坏、读盘失败、指纹采集异常都会落到那个 `catch`。
 *
 * @module backend/call-gates
 */

/**
 * @typedef {object} CallGateCtx
 * @property {(timeoutMs: number) => Promise<boolean>} awaitBackendReady - 等后端就绪。
 * @property {number} BACKEND_CALL_READY_WAIT_MS - 就绪等待上限。
 * @property {() => ({ call: (method: string, args: unknown[]) => unknown } | null)} getWechatBackend - 后端句柄（会随后端重启而变，故用 getter）。
 * @property {() => ({ state: string, lastError?: string | null })} getBackendStatus - 状态机快照（同样用 getter）。
 * @property {() => { skipGates?: boolean }} debugGates - 调试闸门（主进程判定）。
 * @property {{ getLicenseStatus: Function, authorizeCall: Function, METHOD_FEATURE?: Record<string,string> }} licenseService
 * @property {{ getPath: (name: string) => string }} app - Electron 的 app（取 userData）。
 * @property {string} APP_VERSION
 */

/**
 * 过闸并调用后端。
 *
 * **永不抛**：任何失败都返回 `{ ok:false, error:{ message, code, details } }` 信封，
 * 与后端自己的错误形状一致 —— 这样两个传输层都可以直接把它序列化回去，
 * 渲染层的 `unwrap` 也不需要区分「闸门拒的」与「后端拒的」。
 *
 * @param {CallGateCtx} ctx - 由 main.js 组装（与传给 `registerWechatIpc` 的那份同源）。
 * @param {string} method - `@Remote` 注册的方法名。
 * @param {unknown[]} args - 参数数组。
 * @returns {Promise<{ ok: boolean, value?: unknown, error?: { message: string, code?: string, details?: object } }>}
 */
async function gatedWechatCall(ctx, method, args) {
  const {
    awaitBackendReady, BACKEND_CALL_READY_WAIT_MS, getWechatBackend, getBackendStatus,
    debugGates, licenseService, app, APP_VERSION,
  } = ctx;

  // ① 后端还在启动/重启时**等待**，而不是立刻回一句假错误。
  const ready = await awaitBackendReady(BACKEND_CALL_READY_WAIT_MS);
  if (!ready || !getWechatBackend()) {
    const status = getBackendStatus();
    return {
      ok: false,
      error: {
        message: status.lastError
          ? `Super Time 后端暂不可用：${status.lastError}`
          : 'Super Time 后端仍在启动中，请稍候重试',
        code: 'BACKEND_NOT_READY',
        details: { method, state: status.state },
      },
    };
  }

  // ② 调试闸门豁免。条件来自主进程、不接受调用方参数，且必须排在许可校验之前。
  //    放在 try 之外是刻意的：后端同步抛错时不该被误报成「许可校验失败」。
  if (debugGates().skipGates) {
    console.warn('[debug-gates] 已跳过许可证校验（method=%s）', method);
    return getWechatBackend().call(method, args);
  }

  // ③ 许可证授权。
  try {
    const lic = licenseService.getLicenseStatus(app.getPath('userData'), APP_VERSION);
    const gate = licenseService.authorizeCall(lic, method);
    if (!gate.ok) {
      return {
        ok: false,
        error: {
          message: gate.message,
          code: gate.code,
          details: {
            licenseState: lic.state,
            method,
            feature: (licenseService.METHOD_FEATURE || {})[method] || 'wechat-data',
          },
        },
      };
    }
  } catch (e) {
    // 授权检查**自身**失败时必须拒绝，而不是放行。
    // 许可 JSON 损坏、readLicenseFile 读盘失败、指纹采集异常等都会落到这里；
    // 「只 warn 一句就继续调用后端」等于许可闸门一旦出异常就完全失效。
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
}

module.exports = { gatedWechatCall };
