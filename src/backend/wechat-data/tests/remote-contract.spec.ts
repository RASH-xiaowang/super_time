/**
 * H11 验收：前端手写的 `WechatRemote` 接口与后端 `@Remote` 集合必须**双向无缺失**。
 *
 * 为什么要有这条：前端不能 import 后端的实现（跨包 + 运行时边界），接口是手抄的，
 * 而手抄会在两边各自演化 —— 本次引入 typecheck 时就发现 `getFileImageDataUrl` /
 * `exportSnsVideo` 两个方法后端有、前端没声明，调用点却已经在用。
 * 这里用文本比对把这条约束钉住（比"从 @Remote 生成"更轻，且能立刻失败）。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..', '..')

const GATEWAY = join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'gateway.ts')
const API = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'api.ts')

/**
 * M21：`api.ts` 拆成转发桶 + 8 个域模块（`WechatRemote` 现在住 `api-core.ts`）——
 * 这里读它们的**联合**再抠接口成员，断言（前后端方法名对齐）一条没改。
 * 目录取上面那条路径的 dirname，模块名只是加在同一个目录里。
 */
const API_FILES = ['api.ts', 'api-core.ts', 'api-read.ts', 'api-kb.ts', 'api-search.ts', 'api-media.ts', 'api-export-ops.ts', 'api-config.ts', 'api-status.ts']
const API_SRC = API_FILES.map((f2) => readFileSync(join(dirname(API), f2), 'utf8')).join('\n')

/** 后端所有 `@Remote('name')` 装饰器里的名字。 */
function remoteNames(rawSource: string): string[] {
  return [...stripComments(rawSource).matchAll(/@Remote\(\s*'([^']+)'\s*\)/g)].map(m => m[1])
}

/**
 * 去掉块注释与整行注释再解析。
 *
 * 不这么做的话，**被注释掉的方法声明也会被当成存在**（实测：把某个成员注释掉，
 * 断言依然全绿 —— 于是这条用例会在最该报警的时候放行）。
 * 只剥「整行注释」而不剥行尾注释，避免误伤字符串里的 `//`（如 https:// 地址）。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** `interface WechatRemote { … }` 块里声明的成员名（方法式与属性式都算）。 */
function interfaceMembers(rawSource: string): string[] {
  const source = stripComments(rawSource)
  const at = source.indexOf('interface WechatRemote')
  if (at < 0) throw new Error('api.ts 里找不到 interface WechatRemote')
  const open = source.indexOf('{', at)
  let depth = 0
  let close = open
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) { close = i; break }
    }
  }
  const block = source.slice(open, close)
  const names = new Set<string>()
  for (const m of block.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*[(?:]/gm)) names.add(m[1])
  return [...names]
}

describe('Remote 契约：前端镜像与后端 @Remote 对齐', () => {
  const backend = remoteNames(readFileSync(GATEWAY, 'utf8'))
  const client = interfaceMembers(API_SRC)

  it('后端每个 @Remote 都在 WechatRemote 里声明了', () => {
    expect([...backend].sort().filter(n => !client.includes(n))).toEqual([])
  })

  it('WechatRemote 没有后端不存在的成员（拼错或已删的方法）', () => {
    expect([...client].sort().filter(n => !backend.includes(n))).toEqual([])
  })

  it('方法数量非零且两侧一致（防止解析失效导致两条断言空转）', () => {
    expect(backend.length).toBeGreaterThan(100)
    expect(client.length).toBe(backend.length)
  })
})
