/**
 * N19：打包态下「路径存在」不等于「路径可用」。
 *
 * 打包后本 bundle 落在 `resources/app.asar/...` 内，Electron 的 fs 补丁让 `existsSync`
 * 对 asar 内路径照答不误，但 **写** 与 **child_process** 不吃这套 —— asar 内的文件没有
 * 磁盘位置。`voice.ts` 的 `silkDecoderBin()` 原先正是 `existsSync(candidate) → return
 * candidate`，于是打包版把一个 asar 内路径交给 `spawnSync`。复审实测同一个 exe：
 * 磁盘路径 `spawnSync status=1`（真执行）、asar 路径 `error.code=ENOENT`。
 *
 * 这条用例守三件事：① asar 内路径一律改写到 `app.asar.unpacked`；② 改写后那份不存在时
 * 返回 `''`（而不是把不可用的 asar 路径交出去，让 spawn 报一个与病因无关的 ENOENT）；
 * ③ 开发态（路径里没有 `app.asar`）行为不变。
 *
 * 打包布局用**临时目录里的真文件**模拟：建一个真名叫 `app.asar` 的目录让 `existsSync`
 * 为真，再建 `app.asar.unpacked` 放真正的可执行目标 —— 不需要 Electron。
 *
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { onDiskPath, unpackedAware } from '../src/asar-path.ts'
import { silkDecoderBin } from '../src/query/voice.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 每个场景一个独立临时根（根名刻意不含 app.asar，避免污染断言）。 */
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'n19-asar-'))
  scratch.push(root)
  return root
}

/** 在 root 下按相对路径建一个（内容无所谓的）文件。 */
function touch(root: string, ...segments: string[]): string {
  const p = join(root, ...segments)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, 'x', 'utf8')
  return p
}

describe('unpackedAware：只改归档内路径', () => {
  it('开发态路径原样返回（不含 app.asar）', () => {
    const dev = join('D:', 'repo', 'src', 'backend', 'wechat-data', 'resources', 'win32', 'x64', 'wx_silk.exe')
    expect(unpackedAware(dev)).toBe(dev)
  })

  it('归档内路径改写为 app.asar.unpacked 同位置', () => {
    const candidate = join('D:', 'app', 'resources', 'app.asar', 'src', 'backend', 'wx_silk.exe')
    expect(unpackedAware(candidate)).toBe(join('D:', 'app', 'resources', 'app.asar.unpacked', 'src', 'backend', 'wx_silk.exe'))
  })

  it('归档根自身也可改写（marker 在末尾的形态）', () => {
    const candidate = join('D:', 'app', 'resources', 'app.asar')
    expect(unpackedAware(candidate)).toBe(join('D:', 'app', 'resources', 'app.asar.unpacked'))
  })

  it('已经是 unpacked 的路径不再二次改写', () => {
    // 没有这条守卫时，改写会把 `app.asar.unpacked` 里的 marker 当前缀，产出
    // `app.asar.unpacked/.unpacked/...` 这种垃圾路径（N19 顺手修掉）。
    const already = join('D:', 'app', 'resources', 'app.asar.unpacked', 'src', 'wx_silk.exe')
    expect(unpackedAware(already)).toBe(already)
  })
})

describe('onDiskPath：只交出真实存在的磁盘文件', () => {
  it('开发态：文件存在就返回自身，缺失返回空串', () => {
    const root = newRoot()
    const real = touch(root, 'src', 'resources', 'wx_silk.exe')
    expect(onDiskPath(real)).toBe(real)
    expect(onDiskPath(join(root, 'src', 'resources', 'missing.exe'))).toBe('')
  })

  it('打包态且 asarUnpack 覆盖：返回 app.asar.unpacked 下那份', () => {
    const root = newRoot()
    // 存档内那份与解包那份都「存在」（前者靠 Electron 的 fs 补丁为真，这里用真目录模拟）
    const inArchive = touch(root, 'app.asar', 'src', 'resources', 'wx_silk.exe')
    const unpacked = touch(root, 'app.asar.unpacked', 'src', 'resources', 'wx_silk.exe')
    const got = onDiskPath(inArchive)
    expect(got).toBe(unpacked)
    expect(got.includes('app.asar.unpacked')).toBe(true)
  })

  it('打包态但 asarUnpack 漏了：返回空串，而不是那个跑不了的 asar 路径', () => {
    const root = newRoot()
    const inArchive = touch(root, 'app.asar', 'src', 'resources', 'wx_silk.exe')
    // 正是 N19 的现场：existsSync 说存在，spawn 却 ENOENT。改后宁可返回 ''，
    // 让上层报「打包资源缺失」，也不要制造一个与病因无关的 spawn 失败。
    expect(onDiskPath(inArchive)).toBe('')
  })
})

