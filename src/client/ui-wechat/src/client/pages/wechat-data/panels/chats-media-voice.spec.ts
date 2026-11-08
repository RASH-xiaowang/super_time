// @vitest-environment jsdom
/**
 * 语音播放的异步回包必须服从组件生命周期：卸载后不得再 new Audio，
 * 否则 data URL 解码出的媒体缓冲会脱离 React 节点继续常驻。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { MessageEmoticon, MessageVideo, MessageVoice, stopCurrentVoice } from './chats-media.tsx'

const mocks = vi.hoisted(() => ({
  apiGetEmoticonDataUrl: vi.fn(),
  apiGetImageDataUrl: vi.fn(),
  apiGetImageOriginal: vi.fn(),
  apiGetVideoInfo: vi.fn(),
  apiGetVoiceDataUrl: vi.fn(),
  apiGetVoiceInfo: vi.fn(),
  apiGetVoiceTranscript: vi.fn(),
  apiOpenPath: vi.fn(),
  apiExportChatVideo: vi.fn(),
  apiSaveFileDialog: vi.fn(),
  apiTranscribeVoiceMessage: vi.fn(),
  runtimeCapabilities: vi.fn(() => ({ isBrowser: false, desktopEquivalent: false })),
}))

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>()
  return { ...actual, ...mocks }
})

class FakeAudio {
  static instances: FakeAudio[] = []
  src = ''
  currentTime = 0
  ended = false
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  pause = vi.fn()
  load = vi.fn()
  play = vi.fn().mockResolvedValue(undefined)

  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = ''
  }
}

let host: HTMLDivElement
let root: Root
const originalAudio = window.Audio

function renderVoice(): void {
  const message = { localId: 7, serverId: '9223372036854775807', type: 34, isSender: 0, rich: { durationMs: 2000 } } as WechatMessage
  act(() => {
    root.render(createElement(MessageVoice, { m: message, selfName: 'wxid_self' }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  FakeAudio.instances = []
  Object.defineProperty(window, 'Audio', { configurable: true, value: FakeAudio })
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.apiGetVoiceInfo.mockResolvedValue({ available: true })
  mocks.apiGetVoiceTranscript.mockResolvedValue({})
  mocks.apiGetVoiceDataUrl.mockResolvedValue({ url: 'data:audio/wav;base64,AA==' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  Object.defineProperty(window, 'Audio', { configurable: true, value: originalAudio })
})

describe('MessageVoice 的异步音频清理', () => {
  it('取音频途中卸载：迟到的 data URL 不能再创建 Audio', async () => {
    let finish!: (value: { url: string }) => void
    mocks.apiGetVoiceDataUrl.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    renderVoice()
    await flush()

    const bubble = host.querySelector<HTMLElement>('[class*="msgVoiceBubble"]')
    expect(bubble).not.toBeNull()
    act(() => { bubble?.click() })

    act(() => { root.unmount() })
    host.remove()
    finish({ url: 'data:audio/wav;base64,AA==' })
    await flush()

    expect(FakeAudio.instances, '卸载后的语音请求仍创建了音频缓冲').toHaveLength(0)

    // 让 afterEach 仍有一个可安全卸载的 root。
    root = createRoot(host)
  })
})

describe('媒体加载态不显示项目专属文案', () => {
  it('视频请求未返回时只保留骨架', async () => {
    mocks.apiGetVideoInfo.mockImplementation(() => new Promise(() => {}))
    act(() => {
      root.render(createElement(MessageVideo, {
        m: { localId: 8, type: 43, isSender: 0, rich: { durationSec: 12 } } as WechatMessage,
        selfName: 'wxid_self',
      }))
    })
    await flush()

    expect(host.textContent).not.toContain('加载中')
    expect(host.querySelector('[class*="msgImageSkeleton"]')).not.toBeNull()
  })

  it('表情请求未返回时只保留空白骨架', async () => {
    mocks.apiGetEmoticonDataUrl.mockImplementation(() => new Promise(() => {}))
    act(() => {
      root.render(createElement(MessageEmoticon, {
        md5: '0123456789abcdef0123456789abcdef',
      }))
    })
    await flush()

    expect(host.textContent).not.toContain('加载中')
    expect(host.querySelector('[data-loading="true"]')).not.toBeNull()
    expect(host.innerHTML).not.toContain('0123456789abcdef0123456789abcdef')
  })
})

describe('MessageVideo', () => {
  it('封面入口连续打开视频都不会冒泡触发消息行分析', async () => {
    const parentClick = vi.fn()
    mocks.apiGetVideoInfo.mockResolvedValue({
      coverUrl: 'data:image/png;base64,AA==',
      videoPath: 'C:\\videos\\demo.mp4',
    })
    mocks.apiOpenPath.mockResolvedValue({ ok: true, path: 'C:\\videos\\demo.mp4' })
    act(() => {
      root.render(createElement(
        'div',
        { onClick: parentClick },
        createElement(MessageVideo, {
          m: { localId: 9, type: 43, isSender: 0, rich: { durationSec: 12 } } as WechatMessage,
          selfName: 'wxid_self',
        }),
      ))
    })
    await flush()

    const wrap = host.querySelector<HTMLElement>('[class*="msgVideoWrap"]')
    await act(async () => { wrap?.click() })
    await flush()
    await act(async () => { wrap?.click() })
    await flush()

    expect(mocks.apiOpenPath).toHaveBeenCalledTimes(2)
    expect(parentClick).not.toHaveBeenCalled()
  })

  it('无封面但仍可播放的入口同样不会冒泡', async () => {
    const parentClick = vi.fn()
    mocks.apiGetVideoInfo.mockResolvedValue({ videoPath: 'C:\\videos\\fallback.mp4' })
    mocks.apiOpenPath.mockResolvedValue({ ok: true, path: 'C:\\videos\\fallback.mp4' })
    act(() => {
      root.render(createElement(
        'div',
        { onClick: parentClick },
        createElement(MessageVideo, {
          m: { localId: 10, type: 43, isSender: 0, rich: { durationSec: 8 } } as WechatMessage,
          selfName: 'wxid_self',
        }),
      ))
    })
    await flush()

    const entry = host.querySelector<HTMLElement>('[class*="msgVoicelike"]')
    await act(async () => { entry?.click() })
    await flush()

    expect(mocks.apiOpenPath).toHaveBeenCalledWith('C:\\videos\\fallback.mp4')
    expect(parentClick).not.toHaveBeenCalled()
  })

  it('保存原视频走保存对话框与后端原文件导出，且不会冒泡', async () => {
    const parentClick = vi.fn()
    mocks.apiGetVideoInfo.mockResolvedValue({
      coverUrl: 'data:image/png;base64,AA==',
      videoPath: 'C:\\videos\\demo.mp4',
    })
    mocks.apiSaveFileDialog.mockResolvedValue({ canceled: false, path: 'C:\\exports\\demo.jpg' })
    mocks.apiExportChatVideo.mockResolvedValue({
      ok: true,
      path: 'C:\\exports\\demo.mp4',
      bytes: 32,
      format: 'mp4',
    })
    act(() => {
      root.render(createElement(
        'div',
        { onClick: parentClick },
        createElement(MessageVideo, {
          m: { localId: 11, type: 43, isSender: 0, rich: { durationSec: 3 } } as WechatMessage,
          selfName: 'wxid_self',
        }),
      ))
    })
    await flush()

    const save = host.querySelector<HTMLButtonElement>('button')
    await act(async () => { save?.click() })
    await flush()

    expect(mocks.apiSaveFileDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultName: '聊天视频-11.mp4',
      title: '保存聊天原视频',
    }))
    expect(mocks.apiExportChatVideo).toHaveBeenCalledWith(expect.objectContaining({
      username: 'wxid_self',
      localId: 11,
      dest: 'C:\\exports\\demo.jpg',
      jobId: expect.stringMatching(/^chat-video-/),
    }))
    expect(parentClick).not.toHaveBeenCalled()
  })
})

describe('voice message stable identity', () => {
  it('点击播放入口和转写按钮都不会冒泡触发消息行分析', async () => {
    const parentClick = vi.fn()
    const message = { localId: 7, serverId: '9223372036854775807', type: 34, isSender: 0, rich: { durationMs: 2000 } } as WechatMessage
    mocks.apiTranscribeVoiceMessage.mockResolvedValue({ ok: true, text: 'correct text' })
    act(() => {
      root.render(createElement(
        'div',
        { onClick: parentClick },
        createElement(MessageVoice, { m: message, selfName: 'wxid_self' }),
      ))
    })
    await flush()

    const bubble = host.querySelector<HTMLElement>('[class*="msgVoiceBubble"]')
    await act(async () => { bubble?.click() })
    await flush()

    const button = host.querySelector<HTMLButtonElement>('button')
    await act(async () => { button?.click() })
    await flush()

    expect(parentClick).not.toHaveBeenCalled()
  })

  it('passes the selected server_id to transcript reads, playback, and transcription', async () => {
    mocks.apiGetVoiceTranscript.mockResolvedValue({})
    mocks.apiTranscribeVoiceMessage.mockResolvedValue({ ok: true, text: 'correct text' })
    renderVoice()
    await flush()

    expect(mocks.apiGetVoiceTranscript).toHaveBeenCalledWith({
      username: 'wxid_self',
      localId: 7,
      svrId: '9223372036854775807',
    })

    const bubble = host.querySelector<HTMLElement>('[class*="msgVoiceBubble"]')
    await act(async () => { bubble?.click() })
    await flush()
    expect(mocks.apiGetVoiceDataUrl).toHaveBeenCalledWith({
      username: 'wxid_self',
      localId: 7,
      svrId: '9223372036854775807',
    })

    const button = host.querySelector<HTMLButtonElement>('button')
    await act(async () => { button?.click() })
    await flush()
    expect(mocks.apiTranscribeVoiceMessage).toHaveBeenCalledWith({
      username: 'wxid_self',
      localId: 7,
      svrId: '9223372036854775807',
    })
  })
})

describe('voice replay', () => {
  it('切到另一条语音时忽略被 pause 打断的 AbortError', async () => {
    let rejectFirstPlay: ((reason?: unknown) => void) | null = null
    class SwitchAudio {
      static instances: SwitchAudio[] = []
      src = ''
      currentTime = 0
      ended = false
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      pause = vi.fn(() => {
        rejectFirstPlay?.(new DOMException('interrupted by pause', 'AbortError'))
        rejectFirstPlay = null
      })
      load = vi.fn()
      play = vi.fn(() => {
        if (SwitchAudio.instances.length === 1) {
          return new Promise<void>((_resolve, reject) => { rejectFirstPlay = reject })
        }
        return Promise.resolve()
      })

      constructor(src: string) {
        this.src = src
        SwitchAudio.instances.push(this)
      }

      removeAttribute(name: string): void {
        if (name === 'src') this.src = ''
      }
    }
    Object.defineProperty(window, 'Audio', { configurable: true, value: SwitchAudio })
    act(() => {
      root.render(createElement('div', null,
        createElement(MessageVoice, {
          m: { localId: 7, serverId: '1', type: 34, isSender: 0, rich: { durationMs: 2000 } } as WechatMessage,
          selfName: 'wxid_self',
        }),
        createElement(MessageVoice, {
          m: { localId: 8, serverId: '2', type: 34, isSender: 0, rich: { durationMs: 4000 } } as WechatMessage,
          selfName: 'wxid_self',
        }),
      ))
    })
    await flush()

    const bubbles = host.querySelectorAll<HTMLElement>('[class*="msgVoiceBubble"]')
    await act(async () => { bubbles[0]?.click() })
    await flush()
    await act(async () => { bubbles[1]?.click() })
    await flush()

    expect(SwitchAudio.instances).toHaveLength(2)
    expect(host.textContent).not.toContain('语音暂不可用')
  })

  it('rewinds after the first playback and plays the same element again', async () => {
    renderVoice()
    await flush()
    const bubble = host.querySelector<HTMLElement>('[class*="msgVoiceBubble"]')

    await act(async () => { bubble?.click() })
    await flush()
    const audio = FakeAudio.instances[0]!
    expect(audio.play).toHaveBeenCalledTimes(1)

    act(() => {
      audio.ended = true
      audio.currentTime = 2
      audio.onended?.()
    })
    await flush()

    await act(async () => { bubble?.click() })
    await flush()
    expect(audio.currentTime).toBe(0)
    expect(audio.play).toHaveBeenCalledTimes(2)
  })

  it('creates a live element again after global stop cleared its src', async () => {
    renderVoice()
    await flush()
    const bubble = host.querySelector<HTMLElement>('[class*="msgVoiceBubble"]')

    await act(async () => { bubble?.click() })
    await flush()
    const first = FakeAudio.instances[0]!
    act(() => { stopCurrentVoice() })
    expect(first.src).toBe('')

    await act(async () => { bubble?.click() })
    await flush()
    expect(mocks.apiGetVoiceDataUrl).toHaveBeenCalledTimes(2)
    expect(FakeAudio.instances).toHaveLength(2)
    expect(FakeAudio.instances[1]?.src).toBe('data:audio/wav;base64,AA==')
    expect(FakeAudio.instances[1]?.play).toHaveBeenCalledTimes(1)
  })
})
