// @vitest-environment jsdom
/**
 * `moments-videos.ts` 的行为守卫（第三批 #18 第三步）。
 *
 * 这一族改前**一条用例都没有**。它最要紧的三件事都是「看不见的那一类」：
 *  · 同一个视频被点两次不许发两次 RPC（`videoFetching` 那个 ref，改成 state 就失效）；
 *  · 后端回「取不到」时要留**原因**（未缓存 / CDN 加密流 / 出站被拦），界面上是悬停提示；
 *  · 保存路径必须真由后端写盘（渲染端 `<a download>` 在这个 Electron 里点了没反应，实测）。
 * @module moments-videos-spec
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiGetSnsVideoDataUrl: vi.fn(),
  apiExportSnsVideo: vi.fn(),
  apiSaveFileDialog: vi.fn(),
}))
vi.mock('../api.ts', () => mocks)

const { useMomentsVideos } = await import('./moments-videos.ts')
const HERE = dirname(fileURLToPath(import.meta.url))
type Videos = ReturnType<typeof useMomentsVideos>
type Notify = { flash: (v: string, ms?: number) => void; hold: (v: string) => void; clear: () => void }

let host: HTMLDivElement
let root: Root
let api: Videos | null = null
const notify = vi.hoisted(() => ({ flash: vi.fn(), hold: vi.fn(), clear: vi.fn() }))
const saved: string[] = []

function Harness(): React.JSX.Element {
  api = useMomentsVideos({ notify: notify as unknown as Notify, onSavedPath: (p) => { saved.push(p) } })
  const v = api
  return createElement('div', {
    'data-srcs': Object.keys(v.videoSrcs).sort().join(','),
    'data-failed': [...v.videoFailed].sort().join(','),
    'data-err': [...v.videoErr.entries()].map(([k, m]) => `${k}=${m}`).sort().join(','),
    'data-meta': Object.keys(v.videoMeta).sort().join(','),
  })
}

const attr = (name: string): string => host.firstElementChild?.getAttribute(name) ?? ''
const flush = async (): Promise<void> => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  for (const fn of Object.values(mocks)) fn.mockReset()
  for (const fn of Object.values(notify)) fn.mockReset()
  saved.length = 0
  api = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root.render(createElement(Harness)) })
})

afterEach(() => {
  root.unmount()
  host.remove()
})

describe('loadVideo：取本体', () => {
  it('同一个键连点两次只发一次 RPC，成功之后也不再发', async () => {
    mocks.apiGetSnsVideoDataUrl.mockResolvedValue({ url: 'blob:x' })
    act(() => { api?.loadVideo('v:m1', { md5: 'm1' }) })
    act(() => { api?.loadVideo('v:m1', { md5: 'm1' }) })
    await flush()
    expect(mocks.apiGetSnsVideoDataUrl).toHaveBeenCalledTimes(1)
    expect(attr('data-srcs')).toBe('v:m1')
    act(() => { api?.loadVideo('v:m1', { md5: 'm1' }) })
    await flush()
    expect(mocks.apiGetSnsVideoDataUrl, '已经拿到 src 了还再去取').toHaveBeenCalledTimes(1)
  })

  it('空键不发 RPC（省一次必然失败的往返）', async () => {
    act(() => { api?.loadVideo('', { md5: 'm' }) })
    await flush()
    expect(mocks.apiGetSnsVideoDataUrl).not.toHaveBeenCalled()
  })

  it('参数逐个透传：md5/timelineId/mediaId/url/key 少一个后端就找不回那条', async () => {
    mocks.apiGetSnsVideoDataUrl.mockResolvedValue({ url: 'blob:x' })
    act(() => { api?.loadVideo('v:t:i', { md5: '', timelineId: 't', id: 'i', url: 'https://cdn/x', key: 'seed' }) })
    await flush()
    expect(mocks.apiGetSnsVideoDataUrl).toHaveBeenCalledWith({ md5: '', timelineId: 't', mediaId: 'i', url: 'https://cdn/x', key: 'seed' })
  })

  it('后端说取不到 ⇒ 进失败集，并把**原因**留下（未缓存 / CDN 加密流 / 出站被拦是三种不同提示）', async () => {
    mocks.apiGetSnsVideoDataUrl.mockResolvedValue({ url: '', error: '出站被隐私闸拦住' })
    act(() => { api?.loadVideo('v:m2', { md5: 'm2' }) })
    await flush()
    expect(attr('data-failed')).toBe('v:m2')
    expect(attr('data-err')).toBe('v:m2=出站被隐私闸拦住')
  })

  it('RPC 抛异常也算失败，原因是异常信息（不能只把按钮点没反应留给用户）', async () => {
    mocks.apiGetSnsVideoDataUrl.mockRejectedValue(new Error('IPC 超时'))
    act(() => { api?.loadVideo('v:m3', { md5: 'm3' }) })
    await flush()
    expect(attr('data-failed')).toBe('v:m3')
    expect(attr('data-err')).toBe('v:m3=IPC 超时')
  })

  it('取不到之后再点一次仍会重试（失败不该被永久缓存）', async () => {
    mocks.apiGetSnsVideoDataUrl.mockResolvedValueOnce({ url: '', error: '本机没有缓存' })
    act(() => { api?.loadVideo('v:m4', { md5: 'm4' }) })
    await flush()
    mocks.apiGetSnsVideoDataUrl.mockResolvedValue({ url: 'blob:ok' })
    act(() => { api?.loadVideo('v:m4', { md5: 'm4' }) })
    await flush()
    expect(mocks.apiGetSnsVideoDataUrl).toHaveBeenCalledTimes(2)
    expect(attr('data-srcs')).toBe('v:m4')
  })
})

describe('closeVideo：四份状态一起收干净', () => {
  it('src / failed / err / meta 四项都被清掉', async () => {
    mocks.apiGetSnsVideoDataUrl.mockResolvedValue({ url: 'blob:x' })
    act(() => {
      api?.loadVideo('v:m5', { md5: 'm5' })
      api?.setVideoMeta({ 'v:m5': { w: 9, h: 16 } })
    })
    await flush()
    expect(attr('data-srcs')).toBe('v:m5')
    expect(attr('data-meta')).toBe('v:m5')
    act(() => { api?.closeVideo('v:m5') })
    expect(attr('data-srcs')).toBe('')
    expect(attr('data-meta')).toBe('')
    expect(attr('data-failed')).toBe('')
    expect(attr('data-err')).toBe('')
  })
})

describe('saveVideo：路径由主进程选、字节由后端写', () => {
  it('用户取消选择 ⇒ 一次都不许多写', async () => {
    mocks.apiSaveFileDialog.mockResolvedValue({ canceled: true, path: undefined })
    act(() => { api?.saveVideo({ md5: 'm' }) })
    await flush()
    expect(mocks.apiExportSnsVideo).not.toHaveBeenCalled()
    expect(notify.hold).not.toHaveBeenCalled()
    expect(saved).toEqual([])
  })

  it('后端报成 ok=false 要说清原因，并把落盘路径记回面板', async () => {
    mocks.apiSaveFileDialog.mockResolvedValue({ canceled: false, path: 'D:/v/ok.mp4' })
    mocks.apiExportSnsVideo.mockResolvedValue({ ok: true, bytes: 5 * 1048576 })
    act(() => { api?.saveVideo({ md5: 'abcdefgh1234' }) })
    await flush()
    expect(mocks.apiSaveFileDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultName: '朋友圈视频-abcdefgh.mp4',
    }))
    expect(mocks.apiExportSnsVideo).toHaveBeenCalledWith(expect.objectContaining({ dest: 'D:/v/ok.mp4' }))
    expect(notify.flash).toHaveBeenCalledWith('已保存视频（5 MB）')
    expect(saved).toEqual(['D:/v/ok.mp4'])
  })

  it('后端写失败 ⇒ 用后端给的原因，不自己编一句', async () => {
    mocks.apiSaveFileDialog.mockResolvedValue({ canceled: false, path: 'D:/v/bad.mp4' })
    mocks.apiExportSnsVideo.mockResolvedValue({ ok: false, error: '磁盘只读' })
    act(() => { api?.saveVideo({ md5: 'm' }) })
    await flush()
    expect(notify.hold).toHaveBeenCalledWith('保存失败: 磁盘只读')
    expect(saved).toEqual([])
  })

  it('选路径这一步抛异常也要说出来（改前它在 try 之外 ⇒ 没提示 + 一条未接住的 rejection）', async () => {
    mocks.apiSaveFileDialog.mockRejectedValue(new Error('对话框起不来'))
    act(() => { api?.saveVideo({ md5: 'm' }) })
    await flush()
    expect(notify.hold).toHaveBeenCalledWith('保存失败: 对话框起不来')
    expect(mocks.apiExportSnsVideo, '路径都没选成就去写盘').not.toHaveBeenCalled()
    expect(saved).toEqual([])
  })
})

describe('接线：视频 RPC 只有这一条路', () => {
  it('面板不再自己持有视频状态，也不直接调那两个 RPC', () => {
    const panel = readFileSync(join(HERE, 'moments-panel.tsx'), 'utf8')
    expect(panel).toContain('useMomentsVideos')
    for (const gone of ['const [videoSrcs', 'apiGetSnsVideoDataUrl', 'apiExportSnsVideo', 'videoFetching']) {
      expect(panel, `「${gone}」又回到面板里了`).not.toContain(gone)
      expect(readFileSync(join(HERE, 'moments-videos.ts'), 'utf8'), `本层里也找不到「${gone}」⇒ 判据的对象是编的`).toContain(gone)
    }
  })

  it('面板目录里调 `apiGetSnsVideoDataUrl` 的只有这一层', () => {
    const callers = readdirSync(HERE, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name) && !e.name.includes('.spec.'))
      .filter((e) => readFileSync(join(HERE, e.name), 'utf8').includes('apiGetSnsVideoDataUrl('))
      .map((e) => e.name)
    expect(callers, `调用点散开了：${callers.join(', ') || '（一个都没有 ⇒ 判据空转）'}`).toEqual(['moments-videos.ts'])
  })
})
