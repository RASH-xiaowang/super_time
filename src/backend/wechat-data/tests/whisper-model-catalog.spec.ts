/**
 * whisper 模型清单：**界面提供的模型**、**下载文件映射**、**已安装判定**三者必须对齐。
 *
 * 2026-11-18 按中文准确率重排清单：
 *   · 下线 `tiny` / `base`（同音错字多，实测「授权→受权」「微信→微星」）；
 *   · 下线 `medium`（被 `large-v3-q5` 全面压制：体积 1.5 GB vs 1.0 GB，准确率更低）；
 *   · 新增 `turbo-q5` / `large-v3-q5`（q5_0 量化，精度接近 fp16 原版、体积约 1/3）。
 *
 * 这里钉住的核心不变量是**「下线 ≠ 失效」**：文件映射仍保留那三个 id，
 * 否则老配置（`whisper_model: 'medium'`）会突然变成「未知模型」而停摆。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WHISPER_DEFAULT_MODEL,
  WHISPER_DOWNLOAD_FILES,
  WHISPER_LEGACY_MODEL_FILES,
  WHISPER_MODEL_REPLACEMENTS,
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

const fileMap = (): Record<string, string> => Object.fromEntries(WHISPER_DOWNLOAD_FILES)

describe('whisper 模型清单（界面提供的）', () => {
  it('只有 5 个模型，且每个都指向真实的官方 ggml 文件', () => {
    expect(WHISPER_MODELS.map(model => model.id)).toEqual([
      'small', 'turbo-q5', 'turbo', 'large-v3-q5', 'large-v3',
    ])
    expect(fileMap()).toMatchObject({
      small: 'ggml-small.bin',
      'turbo-q5': 'ggml-large-v3-turbo-q5_0.bin',
      turbo: 'ggml-large-v3-turbo.bin',
      'large-v3-q5': 'ggml-large-v3-q5_0.bin',
      'large-v3': 'ggml-large-v3.bin',
    })
  })

  it('低准确率模型不再出现在界面清单里', () => {
    const shown = new Set(WHISPER_MODELS.map(model => model.id as string))
    for (const retired of ['tiny', 'base', 'medium']) {
      expect(shown.has(retired), `${retired} 已下线，不该再出现在产品清单`).toBe(false)
    }
  })

  it('默认模型是界面清单里的一个（不允许默认指向已下线的模型）', () => {
    expect(WHISPER_MODELS.some(model => model.id === WHISPER_DEFAULT_MODEL)).toBe(true)
    expect(WHISPER_DEFAULT_MODEL).toBe('turbo-q5')
  })
})

describe('下线模型的兼容层', () => {
  it('文件映射仍然保留：老配置里的 tiny/base/medium 不能变成「未知模型」', () => {
    expect(WHISPER_LEGACY_MODEL_FILES.map(([id]) => id)).toEqual(['tiny', 'base', 'medium'])
    expect(fileMap()).toMatchObject({
      tiny: 'ggml-tiny.bin',
      base: 'ggml-base.bin',
      medium: 'ggml-medium.bin',
    })
  })

  it('每个下线 id 都有建议替代，且替代仍在界面清单里', () => {
    const shown = new Set(WHISPER_MODELS.map(model => model.id as string))
    for (const [retired, replacement] of Object.entries(WHISPER_MODEL_REPLACEMENTS)) {
      expect(shown.has(retired), `${retired} 已下线，不该再被推荐`).toBe(false)
      expect(shown.has(replacement), `${retired} 的替代 ${replacement} 必须在清单里`).toBe(true)
    }
    expect(Object.keys(WHISPER_MODEL_REPLACEMENTS).sort()).toEqual(['base', 'medium', 'tiny'])
  })

  it('界面清单是下载映射的子集（多出来的是兼容层）', () => {
    const all = new Set(WHISPER_DOWNLOAD_FILES.map(([id]) => id))
    for (const model of WHISPER_MODELS) expect(all.has(model.id)).toBe(true)
    expect(WHISPER_DOWNLOAD_FILES.length).toBe(WHISPER_MODELS.length + WHISPER_LEGACY_MODEL_FILES.length)
  })
})

describe('已安装判定', () => {
  it('按精确文件名判定，前缀相同不算（turbo 不能把 large-v3 点亮）', () => {
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
    // 量化版是独立文件：装了 fp16 turbo 不等于装了 turbo-q5。
    expect(status.find(model => model.id === 'turbo-q5')).toMatchObject({ installed: false })
  })

  it('界面清单之外的已安装文件不会被列出来', () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ggml-medium.bin'), Buffer.from('model'))
    // medium 已下线：文件还在也不会出现在界面清单里。
    expect(whisperModelsStatus(dir).some(model => model.id === 'medium')).toBe(false)
  })
})
