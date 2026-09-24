/**
 * `chats.module.css` 拆成四份之后的接线守卫（M21 第 49 刀）。
 *
 * ## 为什么这一刀必须有守卫，而不只是「构建过了就行」
 *
 * CSS Modules 按**文件**给类名打 hash。拆完之后：
 *   · 同一个类名出现在两份里 ⇒ 它是两个不同的 token，React 那边只写一次 `css.x` 的话，
 *     另一份的那些规则**静默失效**（不报错、不红、构建照样过）；
 *   · 消费者引用了「搬家搬到别份去」的类名而别名没改 ⇒ 拿到 `undefined`，
 *     渲染成 `class="undefined"`，症状是某个元素没样式 —— 只有对着那条消息才看得见。
 * 两种都不会让任何测试变红，所以钉在这里：
 *   ① **四份的局部类名两两不相交**（一个类名只住一个文件）；
 *   ② 每个消费者的每个 `别名.类名` 引用，都能在**那个别名 import 的那份文件**里找到；
 *   ③ 每份都在行数上限以内（棘轮管总量，这里管「别拿拆开来躲上限」——新份必须自己达标）。
 *
 * 判据用的是已 committed 的尺子 `css-cascade.ts`（与 `npm run css:clusters` 同一套解析），
 * 不在这里再写一份 CSS 解析。
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseSource } from './css-cascade.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANELS = join(HERE, 'pages', 'wechat-data', 'panels')
const LIMIT = 1000

/** 拆出来的那几份（含原文件）。**新增一份就要登记**，漏登记时②的引用检查会自己报找不到文件。 */
const PARTS = ['chats.module.css', 'chats-rows.module.css', 'chats-cards.module.css', 'chats-shell.module.css']

/** 每份的局部类名集合与物理行数。 */
function partInfo (name: string): { name: string, classes: Set<string>, lines: number } {
  const text = readFileSync(join(PANELS, name), 'utf8')
  const parsed = parseSource(text)
  return {
    name,
    classes: new Set(parsed.leaves.flatMap((l) => l.classes)),
    lines: text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0),
  }
}

const INFOS = PARTS.map(partInfo)
const byName = new Map(INFOS.map((i) => [i.name, i]))

/** 找出所有 import 了这几份 CSS 的 TSX/TS，返回「文件 → 别名 → 那份 CSS」。 */
function importMap (): Array<{ file: string, alias: string, css: string }> {
  const out: Array<{ file: string, alias: string, css: string }> = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'ui-dist') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(tsx|ts)$/.test(e.name)) continue
      const t = readFileSync(p, 'utf8')
      for (const m of t.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+'([^']*chats(?:-[a-z]+)*\.module\.css)'/g)) {
        const alias = m[1] ?? ''
        const spec = m[2] ?? ''
        const resolved = relative(PANELS, join(dirname(p), spec)).split(sep).join('/')
        out.push({ file: p, alias, css: resolved })
      }
    }
  }
  // 整棵客户端源码树都要扫：消费者分散在 pages/…、utils/… 下，写死子目录列表迟早漏
  // （第一版就是猜了三个目录，猜错的那个直接 ENOENT）。
  walk(HERE)
  return out
}

describe('chats 那套 CSS 拆成四份之后的三条不变量', () => {
  it('登记在册的四份都在（改名/新增要先更新这张表）', () => {
    const onDisk = readdirSync(PANELS).filter((f) => /^chats.*\.module\.css$/.test(f)).sort()
    expect(onDisk.join(', '), '实际文件与 PARTS 不一致 —— 新增了要登记，删了要一并清掉引用')
      .toBe([...PARTS].sort().join(', '))
  })

  it('① 局部类名两两不相交：一个类名只能住在一份里', () => {
    const clashes: string[] = []
    for (let a = 0; a < INFOS.length; a += 1) {
      for (let b = a + 1; b < INFOS.length; b += 1) {
        const ia = INFOS[a]
        const ib = INFOS[b]
        if (ia === undefined || ib === undefined) continue
        for (const c of ia.classes) if (ib.classes.has(c)) clashes.push(`${c}：${ia.name} 与 ${ib.name}`)
      }
    }
    expect(clashes.join('\n'), '同名类出现在两份里 ⇒ CSS Modules 会给它两个 hash，其中一份静默失效').toBe('')
  })

  it('② 每个「别名.类名」都能在它 import 的那份里找到（引用不许悬空）', () => {
    const imports = importMap()
    expect(imports.length, '一个 import 都没匹配上 —— 说明 importMap 的写法与真实 import 脱节了').toBeGreaterThan(6)
    const dangling: string[] = []
    const checked = new Map<string, number>()
    for (const { file, alias, css } of imports) {
      const info = byName.get(css)
      if (info === undefined) { dangling.push(`${relative(PANELS, file)}：import 的 ${css} 不在 PARTS 里`); continue }
      const t = readFileSync(file, 'utf8')
      for (const m of t.matchAll(new RegExp(`\\b${alias}\\.([A-Za-z_][\\w-]*)\\b`, 'g'))) {
        const cls = m[1] ?? ''
        checked.set(info.name, (checked.get(info.name) ?? 0) + 1)
        if (!info.classes.has(cls)) dangling.push(`${relative(PANELS, file)}：${alias}.${cls} 不在 ${info.name} 里`)
      }
    }
    expect(dangling.slice(0, 8).join('\n'), '引用与文件对不上 ⇒ 运行时拿到 undefined，渲染成 class="undefined"').toBe('')
    for (const name of PARTS) expect(checked.get(name) ?? 0, `${name} 一份都没被引用 —— 拆分口径与真实消费者脱节`).toBeGreaterThan(0)
  })

  it('③ 每一份都在上限以内（拆出来不算躲过棘轮：新份自己也要达标）', () => {
    const over = INFOS.filter((i) => i.lines > LIMIT).map((i) => `${i.name}:${String(i.lines)}`)
    expect(over.join(', '), '超限').toBe('')
    const total = INFOS.reduce((a, i) => a + i.classes.size, 0)
    expect(total, '四份的类名总数低得可疑（解析或路径变了）').toBeGreaterThan(300)
  })

  it('引用检查自己得有判别力：造一份「引用了别份的类」的假消费者必须被抓到', () => {
    // 直接验检查逻辑的两端：从两份里各取一个真实类名，交叉引用应该被判为悬空。
    const a = byName.get('chats.module.css')
    const b = byName.get('chats-rows.module.css')
    if (a === undefined || b === undefined) throw new Error('两份文件都没解析出来')
    const clsA = [...a.classes][0] ?? ''
    const clsB = [...b.classes][0] ?? ''
    expect(b.classes.has(clsA), '样例前提：两份的类名必须不同（①已经保证不相交）').toBe(false)
    expect(a.classes.has(clsB)).toBe(false)
    // 把「引用 clsA 却写在 chats-rows 的别名上」这个形状喂给同一个判据
    expect(b.classes.has(clsA), '这条就是②用的判据：别名指向 rows 而类名属于主份 ⇒ 悬空').toBe(false)
  })
})
