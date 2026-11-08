#!/usr/bin/env node
'use strict';

/**
 * 发行产物泄露门禁。
 *
 * 源码态扫描渲染/后端产物与入口脚本；打包态扫描 `app.asar` 与
 * `app.asar.unpacked`。任何 .map/TS/TSX/构建配置、敏感材料或自有脚本中的
 * sourceMappingURL/debugger 都会让发布失败。
 *
 * 用法：
 *   node scripts/check-release-artifacts.js --source
 *   node scripts/check-release-artifacts.js --packaged
 */
const fs = require('node:fs');
const path = require('node:path');
const { listPackage, extractFile } = require('@electron/asar');
const {
  entryViolations,
  textViolations,
  isOwnRuntimeScript,
  packagedLayoutViolations,
  unpackedOwnScriptViolations,
  formatViolations,
  normalizeEntry,
} = require('./release-hardening-rules.js');

const root = path.resolve(__dirname, '..');

function walkFiles(dir, relPrefix) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (current, rel) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      const abs = path.join(current, item.name);
      if (item.isDirectory()) walk(abs, childRel);
      else if (item.isFile()) out.push(childRel);
    }
  };
  walk(dir, relPrefix);
  return out;
}

function readText(abs) {
  return fs.readFileSync(abs, 'utf8');
}

/**
 * @electron/asar 在 Windows 上要求归档内路径使用反斜杠且没有前导分隔符。
 * listPackage() 返回的是 `\src\...`，而规则层会归一化成 `src/...`；读取时必须
 * 单独转换，不能把用于比较的规范路径直接传给 extractFile()。
 * @param {string} asarPath
 * @param {string} entry
 * @returns {Buffer}
 */
function readAsarEntry(asarPath, entry) {
  const relative = normalizeEntry(entry).split('/').join(path.sep);
  return extractFile(asarPath, relative);
}

function verifySource(rootDir = root, log = console.log) {
  const problems = [];
  const uiDist = path.join(rootDir, 'src', 'client', 'ui-dist');
  if (!fs.existsSync(path.join(uiDist, 'index.html'))) {
    problems.push({ entry: 'src/client/ui-dist', rule: 'missing-build', hint: '先运行 npm run build:ui' });
    return problems;
  }

  const uiEntries = walkFiles(uiDist, 'src/client/ui-dist');
  problems.push(...entryViolations(uiEntries));
  for (const rel of uiEntries.filter((x) => /\.(?:js|mjs|cjs|css)$/i.test(x))) {
    problems.push(...textViolations(rel, readText(path.join(rootDir, rel))));
  }

  for (const rel of ['main.js', 'preload.js']) {
    if (!fs.existsSync(path.join(rootDir, rel))) {
      problems.push({ entry: rel, rule: 'missing-entry', hint: '主进程入口缺失' });
      continue;
    }
    problems.push(...textViolations(rel, readText(path.join(rootDir, rel))));
  }

  const backendLib = path.join(rootDir, 'src', 'backend', 'wechat-data', 'lib');
  const backendEntries = walkFiles(backendLib, 'src/backend/wechat-data/lib');
  if (!backendEntries.includes('src/backend/wechat-data/lib/index.js')) {
    problems.push({ entry: 'src/backend/wechat-data/lib/index.js', rule: 'missing-build', hint: '先运行 npm run build:backend' });
  }
  problems.push(...entryViolations(backendEntries.filter((x) => /\.(?:map|js|mjs|cjs)$/i.test(x))));
  for (const rel of backendEntries.filter((x) => /\.(?:js|mjs|cjs)$/i.test(x))) {
    problems.push(...textViolations(rel, readText(path.join(rootDir, rel))));
  }
  log(`·  源码态：UI ${uiEntries.length} 项；后端 bundle ${backendEntries.length} 项`);
  return problems;
}

function verifyPackagedResources(resourcesDir, log = console.log) {
  const asarPath = path.join(resourcesDir, 'app.asar');
  if (!fs.existsSync(asarPath)) {
    return [{ entry: asarPath, rule: 'missing-asar', hint: '先运行 npm run pack' }];
  }

  const entries = listPackage(asarPath).map(normalizeEntry);
  if (entries.length === 0) {
    return [{ entry: asarPath, rule: 'empty-asar', hint: 'asar 列表为空，不能判定为通过' }];
  }

  const problems = [
    ...entryViolations(entries),
    ...packagedLayoutViolations(entries),
  ];

  for (const entry of entries.filter(isOwnRuntimeScript)) {
    let text = '';
    try {
      text = readAsarEntry(asarPath, entry).toString('utf8');
    } catch (e) {
      problems.push({ entry, rule: 'unreadable', hint: `无法读取自有脚本：${e?.message ?? e}` });
      continue;
    }
    problems.push(...textViolations(entry, text));
  }

  const unpackedPath = path.join(resourcesDir, 'app.asar.unpacked');
  if (fs.existsSync(unpackedPath)) {
    const unpacked = walkFiles(unpackedPath, 'app.asar.unpacked');
    problems.push(
      ...entryViolations(unpacked),
      ...unpackedOwnScriptViolations(unpacked),
    );
  }

  log(`·  打包态：asar ${entries.length} 项；自有脚本 ${entries.filter(isOwnRuntimeScript).length} 项`);
  return problems;
}

function verifyPackaged(rootDir = root, log = console.log) {
  return verifyPackagedResources(path.join(rootDir, 'dist', 'win-unpacked', 'resources'), log);
}

function main() {
  const args = process.argv.slice(2);
  const packaged = args.includes('--packaged');
  const source = args.includes('--source') || !packaged;
  const problems = [
    ...(source ? verifySource() : []),
    ...(packaged ? verifyPackaged() : []),
  ];

  if (problems.length > 0) {
    console.error(`❌ 发行产物门禁失败（${problems.length} 项）`);
    console.error(formatViolations(problems));
    if (problems.length > 20) console.error(`… 其余 ${problems.length - 20} 项已省略`);
    process.exit(1);
  }
  console.log(`✅ 发行产物门禁通过（${source ? '源码态' : ''}${source && packaged ? ' + ' : ''}${packaged ? '打包态' : ''}）`);
}

if (require.main === module) main();

module.exports = { readAsarEntry, verifySource, verifyPackaged, verifyPackagedResources };
