/**
 * 「同一个字面量只允许一个主人」（P3-3 MD5 正则 / P3-4 图片 AES 密钥字节化）。
 *
 * ## 为什么这两件事值得合成一份用例
 *
 * 它们坏的是同一个机制：一个字面量/一段表达式散在很多文件里，改其中一处时另外几处
 * 静默保持旧口径。审查报告数到 MD5 正则 10 处、AES 密钥转换 6 处 —— 而 AES 那 6 处里
 * **4 处带 `length > 0` 判定、2 处不带**。不带的那里，配置里没填密钥（空串）会被变成
 * **长度为 0 的 key**，于是 `createDecipheriv` 抛 `Invalid key length`：
 * 界面上是「这张图取不出来」，真实原因是「还没配密钥」—— 该催用户去「数据配置」的一件事，
 * 被报成了像坏了的一样。
 *
 * ## 判据
 *
 * 行为：两个主人的输入输出逐个钉（含边界）；
 * 一致性：全仓扫「这个字面量还散在几处」，**零容忍**（都已收口，加新站点就红）；
 * 反例自证：把判据喂给它自己该抓的那种写法，必须报出来 —— 否则「扫不到」和「没有违规」长得一样。
 * @vitest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MD5_FIND_RE, MD5_RE, MD5_RE_LOOSE, MD5_SEGMENT, isMd5, isMd5Loose } from '../src/md5.ts'
import { normalizeAesKey } from '../src/keys/image-key.ts'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const MD5_OWNER = 'md5.ts'
const KEY_OWNER = join('keys', 'image-key.ts')
const MD5_LITERAL = '[0-9a-f]{32}'
/** AES 密钥字节化的那段表达式（去掉了空格，容忍不同缩进）。 */
const AES_INLINE = /Buffer\.from\(\s*aesKey\s*,\s*'ascii'\s*\)/

const MD5_32 = '0123456789abcdef0123456789abcdef'

