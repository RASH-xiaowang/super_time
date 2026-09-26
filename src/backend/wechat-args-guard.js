'use strict';

/**
 * `wechat:call` 的入参守卫（CODE-AUDIT-2026-09-26 P2-7，第二批 #13）。
 *
 * ## 为什么这道闸门非有不可
 *
 * 渲染进程到主进程只有这一个口子（`ipc-wechat.js` 与 `wechat-worker.js` 都汇到
 * `wechat-host.js` 的 `call()`），而旧实现是 `fn.apply(gateway, callArgs)` ——
 * **方法名有白名单，参数一个都不看**。`@Remote` 的类型只存在于编译期：
 * 面板（或任何拿到 `ipcRenderer.invoke` 的东西）传 `null`、传循环引用、传一个
 * 200MB 的字符串，后端都会照单执行。轻则在结果缓存的 `JSON.stringify` 里炸开，
 * 重则把一条重查询的参数放大成几十次全库扫描。
 *
 * ## 为什么这里不直接上 zod
 *
 * 生成的 `wechat-data/lib/typert.host.js` 里每个方法都有完整 zod schema，但它们
 * **从来没被执行过**（`.parse`/`.safeParse` 全仓 0 次），也就是说「schema 与今天
 * 真实的调用形状对不对得上」这件事没有任何证据。拿没有证据的东西去拒绝真实流量，
 * 结果不会是「更安全」，会是「某个面板今天开始报错」。所以本模块分两档：
 *   ① **硬拒**（这里）：结构、类型、深度、体积 —— 只拒「任何 sane 的面板都不会这样」的量级，
 *      上界刻意放宽（见 `ARG_LIMITS` 的注释），避免误伤真实调用；
 *   ② **影子记账**（`observe` / `noteSchema`）：每次调用记下「这个方法实际传了多大、
 *      schema 判不判得过」。有了这份实测账，①的上界才能收紧、②才能升级成硬拒。
 *
 * @remote 参数的实际校验发生在 `wechat-host.js` 的 `call()` 里，那里是本模块唯一的调用方。
 */

/**
 * 结构上界。**这些数刻意比「应该」大一个量级**：误拒一条真实调用 = 面板当场坏掉，
 * 而松一点的界仍然挡得住「把整个库塞进一个字符串」这类放大。
 * 收界需要证据，证据由 `observe` 攒（每条方法记录历史最大字节数）。
 */
const ARG_LIMITS = {
  maxArgs: 8,
  maxDepth: 24,
  maxString: 24_000_000,
  maxItems: 50_000,
  maxKeys: 20_000,
  maxTotalBytes: 32_000_000,
  /** 记账表容量（超出按 FIFO 淘汰，防无界增长）。 */
  maxLedgerEntries: 512,
};

/** 不可 JSON 化的类型一律拒：结果缓存要把参数 `JSON.stringify`，zod 也只吃纯数据。 */
const REJECTED_TYPES = new Set(['function', 'symbol', 'bigint']);

/**
 * 深查一个参数值。
 * @param {unknown} value - 待查的值。
 * @param {number} depth - 当前深度。
 * @param {Set<object>} seen - 祖先链（环检测）。
 * @param {{bytes:number, nodes:number}} acc - 累计器（就地更新）。
 * @returns {{code:string, message:string} | null} 违规原因，合法返回 null。
 */
function inspect(value, depth, seen, acc) {
  const t = typeof value;
  if (REJECTED_TYPES.has(t)) {
    return { code: 'ARGS_TYPE', message: `参数里出现了 ${t}，后端只接受纯数据` };
  }
  if (value === null || t === 'boolean') return null;
  if (t === 'number') {
    // NaN/Infinity 会一路混进 SQL 与 JSON.stringify（后者把 NaN 写成 null，静默改数据）
    if (!Number.isFinite(value)) {
      return { code: 'ARGS_NUMBER', message: `参数里有非有限数值（${String(value)}）` };
    }
    acc.bytes += 8;
    return null;
  }
  if (t === 'string') {
    if (value.length > ARG_LIMITS.maxString) {
      return { code: 'ARGS_SIZE', message: `单个字符串 ${String(value.length)} 字符，超过上界 ${String(ARG_LIMITS.maxString)}` };
    }
    acc.bytes += value.length;
    return null;
  }
  if (t !== 'object') return null; // undefined 等：原样放行（方法签名里就有可选参数）
  if (seen.has(value)) return { code: 'ARGS_CYCLE', message: '参数里有循环引用' };
  if (depth > ARG_LIMITS.maxDepth) {
    return { code: 'ARGS_DEPTH', message: `参数嵌套超过 ${String(ARG_LIMITS.maxDepth)} 层` };
  }
  acc.nodes += 1;
  // Buffer/TypedArray 按**字节数**记账，绝不逐元素走：20MB 的 buffer 逐项累加会把
  // 主进程事件循环钉死在守卫自己里 —— 那正是这道闸门要防的形状。
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength > ARG_LIMITS.maxTotalBytes) {
      return { code: 'ARGS_SIZE', message: `二进制参数 ${String(value.byteLength)} 字节，超过上界 ${String(ARG_LIMITS.maxTotalBytes)}` };
    }
    acc.bytes += value.byteLength;
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length > ARG_LIMITS.maxItems) {
      return { code: 'ARGS_SIZE', message: `数组有 ${String(value.length)} 项，超过上界 ${String(ARG_LIMITS.maxItems)}` };
    }
    seen.add(value);
    for (const item of value) {
      const bad = inspect(item, depth + 1, seen, acc);
      if (bad) return bad;
    }
    seen.delete(value);
    return null;
  }
  // 非 plain object（Date / Map / Set / Promise / 类实例）过不了 IPC 的结构化克隆到纯数据语义，
  // 也只有 plain object 才是这些方法真正接受的形状。
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    const name = proto && proto.constructor && proto.constructor.name ? proto.constructor.name : '非纯对象';
    return { code: 'ARGS_TYPE', message: `参数里有 ${name} 实例，后端只接受 plain object` };
  }
  const keys = Object.keys(value);
  if (keys.length > ARG_LIMITS.maxKeys) {
    return { code: 'ARGS_SIZE', message: `对象有 ${String(keys.length)} 个键，超过上界 ${String(ARG_LIMITS.maxKeys)}` };
  }
  seen.add(value);
  for (const k of keys) {
    acc.bytes += k.length;
    const bad = inspect(value[k], depth + 1, seen, acc);
    if (bad) return bad;
  }
  seen.delete(value);
  return null;
}

