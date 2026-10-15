#!/usr/bin/env node
'use strict';

/**
 * 重建「Super Time」后端 bundle（src/backend/wechat-data/lib/index.js）。
 *
 * 为什么需要这个脚本：运行时（wechat-host.js）只 import lib/index.js 这一份产物，
 * 改了 src/**\/*.ts 不会生效 —— 上游用 tsdown 产 bundle，本地没有该工具链，
 * 这里用项目已有的 esbuild 复现同等产物。
 *
 * 关键约束（踩过的坑）：
 *   · 装饰器必须是 **TC39 语义**（不能开 experimentalDecorators）——@Remote()
 *     靠标准装饰器上下文注册方法，experimental 语义下注册不上，Remote 方法会全部消失。
 *   · `packages: 'external'`：只打包相对导入，裸模块（@deepseek-ai/*、fzstd、koffi…）
 *     留到运行时从 node_modules 解析 —— 与 wechat-host.js 自己 import 这些包的方式一致，
 *     也避免把原生模块（koffi）打进 bundle。
 *
 * 用法：node scripts/build-wechat-bundle.js
 */

const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const pkgRoot = path.join(root, 'src', 'backend', 'wechat-data');
const pkgSrc = path.join(pkgRoot, 'src');
const defaultOutdir = path.join(pkgRoot, 'lib');
const entry = path.join(pkgSrc, 'index.ts');
const outfile = path.join(defaultOutdir, 'index.js');
// 宿主层 `llm-http.js` 只需要重试原语，不该为一个 fetchWithRetry 冷加载整个
// 网关 bundle。这里把同一份 TS 实现再产出一个约 3KB 的独立 ESM 产物。
const fetchRetryEntry = path.join(pkgSrc, 'net', 'fetch-retry.ts');
const fetchRetryOutfile = path.join(defaultOutdir, 'net', 'fetch-retry.js');

/**
 * 从 esbuild 的 metafile 里取产物字节数（N3）。
 *
 * 为什么不能写成 `result.metafile.outputs[outfile]`：metafile 的键是**相对构建时 cwd 的
 * POSIX 路径**（`src/backend/wechat-data/lib/index.js`），而这里传进去的 `outfile` 是
 * **绝对 Windows 路径**（`D:\...\lib\index.js`）—— 两者永远匹配不上，`out` 恒为 undefined，
 * 于是构建日志长期同时打印「esbuild 自己的 `794.1kb`」和「本脚本的 `0 KB`」。
 * 体积统计失效比没有统计更糟：它看起来像「产物是空的」。
 *
 * 三级取值：① 原样键命中；② 把键 `path.resolve` 后与产物绝对路径比较（键可能是相对或绝对、
 * 正斜杠或反斜杠）；③ 兜底读磁盘 —— 文件刚写完，statSync 一定读得到真实大小，
 * 比再报一个 0 更不容易骗人（真读不到就抛，不静默报 0）。
 */
function outputBytes(metafile, outfile) {
  const outputs = (metafile && metafile.outputs) || {};
  const abs = path.resolve(outfile);
  if (outputs[outfile] && typeof outputs[outfile].bytes === 'number') return outputs[outfile].bytes;
  for (const [key, value] of Object.entries(outputs)) {
    if (!value || typeof value.bytes !== 'number') continue;
    if (path.resolve(key) === abs) return value.bytes;
  }
  return fs.statSync(abs).size;
}

/**
 * 把两份后端产物构建到指定目录。默认写回仓库，但一致性门禁会传临时目录，
 * 这样“检查是否过期”不会先把工作树里的生成文件改掉。
 *
 * @param {{ outdir?: string, log?: boolean }} [opts]
 * @returns {Promise<{ result: import('esbuild').BuildResult, outfile: string, fetchRetryOutfile: string }>}
 */
async function buildBundle(opts = {}) {
  const targetOutdir = opts.outdir || defaultOutdir;
  const targetOutfile = path.join(targetOutdir, 'index.js');
  const targetFetchRetryOutfile = path.join(targetOutdir, 'net', 'fetch-retry.js');
  const result = await esbuild.build({
    entryPoints: [entry, fetchRetryEntry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    outdir: targetOutdir,
    outbase: pkgSrc,
    logLevel: opts.log === false ? 'silent' : 'info',
    logLimit: 30,
    // 显式关闭 experimentalDecorators，走 TC39 标准装饰器（@Remote 依赖它）。
    tsconfigRaw: {
      compilerOptions: {
        target: 'ES2022',
        useDefineForClassFields: false,
        experimentalDecorators: false,
      },
    },
    metafile: true,
  });
  if (opts.log === false) return { result, outfile: targetOutfile, fetchRetryOutfile: targetFetchRetryOutfile };
  // 源码行数最多的产物，报体积时带上字节数，避免 KB 四舍五入后与 esbuild 的读数对不上时无从核对。
  for (const [label, output] of [
    ['后端 bundle', targetOutfile],
    ['宿主 fetch-retry bundle', targetFetchRetryOutfile],
  ]) {
    const bytes = outputBytes(result.metafile, output);
    console.log(`✅ ${label}已重建: ${path.relative(root, output)} (${(bytes / 1024).toFixed(1)} KB / ${bytes} B)`);
  }
  return { result, outfile: targetOutfile, fetchRetryOutfile: targetFetchRetryOutfile };
}

async function main() {
  await buildBundle();
}

// 只在直接执行时构建：单测要 require 本模块拿 outputBytes，不能被构建副作用带走。
if (require.main === module) {
  main().catch((e) => {
    console.error('❌ 构建失败:', e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = {
  buildBundle,
  outputBytes,
  outfile,
  entry,
  fetchRetryEntry,
  fetchRetryOutfile,
};
