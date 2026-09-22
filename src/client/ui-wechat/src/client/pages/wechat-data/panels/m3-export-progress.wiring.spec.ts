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

  /**
   * 真机验收（`scripts/export-progress-e2e.mjs`）发现的第一个断链：
   * 「导全部」时后端**故意**报 `total=0`（总量未知），而客户端把它当 0% 画 ——
   * 一根钉在 0 的空条在用户眼里就是卡死。两侧口径都要钉住。
   */
  it('总量未知时走不定量态，而不是钉在 0%', () => {
    const view = readFileSync(join(HERE, 'chats-view.tsx'), 'utf8')
    expect(view).toContain('indeterminate={exportProgress.total <= 0}')
    const backup = readFileSync(join(HERE, 'Backup.tsx'), 'utf8')
    expect(backup).toContain('indeterminate={encProgress.total <= 0}')
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
    const cat = fn.slice(fn.indexOf('} catch (e) {'), fn.indexOf('} catch (e) {') + 400)
    expect(cat).toMatch(/取消\|cancel\|abort/)
    expect(cat).toContain('已取消导出')
    const backup = readFileSync(join(HERE, 'Backup.tsx'), 'utf8')
    const enc = backup.slice(backup.indexOf('const createEncrypted = async'))
    const blk = enc.slice(enc.indexOf('if (r.ok)'), enc.indexOf('if (r.ok)') + 500)
    expect(blk).toMatch(/取消\|cancel\|abort/)
    expect(blk).toContain('已取消加密备份')
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
    // 三条动作路径都不许再「先 setError 再 refresh」
    for (const handler of ['const create = async', 'const createEncrypted = async', 'const remove = async']) {
      const at = backup.indexOf(handler)
      expect(at, `备份面板里没有 ${handler}`).toBeGreaterThan(-1)
      const body = backup.slice(at, at + 1600)
      expect(body, `${handler} 又回到「报错后刷新」的老写法`).toContain('await finishWith(')
      expect(body).not.toMatch(/if \(!r\.ok\) setError[\s\S]{0,80}await refresh\(\)/)
    }
  })

  it('失败时留着密码（取消后重试不该重新输入），成功才清空', () => {
    const at = backup.indexOf('const createEncrypted = async')
    const body = backup.slice(at, at + 1600)
    expect(body).toContain('if (r.ok) setPassword(')
    expect(body).not.toMatch(/\n\s*setPassword\(''\)/)
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
