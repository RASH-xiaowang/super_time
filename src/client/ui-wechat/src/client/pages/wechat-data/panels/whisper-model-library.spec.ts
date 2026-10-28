// @vitest-environment jsdom
/**
 * 语音模型库的可见契约：
 * · 六个真实 ggml 文件必须同时以卡片呈现，不能再藏进原生下拉；
 * · 已安装、当前选择、下载中三种状态必须能区分；
 * · 下载和停止按钮必须接到真实回调。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WHISPER_MODEL_FALLBACK } from './settings-common.tsx'
import { WhisperModelLibrary, type WhisperModelLibraryProps } from './whisper-model-library.tsx'

let host: HTMLDivElement
let root: Root

function model(id: string, installed = false): (typeof WHISPER_MODEL_FALLBACK)[number] {
  const found = WHISPER_MODEL_FALLBACK.find(item => item.id === id)
  if (found === undefined) throw new Error('missing model fixture: ' + id)
  return { ...found, installed }
}

function props(overrides: Partial<WhisperModelLibraryProps> = {}): WhisperModelLibraryProps {
  return {
    device: 'cpu',
    download: vi.fn(),
    downloading: null,
    models: [
      model('tiny', true),
      model('base'),
      model('small', true),
      model('medium'),
      model('large-v3'),
      model('turbo'),
    ],
    onCancel: vi.fn(),
    onSelect: vi.fn(),
    selected: 'small',
    ...overrides,
  }
}

function render(value = props()): WhisperModelLibraryProps {
  act(() => { root.render(createElement(WhisperModelLibrary, value)) })
  return value
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('WhisperModelLibrary', () => {
  it('同时渲染六张真实文件卡片，而不是原生下拉框', () => {
    render()

    expect(host.querySelector('select')).toBeNull()
    expect(host.querySelectorAll('[role="radio"]')).toHaveLength(6)
    expect([...host.querySelectorAll('[data-model-id]')].map(card => card.getAttribute('data-model-id')))
      .toEqual(['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'])

    for (const item of WHISPER_MODEL_FALLBACK) {
      expect(host.textContent).toContain(item.file)
    }
    expect(host.textContent).toContain('2/6 已下载')
    expect(host.querySelector('[data-model-id="small"]')?.getAttribute('class')).toContain('Selected')
    expect(host.querySelector('[data-model-id="tiny"]')?.getAttribute('data-installed')).toBe('true')
    expect(host.querySelector('[data-model-id="base"]')?.getAttribute('data-installed')).toBe('false')
  })

  it('未安装模型可直接下载，点击卡片可切换当前模型', () => {
    const controls = render()

    const baseCard = host.querySelector('[data-model-id="base"]')
    const download = [...(baseCard?.querySelectorAll('button') ?? [])]
      .find(button => button.textContent?.includes('下载'))
    expect(download).not.toBeUndefined()
    act(() => { download?.click() })
    expect(controls.download).toHaveBeenCalledWith({ id: 'base', name: 'Base' })

    const medium = host.querySelector('[data-model-id="medium"] [role="radio"]') as HTMLButtonElement | null
    expect(medium).not.toBeNull()
    act(() => { medium?.click() })
    expect(controls.onSelect).toHaveBeenCalledWith('medium')
  })

  it('下载中显示实时百分比和停止按钮，同排其它下载按钮禁用', () => {
    const controls = render(props({
      downloading: { model: 'base', file: 'ggml-base.bin', received: 50, total: 100 },
    }))

    const baseCard = host.querySelector('[data-model-id="base"]')
    expect(baseCard?.textContent).toContain('50%')
    const stop = [...(baseCard?.querySelectorAll('button') ?? [])]
      .find(button => button.textContent === '停止')
    expect(stop).not.toBeUndefined()
    act(() => { stop?.click() })
    expect(controls.onCancel).toHaveBeenCalledTimes(1)

    const mediumDownload = [...(host.querySelector('[data-model-id="medium"]')?.querySelectorAll('button') ?? [])]
      .find(button => button.textContent?.includes('请稍候'))
    expect(mediumDownload).not.toBeUndefined()
    expect(mediumDownload?.disabled).toBe(true)
  })
})
