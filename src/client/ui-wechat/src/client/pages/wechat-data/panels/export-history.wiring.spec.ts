/**
 * 导出记录入口的**接线**守卫。
 *
 * 为什么需要源码级守卫：仓库没有 DOM/hook 测试环境（M13/M14 的既定结论），
 * 「按钮有没有真的挂上、点击有没有真的开弹窗」在用例里观测不到。而这条链路恰恰
 * 很容易被后续改动静默掐断 —— 本轮就发生了一次**迁址**（入口从
 * 「设置 → 高级设置」搬到通讯录工具栏），如果只搬了弹窗组件、没接上新入口，
 * 界面表现是「导出记录功能整个消失」，而所有既有用例仍然全绿。
 *
 * 所以这里钉两件事：
 *   ① 通讯录工具栏里有入口，且它真的把开关置为 true；
 *   ② 旧的设置侧接线**已清干净**（避免留下两个入口 / 悬空引用）。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 读源码并去掉注释 —— 否则注释里提到旧做法会让断言误判。 */
function codeOf(file: string): string {
  const src = readFileSync(join(HERE, file), 'utf8')
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')
}

const contacts = codeOf('Contacts.tsx')
const settings = codeOf('Settings.tsx')

describe('导出记录：入口在通讯录', () => {
  it('弹窗组件存在且被通讯录 import', () => {
    expect(existsSync(join(HERE, 'ExportHistoryDialog.tsx'))).toBe(true)
    expect(contacts).toContain("from './ExportHistoryDialog.tsx'")
    expect(contacts).toContain('<ExportHistoryDialog')
  })

  it('工具栏里有入口按钮，且点击真的置开关为 true', () => {
    // 入口标记（自动化/审计可据此定位）
    expect(contacts).toContain('data-open-export-history')
    // 不是只渲染了组件而按钮没接上
    expect(contacts).toMatch(/setHistoryOpen\(true\)/)
    // 开关状态存在，且弹窗受它控制
    expect(contacts).toMatch(/useState\(false\)/)
    expect(contacts).toMatch(/<ExportHistoryDialog[^>]*open=\{historyOpen\}/)
    expect(contacts).toMatch(/onClose=\{\(\) => \{ setHistoryOpen\(false\) \}\}/)
  })

  it('从通讯录打开时默认预筛「通讯录」，与所在面板上下文一致', () => {
    expect(contacts).toMatch(/initialKind="contacts"/)
  })
})

describe('导出记录：旧的设置侧接线已清干净', () => {
  it('Settings 不再 import / 渲染导出记录弹窗', () => {
    expect(settings).not.toContain('ExportHistoryDialog')
    expect(settings).not.toContain('exportHistoryOpen')
  })

  it('Settings 里不再留有入口按钮或导航项', () => {
    expect(settings).not.toContain('data-open-export-history')
    expect(settings).not.toContain("key: 'exports'")
  })

  it('导出记录功能本身仍在（弹窗与后端接口都还在，只是换了入口）', () => {
    const dialog = codeOf('ExportHistoryDialog.tsx')
    // 关键操作一个都不能因为迁址而丢
    for (const marker of ['apiGetExportHistory', 'apiDeleteExportHistory', 'apiPruneExportHistory', 'reExport', 'copyPath', 'openFile', 'revealFile']) {
      expect(dialog, `导出记录弹窗缺少 ${marker}`).toContain(marker)
    }
  })
})
