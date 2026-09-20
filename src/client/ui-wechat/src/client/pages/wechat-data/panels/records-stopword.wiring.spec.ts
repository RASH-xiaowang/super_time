/**
 * 记录页签：类型词停用词清单必须两边一致。
 *
 * 后端 `query/records.ts` 的 `isRecordTypeStopword` 会**故意忽略**「转账 / 红包」这类词
 * （它们是数据源的名字，拿去当关键词会把结果清空）。前端 `Records.tsx` 为了让用户看懂
 * 「为什么输了词却没筛选」，也存了一份同样的清单。
 *
 * 两份清单必须逐项相等：后端加词而前端没跟 ⇒ 界面不提示；前端多词 ⇒ 明明筛了却提示没筛。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const BACKEND = join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'records.ts')
const FRONTEND = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels', 'Records.tsx')

/** 从一个 TS 源码块里抽出所有单引号字符串。 */
function stringsOf(block: string): string[] {
  return [...block.matchAll(/'([^']*)'/g)].map(m => m[1])
}

/** 抓 `function isRecordTypeStopword` 里 return 的那个数组字面量。 */
function backendWords(src: string): string[] {
  const m = src.match(/function isRecordTypeStopword[\s\S]*?return\s*\[([\s\S]*?)\]\.includes/)
  if (!m) throw new Error('后端找不到 isRecordTypeStopword 的数组字面量')
  return stringsOf(m[1]).map(w => w.trim().toLowerCase()).filter(Boolean)
}

/** 抓 `const TYPE_STOPWORDS` 的数组字面量。 */
function frontendWords(src: string): string[] {
  const m = src.match(/const TYPE_STOPWORDS[^=]*=\s*\[([\s\S]*?)\n\]/)
  if (!m) throw new Error('前端找不到 TYPE_STOPWORDS 的数组字面量')
  return stringsOf(m[1]).map(w => w.trim().toLowerCase()).filter(Boolean)
}

describe('记录：类型词停用词清单前后端一致', () => {
  const be = backendWords(readFileSync(BACKEND, 'utf8'))
  const fe = frontendWords(readFileSync(FRONTEND, 'utf8'))

  it('两边都有内容（抽错了会得到空数组，那就什么也没守住）', () => {
    expect(be.length).toBeGreaterThan(5)
    expect(fe.length).toBeGreaterThan(5)
  })

  it('逐项相等：后端改了词表，前端必须跟着改', () => {
    expect([...fe].sort()).toEqual([...be].sort())
  })

  it('前端确实在用它给出提示（不是只存了一份没人用的常量）', () => {
    const src = readFileSync(FRONTEND, 'utf8')
    expect(src).toMatch(/TYPE_STOPWORDS\.includes\(/)
    expect(src).toMatch(/css\.stopwordHint/)
  })
})
