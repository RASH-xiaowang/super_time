/**
 * 局域网远程访问的**接线**判据：模块写对了不等于接上了。
 *
 * ## 为什么单独一份
 *
 * `http-server.spec.ts` 测的是「服务本身的行为对不对」，它用一个**夹具** deps 起服务。
 * 夹具测不到的是：`main.js` 到底有没有创建它、有没有在后端就绪后启动、有没有把后端事件
 * 转发给 SSE 客户端、退出时有没有停。这几条任意一条断掉，单测全绿而功能整体不生效 ——
 * 其中最要命的是**事件转发**：少了它，手机上所有面板都不会实时刷新（WAL 推送链断在
 * 主进程这一环），而界面看起来完全正常，只是「数据不动」，正是上一轮实时性事故的同款症状。
 *
 * 另一条同样要紧：`ipc-wechat.js` 与 HTTP 两条路必须**共用同一道闸门**（`call-gates.js`）。
 * 两边各写一份的话，最可能的漂法是 HTTP 那份少抄 `catch`，于是许可校验一抛异常就变成放行。
 * 所以这里既断言「HTTP 走了共用闸门」，也断言「ipc-wechat 里没有自己那份拷贝」。
 *
 * 判据一律走 **AST**（真调用表达式 / 真标识符顺序），不走文本搜索 ——
 * 文本搜索会被注释里的一句「这里要调 pushEvent」骗过（本仓已踩过三次同类坑）。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MAIN = join(ROOT, 'main.js')
const IPC = join(ROOT, 'src', 'backend', 'ipc-wechat.js')
const GATES = join(ROOT, 'src', 'backend', 'call-gates.js')
const SERVER = join(ROOT, 'src', 'backend', 'http-server.js')

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
}

/** 收集源码里**真实**的调用表达式名（`a.b(…)` → `a.b`，`f(…)` → `f`）。 */
function callNames(sf: ts.SourceFile): string[] {
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const t = node.expression
      if (ts.isIdentifier(t)) out.push(t.text)
      else if (ts.isPropertyAccessExpression(t)) out.push(t.getText(sf))
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return out
}

/**
 * 找形如 `name('literal')` 或 `x.name(…)` 的**第一个**调用的源码偏移。
 *
 * 为什么用偏移而不是「标识符序列」：`setBackendStatus('ready')` 里的 `'ready'` 是
 * **字符串字面量**而不是标识符，按标识符序列找会永远找不到（第一版就是这么红的）。
 * @param sf - 源文件。
 * @param name - 被调名（函数名，或属性访问的最后一段）。
 * @param firstArg - 若给出，要求第一个实参是这个字符串字面量。
 * @returns 偏移；找不到返回 -1。
 */
