/**
 * N2：首启闸门的调试豁免开关，且**打包态不得豁免**（含「设了环变量也不放行」）。
 *
 * 三道闸门：启动引导（`OnboardingShell` 的「跳过」要求 `licenseOk`）→ 隐私同意
 * （同一个启动页的第五站，H14 起排在授权之前）→ 授权（`LicenseGate` 与主进程 `wechat:call` 的 `authorizeCall`）。
 * 自动化要进主界面，本来得签真许可证 + 往 localStorage 伪造「已同意」记录（见 N2 原文）。
 *
 * ## 这项最重要的性质是「不能生效」
 *
 * 豁免必须只在**非打包态**成立，而环变量不是信任边界 —— 谁都能 set。
 * 可靠的事实只有 `app.isPackaged`，所以判据分三层，全部是行为判定：
 *   ① 纯函数：`isPackaged: true`（以及缺失/类型不对）时一律不豁免；
 *   ② 主进程接线：算 `isPackaged` 的实参必须是 Electron 的 `app.isPackaged`（AST 只认真实
 *      调用点，注释掉不算 —— M12/N19/N20 反复栽的同一个坑）；
 *   ③ 渲染层接线：豁免判定必须走 `shouldSkipGates`（它要求 `packaged === false`），
 *      且三道闸门的分支都要被同一个豁免变量守着。
 *
 * ## 能守什么、守不住什么（如实标注）
 *
 *   · **守得住**：判定函数的行为、主进程/渲染层的接线、「打包态下 skipGates 恒 false」；
 *   · **守不住**：真的装一个打包版并设环变量去看它是否进主界面 —— 打包需要
 *     `npm run pack`（本轮被禁止），所以「打包态不能绕过」的证据是「判定函数 + 接线」，
 *     不是「打包产物实机跑过」。同样，界面行为（是否真的进到主界面）需要浏览器环境，
 *     本仓没有，只有 SSR 冒烟与 `scripts/ui-acceptance.mjs`（需要 playwright，未安装）。
 *
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { HANG_ENV, SKIP_GATES_ENV, resolveDebugGates, resolveHangMethods } from '../debug-gates.js'
// P3-17：渲染层那个纯函数（`shouldSkipGates`）的行为判据搬到了它自己那一层
// —— `src/client/ui-app/debug-gates.spec.ts`。宿主层的 spec 直接 import 前端源码是**反向依赖**
// （后端构建产物不该认识前端模块）。本文件继续守**接线**：读 `ui-entry.tsx` 的源码文本，
// 断言它真的调用了一次 `shouldSkipGates`、实参是主进程给的 IPC 事实、三道闸门都由同一个豁免变量守着。
// 「读文本做断言」与「import 值」是两回事：前者是源码级守卫的常规手段，后者才是跨层耦合。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
// M21 第二十刀：misc IPC 频道搬去了 `src/backend/ipc-misc.js` ⇒ 读取面改**联合**
// （断言一条没改；app:debug-gates / dialog:open-file 这些字符串搬到哪份都算数）。
// H7 的 fork 与挂起注入现在住在 backend-supervisor.js；组合根 main.js 仍负责注入 deps。
const mainSrc = [join(ROOT, 'main.js'), join(ROOT, 'src', 'backend', 'backend-supervisor.js')]
  .concat(readdirSync(join(ROOT, 'src', 'backend')).filter((f) => /^ipc-[a-z]+\.js$/.test(f))
    .map((f) => join(ROOT, 'src', 'backend', f)))
  .map((f) => readFileSync(f, 'utf8')).join('\n')
/** IPC 处理器那几个模块（不含 main.js）：`wechat:call` 的注册点在这里。 */
const ipcSrc = readdirSync(join(ROOT, 'src', 'backend')).filter((f) => /^ipc-[a-z]+\.js$/.test(f))
  .map((f) => readFileSync(join(ROOT, 'src', 'backend', f), 'utf8')).join('\n')
/**
 * 闸门实现的**唯一出处**（2026-10-14 从 ipc-wechat.js 抽出）。
 * IPC 与 HTTP（局域网远程访问）两条路都调它，所以顺序不变量只需要在这里成立一次。
 */
