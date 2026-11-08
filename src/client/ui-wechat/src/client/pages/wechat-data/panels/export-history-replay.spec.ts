import { describe, expect, it } from 'vitest'
import { buildMomentsReplayOptions, splitReplayPath } from './export-history-replay.ts'

describe('朋友圈导出历史重放', () => {
  it('保留 ZIP 原始媒体开关并替换新路径', () => {
    const entry = {
      format: 'zip',
      params: JSON.stringify({
        username: 'wxid_me',
        authorName: '我',
        q: '旅行',
        images: true,
        media: 'image',
        month: '2026-10',
        mine: 'mine',
        zip: true,
        includeImages: false,
        includeVideos: true,
        includeLivePhotos: false,
        from: 100,
        to: 200,
        dir: 'D:/old',
        filename: 'old.zip',
        kind: 'not-a-moments-option',
      }),
    }
    expect(buildMomentsReplayOptions(entry, 'D:\\new\\replay.zip')).toEqual({
      username: 'wxid_me',
      authorName: '我',
      q: '旅行',
      images: true,
      media: 'image',
      month: '2026-10',
      mine: 'mine',
      zip: true,
      includeImages: false,
      includeVideos: true,
      includeLivePhotos: false,
      from: 100,
      to: 200,
      dir: 'D:\\new\\',
      filename: 'replay.zip',
    })
  })

  it('旧记录格式为 zip 时即使参数漏写 zip 也按 ZIP 重放', () => {
    const opts = buildMomentsReplayOptions({
      format: 'zip',
      params: JSON.stringify({ images: false, includeImages: false }),
    }, 'D:/out/replay.zip')
    expect(opts).toEqual({
      zip: true,
      images: false,
      includeImages: false,
      dir: 'D:/out/',
      filename: 'replay.zip',
    })
  })

  it('非 ZIP 记录不会凭空带 ZIP 媒体参数', () => {
    const opts = buildMomentsReplayOptions({
      format: 'html',
      params: JSON.stringify({ images: true }),
    }, 'D:/out/replay.html')
    expect(opts).toEqual({
      format: 'html',
      images: true,
      dir: 'D:/out/',
      filename: 'replay.html',
    })
  })

  it('重放任务带本次 jobId，便于进度事件正确归属', () => {
    const opts = buildMomentsReplayOptions({ format: 'html', params: '{}' }, 'D:/out/replay.html', 'export-history-123')
    expect(opts.jobId).toBe('export-history-123')
  })

  it('完整路径按最后一个 Windows/Unix 分隔符拆分', () => {
    expect(splitReplayPath('C:\\Users\\me\\Desktop\\朋友圈.zip')).toEqual({
      dir: 'C:\\Users\\me\\Desktop\\',
      filename: '朋友圈.zip',
    })
    expect(splitReplayPath('/tmp/export/moments.json')).toEqual({
      dir: '/tmp/export/',
      filename: 'moments.json',
    })
  })
})
