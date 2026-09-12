/**
 * Whisper models-dir migration and engine relocation.
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateWhisperEngineDir, migrateWhisperModels, whisperEnginePath } from '../src/query/whisper.ts'
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
