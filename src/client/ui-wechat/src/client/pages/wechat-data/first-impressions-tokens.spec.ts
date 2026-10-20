/**
 * R2 前置门守卫：四个「第一印象」表面的**令牌采纳率棘轮** + 断点档位。
 *
 * 背景 R2。这四个表面是用户进产品前必须
 * 穿过的门（自绘标题栏 → 启动引导 → 隐私同意 → 授权），但它们的令牌采纳率
 * 曾是全站最低的一批（35.7% – 61.1%），因为它们是**后续追加的文件**，写的时候
 * 没跟随既有的 `--nm-*` 规范。
 *
 * 本文件钉两件事：
 *   ① **真裸硬编码**必须 ≤ 基线（棘轮，只许减不许增）。统计口径刻意排除：
 *      · `var(--token, #hex)` 里的 fallback —— 那是兜底，不是裸色；
 *      · 注释里的色值 —— 那是文档；
 *      · **豁免清单**里的项 —— mask 的 `#000`、纯黑阴影、Windows 关闭键平台红，
 *        这些与主题无关，硬套令牌反而是误导。
 *   ② **断点档位**只许落在 4 档（≤1100 / ≤900 / ≤720 / 默认），防止再长出
 *      第五第六个散乱值。
 *
 * 哨兵：先断言四个文件都读到了且总行数下限成立，防「路径配错 → 恒绿」。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 四个首见表面。
 *  spec 位于 src/client/ui-wechat/src/client/pages/wechat-data/
 *  目标在 src/client/ui-app/ ⇒ 从 spec 目录上溯 5 层到 src/client/。 */
const APP = join(HERE, '..', '..', '..', '..', '..', 'ui-app')

const FILES = {
  'titlebar.css': join(APP, 'titlebar.css'),
  'onboarding.module.css': join(APP, 'onboarding', 'onboarding.module.css'),
  'onboarding-stage.module.css': join(APP, 'onboarding', 'onboarding-stage.module.css'),
  'onboarding-stages.module.css': join(APP, 'onboarding', 'onboarding-stages.module.css'),
  'privacy/PrivacyConsentGate.module.css': join(APP, 'privacy', 'PrivacyConsentGate.module.css'),
  'license/license-gate.module.css': join(APP, 'license', 'license-gate.module.css'),
} as const

/**
 * 真裸硬编码基线（R2 完成时的实测值，**含豁免项**）。**只许减不许增。**
 * 实际值与基线必须**严格相等**：低于基线说明有尸体没清，高于基线说明新增了裸色。
 *
 * 2026-10-17 启动页重设计：`onboarding.module.css` 从 5 降到 **1**（只剩纯黑阴影），
 * 舞台外壳拆到新文件 `onboarding-stage.module.css`（0 处裸色，全部走 `--nm-*` 令牌）。
 * 2026-10-19 微信化改版：装饰层（背景图 / 网格遮罩 / 霓虹阴影）整层删除，三份文件都收敛到
 * **0 处裸色**；基线随实际值同步下调（严格相等仍保留，仍能抓「新增裸色」与「尸体没清」两个方向）。
 */
const BARE_BASELINE: Record<keyof typeof FILES, number> = {
  'titlebar.css': 2, // #e81123（Windows 关闭键平台红）+ #fff（其上文字）
  'onboarding.module.css': 0, // 2026-10-19：纯黑阴影随装饰层删除
  'onboarding-stage.module.css': 0, // 2026-10-19：网格遮罩的 4x #000 随背景层删除
  'onboarding-stages.module.css': 0,
  'privacy/PrivacyConsentGate.module.css': 0,
  'license/license-gate.module.css': 0, // 2026-10-19：纯黑阴影随装饰层删除
}

/**
 * 允许保留的裸色（精确值）。这些**仍计入总数**（基线里含它们），
 * 但不算违规 —— 它们与主题无关，硬套令牌反而误导。
 */
const EXEMPT = new Set([
  '#000', '#fff', '#e81123',
  'rgba(0, 0, 0, 0.25)', 'rgba(0, 0, 0, 0.35)',
])

/** 去注释（保留行结构，便于定位）。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/** 剥离所有 `var(...)` 调用（含嵌套一层），剩下的才可能含裸色。 */
function stripVars(s: string): string {
  let out = s
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/var\(\s*--[A-Za-z0-9_-]+\s*(?:,(?:[^()]|\([^()]*\))*)?\)/g, ' ')
    if (next === out) break
    out = next
  }
  return out
}

const HEX = /#[0-9a-fA-F]{3,8}\b/g
const RGBA = /rgba?\([^)]*\)/g

