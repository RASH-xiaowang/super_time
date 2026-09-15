#!/usr/bin/env node
'use strict';

/**
 * 从 `gateway.ts` 的 `@Remote` 装饰器生成 `docs/API.md`（H14）。
 *
 * 为什么生成而不是手写：这份文档此前**三方打架** —— `gateway.ts` 实际 132 个方法、
 * RAG 文档写 126、后端 README 写 114、启动页写 114。任何手工维护的方法清单都会漂，
 * 而「接口参考说有多少个方法」是外部读者判断契约规模的第一眼信息。
 * 现在唯一来源是源码里的装饰器，`--check` 模式让 CI 拒绝过期文档。
 *
 * 用法：
 *   node scripts/gen-api-docs.js           # 写入 docs/API.md
 *   node scripts/gen-api-docs.js --check   # 只校验是否与源码一致（CI 用，不一致 exit 1）
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const GATEWAY = path.join(root, 'src', 'backend', 'wechat-data', 'src', 'gateway.ts');
const OUT = path.join(root, 'docs', 'API.md');

/** 装饰器形如 `@Remote('getSessions')`（允许参数两侧有空白）。 */
const REMOTE_RE = /@Remote\(\s*'([^']+)'\s*\)/;

/**
 * 取第 `lineIndex` 行上方紧邻的 JSDoc 注释块。
 * @param lines - 源码按行切分。
 * @param lineIndex - 装饰器所在行索引。
 * @returns 逐行内容（已剥掉注释的开闭标记与行首星号）；没有注释块时返回空数组。
 */
function readDocAbove(lines, lineIndex) {
  let end = lineIndex - 1;
  if (end < 0) return [];
  // 允许装饰器与注释之间夹空行（本仓库没有，但不必因此少抓一段说明）
  while (end >= 0 && lines[end].trim() === '') end -= 1;
  if (end < 0 || !lines[end].trim().endsWith('*/')) return [];
  let start = end;
  while (start >= 0 && !lines[start].includes('/**')) start -= 1;
  if (start < 0) return [];
  const body = [];
  for (let i = start; i <= end; i += 1) {
    let text = lines[i].trim();
    if (i === start) text = text.replace(/^\/\*\*/, '');
    if (i === end) text = text.replace(/\*\/$/, '');
    text = text.replace(/^\*\s?/, '').trim();
    body.push(text);
  }
  // 去掉首尾空行
  while (body.length > 0 && body[0] === '') body.shift();
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return body;
}

/**
 * 取装饰器下方的方法签名（直到**函数体**的左花括号为止）。
 *
 * 难点：参数或返回类型里的对象字面量也会以 `{` 结尾
 * （`async askWechat(options: {` 后面还有几行 `question: string` … `}): Promise<AskResult> {`）。
 * 只认「以 `{` 结尾」会把签名截成半截。判别办法：**冒号紧跟 `{`** 的是类型字面量的开始，
 * 而函数体的 `{` 前面总是 `)` 或返回类型名。
 * @param lines - 源码按行切分。
 * @param startIndex - 装饰器下一行的索引。
 * @returns 折叠成单行的签名（去掉结尾的 `{`）。
 */
