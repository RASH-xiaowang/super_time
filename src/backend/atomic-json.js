'use strict';

/**
 * 宿主层 JSON 文件的原子写与损坏保护。
 *
 * 从 `wechat-paths.js` 抽出：路径配置、LLM 配置与后续任何宿主持久化模块都共用
 * 同一套 `tmp + rename`、损坏前备份与告警去重。单独成模块后，`wechat-paths.js`
 * 不再同时负责“文件系统原子性”和“业务配置形状”两件事。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖目标。
 *
 * 为什么不直接 writeFileSync：写一半被杀进程 / 磁盘满，目标文件会变成**截断的 JSON**。
 * 而 config.json 里既有数据根路径、也有微信设置镜像（历史上还放过解密密钥），
 * 读到截断内容会静默回落默认值 —— 用户看到的现象是「配置莫名其妙丢了」，
 * 而且**下一次保存就把残缺内容覆盖掉**，原始字节再也找不回来。
 * rename 在同一卷上是原子的：要么是旧文件，要么是完整的新文件。
 * @param {string} target - 目标文件绝对路径。
 * @param {string} text - 要写入的文本。
 */
function writeFileAtomic(target, text) {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  // rename 覆盖目标时，Windows 上**任何**持有目标的句柄都会让它 EPERM —— 不只是 SQLite：
  // 实测连密集 statSync 的瞬态句柄、杀软扫描、备份工具都算（M4 的结论）。
  // 一次瞬态占用不该让「保存配置」失败，所以做有界重试（最多 5 次 × 20ms）。
  let lastErr = null;
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e) {
      lastErr = e;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); } catch { /* 不支持就不等 */ }
    }
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原错误 */ }
  throw lastErr;
}

/** 已告警过的「损坏配置」指纹（路径+大小+修改时间），避免每次读配置都刷同一条。 */
const warnedCorrupt = new Set();

/**
 * 告警一次（同指纹只报一次）。
 * @param {string} file - 配置文件路径。
 * @param {Error} err - 解析/读取错误。
 */
function warnCorruptOnce(file, err) {
  if (err && err.code === 'ENOENT') return; // 首次运行，不告警
  let sig = file;
  try {
    const st = fs.statSync(file);
    sig = `${file}:${st.size}:${st.mtimeMs}`;
  } catch { /* 拿不到 stat 就用路径本身 */ }
  if (warnedCorrupt.has(sig)) return;
  warnedCorrupt.add(sig);
  console.warn(`[config] ${path.basename(file)} 读取/解析失败，本次使用默认值：${err && err.message ? err.message : err}（原文件保留，下次保存前会先备份）`);
}

/** 损坏备份的保留份数：超过就删最旧（备份里含完整密钥，不能让磁盘随损坏次数线性增长）。 */
const MAX_CORRUPT_BACKUPS = 3;
/** 备份文件名用的单调计数（同一毫秒内多次备份不能撞名）。 */
let corruptSeq = 0;

/**
 * 只保留最近 `MAX_CORRUPT_BACKUPS` 份损坏备份。
 * @param {string} target - 原文件绝对路径。
 */
function pruneCorruptBackups(target) {
  try {
    const dir = path.dirname(target);
    const prefix = path.basename(target) + '.corrupt-';
    const all = fs.readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of all.slice(MAX_CORRUPT_BACKUPS)) {
      try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* 删不掉就留着 */ }
    }
  } catch { /* 列目录失败不影响主流程 */ }
}

/**
 * 覆盖前先保住「解析不了的原文件」。
 *
 * 存在的意义：文件损坏时读取方只能回落到默认值，随后任何一次保存都会把
 * 默认值+补丁写回去 —— 残缺文件被无声覆盖。这里先把它改名留存（`.corrupt-<时间戳>`）
 * 并告警，用户/支持人员才有东西可查。
 * @param {string} target - 目标文件绝对路径。
 */
function preserveIfUnparseable(target) {
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch {
    return; // 不存在（首次运行）或读不到：无需处理
  }
  try {
    JSON.parse(text);
    return; // 能解析：正常覆盖
  } catch {
    // 后缀带 pid + 单调计数：只用 Date.now() 时同一毫秒内的多次备份会**静默互相覆盖**
    // （评审实测：3 次损坏只留下 1 份，最早的损坏内容丢了）。
    corruptSeq += 1;
    const backup = `${target}.corrupt-${Date.now()}-${process.pid}-${corruptSeq}`;
    try {
      fs.renameSync(target, backup);
      console.warn(`[config] ${path.basename(target)} 内容不是合法 JSON，已备份为 ${path.basename(backup)} 后重写`);
      pruneCorruptBackups(target);
    } catch (e) {
      console.warn(`[config] ${path.basename(target)} 损坏且无法备份：${e && e.message ? e.message : e}`);
    }
  }
}

module.exports = {
  writeFileAtomic,
  warnCorruptOnce,
  MAX_CORRUPT_BACKUPS,
  preserveIfUnparseable,
};
