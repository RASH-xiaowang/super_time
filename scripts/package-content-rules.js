#!/usr/bin/env node
'use strict';

/**
 * 打包内容规则（N22）：`src/` 下的白名单 + asar 体积上界。
 *
 * 为什么需要它：`package.json` 的 `files` 里 `src/**\/*` 是**通配** —— `src/` 下的**任何**
 * 多余目录/备份都会被打进 asar。M19 补的三条排除（`!src/backend/deps/**`、`!src/**\/*.ts`、
 * `!src/client/ui-app/**`）是**黑名单**：它只验证「已知的冗余不在」，验证不了「不该在的不在」。
 * 做 N21 的 A/B 时把 `src/client/ui-dist` 改名成同级的 `src/client/ui-dist.bak`，它被照常打进
 * 包（约 +12MB），而那三条断言**全部照绿**。同类触发面：编辑器/同步工具留下的 `*.orig`/`*.bak`、
 * 临时导出目录、被 gitignore 的构建中间产物。
 *
 * 两道保险：
 *   ① 结构：`src/**` 下只允许出现白名单里的子树/文件（黑名单之外的那半边）；
 *   ② 体积：asar 总字节数落在 [下界, 上界] 内 —— 抓「白名单内的子树里被塞进大块冗余」
 *      （例如某个目录里又复制了一份前端产物），这类问题结构规则看不见。
 *
 * 为什么单独成模块：packaged-smoke 只在有打包产物时才能跑，而这些规则要能在单测里
 * 直接喂假数据/假产物（见 `src/backend/tests/packaging-content.spec.ts`），也必须能在
 * **打包之前**对工作树跑一遍（同一份规则、两个数据源），否则「放一个 .bak」这类问题
 * 只能等下一次打包才暴露。
 *
 * 白名单是「允许存在」，不是「会在包里」：`src/client/ui-app/**`、`src/backend/deps/**`
 * 这些**允许在源码树上**（也在包里被排除），排除本身由 packaged-smoke 的黑名单断言守着。
 * 有意新增打包内容时，把路径加进下面的清单即可（报错信息里也写了这一句）。
 */

const fs = require('node:fs');
const path = require('node:path');

/** asar 体积上界：30 MiB = 31,457,280 B，对基线 24,033,395 B（22.92 MiB，N21 打包）是 1.31×。 */
const MAX_ASAR_BYTES = 30 * 1024 * 1024;
/**
 * asar 体积下界：纯上界断言在「读不到大小」（0 字节、读错文件）时**恒真**，
 * 所以下界是防空转的那一半 —— 一个真实包不可能小于 10 MiB（内含 node_modules 与前端产物）。
 */
const MIN_ASAR_BYTES = 10 * 1024 * 1024;

/** 允许出现在 `src/` 下的目录前缀（含其全部后代）。 */
const ALLOWED_SRC_DIR_PREFIXES = [
  'src/backend/',                 // 宿主层与后端包（deps/*.ts/ui-app 的排除由黑名单断言负责）
  'src/client/ui-app/',           // 前端源码：明确不进包（黑名单断言守着），但允许在源码树上
  'src/client/ui-dist/',          // 前端构建产物：渲染进程实际加载的那份
  'src/client/ui-primitives-shim/',
  'src/client/ui-wechat/',
  'src/license/',
];

/** 允许出现在 `src/` 下的非目录条目（精确匹配）。 */
const ALLOWED_SRC_FILES = [
  'src/client/README.md',
  'src/index.html',               // ui-dist 缺失时的演示页兜底（N21）
  'src/renderer.js',
  'src/styles.css',
];

/**
 * 残留物判定：白名单子树**内部**也要拦。`src/client/ui-dist/index.html.orig`
 * 这种既在允许的子树里、又不是构建产物的东西，只有这条规则看得见。
 * 逐段（按 `/` 切）判断，段名以备份后缀结尾、或以 `tmp-`/`.tmp`/`.bak` 起头都算残留。
 */
const STRAY_SUFFIX_RE = /(?:\.bak|\.orig|\.old|\.rej|\.swp|~)$/i;
const STRAY_PREFIX_RE = /^\.?(?:tmp|bak)[-.]/i;

function isStrayName(entry) {
  for (const seg of entry.split('/')) {
    if (STRAY_SUFFIX_RE.test(seg)) return true;
    if (STRAY_PREFIX_RE.test(seg)) return true;
  }
  return false;
}