function firstCallAt(sf: ts.SourceFile, name: string, firstArg?: string): number {
  let at = -1
  const visit = (node: ts.Node): void => {
    if (at !== -1) return
    if (ts.isCallExpression(node)) {
      const t = node.expression
      const called = ts.isIdentifier(t) ? t.text : (ts.isPropertyAccessExpression(t) ? t.name.text : '')
      if (called === name) {
        if (firstArg === undefined) { at = node.getStart(sf); return }
        const a = node.arguments[0]
        if (a && ts.isStringLiteralLike(a) && a.text === firstArg) at = node.getStart(sf)
      }
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return at
}

/** 取一个具名函数（或箭头函数变量）的函数体文本；找不到返回 ''。 */
function bodyOf(sf: ts.SourceFile, name: string): string {
  let found = ''
  const visit = (node: ts.Node): void => {
    if (found !== '') return
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) {
      found = node.body.getText(sf)
      return
    }
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name
          && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
          && d.initializer.body) {
          found = d.initializer.body.getText(sf)
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return found
}

describe('主进程接线：服务真的被创建、启动、转发事件、停止', () => {
  const mainSf = parse(MAIN)
  const mainCalls = callNames(mainSf)
  const mainSrc = readFileSync(MAIN, 'utf8')

  it('哨兵：main.js 读到了，且这些模块真的存在', () => {
    expect(mainSrc.length).toBeGreaterThan(10000)
    expect(readFileSync(SERVER, 'utf8').length).toBeGreaterThan(1000)
    expect(readFileSync(GATES, 'utf8').length).toBeGreaterThan(1000)
  })

  it('创建了远程访问服务，且 gatedCall 走的是共用的那道闸门', () => {
    expect(mainCalls, 'main.js 没有创建远程访问服务').toContain('createRemoteAccessServer')
    expect(mainCalls, 'main.js 没有引入共用的闸门实现').toContain('gatedWechatCall')
    // gatedCall 必须委托给 gatedWechatCall —— 直接在 main.js 里手写一份闸门的话，
    // 「两条路共用一份实现」这个前提就没了。
    const createCall = mainSrc.slice(mainSrc.indexOf('createRemoteAccessServer({'))
    const wired = createCall.slice(0, createCall.indexOf('})'))
    expect(wired, 'gatedCall 没有接到 gatedWechatCall 上').toContain('gatedWechatCall(gateCtx')
  })

  it('服务的是 Electron 自己 loadFile 的**同一份**产物（手机与桌面不是两套代码）', () => {
    const at = mainSrc.indexOf('createRemoteAccessServer({')
    const block = mainSrc.slice(at, mainSrc.indexOf('})', at))
    expect(block, '没有把 ui-dist 交给静态服务').toContain("'src', 'client', 'ui-dist'")
    // 与 main-window.js 的 uiEntryHtml 指向同一目录，这里钉的是「同一个字符串形状」
    const mw = readFileSync(join(ROOT, 'src', 'backend', 'main-window.js'), 'utf8')
    expect(mw, 'main-window.js 里的产物目录口径变了，接线判据要跟着改').toContain('ui-dist')
  })

  it('后端事件同时转发给 SSE 客户端（少了这一条，手机上所有面板都不会实时刷新）', () => {
    const body = bodyOf(mainSf, 'broadcastWechatEvent')
    expect(body, '找不到 broadcastWechatEvent 的实现').not.toBe('')
    expect(body, '事件只发给了窗口、没发给手机浏览器').toContain('broadcastToWindows')
    expect(body, 'broadcastWechatEvent 里没有 pushEvent —— WAL 实时刷新链会断在主进程这一环')
      .toContain('pushEvent(name, args)')
  })

  it('后端就绪之后才按配置启动监听', () => {
    // main.js 里有两处 setBackendStatus('ready')（重启监管器一处、初始化收尾一处），
    // 这里要的是「存在一处 ready 排在启动监听之前」—— 启动监听读的是数据根下的配置，
    // 而数据根要等后端 init 完才解析得出来，排早了就读不到、永远不监听。
    const readyAt = firstCallAt(mainSf, 'setBackendStatus', 'ready')
    const syncAt = firstCallAt(mainSf, 'syncWithConfig')
    expect(readyAt, 'main.js 里没有 setBackendStatus("ready") 这一处').toBeGreaterThan(-1)
    expect(syncAt, 'main.js 没有调用 syncWithConfig —— 服务永远不会启动').toBeGreaterThan(-1)
    expect(syncAt, '监听排在了后端就绪之前（那时数据根还没解析出来，配置读不到）')
      .toBeGreaterThan(readyAt)
  })

  it('退出时停止监听（它是唯一对外的入口，退出就该立刻不再接受连接）', () => {
    const at = mainSrc.indexOf("app.on('before-quit'")
    expect(at, 'main.js 里没有 before-quit 回调').toBeGreaterThan(-1)
    const block = mainSrc.slice(at, at + 1600)
    expect(block, 'before-quit 里没有停止远程访问服务').toContain('remoteAccess.stop()')
  })

  it('界面改完设置能立即生效（不等 60 秒兜底复查）', () => {
    expect(mainSrc, '没有 remote-access:apply 这个 IPC，界面改完只能等定时器').toContain("'remote-access:apply'")
    expect(mainSrc).toContain("'remote-access:state'")
  })
})

describe('闸门只有一份实现：IPC 与 HTTP 共用 call-gates', () => {
  const ipcSf = parse(IPC)
  const gateSf = parse(GATES)

  it('ipc-wechat 的 wechat:call 委托给 gatedWechatCall，且**没有**自己那份闸门拷贝', () => {
    const ipcCalls = callNames(ipcSf)
    expect(ipcCalls, 'ipc-wechat 没有调用共用的闸门').toContain('gatedWechatCall')
    const ipcSrc = readFileSync(IPC, 'utf8')
    // 这几样只该出现在 call-gates.js 里。ipc-wechat 里再现一份 = 两边会各自漂。
    for (const own of ['authorizeCall', 'getLicenseStatus', 'LICENSE_CHECK_FAILED', 'BACKEND_NOT_READY']) {
      // 注释里提到是允许的（那是文档），所以只查**剥掉注释之后**的代码。
      const code = ipcSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      expect(code, `ipc-wechat.js 里又出现了自己那份闸门逻辑（${own}）—— 闸门只能有一份实现`)
        .not.toContain(own)
    }
  })

  it('call-gates 里三道闸齐全，且**校验自身异常时拒绝**而不是放行', () => {
    const src = readFileSync(GATES, 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const calls = callNames(gateSf)
    expect(calls, '闸门里没有等后端就绪那一步').toContain('awaitBackendReady')
    expect(code, '闸门里没有许可证授权').toContain('authorizeCall')
    expect(code, '闸门里没有 BACKEND_NOT_READY 这条错误码').toContain('BACKEND_NOT_READY')
    // 这一条是 2026-09 修过的洞：授权校验自己抛异常时，旧实现只 warn 一句就继续调用后端，
    // 等于「许可闸门一旦出异常就完全失效」。HTTP 那条路要是少抄这个 catch，洞就回来了。
    expect(code, '闸门里没有「校验异常即拒绝」那条分支').toContain('LICENSE_CHECK_FAILED')
    const catchAt = code.indexOf('catch (e)')
    const denyAt = code.indexOf('LICENSE_CHECK_FAILED')
    expect(catchAt, '找不到 catch 分支').toBeGreaterThan(-1)
    expect(denyAt, '拒绝分支不在 catch 里面（异常时仍然放行）').toBeGreaterThan(catchAt)
  })

  it('HTTP 侧：白名单判定在**调用后端之前**（被拒的方法不该在后端留下痕迹）', () => {
    const sf = parse(SERVER)
    const body = bodyOf(sf, 'handleCall')
    expect(body, '找不到 handleCall 的实现').not.toBe('')
    const policyAt = body.indexOf('isRemoteSafe(method)')
    const callAt = body.indexOf('gatedCall(')
    expect(policyAt, 'handleCall 里没有白名单判定').toBeGreaterThan(-1)
    expect(callAt, 'handleCall 里没有调用 gatedCall').toBeGreaterThan(-1)
    expect(policyAt, '白名单判定排在了调用后端之后 —— 顺序反了就等于没拦').toBeLessThan(callAt)
    // 排队闸也要在真实调用外面（否则并发上限形同虚设）
    expect(body.indexOf('queue.run('), 'handleCall 没有经过并发闸').toBeGreaterThan(-1)
    expect(body.indexOf('queue.run(')).toBeLessThan(callAt)
  })

  it('HTTP 侧：除 /api/auth 外的 /api/* 都要过会话校验', () => {
    const sf = parse(SERVER)
    const body = bodyOf(sf, 'onRequest')
    expect(body, '找不到路由实现').not.toBe('')
    const authAt = body.indexOf("urlPath === '/api/auth'")
    const guardAt = body.indexOf('authorized(req)')
    const apiAt = body.indexOf("urlPath.startsWith('/api/')")
    expect(authAt, '路由里没有 /api/auth 这一支').toBeGreaterThan(-1)
    expect(apiAt, '路由里没有 /api/* 的总入口').toBeGreaterThan(-1)
    expect(guardAt, '/api/* 分支里没有会话校验').toBeGreaterThan(-1)
    // 令牌端点必须排在会话校验之前（否则没人能登录），而其余 /api/* 必须排在其后
    expect(authAt).toBeLessThan(apiAt)
    expect(apiAt).toBeLessThan(guardAt)
  })

  it('启动条件要求**令牌非空**（老配置遗留的 api_enabled:true 不能把端口打开）', () => {
    const sf = parse(SERVER)
    const body = bodyOf(sf, 'start')
    expect(body, '找不到 start 的实现').not.toBe('')
    expect(body, '启动条件里没有「令牌非空」这一半 —— N24 之前那批用户的端口会被静默打开')
      .toMatch(/cfg\.enabled\s*\|\|\s*cfg\.token === ''|!cfg\.enabled \|\| cfg\.token === ''/)
    // 同一口径也要体现在 syncWithConfig（界面开关走的是它）
    const sync = bodyOf(sf, 'syncWithConfig')
    expect(sync, '找不到 syncWithConfig 的实现').not.toBe('')
    expect(sync, 'syncWithConfig 的「该不该跑」没把令牌算进去')
      .toMatch(/cfg\.enabled && cfg\.token !== ''/)
  })
})
