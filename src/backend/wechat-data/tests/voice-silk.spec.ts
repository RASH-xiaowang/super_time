/**
 * N19 复审 E 项：silk 解码进程的**错误面**与**临时文件**。
 *
 * 复审在 `voice.ts` 里看到两处：① 失败时只报 `res.stderr || '解码器退出码 ' + status`，
 * 而 exe 起不来（ENOENT/EACCES）时 `status` 是 `null`、`stderr` 是空 —— 于是「二进制缺失」
 * 与「音频损坏」在日志里长得一模一样；② `silkToWav` 把 silk 写进缓存目录后**从不删除**
 * （本机 `decoded/voices` 下实测积了十余个 `.wx_silk_*.silk` 残留）。
 *
 * 这里用「env 钉一个不存在的 exe」把两条都跑到：路径由 `silkDecoderBin()` 原样返回
 * （钉住的路径不做存在性检查，是刻意行为），于是 `spawnSync` 必得 ENOENT —— 既证明
 * 错误信息取自 `res.error`，也证明执行确实走到了写临时文件之后那一步（否则下面那条
 * 「已清理」就是空转）。
 *
 * **未覆盖**：`spawnSync` 的 120s 上界。要验它得有一个会挂起的假解码器，单测里等 120 秒
 * 不现实（这个上界是兜「坏输入把后端 10 分钟调用窗口用光」，不是精度要求）。
 *
 * @vitest-environment node
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { silkToWav } from '../src/query/voice.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

const PIN = 'DSH_WECHAT_SILK_BIN'
let saved: string | undefined
beforeEach(() => {
  saved = process.env[PIN]
})
afterEach(() => {
  if (saved === undefined) delete process.env[PIN]
  else process.env[PIN] = saved
})

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'n19-silk-'))
  scratch.push(dir)
  return dir
}

/** 每个场景一个独立的、**必然跑不起来**的解码器路径。 */
function pinMissingExe(): void {
  process.env[PIN] = join(newDir(), 'missing', 'wx_silk.exe')
}

describe('silkToWav：起不来时报真实病因，且不留临时文件', () => {
  it('解码器不存在时错误信息带 ENOENT，而不是「解码器退出码 null」', () => {
    pinMissingExe()
    const res = silkToWav(Buffer.from('not a silk stream'), join(newDir(), 'voice.wav'))
    expect(res.ok).toBe(false)
    expect(String(res.error).toLowerCase()).toContain('enoent')
    // 防回退：只报退出码会把「缺二进制」和「音频坏了」混成同一条日志
    expect(String(res.error)).not.toContain('退出码')
  })

  it('临时 .silk 用完即删（原先会在缓存目录里积压）', () => {
    pinMissingExe()
    const dir = newDir()
    const res = silkToWav(Buffer.alloc(64, 1), join(dir, 'voice.wav'))
    expect(res.ok).toBe(false)
    // 这条是防空转的见证：只有真的走到了 spawnSync 才会拿到 ENOENT，
    // 而 writeFileSync 排在 spawnSync 之前 ⇒ 临时文件确实被创建过。
    expect(String(res.error).toLowerCase()).toContain('enoent')
    expect(readdirSync(dir).filter((f) => f.endsWith('.silk'))).toEqual([])
  })
})
