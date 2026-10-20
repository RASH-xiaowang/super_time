/**
 * `fileOnly` 返回整形（纯函数）：有 file 时去掉 base64 url，没 file 时保持 url 兜底。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { withoutDataUrlWhenFile } from '../src/remotes/media.ts'

describe('withoutDataUrlWhenFile：fileOnly 模式', () => {
  it('有 file ⇒ 删掉 url，保留 format/thumb/error，且不改入参', () => {
    const input = { file: 'wxid_a/ab12.jpg', url: 'data:image/jpeg;base64,xxx', format: 'jpg', thumb: true }
    const out = withoutDataUrlWhenFile(input)
    expect(out).toEqual({ file: 'wxid_a/ab12.jpg', format: 'jpg', thumb: true })
    expect(input.url, '不应修改调用方对象').toBe('data:image/jpeg;base64,xxx')
  })

  it('没有 file / file 为空 ⇒ 原样保留 url（远端 CDN 取回、解码失败、老快照）', () => {
    const dataOnly = { url: 'data:image/png;base64,yyy' }
    expect(withoutDataUrlWhenFile(dataOnly)).toBe(dataOnly)
    expect(withoutDataUrlWhenFile({ file: '', url: 'data:image/png;base64,yyy' })).toEqual({ file: '', url: 'data:image/png;base64,yyy' })
    expect(withoutDataUrlWhenFile<{ file?: string; url?: string; error?: string }>({ error: '本机只有缩略图' })).toEqual({ error: '本机只有缩略图' })
  })
})
