/**
 * Whisper models-dir migration and engine relocation.
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledWhisperAssetsDir, installWhisperEngine, migrateWhisperEngineDir, migrateWhisperModels, whisperDownloadModel, whisperEnginePath, whisperWriteRefusal } from '../src/query/whisper.ts'
import { asciiPathForWhisper } from '../src/query/voice-transcribe.ts'

/** Scratch dirs removed after each test. */
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** 目录不存在时给空表 —— 被闸门挡住的用例里「目录根本没建」与「里面没多出东西」是同一条判断。 */
function readdirIfExists(dir: string): string[] {
  try { return readdirSync(dir).sort() } catch { return [] }
}

/**
 * 「只可能由本轮测试建出来」的父目录，收尾时空着就删回去。
 * 为什么延到 `afterEach`：同一个 tick 里刚删掉子目录，Windows 上立刻删父目录会短暂 EPERM
 * （第一版就因此把 `src/wechat` 留在了仓库里 —— 空目录 git 不报，只有打包白名单判据看得见）。
 */
const emptyPrunes: string[] = []
function noteEmptyPrune(dir: string): void {
  if (!emptyPrunes.includes(dir)) emptyPrunes.push(dir)
}
/** 只删「空目录」：`rmSync` 对目录必须 recursive，非递归会抛 ERR_FS_EISDIR ⇒ 用 `rmdirSync`（非空抛 ENOTEMPTY，正好当守卫）。 */
function pruneIfEmpty(dir: string): void {
  try { rmdirSync(dir) } catch { /* 非空或不存在：不是这次建的，不碰 */ }
}
afterEach(() => {
  for (const dir of emptyPrunes.splice(0)) pruneIfEmpty(dir)
})

describe('migrateWhisperModels', () => {
  it('moves ggml models, the engine bin/ dir and top-level engine files, keeping existing targets', () => {
    const from = scratchDir('wx-w-')
    const to = scratchDir('wx-w-')
    mkdirSync(join(from, 'bin'), { recursive: true })
    writeFileSync(join(from, 'ggml-tiny.bin'), 'tiny')
    writeFileSync(join(from, 'ggml-small.bin'), 'small')
    writeFileSync(join(from, 'bin', 'whisper-cli.exe'), 'exe')
    writeFileSync(join(from, 'bin', 'ggml-cpu.dll'), 'dll')
    // engine files copied into the models-dir root by hand
    writeFileSync(join(from, 'whisper.exe'), 'top-exe')
    writeFileSync(join(from, 'llama.dll'), 'top-dll')
    // existing target must survive with its own content
    mkdirSync(join(to, 'bin'), { recursive: true })
    writeFileSync(join(to, 'bin', 'whisper-cli.exe'), 'keep')

    const res = migrateWhisperModels(from, to)

    expect(res.ok).toBe(true)
    expect(res.moved).toBe(5)
    expect(readdirSync(join(to, 'bin')).sort()).toEqual(['ggml-cpu.dll', 'whisper-cli.exe'])
    expect(readFileSync(join(to, 'bin', 'whisper-cli.exe'), 'utf8')).toBe('keep')
    expect(readFileSync(join(to, 'ggml-tiny.bin'), 'utf8')).toBe('tiny')
    expect(readFileSync(join(to, 'whisper.exe'), 'utf8')).toBe('top-exe')
    expect(readFileSync(join(to, 'llama.dll'), 'utf8')).toBe('top-dll')
    expect(existsSync(join(from, 'ggml-tiny.bin'))).toBe(false)
    expect(existsSync(join(from, 'bin'))).toBe(false)
    expect(existsSync(join(from, 'whisper.exe'))).toBe(false)
  })

  it('removes leftover zip artifacts and .engine-staging and is a no-op on empty/missing dirs', () => {
    const from = scratchDir('wx-w-')
    const to = scratchDir('wx-w-')
    writeFileSync(join(from, 'whisper-bin-x64.zip'), 'zip')
    writeFileSync(join(from, 'whisper-bin-x64.zip.part'), 'part')
    mkdirSync(join(from, '.engine-staging'), { recursive: true })
    writeFileSync(join(from, 'unrelated.txt'), 'keep')

    const res = migrateWhisperModels(from, to)

    expect(res.ok).toBe(true)
    expect(res.moved).toBe(0)
    expect(existsSync(join(from, 'whisper-bin-x64.zip'))).toBe(false)
    expect(existsSync(join(from, 'whisper-bin-x64.zip.part'))).toBe(false)
    expect(existsSync(join(from, '.engine-staging'))).toBe(false)
    expect(existsSync(join(from, 'unrelated.txt'))).toBe(true)

    const missing = scratchDir('wx-w-')
    expect(migrateWhisperModels(join(missing, 'nope'), to)).toEqual({ ok: true, moved: 0 })
    expect(migrateWhisperModels('', to)).toMatchObject({ ok: false })
    expect(migrateWhisperModels(to, to)).toMatchObject({ ok: true, moved: 0 })
  })
})

