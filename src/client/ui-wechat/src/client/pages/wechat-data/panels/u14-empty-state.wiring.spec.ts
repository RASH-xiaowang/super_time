/**
 * U14 · 全站空态口径 + 「css.X 引用必须真的存在」。
 *
 * ── 为什么要用一条守卫管这两件事 ─────────────────────────────────────────
 * 它们描述的是同一个失效方式：**界面上看着"有一块东西"，其实样式/内容都没生效**。
 *  · 空态写成裸的一行字 → 用户看不到"为什么空、下一步做什么"；
 *  · `css.X` 在对应 module.css 里**没有定义** → CSS Modules 返回 undefined →
 *    `className={undefined}` 等于没有类，样式静默失效（2026-09-26 实录：
 *    `ExportHistoryDialog.tsx` 的 `css.tdKind` 从未定义，害得「类型」列的
 *    92px 列宽规则一直没命中；同文件还另有两条用错了类名）。
 *
 * ── 口径（本文件定的，改前先读）────────────────────────────────────────
 *  · **整屏/整卡片空态**（用户进来什么都看不到）→ 必须走 `<EmptyState>`，
 *    外层保留面板自己的 `.empty` 管居中，内层 `EmptyState` 管"图标 + 为什么空 + 下一步"。
 *    范式见 `AskHistoryDialog.tsx`。
 *  · **筛选无匹配 / 图内局部提示**（有数据，只是被筛掉或版面上的一角）→ **不换**，
 *    一行字是对的。本文件用 `KEEP_INLINE` 把这几处**显式登记**下来，
 *    免得后人"顺手统一"把它们撑成整屏空态。
 * @vitest-environment node
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, readStripped, readText, stripComments } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const read = (f: string): string => readText(join(HERE, f))

/** 整屏空态：锚点是那个「数据为空」的分支起点，断言其后 420 字符内出现 `<EmptyState`。 */
const MUST_EMPTYSTATE: ReadonlyArray<{ panel: string; tsx: string; anchor: string }> = [
  { panel: '年度报告', tsx: 'Annual.tsx', anchor: '!data && !loading && !error && (' },
  { panel: '备份恢复', tsx: 'Backup.tsx', anchor: '!loading && items.length === 0 && (' },
  { panel: '隐私体检', tsx: 'Privacy.tsx', anchor: 'totalHits === 0 && (' },
  { panel: '收藏与表情', tsx: 'Favorites.tsx', anchor: '!loading && !error && filtered.length === 0 && (' },
  { panel: '聊天信息抽屉', tsx: 'chats-contact-info-view.tsx', anchor: '!loading && !err && !data && (' },
]

/** 显式**不换**的行内提示：这里写成清单，防止被"顺手统一"成整屏空态。 */
const KEEP_INLINE: ReadonlyArray<{ tsx: string; text: string; why: string }> = [
  { tsx: 'Revoked.tsx', text: '无匹配记录', why: '筛选后的次级提示（有数据，只是被筛掉）' },
  { tsx: 'Files.tsx', text: '未发现重复文件', why: '重复扫描卡片内的结果态，一行字足够' },
  { tsx: 'WorldMap.tsx', text: '没有子板块', why: '地图画布内的局部提示（承载元素尺寸为 0 时才出现）' },
]

describe('U14 · 整屏空态统一走 EmptyState（图标 + 为什么空 + 下一步）', () => {
  for (const { panel, tsx, anchor } of MUST_EMPTYSTATE) {
    it(`${panel}：空态分支里是 <EmptyState>，不是裸的一行字`, () => {
      const src = readStripped(join(HERE, tsx))
      const at = src.indexOf(anchor)
      expect(at, `${panel}：找不到空态分支锚点「${anchor}」—— 改名/改写法时请同步本用例`).toBeGreaterThan(-1)
      const seg = src.slice(at, at + 420)
      expect(seg, `${panel} 的空态退回了一行字（U14 要求有信息的落地 + 下一步）`).toContain('<EmptyState')
      expect(seg, `${panel} 的 EmptyState 要有 title`).toMatch(/title=/)
      expect(seg, `${panel} 的 EmptyState 要说明"为什么空 / 下一步"`).toMatch(/desc=/)
    })
  }

  it('显式登记的行内提示仍然是行内（不是漏改）', () => {
    for (const { tsx, text, why } of KEEP_INLINE) {
      expect(read(tsx), `${tsx} 的「${text}」被改掉了？它是刻意保留的行内提示：${why}`).toContain(text)
    }
  })
})

describe('css.X 引用必须真的存在（否则样式静默失效）', () => {
  it('面板里每个 `css.类名` 都能在同文件的 module.css 里找到定义', () => {
    const files = readdirSync(HERE).filter((f) => f.endsWith('.tsx'))
    atLeast(files.length, 25, 'panels 下的 tsx 文件数')

    const dangling: string[] = []
    let refs = 0
    let scanned = 0
    for (const f of files) {
      // **必须先剥注释**：注释里提到 `css.stat` 这类历史写法不算引用
      // （`PrivacyTrust.tsx` 就有一段解释"原来写成 css.stat 但从未定义"的注释，
      //   不剥注释会把它当成悬空引用 —— 第一版就是这么误报的）。
      const src = stripComments(read(f))
      const m = /import css from '([^']+\.module\.css)'/.exec(src)
      if (!m) continue
      const cssRel = m[1] ?? ''
      expect(cssRel, `${f}: 解析不出它 import 的 module.css 路径`).not.toBe('')
      scanned++
      // CSS 侧同样剥注释；用宽松的「点号后跟标识符」收集，宁可漏报也不误报。
      const cssDefined = new Set(
        [...stripComments(readText(join(HERE, cssRel))).matchAll(/\.([A-Za-z_]\w*)/g)].map((x) => x[1] ?? ''),
      )
      for (const u of new Set([...src.matchAll(/\bcss\.([A-Za-z_]\w*)/g)].map((x) => x[1] ?? ''))) {
        refs++
        if (!cssDefined.has(u)) dangling.push(`${f} → css.${u}`)
      }
    }

    atLeast(scanned, 25, '扫到「引用了 module.css」的面板 tsx 数')
    atLeast(refs, 250, '`css.*` 引用总数（低于下限说明扫描失效，这条守卫是空的）')
    expect(dangling, `悬空类名（CSS Modules 返回 undefined，样式不会生效）：\n  ${dangling.join('\n  ')}`).toEqual([])
  })
})
