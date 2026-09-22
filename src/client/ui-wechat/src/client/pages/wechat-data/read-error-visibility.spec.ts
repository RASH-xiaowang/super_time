/**
 * 「读失败」不许被显示成「没有数据」（N1 的收尾守卫）。
 *
 * 后端把「库打不开 / 读失败」与「确实没有条目」分成两件事：快照里带 `readError` 就是前者。
 * 但这个字段**只有面板真的去读它**才有意义 —— 忘了读，用户看到的就是一个空列表，
 * 而真实原因是数据根损坏/没解密（第 47 轮勘测 `chats.module.css` 时顺手发现这条判据只有零散的
 * 面板级用例，没有全局网）。
 *
 * 本用例不靠人工维护清单，而是**从类型推**：
 *   ① 后端哪些快照类型带 `readError`；
 *   ② api 层（`api-*.ts`）里哪些导出函数的返回类型是它们（面板调的是这层的包装）；
 *   ③ 调用这些方法的面板文件必须自己提到 `readError`。
 * 新接一个带 `readError` 的快照却忘了显示 ⇒ 这里会红。
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKEND_TYPES = join(HERE, '..', '..', '..', '..', '..', '..', 'backend', 'wechat-data', 'src')
const PANELS = join(HERE, 'panels')

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

/** ① 带 readError 的后端类型名。 */
function typesWithReadError(): string[] {
  const files = readdirSync(BACKEND_TYPES).filter((f) => /^types(-[a-z-]+)?\.ts$/.test(f))
  const out = new Set<string>()
  for (const f of files) {
    for (const m of read(join(BACKEND_TYPES, f)).matchAll(/export interface (\w+)[\s\S]*?\n\}/g)) {
      if (/readError\??:/.test(m[0]) && m[1]) out.add(m[1])
    }
  }
  return [...out].sort()
}

/** ② api 层里**返回这些类型**的导出函数（面板调的是这层的包装，不是 `remote.*`）。 */
function apiWrappersReturning(names: string[]): Array<{ fn: string; type: string }> {
  const hits: Array<{ fn: string; type: string }> = []
  for (const f of readdirSync(HERE).filter((x) => /^api(-[a-z-]+)?\.ts$/.test(x))) {
    for (const m of read(join(HERE, f)).matchAll(/export async function (\w+)\s*\([\s\S]*?\)\s*:\s*Promise<(\w+)>/g)) {
      if (m[1] && m[2] && names.includes(m[2])) hits.push({ fn: m[1], type: m[2] })
    }
  }
  return hits.sort((a, b) => a.fn.localeCompare(b.fn))
}

/** ③ 面板文件（排除用例本身）。 */
function panelFiles(): string[] {
  return readdirSync(PANELS).filter((f) => f.endsWith('.tsx') && !f.includes('.spec.')).sort()
}

describe('N1：带 readError 的快照必须在面板里被区分显示', () => {
  const types = typesWithReadError()
  const wrappers = apiWrappersReturning(types)

  it('后端确实有带 readError 的快照类型，且 api 层有对应包装（防止判据空转）', () => {
    expect(types.length).toBeGreaterThan(0)
    expect(wrappers.length, 'api 层没有返回这些类型的函数 —— ② 的解析口径需要更新').toBeGreaterThan(0)
  })

  for (const { fn, type } of wrappers) {
    it(`${fn}()（${type}）的调用方面板读了 readError`, () => {
      // 面板是从 api 层**具名导入后裸调**（`apiGetKbFiles(...)`），不是 `remote.getKbFiles(...)`
      const callers = panelFiles()
        .filter((f) => new RegExp(`(?<![\\w$.])${fn}\\s*\\(`).test(read(join(PANELS, f))))
      expect(callers.length, `没有任何面板调用 ${fn}()；要么判据该更新，要么接口已死`).toBeGreaterThan(0)
      const blind = callers.filter((f) => !read(join(PANELS, f)).includes('readError'))
      expect(blind, `这些面板调了 ${fn}() 却没读 readError（读失败会被显示成空数据）：${blind.join(', ')}`).toEqual([])
    })
  }
})
