/**
 * 上线门禁（`docs/RELEASE-PLAN.md` § 十二）点名的命令必须真的存在、真的在 CI 里跑。
 *
 * ## 为什么要机检这一段
 *
 * 门禁清单是「能不能发布」的最终依据，而它的每一条都写成「某年某月用 `npm run xxx` 实测过」。
 * 命令一旦被改名或删掉，那句话就永远查无实据 —— 但**文档不会变红**，人也不会有任何提示，
 * 于是清单继续以「已核验」的姿态被引用。这正是 N37（条目表把未关闭的调查项藏掉）与
 * N38（列数不符让状态显示在错的列上）同一族的问题：**声明的形态在，可执行的事实在漂**。
 *
 * ## 口径
 *
 * - 只看两处：文档头部（那句「哪些东西在 CI 里能阻断合并」）与 § 十二 整段。
 * - 「命令样子串」= `小写名:小写名[:…]`（前面不能紧贴单词字符）。实测这个形状在两处里
 *   **零误报**（11 条全是 package.json 里真实存在的 script），所以不需要任何例外名单。
 * - 「在 CI 里」= `.github/workflows/ci.yml` 里有 `npm run <名>` 或 `npm test` 这一行。
 *
 * @module tests/release-gate-commands
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { grp } from './helpers/strict-index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const PLAN = readFileSync(join(ROOT, 'docs', 'RELEASE-PLAN.md'), 'utf8')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
const CI = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

/** 文档头部那几句（到第一个二级标题之前）。 */
const HEADER = PLAN.slice(0, PLAN.indexOf('\n## '))

/** § 十二 整段。 */
const GATE_SECTION = (() => {
  const from = PLAN.indexOf('## 十二、上线门禁')
  const to = PLAN.indexOf('## 十三、')
  if (from === -1 || to === -1) {
    throw new Error('找不到「## 十二、上线门禁」到「## 十三、」这一段 —— 章节被改名的话，这里的判据要跟着改')
  }
  return PLAN.slice(from, to)
})()

/**
 * 命令样子串：`name:sub` / `name-a:b`（前后不能紧贴单词字符或连字符）。
 *
 * 连字符那一段是**被变异测出来的**：第一版写成 `[a-z][a-z0-9]*(?::…)+`，于是
 * `license-gate:smoke` 这种带连字符的名字**整个匹配不上** —— 把文档里的它改成
 * `license-gate:smoked`（一个不存在的命令）时守卫照样全绿。判据自己漏了一类，比没有判据更坏。
 */
const SCRIPT_SHAPED = /(^|[^A-Za-z0-9_-])([a-z][a-z0-9]*(?:-[a-z0-9]+)*:[a-z0-9][a-z0-9:_-]*)/g

/**
 * 从一段文本里取出所有「像 npm script」的串。
 * @param text - 被扫的文本。
 * @returns 去重后的名字集合。
 */
function scriptNamesIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(SCRIPT_SHAPED)) out.add(grp(m, 2, '命令样子串'))
  return [...out]
}

/** 单测步的包装脚本（2026-09-24 的 N36 政策：假红允许带记录地重跑一次，所以要过一层判定）。 */
const UNIT_WRAPPER = 'scripts/ci-unit-step.mjs'

/**
 * ci.yml 里**真的会执行**的那些命令行（`run:` 开头）。
 *
 * 为什么不拿整份 yaml 搜命令名：注释也会被搜到。实测第一版就被这个洞骗过 ——
 * 把单测步换成包装脚本之后，ci.yml 里还剩两条**注释**写着 `npm test`，
 * 于是「npm test 在 CI 里跑」照样全绿（把包装脚本的默认命令改掉的变异打不出来）。
 * 只认 `run:` 行之后，注释就不算数了；对其它命令同样是加固
 * （注释里提一句 `license-gate:smoke` 再也不能冒充「这一步在 CI 里跑」）。
 */
const CI_RUN_LINES = [...CI.matchAll(/^\s*run:\s*(.*)$/gm)].map((m) => (m[1] ?? '').trim())

/**
 * 某个命令是否真的在 CI 里跑。
 * @param name - script 名。
 * @returns 命中 `npm run <名>`（或 `npm test`）时为真。
 */
