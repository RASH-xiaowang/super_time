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
import { readChatsSource } from '../../../test-helpers/chats-source.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const entry = readFileSync(join(HERE, '..', '..', '..', '..', '..', '..', 'ui-app', 'ui-entry.tsx'), 'utf8')
/**
 * 事件映射表（2026-10-14 从 ui-entry 的内联 if-else 抽出）：手机浏览器的 SSE 那条路
 * 与 IPC 共用同一份映射，两边各写一份必然漂。判据因此改查**表 + ui-entry 的接线**。
 */
const events = readFileSync(join(HERE, '..', '..', '..', '..', '..', '..', 'ui-app', 'wechat-events.ts'), 'utf8')
const chats = readChatsSource()
const task = readFileSync(join(HERE, 'export-task.ts'), 'utf8')
const status = readFileSync(join(HERE, 'ExportProgressStatus.tsx'), 'utf8')

describe('M3：导出进度与取消的接线', () => {
  it('渲染层入口把 wechat-export/progress 中继成 DOM 事件', () => {
    // 表里必须有这一条，且中继出去的名字与面板监听的一致
    expect(events, '映射表里不再中继导出进度事件')
      .toMatch(/from:\s*'wechat-export\/progress',\s*to:\s*'dsh-wechat-export-progress'/)
    // 表在，还得真的接上：ui-entry 必须把它挂到 IPC 的 onEvent 上（否则表是死数据）
    expect(entry, 'ui-entry 没有把共用的映射表接到 IPC 事件上')
      .toContain('onEvent(dispatchWechatEvent)')
  })

  it('导出入口统一用 export-task 生成并透传 jobId', () => {
    const at = chats.indexOf('const exportSession = useCallback')
    expect(at).toBeGreaterThan(-1)
    const body = chats.slice(at, at + 2600)
    expect(body).toContain('exportTask.run(async ({ jobId })')
    expect(body).toMatch(/jobId,/)
  })

  it('面板按 jobId 认领进度事件，并清理槽位', () => {
    expect(task).toMatch(/addEventListener\('dsh-wechat-export-progress'/)
    expect(task).toMatch(/removeEventListener\('dsh-wechat-export-progress'/)
    expect(task).toContain('detail.jobId !== backendJobRef.current')
    // Promise 收尾必须清槽；否则下一次导出会认领上一次的残留进度。
    expect(task).toContain('jobRef.current = \'\'')
  })

  it('取消按钮调 apiCancelExportJob（不是只关对话框）', () => {
    expect(task).toMatch(/apiCancelExportJob\(jobId\)/)
    expect(chats).toContain('onCancel={cancelExport}')
  })

  it('进度条按 done/total 显示（不是假动画）', () => {
    expect(chats).toContain('<ExportProgressStatus state={exportState} onCancel={cancelExport} />')
    expect(status).toContain('<ProgressBar value={percent ?? 0} indeterminate={percent === null} />')
    expect(status).toContain('progress.done / progress.total')
    expect(status).toContain('Math.min(100,')
  })

  /**
   * 真机验收（`scripts/export-progress-e2e.mjs`）发现的第一个断链：
   * 「导全部」时后端**故意**报 `total=0`（总量未知），而客户端把它当 0% 画 ——
   * 一根钉在 0 的空条在用户眼里就是卡死。两侧口径都要钉住。
   */
  it('总量未知时走不定量态，而不是钉在 0%', () => {
    // 读联合而不是 `chats-view.tsx`：这一段 JSX 已被 #19 第四刀搬进 `chats-export-dialog.tsx`，
    // 按文件名死读会让这条守卫静默失去靶子（`chats-source.ts` 的注释记着这个坑）。
    expect(status).toContain('indeterminate={percent === null}')
    const backup = readFileSync(join(HERE, 'Backup.tsx'), 'utf8')
    expect(backup).toContain('<ExportProgressStatus state={backupTask.state}')
    const fields = readFileSync(join(HERE, '..', 'ui', 'kit-fields.tsx'), 'utf8')
    const at = fields.indexOf('export function ProgressBar')
    const body = fields.slice(at, at + 900)
    expect(body).toContain('indeterminate = false')
    // 不定量时不许报 aria-valuenow（读屏会念「0%」），也不许留内联宽度（那正是「钉在 0%」的成因）
    expect(body).toContain('aria-valuenow={indeterminate ? undefined : Math.round(v)}')
    expect(body).toContain('style={indeterminate ? undefined : { width: `${v}%` }')
    const css = readFileSync(join(HERE, '..', 'ui', 'kit.module.css'), 'utf8')
    expect(css).toMatch(/\.progress\[data-indeterminate\][\s\S]{0,200}animation:/)
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*\.progress\[data-indeterminate\] \.progressFill/)
  })

  /** 真机验收发现的第二个断链：用户自己按「中止」，界面却报「导出失败」。 */
  it('中止按「已取消」说话，不报成失败', () => {
    const fn = chats.slice(chats.indexOf('const exportSession = useCallback'))
    expect(fn).toContain("outcome.canceled ? '已取消导出'")
    expect(task).toMatch(/取消\|cancel\|abort/)
    expect(task).toContain("message: canceled ? '任务已停止' : detail")
    const backup = readFileSync(join(HERE, 'Backup.tsx'), 'utf8')
    const enc = backup.slice(backup.indexOf('const createEncrypted = async'))
    expect(enc).toContain('const outcome = await backupTask.run(async ({ jobId })')
    expect(enc).toContain('if (outcome.ok)')
    expect(enc).not.toContain('已取消加密备份')
  })
})

describe('M3：备份面板的失败提示不能被列表刷新顶掉', () => {
  /**
   * 真机验收（`scripts/backup-progress-e2e.mjs`）跑出来的第三个问题，与进度无关却更严重：
   * `create` / `createEncrypted` / `remove` 原先都是「`setError(失败)` 之后无条件 `await refresh()`」，
   * 而 `refresh()` 开头就 `setError(null)` —— **加密备份失败时界面一个字都不显示**，
   * 用户只看得到进度条消失，等于静默失败。三个入口一律改成走 `finishWith`：
   * 成功才刷新，失败只报因。
   */
  const backup = readFileSync(join(HERE, 'Backup.tsx'), 'utf8')

  it('失败提示与刷新二选一，统一走 finishWith', () => {
    expect(backup).toContain('const finishWith = async (msg: string | null)')
    expect(backup).toMatch(/if \(msg === null\) \{ await refresh\(\); return \}/)
    // 两条无进度的动作路径都不许再「先 setError 再 refresh」；
    // 加密备份已改用共享任务卡显示成功/失败/取消，不再走本地 finishWith。
    for (const handler of ['const create = async', 'const remove = async']) {
      const at = backup.indexOf(handler)
      expect(at, `备份面板里没有 ${handler}`).toBeGreaterThan(-1)
      const body = backup.slice(at, at + 1600)
      expect(body, `${handler} 又回到「报错后刷新」的老写法`).toContain('await finishWith(')
      expect(body).not.toMatch(/if \(!r\.ok\) setError[\s\S]{0,80}await refresh\(\)/)
    }
    const enc = backup.slice(backup.indexOf('const createEncrypted = async'))
    expect(enc).toContain('const outcome = await backupTask.run(async ({ jobId })')
    expect(enc).not.toContain('await finishWith(')
  })

  it('失败时留着密码（取消后重试不该重新输入），成功才清空', () => {
    const at = backup.indexOf('const createEncrypted = async')
    const body = backup.slice(at, at + 1600)
    expect(body).toMatch(/if \(outcome\.ok\) \{[\s\S]{0,80}setPassword\(''\)/)
    expect(body.match(/setPassword\(''\)/g) ?? [], '密码只应在成功分支清空一次').toHaveLength(1)
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
    const body = backup.slice(at, at + 1100)
    expect(body).toContain("idPrefix: 'backup-enc'")
    expect(body).toContain('backupTask.run(async ({ jobId })')
    expect(body).toContain('apiCreateEncryptedBackup({ password: password.trim(), jobId })')
  })

  it('复用共享 jobId 认领与拉取兜底，不再自己挂第二套监听', () => {
    expect(backup).toContain('const backupTask = useExportTask()')
    expect(backup).not.toContain("addEventListener('dsh-wechat-export-progress'")
    expect(task).toContain('useExportProgressRelay(backendJobRef')
  })

  it('进度条与中止都在（不再只有一个 busy 布尔）', () => {
    expect(backup).toContain('<ExportProgressStatus state={backupTask.state} onCancel={')
    expect(status).toContain("data-export-status")
    expect(task).toMatch(/apiCancelExportJob\(jobId\)/)
  })

  it('普通目录备份也生成 jobId、显示共享终态并复用取消', () => {
    const at = backup.indexOf('const create = async')
    expect(at).toBeGreaterThan(-1)
    const body = backup.slice(at, at + 900)
    expect(body).toContain("idPrefix: 'backup-plain'")
    expect(body).toContain('backupTask.run(async ({ jobId })')
    expect(body).toContain('apiCreateBackup({ jobId })')
    expect(backup).toContain('const busyNow = busy || backupTask.running')
    expect(backup).toContain('onCancel={() => { void backupTask.cancel() }}')
  })
})
