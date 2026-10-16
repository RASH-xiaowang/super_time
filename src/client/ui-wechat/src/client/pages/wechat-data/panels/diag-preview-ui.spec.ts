// @vitest-environment node
/**
 * W2-12.4 前端与 IPC 的接线判据。
 *
 * ## 为什么用接线判据而不是渲染断言
 *
 * 能退化的地方全在**接线**上：预览按钮有没有真的去拉预览、预览面板有没有挂在界面上、
 * 截断那句文案有没有被条件包住、复制路径有没有真的写进剪贴板。把这四条钉住，
 * 渲染细节（样式、焦点、滚动位置）可以随便改。
 * @module diag-preview-ui
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const UI = fileURLToPath(new URL('./Settings.tsx', import.meta.url))
const API = fileURLToPath(new URL('../api-media.ts', import.meta.url))
const ui = readFileSync(UI, 'utf8')
const api = readFileSync(API, 'utf8')
const misc = readFileSync(fileURLToPath(new URL('../../../../../../../backend/ipc-misc.js', import.meta.url)), 'utf8')
const preload = readFileSync(fileURLToPath(new URL('../../../../../../../../preload.js', import.meta.url)), 'utf8')

describe('W2-12.4 设置面板上确实有这两件东西', () => {
  it('「预览…」按钮真的去拉预览（不是去关面板）', () => {
    expect(ui).toContain('>预览…</button>')
    expect(ui).toContain('onClick={() => { void previewDiagLog() }}>预览…')
  })

  it('「复制路径」按钮真的去复制', () => {
    expect(ui).toContain('>复制路径</button>')
    expect(ui).toContain('onClick={() => { void copyDiagLogPath() }}>复制路径')
  })

  it('预览面板真的挂在面板里（不是定义了没人用）', () => {
    expect(ui).toContain('<DiagLogPreview data={diagPreview} onClose={closeDiagPreview} />')
    expect(ui).toMatch(/function DiagLogPreview\(props:/)
  })
})

describe('W2-12.4 截断必须说出来', () => {
  it('那句「下面只显示前 N 字符」由 data.truncated 条件控制', () => {
    expect(ui).toContain('{data.truncated ? `（下面只显示前 ${data.text.length} 字符）` : ' + String.fromCharCode(39, 39) + '}')
  })

  it('同时给出全文字符数（用户知道被砍掉了多少）', () => {
    expect(ui).toContain('共 {data.chars} 字符')
  })
})

describe('W2-12.4 四个值都要从 hook 露出来（漏一个界面就拿不到）', () => {
  it('SettingsPanel 解构了 diagPreview / previewDiagLog / closeDiagPreview / copyDiagLogPath', () => {
    expect(ui).toContain('closeDiagPreview, copyDiagLogPath,')
    expect(ui).toContain('diagPreview, exportDiagLog,')
    expect(ui).toContain('previewDiagLog, refreshWhisper, revealDiagLog,')
  })
})

describe('W2-12.4 API 与 IPC 那一段不许走样', () => {
  it('前端走 electronAPI.diag.previewLog / copyLogPath（旧 preload 没有就如实报不支持）', () => {
    expect(api).toContain('api.diag.previewLog()')
    expect(api).toContain('api.diag.copyLogPath()')
    expect(api).toContain("当前环境不支持诊断日志预览")
  })

  it('preload 把两个新通道透出来', () => {
    expect(preload).toContain("previewLog: () => ipcRenderer.invoke('diag:preview-log')")
    expect(preload).toContain("copyLogPath: () => ipcRenderer.invoke('diag:copy-log-path')")
  })

  it('复制路径写进剪贴板的是**日志目录**（不是空串、不是文件名）', () => {
    expect(misc).toContain('const target = path.dirname(diagLog.path);')
    expect(misc).toContain('clipboard.writeText(target);')
  })

  it('预览 handler 与导出 handler 用同一个 buildDiagnosticPreview（内部即 buildDiagnosticReport）', () => {
    // IPC 注册统一经 ipcTrust 包装，源码里注册点是 handleIpc('...')。
    expect(misc).toContain("handleIpc('diag:preview-log'")
    expect(misc).toContain('buildDiagnosticPreview(diagLog, {')
    // 预览与导出的 env 字段必须一致，否则「预览里没有的」会被误当成「导出里也没有」
    const pv = misc.slice(misc.indexOf("handleIpc('diag:preview-log'"))
    const ex = misc.slice(misc.indexOf("handleIpc('diag:export-log'"), misc.indexOf("handleIpc('diag:preview-log'"))
    for (const k of ['app: APP_VERSION', 'electron: process.versions.electron', 'chrome: process.versions.chrome', 'node: process.versions.node', 'platform: process.platform', 'arch: process.arch', 'packaged: app.isPackaged']) {
      expect(pv).toContain(k)
      expect(ex).toContain(k)
    }
  })
})
