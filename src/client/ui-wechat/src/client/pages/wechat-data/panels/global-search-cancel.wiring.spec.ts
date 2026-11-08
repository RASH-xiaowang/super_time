/**
 * 全局搜索取消接线：后端能力只有在前端真的持有 jobId 并取消旧任务时才会释放 worker。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANEL = readFileSync(join(HERE, '..', 'WechatDataPanel.tsx'), 'utf8')
const HOOK = readFileSync(join(HERE, '..', 'use-global-search.ts'), 'utf8')

describe('全局搜索可取消接线', () => {
  it('每次请求为统一搜索和会话搜索各生成 jobId', () => {
    expect(HOOK).toContain("activeJobId = 'global-search-'")
    expect(HOOK).toContain("activeSessionJobId = activeJobId + '-sessions'")
    expect(HOOK).toMatch(/apiSearchUnified\(\{\s*query,\s*limit:\s*8,\s*jobId:\s*activeJobId\s*\}\)/)
    expect(HOOK).toMatch(/apiGetSessions\(\{[\s\S]{0,100}jobId:\s*activeSessionJobId/)
  })

  it('换词、清空与卸载都取消旧 job', () => {
    expect(HOOK).toContain('apiCancelSearch({ jobId })')
    expect(HOOK).toMatch(/return\s*\(\)\s*=>\s*\{[\s\S]{0,120}window\.clearTimeout\(timer\)[\s\S]{0,120}cancelActiveJob\(\)/)
  })

  it('cleanup 同时递增序号，卸载后晚到的结果不会回写状态', () => {
    expect(HOOK).toMatch(
      /return\s*\(\)\s*=>\s*\{[\s\S]{0,180}searchSeqRef\.current\s*\+=\s*1[\s\S]{0,80}cancelActiveJob\(\)/,
    )
  })

  it('面板外壳只消费 hook，不另写一套搜索请求生命周期', () => {
    expect(PANEL).toContain("import { useGlobalSearchState } from './use-global-search.ts'")
    expect(PANEL).not.toContain('apiSearchUnified({')
    expect(PANEL).not.toContain('apiCancelSearch({')
  })
})
