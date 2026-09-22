// @vitest-environment node
/**
 * M3：导出的实时进度必须真的走到界面上（接线守卫）。
 *
 * 后端那一半早就齐了（`jobId` + 控制槽 + `wechat-export/progress` 推送 + `getExportProgress` /
 * `cancelExportJob`），但**齐了不等于通到界面**：
 *   · `ui-entry.tsx` 的事件中继原先只认 `wechat-data/updated` 与 `wechat-ask/delta`，
 *     进度事件到这里就被丢掉；
 *   · 导出入口原先**不传 jobId** ⇒ 后端连推给谁都不知道；
 *   · 对话框上只有一个「导出中…」的按钮，取消无从下手。
 * 这三处任何一处被改回去，都不会有编译错误、也不会有用例失败 —— 用户看到的仍是「转圈等」。
 * 所以逐条钉住（读源码是刻意的：这三件事的本质是「接线存在」）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readChatsSource } from './chats-source.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const entry = readFileSync(join(HERE, '..', '..', '..', '..', '..', '..', 'ui-app', 'ui-entry.tsx'), 'utf8')
const chats = readChatsSource()

describe('M3：导出进度与取消的接线', () => {
  it('渲染层入口把 wechat-export/progress 中继成 DOM 事件', () => {
    const at = entry.indexOf("'wechat-export/progress'")
    expect(at, 'ui-entry 不再中继导出进度事件').toBeGreaterThan(-1)
    expect(entry.slice(at, at + 320), '中继出去的事件名要和面板监听的一致').toContain('dsh-wechat-export-progress')
  })

  it('导出入口带 jobId（不带的话后端不知道该推给谁）', () => {
    const at = chats.indexOf('const exportSession = useCallback')
    expect(at).toBeGreaterThan(-1)
    const body = chats.slice(at, at + 2600)
    expect(body).toContain('exportJobRef.current = jobId')
    expect(body).toMatch(/jobId,\s*\n\s*}/)
  })

  it('面板按 jobId 认领进度事件，并清理槽位', () => {
    expect(chats).toMatch(/addEventListener\('dsh-wechat-export-progress'/)
    expect(chats).toMatch(/removeEventListener\('dsh-wechat-export-progress'/)
    expect(chats).toContain('if (!p || p.jobId !== exportJobRef.current) return')
    // finally 里必须把 jobId 与进度一起清掉：否则下一次导出会认领上一次的残留进度。
    // 注意要**在 exportSession 体内**找那个 finally —— 联合文本里前面还有别的 try。
    const fn = chats.slice(chats.indexOf('const exportSession = useCallback'))
    const fin = fn.slice(fn.indexOf('} finally {'), fn.indexOf('} finally {') + 400)
    expect(fin).toContain('exportJobRef.current = ')
    expect(fin).toContain('setExportProgress(null)')
  })

  it('取消按钮调 apiCancelExportJob（不是只关对话框）', () => {
    expect(chats).toMatch(/apiCancelExportJob\(jobId\)/)
    expect(chats).toMatch(/onClick=\{cancelExport\}/)
  })

  it('进度条按 done/total 显示（不是假动画）', () => {
    const at = chats.indexOf('exportProgress ? (')
    expect(at, '导出对话框里没有进度条分支').toBeGreaterThan(-1)
    const blk = chats.slice(at, at + 500)
    expect(blk).toContain('<ProgressBar value=')
    expect(blk).toMatch(/exportProgress\.total > 0/)
    expect(blk).toContain('exportProgress.done / exportProgress.total')
  })
})

describe('M3：加密备份入口接同一条进度', () => {
  /**
   * 后端 `createEncryptedBackup` 早就收 `jobId`（M3 的控制槽覆盖导出与加密备份两件事），
   * 但界面上原先只有一个 `busy` 布尔 —— 同一个事件、同一个中继，第二条入口不认领就等于没接。
   */
  const backup = readFileSync(join(HERE, 'Backup.tsx'), 'utf8')

  it('createEncrypted 生成 jobId 并透传给后端', () => {
    const at = backup.indexOf('const createEncrypted = async')
    expect(at).toBeGreaterThan(-1)
    const body = backup.slice(at, at + 1400)
    expect(body).toContain("const jobId = 'backup-enc-'")
    expect(body).toContain('encJobRef.current = jobId')
    expect(body).toContain('apiCreateEncryptedBackup({ password: password.trim(), jobId })')
  })

  it('按 jobId 认领进度事件，并在 finally 里清槽', () => {
    expect(backup).toMatch(/addEventListener\('dsh-wechat-export-progress'/)
    expect(backup).toContain('if (!p || p.jobId !== encJobRef.current) return')
    const fin = backup.slice(backup.indexOf('const createEncrypted = async'))
    const blk = fin.slice(fin.indexOf('} finally {'), fin.indexOf('} finally {') + 300)
    expect(blk).toContain("encJobRef.current = ''")
    expect(blk).toContain('setEncProgress(null)')
  })

  it('进度条与中止都在（不再只有一个 busy 布尔）', () => {
    const at = backup.indexOf('encProgress ? (')
    expect(at, '加密备份没有进度分支').toBeGreaterThan(-1)
    const blk = backup.slice(at, at + 900)
    expect(blk).toContain('<ProgressBar value=')
    expect(blk).toContain('encProgress.done / encProgress.total')
    expect(blk).toContain('onClick={cancelEncrypted}')
    expect(backup).toMatch(/apiCancelExportJob\(jobId\)/)
  })
})