describe('migrateWhisperEngineDir', () => {
  it('moves the engine install dir and returns the relocated binary path', () => {
    const from = scratchDir('wx-w-')
    const to = scratchDir('wx-w-')
    const bin = join(from, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'whisper-cli.exe'), 'exe')
    writeFileSync(join(bin, 'ggml-cpu.dll'), 'dll')

    const relocated = migrateWhisperEngineDir(join(bin, 'whisper-cli.exe'), from, to)

    expect(relocated).toBe(join(to, 'bin', 'whisper-cli.exe'))
    expect(existsSync(join(to, 'bin', 'whisper-cli.exe'))).toBe(true)
    expect(existsSync(join(to, 'bin', 'ggml-cpu.dll'))).toBe(true)
    expect(existsSync(bin)).toBe(false)
  })

  it('maps backslash paths against a forward-slash fromDir and root-level engines', () => {
    const from = scratchDir('wx-w-')
    const to = scratchDir('wx-w-')
    const bin = join(from, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'whisper-cli.exe'), 'exe')
    writeFileSync(join(from, 'whisper-cli.exe'), 'root-exe')

    const nested = migrateWhisperEngineDir(join(bin, 'whisper-cli.exe'), from.replaceAll('\\', '/'), to)
    expect(nested).toBe(join(to, 'bin', 'whisper-cli.exe'))
    expect(existsSync(join(to, 'bin', 'whisper-cli.exe'))).toBe(true)

    const root = migrateWhisperEngineDir(join(from, 'whisper-cli.exe'), from, to)
    expect(root).toBe(join(to, 'whisper-cli.exe'))
    expect(existsSync(join(to, 'whisper-cli.exe'))).toBe(true)
  })

  it('leaves external engines and empty values untouched', () => {
    const from = scratchDir('wx-w-')
    const to = scratchDir('wx-w-')
    expect(migrateWhisperEngineDir('C:/other/whisper-cli.exe', from, to)).toBe('')
    expect(migrateWhisperEngineDir('', from, to)).toBe('')
    expect(migrateWhisperEngineDir(join(from, 'bin', 'whisper-cli.exe'), '', to)).toBe('')
  })

  it('relocates an engine in a Release/ layout subdir', () => {
    const from = scratchDir('wx-w-')
    const to = scratchDir('wx-w-')
    const release = join(from, 'whisper', 'Release')
    mkdirSync(release, { recursive: true })
    writeFileSync(join(release, 'whisper-cli.exe'), 'exe')
    writeFileSync(join(release, 'llama.dll'), 'dll')

    const relocated = migrateWhisperEngineDir(join(release, 'whisper-cli.exe'), from, to)

    expect(relocated).toBe(join(to, 'whisper', 'Release', 'whisper-cli.exe'))
    expect(existsSync(join(to, 'whisper', 'Release', 'whisper-cli.exe'))).toBe(true)
    expect(existsSync(join(to, 'whisper', 'Release', 'llama.dll'))).toBe(true)
    expect(existsSync(release)).toBe(false)
  })
})

describe('whisperEnginePath', () => {
  it('does not treat an empty bin/ dir as an installed engine', () => {
    const dir = scratchDir('wx-w-')
    mkdirSync(join(dir, 'bin'), { recursive: true })
    expect(whisperEnginePath('', dir)).toBe('')
  })

  it('finds an engine extracted into a subdir (Release/ layout) and skips staging dirs', () => {
    const dir = scratchDir('wx-w-')
    mkdirSync(join(dir, 'whisper', 'Release'), { recursive: true })
    writeFileSync(join(dir, 'whisper', 'Release', 'whisper-cli.exe'), 'exe')
    mkdirSync(join(dir, '.engine-staging', 'Release'), { recursive: true })
    writeFileSync(join(dir, '.engine-staging', 'Release', 'whisper-cli.exe'), 'staging')

    expect(whisperEnginePath('', dir)).toBe(join(dir, 'whisper', 'Release', 'whisper-cli.exe'))
  })
})

