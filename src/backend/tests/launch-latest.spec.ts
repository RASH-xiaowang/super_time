/**
 * 「启动最新版」启动器的纯逻辑判据（2026-10-21）。
 *
 * 为什么值得测：这族坏法全是**安静**的 —— 源码比产物新却跳过构建，
 * 表现就是"我明明改了、启动的还是旧界面"；而参数解析坏了会让 `--no-launch` 自检失效。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildReasonText, launchBanner, needsBuild, parseLauncherArgs } from '../../../scripts/launch-latest-lib.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

describe('parseLauncherArgs', () => {
  it('识别四个开关，默认全关', () => {
    expect(parseLauncherArgs([])).toEqual({ noLaunch: false, skipBuild: false, forceBuild: false, noKill: false, verbose: false })
    expect(parseLauncherArgs(['--no-launch', '--force-build'])).toMatchObject({ noLaunch: true, forceBuild: true })
    expect(parseLauncherArgs(['--skip-build', '--no-kill', '--verbose'])).toMatchObject({ skipBuild: true, noKill: true, verbose: true })
  })
})

describe('needsBuild：宁可多构建一次，也不能跑旧代码', () => {
  it('产物缺失 / 强制 ⇒ 构建', () => {
    expect(needsBuild({ sourceNewestMs: 1, productOldestMs: 0 })).toEqual({ build: true, reason: 'missing-product' })
    expect(needsBuild({ sourceNewestMs: 1, productOldestMs: 2, force: true })).toEqual({ build: true, reason: 'force' })
  })

  it('源码比产物新 ⇒ 构建；产物更新 ⇒ 跳过', () => {
    expect(needsBuild({ sourceNewestMs: 20, productOldestMs: 10 })).toEqual({ build: true, reason: 'source-newer' })
    expect(needsBuild({ sourceNewestMs: 10, productOldestMs: 20 })).toEqual({ build: false, reason: 'up-to-date' })
    expect(needsBuild({ sourceNewestMs: 20, productOldestMs: 20 })).toEqual({ build: false, reason: 'up-to-date' })
  })

  it('--skip-build 优先（调试用），且 API 不会把 0 当合法产物时间', () => {
    expect(needsBuild({ skip: true, force: true, productOldestMs: 0 })).toEqual({ build: false, reason: 'skip-build' })
    expect(needsBuild({ sourceNewestMs: 5, productOldestMs: Number.NaN }).build).toBe(true)
  })

  it('原因文案能落到人话（构建日志里要看得出为什么）', () => {
    expect(buildReasonText({ build: true, reason: 'source-newer' })).toContain('源码比产物新')
    expect(buildReasonText({ build: false, reason: 'up-to-date' })).toContain('跳过构建')
  })
})

describe('launchBanner：一眼看出跑的是哪个提交', () => {
  it('带分支/SHA/脏计数', () => {
    const text = launchBanner({ branch: 'perf/x', sha: 'abc1234', dirty: 2, build: '重建' })
    expect(text).toContain('perf/x @ abc1234')
    expect(text).toContain('未提交改动 2 个')
    expect(text).toContain('重建')
    expect(launchBanner({})).toContain('(detached)')
  })
})

describe('接线守卫：启动器真的做了 构建/杀旧实例/启动', () => {
  it('脚本里有构建、单实例清理与 launch-app 入口；cmd 包装存在', () => {
    const launcher = readFileSync(join(ROOT, 'scripts', 'launch-latest.mjs'), 'utf8')
    expect(launcher).toContain("['run', 'build:all']")
    expect(launcher).toContain('killRunningInstances')
    expect(launcher).toContain("join(ROOT, 'scripts', 'launch-app.mjs')")
    expect(launcher).toContain('detached: true')
    expect(readFileSync(join(ROOT, 'Latest.cmd'), 'utf8')).toContain('node scripts\\launch-latest.mjs')
  })
})
