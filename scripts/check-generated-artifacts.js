#!/usr/bin/env node
'use strict';

/**
 * 不碰工作树地检查后端 bundle 与 `lib/types/**` 是否和当前源码一致。
 *
 * 旧门禁是“在仓库里重建，再 `git diff --exit-code`”。它有两个问题：
 *   1. 检查本身会先改掉工作树里的生成文件，失败后留下半成品；
 *   2. 脏工作树会把无关改动混进 `git diff`，无法判断“产物过期”和“用户自己的改动”。
 *
 * 这里把 esbuild / tsc 都输出到临时目录，再逐文件比对字节。比对对象是**当前工作树**，
 * 因此提交前的源码/产物是否一致不再依赖 Git 索引是否干净。
 *
 * 用法：
 *   node scripts/check-generated-artifacts.js --backend
 *   node scripts/check-generated-artifacts.js --types
 *   node scripts/check-generated-artifacts.js --all
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildBundle } = require('./build-wechat-bundle.js');

const ROOT = path.resolve(__dirname, '..');
const PKG_ROOT = path.join(ROOT, 'src', 'backend', 'wechat-data');
const LIB_ROOT = path.join(PKG_ROOT, 'lib');
const TYPES_ROOT = path.join(LIB_ROOT, 'types');
const TYPES_CONFIG = path.join(PKG_ROOT, 'tsconfig.types.json');
const BACKEND_PATHS = ['index.js', 'net/fetch-retry.js'];
const MAX_REPORTED_DIFFS = 60;

function parseMode(argv) {
  const mode = argv[2];
  if (mode === '--backend' || mode === '--types' || mode === '--all') return mode.slice(2);
  if (!mode) return 'all';
  throw new Error(`未知模式: ${mode}（可用 --backend / --types / --all）`);
}

/** 递归列出目录里的文件，返回按 `/` 分隔、字典序的相对路径。 */
function listFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(path.relative(rootDir, abs).split(path.sep).join('/'));
    }
  };
  walk(rootDir);
  return out.sort();
}

function fileBytes(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file);
}

/**
 * 比较一组**指名文件**。后端 bundle 只关心两份产物，不能把 lib 下随包生成的
 * `typert.*` 等无关文件也当成“多余产物”。
 */
function compareNamedFiles(relativePaths, actualRoot, generatedRoot, label) {
  const missing = [];
  const extra = [];
  const changed = [];
  for (const rel of relativePaths) {
    const actual = fileBytes(path.join(actualRoot, ...rel.split('/')));
    const generated = fileBytes(path.join(generatedRoot, ...rel.split('/')));
    if (generated === null) missing.push(`${rel}（构建没有产出）`);
    else if (actual === null) missing.push(`${rel}（工作树缺失）`);
    else if (!generated.equals(actual)) changed.push(rel);
  }
  return { label, missing, extra, changed };
}

/** 比较整棵目录，用于 tsc 生成的 `lib/types/**`（多出或缺失都必须算不一致）。 */
function compareTrees(actualRoot, generatedRoot, label) {
  const actual = listFiles(actualRoot);
  const generated = listFiles(generatedRoot);
  const actualSet = new Set(actual);
  const generatedSet = new Set(generated);
  const missing = generated.filter((rel) => !actualSet.has(rel));
  const extra = actual.filter((rel) => !generatedSet.has(rel));
  const changed = generated
    .filter((rel) => actualSet.has(rel))
    .filter((rel) => !fileBytes(path.join(generatedRoot, ...rel.split('/'))).equals(
      fileBytes(path.join(actualRoot, ...rel.split('/'))),
    ));
  return { label, missing, extra, changed };
}

async function checkBackend(tempRoot) {
  const generatedRoot = path.join(tempRoot, 'backend-lib');
  await buildBundle({ outdir: generatedRoot, log: false });
  return compareNamedFiles(BACKEND_PATHS, LIB_ROOT, generatedRoot, '后端 bundle');
}

function checkTypes(tempRoot) {
  const generatedRoot = path.join(tempRoot, 'types');
  const tsc = require.resolve('typescript/lib/tsc.js');
  const result = spawnSync(process.execPath, [
    tsc,
    '-p',
    TYPES_CONFIG,
    '--outDir',
    generatedRoot,
    '--pretty',
    'false',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`生成 lib/types 失败（退出码 ${String(result.status)}）${detail ? `\n${detail}` : ''}`);
  }
  return compareTrees(TYPES_ROOT, generatedRoot, '后端类型声明');
}

function renderDiff(diff) {
  const lines = [];
  const add = (prefix, items) => {
    if (!items.length) return;
    const shown = items.slice(0, MAX_REPORTED_DIFFS);
    for (const item of shown) lines.push(`  ${prefix} ${item}`);
    if (items.length > shown.length) lines.push(`  ${prefix} ... 另有 ${String(items.length - shown.length)} 项`);
  };
  add('缺失', diff.missing);
  add('多余', diff.extra);
  add('不一致', diff.changed);
  return lines.join('\n');
}

async function main() {
  const mode = parseMode(process.argv);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-generated-check-'));
  const results = [];
  try {
    if (mode === 'backend' || mode === 'all') results.push(await checkBackend(tempRoot));
    if (mode === 'types' || mode === 'all') results.push(checkTypes(tempRoot));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  let failed = false;
  for (const diff of results) {
    const mismatches = diff.missing.length + diff.extra.length + diff.changed.length;
    if (mismatches === 0) {
      console.log(`✅ ${diff.label}与当前源码一致`);
    } else {
      failed = true;
      console.error(`❌ ${diff.label}与当前源码不一致：\n${renderDiff(diff)}`);
    }
  }
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌ 生成物一致性检查失败: ${error && error.message ? error.message : error}`);
    process.exit(1);
  });
}

module.exports = {
  BACKEND_PATHS,
  MAX_REPORTED_DIFFS,
  compareNamedFiles,
  compareTrees,
  listFiles,
  parseMode,
};
