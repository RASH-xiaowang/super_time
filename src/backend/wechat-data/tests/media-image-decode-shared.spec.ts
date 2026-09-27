/**
 * P3-5「图片解码三兄弟」抽公共之后的行为守卫 + 反重复判据。
 *
 * 报告那条说的是 `media-image.ts` 里三处结构复制：缓存探测与 `.dat` 解码循环在
 * `decodeImageDataUrl` / `decodeFileImageDataUrl` / `decodeEmoticonDataUrl` 里各抄了一遍。
 * 现在公共部分是 `probeDecodedCache`（按扩展名顺序读已解码缓存）与
 * `decodeDatToResult`（逐个候选解码、跳过 error/hevc、缓存写入 best-effort）。
 *
 * 这里守的是**抽取没把语义抹平**那几件事：
 *   ① 「读失败」与「未命中」不是一回事 —— 前者带着各自的措辞直接报错（两条链的前缀不同），
 *      后者才继续往下一条链走。造确定性读失败的办法是**放一个同名目录**
 *      （`existsSync` 过、`readFileSync` 抛 EISDIR），不依赖权限位，Windows 上也稳定；
 *   ② 表情链**缩略优先**、消息链**原图优先** —— 这个反向差异是刻意的（表情原图多是动图/wxgf），
 *      抽取时它留在调用方，所以两边都要各自的用例；
 *   ③ 解码成功仍要写缓存（`onDecoded` 在返回之前被调用），但缓存写失败不影响这次出图；
 *   ④ hevc（wxgf 转码不可用）这一份要**换下一个候选**而不是当场失败。
 *
 * 末尾一组是反重复判据：公共体只许有一份 —— 结构复制最坏的走样是**改一处漏一处**，
 * 而界面上都叫"图片没显示"，只有日志分得清是哪一处没改。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeEmoticonDataUrl, decodeFileImageDataUrl } from '../src/query/media-image.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 2×2 纯色 PNG 魔数够 `decodeDatBytes` 认成 png（与 `gateway-image-batch.spec.ts` 同一手法）。 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0x01])
/** 整份按 XOR key 取反就是最小可解的 .dat（`detectXorKey` 靠魔数反推出 key）。 */
const xorWith = (bytes: Buffer, key: number): Buffer => Buffer.from(bytes.map(b => b ^ key))
const MD5 = '0123456789abcdef0123456789abcdef'

const temps: string[] = []
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-media-decode-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  for (const d of temps) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 下一条自己报 */ } }
  temps.length = 0
})

describe('probeDecodedCache：读失败与未命中是两件事（两条链各自的措辞）', () => {
  it('缓存里放一个同名**目录** ⇒ 报「读取已解码表情失败」，不是「未找到」', () => {
    const root = tempRoot()
    const decoded = join(root, 'decoded')
    mkdirSync(join(decoded, MD5 + '.png'), { recursive: true })
    const r = decodeEmoticonDataUrl(root, decoded, undefined, MD5)
    expect(r.error ?? '', '读失败必须带自己的前缀（否则两处混成一个）').toMatch(/^读取已解码表情失败:/)
    expect(r.url).toBeUndefined()
  })

  it('文件库那条同样报「读取已解码图片失败」，也不会退化成"未找到"', () => {
    const root = tempRoot()
    const decoded = join(root, 'decoded')
    mkdirSync(join(decoded, MD5 + '.jpg'), { recursive: true })
    const r = decodeFileImageDataUrl(root, decoded, undefined, MD5)
    expect(r.error ?? '').toMatch(/^读取已解码图片失败:/)
    expect(r.url).toBeUndefined()
  })

  it('真命中给出 data URL 与实际格式；一张都没有时才是「未找到」那句', () => {
    const root = tempRoot()
    const decoded = join(root, 'decoded')
    mkdirSync(decoded, { recursive: true })
    writeFileSync(join(decoded, MD5 + '.png'), PNG)
    const hit = decodeEmoticonDataUrl(root, decoded, undefined, MD5)
    expect(hit.format).toBe('png')
    expect(hit.url ?? '').toMatch(/^data:image\/png;base64,/)
    const miss = decodeFileImageDataUrl(root, decoded, undefined, MD5)
    expect(miss.error).toContain('未找到已解密图片')
  })
})

