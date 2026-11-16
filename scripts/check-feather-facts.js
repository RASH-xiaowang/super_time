#!/usr/bin/env node
'use strict';

/**
 * Feather 文档事实一致性守卫。
 *
 * 为什么需要它：`docs/FEATHER-INTEGRATION.md` §5 曾把「生成 sourceRef」写在模型调用
 * 之后，还漏掉了「空正文 pending 预约先落库」。这类顺序错误读者照着做就会把
 * 「先落库、后出网」理解反，而人肉复核很容易再次漂移。
 *
 * 本脚本做两件事：
 *   ① 从生产源码提取常量（合并静默窗口、会话租约、崩溃恢复阈值），生成文档里的
 *      `<!-- feather-facts:begin -->` / `<!-- feather-facts:end -->` 自动块；
 *   ② 断言 §5 主流程代码块中，sourceRef → 空正文预约 → 模型生成 → 分段 →
 *      认领/投递 的首次出现顺序严格递增。
 *
 * 用法：
 *   node scripts/check-feather-facts.js           # 重新生成文档自动块（并做顺序断言）
 *   node scripts/check-feather-facts.js --check   # 只校验，不一致时 exit 1（CI 用）
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(ROOT, 'docs', 'FEATHER-INTEGRATION.md');
const BEGIN = '<!-- feather-facts:begin -->';
const END = '<!-- feather-facts:end -->';
const CHECK_ONLY = process.argv.includes('--check');

/** 文档自动块里的常量清单：值只从源码解析，不在脚本里写死。 */
const FACTS = [
  {
    name: 'CHAT_AI_REPLY_COALESCE_QUIET_MS',
    file: 'src/backend/wechat-data/src/query/ai-reply/runner-coalesce.ts',
    meaning: '连续消息合并的静默窗口',
  },
  {
    name: 'CHAT_AI_REPLY_LEASE_MS',
    file: 'src/backend/wechat-data/src/query/ai-reply/lease-store.ts',
    meaning: '会话执行租约',
  },
  {
    name: 'INTERRUPTED_DISPATCH_STALE_MS',
    file: 'src/backend/wechat-data/src/query/message-list-store-shared.ts',
    meaning: '`dispatching` 崩溃恢复阈值',
  },
];

/**
 * §5 主流程的顺序断言。
 * 每个条目只取**首次出现**的行号；正则刻意互相避让，避免“生成 sourceRef”被
 * 当成模型生成、或“AI 回复 · 生成中”被当成生成完成。
 */
const ORDER = [
  { name: 'sourceRef 生成', re: /sourceRef/i },
  { name: '空正文 pending 预约', re: /空正文|预约/ },
  { name: '模型生成', re: /模型|生成一次|完整正文/ },
  { name: '分段', re: /分段/ },
  { name: '认领/投递', re: /认领|投递/ },
];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function readUtf8(file) {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

/** 只解析整数四则表达式（允许 `5 * 60_000` 这种源码写法），不执行任意代码。 */
function evalIntegerExpression(expr) {
  const src = expr.replace(/_/g, '');
  let i = 0;
  function skip() {
    while (i < src.length && /\s/.test(src[i])) i += 1;
  }
  function parseNumber() {
    skip();
    const m = /^\d+/.exec(src.slice(i));
    if (m === null) throw new Error(`无法解析数字：${expr}`);
    i += m[0].length;
    return Number(m[0]);
  }
  function parseFactor() {
    skip();
    if (src[i] === '(') {
      i += 1;
      const value = parseExpression();
      skip();
      if (src[i] !== ')') throw new Error(`括号不匹配：${expr}`);
      i += 1;
      return value;
    }
    return parseNumber();
  }
  function parseTerm() {
    let value = parseFactor();
    for (;;) {
      skip();
      if (src[i] === '*') {
        i += 1;
        value *= parseFactor();
      } else if (src[i] === '/') {
        i += 1;
        value /= parseFactor();
      } else {
        return value;
      }
    }
  }
  function parseExpression() {
    let value = parseTerm();
    for (;;) {
      skip();
      if (src[i] === '+') {
        i += 1;
        value += parseTerm();
      } else if (src[i] === '-') {
        i += 1;
        value -= parseTerm();
      } else {
        return value;
      }
    }
  }
  const value = parseExpression();
  skip();
  if (i !== src.length || !Number.isInteger(value) || value < 0) {
    throw new Error(`不是合法的非负整数表达式：${expr}`);
  }
  return value;
}

function commaOf(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 人类可读的毫秒说明；只用于文档展示，不参与数值判定。 */
function humanMs(ms) {
  if (ms > 0 && ms % 60000 === 0) return `${ms / 60000} 分钟`;
  if (ms > 0 && ms % 1000 === 0) return `${ms / 1000} 秒`;
  return '';
}

function readFact(fact) {
  const sourcePath = path.join(ROOT, fact.file);
  const source = readUtf8(sourcePath);
  const re = new RegExp(`export\\s+const\\s+${fact.name}\\s*=\\s*([^\\n;]+)`);
  const match = re.exec(source);
  if (match === null) {
    throw new Error(`${fact.file} 里找不到 export const ${fact.name}`);
  }
  const expr = (match[1] ?? '').replace(/\/\/.*$/, '').trim().replace(/\s+/g, ' ');
  if (expr === '') throw new Error(`${fact.file} 里 ${fact.name} 没有值`);
  const ms = evalIntegerExpression(expr);
  return { ...fact, expr, ms };
}

function renderFactsBlock(facts) {
  const lines = [
    '<!-- 由 `node scripts/check-feather-facts.js` 生成；请勿手改，运行该脚本可重新生成。 -->',
    '| 常量 | 源码值 | 含义 | 来源 |',
    '|---|---|---|---|',
  ];
  for (const fact of facts) {
    const human = humanMs(fact.ms);
    const rendered = human === ''
      ? `${commaOf(fact.ms)} ms`
      : `${commaOf(fact.ms)} ms / ${human}`;
    lines.push(`| \`${fact.name}\` | \`${fact.expr}\`（${rendered}） | ${fact.meaning} | \`${fact.file}\` |`);
  }
  return `${BEGIN}\n${lines.join('\n')}\n${END}`;
}

function findBlock(text) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 || end < 0 || end <= start) return null;
  return { start, end: end + END.length, text: text.slice(start, end + END.length) };
}

