/**
 * N9 接线守卫（客户端）：搜索可中断的「谁在取消」这一半。
 *
 * 行为侧的证据在 `src/backend/wechat-data/tests/search-cancel.spec.ts`（取消真的生效、连接真的释放），
 * 这里钉的是**接线**：契约里有没有这个方法、面板在「新搜索 / 清空 / 离开」三条路径上有没有真的发出取消。
 * 少了任一条，后端那套机制就永远没人调用 —— 属于本仓反复栽过的「模块写了但没接上」。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根：本文件在 src/client/ui-wechat/src/client/pages/wechat-data/panels（8 层）。 */
const ROOT = join(HERE, '..', '..', '..', '..', '..', '..', '..', '..')
/**
 * M21：`api.ts` 拆成转发桶 + 8 个域模块（core / read / kb / search / media / export-ops / config / status）——
 * 这里读它们的**联合**（断言一条没放宽；拆出去的边界不该影响任何一条守卫的结论）。
 */
const apiSrc = ['api.ts', 'api-core.ts', 'api-read.ts', 'api-kb.ts', 'api-search.ts', 'api-media.ts', 'api-export-ops.ts', 'api-config.ts', 'api-status.ts'].map((f) => readFileSync(join(HERE, '..', f), 'utf8')).join('\n')
const chatsSrc = readFileSync(join(HERE, 'Chats.tsx'), 'utf8')
const backendSpecSrc = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'tests', 'search-cancel.spec.ts'), 'utf8')

describe('N9：搜索可中断的客户端接线', () => {
  it('契约与封装都在：WechatRemote.cancelSearch + apiCancelSearch + searchMessages 收 jobId', () => {
    expect(apiSrc).toContain('cancelSearch(options: { jobId: string }): Promise<RemoteResult<{ ok: boolean }>>')
    expect(apiSrc).toContain('export async function apiCancelSearch(options: { jobId: string })')
    expect(apiSrc).toContain('remote().cancelSearch(options)')
    expect(apiSrc).toMatch(/searchMessages\(options: \{[^}]*jobId\?: string[^}]*\}\)/)
  })

  it('面板在「新搜索 / 清空 / 离开」三条路径上都发取消', () => {
    const at = chatsSrc.indexOf('const onSearchInput = useCallback')
    expect(at, 'Chats.tsx 里找不到 onSearchInput（用例前提不成立）').toBeGreaterThan(0)
    const body = chatsSrc.slice(at, at + 2600)
    // 清空分支 + 新一轮：各一次
    expect((body.match(/cancelActiveSearch\(\)/g) ?? []).length, '清空/新搜索两条路径都要发取消').toBeGreaterThanOrEqual(2)
    // 卸载清理
    expect(chatsSrc).toContain('useEffect(() => () => { cancelActiveSearch() }, [cancelActiveSearch])')
    // 取消真的打到后端
    expect(chatsSrc).toContain('apiCancelSearch({ jobId })')
  })

  it('搜索调用点必须带 jobId（否则后端永远没有令牌可取消）', () => {
    const calls = chatsSrc.match(/apiSearchMessages\(\{[^}]*\}\)/g) ?? []
    expect(calls.length, 'Chats.tsx 里找不到 apiSearchMessages 调用点').toBeGreaterThan(0)
    for (const c of calls) {
      expect(c, `调用点少了 jobId：${c}`).toContain('jobId')
    }
  })

  it('后端行为侧的门（search-cancel.spec.ts）仍在，且覆盖三条命题', () => {
    expect(backendSpecSrc).toContain('预取消')
    expect(backendSpecSrc).toContain('100ms')
    expect(backendSpecSrc).toContain('不再持有 shard 读连接')
  })
})
