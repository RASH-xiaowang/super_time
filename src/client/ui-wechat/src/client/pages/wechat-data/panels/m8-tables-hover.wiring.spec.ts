/**
 * 表格手机档 + `:hover` 门控的守卫（M8，2026-10-14 真数据实测）。
 *
 * ## 主判据：全仓不许存在「只有 :hover 才现身」的类
 *
 * 触摸上没有 `:hover`（也没有悬停可以补救），所以「平时藏起来、悬停才显」这条桌面惯例
 * 在手机上等于**功能不可达**。计划里原本写的是「把 254 条 `:hover` 全门控进
 * `@media (hover:hover)`」—— 那是几十份文件的机械改动、还会撞 1000 行棘轮。先把真实
 * 集合量出来才看清：源码 `.css` 里的 `:hover` 是 284 条（先前记的 561 把 `ui-dist` 的
 * 成品 CSS 也算进去了），而**真正只在悬停时出现**的只有两类 —— 消息行的精确时间戳
 * （基础态 `opacity: 0`）与朋友圈洞察的月份标注。其余的 hover 只是把 0.5 / 0.55 / 0.85
 * 的透明度提到 1 —— 那是强调，不是可达性（第一版判据把 `opacity:0\b` 当「隐藏」，
 * 于是 0.5 也被吃进来，误报了 5 处）。
 *
 * 所以这里钉的是**不变量**而不是清单：任何类只要基础态是隐藏的（`opacity:0` /
 * `visibility:hidden` / `display:none`）又被某条 `:hover` 规则显出来，同文件就必须给出
 * 一个触摸出口（`@media (hover: none)`、`:active`、`:focus`）。以后新增一条 hover-reveal
 * 而忘了给出口 ⇒ 这条直接红。
 *
 * ## 副判据：表格首列在手机上钉住
 *
 * 表格的 640px 最小宽度是第 89 轮定的（窄窗口下每列才都可达），手机上容器只有 349px
 * （实测资金往来 / 操作日志）⇒ 横滚之后不知道这一行是谁的。首列 sticky 的底色必须
 * 不透明（td/th 原本全透明、斑马纹与表头都是半透明叠色），所以判据连底色与叠色层一起钉。
 *
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { atLeast, atRuleBlock } from '../../../test-helpers/wiring-kit.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** `src/client/`：上溯 **6** 级（panels → wechat-data → pages → client → src → ui-wechat → client）。
 *  少一级就只扫到 ui-wechat（实测 258 条 :hover，全仓 561）—— 下面的哨兵会拦住这种扫描根写错。 */
const CLIENT_ROOT = join(HERE, '..', '..', '..', '..', '..', '..')
const SKIP_DIRS = new Set(['node_modules', 'ui-dist', 'public', '.git'])

/**
 * 递归收 `.css`。
 * @param dir - 当前目录。
 * @returns 命中的绝对路径。
 */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...walk(p))
    } else if (e.name.endsWith('.css')) out.push(p)
  }
  return out
}

/** 「基础态是隐藏的」——`opacity: 0` 后面**不能再接数字**，否则 0.5 / 0.55 / 0.65 这类
 *  「淡出但看得见」会被误判成不可达（第一版就是这么误报了 5 处）。 */
const HIDDEN = /(opacity:\s*0(?![.\d])|visibility:\s*hidden|display:\s*none\b)/
const REVEAL = /opacity:\s*1\b|visibility:\s*visible|display:\s*(?:flex|block|grid|inline-flex)\b/
/** 一份 CSS：`name` 只用于报告，`text` 是内容。 */
interface CssDoc { name: string, text: string }

/**
 * 找出所有「基础态隐藏 + 只靠 :hover 显出 + 没有触摸出口」的类。
 *
 * 判据只吃 `{name, text}`，所以**跑真文件与跑内存反例是同一把尺子**（不另写一份实现）。
 *
 * @param docs - 待判的 CSS 文档。
 * @returns 缺陷清单（空 = 干净）。
 */
