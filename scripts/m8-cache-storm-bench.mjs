#!/usr/bin/env node

/**
 * M8 基准：一次实时同步事件会引发多少「分片元数据重算」。
 *
 * 背景：`meta.ts` 的缓存条目按所读文件的 mtime+size 自失效，但 `shardCatalogDirs` 的条目是
 * 「整份目录一条」，签名由所有分片拼成 —— 于是任何一个分片变了都会让整条失效、把**全部**
 * 分片重新 `loadShardMeta`（开库 + 读 Name2Id + 列 `Msg_%` 表 + 逐表 PRAGMA）。
 * 改造前 `gateway.ts` 每次事件还会 `invalidateWechatMeta()` 整体清空，等价的代价就是
 * 「清空后第一次查询」；改造后只有真正变了的那个分片重载（`shardMetaOf`）。
 *
 * 本脚本对**真实数据**只做 mtime 变更（不碰数据字节），并在 finally 里复原。
 *
 * 用法：
 *   node scripts/m8-cache-storm-bench.mjs
 *   M8_DATA_DIR=<解密数据根> node scripts/m8-cache-storm-bench.mjs
 *
 * 注意两点（避免把数字读成别的意思）：
 *   ① catalog 只纳入**通过过滤器**的分片（排除 fts/resource/wal 等），所以「进入 catalog 的
 *      文件数」通常小于目录里的 .db 数；
 *   ② 这只量了分片元数据这一层。改造前的事件还会丢掉 `contact-meta` 等条目（冷重载几毫秒），
 *      而且**宿主结果缓存**那层被整体清空的代价是另一个量级（单个图片/视频解析要全量扫描，
 *      注释记着实测 12–21 秒）—— 本脚本不覆盖那层。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.M8_DATA_DIR
  || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'super-time-electron', 'wechat-data', 'decrypted');

const metaPath = path.join(here, 'src', 'backend', 'wechat-data', 'src', 'query', 'meta.ts');
if (!fs.existsSync(dataDir)) {
  console.error('❌ 找不到解密数据根：' + dataDir + '\n   用 M8_DATA_DIR 指定。');
  process.exit(2);
}

// Node 22.18+/23+ 默认支持 TS 类型剥离；meta.ts 只依赖 node: 内建模块，可以直接 import。
const meta = await import(pathToFileURL(metaPath).href);

const msgDir = path.join(dataDir, 'message');
const allDb = fs.readdirSync(msgDir).filter((f) => f.endsWith('.db'));
const shards = meta.shardCatalog(dataDir);
console.log(`目录里的 .db：${allDb.length} 个；其中进入 catalog 的：${shards.length} 个`);
console.log(`数据根：${dataDir}`);

const now = () => Number(process.hrtime.bigint()) / 1e6;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = (xs) => `中位 ${median(xs).toFixed(1)}ms  (${xs.map((x) => x.toFixed(1)).join(' / ')})`;

// ① 旧行为：事件里整体清空 → 下一次查询重载全部分片
const cold = [];
for (let i = 0; i < 5; i += 1) {
  meta.invalidateWechatMeta();
  const t0 = now();
  meta.shardCatalog(dataDir);
  cold.push(now() - t0);
}

// ② 无变更
const warm = [];
for (let i = 0; i < 5; i += 1) {
  const t0 = now();
  meta.shardCatalog(dataDir);
  warm.push(now() - t0);
}

// ③ 新行为：只有一个分片真的变了 → 只有它重载
const target = path.join(msgDir, shards[0].file.split(/[\\/]/).pop());
const st = fs.statSync(target);
const one = [];
try {
  for (let i = 0; i < 5; i += 1) {
    const t = new Date(Date.now() + 1000 + i * 1000);
    fs.utimesSync(target, t, t);
    const t0 = now();
    meta.shardCatalog(dataDir);
    one.push(now() - t0);
  }
} finally {
  fs.utimesSync(target, st.atime, st.mtime); // 无论如何都复原
}

// ④ 模拟「面板在 N 个事件后各查询一次」的总代价
const EVENTS = 10;
meta.invalidateWechatMeta();
meta.shardCatalog(dataDir); // 预热
let t0 = now();
for (let i = 0; i < EVENTS; i += 1) {
  meta.invalidateWechatMeta(); // 旧策略的事件处理
  meta.shardCatalog(dataDir);
}
const oldTotal = now() - t0;

t0 = now();
try {
  for (let i = 0; i < EVENTS; i += 1) {
    const t = new Date(Date.now() + 10_000 + i * 1000);
    fs.utimesSync(target, t, t); // 新策略：事件里有一个分片真的变了
    meta.shardCatalog(dataDir);
  }
} finally {
  fs.utimesSync(target, st.atime, st.mtime);
}
const newTotal = now() - t0;

console.log('① 清空后查询（旧行为每次事件的代价）:', fmt(cold));
console.log('② 无变更查询                        :', fmt(warm));
console.log('③ 单分片变更（新行为）              :', fmt(one));
console.log(`④ ${EVENTS} 个事件的总代价：旧 ${oldTotal.toFixed(1)}ms → 新 ${newTotal.toFixed(1)}ms（约 ${(oldTotal / Math.max(newTotal, 0.001)).toFixed(1)}×）`);
console.log(`\n单分片重载 ≈ 全量重载 / catalog 文件数 = ${(median(cold) / shards.length).toFixed(1)}ms，与实测 ${median(one).toFixed(1)}ms 对比即可看出分片粒度是否生效。`);
console.log('提醒：这只量了元数据层；宿主结果缓存（单个图片解析 12–21 秒）那层的收益不在本脚本内。');
