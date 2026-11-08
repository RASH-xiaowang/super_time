#!/usr/bin/env node
'use strict';

/**
 * 发布产物的纯规则层：只回答“某个路径/文本是否允许进入安装包”。
 * I/O 放在 `check-release-artifacts.js`，这样规则可以单测、也可以被
 * electron-builder hook 复用，不会出现“脚本绿、包还是漏”的两套口径。
 */

const FORBIDDEN_EXTENSIONS = new Set([
  '.map', '.ts', '.tsx', '.cts', '.mts', '.tsbuildinfo',
]);
const FORBIDDEN_KEY_EXTENSIONS = new Set(['.pem', '.pfx', '.p12', '.ppk']);
const FORBIDDEN_EXACT = new Set([
  'wechat/config.json',
  'wechat/llm.json',
  'license.json',
  'secrets.json',
  '.env',
  '.npmrc',
]);
const FORBIDDEN_PATH_PREFIXES = [
  'vendor-keys/',
  'activation-request',
];
const REQUIRED_PACKAGED_ENTRIES = [
  'main.js',
  'preload.js',
  'src/client/ui-dist/index.html',
  'src/backend/wechat-data/lib/index.js',
];
const SOURCE_MAP_RE = /\/\/[#@]\s*sourceMappingURL\s*=\s*\S+/;
const DEBUGGER_RE = /(?:^|[;{}\s])debugger\s*;/;
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

/** 统一成 asar 风格：无前导斜杠、正斜杠、无结尾斜杠。 */
function normalizeEntry(entry) {
  return String(entry).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function extOf(entry) {
  const base = entry.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

function isSensitiveName(entry) {
  const base = entry.split('/').pop() || '';
  if (FORBIDDEN_EXACT.has(entry)) return true;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (FORBIDDEN_KEY_EXTENSIONS.has(extOf(entry))) return true;
  return FORBIDDEN_PATH_PREFIXES.some((prefix) => entry.startsWith(prefix));
}

/**
 * 检查最终 asar / unpacked 路径清单。
 * @param {string[]} entries
 * @returns {{ entry: string, rule: string, hint: string }[]}
 */
function entryViolations(entries) {
  const out = [];
  for (const raw of entries) {
    const entry = normalizeEntry(raw);
    if (!entry) continue;
    const ext = extOf(entry);
    if (FORBIDDEN_EXTENSIONS.has(ext)) {
      out.push({
        entry,
        rule: 'source-artifact',
        hint: `${ext} 只应存在于源码树/构建机，发行包不得携带`,
      });
      continue;
    }
    if (/^tsconfig.*\.json$/i.test(entry.split('/').pop() || '')) {
      out.push({ entry, rule: 'build-config', hint: 'TypeScript 构建配置无需随包分发' });
      continue;
    }
    if (/(?:^|\/)(?:tests?|__tests__)\//i.test(entry)
      || /\.(?:spec|test)\.(?:js|cjs|mjs|ts|tsx)$/i.test(entry)) {
      out.push({ entry, rule: 'test-artifact', hint: '测试代码与夹具不应进入发行包' });
      continue;
    }
    if (isSensitiveName(entry)) {
      out.push({ entry, rule: 'sensitive-file', hint: '敏感配置、签名材料或激活材料不得进入发行包' });
    }
  }
  return out;
}

/**
 * 检查自有脚本的文本。第三方依赖不扫源文本，避免把其正常调试语句误判成
 * 本项目的泄露；第三方路径已由 entryViolations 管住。
 * @param {string} label
 * @param {string} text
 * @returns {{ entry: string, rule: string, hint: string }[]}
 */
function textViolations(label, text) {
  const out = [];
  const entry = normalizeEntry(label);
  if (SOURCE_MAP_RE.test(text)) {
    out.push({ entry, rule: 'source-map-reference', hint: '脚本仍引用 sourcemap，源码映射会暴露实现' });
  }
  if (DEBUGGER_RE.test(text)) {
    out.push({ entry, rule: 'debugger', hint: '发行脚本含 debugger 断点' });
  }
  if (PRIVATE_KEY_RE.test(text)) {
    out.push({ entry, rule: 'private-key', hint: '脚本文本中出现私钥块' });
  }
  return out;
}

/** 判断某个 asar 条目是否属于需要做文本扫描的自有代码。 */
function isOwnRuntimeScript(entry) {
  const p = normalizeEntry(entry);
  if (p === 'main.js' || p === 'preload.js') return true;
  if (/\.(?:js|cjs|mjs|css)$/i.test(p) && p.startsWith('src/client/ui-dist/')) return true;
  if (!/\.(?:js|cjs|mjs)$/i.test(p)) return false;
  if (p.startsWith('src/backend/wechat-data/lib/types/')) return false;
  return p.startsWith('src/backend/') || p.startsWith('src/license/') || p.startsWith('src/shared/');
}

function packagedLayoutViolations(entries) {
  const have = new Set(entries.map(normalizeEntry));
  return REQUIRED_PACKAGED_ENTRIES
    .filter((entry) => !have.has(entry))
    .map((entry) => ({ entry, rule: 'missing-runtime-entry', hint: '安装包缺少运行必需文件' }));
}

/**
 * `app.asar.unpacked` 不受 Electron asar integrity 覆盖。第三方原生包可能需要
 * 解包 JS 适配层，但本项目自己的运行时代码不能落到这里，否则一次简单的磁盘替换
 * 就能绕过受完整性保护的 `app.asar`。
 * @param {string[]} entries
 * @returns {{ entry: string, rule: string, hint: string }[]}
 */
function unpackedOwnScriptViolations(entries) {
  return entries
    .map(normalizeEntry)
    .filter((entry) => /\.(?:js|cjs|mjs)$/i.test(entry))
    .filter((entry) => !entry.replace(/^app\.asar\.unpacked\//, '').startsWith('node_modules/'))
    .map((entry) => ({
      entry,
      rule: 'unpacked-script',
      hint: '自有脚本必须留在受 asar integrity 保护的 app.asar 内',
    }));
}

/**
 * 正式发布包不得携带测试钩子标记。带此标记的包会启用截图/安全探针等自动化入口，
 * 只能由 `npm run pack` 的测试配置产生。
 * @param {unknown} metadata - app.asar 内的 package.json 解析结果。
 * @returns {{ entry: string, rule: string, hint: string }[]}
 */
function packageMetadataViolations(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return [{
      entry: 'package.json',
      rule: 'invalid-package-metadata',
      hint: 'app.asar 内的 package.json 缺失或不是对象',
    }];
  }
  if (metadata.supertimeTestHooks === true) {
    return [{
      entry: 'package.json',
      rule: 'test-hooks-enabled',
      hint: '正式包不得带 supertimeTestHooks 标记；该标记只属于测试包',
    }];
  }
  return [];
}

/**
 * 扫描结果统一格式化；只输出路径和规则，绝不输出命中的密钥值。
 * @param {Array<{entry: string, rule: string, hint: string}>} violations
 * @param {number} [limit]
 */
function formatViolations(violations, limit = 20) {
  return violations.slice(0, limit).map((v) => `- [${v.rule}] ${v.entry}\n  ${v.hint}`).join('\n');
}

module.exports = {
  FORBIDDEN_EXTENSIONS,
  REQUIRED_PACKAGED_ENTRIES,
  normalizeEntry,
  isSensitiveName,
  entryViolations,
  textViolations,
  isOwnRuntimeScript,
  packagedLayoutViolations,
  unpackedOwnScriptViolations,
  packageMetadataViolations,
  formatViolations,
};