/**
 * 校验并归一化 `wechat:call` 的参数。
 *
 * 归一化沿用旧行为：不是数组就当单参数包一层，`undefined`/`null` 当无参 ——
 * 守卫**不许改变合法调用的语义**，只许拒绝。
 * @param {unknown} args - 渲染层传来的原始参数。
 * @returns {{ok: true, value: unknown[], bytes: number} | {ok: false, code: string, message: string}}
 */
function guardCallArgs(args) {
  const list = Array.isArray(args) ? args : (args === undefined || args === null ? [] : [args]);
  if (list.length > ARG_LIMITS.maxArgs) {
    return { ok: false, code: 'ARGS_COUNT', message: `一次调用最多 ${String(ARG_LIMITS.maxArgs)} 个参数，收到 ${String(list.length)} 个` };
  }
  const acc = { bytes: 0, nodes: 0 };
  for (const value of list) {
    const bad = inspect(value, 0, new Set(), acc);
    if (bad) return { ok: false, code: bad.code, message: bad.message };
  }
  if (acc.bytes > ARG_LIMITS.maxTotalBytes) {
    return { ok: false, code: 'ARGS_SIZE', message: `一次调用共 ${String(acc.bytes)} 字符量，超过上界 ${String(ARG_LIMITS.maxTotalBytes)}` };
  }
  return { ok: true, value: list, bytes: acc.bytes };
}

/**
 * 参数体积账（影子阶段的核心）。
 *
 * 为什么要它：上界只能凭「sane 的面板不会这样」拍脑袋，而**收紧上界必须有实测**。
 * 每条方法留住历史最大字节数，攒够真实流量后，这份账就是收界（以及把 zod
 * 从影子升级成硬拒）的依据。
 */
const ledger = new Map();

/** 每个方法第一次看到 schema 不通过时记一条原因（不刷屏，也方便对着 ② 档查）。 */
const schemaIssues = new Map();

/**
 * 记一次调用的参数体积。
 * @param {string} method - Remote 方法名。
 * @param {number} bytes - `guardCallArgs` 算出的字符量。
 */
function observe(method, bytes) {
  if (ledger.size >= ARG_LIMITS.maxLedgerEntries && !ledger.has(method)) {
    const first = ledger.keys().next();
    if (!first.done) ledger.delete(first.value);
  }
  const hit = ledger.get(method);
  ledger.set(method, { calls: (hit ? hit.calls : 0) + 1, maxBytes: Math.max(hit ? hit.maxBytes : 0, bytes) });
}

/**
 * 记一次 zod 影子判定。
 * @param {string} method - Remote 方法名。
 * @param {string | null} reason - 判定失败的原因（通过传 null）。
 */
function noteSchema(method, reason) {
  if (reason === null) {
    if (!schemaIssues.has(method)) schemaIssues.set(method, null);
    return;
  }
  if (!schemaIssues.has(method) || schemaIssues.get(method) === null) schemaIssues.set(method, reason);
}

/**
 * 影子账本快照（导出给 `info()` 与诊断日志，不参与放行判定）。
 * @param {number} covered - 有 schema 的方法数。
 * @param {number} total - `@Remote` 方法总数。
 * @returns {{covered:number, total:number, uncovered:number, enforced:string[], mismatched:string[], largest:Array<{method:string, maxBytes:number}>}}
 */
