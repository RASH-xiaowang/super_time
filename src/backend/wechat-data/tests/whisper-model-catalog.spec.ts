/**
 * The settings panel exposes exactly these six whisper.cpp artifacts. Keep
 * the UI catalog, download map and installed-state detector on one file map.
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WHISPER_DOWNLOAD_FILES,
  WHISPER_MODELS,
  whisperModelsStatus,
} from '../src/query/whisper.ts'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-catalog-'))
  scratch.push(dir)
  return dir
}

describe('whisper model catalog', () => {
  it('maps every selectable model to its real official ggml file', () => {
    expect(Object.fromEntries(WHISPER_DOWNLOAD_FILES)).toEqual({
      tiny: 'ggml-tiny.bin',
      base: 'ggml-base.bin',
      small: 'ggml-small.bin',
      medium: 'ggml-medium.bin',
      'large-v3': 'ggml-large-v3.bin',
      turbo: 'ggml-large-v3-turbo.bin',
    })
    expect(WHISPER_MODELS.map(model => model.id).sort()).toEqual(
      WHISPER_DOWNLOAD_FILES.map(([id]) => id).sort(),
    )
  })

  it('reports installed state by exact file, not a shared prefix', () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ggml-large-v3-turbo.bin'), Buffer.from('model'))

    const status = whisperModelsStatus(dir)
    expect(status.find(model => model.id === 'turbo')).toMatchObject({
      installed: true,
      file: 'ggml-large-v3-turbo.bin',
    })
    expect(status.find(model => model.id === 'large-v3')).toMatchObject({
      installed: false,
      file: 'ggml-large-v3.bin',
    })
  })
})
