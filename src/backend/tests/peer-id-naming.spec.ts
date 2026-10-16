// @vitest-environment node
/**
 * 「同一个概念三个名字」的命名纪律（审计 P3-6，并**纠正报告一处并列**）。
 *
 * 报告写的是 `username`(2640) / `talker`(361) / `author`(384) 三名同概念。实测只有前两个是同概念：
 * `MomentEntry.author` 装的是「备注 → 昵称 → ID 逐级回退」出来的**显示名**
 * （`query/moments.ts` 里 `const author = names.get(username) || parsed.nickname || username || '未知'`），
 * 真正的第三个名字是朋友圈过滤参数 `authorUsername`。把显示名当 ID 去 join 会话是查不到的 ——
 * 这类"名字看起来同一层、实际差一层"的字段最容易在被信任的情况下用错，所以把结论写进类型层，
 * 并且**让每个 `talker` 出现处都指回正主**：以后再加同名参数，注释漏了当场红。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'wechat-data', 'src')
const CANON = 'WechatSession.username'

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsFiles(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const rel = (p: string): string => p.replace(SRC + '\\', '').replace(SRC + '/', '').replace(/\\/g, '/')

/** 找某个声明行前面 6 行里的注释文本。 */
function headerAbove(lines: string[], idx: number): string {
  return lines.slice(Math.max(0, idx - 6), idx).join('\n')
}

/** 所有 `talker` 声明处（参数或接口字段），以及它们的"上面有没有指回正主"。 */
function talkerSites(): Array<{ where: string, documented: boolean }> {
  const sites: Array<{ where: string, documented: boolean }> = []
  for (const p of tsFiles(SRC)) {
    const lines = readFileSync(p, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!/^\s*(?:readonly\s+)?talker\??:\s*string/.test(line)) return
      sites.push({ where: `${rel(p)}:${String(i + 1)}`, documented: headerAbove(lines, i).includes(CANON) })
    })
  }
  return sites
}

describe('会话 ID 的命名纪律（P3-6）', () => {
  it('确实扫到了 `talker` 声明处（扫不到 ⇒ 下面两条都是恒真）', () => {
    const sites = talkerSites()
    expect(sites.length, '一个 talker 声明都没扫到 —— 路径或写法判错').toBeGreaterThanOrEqual(3)
  })

  it('每个 `talker` 都在注释里指回正主 `WechatSession.username`', () => {
    const undocumented = talkerSites().filter((s) => !s.documented).map((s) => s.where)
    expect(undocumented, `这些同名字段没写"它是谁的别名"：\n  ${undocumented.join('\n  ')}`).toEqual([])
  })

  it('正主那一处把三个名字与"author 不是 ID"都写清了', () => {
    const types = readFileSync(join(SRC, 'types-chat.ts'), 'utf8')
    const block = types.slice(types.indexOf('export interface WechatSession'), types.indexOf('username: string', types.indexOf('export interface WechatSession')))
    expect(block, '正主的注释里没提 `talker`').toContain('`talker`')
    expect(block, '正主的注释里没提 `authorUsername`').toContain('`authorUsername`')
    expect(block, '正主的注释没澄清 `author` 是显示名（报告那处并列就是被它误导的）').toContain('显示名')

    const moments = readFileSync(join(SRC, 'query', 'moments.ts'), 'utf8').split('\n')
    const at = moments.findIndex((l) => /^\s+author: string$/.test(l))
    expect(at, 'MomentEntry.author 这一格不见了 ⇒ 口径变了要同步改这条判据').toBeGreaterThan(-1)
    expect(headerAbove(moments, at)).toContain('显示名')
  })

  it('反例自证：新加一个没写别名的 `talker` 会被同一条判据抓住', () => {
    const real = talkerSites()
    const missing = real.filter((s) => !s.documented)
    // 现网必须一条不缺（否则上面那条已经在红），而"去掉一处注释"要能造出缺陷
    expect(missing.length, '现网就有未注释的 talker ⇒ 这条判据现在就是红的').toBe(0)
    const sample = readFileSync(join(SRC, 'query', 'messages.ts'), 'utf8').split('\n')
    const idx = sample.findIndex((l) => /^\s+talker: string,$/.test(l))
    expect(idx, 'messages.ts 里没有 `talker: string,` 这一行了').toBeGreaterThan(-1)
    const stripped = [...sample.slice(0, idx - 1), ...sample.slice(idx)]
    const backref = headerAbove(stripped, idx - 1).includes(CANON)
    expect(backref, '把注释删掉后仍然"文档齐全" ⇒ 判据没在看注释').toBe(false)
  })
})
