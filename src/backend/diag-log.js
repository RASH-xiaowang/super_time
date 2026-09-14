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
  const format = (args) => args.map((a) => {
    if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ').slice(0, MAX_LINE_CHARS);

  /**
   * 追加一行。
   * @param {string} level - 级别（error/warn/info…）。
   * @param {unknown[]} args - 内容。
   */
  const write = (level, args) => {
    if (broken || typeof dir !== 'string' || dir === '') return;
    try {
      const line = `[${now().toISOString()}] [${level}] ${format(args)}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      if (currentSize() + bytes > maxBytes) rotate();
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

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  buildDiagnosticReport,
  createDiagLog,
  installConsoleCapture,
};