function snapshot(covered, total) {
  const mismatched = [...schemaIssues.entries()]
    .filter(([, reason]) => typeof reason === 'string')
    .map(([method]) => method)
    .sort();
  const enforced = [...schemaIssues.entries()]
    .filter(([, reason]) => reason === null)
    .map(([method]) => method)
    .sort();
  const largest = [...ledger.entries()]
    .map(([method, v]) => ({ method, maxBytes: v.maxBytes }))
    .sort((a, b) => b.maxBytes - a.maxBytes)
    .slice(0, 10);
  return { covered, total, uncovered: Math.max(0, total - covered), enforced, mismatched, largest };
}

/**
 * zod issue 列表里「只怪多给了键」的判定：这类差异是**向前兼容**的
 * （面板可以先发一个后端旧 schema 还不认识的字段），不该据此拒绝真实调用。
 * @param {{code?: string}[]} issues - `result.error.issues`。
 * @returns {boolean} 全部问题都只是多余键时返回 true。
 */
function onlyExtraKeys(issues) {
  return issues.length > 0 && issues.every((i) => i.code === 'unrecognized_keys')
}

/**
 * 把一次 schema 判定翻成人能看懂的一条原因（影子阶段只留痕，不弹窗）。
 * @param {{code?: string, path?: (string | number)[], message?: string}[]} issues - zod issues。
 * @returns {string} 形如 `title: Invalid input: expected string, received undefined`。
 */
function issueText(issues) {
  const i = issues.find((x) => x.code !== 'unrecognized_keys') ?? issues[0]
  if (!i) return '未知'
  const p = Array.isArray(i.path) && i.path.length > 0 ? i.path.join('.') : '(整体)'
  return `${p}: ${String(i.message ?? i.code)}`
}

/**
 * 从 `TYPERT.invocations` 建「实现名 → 各位置参数的 zod schema」表。
 *
 * 为什么以**实现名**为键：`wechat-host.js` 在查表之前已经把公开方法名（`exportName`）
 * 解析成了实现成员名，用同一口径才不会有两套名字。
 * @param {Array<{method: string, parameters?: Array<{codec?: {schema?: unknown}}>}>} invocations - 生成的调用表。
 * @returns {Map<string, unknown[]>} 实现名 → 按位置排好的 schema 列表。
 */
function buildSchemaMap(invocations) {
  const out = new Map();
  for (const inv of invocations ?? []) {
    if (!inv || typeof inv.method !== 'string') continue;
    const schemas = (inv.parameters ?? [])
      .map((p) => (p && p.codec && 'schema' in p.codec ? p.codec.schema : undefined));
    out.set(inv.method, schemas);
  }
  return out;
}

/**
 * 用生成的 schema 判一次参数（② 档）。
 *
 * 两档行为由 `enforced` 这个集合决定：**在里面 ⇒ 拒绝**，不在 ⇒ 只记账。
 * 之所以能这么切：`unrecognized_keys`（面板多发一个后端还没认的字段）永远不算失败，
 * 于是「拒绝」只可能来自类型/必填项错配 —— 而那正是需要证据才敢硬拒的那一类。
 * @param {Map<string, unknown[]> | null} schemas - `buildSchemaMap` 的产物（null 表示没加载到）。
 * @param {string} implName - 已解析的实现名。
 * @param {unknown[]} callArgs - 归一化后的参数数组。
 * @param {Set<string>} enforced - 已用真实流量证明过 schema 对得上的方法名。
 * @returns {{verdict: 'no-schema'|'unloaded'|'ok'|'mismatch', code?: string, message?: string}}
 */
function checkSchema(schemas, implName, callArgs, enforced) {
  if (!schemas) return { verdict: 'unloaded' };
  if (!schemas.has(implName)) return { verdict: 'no-schema' };
  const list = schemas.get(implName) ?? [];
  for (let i = 0; i < list.length; i += 1) {
    const schema = list[i];
    if (!schema || typeof schema.safeParse !== 'function') continue;
    const arg = i < callArgs.length ? callArgs[i] : undefined;
    const res = schema.safeParse(arg);
    if (res.success) continue;
    const issues = res.error && Array.isArray(res.error.issues) ? res.error.issues : [];
    if (onlyExtraKeys(issues)) continue;
    const message = `${implName} 的第 ${String(i + 1)} 个参数不符合该方法声明的形状（${issueText(issues)}）`;
    return enforced.has(implName)
      ? { verdict: 'mismatch', code: 'ARGS_SCHEMA', message }
      : { verdict: 'mismatch', message };
  }
  return { verdict: 'ok' };
}

/** 单测/进程复用时的复位把手（影子账本不该在测试之间串味）。 */
function resetLedger() {
  ledger.clear();
  schemaIssues.clear();
}

module.exports = {
  ARG_LIMITS,
  guardCallArgs,
  observe,
  noteSchema,
  snapshot,
  resetLedger,
  buildSchemaMap,
  checkSchema,
  onlyExtraKeys,
  issueText,
  /** 单测入口：直接看深查逻辑。 */
  inspect,
};
