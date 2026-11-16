/**
 * W3-11.7：损坏库修复链路的**接线守卫**（源码级）。
 *
 * 为什么必须是源码级守卫：`db-integrity-repair.spec.ts` 证明的是后端链路
 * （体检判坏 → 只重解密坏的 → 复检）是对的，证明不了**健康中心真的把它们接上了** ——
 * 把健康面板里的调用摘掉，后端用例照样全绿，而用户面对的又是那个死胡同：
 * 「库文件已损坏 ⇒ 请到数据库健康体检」，走到面板却只有一个「重新检查」。
 * 本仓库没有组件/DOM 测试环境（jsdom / react-test-renderer / testing-library 都不在
 * 依赖里），所以「面板接上了」这一层只能靠源码形状钉住。
 *
 * 2026-11 增补：取数与动作抽进 `health-actions.ts` 之后，守卫还钉住三件事 ——
 *   · WAL 推送的回调只调 `loadStats`，不得顺带跑全库体检；
 *   · 体检 RPC 失败必须单独成态（`integrityError`），不得 `.catch(() => null)` 吞成全绿；
 *   · 修复提示统一走 `repairNotice`，任务占用 / `ok:false` / 失败明细都不能再误报。
 *
 * ⚠️ **本守卫能证明什么、不能证明什么**：只保证形状正确（调用在、按钮在）。
 * 面板的**运行期行为**（点下去真的会修复、修复中按钮真的禁用、修完数字真的刷新）
 * 未在浏览器里验证过 —— 需要真实数据 + GUI，仓库当前没有这个手段。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANELS = HERE
const API_DIR = join(HERE, '..')

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8')
}

/** 去掉注释后的源码：注释里会讲旧写法（例如 `.catch(() => null)`），不能让断言误判。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

/**
 * 健康面板与其拆分出来的兄弟模块的联合源码。
 *
 * 为什么要联合：这一族的卡片拆进过 `health-integrity.tsx`（`HealthPanel` 因此
 * 回到函数尺寸棘轮以内），取数与动作又拆进了 `health-actions.ts` ——「修复按钮 /
 * 没能体检的呈现 / RPC 调用」这些断言的目标搬过家，只读 `Health.tsx` 会把已接好的线
 * 误报成没接。口径与 `transient-notice.wiring.spec.ts` 的 readCode 同形（读兄弟文件）。
 */
function readHealth(): string {
  return ['Health.tsx', 'health-integrity.tsx', 'health-actions.ts']
    .map((f) => read(PANELS, f))
    .join('\n')
}

const API_CONFIG = join(API_DIR, 'api-config.ts')
const API_CORE = join(API_DIR, 'api-core.ts')

describe('W3-11.7：损坏库修复链路接上了健康中心', () => {
  it('健康面板同时接了体检与修复两个 RPC（少一个就是死胡同）', () => {
    const src = readHealth()
    expect(src).toContain('apiCheckDbIntegrity')
    expect(src).toContain('apiRepairCorruptDbs')
  })

  it('修复按钮只在体检发现损坏时出现（没有损坏也挂个「修复」= 暗示库常态是坏的）', () => {
    const src = readHealth()
    expect(src).toContain('corruptedCount > 0')
    expect(src).toContain('修复损坏的库')
  })

  it('修不了/查不了的两类分开呈现（把「占用」说成「损坏」会驱动注定失败的重解密）', () => {
    const src = readHealth()
    expect(src).toContain('unreadable')
    expect(src).toContain('没能体检')
  })

  /**
   * 2026-10-13 真机：三个 `*_fts.db`（微信自带 `MMFtsTokenizer`）被判成「多半被微信独占」，
   * 面板劝用户「退出微信后再点重新检查」—— 退出微信**永远**不会让 `SQL logic error` 消失。
   * 第三类必须单独成卡，且文案必须说清「退出微信也没用」。
   */
  it('本机体检不了的第三类单独成卡，且不劝用户退微信', () => {
    const src = readHealth()
    expect(src).toContain('uncheckable')
    expect(src).toContain('本机体检不了')
    expect(src).toContain('退出微信也没用')
  })

  it('api-config.ts 的两个转发桶真在后端方法上（拼错名字这里红）', () => {
    const src = read(API_CONFIG)
    expect(src).toContain('remote().checkDbIntegrity()')
    expect(src).toContain('remote().repairCorruptDbs()')
  })

  it('WechatRemote 接口声明了两个方法（remote-contract 对账的前置）', () => {
    const src = read(API_CORE)
    expect(src).toContain('checkDbIntegrity():')
    expect(src).toContain('repairCorruptDbs():')
  })
})