function hoverOnlyReveals (docs: readonly CssDoc[]): Array<{ name: string, cls: string, reveal: string }> {
  const out: Array<{ name: string, cls: string, reveal: string }> = []
  for (const doc of docs) {
    const t = doc.text
    for (const m of t.matchAll(/([^n{};]*:hover[^{\n]*)\{([^}]*)\}/g)) {
      const sel = m[1] ?? ''
      const body = m[2] ?? ''
      if (!REVEAL.test(body)) continue
      for (const cls of sel.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
        const name = cls[1] ?? ''
        if (name === '') continue
        // 这个类自己的基础规则必须是「藏起来」的
        const baseRe = new RegExp(`\\.${name}\\s*(?:,[^\\n]*)?\\{[^}]*${HIDDEN.source}`, 's')
        if (!baseRe.test(t)) continue
        // 出口必须**指着这个类并真的把它显出来**：早先两版分别栽在「文件里有任意
        // :focus{opacity:1} 就算出口」（整份文件免检）与「`@media (hover:none)` 里提到过
        // 类名就算出口」（那一档里写 `opacity: 0` 也放行）—— 都是假绿。
        const revealsOn = (kw: string): boolean =>
          new RegExp(`${kw}[^{]*\\.${name}\\b[^{]*\\{[^}]*opacity:\\s*1`, 's').test(t)
        const inHoverNoneTier = new RegExp(
          `@media\\s*\\(\\s*hover:\\s*none[^{]*\\{[\\s\\S]*?\\.${name}\\b[^{]*\\{[^}]*(?:opacity:\\s*1|visibility:\\s*visible|display:\\s*(?:flex|block|grid))`,
          's',
        ).test(t)
        if (inHoverNoneTier || revealsOn(':active') || revealsOn(':focus')) continue
        out.push({ name: doc.name, cls: name, reveal: `${sel.trim()} { ${body.trim().slice(0, 28)} }` })
      }
    }
  }
  return out
}

describe('全仓不存在「只有 :hover 才现身」的类（触摸上没有 hover）', () => {
  const files = walk(CLIENT_ROOT)
  const docs: CssDoc[] = files.map((f) => ({ name: relative(CLIENT_ROOT, f).replaceAll('\\', '/'), text: readFileSync(f, 'utf8') }))
  const defects = hoverOnlyReveals(docs)

  it('每一条「基础态隐藏 + hover 显出」都配了触摸出口', () => {
    expect(defects.map((d) => `${d.name}  .${d.cls}  ← ${d.reveal}`).join('\n'),
      '这些控件在手机上永远不出现（触摸没有 :hover）；要么给 @media (hover:none) / :active 出口，要么别把 hover 当唯一开关')
      .toBe('')
  })

  it('哨兵 + 反例自证：拿掉已修的触摸出口，必须被同一条判据抓住', () => {
    atLeast(files.length, 60, '扫到的 .css 份数')
    let hoverRules = 0
    for (const f of files) hoverRules += (readFileSync(f, 'utf8').match(/:hover/g) ?? []).length
    atLeast(hoverRules, 250, '全仓源码 .css 里的 :hover 数（2026-10-14 实测 284；不含 ui-dist 的成品 CSS）')
    const chatsDoc = docs.find((d) => d.name.endsWith('chats.module.css'))
    expect(chatsDoc, '没读到 chats.module.css ⇒ 扫描根不对').toBeDefined()
    const stripped = (chatsDoc?.text ?? '').replace(/@media \(hover: none\) \{[\s\S]*?\}/, '')
    expect(stripped, '反例构造失效（没匹配到那段 @media (hover: none)）').not.toBe(chatsDoc?.text ?? '')
    const hit = hoverOnlyReveals([{ name: 'chats.module.css(反例)', text: stripped }])
    expect(hit.some((d) => d.cls === 'msgTimeChip'),
      '拿掉出口后没被抓住 ⇒ 这条判据是空的').toBe(true)
  })
})

describe('表格手机档：首列钉住且底色不透明', () => {
  const kitTable = readFileSync(join(HERE, '..', 'ui', 'kit-table.module.css'), 'utf8')
  const phone = atRuleBlock(kitTable, '@media (max-width: 560px)')

  it('首列 sticky 到左边，底色用卡片令牌（td/th 原本全透明，直接贴会让内容穿过来）', () => {
    expect(phone, '首列没有 sticky ⇒ 手机上横滚之后不知道这行是谁的').toContain('position: sticky')
    expect(phone, '没有钉住左边').toContain('left: 0')
    expect(phone, '底色不是卡片令牌 ⇒ 浅色主题会跟着翻车').toContain('var(--nm-bg-card')
    expect(phone, '表头的半透明叠色没叠回来 ⇒ 粘住的列比其余格子暗一档')
      .toContain('linear-gradient(var(--nm-table-header-bg)')
    expect(phone, '偶数行的斑马纹没叠回来').toContain('linear-gradient(var(--nm-table-row-stripe)')
    expect(phone, '表体首列的 z-index 必须低于表头首列（交叉处会穿帮）').toMatch(/td:first-child \{ z-index: 2; \}/)
  })
})
