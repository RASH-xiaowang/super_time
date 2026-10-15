/**
 * 选择器守卫：**任何选择器文本里都不许出现 CSS 转义（反斜杠）**。
 *
 * 起因是一次实测到的静默腐烂（2026-10-14）：`chats-shell.module.css` 里块注释的收尾符之后
 * 紧跟**字面量反斜杠 + n**，然后才是 `.msgHeaderInfo` 的选择器（编辑器把换行写成了转义串）。
 * 构建产物里它编译成：
 *
 *     }n._msgHeaderInfo_ippvg_57{position:absolute;left:50%…
 *
 * 即选择器变成「`<n>` 元素且带该类」，页面上没有 `<n>` 元素 ⇒ 整条规则永不匹配。
 * 那次「会话名居中 + 动作靠右」的微信对齐改动，从写下那天起在真机上一个像素效果都没有。
 *
 * **为什么现有守卫全部放过它**（这条判据存在的理由）：
 *  · `sourceClasses()` 用 `\.([A-Za-z_][\w-]*)` 抽类名，前面的 `n` 是隐形字符 ⇒
 *    拆分不变量②（引用不悬空）成立，`cssshell.msgHeaderInfo` 查得到；
 *  · `check-wx-tokens` 是对着**成品 CSS** 断言类名字面量在不在 ⇒ 也在（它在选择器里）。
 *  两处都「查到了这个类」，没人查「这个类前面的选择器起首是什么」。
 *
 * 判据只看 `parseSource().leaves[].sel` / `.at`（注释已被 `blankComments` 抹成空格），
 * 所以**注释里**的反斜杠不报 —— 这不是理论顾虑：`settings.module.css:306` 的注释里就有一个
 * Windows 路径 `D:\Tencent\Documents\xwechat_…`，扫原始文本的话这条判据第一天就误报。
 *
 * @vitest-environment node
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseSource } from './css-cascade.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** 扫描根：整个前端源码（与 theme-geometry.spec.ts 同款，那一份在 pages/wechat-data 下深三层）。 */
const CLIENT_ROOT = join(HERE, '..', '..')
const SKIP_DIRS = new Set(['node_modules', 'ui-dist', 'public', '.git'])

/**
 * 递归收 `.css`。
 * @param dir - 当前目录。
 * @returns 命中的文件绝对路径。
 */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...walk(p))
    } else if (e.name.endsWith('.css')) {
      out.push(p)
    }
  }
  return out
}

/** 一条「选择器里有转义」的缺陷。 */
interface EscapeDefect { file: string, line: number, sel: string }

/**
 * 找出所有选择器 / at-rule 条件里带反斜杠的条目。
 * @param files - 待扫的 CSS 绝对路径。
 * @returns 缺陷清单（空 = 干净）。
 */
export function selectorEscapeDefects(files: readonly string[]): EscapeDefect[] {
  const out: EscapeDefect[] = []
  for (const f of files) {
    const rel = relative(CLIENT_ROOT, f).replaceAll('\\', '/')
    for (const leaf of parseSource(readFileSync(f, 'utf8')).leaves) {
      for (const part of [leaf.sel, leaf.at]) {
        if (part.includes('\\')) out.push({ file: rel, line: leaf.a, sel: part })
      }
    }
  }
  return out
}

describe('选择器里不许有 CSS 转义（反斜杠）', () => {
  const files = walk(CLIENT_ROOT)
  const defects = selectorEscapeDefects(files)

  it('全仓 .css 的选择器与 at-rule 条件都是干净文本', () => {
    expect(defects.map((d) => `${d.file}:${String(d.line)} ${d.sel}`).join('\n'),
      '反斜杠在源码选择器里会把类名吃掉一部分（`\\n.foo` 编译成 `n._foo_HASH`，永不匹配）').toBe('')
  })

  it('哨兵：扫描真的扫到了东西（防解析坏了 → 扫不到 → 恒绿）', () => {
    expect(files.length, '一份 .css 都没扫到 ⇒ walk 或扫描根坏了').toBeGreaterThan(60)
    let leaves = 0
    for (const f of files) leaves += parseSource(readFileSync(f, 'utf8')).leaves.length
    expect(leaves, '扫到文件却解析不出规则 ⇒ parseSource 坏了').toBeGreaterThan(1000)
  })

  it('判据自己有判别力：造一次 `\\n.bad` 必须被抓，注释里的反斜杠必须不报', () => {
    const probe = join(tmpdir(), `css-escape-probe-${String(process.pid)}.css`)
    const scan = (css: string): EscapeDefect[] => {
      writeFileSync(probe, css, 'utf8')
      return selectorEscapeDefects([probe])
    }
    try {
      const hit = scan('.ok { color: red }\n\\n.bad { color: blue }\n')
      expect(hit.length, '反斜杠选择器没被抓 ⇒ 判据是空的').toBe(1)
      expect(hit[0]!.sel, '抓到的必须正是那条坏选择器').toContain('\\n.bad')

      expect(scan('/* 目录长这样：D:\\Tencent\\Documents\\xwechat_… */\n.ok { color: red }\n').length,
        '注释里的反斜杠被报了 ⇒ 判据没走 blankComments，settings.module.css 会天天误报').toBe(0)

      expect(scan('@media (max-width: 56\\30px) { .ok { color: red } }\n')
        .some((d) => d.sel.includes('@media')), 'at-rule 条件里的转义没被抓').toBe(true)
    } finally {
      rmSync(probe, { force: true })
    }
  })
})
