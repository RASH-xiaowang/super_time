/**
 * L20：提示语「显示 N 秒后自动消失」的**接线守卫**，兼**迁移清单**。
 *
 * 为什么必须是源码级守卫：`timers.spec.ts` 只证明 `createNoticeController` 这个原语是对的，
 * 证明不了**哪个面板真的用了它** —— 把某个面板的 `flash(x)` 换回
 * `setNotice(x); setTimeout(() => { setNotice(null) }, 3000)`，原语的用例会全绿
 * （M13 复审实测过这一步：整文件退回改动前，全量用例零变红）。
 * 本仓库没有组件/DOM 测试环境（jsdom / react-test-renderer / testing-library 都不在依赖里，
 * `vitest.config.ts` 只收纯逻辑模块），所以这一层只能靠源码形状钉住。
 *
 * ⚠️ **本守卫能证明什么、不能证明什么**：它只保证「形状正确」——
 * 面板的**运行期行为（计时是否真的 3 秒消失、卸载是否真的不写 state、连出两条提示是否
 * 真的不互相截断）未在浏览器里验证过**，仓库当前也没有能做这件事的手段
 * （只有 SSR 静态冒烟 `ui:smoke`，观测不到定时器）。`timers.spec.ts` 用假时钟覆盖了
 * 计时语义，但覆盖的是原语、不是「这个面板接上了它」。
 *
 * 已迁移的 11 个面板 / 14 处（括号内是改前那句 setTimeout 的时长，原样保留）：
 *   Contacts(4000) Emoticons(3000) Favorites(4000) Health(3000) Ledger(3000)
 *   Moments(6000 ×3) Overview(6000, 2500) PeriodSummary(3000) Records(4000) Tasks(3000)
 *   Settings（富提示：kind/details/关闭按钮，5s/12s 两档 —— 收口批用 `useTransientNotice<Notice>` 承接）
 * 有意**未迁移**（形态不同，不是漏掉）：`DailySummary.tsx` 是 toast 队列（多条并存、各自计时）。
 * 该文件的守卫见 `read-error-and-notice.wiring.spec.ts`。
 *
 * 写这类守卫的坑（复审踩过两次）：不要用 `[\s\S]*?` 去跨行匹配花括号，它会跨过内层的 `}`，
 * 对**正确**的代码也误报红；用 `[^}]` 把匹配限制在同一层。本文件匹配的是同一行，不受此影响。
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 去掉注释后读源码：注释里会提到旧写法（例如 hooks.tsx 的迁移说明），不能让断言误判。 */
function readCode(file: string): string {
  return readFileSync(join(HERE, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

/** 已迁移面板：hook 的时长实参、以及至少出现几次 flash( / hold(（防空转：把调用删掉就红）。 */
const MIGRATED: ReadonlyArray<{ file: string; hook: string; render: string; flash: number; hold: number }> = [
  { file: 'Contacts.tsx', hook: 'useTransientNotice(4000)', render: 'notice', flash: 1, hold: 0 },
  { file: 'Emoticons.tsx', hook: 'useTransientNotice()', render: 'notice', flash: 1, hold: 0 },
  { file: 'Favorites.tsx', hook: 'useTransientNotice(4000)', render: 'notice', flash: 1, hold: 0 },
  { file: 'Health.tsx', hook: 'useTransientNotice()', render: 'notice', flash: 1, hold: 0 },
  { file: 'Ledger.tsx', hook: 'useTransientNotice()', render: 'notice', flash: 1, hold: 0 },
  { file: 'Moments.tsx', hook: 'useTransientNotice(6000)', render: 'hint', flash: 3, hold: 9 },
  { file: 'Overview.tsx', hook: 'useTransientNotice(6000)', render: 'error', flash: 2, hold: 3 },
  { file: 'PeriodSummary.tsx', hook: 'useTransientNotice()', render: 'notice', flash: 1, hold: 1 },
  { file: 'Records.tsx', hook: 'useTransientNotice(4000)', render: 'notice', flash: 1, hold: 0 },
  { file: 'Tasks.tsx', hook: 'useTransientNotice()', render: 'notice', flash: 1, hold: 0 },
]

/** 旧写法的形状：`setTimeout(() => { setNotice(null) }, N)`（含 `window.` 前缀与 `() =>{` 变体）。 */
const RAW_NOTICE_TIMER_RE = /(?:window\.)?setTimeout\(\s*\(\)\s*=>\s*\{?\s*setNotice\(null\)/

describe('L20 接线守卫（源码级；面板运行期行为未在浏览器验证）', () => {
  for (const m of MIGRATED) {
    describe(m.file, () => {
      const code = readCode(m.file)

      it('走公共 hook，时长与改前的魔数一致', () => {
        expect(code).toContain("from './hooks.tsx'")
        expect(code).toContain(m.hook)
        // 解构里必须有 notice（渲染用）与 flash（写入用）
        expect(code).toMatch(/const \{ notice, flash[^}]*\} = useTransientNotice/)
      })

      it('旧的 setNotice 状态与裸定时器都已不在', () => {
        expect(code).not.toContain('setNotice')
        expect(code).not.toMatch(RAW_NOTICE_TIMER_RE)
      })

      it('防空转：提示语真的还在渲染，且调用点存在（不是把功能删掉换绿）', () => {
        expect(code).toContain(`{notice && <div className={css.${m.render}}>{notice}</div>}`)
        expect((code.match(/flash\(/g) ?? []).length).toBeGreaterThanOrEqual(m.flash)
        expect((code.match(/hold\(/g) ?? []).length).toBeGreaterThanOrEqual(m.hold)
      })
    })
  }

  it('Overview 的「已导出报告」仍是 2500ms（同文件里两处时长不一致，不能被拉平）', () => {
    const code = readCode('Overview.tsx')
    expect(code).toContain("flash('已导出报告', 2500)")
  })

  it('失败类提示走 hold（改前它们不带定时器，一致性不能被破坏）', () => {
    // 抽一个代表：Moments 的复制结果与 Overview 的后台刷新失败
    expect(readCode('Moments.tsx')).toContain("hold('已复制')")
    expect(readCode('Overview.tsx')).toContain('hold(')
    // 用 flash 顶掉失败提示会把它变成「6 秒后自己消失」，那是行为变更
    expect(readCode('Moments.tsx')).not.toContain("flash('导出失败")
    expect(readCode('Overview.tsx')).not.toContain("flash('归档失败")
  })

  it('面板目录里没有漏网的旧写法（新增面板也会被这条抓住）', () => {
    const files = readdirSync(HERE).filter(f => f.endsWith('.tsx')).sort()
    // 防空转：目录里确实扫到了面板（不然这条断言恒真）
    expect(files.length).toBeGreaterThan(20)
    /** 允许仍持有 notice 槽位的例外：hooks.tsx 是公共实现本身。 */
    const allowed = new Set(['hooks.tsx'])
    const scanned = files.filter(f => !allowed.has(f))
    expect(scanned.length).toBeGreaterThan(20)
    expect(scanned.filter(f => readCode(f).includes('setNotice'))).toEqual([])
    expect(scanned.filter(f => RAW_NOTICE_TIMER_RE.test(readCode(f)))).toEqual([])
  })
})