describe('asciiPathForWhisper', () => {
  it('aliases non-ASCII files to an ASCII junction and leaves ASCII paths alone', () => {
    const nonAscii = scratchDir('语音转写测试-')
    const aliasBase = scratchDir('wpa-test-')
    writeFileSync(join(nonAscii, 'a.bin'), 'data')

    const aliased = asciiPathForWhisper(join(nonAscii, 'a.bin'), aliasBase)

    expect(aliased).not.toContain('语音')
    expect(aliased.startsWith(aliasBase)).toBe(true)
    expect(existsSync(aliased)).toBe(true)
    expect(readFileSync(aliased, 'utf8')).toBe('data')

    const ascii = join(aliasBase, 'plain.txt')
    expect(asciiPathForWhisper(ascii, aliasBase)).toBe(ascii)
  })
})

/**
 * 「只读目录不当写入目标」这一族（`whisperWriteRefusal` + 五个写入口的接线）。
 *
 * 起因记在审查报告 §六：`defaultWhisperModelsDir` 在数据根那个可写目录还没建好（或镜像失败）时
 * **会退回随包资产目录**。退回本身没错 —— 读预置的 tiny 模型不需要写权限；
 * 错的是这份「只读兜底」原先会被原样交给下载/安装/迁移：
 *   · 装到 Program Files ⇒ `mkdirSync` 抛 EACCES，用户在设置面板看到的是一句看不懂的错；
 *   · 开发态那个目录就是仓库里的 `src/wechat/whisper` ⇒ 一次模型下载能往仓库写进 1.5 GB。
 * 所以规则收在一处，写盘之前每个入口都问一次；这里既量规则，也量「闸门在第一次落盘之前」。
 */