function readSignature(lines, startIndex) {
  const parts = [];
  for (let i = startIndex; i < lines.length && i < startIndex + 60; i += 1) {
    const text = lines[i].trim();
    if (text === '') continue;
    const opensBody = text.endsWith('{') && !/:\s*\{$/.test(text);
    parts.push(opensBody ? text.slice(0, -1).trim() : text);
    if (opensBody) break;
    // 抽象/接口形态没有函数体，遇到分号即结束
    if (text.endsWith(';')) break;
  }
  // 参数里的行内注释不进签名（例如 `streamId` 那行挂着的说明），否则签名会被注释切碎
  const inlineComment = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
  return parts.join(' ').replace(inlineComment, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 从 gateway.ts 源码里按出现顺序抽出全部 Remote 方法。
 * @param src - gateway.ts 全文。
 * @returns `{ name, doc, signature }` 列表。
 */
function extractMethods(src) {
  const lines = src.split(/\r?\n/);
  const methods = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = REMOTE_RE.exec(lines[i]);
    if (!m) continue;
    methods.push({
      name: m[1],
      doc: readDocAbove(lines, i),
      signature: readSignature(lines, i + 1),
    });
  }
  return methods;
}

/** 去掉 JSDoc 标签行，得到纯说明文本。 */
function proseLines(doc) {
  return doc.filter((l) => !l.startsWith('@'));
}

/**
 * 取说明的第一句（用于概览表）。
 *
 * 只在「句号 + 空白」处切分：`Weixin.dll` / `every .db file` 这类缩写里也含点，
 * 按裸点切会把句子拦腰截断（第一版就这么截了）。
 */
function firstSentence(doc) {
  const prose = proseLines(doc).join(' ');
  if (!prose) return '';
  const sentence = (prose.split(/(?<=[.。])\s+/)[0] ?? prose).trim();
  // 概览表是索引，过长的一行会让整张表没法扫读；明细里有全文
  return sentence.length > 110 ? `${sentence.slice(0, 109)}…` : sentence;
}

/** 把表格单元格里会破坏 Markdown 的字符转义掉。 */
function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/**
 * 渲染整份文档。
 * @param methods - extractMethods 的结果（按源码顺序）。
 * @returns Markdown 全文（结尾带换行）。
 */
function render(methods) {
  const names = methods.map((m) => m.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  const sorted = [...methods].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const out = [];
  out.push('# Remote 接口参考');
  out.push('');
  out.push('> ⚙️ 本文件由 `npm run docs:api` 从 `src/backend/wechat-data/src/gateway.ts` 的');
  out.push('> `@Remote(\'name\')` 装饰器**自动生成**，请勿手工编辑；改了 gateway 请重跑生成命令。');
  out.push('> CI 的 `npm run docs:api:check` 会在文档与源码不一致时失败。');
  out.push('');
  out.push(`当前共 **${methods.length}** 个 Remote 方法。`);
  out.push('');
  out.push('渲染进程通过这些方法与后端通信（`gateway.ts` 是唯一分发点）：');
  out.push('渲染层 → `preload.js` 的 `window.electronAPI.wechat.call(name, args)` → 主进程授权闸门 →');
  out.push('后端 worker → `gateway` 的同名方法。前端手写镜像 `WechatRemote`');
  out.push('（`src/client/ui-wechat/src/client/pages/wechat-data/api.ts`）必须与之一一对应，');
  out.push('由 `src/backend/wechat-data/tests/remote-contract.spec.ts` 守住。');
  out.push('');
  if (dupes.length > 0) {
    // 重名会让「按名字调用」出现歧义，属于必须立刻修的问题，所以在文档里显式点出来
    out.push(`> ⚠️ 存在重复注册的方法名：${[...new Set(dupes)].join('、')}`);
    out.push('');
  }
  out.push('## 概览');
  out.push('');
  out.push('| # | 方法 | 说明 |');
  out.push('|---|---|---|');
  sorted.forEach((m, i) => {
    out.push(`| ${i + 1} | \`${m.name}\` | ${cell(firstSentence(m.doc) || '—')} |`);
  });
  out.push('');
  out.push('## 明细');
  out.push('');
  for (const m of sorted) {
    out.push(`### \`${m.name}\``);
    out.push('');
    if (m.signature) {
      out.push('```ts');
      out.push(m.signature);
      out.push('```');
      out.push('');
    }
    const prose = proseLines(m.doc);
    if (prose.length > 0) {
      out.push(prose.join(' '));
      out.push('');
    }
    const tags = m.doc.filter((l) => l.startsWith('@'));
    for (const tag of tags) {
      out.push(`- ${tag}`);
    }
    if (tags.length > 0) out.push('');
    if (prose.length === 0 && tags.length === 0) {
      // 不为「源码里就没有说明」编内容：写明白，读者才知道该去读源码
      out.push('_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_');
      out.push('');
    }
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

function main() {
  const check = process.argv.includes('--check');
  const src = fs.readFileSync(GATEWAY, 'utf8');
  const methods = extractMethods(src);
  if (methods.length === 0) {
    console.error('❌ 没有从 gateway.ts 抽到任何 @Remote 方法 —— 解析失效，请检查装饰器写法');
    process.exit(1);
  }
  const content = render(methods);

  if (check) {
    let current = null;
    try {
      current = fs.readFileSync(OUT, 'utf8');
    } catch {
      console.error(`❌ 缺少 ${path.relative(root, OUT)}：请运行 npm run docs:api 生成`);
      process.exit(1);
    }
    if (current.replace(/\r\n/g, '\n') !== content) {
      console.error('❌ docs/API.md 与 gateway.ts 的 @Remote 集合不一致：请运行 npm run docs:api 后提交');
      process.exit(1);
    }
    console.log(`ok: docs/API.md 与源码一致（${methods.length} 个方法）`);
    return;
  }

  fs.writeFileSync(OUT, content, 'utf8');
  console.log(`已生成 ${path.relative(root, OUT)}：${methods.length} 个 Remote 方法`);
}

main();
