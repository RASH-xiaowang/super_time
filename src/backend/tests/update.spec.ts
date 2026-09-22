/**
 * 自动更新：状态机 / 服务行为 / 接线守卫。
 *
 * ## 为什么这些用例值得存在
 *
 * 更新链路的失效方式几乎都是**静默**的：打包时漏了 `build.publish`，
 * `resources/app-update.yml` 就不生成，安装版每次检查都报一句英文的
 * `ENOENT ... app-update.yml`；渲染层少接一条 `update:*` 通道，界面就永远停在
 * 「尚未检查」。这些都不会让应用起不来，只会让**升级永远不发生** —— 而
 * 「升级不发生」恰恰是最不容易被发现的 bug（用户以为自己在用最新版）。
 *
 * ## 分三层，都是行为判定
 *
 *   ① 纯函数：事件 → 状态的收敛（含进度钳位、说明截断、错误翻译）；
 *   ② 服务行为：注入假 autoUpdater（EventEmitter），断言「什么时候才真的出网」、
 *      「重复点击会不会并发下载」、「没下载完能不能装」；
 *   ③ 接线：main.js / preload.js / package.json / 设置面板里那几行**真的存在**，
 *      且取值来自该来的地方（AST 只认真实调用点，注释掉不算 —— M12/N19/N20 反复栽的坑）。
 *
 * ## 守得住什么、守不住什么（如实标注）
 *
 *   · **守得住**：状态迁移、去重与节流、错误翻译、IPC/发布源的接线存在性；
 *   · **守不住**：真的从 GitHub Releases 拉一次 latest.yml 并把包装上 —— 那需要
 *     一个真实发布过的 tag 与安装版产物（本轮无），所以「更新能装成功」的证据是
 *     「状态机 + 接线 + electron-updater 的默认安装路径」，不是端到端实机升级。
 *
 * @vitest-environment node
 */
