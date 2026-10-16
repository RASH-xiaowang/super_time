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

/**
 * asar 体积上界：64 MiB = 67,108,864 B，对基线 56,478,217 B（53.86 MiB，阶段 D 实测）是 1.19×。
 *
 * 基线为什么从 24,033,395 B（N21）涨到 56,478,217 B（+32.4MB）：阶段 D 接入了
 * PDF / Word / Excel 三个解析器（`pdfjs-dist` / `mammoth` / `xlsx`），它们是**运行期**
 * 依赖，必须随包发布。上界跟着抬，但**不比基线抬得更松** —— 仍留在 1.2× 以内，
 * 这样 N22 那个场景（一个 `ui-dist.bak` 之类的残留，约 +12MB）依旧会顶破上界被抓住。
 * 其中已经扣掉两处纯浪费（实测见 `working/d-asar-probe2.txt`）：
 *   · pdfjs 只留运行期要用的那几块（`legacy/build` + `cmaps` + `standard_fonts` + wasm）：
 *     33.17MB → 9.42MB，裁掉的是 `*.map`、非 legacy 的 `build/`、`web/`、`types/`；
 *   · pdfjs 的 optional 依赖 `@napi-rs/canvas` 整棵排除（36.5MB 的 win32 原生 canvas，
 *     本用途只 `getTextContent()`、从不 `render()`，实测移走后 23/23 解析用例仍全绿）。
 */
const MAX_ASAR_BYTES = 64 * 1024 * 1024;
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
  'src/shared/',                  // 后端 CommonJS 与前端 ESM 共用的纯数据模块
];

/** 允许出现在 `src/` 下的非目录条目（精确匹配）。 */
const ALLOWED_SRC_FILES = [
  'src/client/README.md',
  'src/index.html',               // ui-dist 缺失时的演示页兜底（N21）
  'src/renderer.js',
  'src/styles.css',
];

/**
 * 只允许出现在**工作树**、但不允许出现在 **asar** 里的 `src/` 子树。
 *
 * 与 `ALLOWED_SRC_DIR_PREFIXES` 的差别是关键：那张表回答的是「源码树里能不能有」，
 * 这张表回答的是「打包产物里能不能有」。`package.json#build.files` 仍以 `src/` 通配
 * 通配开头，因此排除规则漏一条，这些整棵树就会原样进 asar。
 */
const ASAR_FORBIDDEN_SRC_PREFIXES = [
  'src/backend/deps/',
  'src/client/ui-app/',
  'src/client/ui-primitives-shim/',
  'src/client/ui-wechat/',
];

/**
 * TypeScript 源后缀。`.d.ts` 也按 `.ts` 命中；`src/**\/*.ts` 这条旧排除只管住了 `.ts`，
 * 前端 `.tsx` 曾在 asar 里漏掉 145 个。
 */
const ASAR_FORBIDDEN_SRC_SUFFIX_RE = /\.tsx?$/i;

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
 * 打包产物层的**源码泄漏**断言：白名单结构检查允许工作树里有这些源码，但不能进 asar。
 *
 * 与 `srcEntryViolations` 的输入可能相同，但规则相反：那里查「工作树是否只含合法子树」，
 * 这里查「asar 是否混进了只该存在于开发态的前端源码/内联依赖/TS(X) 源」。
 * @param {string[]} entries asar `listPackage()` 输出或磁盘相对路径。
 * @returns {{ entry: string, rule: string, hint: string }[]}
 */