describe('whisperWriteRefusal：随包只读目录不当写入目标', () => {
  it('规则：只读目录本身与其内部任何一层都拒', () => {
    const bundled = scratchDir('wx-bundled-')
    expect(whisperWriteRefusal(bundled, bundled)).toContain('只读')
    expect(whisperWriteRefusal(join(bundled, 'bin'), bundled), '子目录也要拒（原先只比相等）').toContain('只读')
    expect(whisperWriteRefusal(join(bundled, 'bin', '..', '..', 'elsewhere'), bundled), '跳出只读目录之外就不该拒（按路径段比，不比字符串前缀）').toBeNull()
    expect(whisperWriteRefusal(bundled + '-not-inside', bundled), '同前缀的兄弟目录不是"在里面"').toBeNull()
    expect(whisperWriteRefusal('', bundled)).toBe('没有给出模型目录')
    expect(whisperWriteRefusal('   ', bundled)).toBe('没有给出模型目录')
  })

  it('系统关键目录仍然拒（复用 path-policy 那把尺子，不另起一份黑名单）', () => {
    expect(whisperWriteRefusal('C:\Program Files\SuperTime\whisper', scratchDir('wx-bundled-'))).toContain('系统关键目录')
  })

  it('默认实参真的指向随包目录（否则上面那些用例量的是替身）', () => {
    const bundled = bundledWhisperAssetsDir()
    expect(bundled, '随包目录解析成空 ⇒ 默认实参那条线是恒真').not.toBe('')
    expect(whisperWriteRefusal(bundled)).toContain('只读')
    expect(whisperWriteRefusal(join(bundled, 'bin'))).toContain('只读')
    expect(whisperWriteRefusal(scratchDir('wx-writable-'))).toBeNull()
  })

  it('四个写入口：只读目录一律先拒，且一个字节都没落到盘上', async () => {
    const bundled = bundledWhisperAssetsDir()
    // 测试树里 `bundledWhisperAssetsDir()` 就是仓库下的 `src/wechat/whisper` —— 闸门漏了的时候
    // 写入侧会真的往这里建东西，所以先给整目录拍一张表，收尾逐字比对（见下面的 finally）。
    const listingBefore = readdirIfExists(bundled)
    noteEmptyPrune(bundled)
    noteEmptyPrune(dirname(bundled))
    // 四个探针路径都落在**真的**随包目录里（写入口拿不到 bundled 这个参数，只能真打）
    const tEngine = join(bundled, 'wx-no-write-engine')
    const tModel = join(bundled, 'wx-no-write-model')
    const tMigrate = join(bundled, 'wx-no-write-migrate')
    const tEngineDir = join(bundled, 'wx-no-write-engine-dir')
    const targets = [tEngine, tModel, tMigrate, tEngineDir]
    for (const t of targets) rmSync(t, { recursive: true, force: true })
    let progressCalls = 0
    const onProgress = (): void => { progressCalls += 1 }
    // 把出网钉死：闸门如果被拆掉，写入侧会一路走到下载 —— 那时既不该慢慢重试，
    // 也不该真的碰网络。计数而不是读日志，是「被拒的调用一次都不许出网」那类判据的同一把尺子。
    const realFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('被拒的目录不该走到下载')
    }) as unknown as typeof fetch
    try {
      const eng = await installWhisperEngine(tEngine, onProgress)
      expect(eng.ok, '只读目录被当成可写目录装了引擎').toBe(false)
      expect(eng.error).toContain('只读')
      const mdl = await whisperDownloadModel('turbo', tModel, onProgress)
      expect(mdl.ok).toBe(false)
      expect(mdl.error).toContain('只读')
      const from = scratchDir('wx-from-')
      writeFileSync(join(from, 'ggml-tiny.bin'), 'tiny')
      mkdirSync(join(from, 'bin'), { recursive: true })
      writeFileSync(join(from, 'bin', 'whisper-cli.exe'), 'exe')
      const mig = migrateWhisperModels(from, tMigrate)
      expect(mig.ok).toBe(false)
      expect(mig.error).toContain('只读')
      const binPath = join(from, 'bin', 'whisper-cli.exe')
      const moved = migrateWhisperEngineDir(binPath, from, tEngineDir)
      expect(moved, '引擎目录迁移也不许往只读位置搬').toBe('')
      expect(existsSync(binPath), '引擎被搬进了只读目录 ⇒ 源文件已经没了').toBe(true)
      // 被拒 ⇒ 目录根本没被创建（`mkdirSync` 排在闸门之后）
      for (const t of targets) {
        expect(existsSync(t), `只读目录里多出了一个 ${basename(t)} ⇒ 闸门没在写入之前`).toBe(false)
      }
      expect(readdirSync(from), '被拒之后不该顺手把源目录搬空').not.toEqual([])
      expect(progressCalls, '一次进度回调都没该发生（那是已经在下载了）').toBe(0)
      expect(fetchCalls, '被拒的调用出网了 ⇒ 闸门不在写入之前').toBe(0)
      expect(readdirIfExists(bundled), `随包目录的内容变了：${targets.join(' ')}`).toEqual(listingBefore)
    } finally {
      globalThis.fetch = realFetch
      for (const t of targets) rmSync(t, { recursive: true, force: true })
      // 父目录链也可能是被上一次运行建出来的（`mkdirSync(..., {recursive:true})` 的副作用；
      // 空目录 git 看不见 ⇒ `git status` 一片干净，只有 `packaging-content.spec.ts` 的 `src/`
      // 白名单判据会报）。所以这里**不看"原本在不在"**，一律"空则删回去"（里面有真东西就抛错、不碰）。
      pruneIfEmpty(bundled)
      pruneIfEmpty(dirname(bundled))
    }
  })

  it('接线：五个写入口都在第一次落盘之前问过这道闸', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/query/whisper.ts', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
    const WRITERS = ['installWhisperEngine', 'whisperDownloadModel', 'migrateWhisperModels', 'migrateWhisperEngineDir', 'seedBundledWhisper']
    expect(WRITERS.length, '写入口清单是空的 ⇒ 这条恒真').toBe(5)
    for (const name of WRITERS) {
      const at = src.indexOf(`function ${name}(`)
      expect(at, `找不到 function ${name}( ⇒ 它被改名或搬走，这条接线判据就瞎了`).toBeGreaterThan(-1)
      const body = src.slice(at, src.indexOf('\n}\n', at))
      const gate = body.indexOf('whisperWriteRefusal(')
      expect(gate, `${name} 没问过这道闸`).toBeGreaterThan(-1)
      const firstWrite = Math.min(...['mkdirSync(', 'moveItem(', 'createWriteStream(']
        .map((t) => (body.indexOf(t) < 0 ? Number.MAX_SAFE_INTEGER : body.indexOf(t))))
      expect(gate < firstWrite, `${name} 的闸门排在第一次落盘之后 —— 先写了再拒等于没拒`).toBe(true)
    }
  })
})
