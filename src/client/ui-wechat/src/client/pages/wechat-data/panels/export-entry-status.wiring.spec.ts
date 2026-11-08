/**
 * 本地导出入口也必须有可见生命周期。
 *
 * 这些下载不需要后端 jobId，但不能退化成「点一下、文件也许出现、失败只进 console」：
 * 至少要有 running / success / error 三态；总量未知时显示不定量进度，不伪造百分比。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (file: string): string => readFileSync(join(HERE, file), 'utf8')

const LOCAL_EXPORTS: ReadonlyArray<{
  owner: string
  statusFile: string
  prefixes: readonly string[]
}> = [
  { owner: 'use-graph-export-actions.ts', statusFile: 'Graph.tsx', prefixes: ['graph-svg', 'graph-png', 'graph-poster'] },
  { owner: 'use-diag-log-export.ts', statusFile: 'Settings.tsx', prefixes: ['settings-diag-log'] },
  { owner: 'OperationLogPanel.tsx', statusFile: 'OperationLogPanel.tsx', prefixes: ['operation-log-export'] },
  { owner: 'PrivacyTrust.tsx', statusFile: 'PrivacyTrust.tsx', prefixes: ['privacy-audit-export'] },
  { owner: 'Ledger.tsx', statusFile: 'Ledger.tsx', prefixes: ['ledger-csv'] },
  { owner: 'use-overview-report-export.ts', statusFile: 'overview-panel.tsx', prefixes: ['overview-json', 'overview-markdown'] },
]

describe('本地导出：不定量进度 + 可见终态', () => {
  it('每个本地导出入口都接共享任务，并显示状态卡', () => {
    for (const entry of LOCAL_EXPORTS) {
      const owner = read(entry.owner)
      const status = read(entry.statusFile)
      expect(owner, `${entry.owner} 没接 useExportTask`).toContain('useExportTask()')
      expect(status, `${entry.statusFile} 没渲染共享状态卡`).toContain('<ExportProgressStatus')
      for (const prefix of entry.prefixes) {
        expect(owner, `${entry.owner} 漏了 ${prefix}`).toContain(prefix)
      }
    }
  })

  it('总量未知时不填假分母，并明确声明本地任务不可取消', () => {
    for (const entry of LOCAL_EXPORTS) {
      const owner = read(entry.owner)
      expect(owner, `${entry.owner} 伪造了确定进度`).toContain("progress: { phase: 'local', done: 0, total: 0 }")
      expect(owner, `${entry.owner} 的本地任务不应显示取消`).toContain('cancelable: false')
    }
  })

  it('图谱导出按钮在任务运行中全部禁用', () => {
    const menu = read('GraphExportMenu.tsx')
    const disabled = menu.match(/disabled=\{exporting\}/g) ?? []
    expect(disabled, '触发按钮与 SVG/PNG/海报菜单项都必须锁住').toHaveLength(4)
  })

  it('设置与总览面板确实接上了抽出的导出 hook', () => {
    expect(read('settings-state.tsx')).toContain('useDiagLogExport(refreshDiag)')
    expect(read('overview-panel.tsx')).toContain('useOverviewReportExport({')
  })
})
