/**
 * 隐私体检落地态的接线守卫。
 *
 * 背景：这个面板此前在打开时只有**一行居中文字**（"体检你的微信数据：扫描手机号 / 身份证 / …"），
 * 实测在 802px 的内容区里留下 668px 连续空白（占比 87%）：既没说扫多久，也没说扫完能拿到什么。
 * 现在落地态由 `PrivacyLanding` 承担，扫描中共用同一套结构。
 *
 * 为什么要有这个用例：
 *  ① 面板里列的 6 个体检项必须与**后端真正在扫的类别**一致。前端这份是独立写死的
 *     （label / icon / 顺序），后端 `query/privacy.ts` 的 CATEGORIES 才是真源 ——
 *     两处一旦漂移，界面会承诺一个后端根本不查的类别（或反过来漏掉一类），
 *     而这种情况不会有任何测试变红。
 *  ② 落地态不能退回成一行文字：那是本轮修掉的问题本身。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 往上找到仓库根（认 main.js + package.json），避免写死 ../../.. 的层数。 */
function findRoot(start: string): string {
  let d = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, 'main.js')) && existsSync(join(d, 'package.json'))) return d
    d = dirname(d)
  }
  throw new Error('找不到仓库根')
}
const ROOT = findRoot(HERE)
const panel = readFileSync(join(HERE, 'Privacy.tsx'), 'utf8')
const backend = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'privacy.ts'), 'utf8')

/** 后端真源：CATEGORIES 里的 (key, label, icon) 三元组，保持声明顺序。 */
function backendCategories(): Array<{ key: string; label: string; icon: string }> {
  const block = backend.match(/const CATEGORIES[^=]*=\s*\[([\s\S]*?)\n\]/)?.[1] ?? ''
  return [...block.matchAll(/key:\s*'([^']+)',\s*label:\s*'([^']+)',\s*icon:\s*'([^']+)'/g)]
    .map((m) => ({ key: m[1]!, label: m[2]!, icon: m[3]! }))
}

/** 前端落地页：PRIVACY_ITEMS 里的 (key, label, icon) 三元组。 */
function frontendItems(): Array<{ key: string; label: string; icon: string }> {
  const block = panel.match(/const PRIVACY_ITEMS[^=]*=\s*\[([\s\S]*?)\n\]/)?.[1] ?? ''
  return [...block.matchAll(/key:\s*'([^']+)',\s*label:\s*'([^']+)',\s*icon:\s*'([^']+)'/g)]
    .map((m) => ({ key: m[1]!, label: m[2]!, icon: m[3]! }))
}

describe('隐私体检：落地态完整且与后端一致', () => {
  it('解析到了两边的类别清单（防空转）', () => {
    expect(backendCategories().length, '没解析到后端 CATEGORIES').toBeGreaterThanOrEqual(6)
    expect(frontendItems().length, '没解析到前端 PRIVACY_ITEMS').toBeGreaterThanOrEqual(6)
  })

  it('前端列的体检项 = 后端真正在扫的类别（key / label / icon / 顺序都一致）', () => {
    expect(frontendItems()).toEqual(backendCategories())
  })

  it('落地态不再是一行文字，而是四段结构（范围 / 产出 / 不会做什么 / 体检项 / 隐私边界）', () => {
    expect(panel).toContain('function PrivacyLanding')
    for (const anchor of ['会扫描什么', '结果能做什么', '体检不会做什么', 'pvItems', 'pvGuard']) {
      expect(panel, `落地态缺少「${anchor}」`).toContain(anchor)
    }
    // 旧的裸一行：`{!error && !loading && !data && <div className={css.empty}>体检你的微信数据…`
    expect(panel).not.toMatch(/<div className=\{css\.empty\}>体检你的微信数据/)
  })

  it('落地态与扫描中共用一个结构（扫描时不能又退回成一句话）', () => {
    expect(panel).toContain('<PrivacyLanding scanning={loading} />')
    expect(panel).toMatch(/scanning \? '正在扫描…' : '会扫描什么'/)
  })

  it('范围数字来自总览缓存而不是新发一次重查询', () => {
    expect(panel).toContain('dsh-wechat-overview-base-v1')
    expect(panel).toContain('dsh-wechat-overview-insights-v1')
    // 读缓存必须容错：缓存缺失/损坏时要退化成只说范围，不能让面板崩掉
    expect(panel).toMatch(/function readScope\(\)[\s\S]*?catch\s*\{/)
  })
})