/** 小型 LCS 行差异：只用于打印“文档里现在是什么、源码要求什么”。 */
function renderLineDiff(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i += 1;
    } else {
      out.push(`+ ${b[j]}`);
      j += 1;
    }
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

/** 取 `## 5.` 到下一个二级标题之间的正文。 */
function section5(text) {
  const start = text.indexOf('\n## 5. ');
  if (start < 0) return '';
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next < 0 ? text.length : next);
}

/** 取 §5 的第一个 ```text 代码块（主流程）。 */
function mainFlowLines(section) {
  const match = /```text\r?\n([\s\S]*?)```/.exec(section);
  if (match === null) return null;
  return (match[1] ?? '').split(/\r?\n/);
}

function checkOrder(text) {
  const lines = mainFlowLines(section5(text));
  if (lines === null) {
    fail('docs/FEATHER-INTEGRATION.md §5 里找不到 ```text 主流程代码块，无法做顺序断言。');
    return false;
  }
  const hits = ORDER.map((item) => ({
    ...item,
    index: lines.findIndex((line) => item.re.test(line)),
  }));
  const missing = hits.filter((item) => item.index < 0);
  if (missing.length > 0) {
    fail('§5 主流程缺少顺序断言所需的行：' + missing.map((item) => item.name).join('、'));
    return false;
  }
  const problems = [];
  for (let i = 1; i < hits.length; i += 1) {
    if (hits[i].index <= hits[i - 1].index) {
      problems.push(
        `「${hits[i].name}」行（第 ${hits[i].index + 1} 行）必须晚于「${hits[i - 1].name}」行（第 ${hits[i - 1].index + 1} 行）`,
      );
    }
  }
  if (problems.length > 0) {
    fail('§5 主流程顺序错误：\n  - ' + problems.join('\n  - '));
    return false;
  }
  console.log('feather facts: 顺序 OK（' + hits.map((item) => item.name).join(' → ') + '）');
  return true;
}

function main() {
  const doc = readUtf8(DOC_PATH);
  const facts = FACTS.map(readFact);
  const expectedBlock = renderFactsBlock(facts);
  const block = findBlock(doc);

  if (block === null) {
    fail(
      'docs/FEATHER-INTEGRATION.md 缺少 feather-facts 自动块标记：\n  '
      + BEGIN + '\n  ' + END,
    );
    return;
  }

  const actualBlock = block.text.replace(/\r\n/g, '\n');
  const blockMatches = actualBlock === expectedBlock;

  if (!blockMatches) {
    if (CHECK_ONLY) {
      fail(
        'docs/FEATHER-INTEGRATION.md 的 feather-facts 自动块与源码不一致：\n'
        + renderLineDiff(expectedBlock, actualBlock)
        + '\n请运行 `node scripts/check-feather-facts.js` 重新生成。',
      );
    } else {
      const eol = doc.includes('\r\n') ? '\r\n' : '\n';
      const nextBlock = eol === '\n' ? expectedBlock : expectedBlock.replace(/\n/g, eol);
      const next = doc.slice(0, block.start) + nextBlock + doc.slice(block.end);
      fs.writeFileSync(DOC_PATH, next, 'utf8');
      console.log('feather facts: 已重新生成 docs/FEATHER-INTEGRATION.md 的常量块。');
    }
  } else {
    console.log('feather facts: 常量块 OK（' + facts.length + ' 个常量）。');
  }

  // 顺序断言永远读取磁盘上的最新内容；生成模式刚写过文件时也一样。
  const latest = CHECK_ONLY ? doc : readUtf8(DOC_PATH);
  const orderOk = checkOrder(latest);
  const factsOk = CHECK_ONLY ? blockMatches : true;
  if (!factsOk || !orderOk) process.exitCode = 1;
}

try {
  main();
} catch (e) {
  fail('feather facts 检查失败：' + (e instanceof Error ? e.message : String(e)));
}