const gatesSrc = readFileSync(join(ROOT, 'src', 'backend', 'call-gates.js'), 'utf8')
const preloadSrc = readFileSync(join(ROOT, 'preload.js'), 'utf8')
const entryPath = join(ROOT, 'src', 'client', 'ui-app', 'ui-entry.tsx')
const entrySrc = readFileSync(entryPath, 'utf8')
const acceptanceSrc = (() => {
  // M21：验收脚本拆成「场景」+「夹具/助手」两个模块 —— 读它们的联合，
  // 断言一条没改（搬去 lib 的助手照样算这个脚本的一部分）。
  const dir = join(ROOT, 'scripts')
  return ['ui-acceptance.mjs', 'ui-acceptance-lib.mjs']
    .map((f) => { try { return readFileSync(join(dir, f), 'utf8') } catch { return '' } })
    .join('\n')
})()

/** 解析一段源码（.js 用 JS，.tsx 用 TSX）以便只认真实节点。 */
function parse(file: string, src: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JS
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind)
}

/** 收集源码里所有真实 `CallExpression`，键是「被调表达式的源码文本」。 */
function callExpressions(file: string, src: string): Array<{ callee: string; args: string[] }> {
  const sf = parse(file, src)
  const out: Array<{ callee: string; args: string[] }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      out.push({ callee: node.expression.getText(sf), args: node.arguments.map((a) => a.getText(sf)) })
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return out
}

/** 取 `if` 语句的测试表达式文本（用于断言闸门分支真的被豁免变量守着）。 */
function ifTests(file: string, src: string): string[] {
  const sf = parse(file, src)
  const tests: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) tests.push(node.expression.getText(sf))
    node.forEachChild(visit)
  }
  visit(sf)
  return tests
}

/** 取「测试表达式 → 语句体源码文本」的全部 `if`（用于断言某个分支里到底渲染了什么）。 */
function ifBranches(file: string, src: string): Array<{ test: string; body: string }> {
  const sf = parse(file, src)
  const out: Array<{ test: string; body: string }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) out.push({ test: node.expression.getText(sf), body: node.thenStatement.getText(sf) })
    node.forEachChild(visit)
  }
  visit(sf)
  return out
}

describe('N2：豁免判定的纯函数（打包态一律不豁免）', () => {
  it('非打包态 + 显式开关 ⇒ 豁免', () => {
    expect(SKIP_GATES_ENV).toBe('SUPERTIME_SKIP_ONBOARDING')
    expect(resolveDebugGates({ isPackaged: false, env: { SUPERTIME_SKIP_ONBOARDING: '1' } }))
      .toEqual({ packaged: false, requested: true, skipGates: true })
  })

  it('**打包态 + 设了环变量 ⇒ 仍然不豁免**（本项的核心安全要求）', () => {
    const r = resolveDebugGates({ isPackaged: true, env: { SUPERTIME_SKIP_ONBOARDING: '1' } })
    expect(r.skipGates, '打包态被环变量绕过了').toBe(false)
    // 事实也要如实回给渲染层，渲染层才可能做第二道校验
    expect(r.packaged).toBe(true)
    expect(r.requested).toBe(true)
  })

  it('没设环变量（或值不是 1）⇒ 不豁免', () => {
    for (const env of [{}, { SUPERTIME_SKIP_ONBOARDING: '0' }, { SUPERTIME_SKIP_ONBOARDING: 'true' },
      { SUPERTIME_SKIP_ONBOARDING: '' }, { SUPERTIME_SKIP_ONBOARDING: 'yes' }]) {
      expect(resolveDebugGates({ isPackaged: false, env }).skipGates, JSON.stringify(env)).toBe(false)
    }
  })

  it('isPackaged 缺失/类型不对 ⇒ 不豁免（失败方向是照常走闸门）', () => {
    // 调用方写错（忘传、传了字符串、传了 process.env 里的值）时不能默认放行
    for (const bogus of [undefined, null, 'false', 0, 1, 'true', {}]) {
      const r = resolveDebugGates({ isPackaged: bogus, env: { SUPERTIME_SKIP_ONBOARDING: '1' } })
      expect(r.skipGates, `isPackaged=${JSON.stringify(bogus)} 时不应放行`).toBe(false)
    }
    // 连 opts 都不传
    expect(resolveDebugGates().skipGates).toBe(false)
  })
})