describe('decodeDatToResult：两条链的排序差异留在调用方', () => {
  /** 造一棵表情目录树：`msg/attach/<hash>/2024-01/Img/<md5>{,_t}.dat`。 */
  function attachWithThumb(root: string): void {
    const imgDir = join(root, 'msg', 'attach', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2024-01', 'Img')
    mkdirSync(imgDir, { recursive: true })
    // 原图解出来是 JPG、缩略图解出来是 PNG —— 格式不同才分得出谁先被选中
    writeFileSync(join(imgDir, MD5 + '.dat'), xorWith(JPG, 0xff))
    writeFileSync(join(imgDir, MD5 + '_t.dat'), xorWith(PNG, 0xff))
  }

  it('表情链缩略优先：拿到的是 PNG 那一份，且解码后写回了 decoded 缓存', () => {
    const root = tempRoot()
    const decoded = join(root, 'decoded')
    mkdirSync(decoded, { recursive: true })
    const base = join(root, 'wechat')
    mkdirSync(base, { recursive: true })
    attachWithThumb(base)
    const r = decodeEmoticonDataUrl(root, decoded, base, MD5)
    expect(r.format, '表情链应优先缩略图（原图多是动图/wxgf）').toBe('png')
    expect(r.url ?? '').toMatch(/^data:image\/png;base64,/)
    // onDecoded 真的被调用过：缓存里现在该有这张 png，第二次直接命中同一份
    const again = decodeEmoticonDataUrl(root, decoded, undefined, MD5)
    expect(again.format).toBe('png')
    expect(again.url).toBe(r.url)
  })

  it('hevc（wxgf 转码不可用）这一份要跳过；只剩它时如实报"无法解码为可渲染格式"', () => {
    const root = tempRoot()
    const decoded = join(root, 'decoded')
    mkdirSync(decoded, { recursive: true })
    const base = join(root, 'wechat')
    const imgDir = join(base, 'msg', 'attach', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '2024-01', 'Img')
    mkdirSync(imgDir, { recursive: true })
    // 'wxgf' 四个字节开头：decodeDatBytes 走转码分支，本机没有 DLL 时降级成 hevc
    writeFileSync(join(imgDir, MD5 + '.dat'), Buffer.from([0x77, 0x78, 0x67, 0x66, 0x77, 0x78, 0x67, 0x66, 1, 2, 3, 4]))
    const only = decodeEmoticonDataUrl(root, decoded, base, MD5)
    expect(only.error, 'hevc 不能被当成可渲染结果交出去').toBe('表情文件无法解码为浏览器可渲染格式')
    expect(only.url).toBeUndefined()
  })

  it('没有原始微信目录时不猜路径：报的是"缺少原始微信目录"，不是空 url', () => {
    const root = tempRoot()
    const decoded = join(root, 'decoded')
    mkdirSync(decoded, { recursive: true })
    const r = decodeEmoticonDataUrl(root, decoded, undefined, MD5)
    expect(r.error).toContain('缺少原始微信目录')
    expect(r.url).toBeUndefined()
  })
})

describe('反重复：公共体只许有一份（改一处漏一处就是这类结构的坏法）', () => {
  const src = stripComments(readFileSync(join(HERE, '..', 'src', 'query', 'media-image.ts'), 'utf8'))
  const countOf = (needle: string): number => src.split(needle).length - 1

  it('先自证读到了源码，且读的是**剥注释**之后的那份', () => {
    expect(src.length, 'media-image.ts 没读到').toBeGreaterThan(8000)
    expect(src).toContain('function decodeDatToResult')
    // 注释里提到过 "hevc"、"decodeDatBytes" 等字样：没剥净的话下面的计数会偏大而不是偏小，
    // 所以这里同时断言"注释里的示例代码不算数"这一侧（历史口径：文本扫描三次咬到自己）
    expect(src).not.toContain('P3-5')
  })

  it('hevc 那一跳只出现在公共 helper 里（三处各写一遍的时代结束了）', () => {
    expect(countOf("if (dec.format === 'hevc') continue"), 'hevc 跳过的写法份数').toBe(1)
  })

  it('`decodeDatBytes(…new Uint8Array(bytes)…)` 的直接调用只剩 helper 里那一处', () => {
    expect(countOf('decodeDatBytes(new Uint8Array(bytes)'), '解码调用的散落处数').toBe(1)
  })

  it('两个公共 helper 都被真用上了（抽了没人用等于没抽）', () => {
    expect(countOf('decodeDatToResult('), 'decodeDatToResult 出现次数（定义那行 + 调用点）').toBeGreaterThanOrEqual(4)
    expect(countOf('probeDecodedCache('), 'probeDecodedCache 出现次数（定义那行 + 调用点）').toBeGreaterThanOrEqual(3)
  })
})

/** 先归一 CRLF 再剥注释（与 `test-helpers/wiring-kit.ts` 同一口径；自带一份是为了不跨层依赖）。 */
function stripComments(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
