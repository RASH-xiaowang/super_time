// @vitest-environment jsdom
/**
 * 撤回正文与资源卡的可查看性回归。
 *
 * 撤回面板不能只给一句“原文已保留”：正文要在未展开时就进入 DOM，
 * 图片/视频/语音/文件/链接要能直接取到实体，且媒体按钮不能冒泡触发整行折叠。
 * 定位键缺失时也必须给出可读提示，不能静默剩下一个空卡片。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RevokedItem } from '@deepseek-ai/dsh-wechat-data/types'

const stubs = vi.hoisted(() => ({
  image: vi.fn((_options: unknown): Promise<{ url?: string; file?: string; error?: string }> => Promise.resolve({})),
  fileImage: vi.fn((_options: unknown): Promise<{ url?: string; file?: string; error?: string }> => Promise.resolve({})),
  emoticon: vi.fn((_options: unknown): Promise<{ url?: string; file?: string; error?: string }> => Promise.resolve({})),
  videoInfo: vi.fn((_options: unknown): Promise<{
    available?: boolean
    md5?: string
    coverUrl?: string
    videoPath?: string
    error?: string
  }> => Promise.resolve({})),
  voice: vi.fn((_options: unknown): Promise<{ url?: string; error?: string }> => Promise.resolve({})),
  messageFile: vi.fn((_options: unknown): Promise<{ url?: string; error?: string }> => Promise.resolve({})),
  openPath: vi.fn((_path: string): Promise<{ ok: boolean; path: string; error?: string }> => (
    Promise.resolve({ ok: true, path: _path })
  )),
  openLink: vi.fn((_url: string): void => {}),
}))

vi.mock('../api.ts', () => ({
  apiGetAvatar: vi.fn(() => Promise.resolve({ kind: 'none' })),
  apiGetAvatarBatched: vi.fn(() => Promise.resolve({ kind: 'none' })),
  apiGetEmoticonDataUrl: (options: unknown) => stubs.emoticon(options),
  apiGetFileImageDataUrl: (options: unknown) => stubs.fileImage(options),
  apiGetImageDataUrl: (options: unknown) => stubs.image(options),
  apiGetMessageFile: (options: unknown) => stubs.messageFile(options),
  apiGetVideoInfo: (options: unknown) => stubs.videoInfo(options),
  apiGetVoiceDataUrl: (options: unknown) => stubs.voice(options),
  apiOpenPath: (path: string) => stubs.openPath(path),
}))

vi.mock('./chats-support.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chats-support.tsx')>()
  return {
    ...actual,
    openLink: (url: string): void => { stubs.openLink(url) },
  }
})

// 测试按桌面态跑：资源动作必须真的可点，才能验证它调到了哪个接口。
vi.mock('../ui/desktop-only.tsx', () => ({
  desktopActionProps: () => ({}),
}))

import { RevokedContent } from './revoked-content.tsx'

const MD5 = 'a'.repeat(32)

function item(over: Partial<RevokedItem> = {}): RevokedItem {
  return {
    sender: '张三',
    sender_username: 'wxid_sender',
    type_label: '文本',
    content: '被撤回的正文',
    create_time: 1_700_000_000,
    session_username: 'wxid_room',
    session_name: '测试群',
    session_is_group: true,
    local_id: 101,
    retained: true,
    status_label: '原文已保留',
    ...over,
  }
}

let host: HTMLDivElement
let root: Root
let anchorClick: ReturnType<typeof vi.spyOn>

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

function show(record: RevokedItem, open = false, onParentClick?: () => void): void {
  act(() => {
    root.render(createElement(
      'div',
      onParentClick ? { onClick: onParentClick } : null,
      createElement(RevokedContent, { item: record, open }),
    ))
  })
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')]
    .find((el) => el.textContent?.includes(label))
  expect(found, `找不到按钮：${label}`).toBeDefined()
  return found as HTMLButtonElement
}

async function click(label: string): Promise<void> {
  const target = button(label)
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
  await flush()
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom 没有 IntersectionObserver；LazyMount 在无 IO 时会主动 reveal，
  // 这与真实环境里“资源进入视野”是同一条渲染路径。
  Reflect.deleteProperty(globalThis, 'IntersectionObserver')

  stubs.image.mockReset()
  stubs.image.mockResolvedValue({})
  stubs.fileImage.mockReset()
  stubs.fileImage.mockResolvedValue({})
  stubs.emoticon.mockReset()
  stubs.emoticon.mockResolvedValue({})
  stubs.videoInfo.mockReset()
  stubs.videoInfo.mockResolvedValue({})
  stubs.voice.mockReset()
  stubs.voice.mockResolvedValue({})
  stubs.messageFile.mockReset()
  stubs.messageFile.mockResolvedValue({})
  stubs.openPath.mockReset()
  stubs.openPath.mockImplementation((path: string) => Promise.resolve({ ok: true, path }))
  stubs.openLink.mockReset()
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  anchorClick.mockRestore()
  host.remove()
})

describe('撤回正文直接可见', () => {
  it('未展开时完整多行正文就进入 DOM，不受 4 行折叠影响', () => {
    const text = [
      '第一行：这是一条很长的撤回正文。',
      '第二行：未展开时也必须进入 DOM。',
      '第三行：不能只显示前四行。',
      '第四行：资源与正文都应直接可见。',
      '第五行：这一行是判断是否被截断的关键。',
      '第六行：完整内容必须原样保留。',
    ].join('\n')
    show(item({ content: text }), false)

    const body = host.querySelector('[data-collapsed]')
    expect(body, '撤回正文没有渲染').not.toBeNull()
    expect(body?.textContent).toBe(text)
    expect(body?.textContent?.split('\n')).toHaveLength(6)
    expect(body?.getAttribute('data-collapsed')).toBe('true')
    expect(host.textContent).toContain('会话：测试群')
  })
})

describe('图片', () => {
  it('有消息定位键时优先按会话 + local_id 取图并渲染 img', async () => {
    stubs.image.mockResolvedValue({ url: 'data:image/png;base64,ZmFrZS1pbWFnZQ==' })
    show(item({
      type_label: '图片',
      content: '',
      media: { kind: 'image', md5: MD5 },
    }))
    await flush()

    expect(stubs.image).toHaveBeenCalledWith({ username: 'wxid_room', localId: 101 })
    expect(stubs.fileImage).not.toHaveBeenCalled()
    const img = host.querySelector('img[alt="撤回的图片"]')
    expect(img, '取图成功却没有渲染图片').not.toBeNull()
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,ZmFrZS1pbWFnZQ==')
  })

  it('缺少消息定位键时按 md5 回落', async () => {
    stubs.fileImage.mockResolvedValue({ url: 'data:image/png;base64,bWQ1LWZhbGxiYWNr' })
    show(item({
      type_label: '图片',
      content: '',
      session_username: '',
      local_id: 0,
      media: { kind: 'image', md5: MD5 },
    }))
    await flush()

    expect(stubs.image).not.toHaveBeenCalled()
    expect(stubs.fileImage).toHaveBeenCalledWith({ md5: MD5, thumbFirst: true })
    expect(host.querySelector('img[alt="撤回的图片"]')?.getAttribute('src'))
      .toBe('data:image/png;base64,bWQ1LWZhbGxiYWNr')
  })

  it('HTTP 页面收到落盘文件时使用 /api/media/decoded，不生成 wechat-media://', async () => {
    stubs.fileImage.mockResolvedValue({ file: 'wxid_room/md5-fallback.jpg' })
    show(item({
      type_label: '图片',
      content: '',
      session_username: '',
      local_id: 0,
      media: { kind: 'image', md5: MD5 },
    }))
    await flush()

    const src = host.querySelector('img[alt="撤回的图片"]')?.getAttribute('src')
    expect(src).toBe('/api/media/decoded/wxid_room/md5-fallback.jpg')
    expect(src).not.toContain('wechat-media://')
  })

  it('主定位取图失败时仍尝试 md5 备用键', async () => {
    stubs.image.mockResolvedValue({ error: '消息缓存里已找不到这张图' })
    stubs.fileImage.mockResolvedValue({ url: 'data:image/png;base64,ZmFsbGJhY2std29ya2Vk' })
    show(item({
      type_label: '图片',
      content: '',
      media: { kind: 'image', md5: MD5 },
    }))
    await flush()

    expect(stubs.image).toHaveBeenCalledTimes(1)
    expect(stubs.fileImage).toHaveBeenCalledWith({ md5: MD5, thumbFirst: true })
    expect(host.querySelector('img[alt="撤回的图片"]')).not.toBeNull()
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('没有任何定位键时给出可读错误，不崩溃', async () => {
    show(item({
      type_label: '图片',
      content: '',
      session_username: '',
      local_id: 0,
      media: { kind: 'image' },
    }))
    await flush()

    expect(stubs.image).not.toHaveBeenCalled()
    expect(stubs.fileImage).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('缺少图片定位信息')
  })
})

describe('视频、语音、文件与链接', () => {
  it('视频显示封面与系统播放器按钮；按钮不冒泡，打开的是后端给出的本机路径', async () => {
    stubs.videoInfo.mockResolvedValue({
      available: true,
      coverUrl: 'data:image/jpeg;base64,Y292ZXI=',
      videoPath: 'C:\\wechat\\msg\\video\\demo.mp4',
    })
    const parentClick = vi.fn()
    show(item({
      type_label: '视频',
      content: '',
      media: { kind: 'video', durationSec: 75 },
    }), false, parentClick)
    await flush()

    expect(stubs.videoInfo).toHaveBeenCalledWith({ username: 'wxid_room', localId: 101 })
    expect(host.querySelector('img[alt="撤回的视频封面"]')?.getAttribute('src'))
      .toBe('data:image/jpeg;base64,Y292ZXI=')
    expect(host.textContent).toContain('视频 · 1:15')

    await click('用系统播放器打开')
    expect(stubs.openPath).toHaveBeenCalledWith('C:\\wechat\\msg\\video\\demo.mp4')
    expect(parentClick, '媒体按钮冒泡触发了父行折叠').not.toHaveBeenCalled()
  })

  it('没有会话/local_id 时用 media.md5 走 MD5-only 视频查询', async () => {
    stubs.videoInfo.mockResolvedValue({
      available: true,
      md5: MD5,
      coverUrl: 'data:image/jpeg;base64,bWQ1LWNvdmVy',
      videoPath: 'C:\\wechat\\msg\\video\\' + MD5 + '.mp4',
    })
    show(item({
      type_label: '视频',
      content: '',
      session_username: '',
      local_id: 0,
      media: { kind: 'video', md5: MD5, durationSec: 5 },
    }))
    await flush()

    expect(stubs.videoInfo).toHaveBeenCalledWith({ md5: MD5 })
    expect(host.querySelector('img[alt="撤回的视频封面"]')?.getAttribute('src'))
      .toBe('data:image/jpeg;base64,bWQ1LWNvdmVy')
    expect(host.textContent).toContain('用系统播放器打开')
  })

  it('语音取回可播放地址并渲染 audio', async () => {
    stubs.voice.mockResolvedValue({ url: 'data:audio/wav;base64,ZmFrZS12b2ljZQ==' })
    show(item({
      type_label: '语音',
      content: '',
      media: { kind: 'voice', durationMs: 3000 },
    }))
    await flush()

    expect(stubs.voice).toHaveBeenCalledWith({ username: 'wxid_room', localId: 101 })
    expect(host.textContent).toContain('语音 · 3″')
    expect(host.querySelector('audio')?.getAttribute('src'))
      .toBe('data:audio/wav;base64,ZmFrZS12b2ljZQ==')
  })

  it('文件下载把文件名、体积与时间交给 msg/file，并阻止父行折叠', async () => {
    stubs.messageFile.mockResolvedValue({ url: 'data:application/pdf;base64,ZmFrZS1maWxl' })
    const parentClick = vi.fn()
    show(item({
      type_label: '文件',
      content: '',
      media: {
        kind: 'file',
        name: '报价单.pdf',
        ext: 'pdf',
        size: 2048,
        fileMd5: MD5,
      },
    }), false, parentClick)
    await flush()

    expect(host.textContent).toContain('报价单.pdf')
    expect(host.textContent).toContain('PDF')
    await click('下载文件')

    expect(stubs.messageFile).toHaveBeenCalledWith({
      fileName: '报价单.pdf',
      size: 2048,
      createTime: 1_700_000_000,
      fileMd5: MD5,
    })
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(parentClick, '文件按钮冒泡触发了父行折叠').not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('普通链接只把 http(s) 地址交给 openLink', async () => {
    show(item({
      type_label: '链接',
      content: '',
      media: {
        kind: 'link',
        title: '一篇公众号文章',
        desc: '文章摘要',
        url: 'https://example.com/post?id=7',
      },
    }))
    await flush()

    expect(host.textContent).toContain('一篇公众号文章')
    expect(host.textContent).toContain('文章摘要')
    await click('打开链接')
    expect(stubs.openLink).toHaveBeenCalledWith('https://example.com/post?id=7')
  })
})

describe('表情', () => {
  it('HTTP 页面收到落盘文件时同样使用 /api/media/decoded', async () => {
    stubs.emoticon.mockResolvedValue({ file: 'emoticons/emoji.gif' })
    show(item({
      type_label: '表情',
      content: '',
      media: { kind: 'emoji', md5: MD5 },
    }))
    await flush()

    const src = host.querySelector('img[alt="撤回的表情"]')?.getAttribute('src')
    expect(src).toBe('/api/media/decoded/emoticons/emoji.gif')
    expect(src).not.toContain('wechat-media://')
  })
})