function asarSourceLeakViolations(entries) {
  const out = [];
  for (const raw of entries) {
    const entry = normalizeEntry(raw);
    if (!entry.startsWith('src/')) continue;
    const forbiddenPrefix = ASAR_FORBIDDEN_SRC_PREFIXES.find((prefix) =>
      entry.startsWith(prefix) || entry === prefix.slice(0, -1));
    if (forbiddenPrefix) {
      out.push({
        entry,
        rule: 'asar-source-tree',
        hint: `该子树只在开发态存在，运行时加载的是 ui-dist 或 lib/；` +
          `应由 package.json#build.files 的 !${forbiddenPrefix}** 排除`,
      });
      continue;
    }
    if (ASAR_FORBIDDEN_SRC_SUFFIX_RE.test(entry)) {
      out.push({
        entry,
        rule: 'asar-typescript-source',
        hint: 'TypeScript/TSX 源不得进 asar；运行时没有任何 TS 加载器',
      });
    }
  }
  return out;
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
      detail: `${mb(bytes)} > 上界 ${mb(MAX_ASAR_BYTES)}（=${MAX_ASAR_BYTES} B；基线 56,478,217 B 的 1.19×）`,
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

/**
 * **生产依赖闭包**：按 node_modules 的真实布局解析「生产依赖 + 全部传递依赖」的**包名集合**。
 *
 * 为什么要它：electron-builder 会把生产依赖树自动带进包 —— `files` 白名单管得住 `src/**`，
 * 管不住「某个依赖顺路带进来一个 135 MB 的兄弟包」。审计 §P2-6 ⑰ 实测 asar 196.65 MB，
 * 其中 `node_modules/onnxruntime-web/dist` **135.15 MB** 与 `@img/sharp-win32-x64` **18.50 MB**
 * 都是 `@huggingface/transformers` 的传递依赖，而**没有一条正向规则列出过它们**。
 *
 * 解析顺序照 Node：先看 `fromDir/node_modules/<name>`，再逐级向上找。
 * 不含 devDependencies（它们不进包）。optionalDependencies 要算 —— 它们也在生产树里。
 *
 * @param {string} rootDir 仓库根。
 * @param {object} rootPkg 解析后的 package.json。
 * @returns {{ names: Set<string>, missing: string[] }} 闭包内的包名；以及解析不到（没装）的名字。
 */
function productionDepClosure(rootDir, rootPkg) {
  const names = new Set();
  const missing = [];
  const depsOf = (pkg) => [
    ...Object.keys((pkg && pkg.dependencies) || {}),
    ...Object.keys((pkg && pkg.optionalDependencies) || {}),
  ];
  const resolvePkgDir = (fromDir, name) => {
    let d = fromDir;
    for (;;) {
      const cand = path.join(d, 'node_modules', name);
      if (fs.existsSync(path.join(cand, 'package.json'))) return cand;
      const up = path.dirname(d);
      if (up === d) return null;
      d = up;
    }
  };
  const queue = depsOf(rootPkg).map((n) => [rootDir, n]);
  while (queue.length > 0) {
    const [fromDir, name] = queue.shift();
    if (names.has(name)) continue;
    const dir = resolvePkgDir(fromDir, name);
    if (dir === null) { missing.push(name); continue; }
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      missing.push(name);
      continue;
    }
    names.add(name);
    for (const n of depsOf(pkg)) queue.push([dir, n]);
  }
  return { names, missing };
}

/**
 * **不允许出现在生产依赖闭包里**的包（每条都写明为什么）。
 *
 * 判据是「名字在不在闭包里」，与打包 glob 无关 —— 名单里出现任何一个就说明有依赖
 * 顺路把大块头带进来了。**豁免要显式**：真要引入时，在这里给它写一条带理由的例外，
 * 而不是悄悄把断言删掉。
 */
const FORBIDDEN_IN_DEPS = [
  { name: 'onnxruntime-web', why: 'wasm/js 构建形态，Node 侧用不上（node 构建只 require onnxruntime-node）——实测 135 MB' },
  { name: 'sharp', why: '图片处理，本用途只用分词器用不到它 ——连带 @img/sharp-win32-x64 的 libvips-42.dll 18.6 MB' },
  { name: '@img/sharp-win32-x64', why: 'sharp 的原生 libvips（18.6 MB）' },
];