describe('2026-11：健康面板的取数纪律与修复文案（防误报回归）', () => {
  it('修复结果统一走 repairNotice（Health.tsx / health-actions.ts 这条接线面）', () => {
    const src = stripComments(readHealth())
    expect(src, '没引入 repairNotice ⇒ 修复提示又回到只看 found 的旧口径').toContain("from './repair-notice.ts'")
    expect(src, '没有调用 repairNotice ⇒ ok:false / 任务占用会再次被说成完成或没坏').toContain('repairNotice(')
  })

  it('WAL 推送只刷统计，绝不在同步事件里跑全库体检', () => {
    const src = stripComments(read(PANELS, 'Health.tsx'))
    const match = /useWechatDataUpdated\(\s*\(\)\s*=>\s*\{([^}]*)\}/.exec(src)
    expect(match, 'Health.tsx 里找不到 useWechatDataUpdated 回调').not.toBeNull()
    const body = match?.[1] ?? ''
    expect(body, '同步事件应当只调 loadStats').toContain('loadStats()')
    expect(body, '同步事件回调里不得出现全库体检 RPC').not.toContain('apiCheckDbIntegrity')
    expect(body, '同步事件回调里不得再调会顺带体检的 load()').not.toMatch(/\bload\(\)/)
  })

  it('体检失败必须单独成态，不得 `.catch(() => null)` 吞成全绿', () => {
    const src = stripComments(readHealth())
    expect(src, '体检失败又被 catch 成 null ⇒ 三个计数归零，页面看起来全绿')
      .not.toContain('apiCheckDbIntegrity().catch((): null => null)')
    expect(src, 'apiCheckDbIntegrity 上不应再挂 .catch').not.toMatch(/apiCheckDbIntegrity\([^)]*\)\s*\.catch/)
  })

  it('体检失败原因被渲染并传入卡片（不是吞掉）', () => {
    const panel = stripComments(read(PANELS, 'Health.tsx'))
    expect(panel, 'Health.tsx 没接 integrityError').toContain('integrityError')
    expect(panel, 'integrityError 没传给 HealthIntegrityCards')
      .toMatch(/<HealthIntegrityCards[\s\S]*?error=\{integrityError\}/)
    const cards = stripComments(read(PANELS, 'health-integrity.tsx'))
    expect(cards, '卡片组件没有 error 参数').toContain('error?: string | null')
    expect(cards, '卡片组件没有 checked 参数').toContain('checked?: boolean')
    expect(cards, '卡片没渲染「体检没跑成」').toContain('体检没跑成')
    expect(cards, '卡片没渲染「尚未体检」').toContain('尚未体检')
    expect(cards, '卡片没渲染「未发现损坏」').toContain('未发现损坏')
  })

  it('repair 用 repairNotice 报结果，且只复检一次（不再 await load() 白扫全库）', () => {
    const src = stripComments(read(PANELS, 'health-actions.ts'))
    expect(src, 'repair 没调用 repairNotice(r)').toContain('repairNotice(r)')
    expect(src, 'repair 里又用 await load() ⇒ 复检之外还会再跑一遍全库扫描').not.toContain('await load()')
    expect((src.match(/await loadIntegrity\(\)/g) ?? []).length, 'repair 应恰好复检一次').toBe(1)
  })
})
