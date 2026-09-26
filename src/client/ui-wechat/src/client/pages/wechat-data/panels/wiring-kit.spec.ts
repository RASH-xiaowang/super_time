/**
 * `wiring-kit.ts` 的自检：这批 helper 是**44 份守卫的地基**，它们自己错了，
 * 上面所有断言都会一起骗人（要么全假绿、要么本地绿 CI 红）。
 *
 * 所以这里对每个 helper 都测**两侧**：
 *   正向 —— 正常输入给出预期结果；
 *   反向 —— 坏输入必须**抛错/变红**，而不是返回空串让调用方的 `not.toContain` 全绿。
 *
 * 「锚点缺失时返回空串」是本项目最贵的一类假绿：把要守的代码删掉，
 * 断言照样通过。所以下面每一条反向用例都是针对它的。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  allClassBlocks,
  assertSettledContract,
  atLeast,
  classBlock,
  findRoot,
  readStripped,
  readText,
  readUnion,
  sliceBetween,
  stripComments,
} from './wiring-kit.ts'

const HERE = import.meta.dirname
const ROOT = findRoot(HERE)

describe('stripComments：归一 + 剥注释', () => {
  it('剥掉块注释与行注释，且不改变行数结构', () => {
    const out = stripComments('const a = 1 // 尾注释\n/* 块\n注释 */\nconst b = 2\n')
    expect(out).toContain('const a = 1')
    expect(out).toContain('const b = 2')
    expect(out).not.toContain('尾注释')
    expect(out).not.toContain('块')
  })

  it('CRLF 先归一，否则行注释正则会留下 \\r 让跨行锚点对不上', () => {
    expect(stripComments('a\r\n// c\r\nb')).toBe('a\n\nb')
  })

  it('不把 `https://` 里的 `//` 当注释起点（行注释正则的 `(^|[^:])` 前置就是为它）', () => {
    const src = "const u = 'https://example.com/x'\nconst v = 'wss://a/b'\n"
    expect(stripComments(src)).toBe(src)
  })

  it('行首的 `//` 仍然要剥（不能因为怕误伤协议就漏掉整行注释）', () => {
    expect(stripComments('// 整行注释\nconst a = 1\n')).toBe('\nconst a = 1\n')
  })
})

describe('readText / readStripped / readUnion', () => {
  it('readText 读得到、readStripped 顺手剥注释', () => {
    expect(readText(join(HERE, 'chats-source.ts'))).toContain('readChatsSource')
    expect(readStripped(join(HERE, 'chats-source.ts'))).not.toContain('前缀扫描用 readdir')
  })

  it('文件不存在时直接抛（守卫读不到被守护的文件必须炸，不能静默当空串）', () => {
    expect(() => readText(join(HERE, '__不存在的文件__.ts'))).toThrow()
    expect(() => readStripped(join(HERE, '__不存在的文件__.ts'))).toThrow()
  })

  it('readUnion 把入口与「按前缀扫到的拆分模块」合成一份，且比单独读入口长得多', () => {
    const union = readUnion(HERE, /^settings-[a-z-]+\.tsx?$/, ['Settings.tsx'])
    const entryOnly = readText(join(HERE, 'Settings.tsx'))
    expect(union).toContain('useSettingsState')
    expect(union.length, '没扫到 settings-*.tsx 拆分模块').toBeGreaterThan(entryOnly.length * 2)
  })
})

describe('sliceBetween：锚点切片（锚点缺失必须变红）', () => {
  const text = 'HEAD\nconst fn = () => {\n  step1()\n  step2()\n}\nTAIL\n'

  it('切开两锚点之间（不含终点）', () => {
    const seg = sliceBetween(text, 'const fn = () => {', 'TAIL', '示例')
    expect(seg).toContain('step1()')
    expect(seg).not.toContain('TAIL')
  })

  it('起点锚点找不到 → 抛（旧写法返回空串会让后续 not.toContain 全绿）', () => {
    expect(() => sliceBetween(text, '不存在的锚点', 'TAIL', '示例')).toThrow()
  })

  it('终点锚点找不到 → 抛', () => {
    expect(() => sliceBetween(text, 'const fn', '不存在的锚点', '示例')).toThrow()
  })

  it('终点在起点之前 → 抛（顺序写反了要立刻发现，而不是切出一个倒序的怪片段）', () => {
    expect(() => sliceBetween(text, 'TAIL', 'const fn', '示例')).toThrow()
  })
})