/** 收集全部裸色（含豁免；只收「非豁免」的部分用于违规报告）。 */
function scanBare(file: string): { all: string[]; violations: string[] } {
  const raw = readFileSync(file, 'utf8')
  const body = stripVars(stripComments(raw))
  const all: string[] = []
  for (const line of body.split('\n')) {
    const s = line.trim()
    if (!s || !s.includes(':') || s.endsWith('{')) continue
    const prop = s.split(':')[0]?.trim() ?? ''
    if (!/^[-a-zA-Z]+$/.test(prop)) continue
    for (const m of s.match(HEX) ?? []) all.push(m.toLowerCase())
    for (const m of s.match(RGBA) ?? []) all.push(m.replace(/\s+/g, ' '))
    // 具名颜色：只认**值位置**上的关键词，避免 `white-space` 这类属性名误伤。
    for (const m of s.match(/:\s*[^:]*/g) ?? []) {
      for (const c of m.match(/\b(?:white|black|silver|gray|grey)\b(?!-)/gi) ?? []) {
        all.push(c.toLowerCase())
      }
    }
  }
  return { all, violations: all.filter((h) => !EXEMPT.has(h)) }
}

describe('R2 首见表面：令牌采纳率棘轮', () => {
  it('哨兵：五个文件都读到了（否则下面几条会恒绿）', () => {
    for (const [name, p] of Object.entries(FILES)) {
      const n = readFileSync(p, 'utf8').length
      expect(n, `${name} 读不到或过短`).toBeGreaterThan(500)
    }
  })

  it.each(Object.keys(FILES) as Array<keyof typeof FILES>)(
    '%s 的真裸硬编码不超过基线（只许减不许增）',
    (name) => {
      const { all, violations } = scanBare(FILES[name])
      const base = BARE_BASELINE[name]
      expect(
        violations.length,
        `${name} 出现 ${violations.length} 处非豁免裸色：${[...new Set(violations)].join(', ')}`
          + ' —— 请改用 --nm-* 令牌，或若确属「与主题无关」（平台色/纯黑/mask），'
          + '把它加进本 spec 的 EXEMPT 并同步上调基线。',
      ).toBe(0)
      expect(
        all.length,
        `${name} 裸色总数 ${all.length} > 基线 ${base}。`
          + `（若等于基线以下且无违规项，是正确的收敛态。）`,
      ).toBeLessThanOrEqual(base)
    },
  )

  it('基线不留尸体：实际总数必须严格等于基线（低于基线请下调）', () => {
    for (const name of Object.keys(FILES) as Array<keyof typeof FILES>) {
      const { all } = scanBare(FILES[name])
      expect(
        all.length,
        `${name} 实际 ${all.length} ≠ 基线 ${BARE_BASELINE[name]}：请把 BASELINE 下调到实测值。`,
      ).toBe(BARE_BASELINE[name])
    }
  })
})

describe('R2 首见表面：断点档位收敛', () => {
  /** 允许的**视口**档（px）。只许这 3 档（默认档不需要 @media）。 */
  const ALLOWED_VIEWPORT = new Set([1100, 900, 720])
  /**
   * 允许的**卡片级**细调断点。这些是容器内部的窄宽适配（例如三栏卡在 520px 下折两栏），
   * 不属于「窗口档位」，收敛它们会破坏布局。用容器查询更合适，但那是 R4 的事。
   */
  const ALLOWED_CARD = new Set([520, 440, 420, 560])

  it('四个首见表面只用 ≤1100 / ≤900 / ≤720 三档视口断点', () => {
    for (const [name, p] of Object.entries(FILES)) {
      const body = stripComments(readFileSync(p, 'utf8'))
      const breaks = [...body.matchAll(/@media[^{]*max-width:\s*(\d+)px/g)].map((m) => Number(m[1]))
      const bad = breaks.filter((b) => !ALLOWED_VIEWPORT.has(b) && !ALLOWED_CARD.has(b))
      expect(
        bad,
        `${name} 出现了非档位断点：${bad.join(', ')}`
          + ' —— 视口档只许 1100 / 900 / 720；卡片级细调须在 ALLOWED_CARD 登记。',
      ).toEqual([])
    }
  })

  it('视口断点必须成对配套 min-width（改了 max 忘了 min 会留下空隙）', () => {
    // onboarding 用 (max-width:900) + (min-width:901) 配对。若有人只改一边，这里会红。
    const body = stripComments(readFileSync(FILES['onboarding.module.css'], 'utf8'))
    if (body.includes('min-width')) {
      const pairs = [...body.matchAll(/@media\s*\(min-width:\s*(\d+)px\)/g)].map((m) => Number(m[1]))
      for (const mn of pairs) {
        // min-width 应等于「某个 max-width + 1」
        const maxes = [...body.matchAll(/@media[^{]*max-width:\s*(\d+)px/g)].map((m) => Number(m[1]))
        expect(
          maxes.some((mx) => mx + 1 === mn),
          `min-width:${mn} 找不到配对的 max-width:${mn - 1}`,
        ).toBe(true)
      }
    }
  })
})
