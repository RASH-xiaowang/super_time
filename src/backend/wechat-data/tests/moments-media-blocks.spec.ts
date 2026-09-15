/**
 * L10：朋友圈 `<media>` 块扫描（`moments.ts` 的 mediaBlocks）的行为等价性 + 源码守卫。
 *
 * 改动只把「每轮 `xml.slice(pos)` 重建余串」（k 块合计 O(k·n) 字符拷贝）换成
 * `indexOf(needle, pos)` 的起点偏移（无拷贝、O(n)）。**输出必须逐字不变**，
 * 所以这里用同一批夹具锁住：块数、顺序、url/thumb/key/md5、以及「遇到未闭合块就停」。
 *
 * 为什么还要一条源码守卫：性能改动是**行为等价**的，把实现退回 `xml.slice(pos)`
 * 之后用例会全绿（这正是 M13 复审抓到的「守卫空转」）。N8 的先例是给函数体加形状断言，
 * 这里沿用：`mediaBlocks` 的函数体里不得出现无起点的余串重建。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSnsXml } from '../src/query/moments.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, '..', 'src', 'query', 'moments.ts'), 'utf8')

/** 取出顶层函数的函数体（本文件风格：函数体以行首 `}` 结束）。 */
function bodyOf(source: string, header: string): string {
  const start = source.indexOf(header)
  expect(start, `${header} 必须仍在源码里`).toBeGreaterThan(-1)
  const end = source.indexOf('\n}', start)
  expect(end, `${header} 的函数体必须仍以顶层 '}' 结束`).toBeGreaterThan(start)
  return source.slice(start, end)
}

/** 一个 `<media>` 块（`<media>` 形态）。 */
function mediaBlock(i: number, url: string, thumb: string): string {
  return `<media><id>m${i}</id><type>2</type>`
    + `<url md5="md5-${i}">${url}</url><thumb>${thumb}</thumb><enc key="key-${i}" /></media>`
}

function contentXml(blocks: string): string {
  return '<TimelineObject><id>tl-1</id><createTime>1700000000</createTime>'
    + `<contentDesc>周末</contentDesc>${blocks}</TimelineObject>`
}

describe('L10 mediaBlocks：行为等价（改前改后输出逐字相同）', () => {
  it('9 张图的正文：块数、顺序、url/thumb/key/md5 全部照旧', () => {
    const blocks = Array.from({ length: 9 }, (_, i) => mediaBlock(i + 1, `https://cdn/x${i + 1}.jpg`, `https://cdn/t${i + 1}.jpg`)).join('')
    const r = parseSnsXml(contentXml(blocks))
    expect(r.mediaCount).toBe(9)
    expect(r.mediaDesc).toBe('图片×9')
    expect(r.images).toHaveLength(9)
    expect(r.videos).toHaveLength(0)
    expect(r.images.map(m => m.url)).toEqual(Array.from({ length: 9 }, (_, i) => `https://cdn/x${i + 1}.jpg`))
    expect(r.images[0]).toMatchObject({ key: 'key-1', md5: 'md5-1', thumb: 'https://cdn/t1.jpg', id: 'm1' })
    expect(r.images[8]).toMatchObject({ key: 'key-9', md5: 'md5-9', id: 'm9' })
    expect(r.text).toBe('周末')
  })

  it('`<media key="…">` 属性形态与 `<media>` 形态混排时按文档顺序扫描', () => {
    const xml = contentXml(
      mediaBlock(1, 'https://cdn/a.jpg', 'https://cdn/at.jpg')
      + '<media key="attr-2"><url md5="md5-2">https://cdn/b.jpg</url><thumb>https://cdn/bt.jpg</thumb></media>'
      + mediaBlock(3, 'https://cdn/c.jpg', 'https://cdn/ct.jpg'),
    )
    const r = parseSnsXml(xml)
    expect(r.mediaCount).toBe(3)
    expect(r.images.map(m => m.url)).toEqual(['https://cdn/a.jpg', 'https://cdn/b.jpg', 'https://cdn/c.jpg'])
    expect(r.images[1]?.md5).toBe('md5-2')
  })

  it('视频链接走 videos 而不是 images，且块仍被逐个扫到', () => {
    const blocks = mediaBlock(1, 'https://cdn/p1.jpg', 'https://cdn/t1.jpg')
      + '<media><id>m2</id><type>6</type><url md5="md5-2">https://snsvideodownload?filekey=x.mp4</url>'
      + '<thumb>https://cdn/t2.jpg</thumb></media>'
    const r = parseSnsXml(contentXml(blocks))
    expect(r.images.map(m => m.url)).toEqual(['https://cdn/p1.jpg'])
    expect(r.videos.map(v => v.url)).toEqual(['https://snsvideodownload?filekey=x.mp4'])
    expect(r.mediaDesc).toBe('视频')
  })

  it('未闭合的 `<media>`（缺 `</media>`）不会死循环、也不会丢前面的块', () => {
    const xml = contentXml(mediaBlock(1, 'https://cdn/p1.jpg', 'https://cdn/t1.jpg') + '<media><url>https://cdn/broken.jpg</url>')
    const r = parseSnsXml(xml)
    expect(r.images.map(m => m.url)).toEqual(['https://cdn/p1.jpg'])
  })

  it('大块数（3000 块）计数仍准确', () => {
    const blocks = Array.from({ length: 3000 }, (_, i) => mediaBlock(i + 1, `https://cdn/x${i}.jpg`, `https://cdn/t${i}.jpg`)).join('')
    const r = parseSnsXml(contentXml(blocks))
    expect(r.images).toHaveLength(3000)
    expect(r.images[2999]?.url).toBe('https://cdn/x2999.jpg')
  })
})

describe('L10 源码守卫：不得退回「每轮两次搜索 + 重建余串」的写法', () => {
  const body = bodyOf(src, 'function mediaBlocks(')

  it('用带起点的绝对偏移定位，而不是 slice(pos) 之后的相对索引', () => {
    expect(body).toContain('indexOf(MEDIA_OPEN, pos)')
    expect(body).not.toMatch(/xml\.slice\(pos\)/)
    expect(body).not.toContain('pos + idx')
  })

  it('两种开标签写法共用一次前缀搜索（`indexOf("<media ", pos)` 是真正的平方项）', () => {
    // 实测（2.9MB / 2 万块）：每块单独找一次 `<media `（正文里全是 `<media>` 时每次都扫到末尾
    // 才放弃）要 17.8s，单次前缀搜索 2.8ms。所以这里禁止那个针回到循环里。
    expect(body).not.toContain("indexOf('<media ', pos)")
    expect(body).not.toContain("indexOf('<media>', pos)")
    expect(body).toContain("xml.charAt(start + MEDIA_OPEN.length)")
  })
})
