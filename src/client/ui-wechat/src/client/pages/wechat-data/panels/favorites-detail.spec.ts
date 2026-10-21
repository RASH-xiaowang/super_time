// @vitest-environment jsdom
/**
 * 普通收藏详情的头像判据。
 *
 * 用户反馈「其他收藏类型没有头像」：详情头部必须展示来源头像，并且远程地址只能
 * 交给 `RemoteImg` 走后端代理；取不到时回落到来源首字，而不是留空框。
 */
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FavorItem } from '@deepseek-ai/dsh-wechat-data/types'

const stubs = vi.hoisted(() => ({
  avatar: vi.fn((options: { md5: string }): Promise<{ url?: string }> => {
    void options
    return Promise.resolve({})
  }),
  voice: vi.fn((): Promise<{ url?: string; error?: string }> => Promise.resolve({})),
  videoCover: vi.fn((): Promise<{ url?: string; error?: string }> => Promise.resolve({})),
  video: vi.fn((): Promise<{ url?: string; error?: string }> => Promise.resolve({})),
  file: vi.fn((): Promise<{ url?: string; error?: string }> => Promise.resolve({})),
  favorite: vi.fn((options?: { kind?: string }): Promise<{ url?: string; error?: string }> => {
    void options
    return Promise.resolve({})
  }),
}))

vi.mock('../api.ts', () => ({
  apiGetSnsImageDataUrl: stubs.avatar,
  apiGetVoiceDataUrl: stubs.voice,
  apiGetSnsVideoCoverDataUrl: stubs.videoCover,
  apiGetSnsVideoDataUrl: stubs.video,
  apiGetMessageFile: stubs.file,
  apiGetFavoriteMediaDataUrl: stubs.favorite,
}))

vi.mock('./remote-img.tsx', () => ({
  RemoteImg: ({ src, pending, failed, empty }: {
    src: string
    pending?: React.ReactNode
    failed?: React.ReactNode
    empty?: React.ReactNode
  }): React.JSX.Element => createElement('span', {
    'data-remote-src': src,
    'data-has-pending': pending ? '1' : '0',
    'data-has-failed': failed ? '1' : '0',
    'data-has-empty': empty ? '1' : '0',
  }),
}))

import { FavoriteDetail } from './favorites-detail.tsx'
import { parseFavoriteAvatar } from './favorites-avatar.tsx'

const fav = (over: Partial<FavorItem> = {}): FavorItem => ({
  localId: 9,
  type: 8,
  typeLabel: '文件',
  title: '报价单.pdf',
  desc: '',
  url: '',
  updateTime: 1_700_000_000,
  time: '2023-11-15 06:13',
  content: '',
  fromUsr: 'someone@chatroom',
  chatName: 'wxid_sender',
  source: '蒙婵丽-p 姐',
  avatar: 'https://wx.qlogo.cn/avatar/132',
  ...over,
})

let host: HTMLDivElement
let root: Root

function show(item: FavorItem): void {
  act(() => {
    root.render(createElement(FavoriteDetail, { item, thumbs: {} }))
  })
}

