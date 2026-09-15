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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { onDiskPath, unpackedAware } from '../src/asar-path.ts'

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

describe('接线守卫：silkDecoderBin 必须过 onDiskPath', () => {
  it('解析结果走 onDiskPath，且不再用裸 existsSync 判定', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    // 断言的是**调用点**：老写法 `existsSync(candidate)` 在源码里必须不再出现
    const source = readFileSync(join(here, '..', 'src', 'query', 'voice.ts'), 'utf8')
    expect(source).toContain('onDiskPath(candidate)')
    expect(source).not.toContain('existsSync(candidate)')
  })
})
