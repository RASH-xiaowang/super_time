/**
 * kit 的 CSS 拆分守卫（M21 第十七刀）。
 *
 * 拆 CSS Modules 有两个只在运行期才现形、单测与 SSR 冒烟都抓不到的坑：
 *
 *   ① **跨份引用**：选择器里写 `.<类>` 时，类名会被**所在文件**的哈希改写。所以一条规则里
 *      引用的每个类都必须在**同一份** CSS 里定义 —— 否则那个类名与元素实际拿到的名字对不上，
 *      规则**静默失效**（样式不见了但页面不报错）。第十七刀勘测时 `.root` 与 `ovCardBd`
 *      两次都栽在这个模式上：整块搬走后，引用它们的规则留在了原文件。
 *   ② **跨份选择器列表**：同一条规则的选择器列表若跨两份（如焦点环把 overlay 与 shell 的类
 *      列在一起），整条留在任一侧都会让另一侧的控件**失去该规则**。正解是按归属一分为二，
 *      但必须保证「声明块逐字相同」且「选择器并集不变」。
 *
 * 本文件只覆盖 kit 的三份 CSS（后续再拆别的面板时，把那份也加进 FILES 即可）。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILES = ['kit.module.css', 'kit-table.module.css', 'kit-overlay.module.css']
const src = (f: string): string => readFileSync(join(HERE, f), 'utf8')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '')

/** 一份 CSS 里**定义**的类（行首 `.X`）。 */
function defined(s: string): Set<string> {
  return new Set([...strip(s).matchAll(/^\.([A-Za-z_][\w-]*)/gm)].map((m) => m[1]))
}

/** 一份 CSS 里**被选择器引用**的类（`.<类>` 出现在某个 `{` 之前）。 */
function referenced(s: string): Set<string> {
  // 用括号定位而不是「`}` + 选择器 + `{`」：后者会把 `}` 吃进匹配，
  // 相邻的两条规则里必有一条读不到（第一次写就漏掉了追加在文件末尾的那条）。
  const t = strip(s)
  const out = new Set<string>()
  let i = 0
  for (;;) {
    const b = t.indexOf('{', i)
    if (b < 0) break
    for (const c of t.slice(i, b).matchAll(/\.([A-Za-z_][\w-]*)/g)) out.add(c[1] ?? '')
    let depth = 0
    let j = b
    for (; j < t.length; j += 1) {
      if (t[j] === '{') depth += 1
      else if (t[j] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    i = j + 1
  }
  return out
}

/** 取一条规则的声明块（含缩进，逐字）。 */
function block(s: string, selector: string): string {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{\\n([\\s\\S]*?)\\n\\}`).exec(strip(s))
  expect(m, `找不到规则 ${selector}`).toBeTruthy()
  return m?.[1] ?? ''
}

describe('kit 的 CSS 拆分：选择器的类必须在同一份里定义（否则静默失效）', () => {
  for (const f of FILES) {
    it(`${f}：被引用的类都在本份里有定义`, () => {
      const own = defined(src(f))
      const missing = [...referenced(src(f))].filter((c) => !own.has(c))
      expect(missing, `${f} 的选择器引用了别份的类（哈希会对不上，规则静默失效）：${missing.join(', ')}`).toEqual([])
    })
  }

  it('焦点环那条选择器列表按归属一分为二：声明逐字相同、选择器并集不变', () => {
    // 原始是 4 个选择器一条规则（键盘 Tab 看不到焦点才补的，见 kit.module.css 的原注释）。
    const decl = '  outline: none;\n  box-shadow: 0 0 0 2px var(--nm-bg-card), 0 0 0 4px var(--nm-border-active);'
    expect(block(src('kit.module.css'), '.searchClear:focus-visible'), 'kit.module.css 那半的声明块变了').toBe(decl)
    expect(block(src('kit-overlay.module.css'), '.tabTrigger:focus-visible,\n.segItem:focus-visible,\n.drawerClose:focus-visible'),
      'kit-overlay.module.css 那半的声明块变了').toBe(decl)
    const union = ['tabTrigger', 'segItem', 'searchClear', 'drawerClose'].map((c) => `.${c}:focus-visible`)
    const all = src('kit.module.css') + src('kit-overlay.module.css')
    for (const sel of union) {
      expect(all, `${sel} 在拆分后不见了 —— 那个控件会失去焦点环`).toContain(sel)
    }
  })
})
