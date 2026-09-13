#!/usr/bin/env node
'use strict';

/**
 * 重建「微信+」后端 bundle（src/backend/wechat-data/lib/index.js）。
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
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const pkgRoot = path.join(root, 'src', 'backend', 'wechat-data');
const entry = path.join(pkgRoot, 'src', 'index.ts');
const outfile = path.join(pkgRoot, 'lib', 'index.js');

async function main() {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    outfile,
    logLevel: 'info',
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
  const out = result.metafile.outputs[outfile];
  const kb = out ? Math.round(out.bytes / 1024) : 0;
  console.log(`\n✅ 后端 bundle 已重建: ${path.relative(root, outfile)} (${kb} KB)`);
}

main().catch((e) => {
  console.error('❌ 构建失败:', e && e.message ? e.message : e);
  process.exit(1);
});
