/**
 * 「留白审计的就绪钩子」两端接线判据（2026-09-27 换霓虹皮肤时立的）。
 *
 * ## 为什么值得一条判据
 *
 * 2026-09-27 把指标条换成霓虹牌（`.ovHero*` → `.hero* / .plate*`）之后，`ui:overview-audit`
 * 打印的是「未检测到已加载的总览数据（首启空库），跳过布局判定」并**以 0 退出** ——
 * 它查的就绪判据是 `[class*=ovHero]`，那套类名被删了之后，"没找到"被读成"空库"。
 * 于是**留白、网格空洞、内容裁切这三项验收一起静默失效**，而退出码还是绿的。
 *
 * 这正是台账里 `data-st-ledger-money` 那一课的重演（文案/类名当靶子 ⇒ 改皮即失效），
 * 所以这次直接给指标条一个专属属性 `data-st-ov-hero`，并把两端钉在一起：
 * 组件侧（`overview-neon.tsx`）必须有它，脚本侧（`overview-layout-audit.mjs`）必须查它。
 *
 * 位置：与面板同目录（它钉的一端就是这个目录里的组件）。**不要**把它挪到
 * `src/backend/tests/`：`layer-direction.spec.ts` 把「后端/宿主指进 src/client 的依赖」
 * 钉成 0 条，而这条判据要用前端侧的 `wiring-kit`（`readStripped`）。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRoot, readStripped, readText } from '../../../test-helpers/wiring-kit.ts'

const ROOT = findRoot(import.meta.dirname)
const HOOK = 'data-st-ov-hero'
const PANEL = join(import.meta.dirname, 'overview-neon.tsx')
const SCRIPT = join(ROOT, 'scripts', 'overview-layout-audit.mjs')

/** 脚本侧一律**剥注释再断言**：说明里会照抄旧判据的字样，按原文扫必然自伤（本仓的老坑）。 */
const readCode = (p: string): string => readStripped(p)

describe('总览留白审计的就绪钩子（容器侧 + 脚本侧）', () => {
  it('容器上有这个属性，且挂在那张「指标条」上（不是随手加在别的容器上）', () => {
    const code = readText(PANEL)
    const line = code.split('\n').find((l) => l.includes(HOOK))
    expect(line, `overview-neon.tsx 里找不到 ${HOOK} ⇒ 留白审计的就绪判据已经失去靶子`).toBeTruthy()
    expect(line, `${HOOK} 必须与指标条的容器同在一行（脚本问的就是这一块）`).toContain('neon.hero')
    expect(code, 'NeonHero 不见了？脚本钩子指向的组件必须在').toContain('export function NeonHero')
  })

  it('脚本问的就是这个属性（而不是类名或文案）', () => {
    const code = readCode(SCRIPT)
    expect(code, `脚本不再引用 [${HOOK}] ⇒ 它要么改回了类名匹配，要么钩子被删了`).toContain(`[${HOOK}]`)
    expect(code, '脚本改回按类名找指标条 ⇒ 换皮肤那天它会静默把"没找到"当成"空库"（见本文件头）')
      .not.toContain('[class*=ovHero]')
  })

  it('反例自证：两端各自改一处，判据都要报（证明上面两条不是恒真）', () => {
    const panel = readText(PANEL)
    expect(panel.includes(HOOK), '容器侧本来就没有这个属性 ⇒ 第一条是假绿').toBe(true)
    // 用 split/join 构造"改名"，而不是 `HOOK + '-RENAMED'`（新串仍含旧串，自证会变自欺）。
    const renamed = panel.split(HOOK).join('data-st-ov-her0')
    expect(renamed.split('\n').some((l) => l.includes(HOOK)), '改名后仍然命中 ⇒ 反例是自欺').toBe(false)
    const script = readCode(SCRIPT)
    expect(script.includes(`[${HOOK}]`), '脚本侧本来就不引用它 ⇒ 第二条是假绿').toBe(true)
    expect(script.replace(`[${HOOK}]`, '[]').includes(`[${HOOK}]`),
      '把查询换成 [] 之后仍然命中 ⇒ 第二条反例没打到靶子').toBe(false)
  })
})