/**
 * **必须**在生产依赖闭包里的包（少一个打包版就残废，而"体积下降"不会告诉你）。
 * 与 packaged-smoke 的「必需物仍在」是同一思路，但这条**不需要先打包**。
 */
const REQUIRED_IN_DEPS = [
  { name: 'onnxruntime-node', why: 'laya 本地推理的 ONNX 运行时' },
  { name: 'onnxruntime-common', why: 'onnxruntime-node 的兄弟包：dist/index.js 与 dist/binding.js 都无保护 require 它' },
  { name: '@huggingface/tokenizers', why: 'laya 的分词器（纯 JS、零依赖）' },
  { name: 'koffi', why: '读写目标进程内存（读取微信数据库密钥）' },
  { name: 'mammoth', why: 'Word（.docx）解析器 —— 知识库导入用' },
  { name: 'pdfjs-dist', why: 'PDF 解析器 —— 知识库导入用' },
  { name: 'unzipper', why: 'zip 解压 —— 备份恢复与知识库导入用' },
  { name: 'xlsx', why: 'Excel（.xlsx）解析器 —— 知识库导入用' },
];

/**
 * 对依赖闭包跑「禁用 + 必需」两条断言。返回违规清单（空数组 = 通过）。
 * @param {Set<string>} names 闭包内的包名。
 * @returns {{ rule: string, name: string, hint: string }[]}
 */
function depClosureViolations(names) {
  const out = [];
  for (const f of FORBIDDEN_IN_DEPS) {
    if (names.has(f.name)) {
      out.push({ rule: 'dep-forbidden', name: f.name, hint: `不该出现在生产依赖闭包里：${f.why}` });
    }
  }
  for (const r of REQUIRED_IN_DEPS) {
    if (!names.has(r.name)) {
      out.push({ rule: 'dep-required', name: r.name, hint: `生产依赖闭包里缺了它：${r.why}` });
    }
  }
  return out;
}

/**
 * 期望的 Remote 方法数：按目录扫 `gateway*.ts`，取全部 `@Remote('name')` 的**去重**集合大小。
 *
 * 为什么不能只读 `gateway.ts`：M21 把方法面拆成继承链之后，`gateway.ts` 是**空叶子**（装配层），
 * 方法壳都在基类文件里 —— 只读它数出的是 **0**，打包冒烟的「方法数」断言因此必然红，
 * 而那条冒烟只在 nightly / 发版前跑，没人当场发现（本次修复）。口径与
 * `scripts/gen-api-docs.js` 的 `GATEWAY_FILES` 一致：`/^gateway[a-z-]*\.ts$/` 扫目录，
 * 以后再拆一层也不用回来改。
 * @param {string} srcDir 后端包源码目录（`src/backend/wechat-data/src`）。
 * @returns {number} 去重后的方法数。
 */
function countRemoteMethods(srcDir) {
  const files = fs.readdirSync(srcDir).filter((f) => /^gateway[a-z-]*\.ts$/.test(f));
  const names = new Set();
  for (const f of files) {
    const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
    for (const m of text.matchAll(/@Remote\(\s*'([^']+)'\s*\)/g)) names.add(m[1]);
  }
  return names.size;
}

module.exports = {
  MAX_ASAR_BYTES,
  MIN_ASAR_BYTES,
  FORBIDDEN_IN_DEPS,
  REQUIRED_IN_DEPS,
  productionDepClosure,
  depClosureViolations,
  countRemoteMethods,
  ALLOWED_SRC_DIR_PREFIXES,
  ALLOWED_SRC_FILES,
  isStrayName,
  normalizeEntry,
  srcEntryViolations,
  asarSizeViolations,
  collectDiskEntries,
  ASAR_FORBIDDEN_SRC_PREFIXES,
  ASAR_FORBIDDEN_SRC_SUFFIX_RE,
  asarSourceLeakViolations,
};
