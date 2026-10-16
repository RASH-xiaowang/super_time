/**
 * W3-11.7：损坏库修复链路的**接线守卫**（源码级）。
 *
 * 为什么必须是源码级守卫：`db-integrity-repair.spec.ts` 证明的是后端链路
 * （体检判坏 → 只重解密坏的 → 复检）是对的，证明不了**健康中心真的把它们接上了** ——
 * 把 `Health.tsx` 里那两个调用摘掉，后端用例照样全绿，而用户面对的又是那个死胡同：
 * 「库文件已损坏 ⇒ 请到数据库健康体检」，走到面板却只有一个「重新检查」。
 * 本仓库没有组件/DOM 测试环境（jsdom / react-test-renderer / testing-library 都不在
 * 依赖里），所以「面板接上了」这一层只能靠源码形状钉住。
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

/**
 * `Health.tsx` 与其拆分出来的兄弟模块的联合源码。
 *
 * 为什么要联合：这一族的卡片拆进过 `health-integrity.tsx`（`HealthPanel` 因此
 * 回到函数尺寸棘轮以内），「修复按钮 / 没能体检的呈现」这些断言的目标搬过家 ——
 * 只读 `Health.tsx` 会把已接好的线误报成没接。口径与
 * `transient-notice.wiring.spec.ts` 的 readCode 同形（前缀扫兄弟文件）。
 */
function readHealth(): string {
  return ['Health.tsx', 'health-integrity.tsx']
    .map((f) => read(PANELS, f))
    .join('\n')
}

const API_CONFIG = join(API_DIR, 'api-config.ts')
const API_CORE = join(API_DIR, 'api-core.ts')

describe('W3-11.7：损坏库修复链路接上了健康中心', () => {
  it('Health.tsx 同时接了体检与修复两个 RPC（少一个就是死胡同）', () => {
    const src = read(PANELS, 'Health.tsx')
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
