/**
 * CI 分档的自检：把 `scripts/ci-tiers.mjs` 那张表对着三个 workflow 逐条核对。
 *
 * ## 为什么这张表要有守卫
 *
 * 「哪些检查进了哪档门禁」这件事如果只写在 workflow YAML 里，会有三个静默的坏掉方式：
 *
 *   1. 改了 workflow 忘了改表 ⇒ 下一个人照着过期清单做决定；
 *   2. 表里写了某个 script，但它被改名/删了 ⇒ 那条检查其实已经不存在了；
 *   3. **`KNOWN_ROT` 里的东西被顺手接进某档** ⇒ 门禁从此常红，
 *      而「常红」和「没这条」一样糟 —— 通常的结果是把 `continue-on-error` 打开，
 *      于是它变成一个**看起来在跑、其实什么都不拦**的检查。
 *
 * 第 3 条是这里最要紧的一条，所以单独有断言：腐烂清单里的 script **不许**出现在任何 workflow 里。
 *
 * ⚠ 反过来也成立：「不接进门禁」只是止血。`ui:longlist-e2e` 在 KNOWN_ROT 里躺了一个多月 ——
 *   没人跑它，所以没人发现它唯一那条红判据的根因只是夹具每天 10 条、让场景永远不可能发生。
 *  2026-10-11 修好接进 TIER1 后，`ci-tiers.mjs` 里留了墓碑（`KNOWN_ROT` 之后的注释块），
 *  免得下一个人照着那条过期结论重新规划一次。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KNOWN_ROT, LOCAL_ONLY, MEASURED_ON, TIER1, TIER2, TIER3 } from '../../../scripts/ci-tiers.mjs'
import { MUTATIONS } from '../../../scripts/mutations-registry.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

/**
 * 读 workflow 并**剥掉 `#` 注释行**。
 *
 * 为什么必须剥：这次加注释时正好踩到了 —— 我在 `release.yml` 里写了一句
 * 「下一步就是 `npm run dist -- --publish always`，一步到位发布」，
 * 于是「按顺序断言 pack 在发布之前」去找 `indexOf('npm run pack')` 时，
 * 命中的第一个 `--publish always` 在**我自己的注释里**而不是真步骤里，
 * 断言于是变成「注释写在发布后面」。仓库早就有 `code()` 剥注释的纪律（见
 * `sns-image-integrity-guard.spec.ts`），YAML 这边补上同一套。
 */
