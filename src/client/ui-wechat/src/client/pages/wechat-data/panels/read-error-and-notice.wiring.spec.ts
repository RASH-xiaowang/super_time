// @vitest-environment node
/**
 * N1（前端半边）与 L20 最后一处的**接线守卫**（源码级）。
 *
 * 为什么是源码级：仓库没有组件/DOM 测试环境（jsdom / testing-library 都不在依赖里），
 * 「待办面板把『读取失败』与『空列表』分开显示」「Settings 的富提示走公共控制器」这两条
 * 在运行期没有可断言的观测面 —— 而它们恰恰是最容易被后续重构悄悄退回原样的地方
 * （L20 复审实测过：整文件退回改动前，全量用例零变红）。
 *
 * 能证明什么、不能证明什么：只保证**形状**。提示语是否真的 5s/12s 消失、读失败提示是否
 * 真的渲染出来，**没有浏览器验证**（`timers.spec.ts` 覆盖的是控制器原语，不是接线）。
 *
 * 匹配花括号时用 `[^}]` 限制在同一层（`[\s\S]*?` 会跨过内层 `}` 而误报）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readSettingsSource } from './settings-source.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 去注释后读源码（注释里会提到旧写法，不能让断言误判）。 */
function readCode(file: string): string {
  // M21：设置面板已拆成多份 —— 前缀匹配（不区分大小写）读联合。
  // 注意联合也要走下面的**去注释**：第一版在这里直接 return，注释里那句
  // 「改前是 `setMessage(x); setTimeout(() => setMessage(null), N)`」当场把反例断言打红。
  const raw = /^settings(-[a-z-]+)?\.tsx?$/i.test(file)
    ? readSettingsSource()
    : readFileSync(join(HERE, file), 'utf8')
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

describe('N1：待办面板区分「读取失败」与「确无数据」', () => {
  const code = readCode('Tasks.tsx')

  it('把 readError 收进状态，并且只在**没读错**时写渲染缓存', () => {
    expect(code).toContain('setReadError(r.readError ?? null)')
    expect(code).toMatch(/if \(!r\.readError\) writeRenderCache\('tasks', r\.items\)/)
    // 旧写法：无条件写缓存 —— 会把「读不到」的空列表存成下次的首帧「暂无待办」
    expect(code).not.toMatch(/^\s*writeRenderCache\('tasks', r\.items\)$/m)
  })

  it('读取失败有独立提示，空列表文案不会在失败时出现', () => {
    expect(code).toMatch(/\{readError && \(/)
    expect(code).toContain('待办库读取失败')
    // 防空转：空状态必须带 !readError 这道闸（否则失败时仍显示「暂无待办」）
    expect(code).toMatch(/!loading && tasks\.length === 0 && !error && !readError && <EmptyState/)
  })
})

describe('L20：Settings 的富提示迁到公共控制器', () => {
  const code = readCode('Settings.tsx')

  it('走公共 hook（泛型值 = 富提示对象），时长两档按改前原样保留', () => {
    expect(code).toContain("from './hooks.tsx'")
    expect(code).toContain('useTransientNotice<Notice>(5000)')
    expect(code).toMatch(/flash\(\{ kind, text,/)
    expect(code).toContain('rich ? 12000 : 5000')
  })

  it('手写的定时器与 setMessage 已全部消失', () => {
    // 旧写法：句柄丢了 —— 连出两条提示时第一条的定时器会把第二条提前清掉，卸载后还会写 state
    expect(code).not.toMatch(/setTimeout\(\s*\(\)\s*=>\s*\{?\s*setMessage\(null\)/)
    expect(code).not.toContain('setMessage(')
    // 关闭按钮改为控制器清空（不然关闭后定时器仍会把槽位再清一次）
    expect(code).toContain('onClick={() => { clear() }}')
  })
})