describe('classBlock：取 CSS 声明块（类名缺失必须变红）', () => {
  const css = '.a {\n  color: red;\n}\n.aLong {\n  color: blue;\n}\n'

  it('取到目标类的块，且不越过后面的规则', () => {
    expect(classBlock(css, 'a')).toContain('color: red')
    expect(classBlock(css, 'a')).not.toContain('blue')
  })

  it('类名是另一个类名的前缀时不会误命中（`.a {` 带空格匹配）', () => {
    expect(classBlock(css, 'aLong')).toContain('blue')
  })

  it('找不到该类 → 抛', () => {
    expect(() => classBlock(css, '不存在')).toThrow()
  })

  it('同一个类被声明多次时，classBlock 只给**第一条**（这可能只是媒体查询里的局部覆盖）', () => {
    const multi = '.c { flex: none; }\n.c { color: red; }\n'
    expect(classBlock(multi, 'c')).toBe('.c { flex: none; ')
    // 这就是它必须配 allClassBlocks 的原因：对第一条下「没有 color」的结论会错。
    expect(classBlock(multi, 'c')).not.toContain('color')
    expect(allClassBlocks(multi, 'c').length).toBe(2)
  })
})

describe('allClassBlocks：取同一类的全部声明块', () => {
  const css = '.c { flex: none; }\n.c { color: red; }\nother {}\n.c { gap: 8px; }\n'

  it('按出现顺序全给出来', () => {
    const blocks = allClassBlocks(css, 'c')
    expect(blocks.length).toBe(3)
    expect(blocks[0]).toContain('flex: none')
    expect(blocks[2]).toContain('gap: 8px')
  })

  it('一条都没有时返回空数组（调用方自己断言长度，避免"空集上 some 恒假"的静默失败）', () => {
    expect(allClassBlocks(css, '不存在')).toEqual([])
  })
})

describe('findRoot / atLeast', () => {
  it('从 panels 目录向上能找到仓库根（用仓库标志文件独立校验，不靠层数算术）', () => {
    const root = findRoot(HERE)
    expect(root).not.toBe(HERE)
    expect(existsSync(join(root, 'main.js')), '根目录必须有 main.js').toBe(true)
    expect(existsSync(join(root, 'package.json')), '根目录必须有 package.json').toBe(true)
    expect(existsSync(join(root, 'scripts', 'panel-audit.mjs')), '根目录下应有 scripts/panel-audit.mjs').toBe(true)
    // 反向：根下面不该再有 main.js（挑到 src/ 之类的浅层就会多一层）
    expect(existsSync(join(root, 'src', 'main.js')), '说明只上溯到了 src/ 而不是仓库根').toBe(false)
  })

  it('找不到时抛错，而不是返回一个猜的路径', () => {
    // 用一个**保证为空**的临时目录做起点：不能拿 node_modules/electron 当反例 ——
    // 那个包里恰好同时有 package.json 与 main.js，findRoot 会把它当成"仓库根"（实测踩过）。
    const empty = mkdtempSync(join(tmpdir(), 'wk-noroot-'))
    try {
      expect(() => findRoot(empty)).toThrow()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('atLeast 是防空转哨兵：低于下限就红（否则「扫到 0 个文件」会让整条守卫空转）', () => {
    expect(() => atLeast(3, 3, '示例')).not.toThrow()
    expect(() => atLeast(0, 3, '示例')).toThrow()
  })
})

describe('assertSettledContract：审计工具的落定口径', () => {
  const audit = readText(join(ROOT, 'scripts', 'panel-audit.mjs'))

  it('真实的 panel-audit.mjs 满足五条落定契约', () => {
    expect(() => assertSettledContract(audit)).not.toThrow()
  })

  it('骨架检测被去掉 → 红（就是它当初把「首屏空面板」记成布局缺陷）', () => {
    expect(() => assertSettledContract(audit.replace(/skel/g, 'skelX'))).toThrow()
  })

  it('最短等待被去掉 → 红（纯稳定性判定挡不住首屏空面板）', () => {
    expect(() => assertSettledContract(audit.replace('Date.now() - t0 > minMs', 'true'))).toThrow()
  })

  it('稳定性次数要求被放宽到 1 次 → 红', () => {
    expect(() => assertSettledContract(audit.replace('stable >= 3', 'stable >= 1'))).toThrow()
  })
})