/** 条目路径归一化：统一正斜杠、去掉前导斜杠与结尾斜杠（asar 用反斜杠，磁盘用 `path.join`）。 */
function normalizeEntry(p) {
  return String(p).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function isAllowedSrcPath(entry) {
  for (const file of ALLOWED_SRC_FILES) if (entry === file) return true;
  for (const prefix of ALLOWED_SRC_DIR_PREFIXES) {
    const dir = prefix.slice(0, -1);
    // 允许的子树本身、子树的后代，以及**它们一路上溯的父目录**（`src`、`src/client` 这类
    // 目录条目在 asar 里也存在，不属于「多余目录」）。
    if (entry === dir || entry.startsWith(prefix) || prefix.startsWith(`${entry}/`)) return true;
  }
  return false;
}

/**
 * 结构断言：`src/**` 下的每个条目都必须在白名单内。
 * @param {string[]} entries 归一化前的路径列表（asar 的 `listPackage()` 输出或磁盘相对路径）。
 * @returns {{ entry: string, rule: string, hint: string }[]} 违规条目（空数组 = 通过）。
 */
function srcEntryViolations(entries) {
  const out = [];
  for (const raw of entries) {
    const entry = normalizeEntry(raw);
    if (!entry || !entry.startsWith('src/')) continue;
    if (isStrayName(entry)) {
      out.push({
        entry,
        rule: 'stray',
        hint: '备份/临时残留不该出现在 src/ 下（会被 `src/**/*` 打进包）',
      });
      continue;
    }
    if (isAllowedSrcPath(entry)) continue;
    out.push({
      entry,
      rule: 'allowlist',
      hint: '不在 src/ 白名单内；若确属有意新增的打包内容，' +
        '请加进 scripts/package-content-rules.js 的 ALLOWED_SRC_DIR_PREFIXES / ALLOWED_SRC_FILES',
    });
  }
  return out;
}

/** 体积断言：asar 总字节数必须落在 [MIN, MAX] 内。 */
function asarSizeViolations(bytes) {
  const out = [];
  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (!(typeof bytes === 'number' && bytes > 0)) {
    out.push({ rule: 'size-floor', detail: `asar 字节数读取无效（${JSON.stringify(bytes)}）—— 请检查产物路径` });
    return out;
  }
  if (bytes < MIN_ASAR_BYTES) {
    out.push({ rule: 'size-floor', detail: `${mb(bytes)} < 下界 ${mb(MIN_ASAR_BYTES)}（读错文件或包不完整）` });
  }
  if (bytes > MAX_ASAR_BYTES) {
    out.push({
      rule: 'size-ceiling',
      detail: `${mb(bytes)} > 上界 ${mb(MAX_ASAR_BYTES)}（=${MAX_ASAR_BYTES} B；基线 24,033,395 B 的 1.31×）`,
    });
  }
  return out;
}

/**
 * 工作树清单：`src/` 下的全部条目（目录本身也算一条，否则「多余的整个目录」会被漏掉）。
 * 读不到目录时返回空数组 —— 调用方必须断言结果非空（防空转），这里不自己抛。
 *
 * `prefix` 必须传「相对仓库根的那一段」（这里就是 `src`）：白名单里的路径都是相对仓库根的，
 * 少了前缀会让全部条目都因 `startsWith('src/')` 不成立而被跳过 —— 那种检查会「静默全绿」。
 * @param {string} rootDir 要遍历的目录。
 * @param {string} prefix 该目录相对仓库根的 POSIX 前缀（如 `src`）。
 */
function collectDiskEntries(rootDir, prefix) {
  const out = [];
  const root = path.normalize(String(prefix || '')).replace(/\\/g, '/').replace(/\/+$/, '');
  const walk = (dir, rel) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      out.push(childRel);
      if (item.isDirectory()) walk(path.join(dir, item.name), childRel);
    }
  };
  walk(rootDir, root);
  return out;
}

module.exports = {
  MAX_ASAR_BYTES,
  MIN_ASAR_BYTES,
  ALLOWED_SRC_DIR_PREFIXES,
  ALLOWED_SRC_FILES,
  isStrayName,
  normalizeEntry,
  srcEntryViolations,
  asarSizeViolations,
  collectDiskEntries,
};
