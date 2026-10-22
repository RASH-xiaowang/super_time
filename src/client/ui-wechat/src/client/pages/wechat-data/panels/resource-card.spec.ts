// @vitest-environment jsdom
/**
 * 问答资源卡的安全动作回归。
 *
 * 资源定位对象同时携带“能取回本机媒体”的键和只应在内部传递的标识。
 * 这里钉住两端：动作只按白名单生成，外部链接只放行 http(s)；界面既不
 * 把内部键渲染成文本，也不为无法安全打开的资源伪造按钮。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnswerRuntimeResourceCitation } from './use-ask.ts'

const stubs = vi.hoisted(() => {
  const empty = (): { url?: string; file?: string; error?: string } => ({})
  return {
    favorite: vi.fn((_options: unknown) => Promise.resolve(empty())),
    fileImage: vi.fn((_options: unknown) => Promise.resolve(empty())),
    messageFile: vi.fn((_options: unknown) => Promise.resolve(empty())),
    snsImage: vi.fn((_options: unknown) => Promise.resolve(empty())),
    openLink: vi.fn((_url: string): void => {}),
  }
})

vi.mock('../api.ts', () => ({
  apiGetFavoriteMediaDataUrl: (options: unknown) => stubs.favorite(options),
  apiGetFileImageDataUrl: (options: unknown) => stubs.fileImage(options),
  apiGetMessageFile: (options: unknown) => stubs.messageFile(options),
  apiGetSnsImageDataUrl: (options: unknown) => stubs.snsImage(options),
}))

vi.mock('./chats-support.tsx', () => ({
  openLink: (url: string): void => { stubs.openLink(url) },
}))

import { ResourceCard, resourceActionKind } from './resource-card.tsx'

type ResourceLocator = Extract<AnswerRuntimeResourceCitation['locator'], { type: 'resource' }>

function locator(over: Partial<ResourceLocator> = {}): ResourceLocator {
  return {
    type: 'resource',
    tool: 'search_resources',
    key: 'resource-stable-key',
    ...over,
  }
}

function resource(
  locatorOver: Partial<ResourceLocator>,
  over: Partial<AnswerRuntimeResourceCitation> = {},
): AnswerRuntimeResourceCitation {
  return {
    evidenceId: 'res:test',
    tool: 'search_resources',
    key: 'resource-stable-key',
    name: '资源',
    time: '',
    snippet: '',
    ...over,
    locator: locator(locatorOver),
  }
}

let host: HTMLDivElement
let root: Root

function show(item: AnswerRuntimeResourceCitation): void {
  act(() => { root.render(createElement(ResourceCard, { resource: item })) })
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')]
    .find(el => el.textContent?.includes(label))
  expect(found, `找不到按钮：${label}`).toBeDefined()
  return found as HTMLButtonElement
}

async function click(label: string): Promise<void> {
  const target = button(label)
  await act(async () => {
    target.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  stubs.favorite.mockReset()
  stubs.favorite.mockResolvedValue({})
  stubs.fileImage.mockReset()
  stubs.fileImage.mockResolvedValue({})
  stubs.messageFile.mockReset()
  stubs.messageFile.mockResolvedValue({})
  stubs.snsImage.mockReset()
  stubs.snsImage.mockResolvedValue({})
  stubs.openLink.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('resourceActionKind', () => {
  it('朋友圈图片支持 md5 或 timelineId + mediaId 两种定位', () => {
    expect(resourceActionKind(resource({
      resourceKind: 'moment',
      md5: 'moment-md5',
    }))).toBe('moment-image')
    expect(resourceActionKind(resource({
      resourceKind: 'moment',
      timelineId: 'timeline-1',
      mediaId: 'media-1',
    }))).toBe('moment-image')
    expect(resourceActionKind(resource({
      resourceKind: 'moment',
      timelineId: 'timeline-1',
    }))).toBe('none')
  })

  it('收藏按媒体类型给出图片、视频与文件动作', () => {
    expect(resourceActionKind(resource({
      resourceKind: 'favorite',
      mediaKind: 'image',
      md5: 'favorite-image-md5',
    }))).toBe('favorite-image')
    expect(resourceActionKind(resource({
      resourceKind: 'favorite',
      mediaKind: 'video',
      md5: 'favorite-video-md5',
    }))).toBe('favorite-video')
    expect(resourceActionKind(resource({
      resourceKind: 'favorite',
      mediaKind: 'file',
      md5: 'favorite-file-md5',
    }))).toBe('favorite-file')
    expect(resourceActionKind(resource({
      resourceKind: 'favorite',
      mediaKind: 'file',
      fileName: '报价.pdf',
    }))).toBe('favorite-file')
  })

  it('文件库图片与普通文件分别走预览和下载', () => {
    expect(resourceActionKind(resource({
      resourceKind: 'file',
      category: 'image',
      md5: 'file-image-md5',
    }))).toBe('file-image')
    expect(resourceActionKind(resource({
      resourceKind: 'file',
      category: 'file',
      fileName: '合同.docx',
    }))).toBe('file-download')
  })

  it('只有 http/https 外部地址可打开，其余协议一律只能看摘要', () => {
    expect(resourceActionKind(resource({
      resourceKind: 'record',
      url: ' https://example.com/a?q=1 ',
    }))).toBe('external-link')
    expect(resourceActionKind(resource({
      resourceKind: 'record',
      url: 'HTTP://example.com/a',
    }))).toBe('external-link')

    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///C:/secret.txt',
      'ftp://example.com/a',
    ]) {
      expect(resourceActionKind(resource({ resourceKind: 'record', url })), url).toBe('none')
    }
  })
})

describe('ResourceCard', () => {
  it('没有安全动作时以 li 渲染摘要，不出现动作按钮', () => {
    show(resource({
      resourceKind: 'record',
      transferId: 'transfer-secret',
    }, {
      name: '转账记录',
      snippet: '仅展示摘要',
    }))

    expect(host.firstElementChild?.tagName).toBe('LI')
    expect(host.textContent).toContain('转账记录')
    expect(host.textContent).toContain('仅展示摘要')
    expect(host.textContent).toContain('仅摘要')
    expect(host.querySelector('button')).toBeNull()
  })

  it('安全外部链接显示“打开链接”，点击时只把清理后的地址交给 openLink', async () => {
    show(resource({
      resourceKind: 'record',
      url: '  https://example.com/report?id=7  ',
    }, {
      name: '外部报告',
    }))

    expect(host.textContent).toContain('打开链接')
    expect(host.querySelector('a')).toBeNull()
    await click('打开链接')

    expect(stubs.openLink).toHaveBeenCalledTimes(1)
    expect(stubs.openLink).toHaveBeenCalledWith('https://example.com/report?id=7')
  })

  it('不安全链接不生成打开动作，点击入口也不存在', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///C:/secret.txt',
    ]) {
      show(resource({ resourceKind: 'record', url }, { name: '危险链接' }))
      expect(host.textContent, url).toContain('仅摘要')
      expect(host.querySelector('button'), url).toBeNull()
    }
    expect(stubs.openLink).not.toHaveBeenCalled()
  })

  it('收藏图片点击后按 md5 取回媒体，并把返回 url 渲染成图片', async () => {
    const md5 = 'a'.repeat(32)
    const url = 'data:image/png;base64,ZmFrZS1pbWFnZQ=='
    stubs.favorite.mockResolvedValue({ url })
    show(resource({
      resourceKind: 'favorite',
      mediaKind: 'image',
      md5,
    }, {
      name: '报价截图.png',
    }))

    await click('查看图片')

    expect(stubs.favorite).toHaveBeenCalledTimes(1)
    expect(stubs.favorite).toHaveBeenCalledWith({ md5, kind: 'image' })
    const image = host.querySelector('img')
    expect(image, '取回成功后必须渲染图片').not.toBeNull()
    expect(image?.getAttribute('src')).toBe(url)
    expect(image?.getAttribute('alt')).toBe('报价截图.png')
  })

  it('可见内容不泄露 key、token、seed、md5 与其他内部定位值', () => {
    show(resource({
      resourceKind: 'record',
      sourceId: 'source-secret',
      serverId: 'server-secret',
      transferId: 'transfer-secret',
      messageServerId: 'message-server-secret',
      timelineId: 'timeline-secret',
      username: 'username-secret',
      mediaId: 'media-secret',
      md5: 'md5-secret',
      thumbMd5: 'thumb-md5-secret',
      fullMd5: 'full-md5-secret',
      url: 'javascript:alert("url-secret")',
      token: 'token-secret',
      seed: 'seed-secret',
    }, {
      key: 'resource-key-secret',
      name: '安全资源名',
      snippet: '安全摘要',
    }))

    const visible = host.textContent ?? ''
    expect(visible).toContain('安全资源名')
    expect(visible).toContain('安全摘要')
    for (const secret of [
      'resource-key-secret',
      'source-secret',
      'server-secret',
      'transfer-secret',
      'message-server-secret',
      'timeline-secret',
      'username-secret',
      'media-secret',
      'md5-secret',
      'thumb-md5-secret',
      'full-md5-secret',
      'url-secret',
      'token-secret',
      'seed-secret',
    ]) {
      expect(visible, secret).not.toContain(secret)
    }
  })
})
