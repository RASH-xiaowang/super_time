/**
 * JSON 落盘的原子写 + 「解析不了的原文件先留痕」。
 *
 * 为什么把它单独放成一层（M24）：这份能力被配置层（`config.json` / `secrets.json`）与
 * 上层共用；`keys/**` 也需要待在它上面而不能反向依赖 `query/**`，所以它必须在依赖图的
 * 最底下 —— 本文件不 import 包内任何模块。
 */

import { readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 同步小睡（写路径是同步的，只能这样让出一点时间给占用者释放句柄）。 */
function sleepMsSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 环境不支持 Atomics.wait 就不等：退化成「不重试」 */
  }
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖。
 *
 * 直接 writeFileSync 到目标路径时，写一半被杀进程/磁盘满会留下**截断的 JSON**；
 * 而 config.json 里有数据根路径与密钥字段，读到截断内容会静默回落默认值
 * （用户看到的是「配置莫名丢了」），且下一次保存就把残缺内容覆盖掉。
 * 宿主层 `src/backend/wechat-paths.js` 有一份等价实现（那边是 CJS，无法共享）。
 * @param target - 目标文件绝对路径。
 * @param text - 要写入的文本。
 */
export function writeFileAtomic(target: string, text: string): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  // rename 覆盖目标时，Windows 上**任何**持有目标的句柄都会让它 EPERM —— 不只是 SQLite：
  // 实测连密集 `statSync` 的瞬态句柄、杀软扫描、备份工具都算（这条正是 M4 的结论）。
  // 一次瞬态占用不该让「保存配置」失败，所以做有界重试（最多 5 次 × 20ms）。
  let lastErr: unknown = null
  for (let i = 0; i < 5; i += 1) {
    try {
      renameSync(tmp, target)
      return
    } catch (e) {
      lastErr = e
      sleepMsSync(20)
    }
  }
  try { rmSync(tmp, { force: true }) } catch { /* 清理失败不掩盖原错误 */ }
  throw lastErr
}

/** 损坏备份的保留份数：超过就删最旧（备份含完整密钥，不能让磁盘随损坏次数线性增长）。 */
const MAX_CORRUPT_BACKUPS = 3
/** 备份文件名用的单调计数（同一毫秒内多次备份不能撞名）。 */
let corruptSeq = 0

/**
 * 只保留最近 `MAX_CORRUPT_BACKUPS` 份损坏备份。
 * @param target - 原文件绝对路径。
 */
function pruneCorruptBackups(target: string): void {
  try {
    const dir = dirname(target)
    const prefix = basename(target) + '.corrupt-'
    const all = readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of all.slice(MAX_CORRUPT_BACKUPS)) {
      try { rmSync(join(dir, f), { force: true }) } catch { /* 删不掉就留着 */ }
    }
  } catch { /* 列目录失败不影响主流程 */ }
}

/**
 * 覆盖前先保住「解析不了的原文件」（改名成 `.corrupt-<时间戳>`）并告警。
 * 否则损坏文件会被默认值+补丁无声覆盖，事后无从追查。
 * @param target - 目标文件绝对路径。
 */
export function preserveIfUnparseable(target: string): void {
  let text: string
  try {
    text = readFileSync(target, 'utf8')
  } catch {
    return // 不存在（首次运行）或读不到
  }
  try {
    JSON.parse(text)
    return
  } catch {
    // 后缀带 pid + 单调计数：只用 Date.now() 时同一毫秒内的多次备份会静默互相覆盖
    corruptSeq += 1
    const backup = `${target}.corrupt-${Date.now()}-${process.pid}-${corruptSeq}`
    try {
      renameSync(target, backup)
      console.warn(`[config] ${basename(target)} 内容不是合法 JSON，已备份为 ${basename(backup)} 后重写`)
      pruneCorruptBackups(target)
    } catch (e) {
      console.warn(`[config] ${basename(target)} 损坏且无法备份：${(e as Error).message}`)
    }
  }
}
