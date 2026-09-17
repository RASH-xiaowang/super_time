/**
 * 禁用原生确认框的守卫。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * `window.confirm()` 弹的是**操作系统原生对话框**：系统标题栏写着进程名
 * （Electron 下是 `super-time-electron`），白底方框在一片深色霓虹界面里完全
 * 不属于这个应用；它还阻塞渲染进程、无法标注危险级别、macOS 上按钮语义与
 * Windows 相反。实测就是这样被用户看到并报障的。
 *
 * 正确的做法是 `useConfirm()`（`ui/confirm.tsx`）—— 应用内确认框，跟主题、
 * 可标注 danger、可要求逐字输入。本用例把「不要再退回原生」这件事钉住。
 *
 * ── 为什么是源码级守卫 ────────────────────────────────────────
 * 仓库没有 DOM/hook 测试环境（M13/M14 的既定结论），「点了按钮弹出的是哪种框」
 * 观测不到。而这类回退极易发生：新写一个删除按钮时顺手 `window.confirm` 就够了。
 * @vitest-environment node
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
/** wechat-data 根目录（本文件在 panels/ 下）。 */
const ROOT = join(HERE, '..')

/** 递归收集 .ts/.tsx（跳过构建产物与依赖）。 */
function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'ui-dist' || name === 'deps') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) collect(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const FILES = collect(ROOT)
/** 唯一允许出现 window.confirm 的地方：确认框自身的**无 Provider 降级分支**。 */
const ALLOWED = join(ROOT, 'ui', 'confirm.tsx')
/** 守卫自身：文里必然出现 `window.confirm` 这个词，必须排除，否则自己抓自己。 */
const SELF = join(HERE, 'confirm.wiring.spec.ts')

describe('确认框：不得再使用原生 window.confirm', () => {
  it('除 confirm.tsx 的降级分支外，没有任何调用', () => {
    const offenders: string[] = []
    for (const f of FILES) {
      if (f === ALLOWED || f === SELF) continue
      const src = readFileSync(f, 'utf8')
      if (/window\.confirm\s*\(/.test(src)) offenders.push(f.slice(ROOT.length + 1))
    }
    expect(offenders, `这些文件仍在使用原生 window.confirm，请改用 useConfirm()：\n${offenders.join('\n')}`).toEqual([])
  })

  it('防空转：确实扫到了源码文件与 confirm.tsx', () => {
    expect(FILES.length).toBeGreaterThan(30)
    expect(FILES).toContain(ALLOWED)
  })

  it('confirm.tsx 保留原生降级（没有 Provider 时不能直接崩）', () => {
    const src = readFileSync(ALLOWED, 'utf8')
    expect(src).toMatch(/fallbackConfirm|window\.confirm/)
  })
})

describe('确认框：必须挂在应用根部', () => {
  const panel = readFileSync(join(ROOT, 'WechatDataPanel.tsx'), 'utf8')

  it('WechatDataPanel import 并渲染了 ConfirmProvider', () => {
    expect(panel).toContain("from './ui/confirm.tsx'")
    expect(panel).toMatch(/<ConfirmProvider>/)
    expect(panel).toMatch(/<\/ConfirmProvider>/)
  })

  it('Provider 包住了整个面板（开标签在主 return 之后、闭标签在结尾）', () => {
    const open = panel.indexOf('<ConfirmProvider>')
    const close = panel.indexOf('</ConfirmProvider>')
    expect(open).toBeGreaterThan(0)
    expect(close).toBeGreaterThan(open)
    // 面板的实体内容必须夹在中间。以「设置弹窗」的**渲染点**为界做抽样 ——
    // 不能再拿 `settingsOpen` 这个词判位置：它最早出现在 hooks 段的 useState 里，
    // 会比 Provider 还靠前，那样的断言是错的（第一版就是这么写错的）。
    const settingsDialog = panel.indexOf('<div className={css.settingsDialogBody}>')
    expect(settingsDialog, '找不到设置弹窗的渲染点，断言失去参照').toBeGreaterThan(open)
    expect(settingsDialog).toBeLessThan(close)
    // 侧栏与主内容区同样在 Provider 内
    expect(panel.indexOf('className={css.sidebar}')).toBeGreaterThan(open)
    expect(panel.indexOf('className={css.content}')).toBeGreaterThan(open)
  })

  it('每个面板都用 useConfirm() 而不是自带原生框', () => {
    // 曾用过原生框的面板至少要 import 我们的 hook（防止迁移被回退）
    for (const f of ['Backup.tsx', 'Chats.tsx', 'DailySummary.tsx', 'Favorites.tsx', 'OperationLogPanel.tsx', 'Settings.tsx', 'ExportHistoryDialog.tsx']) {
      const src = readFileSync(join(ROOT, 'panels', f), 'utf8')
      expect(src, `${f} 未接入 useConfirm()`).toMatch(/useConfirm/)
      expect(src, `${f} 仍带 window.confirm`).not.toMatch(/window\.confirm\s*\(/)
    }
  })
})

describe('确认框：危险动作的保护', () => {
  it('破坏性确认都标了 danger（确认按钮走危险色，不会和「确定」长得一样）', () => {
    const src = readFileSync(ALLOWED, 'utf8')
    expect(src).toMatch(/variant=\{tone === 'danger' \? 'danger' : 'primary'\}/)
  })

  it('支持逐字输入确认（批量不可逆操作的第二道闸）', () => {
    const src = readFileSync(ALLOWED, 'utf8')
    expect(src).toContain('requireText')
    expect(src).toMatch(/typed === req\?\.requireText/)
    // 不匹配时确认按钮必须禁用
    expect(src).toMatch(/disabled=\{!textOk\}/)
  })

  it('「删除并删文件」在批量时启用逐字确认', () => {
    const src = readFileSync(join(ROOT, 'panels', 'ExportHistoryDialog.tsx'), 'utf8')
    expect(src).toMatch(/requireText:\s*`删除 \$\{ids\.length\} 条`/)
  })
})
