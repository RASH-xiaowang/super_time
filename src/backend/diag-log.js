'use strict';

/**
 * 极简文件日志（大小轮转）。
 *
 * 为什么要它：GUI 态下 stdout 是一条无人接管的管道，`console-safe` 一旦发现管道坏了
 * 就**彻底静默** —— 于是崩溃之后什么都没留下，用户报障时我们只有一句「打不开」。
 * 错误必须有落盘记录。
 *
 * 三条取舍：
 *   · 同步 append：日志量不大，而崩溃瞬间的那几行比吞吐重要；
 *   · 自己算大小并轮转（app.log → app.1.log → app.2.log，丢最旧）：总量有上界；
 *   · **绝不抛**：写日志失败（目录不可写、磁盘满）只禁用自己，绝不影响业务。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 单文件上限 2MB、保留 3 份（含当前）→ 总量 ≤ 约 6MB，够诊断又不会失控。 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
/** 单行上限：避免一条巨型 JSON 把日志冲掉。 */
const MAX_LINE_CHARS = 4000;

/**
 * 需要脱敏的字段名（JSON 键或 `key=value` 形式）。
 * 这些名字在配置文件/错误上下文里出现即视为敏感。
 */
const SENSITIVE_KEY_RE = /(["']?(?:api[_-]?key|db[_-]?enc[_-]?key|image[_-]?aes[_-]?key|image[_-]?xor[_-]?key|api[_-]?token|token|secret|password|passwd|authorization|cookie|credential)["']?\s*[:=]\s*)(["']?)([^\s"',}]{2,})/gi;
/** `sk-…` 形态的 API Key（OpenAI 兼容厂商通用前缀）。 */
const SK_TOKEN_RE = /\bsk-[A-Za-z0-9_-]{4,}/g;
/** `Bearer <token>`。 */
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]{6,}=*/gi;
/** 16 进制长串（≥16 位，覆盖 32/64 位密钥）。 */
const HEX_RE = /\b[0-9a-fA-F]{16,}\b/g;

/**
 * 给一行文本脱敏。**单一收口点**：所有落盘内容都先过这里。
 *
 * 为什么必须有：`JSON.parse` 的报错会带出错位置附近的**源码片段**
 * （`Unexpected token 'x', ..."apiKey":sk-live-AB"... is not valid JSON`），
 * 于是「损坏的 llm.json/config.json」的告警会把密钥前若干位带进日志；
 * 而导出诊断日志是把日志原样交给支持人员的 —— 等于新开了一条外发通道。
 * 另外任何将来 dump 对象的日志点也会被这里兜住。
 * @param {string} text - 原始文本。
 * @returns {string} 脱敏后的文本。
 */
function redact(text) {
  return String(text)
    // 顺序有意：`Bearer <token>` 与 `sk-…` 必须先处理。否则键值规则会把
    // `authorization: Bearer` 里的 "Bearer" 当成值吃掉，把真 token 留在后面。
    .replace(BEARER_RE, 'Bearer ***')
    .replace(SK_TOKEN_RE, 'sk-***')
    .replace(SENSITIVE_KEY_RE, (_m, prefix, quote) => `${prefix}${quote}***`)
    .replace(HEX_RE, '***');
}

/**
 * 建一个日志器。
 * @param {{ dir: string, file?: string, maxBytes?: number, maxFiles?: number, now?: () => Date }} opts
 *   dir 必须给；其余可选（maxBytes/maxFiles 便于测试用极小值）。
 * @returns {{ path: string, write: (level: string, args: unknown[]) => void, format: (args: unknown[]) => string, files: () => string[], disabled: () => boolean }} 日志器。
 */
function createDiagLog(opts = {}) {
  const dir = opts.dir;
  const name = opts.file || 'app.log';
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES;
  const maxFiles = Math.max(1, Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : DEFAULT_MAX_FILES);
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();

  /** 第 i 份（0 = 当前，越大越旧）。 */
  const fileAt = (i) => (i === 0 ? path.join(dir, name) : path.join(dir, name.replace(/\.log$/, '') + '.' + i + '.log'));
  const files = () => Array.from({ length: maxFiles }, (_, i) => fileAt(i));

  let size = -1; // -1 = 尚未探测
  let broken = false;

  const currentSize = () => {
    if (size >= 0) return size;
    try {
      size = fs.statSync(fileAt(0)).size;
    } catch {
      size = 0;
    }
    return size;
  };

  /** app.log → app.1.log → …，并丢掉最旧的一份。 */
  const rotate = () => {
    try {
      if (maxFiles === 1) {
        // 只保留一份时没有「更旧的份」可搬 —— 直接截断当前文件，
        // 否则这个分支一次都不执行、文件会无上界增长（评审实测 maxBytes=500 写到 27KB）。
        fs.writeFileSync(fileAt(0), '', 'utf8');
        size = 0;
        return;
      }
      for (let i = maxFiles - 1; i >= 1; i -= 1) {
        const from = fileAt(i - 1);
        const to = fileAt(i);
        if (!fs.existsSync(from)) continue;
        if (i === maxFiles - 1) {
          try { fs.rmSync(to, { force: true }); } catch { /* 覆盖不了就交给下一次 */ }
        }
        fs.renameSync(from, to);
      }
      size = 0;
    } catch {
      // 轮转失败不该影响追加：下一次写之前还会再试
    }
  };

  /**
   * 把任意值序列化成一行（Error 带栈、循环引用不炸、超长截断）。
   * @param {unknown[]} args - console 风格的参数。
   * @returns {string} 单行文本。
   */
  const format = (args) => redact(args.map((a) => {
    if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ')).slice(0, MAX_LINE_CHARS);

  /**
   * 追加一行。
   * @param {string} level - 级别（error/warn/info…）。
   * @param {unknown[]} args - 内容。
   */
  /**
   * W3-1.4：**按天**轮转的判断。
   *
   * 为什么除了“按大小”还要“按天”：大小触发只保证文件不超上界，
   * 但一份“写了少就过夜”的 app.log 会一直紧贴着新事件写———
   * 排查时得在同一份文件里翻过多天，而转出去的那份又往往还没写满。
   * 新的一天开一份，“今天发生了什么”才自成一篇。
   *
   * 口径：当前文件里的**第一行**时间戳（写入时自带）。读它而不是记在内存里：
   * 进程重启之后内存状态没了，而“这份文件属于哪一天”是件与重启无关的事实。
   */
  const dayOf = (t) => t.toISOString().slice(0, 10); // YYYY-MM-DD（UTC，不受本机时区影响）
  const currentFileDay = () => {
    let fd = null;
    try {
      // 只读开头 64 字节：时间戳在行首，不必把整份 log 读进内存。
      fd = fs.openSync(fileAt(0), 'r');
      const buf = Buffer.alloc(64);
      const n = fs.readSync(fd, buf, 0, 64, 0);
      const m = /^\[(\d{4}-\d{2}-\d{2})T/.exec(buf.toString('utf8', 0, n));
      return m ? m[1] : null;
    } catch {
      return null; // 没文件 / 读不了：当成“没有归属”，不轮转
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* 别人关了就失效，无所谓 */ } }
    }
  };

  /**
   * 写之前先判断两个触发器：超大小、跳天。
   * 返回是否发生过轮转（日志与测试都要用）。
   * 顺序有意：超大小优先——— 同一行既超大小又跳天时，
   * 不该转两次（第二次会把才写的那行也转走）。
   */
  const rotateIfNeeded = (bytes) => {
    if (currentSize() + bytes > maxBytes) { rotate(); return true; }
    // 跳天：文件非空 + 第一行属于另一天。空文件无需转。
    if (currentSize() > 0 && dayOf(now()) !== currentFileDay()) { rotate(); return true; }
    return false;
  };
  const write = (level, args) => {
    if (broken || typeof dir !== 'string' || dir === '') return;
    try {
      const line = `[${now().toISOString()}] [${level}] ${format(args)}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      rotateIfNeeded(bytes);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(fileAt(0), line, 'utf8');
      size = Math.max(currentSize(), 0) + bytes;
    } catch {
      broken = true; // 目录不可写/磁盘满：停掉自己，绝不向上抛
    }
  };

  return { path: fileAt(0), write, format, files, disabled: () => broken };
}

/**
 * 把 console 也接进日志（**不移除**原有的控制台输出）。
 *
 * 安装顺序有讲究：必须在 `console-safe.install()` **之后**装 —— 那层包装在管道断掉时
 * 会直接 return，如果先装它、后接日志，管道一坏日志就一起没了；反过来则日志先落盘、
 * 再由管道那层决定要不要往里写。
 * @param {ReturnType<typeof createDiagLog>} log - 日志器。
 * @param {string[]} [levels] - 要接管的级别。
 * @returns {() => void} 还原函数（测试用）。
 */
function installConsoleCapture(log, levels = ['log', 'info', 'warn', 'error']) {
  const saved = [];
  for (const level of levels) {
    const prev = console[level];
    if (typeof prev !== 'function') continue;
    saved.push([level, prev]);
    console[level] = (...args) => {
      log.write(level, args);
      try { prev.apply(console, args); } catch { /* 原来的包装自己会处理管道问题 */ }
    };
  }
  return () => {
    for (const [level, prev] of saved) console[level] = prev;
  };
}

/**
 * Electron 的 `console-message` 级别 → 我们的级别名。
 *
 * Electron 给的是数字（0=verbose / 1=info / 2=warn / 3=error），而 `createDiagLog`
 * 的 `level` 是字符串标签 —— 两者对不上就只能在字符串里凑齐，那正是日志难 grep 的原因。
 */
const RENDERER_LEVELS = { 0: 'verbose', 1: 'info', 2: 'warn', 3: 'error' };

/** 默认只收 warn 与 error。 */
const DEFAULT_RENDERER_LEVELS = ['warn', 'error'];

/**
 * 把**渲染层**的 console 转发进诊断日志。
 *
 * ## 为什么必须有（2026-10-08 排查朋友圈问题时实测）
 *
 * 修复前 `app.log` 里 `moments-media` / `renderer` / `取图失败` 各 **0 行** ——
 * 渲染层的 `console.warn/error` 根本不进诊断日志。于是「卡片只显示默认文案」这类问题
 * **在用户机器上取不到任何证据**，只能靠「零 RPC + failed 分支」这类间接现象反推；
 * 那次排查因此连续判错了三次（以为是跑旧代码、以为是键为空、以为是尾块导致渲染失败）。
 *
 * ## 为什么默认只收 warn/error
 *
 * 渲染层的 `console.log` 在正常使用时量很大，全收会把 2 MB × 3 份的轮转迅速冲掉，
 * 真正需要的那几行反而被挤掉 —— 那等于用「有日志」换掉了「日志有用」。
 * 需要更全时可设 `SUPERTIME_RENDERER_LOG_LEVELS=verbose,info,warn,error`。
 *
 * ## 为什么脱敏交给 `write`
 *
 * 这里只负责**转发**，不自己拼字符串：`createDiagLog` 的 `format` 已经过 `redact`
 * （API key / sk- / Bearer / 长 hex 串），在这里另拼一条就等于开一个绕过脱敏的口子。
 *
 * @param {object} contents - Electron 的 `webContents`（只需 `on`/`off`）。
 * @param {ReturnType<typeof createDiagLog>} log - 日志器。
 * @param {string[]} [levels] - 要转发的级别名；缺省 `['warn','error']`。
 * @returns {() => void} 还原函数（测试与热重载用）。
 */
function installRendererConsoleCapture(contents, log, levels = DEFAULT_RENDERER_LEVELS) {
  if (!contents || typeof contents.on !== 'function') return () => {};
  const wanted = new Set(levels);
  const onMessage = (_event, level, message, line, sourceId) => {
    const name = RENDERER_LEVELS[level] ?? 'info';
    if (!wanted.has(name)) return;
    const text = typeof message === 'string' ? message : String(message ?? '');
    if (text === '') return;
    try {
      log.write('renderer', [
        `[${name}]`,
        // 带上来源文件与行号：渲染层的报错没有栈，缺了它就不知道该去哪个文件看
        `[${String(sourceId ?? '?')}:${String(line ?? 0)}]`,
        text,
      ]);
    } catch {
      // 日志不可写不该影响应用本身（与 createDiagLog 内部「broken 后停掉自己」一致）
    }
  };
  contents.on('console-message', onMessage);
  return () => {
    if (typeof contents.off === 'function') contents.off('console-message', onMessage);
  };
}

/**
 * 从环境变量读要转发的渲染层级别。
 *
 * 做成函数而不是模块常量：`main.js` 在 `app.whenReady()` 之前就 require 这个模块，
 * 那时 `process.env` 虽然可读，但把「可被环境变量改」这件事藏在模块加载期会让
 * 单元测试无法在两次运行之间切换档位。
 * @param {Record<string, string | undefined>} [env] - 环境映射。
 * @returns {string[]} 级别名列表；未设置时为 `['warn','error']`。
 */
function rendererConsoleLevels(env = process.env) {
  const raw = String(env.SUPERTIME_RENDERER_LOG_LEVELS ?? '').trim();
  if (raw === '') return DEFAULT_RENDERER_LEVELS.slice();
  const list = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  return list.length > 0 ? list : DEFAULT_RENDERER_LEVELS.slice();
}

/**
 * 把各份轮转日志（**旧 → 新**）+ 环境信息拼成一份可直接交付给支持人员的文本。
 *
 * 抽成函数是为了可测：拼装顺序错了（新旧颠倒）人工翻日志会非常费劲，
 * 而这种错误在弹出保存对话框那一步是看不出来的。
 * @param {ReturnType<typeof createDiagLog>} log - 日志器。
 * @param {Record<string, unknown>} [env] - 环境信息（版本/平台等）。
 * @returns {string} 诊断报告全文。
 */
function buildDiagnosticReport(log, env = {}) {
  const parts = [];
  for (const p of log.files().slice().reverse()) {
    try {
      if (fs.statSync(p).size <= 0) continue;
      parts.push(`===== ${path.basename(p)} =====\n${fs.readFileSync(p, 'utf8')}`);
    } catch {
      // 该份不存在/读不到：跳过即可，不能让导出整体失败
    }
  }
  parts.push('===== 环境 =====\n' + JSON.stringify(env, null, 2));
  return parts.join('\n');
}

/** 预览最多给多少字符（够看出「脱敏之后长什么样」，又不至于把整份 6MB 拉进渲染进程）。 */
const PREVIEW_MAX_CHARS = 8000;

/**
 * 导出前的**脱敏预览**（W2-12.4）。
 *
 * ## 为什么要有这一段
 *
 * 诊断日志是**要发给别人**的文件。用户有充分理由在发出去之前先看一眼「里面到底有什么」，
 * 尤其是：日志里可能有聊天内容、路径、用户名。`redact` 只保证密钥一类的东西被换掉，
 * 但「有没有别的敏感内容」是**用户自己**才有资格判断的事 ——
 * 让他在分享前能确认，比替他假设要靠得住。
 *
 * ## 三条边界
 *
 * ① 预览与导出**用同一个 `buildDiagnosticReport`**，不做第二套拼装 ——
 *    否则「预览里没有的那行」会被误当成「导出里也没有」，而这正是最不能出错的地方。
 * ② **截断要说出来**（`truncated: true` + 原字符数）：让用户以为看全了，比不给看更糟。
 * ③ 预览走 IPC 回渲染进程，日志因此**多出一份内存副本**。所以限量 8000 字符，
 *    不做「先全读再截」以外的任何事。
 *
 * @param {ReturnType<typeof createDiagLog>} log - 日志器。
 * @param {Record<string, unknown>} [env] - 环境信息（与导出那份同源）。
 * @param {{ maxChars?: number }} [opts] - 预览上限。
 * @returns {{ text: string, chars: number, truncated: boolean, files: string[] }} 预览。
 */
function buildDiagnosticPreview(log, env = {}, opts = {}) {
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : PREVIEW_MAX_CHARS;
  const report = buildDiagnosticReport(log, env);
  const truncated = report.length > maxChars;
  return {
    text: truncated ? report.slice(0, maxChars) : report,
    chars: report.length,
    truncated,
    files: log.files().map((p) => path.basename(p)),
  };
}
module.exports = {
  DEFAULT_MAX_BYTES,
  PREVIEW_MAX_CHARS,
  DEFAULT_MAX_FILES,
  RENDERER_LEVELS,
  buildDiagnosticReport,
  buildDiagnosticPreview,
  createDiagLog,
  installConsoleCapture,
  installRendererConsoleCapture,
  redact,
  rendererConsoleLevels,
};