describe('N2：接线守卫（主进程 / preload / 渲染层 / 验收脚本）', () => {
  it('主进程把 app.isPackaged 作为事实交给判定函数', () => {
    const calls = callExpressions('main.js', mainSrc).filter((c) => c.callee === 'resolveDebugGates')
    expect(calls.length, 'main.js 里找不到 resolveDebugGates(...) 的真实调用点').toBeGreaterThan(0)
    for (const c of calls) {
      // 实参必须是对象字面量里现取的 app.isPackaged（写死 false / 读环变量都会被这条拦下）
      expect(c.args.join(','), 'isPackaged 的取值必须来自 Electron 的 app.isPackaged')
        .toContain('isPackaged: app.isPackaged')
    }
  })

  it('豁免状态经 IPC 回给渲染层，且返回值含 packaged 与 skipGates 两个事实', () => {
    expect(preloadSrc).toContain("ipcRenderer.invoke('app:debug-gates')")
    expect(preloadSrc).toMatch(/debugGates:\s*\(\)\s*=>/)
    const at = mainSrc.indexOf("handleIpc('app:debug-gates'")
    expect(at, 'main.js 里没有注册 app:debug-gates').toBeGreaterThan(0)
    const snippet = mainSrc.slice(at, at + 900)
    expect(snippet).toContain('return { packaged: gates.packaged, skipGates: gates.skipGates }')
    // 防空转：注册点必须真的调用判定函数（否则上面那行可能来自别的地方）
    expect(snippet).toContain('const gates = debugGates()')
  })

  it('wechat:call 在 authorizeCall 之前放行豁免，且条件来自主进程判定', () => {
    // 2026-10-14：闸门实现从 ipc-wechat.js 抽到了 call-gates.js（HTTP 那条路也要过同一道闸，
    // 两边各写一份必然漂）。所以这条判据现在看**共用的那份实现**：
    //   ① `wechat:call` 仍然注册着，且委托给 gatedWechatCall（没有绕开闸门自己写一份）；
    //   ② 顺序不变量落在 gatedWechatCall 里 —— 豁免分支必须在 authorizeCall 之前。
    const at = ipcSrc.indexOf("handleIpc('wechat:call'")
    expect(at, 'ipc-wechat.js 里没有注册 wechat:call').toBeGreaterThan(0)
    const handler = ipcSrc.slice(at, at + 400)
    expect(handler, 'wechat:call 不再委托给共用的闸门实现（是绕开了还是自己又写了一份？）')
      .toContain('gatedWechatCall(')

    const fnAt = gatesSrc.indexOf('async function gatedWechatCall(')
    expect(fnAt, 'call-gates.js 里找不到 gatedWechatCall（用例前提不成立）').toBeGreaterThan(-1)
    const body = gatesSrc.slice(fnAt)
    const gateCall = body.indexOf('debugGates().skipGates')
    const authorize = body.indexOf('licenseService.authorizeCall')
    expect(gateCall, '闸门里没有豁免分支 —— 脚本进了主界面也会被许可证挡住').toBeGreaterThan(0)
    expect(authorize, '闸门里找不到 authorizeCall（用例前提不成立）').toBeGreaterThan(0)
    expect(gateCall, '豁免分支必须在 authorizeCall 之前').toBeLessThan(authorize)
    // 条件本身必须来自判定函数，不能是裸的环变量
    expect(body.slice(0, gateCall), '豁免条件里不得直接读环变量').not.toContain('process.env.SUPERTIME_SKIP_ONBOARDING')
    // 顺序不变量之外还有一条：**校验自身抛异常时拒绝**。这一条是 2026-09 修过的洞，
    // 抽出共用实现之后它同时管着两条路，所以在这里一并钉住（行为判据见 call-gates.spec.ts）。
    const catchAt = body.indexOf('catch (e)')
    expect(catchAt, '闸门里没有 catch —— 校验抛异常会变成放行').toBeGreaterThan(authorize)
    expect(body.slice(catchAt), 'catch 分支里没有拒绝用的错误码').toContain('LICENSE_CHECK_FAILED')
  })

  it('渲染层用 shouldSkipGates 判定，且三道闸门都由同一个豁免变量守着', () => {
    const calls = callExpressions(entryPath, entrySrc).filter((c) => c.callee === 'shouldSkipGates')
    expect(calls.length, 'ui-entry.tsx 没有调用 shouldSkipGates —— 渲染层可能自己读环变量去了').toBe(1)
    // 实参必须是主进程给的事实（不是字面量、不是 process.env）
    expect(calls[0]!.args.join(',')).toBe('gates')

    // 2026-10-14：守闸门的变量由 `skipGates` 换成 `gatesBypassed`（= 调试豁免 || 浏览器态），
    // 因为手机浏览器那三道闸门在本设备上做不成（见 capabilities.ts 的 bypassLocalGates）。
    // 判据的**意图**没变，而且多了一条要守的：那个变量的定义里必须**真的含调试豁免** ——
    // 否则「换个变量名把 skipGates 悄悄摘掉」这种改法会静默通过。
    expect(entrySrc, '找不到 gatesBypassed 的定义，或它不再由 skipGates 参与（豁免口径被拆散了）')
      .toMatch(/const gatesBypassed = skipGates \|\| bypassLocalGates/)

    const tests = ifTests(entryPath, entrySrc)
    const gateTests = tests.filter((t) => t.includes('onboardingDone') || t.includes('consented'))
    expect(gateTests.length, '找不到启动引导 / 隐私同意的分支（用例前提不成立）').toBeGreaterThanOrEqual(2)
    for (const t of gateTests) {
      expect(t, `闸门分支「${t}」没有被豁免变量守着`).toContain('gatesBypassed')
    }

    // 授权闸门的第二层在 LicenseGate 自己身上：它未授权就渲染解锁页。豁免若只跳过
    // 启动引导，界面会停在解锁页 —— 这条钉住「豁免时直接渲染主面板、不经 LicenseGate」。
    const branches = ifBranches(entryPath, entrySrc)
    const bypass = branches.filter((b) => b.test.trim() === 'gatesBypassed' && b.body.includes('WechatDataPanel'))
    expect(bypass.length, '豁免分支没有直接渲染 WechatDataPanel（会被 LicenseGate 的解锁页拦住）').toBe(1)
    expect(bypass[0]!.body, '豁免分支里不得再套 LicenseGate').not.toContain('LicenseGate')
    // 反面：正常路径仍必须由 LicenseGate 把关（别把闸门整个拆了）
    expect(entrySrc).toContain('<LicenseGate>')
  })

  it('调试横幅只认调试豁免：手机浏览器态不该挂一条「🛠 调试模式」', () => {
    // gatesBypassed 把「调试豁免」与「浏览器态」合并成了一个口径，但**横幅只该在前者出现**：
    // 手机上挂一条「已跳过启动引导 / 隐私同意 / 授权（仅非打包态生效）」既吓人又是假话
    // （那条文案里的 SUPERTIME_SKIP_ONBOARDING 在手机上根本没设过），还会让真机截图失去意义。
    const at = entrySrc.indexOf('debug-gates-banner')
    expect(at, 'ui-entry.tsx 里找不到调试横幅（用例前提不成立）').toBeGreaterThan(0)
    // 横幅那个 effect 的守卫必须是 `if (!skipGates) return`，不能是 gatesBypassed
    const guard = entrySrc.lastIndexOf('if (!skipGates) return', at + 400)
    expect(guard, '调试横幅的守卫被换成了 gatesBypassed（手机上会出现横幅）').toBeGreaterThan(0)
    expect(entrySrc, '横幅文案里应当仍然写明它只在非打包态生效').toContain('仅非打包态生效')
  })

  it('验收脚本改用豁免开关，且不再伪造隐私同意记录', () => {
    expect(acceptanceSrc).toContain("SUPERTIME_SKIP_ONBOARDING: '1'")
    // 伪造思路的两个特征（写 localStorage 的 init script、reload 让 React 重读）都必须消失
    expect(acceptanceSrc).not.toContain('privacy-consent')
    expect(acceptanceSrc).not.toContain('addInitScript')
    // 而且要有断言证明豁免真的生效（否则开关坏了脚本照样绿）
    expect(acceptanceSrc).toContain("#debug-gates-banner")
  })
})

