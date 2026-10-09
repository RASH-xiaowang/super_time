/**
 * 变异增量选取（`scripts/mutation-scope.mjs`）的行为断言。
 *
 * ## 这条逻辑为什么值得单测
 *
 * 增量选取是「PR 门禁跑一部分变异」的唯一依据，而它一旦**少选**，后果是**静默的**：
 * 门禁照样绿，只是那条变异根本没跑。所以断言必须落在两件容易被写错的事上：
 *
 *   1. **spec 改了也要重跑** —— 只按目标文件筛会漏掉「削弱守卫」那类改动；
 *      2026-10-09 实测（HEAD~1…HEAD 改 30 个文件）：45 条 vs 53 条，多出的 8 条全是这一类。
 *   2. **登记表被动 ⇒ 全量**，且**取不到 diff ⇒ 全量** —— 筛选基准被改、或筛选失败时，
 *      退化成全量才是安全的默认；静默跳过是最坏的结果。
 *
 * 刻意**不**去断言「具体选了哪几条 id」：那会把它绑死在当时的登记表上，
 * 每加一条变异就要改这里一次，而它并不提供额外的保护力。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { changedFilesSince, REGISTRY_PATH_RE, selectForDiff } from '../../../scripts/mutation-scope.mjs'
import { MUTATIONS } from '../../../scripts/mutations-registry.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('变异增量选取', () => {
  const A = 'src/backend/wechat-data/src/query/sns-cdn-image.ts'
  const SPEC = 'src/backend/wechat-data/tests/sns-image-integrity-guard.spec.ts'
  const table = [
    { id: 'M1', file: A, spec: SPEC },
    { id: 'M2', file: 'src/backend/wechat-data/src/query/moments.ts', spec: 'src/backend/wechat-data/tests/moments.spec.ts' },
    { id: 'M3', file: 'src/client/ui-wechat/src/client/pages/wechat-data/media-cache.ts', spec: SPEC },
  ]

  it('改了目标文件 ⇒ 那条变异要重跑', () => {
    const r = selectForDiff(table, [A])
    expect(r.all).toBe(false)
    expect(r.picked.map((m) => m.id)).toEqual(['M1'])
  })

  it('⚠️ 只改了 spec（目标文件没动）⇒ 也要重跑，否则「削弱守卫」的门是空的', () => {
    // 这条就是全部意义所在：把守卫改松是最容易发生的改动，而它恰好不碰任何目标文件。
    const r = selectForDiff(table, [SPEC])
    expect(r.all).toBe(false)
    expect(r.picked.map((m) => m.id), 'spec 命中的两条都要跑').toEqual(['M1', 'M3'])
    expect(r.bySpec).toBe(2)
    expect(r.byTarget).toBe(0)
  })

  it('目标与 spec 都命中同一条时只算一次', () => {
    const r = selectForDiff(table, [A, SPEC])
    expect(r.picked.map((m) => m.id)).toEqual(['M1', 'M3'])
    expect(new Set(r.picked.map((m) => m.id)).size).toBe(r.picked.length)
  })

  it('改动与任何一条都无关 ⇒ 选中 0 条（全量由 mutation-check 判为「无事可验」而非失败）', () => {
    const r = selectForDiff(table, ['docs/README.md'])
    expect(r.picked).toEqual([])
    expect(r.all).toBe(false)
  })

  it('登记表本体被改动 ⇒ 全量（筛选基准已经被改了，按文件筛没有意义）', () => {
    for (const f of ['scripts/mutations-registry.mjs', 'scripts/mutations-registry.batch3d.mjs']) {
      const r = selectForDiff(table, [f])
      expect(r.all, f + ' 被动却没有触发全量').toBe(true)
      expect(r.picked).toHaveLength(table.length)
    }
  })

  it('Windows 反斜杠也能对上（git 给的是 `/`，但调用方未必）', () => {
    const r = selectForDiff(table, [A.replace(/\//g, '\\')])
    expect(r.picked.map((m) => m.id)).toEqual(['M1'])
  })

  it('REGISTRY_PATH_RE 只认登记表那几个文件，不误伤别的 scripts/*.mjs', () => {
    expect(REGISTRY_PATH_RE.test('scripts/mutation-check.mjs')).toBe(false)
    expect(REGISTRY_PATH_RE.test('scripts/mutation-scope.mjs')).toBe(false)
    expect(REGISTRY_PATH_RE.test('scripts/mutations-registry.batch3c.mjs')).toBe(true)
  })
})

describe('增量选取与真实登记表对得上', () => {
  it('拿 HEAD~1…HEAD 试选一次，能选出东西且全在登记表里', () => {
    const r = changedFilesSince('HEAD~1', ROOT)
    expect(r.ok, '取 diff 失败：' + r.detail).toBe(true)
    expect(r.files.length, '这个参照点应该至少动了一个文件').toBeGreaterThan(0)
    const sel = selectForDiff(MUTATIONS, r.files)
    expect(sel.picked.length).toBeLessThanOrEqual(MUTATIONS.length)
    for (const m of sel.picked) expect(MUTATIONS).toContain(m)
  })

  it('取一个不存在的 ref ⇒ ok=false（调用方据此退化成全量，绝不静默跳过）', () => {
    const r = changedFilesSince('refs/heads/definitely-not-a-real-ref-xyz', ROOT)
    expect(r.ok).toBe(false)
    expect(r.files).toEqual([])
  })

  it('⚠️ 每条变异都必须有 file 与 spec —— 少一个就等于它在增量模式下永远不会被选中', () => {
    const broken = MUTATIONS.filter((m) => !existsSync(join(ROOT, String(m.file))) || !existsSync(join(ROOT, String(m.spec))))
    expect(broken.map((m) => m.id + ' → ' + m.file + ' / ' + m.spec), '这些条目的目标或判据文件不存在').toEqual([])
  })
})

describe('门禁必须调这个脚本（不然增量选取只是一段没人跑的死代码）', () => {
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const nightly = existsSync(join(ROOT, '.github', 'workflows', 'nightly.yml'))
    ? readFileSync(join(ROOT, '.github', 'workflows', 'nightly.yml'), 'utf8') : ''

  it('PR 门禁跑增量', () => {
    expect(ci).toContain('check:mutation:diff')
  })

  it('夜间跑全量（增量没覆盖到的那些必须有地方兜底）', () => {
    expect(nightly, '还没有夜间工作流').not.toBe('')
    expect(nightly).toContain('check:mutation')
    expect(nightly).not.toContain('check:mutation:diff')
  })
})