describe('silkDecoderBin：按真实布局走一遍（行为级，不是源码字符串）', () => {
  // 上一版这条守卫断言的是「源码里含 onDiskPath(candidate)」——复审指出它可绕过：
  // 把那行字符串留在**注释**里、底下仍用裸 existsSync，守卫照样绿而 bug 回来了。
  // 现在改为把 startDir 注进去，真的按两种布局各走一遍。
  const PIN = 'DSH_WECHAT_SILK_BIN'
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env[PIN]
    delete process.env[PIN]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[PIN]
    else process.env[PIN] = saved
  })

  /** 打包态布局：bundle 落在 `<root>/app.asar/src/backend/wechat-data/lib/`。 */
  function packaged(root: string, unpacked: boolean): { start: string; inArchive: string; outside: string } {
    const start = join(root, 'app.asar', 'src', 'backend', 'wechat-data', 'lib')
    mkdirSync(start, { recursive: true })
    const inArchive = touch(root, 'app.asar', 'src', 'backend', 'wechat-data', 'resources', 'win32', 'x64', 'wx_silk.exe')
    const outside = join(root, 'app.asar.unpacked', 'src', 'backend', 'wechat-data', 'resources', 'win32', 'x64', 'wx_silk.exe')
    if (unpacked) touch(root, 'app.asar.unpacked', 'src', 'backend', 'wechat-data', 'resources', 'win32', 'x64', 'wx_silk.exe')
    return { start, inArchive, outside }
  }

  it('打包态 + asarUnpack 覆盖：返回 app.asar.unpacked 下那份', () => {
    const root = newRoot()
    const { start, inArchive, outside } = packaged(root, true)
    // 场景必须是「危险」的那一种：归档里那份确实存在，裸 existsSync 会说「找到了」
    expect(existsSync(inArchive)).toBe(true)
    expect(silkDecoderBin(start)).toBe(outside)
  })

  it('打包态 + asarUnpack 漏了：返回空串，而不是归档内那个 spawn 不了的路径', () => {
    const root = newRoot()
    const { start, inArchive } = packaged(root, false)
    expect(existsSync(inArchive)).toBe(true)
    expect(silkDecoderBin(start)).toBe('')
  })

  it('开发态：返回真实磁盘路径，且不含 app.asar', () => {
    const root = newRoot()
    mkdirSync(join(root, 'src', 'backend', 'wechat-data', 'lib'), { recursive: true })
    const dev = touch(root, 'src', 'backend', 'wechat-data', 'resources', 'win32', 'x64', 'wx_silk.exe')
    const got = silkDecoderBin(join(root, 'src', 'backend', 'wechat-data', 'lib'))
    expect(got).toBe(dev)
    expect(got.includes('app.asar')).toBe(false)
  })

  it('布局里没有解码器：空串，而不是一个不存在的路径', () => {
    const root = newRoot()
    mkdirSync(join(root, 'src', 'backend', 'wechat-data', 'lib'), { recursive: true })
    expect(silkDecoderBin(join(root, 'src', 'backend', 'wechat-data', 'lib'))).toBe('')
  })

  it('env 钉住的路径优先返回（现场排查用）', () => {
    process.env[PIN] = 'D:\\pinned\\wx_silk.exe'
    expect(silkDecoderBin()).toBe('D:\\pinned\\wx_silk.exe')
  })
})