/** 去掉块注释与行注释（判据只看代码，注释里讲到这个字面量是正常的）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) { out.push(...tsFiles(abs)); continue }
    if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.includes('.spec.')) out.push(abs)
  }
  return out
}

const files = tsFiles(SRC)

describe('md5 字面量的唯一出处', () => {
  it('isMd5 只认 32 位**小写**十六进制整串（缓存文件名口径）', () => {
    expect(isMd5(MD5_32)).toBe(true)
    expect(isMd5(MD5_32.toUpperCase()), '大写也算 ⇒ 与「文件名一定是小写」的既有口径不一致').toBe(false)
    expect(isMd5(MD5_32.slice(0, 31))).toBe(false)
    expect(isMd5(MD5_32 + '0')).toBe(false)
    expect(isMd5('0123456789abcdef0123456789abcdeg')).toBe(false)
    expect(isMd5('')).toBe(false)
    expect(isMd5(' ' + MD5_32)).toBe(false)
    expect(isMd5(MD5_32 + '.dat')).toBe(false)
  })

  it('isMd5Loose 认大小写，但它不代替归一化（拿到之后仍要 toLowerCase）', () => {
    expect(isMd5Loose(MD5_32.toUpperCase())).toBe(true)
    expect(isMd5Loose('0123456789ABCDEF0123456789ABCDEF')).toBe(true)
    expect(isMd5Loose(MD5_32.slice(0, 31))).toBe(false)
  })

  it('MD5_SEGMENT 拼进更大的模式仍然等价（前缀/后缀两处站点靠它，不各写一份）', () => {
    const prefix = new RegExp('^(' + MD5_SEGMENT + ')', 'i')
    expect(prefix.exec(MD5_32 + '_t.dat')?.[1]).toBe(MD5_32)
    expect(prefix.exec('deadbeef.dat'), '只有 8 位十六进制不该算 md5 前缀').toBeNull()
    const cache = new RegExp('^(' + MD5_SEGMENT + ')(\\.t)?\\.(' + 'jpg|png' + ')$', 'i')
    expect(cache.test(MD5_32 + '.t.jpg')).toBe(true)
    expect(cache.test(MD5_32 + '.hevc')).toBe(false)
  })

  it('共享的正则实例必须无 g 标（有 g 就会带着 lastIndex 跨调用漂）', () => {
    // 这些常量现在被十几处共用：一旦有人加 `g`，`.test`/`.exec` 就从上次结束的位置继续找，
    // 表现为「同样的输入，第二次调用结果不同」—— 极难查。这里直接把它钉死。
    for (const [name, re] of [['MD5_RE', MD5_RE], ['MD5_RE_LOOSE', MD5_RE_LOOSE], ['MD5_FIND_RE', MD5_FIND_RE]] as const) {
      expect(re.flags, `${name} 多了标志位 ⇒ 共享实例会互相踩 lastIndex`).not.toContain('g')
      expect(re.test(MD5_32)).toBe(true)
      expect(re.test(MD5_32), `${name} 第二次判定变了`).toBe(true)
    }
    const hay = 'x' + MD5_32 + 'y'
    expect(MD5_FIND_RE.exec(hay)?.[0]).toBe(MD5_32)
    expect(MD5_FIND_RE.exec(hay)?.[0], '抽取型正则第二次调用结果变了 ⇒ 状态泄漏').toBe(MD5_32)
  })
})

describe('图片 AES 密钥的唯一归一化', () => {
  it('16 个 ASCII 字符 ⇒ 16 字节；Buffer/Uint8Array 原样；缺失与空白 ⇒ null', () => {
    const bytes = normalizeAesKey('abcdefghijklmnop')
    expect(bytes?.length).toBe(16)
    expect(bytes?.toString('ascii')).toBe('abcdefghijklmnop')
    expect(normalizeAesKey(Buffer.from('abcdefghijklmnop', 'ascii'))?.length).toBe(16)
    expect(normalizeAesKey(new Uint8Array([1, 2, 3]))?.length).toBe(3)
    for (const empty of ['', '   ', '\t\n', null, undefined]) {
      expect(normalizeAesKey(empty as string), `${JSON.stringify(empty)} 应当被当成「没有密钥」`).toBeNull()
    }
    expect(normalizeAesKey(Buffer.alloc(0))).toBeNull()
    expect(normalizeAesKey(new Uint8Array(0))).toBeNull()
  })

  it('为什么必须是 null 而不是 0 字节 key：空 key 会让解密层抛「Invalid key length」', () => {
    // 这条不是在测本模块，是在**钉住症状**：旧的两处写法把空串交给 Buffer.from ⇒
    // 长度 0 的 key ⇒ createDecipheriv 直接抛，界面显示成「这张图取不出来」。
    const { createDecipheriv } = require('node:crypto') as typeof import('node:crypto')
    expect(() => createDecipheriv('aes-128-ecb', Buffer.alloc(0), null)).toThrow(/key length/i)
    // 而调用方的退化分支只认 null：
    expect(normalizeAesKey('')).toBeNull()
  })

  it('密钥里有非 ASCII 字符时不截断长度，但高位会被 ascii 编码抹掉（钉住现状，别当成校验）', () => {
    // 既有口径就是 `Buffer.from(key, 'ascii')`：长度保持 16，但每个字符只保留低 7 位
    // （'é'=0xE9 ⇒ 0x69='i'）。也就是说「配了个看起来对的密钥」与「解出来的密钥」
    // 可能不是同一份 —— 这条用例把它写成可见事实，免得下次有人拿「密钥明明填对了」当证据。
    const weird = normalizeAesKey('abcdefghijklmnop'.slice(0, 15) + '\u00e9')
    expect(weird?.length).toBe(16)
    expect(weird?.toString('ascii')[15]).toBe('i')
    expect(weird?.toString('ascii')).not.toBe('abcdefghijklmnop'.slice(0, 15) + '\u00e9')
  })
})

describe('两个一致性的守卫本身不许空转', () => {
  it('扫描集合非空（一个文件都没扫到 ⇒ 下面两条是恒真）', () => {
    expect(files.length, '没扫到后端源码文件').toBeGreaterThan(80)
    expect(files.some((f) => f.endsWith(MD5_OWNER))).toBe(true)
    expect(files.some((f) => f.endsWith(KEY_OWNER))).toBe(true)
  })

  it('MD5 字面量只许住在 md5.ts 里（P3-3 收口之后零容忍）', () => {
    const offenders: string[] = []
    for (const abs of files) {
      if (abs.endsWith(MD5_OWNER)) continue
      const body = stripComments(readFileSync(abs, 'utf8'))
      if (body.includes(MD5_LITERAL) || /\[0-9a-f\]\{32\}/.test(body)) offenders.push(abs.slice(SRC.length + 1))
    }
    expect(offenders, '这些文件又自己写了一遍 32 位十六进制的字面量：\n  ' + offenders.join('\n  ')).toEqual([])
  })

  it('aesKey → Buffer 只许住在 keys/image-key.ts 里（P3-4）', () => {
    const offenders: string[] = []
    for (const abs of files) {
      if (abs.endsWith(KEY_OWNER)) continue
      const body = stripComments(readFileSync(abs, 'utf8'))
      if (AES_INLINE.test(body)) offenders.push(abs.slice(SRC.length + 1))
    }
    expect(offenders, '这些文件绕过了 normalizeAesKey（空串口径就是这么散开的）：\n  ' + offenders.join('\n  ')).toEqual([])
  })

  it('判据自证：喂它一段违规代码，必须报出来', () => {
    const dirtyMd5 = "const OK = /^[0-9a-f]{32}$/.test(x)\n"
    expect(stripComments(dirtyMd5)).toMatch(/\[0-9a-f\]\{32\}/)
    const dirtyAes = "const k = Buffer.from(aesKey, 'ascii')\n"
    expect(AES_INLINE.test(stripComments(dirtyAes)), '扫不出违规写法 ⇒ 上面两条恒真').toBe(true)
    // 反向：合规写法不许被报（否则清单会被噪声淹没）
    expect(AES_INLINE.test(stripComments('const k = normalizeAesKey(aesKey)\n'))).toBe(false)
    expect(stripComments("/* 注释里提到 [0-9a-f]{32} */\nconst k = isMd5(s)\n")).not.toMatch(/\[0-9a-f\]\{32\}/)
  })
})