const wf = (name: string): string => readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8')
  .split(/\r?\n/)
  .map((l) => (/^\s*#/.test(l) ? '' : l))
  .join('\n')

const ci = wf('ci.yml')
const nightly = wf('nightly.yml')
const release = wf('release.yml')

/** 这个 script 在某个 workflow 里被真的调用了吗（按 `npm run <name>` 找，注释已剥）。 */
const runsIn = (text: string, script: string): boolean => new RegExp('npm run ' + script.replace(/[:/]/g, '\\$&') + '(?![\\w:-])').test(text)

describe('分档表本身', () => {
  it('表里每一条都是 package.json 里真实存在的 script（改名/删除后不许悄悄留在表里）', () => {
    const all = [...TIER1, ...TIER2, ...TIER3, ...KNOWN_ROT, ...LOCAL_ONLY].map((r) => r.script)
    const missing = all.filter((s) => pkg.scripts[s] === undefined)
    expect(missing, '这些 script 已不存在，表要跟着改').toEqual([])
  })

  it('三档之间没有重复（同一个检查挂两档 = 白跑一遍，或者两处的时间预期都不准）', () => {
    const seen = new Map<string, string>()
    const dup: string[] = []
    for (const [tier, rows] of [['1', TIER1], ['2', TIER2], ['3', TIER3]] as const) {
      for (const r of rows) {
        if (seen.has(r.script)) dup.push(r.script + '（1 档与 ' + seen.get(r.script) + ' 档 / ' + tier + ' 档）')
        else seen.set(r.script, tier)
      }
    }
    expect(dup).toEqual([])
  })

  it('这一轮真正补上的那几件，一张表都不许漏（否则「分档」只是个说法）', () => {
    // 2026-10-09 审计的结论：这三件**此前完全不在任何门禁里** ——
    // `lint:db` 是绿的但新违规没人拦；412 条变异自证一次都没跑过；
    // 9 个性能基准被 `skipIf` 守着、package.json 里又没有 MEASURE_* script，于是从未真跑。
    // 「不在门禁里」不可见，所以这条把结果钉死。
    const all = new Set([...TIER1, ...TIER2, ...TIER3].map((r) => r.script))
    for (const s of ['lint:db', 'check:deps-provenance', 'check:mutation', 'check:mutation:diff', 'measure:quick', 'measure:slow']) {
      expect(all.has(s), s + ' 不在任何一档里 —— 这正是这一轮要修的缺口').toBe(true)
    }
    // 而且必须真的接进 workflow，不只是写进表
    expect(runsIn(ci, 'lint:db')).toBe(true)
    expect(runsIn(ci, 'check:deps-provenance')).toBe(true)
    expect(runsIn(ci, 'measure:quick')).toBe(true)
    expect(runsIn(nightly, 'check:mutation')).toBe(true)
    expect(runsIn(nightly, 'measure:slow')).toBe(true)
  })

  it('每条都写了「为什么是这一档」，且实测日期没过期到离谱', () => {
    for (const [tier, rows] of [['1', TIER1], ['2', TIER2], ['3', TIER3]] as const) {
      for (const r of rows) {
        expect(String(r.why ?? '').length, `${r.script}（${tier} 档）没写理由`).toBeGreaterThan(10)
        expect(String(r.cost ?? ''), `${r.script} 没写实测成本`).not.toBe('')
      }
    }
    // 实测成本是这个表的全部依据；日期写错了那张表就没意义了。放宽到 120 天，
    // 因为它只该在**重新实测**时更新，而不是每次改 workflow 都更新。
    const days = (Date.now() - Date.parse(MEASURED_ON)) / 86400000
    expect(Number.isFinite(days), 'MEASURED_ON 不是可解析的日期').toBe(true)
    expect(days, '成本数字是 ' + MEASURED_ON + ' 实测的，已经过去 ' + Math.round(days) + ' 天 ⇒ 重新实测并更新').toBeLessThan(120)
  })

  it('全量变异条数从登记表现算，不再在各处手抄一个会腐坏的数字', () => {
    const row = TIER2.find((r) => r.script === 'check:mutation')
    expect(row, 'TIER2 里没有 check:mutation').toBeTruthy()
    expect(String(row?.why)).toContain(String(MUTATIONS.length))
    const tiers = readFileSync(join(ROOT, 'scripts', 'ci-tiers.mjs'), 'utf8')
    expect(tiers, 'TIER2 的条数必须从 MUTATIONS.length 现算').toContain('${MUTATIONS.length}')
  })
})

describe('第一档：PR 门禁真的调了表里每一条', () => {
  for (const r of TIER1) {
    it('ci.yml 调了 ' + r.script + '（' + r.cost + '）', () => {
      expect(runsIn(ci, r.script), r.script + ' 在表里但不在 ci.yml 里').toBe(true)
    })
  }

  it('变异增量那条必须拿到基线 ref（拿不到就会退化成全量，25~30 分钟会把 job 顶爆）', () => {
    expect(ci).toContain('SUPERTIME_MUTATION_BASE')
    // pull_request 与 push 两种事件的 base 字段名不同，两个都要写
    expect(ci).toContain('github.event.pull_request.base.sha')
    expect(ci).toContain('github.event.before')
    // 浅克隆会让 `git diff <base>...HEAD` 失败 ⇒ 必须拉全历史
    expect(ci).toMatch(/fetch-depth: 0/)
  })

  it('登记表被动时要另起一条全量 job，且它有独立的 timeout（不能挤在单测已占 26 分钟的那条里）', () => {
    expect(ci).toContain('mutation-full')
    expect(ci).toContain('ci-needs-full-mutation.mjs')
    expect(ci).toContain("steps.probe.outputs.needs_full_mutation == 'true'")
  })

  it('第一档每一步都有 timeout 兜底（Windows runner 比本机慢约 24 倍，秒级检查在 CI 上也会飘）', () => {
    // 具体哪几条必须带 timeout 由 YAML 结构保证；这里只守住「变异增量」这一条 ——
    // 它是唯一耗时不可预测的（选中几条取决于 diff）。
    const step = /- name: 变异自证（增量）\r?\n\s+timeout-minutes: \d+/.exec(ci)
    expect(step, '变异增量步骤没有 timeout').not.toBeNull()
  })
})

describe('第二档：夜间工作流跑的是全量，而不是增量', () => {
  for (const r of TIER2) {
    it('nightly.yml 调了 ' + r.script + '（' + r.cost + '）', () => {
      expect(runsIn(nightly, r.script), r.script + ' 在表里但不在 nightly.yml 里').toBe(true)
    })
  }

  it('⚠️ 夜间跑的全量变异**不是**增量那个 script（不然第二档就白设了）', () => {
    expect(nightly).toContain('npm run check:mutation')
    expect(nightly).not.toContain('check:mutation:diff')
  })

  it('tag 发布也要在 publish 之前自己跑全量变异（tag push 不触发 ci.yml，夜间档可能晚于发版）', () => {
    const iMutation = release.indexOf('npm run check:mutation')
    const iPublish = release.indexOf('--publish always')
    expect(iMutation, 'release.yml 没有全量变异自证').toBeGreaterThan(-1)
    expect(iPublish).toBeGreaterThan(-1)
    expect(iMutation, '全量变异自证必须排在发布之前').toBeLessThan(iPublish)
    expect(release, '发版跑增量自证会漏掉「目标与 spec 都没动」的登记表腐坏').not.toContain('check:mutation:diff')
  })

  it('夜间 job 要拉全历史并准备 Electron（两个真机 e2e 起的是 node_modules 里那个二进制）', () => {
    expect(nightly).toMatch(/fetch-depth: 0/)
    expect(nightly).toContain('node node_modules/electron/install.js')
  })

  it('Node 版本与 PR 门禁一致（门禁要在发版用的那个 Node 上跑）', () => {
    const v = /node-version: '([^']+)'/.exec(nightly)
    expect(v, 'nightly.yml 没写 node-version').not.toBeNull()
    expect(v![1], '夜间用的 Node 与 PR 门禁不一致 ⇒ 夜间验的不是发版用的那套运行时').toBe(String(/node-version: '([^']+)'/.exec(ci)![1]))
  })

  it('夜间是 schedule 触发且每天最多一次（否则它就不是"夜间"而是又一条 PR 门禁）', () => {
    expect(nightly).toContain('schedule:')
    expect(nightly).toMatch(/cron: '\d+ \d+ \* \* \*'/)
    expect(nightly).not.toMatch(/cron: '[^']*\*[^ ]* [^']*\*[^ ]* \* \* \*'/)
  })
})

