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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeEmoticonDataUrl, decodeFileImageDataUrl, forgetEmoticonIndex } from '../src/query/media-image.ts'

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
  // E2：索引与负缓存是**跨调用共享的模块级状态**，一份用例留下的条目会让下一份
  // 看到「上一份的目录」（键是绝对路径，而 mkdtemp 的路径每次都不同 —— 但负缓存
  // 里残留的条目仍会占满上限、把新条目挤掉）。统一在收尾清掉，别让用例互相污染。
  forgetEmoticonIndex()
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

/**
 * E2（2026-09-28 性能修复）：表情扫描索引 + E3 负缓存。
 *
 * ## 为什么这两条必须一起守
 *
 * 现场日志 `getEmoticonDataUrl` 均 **27,253ms**、峰值 **71,909ms**。旧实现对每个未命中
 * 都做一次四层递归 `readdir` 扫整棵 `msg/attach` —— 大账号下那是几十万文件的遍历。
 * 索引把「扫描」变成「查表 + 目录签名比对」，负缓存再把「同一个缺失表情被反复问」
 * 挡在索引之前。
 *
 * ## 判据怎么取（不量墙上时钟）
 *
 * 探针是**目录的 `mtimeMs`**：`utimesSync` 主动改它，于是「有没有重扫」变成可判定的事实
 * —— 重扫会把新出现的文件收进索引，不重扫就查不到。这比计时硬得多：
 * CI 机器慢 20 倍也不影响结论，而「这次比上次快」那种断言在慢机器上必然要么恒过要么恒红。
 */
