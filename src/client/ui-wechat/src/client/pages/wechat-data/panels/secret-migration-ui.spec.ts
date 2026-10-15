// @vitest-environment node
/**
 * W2-12.3 前端那一半：M1 密钥搬家提示必须**只出现一次**，且必须由后端说了算。
 *
 * ## 钉住的东西
 *
 * ① 只在 `pending === true` 时渲染 —— 不许改成 `secretMigration` 存在就渲染
 *    （那等于「后端老版本没这个字段」也弹一条假提示）。
 * ② 「知道了」写的是 `secret_migration_notice_ack: true`，而且**走正式的保存接口**，
 *    写完要重新 load（不许本地把提示藏起来就算数 —— 那刷新一下又回来，比不提示更烦）。
 * ③ 写失败要说话，且**不要**本地先隐藏。
 * ④ 被搬的字段名要显示出来：用户得知道到底哪些字段会从 config.json 消失。
 * @module secret-migration-ui
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PANEL = fileURLToPath(new URL('./Settings.tsx', import.meta.url))
const STATE = fileURLToPath(new URL('./settings-state.tsx', import.meta.url))
const ui = readFileSync(PANEL, 'utf8')
const state = readFileSync(STATE, 'utf8')

describe('W2-12.3 提示条', () => {
  it('只在 `pending === true` 时出现（字段缺失 ≠ 提示）', () => {
    expect(ui).toMatch(/if \(state\?\.pending !== true\) return null/)
  })

  it('说的是「搬到 secrets.json」并让用户知道 config.json 里会被删掉', () => {
    expect(ui).toContain('密钥已改存到 secrets.json')
    expect(ui).toMatch(/搬到 secrets\.json 并从 config\.json 删除/)
  })

  it('被搬的字段名要列出来（用户得知道哪些字段会消失）', () => {
    expect(ui).toContain("state.fields.join('、')")
  })

  it('手工编辑入口说清楚是 secrets.json（别让人再去翻 config.json）', () => {
    expect(ui).toMatch(/要手工查看或修改请编辑 secrets\.json/)
  })

  it('「知道了」接的是 ackSecretMigration（不是本地 setState 藏起来）', () => {
    expect(ui).toContain('onClick={onAck}')
    expect(ui, '提示条要真的挂在面板里').toContain('<SecretMigrationNotice state={secretMigration} onAck={ackSecretMigration} />')
    expect(ui).not.toMatch(/secretMigration\.pending\s*&&\s*setState/)
  })
})

describe('W2-12.3 ackSecretMigration', () => {
  it('取自 cfg 的 secret_migration，缺失时是 null 而不是 pending', () => {
    expect(state).toContain('secretMigration: cfg?.secret_migration ?? null')
  })

  it('写的是确认位，走正式保存接口', () => {
    expect(state).toContain('apiSaveWechatConfig({ patch: { secret_migration_notice_ack: true } })')
  })

  it('写完重新 load（提示要真消失，不能只改本地状态）', () => {
    const i = state.indexOf('async function writeSecretMigrationAck(')
    expect(i).toBeGreaterThan(-1)
    const body = state.slice(i, i + 900)
    expect(body).toContain('await load()')
  })

  it('写失败要说话，且**不**在失败路径上本地隐藏', () => {
    const i = state.indexOf('async function writeSecretMigrationAck(')
    const body = state.slice(i, i + 900)
    expect(body, '失败必须给用户一句话').toMatch(/提示关不掉/)
    // 失败分支的条件必须是「保存真的失败了」。写成 `if (true)`（或任何与 r.ok 无关的
    // 条件）就变成「保存请求发出去了，结果不看，本地直接藏提示」——
    // 刷新一下提示又回来，比不提示更烦。这条判据就是为了钉住这个条件。
    expect(body, '失败分支必须由 r.ok 驱动，不能是无条件短路').toMatch(/if \(!r\.ok\)[^\n]*return[^\n]*\}/)
  })

  it('两个值都从 hook 的返回里露出去（漏一个就是界面拿不到）', () => {
    expect(state).toContain('ackSecretMigration: async () => { await writeSecretMigrationAck(')
    expect(state).toContain('saving, scanOriginals, closeDiagPreview, copyDiagLogPath, diagPreview, previewDiagLog, secretMigration: cfg?.secret_migration ?? null, setDbDir')
    expect(ui).toContain('accounts, ackSecretMigration, activeKey')
    expect(ui).toContain('scanOriginals, secretMigration, setDbDir')
  })
})