describe('第三档：发版前跑，且在发布之前', () => {
  for (const r of TIER3) {
    it('release.yml 调了 ' + r.script, () => {
      expect(runsIn(release, r.script), r.script + ' 在表里但不在 release.yml 里').toBe(true)
    })
  }

  it('⚠️ 打包态检查必须在 `--publish always` **之前**（之后失败时版本已经发出去了）', () => {
    const iPack = release.indexOf('npm run pack')
    const iPublish = release.indexOf('--publish always')
    expect(iPack, 'release.yml 里没有 npm run pack').toBeGreaterThan(-1)
    expect(iPublish).toBeGreaterThan(-1)
    expect(iPack, 'pack 必须排在发布之前').toBeLessThan(iPublish)
  })

  it('打包态冒烟都在 pack 之后（它们要读 dist/win-unpacked）', () => {
    const iPack = release.indexOf('npm run pack')
    for (const r of TIER3) {
      const i = release.indexOf('npm run ' + r.script)
      expect(i, r.script + ' 不在 release.yml 里').toBeGreaterThan(-1)
      expect(i, r.script + ' 排在 npm run pack 之前 ⇒ 它读不到打包件').toBeGreaterThan(iPack)
    }
  })
})

describe('KNOWN_ROT：明知坏、不许接进任何一档', () => {
  for (const r of KNOWN_ROT) {
    it(`${r.script} 不在任何 workflow 里`, () => {
      for (const [name, text] of [['ci.yml', ci], ['nightly.yml', nightly], ['release.yml', release]] as const) {
        expect(runsIn(text, r.script), `${r.script} 出现在 ${name} 里 —— 它是 KNOWN_ROT，接进去门禁就会常红`).toBe(false)
      }
    })
  }

  it('每条都写了症状与根因（下一个人不该重新查一遍）', () => {
    for (const r of KNOWN_ROT) {
      expect(String(r.symptom ?? '').length, r.script + ' 没写症状').toBeGreaterThan(8)
      expect(String(r.rootCause ?? '').length, r.script + ' 没写根因').toBeGreaterThan(8)
    }
  })
})

