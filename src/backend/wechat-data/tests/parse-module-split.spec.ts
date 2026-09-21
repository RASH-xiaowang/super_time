/**
 * M21 的拆分守卫：`parse.ts` 拆成 5 个模块之后，**依赖只能往下走**（不许出现环）。
 *
 * 为什么要有这条：拆分的价值一半在「文件小」，另一半在「层次清楚」。如果 `parse-xml.ts`
 * 反过来 import `parse-rich.ts`，环不会让测试变红 —— 只会在下一次改动时变成难以定位的
 * 初始化顺序问题（`api-module-split.spec.ts` 对 api.ts 那片拆分立了同样的闸门）。
 *
 * 另一个方向也钉住：**本体 `parse.ts` 必须继续对外转发**（外部 3 处 import 走的是 `./parse.ts`），
 * 而且这些转发里的名字必须真的还存在 —— 否则某次「清理未用导出」会静默打断外部调用方。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const dir = join(HERE, '..', 'src', 'query')

/**
 * 取一个模块里 import / 转发 的 **parse 家族**兄弟模块（相对路径 `./parse-*.ts`）。
 * @param module - 模块文件名。
 * @returns 被引用的兄弟模块名（去重、字典序）。
 */
function siblingImports(module: string): string[] {
  // 先剥注释：文件里「说明性」地提到 `from './parse.ts'` 不算 import（第一版守卫就栽在这）
  const raw = readFileSync(join(dir, module), 'utf8')
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
  const names = [...src.matchAll(/from '\.\/(parse(?:-[a-z]+)?\.ts)'/g)].map((m) => m[1] ?? '')
  return [...new Set(names)].sort()
}

describe('M21：parse 拆分的依赖方向', () => {
  it('底层模块不反向 import 上层（无环）', () => {
    expect(siblingImports('parse-xml.ts'), 'parse-xml 是最底层').toEqual([])
    expect(siblingImports('parse-call.ts'), 'parse-call 是自足的，不该依赖兄弟模块').toEqual([])
    expect(siblingImports('parse-system.ts'), 'parse-system 只许依赖 parse-xml').toEqual(['parse-xml.ts'])
    for (const s of siblingImports('parse-rich.ts')) {
      expect(['parse-xml.ts', 'parse-call.ts', 'parse-system.ts'], `parse-rich 不许 import ${s}`).toContain(s)
    }
  })

  it('本体 parse.ts 继续对外转发（外部调用方不用改 import 路径）', () => {
    const body = readFileSync(join(dir, 'parse.ts'), 'utf8')
    for (const name of ['parseMessageContent', 'parseSystemMessage', 'classifyRender', 'RENDER_LABEL', 'parseAtUsernames', 'richPlaceholder']) {
      expect(body, `parse.ts 少了对外可见的 ${name}`).toContain(name)
    }
    expect(body, 'parse.ts 应当从拆出的模块再导出').toMatch(/export \{[^}]*\} from '\.\/parse-/s)
  })

  it('防空转：拆出的模块都在且都真的被 parse.ts 用到（免得守卫读了个空文件也算过）', () => {
    const body = readFileSync(join(dir, 'parse.ts'), 'utf8')
    for (const m of ['parse-xml.ts', 'parse-rich.ts', 'parse-system.ts']) {
      expect(body, `parse.ts 没有用到 ${m}`).toContain(`from './${m}'`)
    }
    for (const m of ['parse-xml.ts', 'parse-call.ts', 'parse-rich.ts', 'parse-system.ts']) {
      expect(readFileSync(join(dir, m), 'utf8').length, `${m} 不该是空文件`).toBeGreaterThan(500)
    }
  })
})