function runsInCi(name: string): boolean {
  const isRun = (re: RegExp): boolean => CI_RUN_LINES.some((line) => re.test(line))
  if (name === 'test') {
    if (isRun(/^npm test(\s|$)/)) return true
    // 走包装脚本的间接调用也认，但**必须两头都验**：ci.yml 点名了这个脚本，且脚本默认命令
    // 真的是 `npm test`。少验任何一头，「npm test 在 CI 里跑」这句话都会变成空的 ——
    // 而它正是本文件要机检的那类声明。
    if (!CI.includes(UNIT_WRAPPER)) return false
    const src = readFileSync(join(ROOT, UNIT_WRAPPER), 'utf8')
    return /SUPERTIME_UNIT_CMD\s*\?\?\s*'npm test'/.test(src)
  }
  return isRun(new RegExp(`^npm run ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`))
}

/** 头部那句「都在 CI 里能阻断合并」点名的东西（按类别，不写死一条字符串）。 */
const CLAIMED_IN_CI = ['test', 'typecheck', 'docs:api:check']

describe('上线门禁点名的命令要存在、要真的在 CI 里跑', () => {
  const named = [...new Set([...scriptNamesIn(HEADER), ...scriptNamesIn(GATE_SECTION)])].sort()

  it('解析口径本身要有效：两处合起来至少点名 8 个命令', () => {
    // 没有这条，改名/改段落会让下面的断言变成「空集合相等」而恒绿。
    expect(named.length, `只认出 ${String(named.length)} 个命令样子串 —— 多半是正则或章节边界变了：${named.join(', ')}`)
      .toBeGreaterThanOrEqual(8)
  })

  it('每一个点名的命令都还在 package.json 的 scripts 里', () => {
    const missing = named.filter((n) => !(n in PKG.scripts))
    expect(missing.join('\n'), '门禁清单引用了不存在的命令（改名或删掉会让那条验收查无实据）')
      .toBe('')
  })

  it('头部那句「在 CI 里能阻断合并」点名的命令，CI 里确实各有一行', () => {
    const absent = CLAIMED_IN_CI.filter((n) => !runsInCi(n))
    expect(absent.join('\n'), '文档说有门禁能拦合并，ci.yml 里却找不到对应步骤')
      .toBe('')
  })

  it('清单里被当成「CI 证据」的那两类真机 e2e 与安全守卫，也确实在 ci.yml 里', () => {
    const e2e = named.filter((n) => n.startsWith('e2e:'))
    expect(e2e.length, '门禁段一条 `e2e:*` 都没点名 —— 那段话改写过，这条判据要重新对一遍')
      .toBeGreaterThanOrEqual(1)
    const notRun = e2e.filter((n) => !runsInCi(n))
    const guardMissing = ['security-guard:smoke', 'license-gate:smoke'].filter((n) => !runsInCi(n))
    expect([...notRun, ...guardMissing].join('\n'), '这些步骤被写成「CI 里有」，但 ci.yml 里没有')
      .toBe('')
  })

  it('单测步要么直接 `npm test`，要么经由「默认命令就是 npm test」的包装脚本 —— 两头总得有一条', () => {
    // 2026-09-24 起走的是后者（N36 政策：已归因的假红允许带记录地重跑一次）。
    // 两头都断言，是因为只查 ci.yml 会出现这种洞：步骤写 `node scripts/ci-unit-step.mjs`，
    // 而那个脚本里的默认命令被改成了别的（或者干脆没跑测试）—— 文档那句「npm test 在 CI 里」就成了空话。
    const direct = CI_RUN_LINES.some((line) => /^npm test(\s|$)/.test(line))
    const wrapperSrc = readFileSync(join(ROOT, UNIT_WRAPPER), 'utf8')
    const viaWrapper = CI.includes(UNIT_WRAPPER) && /SUPERTIME_UNIT_CMD\s*\?\?\s*'npm test'/.test(wrapperSrc)
    expect(direct || viaWrapper, `ci.yml 里既没有直接的 npm test，也没走「默认命令 = npm test」的包装脚本（${UNIT_WRAPPER}）`)
      .toBe(true)
  })
})