/**
 * H7 的「永不回包」注入（`SUPERTIME_DEBUG_HANG_METHODS`）。
 *
 * 它存在的唯一理由是**验收**：让某个 Remote 调用真的悬挂到主进程超时，
 * 才能端到端回答「界面会不会无限转圈」（脚本见 `scripts/loading-recovery-e2e.mjs`）。
 * 与豁免开关同一套信任模型 —— 打包态一律不生效：判定函数返回空表，
 * 主进程还会**显式删掉**该变量再 fork，worker 连继承都继承不到。
 */
describe('H7：永不回包注入的判定与接线（打包态恒不生效）', () => {
  const workerSrc = readFileSync(join(ROOT, 'src', 'backend', 'wechat-worker.js'), 'utf8')
  const e2eSrc = readFileSync(join(ROOT, 'scripts', 'loading-recovery-e2e.mjs'), 'utf8')

  it('打包态（含 isPackaged 缺失/类型不对）⇒ 恒为空表', () => {
    expect(HANG_ENV).toBe('SUPERTIME_DEBUG_HANG_METHODS')
    for (const bogus of [true, undefined, null, 'false', 0, 1, {}]) {
      expect(
        resolveHangMethods({ isPackaged: bogus, env: { SUPERTIME_DEBUG_HANG_METHODS: 'getSessions' } }),
        `isPackaged=${JSON.stringify(bogus)} 时不应注入`,
      ).toEqual([])
    }
    expect(resolveHangMethods()).toEqual([])
  })

  it('非打包态 ⇒ 逗号分隔、去空白、去空项；未设 ⇒ 空表', () => {
    expect(resolveHangMethods({ isPackaged: false, env: { SUPERTIME_DEBUG_HANG_METHODS: ' getSessions , queryContacts ,' } }))
      .toEqual(['getSessions', 'queryContacts'])
    expect(resolveHangMethods({ isPackaged: false, env: {} })).toEqual([])
    expect(resolveHangMethods({ isPackaged: false, env: { SUPERTIME_DEBUG_HANG_METHODS: '' } })).toEqual([])
  })

  it('主进程取名单也用 app.isPackaged，且给 worker 的 env「有则写、无则删」', () => {
    const calls = callExpressions('main.js', mainSrc).filter((c) => c.callee === 'resolveHangMethods')
    expect(calls.length, 'main.js 里找不到 resolveHangMethods(...) 的真实调用点').toBeGreaterThan(0)
    for (const c of calls) {
      // 监管器用注入进来的 isPackaged；注入点仍必须在组合根直接读 Electron 的 app.isPackaged。
      expect(c.args.join(','), '监管器的名单判定必须使用注入的 isPackaged 与 env')
        .toContain('isPackaged')
    }
    const supervisorWiring = callExpressions('main.js', mainSrc)
      .filter((c) => c.callee === 'createBackendSupervisor')
    expect(supervisorWiring.length, '组合根没有创建后端监管器').toBeGreaterThan(0)
    expect(supervisorWiring[0]!.args.join(','), 'isPackaged 的取值必须来自 Electron 的 app.isPackaged')
      .toContain('isPackaged: app.isPackaged')
    // fork 必须收到 env；打包态走 delete 分支（不是「不设置」—— 否则会继承到父进程的同名变量）
    const fork = callExpressions('main.js', mainSrc).filter((c) => c.callee === 'utilityProcess.fork')
    expect(fork.length, '找不到 utilityProcess.fork 调用点（用例前提不成立）').toBe(1)
    expect(fork[0]!.args.join(','), 'fork 没有把 workerEnv 交给子进程').toContain('env: workerEnv')
    expect(mainSrc).toMatch(/if \(hangMethods\.length > 0\) workerEnv\[DEBUG_HANG_ENV\]/)
    expect(mainSrc, '打包态必须显式删除该变量').toContain('delete workerEnv[DEBUG_HANG_ENV]')
  })

  it('worker 命中名单时不回包（客户端才会走到超时），且判定在回包之前', () => {
    expect(workerSrc).toContain('SUPERTIME_DEBUG_HANG_METHODS')
    const at = workerSrc.indexOf("case 'call'")
    expect(at, 'worker 里找不到 call 分支（用例前提不成立）').toBeGreaterThan(0)
    const body = workerSrc.slice(at, at + 700)
    const gate = body.indexOf('HANG_METHODS.includes')
    const post = body.indexOf('post({ id, value: await backend.call')
    expect(gate, 'call 分支里没有注入判定 —— 注入形同虚设').toBeGreaterThan(0)
    expect(post, 'call 分支里找不到回包点（用例前提不成立）').toBeGreaterThan(0)
    expect(gate, '注入判定必须在回包之前').toBeLessThan(post)
  })

  it('验收脚本把注入与超时都压到秒级，并断言「注入真的命中过」', () => {
    expect(e2eSrc).toContain('SUPERTIME_DEBUG_HANG_METHODS')
    expect(e2eSrc).toContain('SUPERTIME_CALL_TIMEOUT_MS')
    // 防空转：脚本必须读日志确认注入与超时都发生过（否则界面出错也可能是别的原因）
    expect(e2eSrc).toContain('注入「永不回包」')
    expect(e2eSrc).toMatch(/日志|app\.log/)
  })
})