const q = (sel: string): Element | null => host.querySelector(sel)

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  stubs.avatar.mockReset()
  stubs.avatar.mockResolvedValue({})
  stubs.voice.mockReset()
  stubs.voice.mockResolvedValue({})
  stubs.videoCover.mockReset()
  stubs.videoCover.mockResolvedValue({})
  stubs.video.mockReset()
  stubs.video.mockResolvedValue({})
  stubs.file.mockReset()
  stubs.file.mockResolvedValue({})
  stubs.favorite.mockReset()
  stubs.favorite.mockResolvedValue({})
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('FavoriteDetail 来源头像', () => {
  it('解析头像引用：本地 data URL 直接可画，MD5 走解码但不同时当 URL', () => {
    expect(parseFavoriteAvatar(' data:image/jpeg;base64,/9j/4AAQ ')).toEqual({
      src: 'data:image/jpeg;base64,/9j/4AAQ',
      md5: '',
    })
    expect(parseFavoriteAvatar('F18572F2133C91307DC98C1CC095D995')).toEqual({
      src: '',
      md5: 'f18572f2133c91307dc98c1cc095d995',
    })
    expect(parseFavoriteAvatar(' https://wx.qlogo.cn/avatar/132 ')).toEqual({
      src: 'https://wx.qlogo.cn/avatar/132',
      md5: '',
    })
  })

  it('来源头像交给 RemoteImg（远程地址不直接进入 <img>）', () => {
    show(fav())
    const remote = q('[data-remote-src]')
    expect(remote?.getAttribute('data-remote-src')).toBe('https://wx.qlogo.cn/avatar/132')
    expect(q('img'), '详情组件自己直接挂远程 <img> = 绕过后端代理').toBeNull()
    // pending/failed/empty 三种状态都必须有首字兜底，避免头像位变成空框。
    expect(remote?.getAttribute('data-has-pending')).toBe('1')
    expect(remote?.getAttribute('data-has-failed')).toBe('1')
    expect(remote?.getAttribute('data-has-empty')).toBe('1')
  })

  it('本机 data URL 首屏直接交给 RemoteImg，不再停留在空头像位', () => {
    show(fav({ avatar: 'data:image/jpeg;base64,avatar' }))
    expect(q('[data-remote-src]')?.getAttribute('data-remote-src')).toBe('data:image/jpeg;base64,avatar')
    expect(stubs.avatar).not.toHaveBeenCalled()
  })

  it('头像为空时仍让 RemoteImg 走 empty 分支（由它画来源首字，避免空框）', () => {
    show(fav({ avatar: '', title: '位置收藏', type: 6, typeLabel: '位置', source: '王国宁' }))
    expect(host.textContent).toContain('王国宁')
    expect(host.textContent).toContain('位置')
    expect(q('[data-remote-src]')?.getAttribute('data-remote-src')).toBe('')
    expect(q('[data-remote-src]')?.getAttribute('data-has-empty'), '没有头像时必须把首字兜底交给 empty').toBe('1')
  })

  it('头像位与来源/类型/时间分层展示，不是把元信息挤成一行', () => {
    show(fav())
    expect(host.textContent).toContain('蒙婵丽-p 姐')
    expect(host.textContent).toContain('文件')
    expect(host.textContent).toContain('2023-11-15 06:13')
  })

  it('来源头像是 32 位 MD5 时用收藏图片解码链取本机图（不再直接拿 MD5 当 URL）', async () => {
    stubs.avatar.mockResolvedValue({ url: 'data:image/jpeg;base64,avatar' })
    const md5 = 'f18572f2133c91307dc98c1cc095d995'
    await act(async () => {
      root.render(createElement(FavoriteDetail, { item: fav({ avatar: md5 }), thumbs: {} }))
      await Promise.resolve()
    })
    expect(stubs.avatar.mock.calls.map((c) => c[0])).toEqual([{ md5 }])
    expect(q('[data-remote-src]')?.getAttribute('data-remote-src')).toBe('data:image/jpeg;base64,avatar')
  })

  it('语音收藏用 svrId 取音频并渲染播放器，不再只显示「[语音]」', async () => {
    stubs.voice.mockResolvedValue({ url: 'data:audio/wav;base64,voice' })
    await act(async () => {
      root.render(createElement(FavoriteDetail, {
        item: fav({
          type: 3,
          typeLabel: '语音',
          title: '语音',
          content: '<fav><datalist><dataitem datatype="3"><duration>2686</duration><fromnewmsgid>2538601227098830648</fromnewmsgid></dataitem></datalist></fav>',
        }),
        thumbs: {},
      }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stubs.voice).toHaveBeenCalledWith({ svrId: '2538601227098830648' })
    expect(host.textContent).toContain('语音 · 3 秒')
    expect(q('audio')?.getAttribute('src')).toBe('data:audio/wav;base64,voice')
    expect(host.textContent).not.toContain('[语音]')
  })

  it('图片详情按完整 MD5 再取一次，列表缓存缺失时仍能显示', async () => {
    stubs.avatar.mockImplementation(async ({ md5 }: { md5: string }) => (
      md5 === 'full' ? { url: 'data:image/jpeg;base64,favorite' } : {}
    ))
    await act(async () => {
      root.render(createElement(FavoriteDetail, {
        item: fav({
          type: 2,
          typeLabel: '图片',
          avatar: '',
          content: '<fav><datalist><dataitem datatype="2"><fullmd5>full</fullmd5><thumbfullmd5>thumb</thumbfullmd5></dataitem></datalist></fav>',
        }),
        thumbs: {},
      }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stubs.avatar.mock.calls.map((c) => c[0])).toContainEqual({ md5: 'full' })
    expect(q('img[src="data:image/jpeg;base64,favorite"]')).not.toBeNull()
  })

  it('图片先用收藏专用缓存解析，命中后不再走朋友圈图片接口', async () => {
    stubs.favorite.mockResolvedValue({ url: 'data:image/jpeg;base64,local-favorite' })
    await act(async () => {
      root.render(createElement(FavoriteDetail, {
        item: fav({
          type: 2,
          typeLabel: '图片',
          avatar: '',
          content: '<fav><datalist><dataitem datatype="2"><fullmd5>full</fullmd5><thumbfullmd5>thumb</thumbfullmd5></dataitem></datalist></fav>',
        }),
        thumbs: {},
      }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stubs.favorite).toHaveBeenCalledWith({ fullMd5: 'full', thumbMd5: 'thumb', md5: 'thumb', kind: 'image' })
    expect(stubs.avatar).not.toHaveBeenCalled()
    expect(q('img[src="data:image/jpeg;base64,local-favorite"]')).not.toBeNull()
  })

  it('视频先渲染封面，点击后才取视频本体', async () => {
    stubs.videoCover.mockResolvedValue({ url: 'data:image/jpeg;base64,cover' })
    stubs.video.mockResolvedValue({ url: 'data:video/mp4;base64,video' })
    const item = fav({
      type: 4,
      typeLabel: '视频',
      avatar: '',
      content: '<fav><datalist><dataitem datatype="4"><fullmd5>video-full</fullmd5><thumbfullmd5>video-thumb</thumbfullmd5><duration>20</duration></dataitem></datalist></fav>',
    })
    await act(async () => {
      root.render(createElement(FavoriteDetail, { item, thumbs: {} }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stubs.favorite).toHaveBeenCalledWith({
      thumbMd5: 'video-thumb',
      fullMd5: 'video-full',
      md5: 'video-thumb',
      kind: 'image',
    })
    expect(stubs.videoCover).toHaveBeenCalledWith({ md5: 'video-thumb' })
    expect(stubs.video).not.toHaveBeenCalled()
    const playButton = q('button[class*="favVideoStage"]')
    expect(playButton?.textContent).toContain('播放视频')
    await act(async () => {
      playButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stubs.video).toHaveBeenCalledWith({ md5: 'video-full' })
    expect(q('video')?.getAttribute('src')).toBe('data:video/mp4;base64,video')
  })

  it('视频封面与本体都优先使用收藏缓存', async () => {
    stubs.favorite.mockImplementation(async (options = {}) => (
      options.kind === 'video'
        ? { url: 'data:video/mp4;base64,local-video' }
        : { url: 'data:image/jpeg;base64,local-cover' }
    ))
    const item = fav({
      type: 4,
      typeLabel: '视频',
      avatar: '',
      content: '<fav><datalist><dataitem datatype="4"><fullmd5>video-full</fullmd5><thumbfullmd5>video-thumb</thumbfullmd5><duration>20</duration></dataitem></datalist></fav>',
    })
    await act(async () => {
      root.render(createElement(FavoriteDetail, { item, thumbs: {} }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stubs.favorite).toHaveBeenCalledWith({ thumbMd5: 'video-thumb', fullMd5: 'video-full', md5: 'video-thumb', kind: 'image' })
    expect(stubs.videoCover).not.toHaveBeenCalled()
    expect(q('button[class*="favVideoStage"] img')?.getAttribute('src')).toBe('data:image/jpeg;base64,local-cover')
    await act(async () => {
      q('button[class*="favVideoStage"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stubs.favorite).toHaveBeenCalledWith({ fullMd5: 'video-full', md5: 'video-thumb', kind: 'video' })
    expect(stubs.video).not.toHaveBeenCalled()
    expect(q('video')?.getAttribute('src')).toBe('data:video/mp4;base64,local-video')
  })

  it('文件卡点击时按文件名/体积/收藏时间查找并下载', async () => {
    stubs.file.mockResolvedValue({ url: 'data:application/pdf;base64,file' })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const item = fav({
      type: 8,
      typeLabel: '文件',
      avatar: '',
      updateTime: 1_700_000_000,
      content: '<fav><datalist><dataitem datatype="8"><datatitle>报价单.pdf</datatitle><datafmt>pdf</datafmt><fullsize>20480</fullsize></dataitem></datalist></fav>',
    })
    await act(async () => {
      root.render(createElement(FavoriteDetail, { item, thumbs: {} }))
      await Promise.resolve()
    })
    await act(async () => {
      q('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stubs.file).toHaveBeenCalledWith({ fileName: '报价单.pdf', size: 20480, createTime: 1_700_000_000 })
    expect(click).toHaveBeenCalledTimes(1)
    click.mockRestore()
  })

  it('文件点击时先下载收藏缓存里的原文件', async () => {
    stubs.favorite.mockResolvedValue({ url: 'data:application/pdf;base64,local-file' })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const item = fav({
      type: 8,
      typeLabel: '文件',
      avatar: '',
      content: '<fav><datalist><dataitem datatype="8"><datatitle>报价单.pdf</datatitle><datafmt>pdf</datafmt><fullsize>20480</fullsize><fullmd5>file-md5</fullmd5></dataitem></datalist></fav>',
    })
    await act(async () => {
      root.render(createElement(FavoriteDetail, { item, thumbs: {} }))
      await Promise.resolve()
    })
    await act(async () => {
      q('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stubs.favorite).toHaveBeenCalledWith({
      fullMd5: 'file-md5',
      kind: 'file',
      ext: 'pdf',
      fileName: '报价单.pdf',
      size: 20480,
    })
    expect(stubs.file).not.toHaveBeenCalled()
    expect(click).toHaveBeenCalledTimes(1)
    click.mockRestore()
  })

  it('文件卡失败时显示后端原因，不把「打开失败」吞掉', async () => {
    stubs.file.mockResolvedValue({ error: '本地未找到该文件' })
    const item = fav({
      type: 8,
      typeLabel: '文件',
      avatar: '',
      content: '<fav><datalist><dataitem datatype="8"><datatitle>缺失.pdf</datatitle><datafmt>pdf</datafmt></dataitem></datalist></fav>',
    })
    await act(async () => {
      root.render(createElement(FavoriteDetail, { item, thumbs: {} }))
      await Promise.resolve()
    })
    await act(async () => {
      q('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.textContent).toContain('本地未找到该文件')
  })

  it('图片两个 MD5 都失败时显示可读状态', async () => {
    stubs.avatar.mockResolvedValue({})
    const item = fav({
      type: 2,
      typeLabel: '图片',
      avatar: '',
      content: '<fav><datalist><dataitem datatype="2"><fullmd5>full</fullmd5><thumbfullmd5>thumb</thumbfullmd5></dataitem></datalist></fav>',
    })
    await act(async () => {
      root.render(createElement(FavoriteDetail, { item, thumbs: {} }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stubs.avatar).toHaveBeenCalledWith({ md5: 'full' })
    expect(stubs.avatar).toHaveBeenCalledWith({ md5: 'thumb' })
    expect(host.textContent).toContain('图片暂不可用')
    expect(host.textContent).not.toContain('[图片]')
  })

  it('图片没有 MD5 时直接给出暂不可用，不永远停在加载中', async () => {
    await act(async () => {
      root.render(createElement(FavoriteDetail, {
        item: fav({
          type: 2,
          typeLabel: '图片',
          avatar: '',
          content: '<fav><datalist><dataitem datatype="2"></dataitem></datalist></fav>',
        }),
        thumbs: {},
      }))
      await Promise.resolve()
    })
    expect(stubs.avatar).not.toHaveBeenCalled()
    expect(host.textContent).toContain('图片暂不可用')
    expect(host.textContent).not.toContain('正在加载图片')
  })

  it('语音没有 svrId/MD5 时直接给出暂不可用，不永远停在解码中', async () => {
    await act(async () => {
      root.render(createElement(FavoriteDetail, {
        item: fav({
          type: 3,
          typeLabel: '语音',
          avatar: '',
          content: '<fav><datalist><dataitem datatype="3"><duration>2000</duration></dataitem></datalist></fav>',
        }),
        thumbs: {},
      }))
      await Promise.resolve()
    })
    expect(stubs.voice).not.toHaveBeenCalled()
    expect(host.textContent).toContain('语音暂不可用')
    expect(host.textContent).not.toContain('正在解码语音')
  })

  it('未知资源只有 MD5 封面时也解码展示，而不是把 MD5 当 URL 或留空', async () => {
    stubs.avatar.mockResolvedValue({ url: 'data:image/jpeg;base64,unknown-cover' })
    const md5 = 'f18572f2133c91307dc98c1cc095d995'
    await act(async () => {
      root.render(createElement(FavoriteDetail, {
        item: fav({
          type: 999,
          typeLabel: '其他',
          avatar: '',
          content: `<fav><datalist><dataitem datatype="77"><datatitle>新资源</datatitle><fullmd5>${md5}</fullmd5></dataitem></datalist></fav>`,
        }),
        thumbs: {},
      }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stubs.avatar).toHaveBeenCalledWith({ md5 })
    expect(q('img[src="data:image/jpeg;base64,unknown-cover"]')).not.toBeNull()
  })

  it('位置、小程序与未知资源给出可读卡片，而不是空白或类型占位', () => {
    show(fav({
      type: 6,
      typeLabel: '位置',
      avatar: '',
      content: '<fav><locitem><poiname>登记服务站</poiname><label>星光大道</label><lat>22.78</lat><lng>108.31</lng></locitem></fav>',
    }))
    expect(host.textContent).toContain('登记服务站')
    expect(host.textContent).toContain('在高德地图中查看')
    act(() => { root.render(createElement('span')) })
    show(fav({
      type: 19,
      typeLabel: '小程序',
      avatar: '',
      content: '<fav><datalist><dataitem datatype="19"><datatitle>小程序标题</datatitle></dataitem></datalist><appbranditem><appid>wx123</appid><pagepath>pages/index</pagepath></appbranditem></fav>',
    }))
    expect(host.textContent).toContain('小程序标题')
    expect(host.textContent).toContain('wx123')
    act(() => { root.render(createElement('span')) })
    show(fav({
      type: 999,
      typeLabel: '其他',
      avatar: '',
      content: '<fav><datalist><dataitem datatype="77"><datatitle>新资源</datatitle><url>https://example.com/new</url></dataitem></datalist></fav>',
    }))
    expect(host.textContent).toContain('新资源')
    expect(host.textContent).toContain('其他资源 · 类型 77')
  })
})