describe('LOCAL_ONLY：只能在本机跑，不许接进 workflow', () => {
  it('要么为空、要么每条都是真本机专属（判据由 `ci-script-isolation` 本身执行）', () => {
    // 这里**刻意不去重复**那条守卫的判定（它用 AST 抽字符串字面量，比字符串搜索准，
    // 而且它连测试文件本身一起扫 —— 我第一版把那两个本机专属路径的字面量写进这个 spec，
    // 结果它当场把自己判红了，那才是本轮最讽刺的一次）。
    //
    // W2-13.3 起它**允许为空**：最后一条（`package:smoke`）已毕业进 TIER2 ——
    // 「只能本机跑」的原因（路径尾段被拆成常量）是可以修的，修完本地清单就该空下来。
    // 空清单是好事，不是漏登记：真被接进去时，`ci-script-isolation` 会独立报出
    // 「引用了本机专属资源」，所以这里不需要再用「非空」假装守住它。
    expect(LOCAL_ONLY.length).toBeGreaterThanOrEqual(0)
  })

  for (const r of LOCAL_ONLY) {
    it(`${r.script} 不在任何 workflow 里`, () => {
      for (const [name, text] of [['ci.yml', ci], ['nightly.yml', nightly], ['release.yml', release]] as const) {
        expect(runsIn(text, r.script), `${r.script} 出现在 ${name} 里 —— 它引用本机专属资源，接进去必挂`).toBe(false)
      }
    })

    it(`${r.script} 写了为什么只能本机跑`, () => {
      expect(String(r.why ?? '').length, r.script + ' 没写原因').toBeGreaterThan(10)
    })
  }
})

describe('查漏：仓里有哪些 script 仍然三档都没进', () => {
  it('列出来供人看（这条不设断言 —— 剩下的多半是 start/dev/license-keygen 这类**不该**进 CI 的）', () => {
    const covered = new Set([...TIER1, ...TIER2, ...TIER3, ...KNOWN_ROT, ...LOCAL_ONLY].map((r) => r.script))
    const preExisting = new Set(
      [...ci.matchAll(/npm run ([\w:-]+)/g), ...nightly.matchAll(/npm run ([\w:-]+)/g), ...release.matchAll(/npm run ([\w:-]+)/g)]
        .map((m) => m[1]),
    )
    const uncovered = Object.keys(pkg.scripts).filter((s) => !covered.has(s) && !preExisting.has(s))
    console.log('  三档都没进、也不是既有门禁在调的 ' + String(uncovered.length) + ' 个：')
    for (const s of uncovered) console.log('    ' + s.padEnd(30) + String(pkg.scripts[s] ?? '').slice(0, 66))
    expect(true).toBe(true)
  })
})