import { EventEmitter } from 'node:events'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import {
  DISABLE_UPDATE_CHECK_ENV, applyUpdateEvent, blankUpdateState,
  createUpdateService, describeUpdateError, normalizeProgress, normalizeReleaseNotes,
} from '../update.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const mainSrc = readFileSync(join(ROOT, 'main.js'), 'utf8')
const preloadSrc = readFileSync(join(ROOT, 'preload.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as any
const settingsDir = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels')
// M21 第二十七刀把「软件更新」区块搬进 settings-sections.tsx ⇒ 读**面板 + 它的拆分模块**的联合
// （断言一条没改；更新区块搬到哪份都算数）。用 readdir 而不是手写清单，下次再拆不必回来补名字。
const settingsSrc = readdirSync(settingsDir)
  .filter((f) => /^settings-[a-z-]+\.tsx$/.test(f))
  .concat(['Settings.tsx'])
  .sort()
  .map((f) => readFileSync(join(settingsDir, f), 'utf8')).join('\n')

/** 收集源码里所有真实 `CallExpression`，键是「被调表达式的源码文本」。 */
function callExpressions(file: string, src: string): Array<{ callee: string; args: string[] }> {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JS
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind)
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

/** 一个够用的假 autoUpdater：EventEmitter + 被调用次数计数。 */
function fakeUpdater() {
  const e: any = new EventEmitter()
  e.autoDownload = false
  e.autoInstallOnAppQuit = false
  e.logger = null
  e.checks = 0
  e.installs = []
  e.checkForUpdates = () => { e.checks += 1; return Promise.resolve(null) }
  e.quitAndInstall = (silent: boolean, forceRunAfter: boolean) => { e.installs.push([silent, forceRunAfter]) }
  return e
}

/** 建一个「打包态 + 有 autoUpdater + 没设禁用环变量」的服务。 */
function serviceFor(updater: any, over: Record<string, unknown> = {}) {
  const broadcasts: any[] = []
  const svc = createUpdateService({
    autoUpdater: updater,
    isPackaged: true,
    currentVersion: '1.0.0',
    env: {},
    onState: (s: any) => broadcasts.push(s),
    ...over,
  })
  return { svc, broadcasts }
}

afterEach(() => { vi.useRealTimers() })

describe('纯函数：事件 → 状态', () => {
  it('checking 记下 manual，并清掉上一次的进度与错误', () => {
    const dirty = { ...blankUpdateState('1.0.0'), phase: 'error', error: '旧的', progress: { percent: 40 } }
    const s = applyUpdateEvent(dirty, { type: 'checking', manual: true, at: '2026-01-01T00:00:00.000Z' })
    expect(s.phase).toBe('checking')
    expect(s.manual).toBe(true)
    expect(s.error).toBeNull()
    expect(s.progress).toBeNull()
    expect(s.checkedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('available 带上版本与说明', () => {
    const s = applyUpdateEvent(blankUpdateState('1.0.0'), {
      type: 'available',
      info: { version: '1.2.0', releaseName: 'Super Time 1.2.0', releaseNotes: '修复了若干问题', releaseDate: '2026-02-01T00:00:00.000Z' },
    })
    expect(s.phase).toBe('available')
    expect(s.version).toBe('1.2.0')
    expect(s.releaseName).toBe('Super Time 1.2.0')
    expect(s.releaseNotes).toBe('修复了若干问题')
    expect(s.releaseDate).toBe('2026-02-01T00:00:00.000Z')
  })

  it('not-available 必须抹掉版本与说明（否则界面上留着上一次的版本号）', () => {
    const withVersion = applyUpdateEvent(blankUpdateState('1.0.0'), { type: 'available', info: { version: '1.2.0', releaseNotes: 'x' } })
    const s = applyUpdateEvent(withVersion, { type: 'not-available', info: { version: '1.0.0' } })
    expect(s.phase).toBe('up-to-date')
    expect(s.version).toBeNull()
    expect(s.releaseNotes).toBeNull()
  })

  it('progress 把 percent 钳到 [0,100]，非有限数值字段置 null', () => {
    const s = applyUpdateEvent(blankUpdateState('1.0.0'), {
      type: 'progress',
      progress: { percent: 137.5, transferred: 10, total: 100, bytesPerSecond: -1 },
    })
    expect(s.phase).toBe('downloading')
    expect(s.progress.percent).toBe(100)
    expect(s.progress.bytesPerSecond).toBeNull()
    expect(normalizeProgress(undefined).percent).toBe(0)
    expect(normalizeProgress({ percent: -20 }).percent).toBe(0)
  })

  it('downloaded 把进度钉在 100% 并保留版本', () => {
    const downloading = applyUpdateEvent(blankUpdateState('1.0.0'), { type: 'progress', progress: { percent: 42 } })
    const s = applyUpdateEvent(downloading, { type: 'downloaded', info: { version: '1.2.0' } })
    expect(s.phase).toBe('downloaded')
    expect(s.version).toBe('1.2.0')
    expect(s.progress.percent).toBe(100)
  })

  it('未知事件不改状态（防空转：别把默认分支写成「什么都清空」）', () => {
    const base = { ...blankUpdateState('1.0.0'), phase: 'downloading' }
    expect(applyUpdateEvent(base, { type: 'update-cancelled' })).toBe(base)
    expect(applyUpdateEvent(base, {})).toBe(base)
  })

  it('releaseNotes 支持数组形态（多版本差分 provider），并截断超长内容', () => {
    expect(normalizeReleaseNotes([{ version: '1.2.0', note: 'a' }, { version: '1.1.0', note: 'b' }]))
      .toBe('v1.2.0\na\n\nv1.1.0\nb')
    expect(normalizeReleaseNotes('   ')).toBeNull()
    expect(normalizeReleaseNotes(undefined)).toBeNull()
    const long = normalizeReleaseNotes('x'.repeat(5000))!
    expect(long.length).toBeLessThan(5000)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('纯函数：错误翻译（原始 message 直接给用户等于没说）', () => {
  it('缺 app-update.yml / 404 / 网络 / 校验 各有各的说法', () => {
    expect(describeUpdateError(new Error('ENOENT: no such file, open app-update.yml'))).toContain('build.publish')
    expect(describeUpdateError(new Error('HttpError: 404 Not Found'))).toContain('latest.yml')
    expect(describeUpdateError(new Error('getaddrinfo ENOTFOUND github.com'))).toContain('网络不可达')
    expect(describeUpdateError(new Error('sha512 checksum mismatch'))).toContain('校验失败')
  })

  it('认不出来就原样回传，不吞消息', () => {
    expect(describeUpdateError(new Error('boom'))).toBe('boom')
    expect(describeUpdateError(undefined)).toBe('未知错误')
  })
})

describe('服务行为：什么时候才真的出网', () => {
  it('打包态 + 支持 ⇒ 真的调 checkForUpdates，并先进入 checking', async () => {
    const up = fakeUpdater()
    const { svc, broadcasts } = serviceFor(up)
    expect(svc.isSupported()).toBe(true)
    const s: any = await svc.check({ manual: true })
    expect(up.checks).toBe(1)
    expect(s.phase).toBe('checking')
    expect(s.manual).toBe(true)
    expect(broadcasts.length).toBeGreaterThan(0)
  })

  it('**非打包态一律不出网**（开发态没有 app-update.yml）', async () => {
    const up = fakeUpdater()
    const { svc } = serviceFor(up, { isPackaged: false })
    const s: any = await svc.check({ manual: true })
    expect(up.checks, '开发态不该真的去拉更新').toBe(0)
    expect(s.phase).toBe('unsupported')
    expect(s.reason).toBe('dev')
  })

  it('显式禁用环变量 ⇒ 不出网，且原因可与「开发态」区分', async () => {
    const up = fakeUpdater()
    const { svc } = serviceFor(up, { env: { [DISABLE_UPDATE_CHECK_ENV]: '1' } })
    expect(DISABLE_UPDATE_CHECK_ENV).toBe('SUPERTIME_DISABLE_UPDATE_CHECK')
    const s: any = await svc.check({ manual: true })
    expect(up.checks).toBe(0)
    expect(s.phase).toBe('unsupported')
    expect(s.reason).toBe('disabled')
  })

  it('electron-updater 加载失败 ⇒ 报 unavailable（发布事故要和正常现象分开）', async () => {
    const { svc } = serviceFor(null)
    expect(svc.isSupported()).toBe(false)
    const s: any = await svc.check({ manual: true })
    expect(s.phase).toBe('unsupported')
    expect(s.reason).toBe('unavailable')
  })

  it('**正在下载时再点检查 ⇒ 不再拉一次**（并发下载会写出损坏的安装包）', async () => {
    const up = fakeUpdater()
    const { svc } = serviceFor(up)
    await svc.check({ manual: true })
    up.emit('update-available', { version: '1.2.0' })
    up.emit('download-progress', { percent: 30 })
    expect((svc.getState() as any).phase).toBe('downloading')
    await svc.check({ manual: true })
    expect(up.checks, '下载中重复点击不该触发第二次 checkForUpdates').toBe(1)
  })

  it('checkForUpdates reject 且没发 error 事件 ⇒ 也要落到 error 状态', async () => {
    const up = fakeUpdater()
    up.checkForUpdates = () => { up.checks += 1; return Promise.reject(new Error('HttpError: 404')) }
    const { svc } = serviceFor(up)
    const s: any = await svc.check({ manual: true })
    expect(s.phase).toBe('error')
    expect(s.error).toContain('latest.yml')
  })

  it('autoDownload / autoInstallOnAppQuit 都打开（本轮选定的行为）', () => {
    const up = fakeUpdater()
    serviceFor(up)
    expect(up.autoDownload).toBe(true)
    expect(up.autoInstallOnAppQuit).toBe(true)
  })
})

describe('服务行为：下载进度节流', () => {
  it('同一整数百分点不重复推送，但阶段切换必推', async () => {
    const up = fakeUpdater()
    const { svc, broadcasts } = serviceFor(up)
    await svc.check({ manual: true })
    const before = broadcasts.length
    up.emit('update-available', { version: '1.2.0' })       // 阶段检查→可用：必推
    const afterAvailable = broadcasts.length
    expect(afterAvailable).toBeGreaterThan(before)

    // 同一整数百分点内的抖动（0.0 … 0.9）只应推第一次
    for (let i = 0; i < 10; i += 1) up.emit('download-progress', { percent: i / 10 })
    expect(broadcasts.length - afterAvailable).toBe(1)

    // 换到下一个整数百分点，推
    up.emit('download-progress', { percent: 1.0 })
    expect(broadcasts.length - afterAvailable).toBe(2)

    // 状态本身仍然是连续的（节流只影响推送，不影响事实）
    expect((svc.getState() as any).progress.percent).toBe(1)
  })

  it('100 次进度事件最多推 100 条（量级有上界，不会把 IPC 打满）', async () => {
    const up = fakeUpdater()
    const { svc, broadcasts } = serviceFor(up)
    await svc.check({ manual: true })
    for (let i = 0; i < 100; i += 1) up.emit('download-progress', { percent: i + Math.random() })
    expect(broadcasts.length).toBeLessThanOrEqual(102)
  })
})

describe('服务行为：安装闸门', () => {
  it('没下载完就点安装 ⇒ 拒绝，且绝不 quitAndInstall（否则应用会白退一次）', async () => {
    const up = fakeUpdater()
    const { svc } = serviceFor(up)
    await svc.check({ manual: true })
    up.emit('update-available', { version: '1.2.0' })
    const r = svc.install()
    expect(r.ok).toBe(false)
    expect(up.installs).toEqual([])
  })

  it('下载完成 ⇒ 安装，并让应用重启（silent=false 让用户看见安装器）', async () => {
    const up = fakeUpdater()
    const { svc } = serviceFor(up)
    await svc.check({ manual: true })
    up.emit('update-available', { version: '1.2.0' })
    up.emit('update-downloaded', { version: '1.2.0' })
    const r = svc.install()
    expect(r.ok).toBe(true)
    // quitAndInstall 排在下一个 tick：先把 IPC 响应发出去，再开始退出
    expect(up.installs).toEqual([])
    await new Promise((res) => setImmediate(res))
    expect(up.installs).toEqual([[false, true]])
  })

  it('dispose 之后事件不再改状态，定时器也不再触发', async () => {
    vi.useFakeTimers()
    const up = fakeUpdater()
    const { svc, broadcasts } = serviceFor(up, { autoCheckDelayMs: 1000 })
    svc.scheduleAutoCheck()
    svc.dispose()
    await vi.advanceTimersByTimeAsync(5000)
    expect(up.checks, 'dispose 之后不该再自动检查').toBe(0)
    const n = broadcasts.length
    up.emit('update-available', { version: '1.2.0' })
    expect(broadcasts.length, 'dispose 之后监听器应已摘掉').toBe(n)
  })

  it('scheduleAutoCheck 在不支持时把状态摆正（界面挂载就能问到原因，而不是停在 idle）', () => {
    const up = fakeUpdater()
    const { svc } = serviceFor(up, { isPackaged: false, autoCheckDelayMs: 0 })
    svc.scheduleAutoCheck()
    const s: any = svc.getState()
    expect(s.phase).toBe('unsupported')
    expect(s.reason).toBe('dev')
    expect(up.checks).toBe(0)
  })

  it('scheduleAutoCheck 延迟到点后才检查，且只排一次', async () => {
    vi.useFakeTimers()
    const up = fakeUpdater()
    const { svc } = serviceFor(up, { autoCheckDelayMs: 30_000 })
    svc.scheduleAutoCheck()
    svc.scheduleAutoCheck()      // 第二次应被 timer 挡住
    await vi.advanceTimersByTimeAsync(29_000)
    expect(up.checks).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(up.checks).toBe(1)
  })
})

describe('接线守卫：真实存在、且取值来自该来的地方', () => {
  it('main.js 懒加载 electron-updater 且加载失败不致命', () => {
    const calls = callExpressions('main.js', mainSrc)
    const create = calls.filter((c) => c.callee === 'createUpdateService')
    expect(create.length, 'main.js 里找不到 createUpdateService(...) 的真实调用点').toBeGreaterThan(0)
    // 实参里必须真的把 autoUpdater 传进去（忘了传 = 服务永远报 unavailable）
    expect(create[0]!.args.join(',')).toContain('autoUpdater')
    // 加载必须是 require('electron-updater')，且出现在 try 里（它失败不能拖垮启动）
    expect(mainSrc).toContain("require('electron-updater')")
    const at = mainSrc.indexOf("require('electron-updater')")
    const before = mainSrc.slice(Math.max(0, at - 400), at)
    expect(before, 'electron-updater 的 require 必须包在 try/catch 里').toContain('try {')
    expect(mainSrc.slice(at, at + 400)).toContain('catch')
  })

  it('三个 update: 通道都注册了，且 check 的 manual 由渲染层传、可信性由主进程决定', () => {
    for (const ch of ['update:state', 'update:check', 'update:install']) {
      expect(mainSrc, `main.js 里没有注册 ${ch}`).toContain(`ipcMain.handle('${ch}'`)
    }
    const at = mainSrc.indexOf("ipcMain.handle('update:check'")
    const handler = mainSrc.slice(at, at + 700)
    expect(handler, 'update:check 必须把 manual 传给服务').toContain('manual')
    // 渲染层不得把「要不要出网」的判定塞进来
    expect(handler).not.toContain('isPackaged')
  })

  it('更新状态在建窗后安排自检，并在退出前 dispose', () => {
    const schedule = mainSrc.indexOf('updateService.scheduleAutoCheck()')
    const createWindow = mainSrc.indexOf('\n  createWindow();')
    expect(createWindow, '找不到 createWindow() 的调用点').toBeGreaterThan(0)
    expect(schedule, 'main.js 没有安排自动检查 —— 更新永远不会发生').toBeGreaterThan(createWindow)
    const quit = mainSrc.indexOf("app.on('before-quit'")
    expect(quit).toBeGreaterThan(0)
    expect(mainSrc.slice(quit), 'before-quit 里没有 dispose 更新服务').toContain('updateService.dispose()')
  })

  it('preload 暴露 update 命名空间（含 state / check / install / onEvent）', () => {
    expect(preloadSrc).toMatch(/update:\s*\{/)
    for (const m of ["invoke('update:state')", "invoke('update:check'", "invoke('update:install')", "'update:event'"]) {
      expect(preloadSrc, `preload 里找不到 ${m}`).toContain(m)
    }
    // onEvent 必须返回退订函数，否则设置面板反复开关会累积监听器
    expect(preloadSrc).toMatch(/removeListener\('update:event'/)
  })

  it('发布源与版本号都齐（缺 publish 就不生成 app-update.yml，更新永远报 ENOENT）', () => {
    expect(Array.isArray(pkg.build?.publish), 'package.json 里没有 build.publish').toBe(true)
    const pub = pkg.build.publish[0]
    expect(pub.provider).toBe('github')
    expect(typeof pub.owner).toBe('string')
    expect(pub.owner.length).toBeGreaterThan(0)
    expect(typeof pub.repo).toBe('string')
    expect(pub.repo.length).toBeGreaterThan(0)
    expect(typeof pkg.dependencies?.['electron-updater'], 'electron-updater 必须是**生产**依赖（devDependencies 不会进包）').toBe('string')
    expect(pkg.build.files, '打包 files 白名单里应含 electron-updater（显式列出，不依赖隐式包含）')
      .toEqual(expect.arrayContaining(['node_modules/electron-updater/**/*']))
    // 更新包本体也要能被 electron-updater 找到：NSIS 目标 + 版本号
    expect(pkg.build.win.target[0].target).toBe('nsis')
    expect(typeof pkg.version).toBe('string')
  })

  it('设置面板里有「软件更新」入口，且指向 update 这一节', () => {
    expect(settingsSrc, 'Settings.tsx 里找不到软件更新区块').toContain('function UpdateSection')
    expect(settingsSrc).toContain("key: 'update'")
    // 2026-09 起左导航从「切节（右侧一次只渲染一节）」改成「目录（各节全部堆叠 +
    // 高亮跟随滚动）」，旧的字面量门禁 `activeKey !== 'update'` 因此不复存在。
    // 等价的不变量有两条：① update 节在页面上真的有锚点（否则点了也滚不到），
    // ② 导航项与节之间的对应由 `activeKey === it.key` 驱动（否则列表只是一张死目录）。
    expect(settingsSrc, 'update 节没有渲染锚点，导航点了也滚不到').toContain('data-settings-section="update"')
    expect(settingsSrc, 'update 节没有挂上 UpdateSection').toMatch(/data-settings-section="update"[^>]*>\s*<UpdateSection/)
    expect(settingsSrc, '导航高亮/定位没接 activeKey —— 左栏会变成一张死目录').toContain('activeKey === it.key')
    // NavKey 联合类型里也要有，否则 activeKey 的比较会被 TS 判成永不相等
    expect(settingsSrc).toMatch(/'license'\s*\|\s*'update'/)
    // 区块里的按钮必须真的调 electronAPI.update
    expect(settingsSrc).toContain('electronAPI?.update')
    expect(settingsSrc).toContain('api.check({ manual: true })')
  })
})