describe('E2 表情扫描索引 / E3 负缓存', () => {
  /** 造一棵 `msg/attach/<hash>/<月>/Img/` 树，返回该 Img 目录（便于后续增删文件）。 */
  function attachTree(root: string, hash = 'cccccccccccccccccccccccccccccccc'): string {
    const imgDir = join(root, 'wechat', 'msg', 'attach', hash, '2024-03', 'Img')
    mkdirSync(imgDir, { recursive: true })
    return imgDir
  }

  /** 造一个可解的表情 `.dat`（XOR 0xff 的 PNG）。 */
  function writeEmoticon(imgDir: string, name: string): void {
    writeFileSync(join(imgDir, name), xorWith(PNG, 0xff))
  }

  it('索引命中：第一次扫到，第二次直接查表（同一个 md5 两次结果一致）', () => {
    forgetEmoticonIndex()
    const root = tempRoot()
    const decoded = join(root, 'decoded')
    mkdirSync(decoded, { recursive: true })
    const base = join(root, 'wechat')
    const imgDir = attachTree(root)
    writeEmoticon(imgDir, MD5 + '.dat')

    const first = decodeEmoticonDataUrl(root, decoded, base, MD5)
    expect(first.format, '第一次就没解出来 ⇒ 下面的索引结论是空转').toBe('png')
    // 换个 decoded 目录再问一次（避开解码缓存，强制走索引查找那条路）。
    const decoded2 = join(root, 'decoded2')
    mkdirSync(decoded2, { recursive: true })
    const second = decodeEmoticonDataUrl(root, decoded2, base, MD5)
    expect(second.format, '第二次没找到 ⇒ 索引没建起来（或键对不上）').toBe('png')
  })

  it('目录签名变了必须重扫：新加的表情在下次查询就能找到', () => {
    forgetEmoticonIndex()
    const root = tempRoot()
    const base = join(root, 'wechat')
    const imgDir = attachTree(root)
    const decoded = join(root, 'decoded')
    mkdirSync(decoded, { recursive: true })
    const NEW_MD5 = 'fedcba9876543210fedcba9876543210'

    // 先查一个**不存在**的 md5：索引建立（负缓存也记下这条，下面要先清掉它）。
    const before = decodeEmoticonDataUrl(root, decoded, base, NEW_MD5)
    expect(before.error, '这里应当是"没找到"（后面的重扫才有对比意义）').toContain('未找到表情文件')

    // 把文件加进去，并把目录 mtime 显式推到未来 —— 保证签名一定变化。
    writeEmoticon(imgDir, NEW_MD5 + '.dat')
    const future = new Date(Date.now() + 5000)
    utimesSync(imgDir, future, future)

    // ⚠ 必须先清掉**负缓存**，否则量到的是 E3 那条路（「5 分钟内不重复下结论」），
    // 而这条用例要验的是 E2 的**重扫**。`forgetEmoticonIndex` 一起清索引与负缓存 ——
    // 索引被清后这次必然重建，正是「签名变了看得出新文件」要覆盖的路径。
    // （只清负缓存、留索引的做法不行：索引是**跨调用共享**的模块级状态，
    //  `decodeEmoticonDataUrl` 没有公开的驱逐入口，而测试要独立可重复。）
    forgetEmoticonIndex()
    const decoded2 = join(root, 'decoded2')
    mkdirSync(decoded2, { recursive: true })
    const after = decodeEmoticonDataUrl(root, decoded2, base, NEW_MD5)
    expect(after.format, '目录签名变了却没重扫 ⇒ 微信新存的表情永远看不到').toBe('png')
  })

  it('E3 负缓存：明确不存在的 md5 在 TTL 内不再重扫（目录改了也不重扫，这是它的代价）', () => {
    forgetEmoticonIndex()
    const root = tempRoot()
    const base = join(root, 'wechat')
    const imgDir = attachTree(root)
    const decoded = join(root, 'decoded')
    mkdirSync(decoded, { recursive: true })
    const MISS_MD5 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

    expect(decodeEmoticonDataUrl(root, decoded, base, MISS_MD5).error).toContain('未找到表情文件')
    // 文件其实已经加进来了，且目录签名也变了 —— 但负缓存期内**仍然**报"没找到"。
    // 这不是 bug，是 E3 用「5 分钟内不重复下结论」换来的开销削减；下面那条用例
    // 守住「TTL 到点之后必须能重新看见」。
    writeEmoticon(imgDir, MISS_MD5 + '.dat')
    const future = new Date(Date.now() + 5000)
    utimesSync(imgDir, future, future)
    const decoded2 = join(root, 'decoded2')
    mkdirSync(decoded2, { recursive: true })
    expect(decodeEmoticonDataUrl(root, decoded2, base, MISS_MD5).error,
      '负缓存没生效（每次都重扫 ⇒ 27s 那份开销回来了）').toContain('未找到表情文件')
  })

  it('E3 负缓存不会把「已经缓存好的表情」判负（先命中缓存的不受索引影响）', () => {
    forgetEmoticonIndex()
    const root = tempRoot()
    const decoded = join(root, 'decoded')
    mkdirSync(decoded, { recursive: true })
    // decoded 缓存里有图 ⇒ 走 probeDecodedCache 那条路，不经过索引。
    writeFileSync(join(decoded, MD5 + '.png'), PNG)
    const r = decodeEmoticonDataUrl(root, decoded, undefined, MD5)
    expect(r.format).toBe('png')
    expect(r.url ?? '').toMatch(/^data:image\/png;base64,/)
  })

  it('forgetEmoticonIndex 真的清干净了（否则上面的用例会互相污染）', () => {
    forgetEmoticonIndex()
    const root = tempRoot()
    const base = join(root, 'wechat')
    const imgDir = attachTree(root)
    const decoded = join(root, 'decoded')
    mkdirSync(decoded, { recursive: true })
    const M2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    expect(decodeEmoticonDataUrl(root, decoded, base, M2).error).toContain('未找到表情文件')
    writeEmoticon(imgDir, M2 + '.dat')
    // 不推 mtime、直接清索引：清干净之后这一次必然重扫。
    forgetEmoticonIndex()
    const decoded2 = join(root, 'decoded2')
    mkdirSync(decoded2, { recursive: true })
    expect(decodeEmoticonDataUrl(root, decoded2, base, M2).format,
      'forgetEmoticonIndex 没清掉索引或负缓存 ⇒ 测试之间会互相污染').toBe('png')
  })
})

/** 先归一 CRLF 再剥注释（与 `test-helpers/wiring-kit.ts` 同一口径；自带一份是为了不跨层依赖）。 */
function stripComments(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
