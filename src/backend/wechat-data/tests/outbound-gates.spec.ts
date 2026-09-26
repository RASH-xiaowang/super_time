/**
 * 出网总闸的**行为**验收：开关打开时一个请求都不发（P0-2 / CODE-AUDIT-2026-09-26）。
 *
 * 与 `src/backend/tests/outbound-site-coverage.spec.ts` 的分工：
 *   · 那份按调用点枚举并核对台账 —— 它能发现「新增了一个没登记的出网点」，
 *     但只能检查「闸门标记存在于代码里」，检查不了它**管不管得到**这个点；
 *   · 这一份真的把 `fetch` 换成探针跑一遍网关：闸门打开 ⇒ `calls` 必须是空的，
 *     闸门关闭 ⇒ `calls` 必须**非空**（反例）。两半都要，否则「守卫恒真」和「闸门形同虚设」
 *     这两种错法都会静默通过。
 *
 * 三个点过去都漏在闸门外：
 *   · `installWhisperEngine` —— 紧邻的 `downloadWhisperModel` 有闸，同族漏一个；
 *   · `downloadLayaModel` —— 装配时连 `privacyBlocked` 依赖都没注入；
 *   · `wechat:llm-models` 在主进程，见 `src/backend/tests/ipc-wechat.spec.ts`。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
import { saveConfig } from '../src/query/config.ts'
import { readPrivacySettings, writePrivacySettings } from '../src/query/privacy-audit.ts'

let root = ''
let decrypted = ''
let gw: WechatDataGateway
/** 探针记下的每一次出网尝试（URL）。 */
let outbound: string[] = []
/**
 * 「不许把产物写进仓库」哨兵：开发态的随包资产回退目录是 `<repo>/src/wechat`，
 * 它同时被 `packaging-content.spec.ts`（N22 白名单）判为违规。
 * 本机本来没有这个目录 ⇒ 用例跑完也不许有（若开发机上真有，就不判，避免误伤）。
 */
const REPO_WECHAT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'src', 'wechat')
const repoWechatPreexisting = existsSync(REPO_WECHAT_DIR)

function fakeCtx(): Context {
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => fn(),
    emit: () => {},
    llm: {
      stream: async function* () { /* 本文件不测生成路径 */ },
      embed: async (texts: string[]) => texts.map(() => [0, 0, 0]),
      embeddingModelName: () => 'stub-embed',
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) },
  } as unknown as Context
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wx-outbound-'))
  // 产物路径是 `dirname(decryptedDir)` ⇒ decryptedDir 必须是 root 的子目录（见 temp-db 的坑）
  decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(root, 'decoded'))
  vi.stubEnv('DSH_WECHAT_SELF_WXID', 'wxid_self')
  // **必须钉住两个模型目录**：`defaultWhisperModelsDir` 在数据根里还没有 whisper 目录时会
  // 退回「随包资产目录」，而开发态那个目录就在仓库里（`src/wechat/whisper`）——
  // 第一版没钉，本文件的「反例」用例真的在仓库里建出了 `src/wechat/whisper/bin`。
  saveConfig(decrypted, {
    whisper_models_dir: join(root, 'whisper'),
    laya_models_dir: join(root, 'laya'),
  })
  outbound = []
  // 404 不在重试状态码里 ⇒ 探针立刻返回，用例不会被退避睡眠拖慢
  vi.stubGlobal('fetch', async (url: unknown) => {
    outbound.push(String(url))
    return { ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null }, text: async () => '', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0), body: null }
  })
  gw = new WechatDataGateway(fakeCtx())
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  if (!repoWechatPreexisting) {
    expect(existsSync(REPO_WECHAT_DIR), `用例把产物写进了仓库：${REPO_WECHAT_DIR}`).toBe(false)
  }
})

/** 打开/关闭「禁止 AI 出网」总闸（走真实的隐私存储，不是桩）。 */
function setBlockOutbound(on: boolean): void {
  writePrivacySettings(decrypted, { ...readPrivacySettings(decrypted), blockOutbound: on })
}

/** 三个「只下文件」的入口，各自的审计功能名。 */
const FILE_DOWNLOADS: Array<{ name: string; feature: string; run: () => Promise<{ ok?: boolean; error?: string }> }> = [
  { name: 'installWhisperEngine', feature: 'whisper_engine_install', run: () => gw.installWhisperEngine() },
  { name: 'downloadWhisperModel', feature: 'voice_model_download', run: () => gw.downloadWhisperModel({ model: 'tiny' }) },
  { name: 'downloadLayaModel', feature: 'laya_model_download', run: () => gw.downloadLayaModel() },
]

describe('「禁止 AI 出网」管到每一个下载入口', () => {
  it('台账没漏：这三条都是网关上的真实方法', () => {
    for (const d of FILE_DOWNLOADS) {
      expect(typeof (gw as unknown as Record<string, unknown>)[d.name], `${d.name} 不是网关方法`).toBe('function')
    }
    expect(FILE_DOWNLOADS.length).toBe(3)
  })

  it('开关打开 ⇒ 直接返回拦截文案，一次 fetch 都不发', async () => {
    setBlockOutbound(true)
    for (const d of FILE_DOWNLOADS) {
      const before = outbound.length
      const r = await d.run()
      expect(r.ok, `${d.name} 在开关打开时仍然成功了`).toBe(false)
      expect(r.error ?? '', `${d.name} 没说出是哪个开关`).toContain('出站拦截')
      expect(r.error ?? '', `${d.name} 的审计功能名没出现在文案里`).toContain(d.feature)
      expect(outbound.slice(before), `${d.name} 在开关打开后发出了请求`).toEqual([])
    }
  })

  it('反例（防空转）：开关关闭 ⇒ 同一条路真的会发出请求', async () => {
    setBlockOutbound(false)
    for (const d of FILE_DOWNLOADS) {
      const before = outbound.length
      await d.run()
      expect(outbound.length, `${d.name} 在开关关闭时也没有发出请求 ⇒ 上一条用例是恒真的`).toBeGreaterThan(before)
      expect(String(outbound[outbound.length - 1])).toMatch(/^https:\/\//)
    }
  })

  it('拦截记录进了操作日志（用户查得到为什么没装上）', async () => {
    setBlockOutbound(true)
    await gw.installWhisperEngine()
    await gw.downloadLayaModel()
    const rows = gw.getOperationLog({ limit: 50 }).items
    const actions = rows.map((r) => String(r.action))
    expect(actions, 'install_whisper_engine 被拦没有写进操作日志').toContain('install_whisper_engine')
    expect(actions, 'download_laya_model 被拦没有写进操作日志').toContain('download_laya_model')
    const detail = rows.filter((r) => r.action === 'download_laya_model').map((r) => String(r.detail ?? '')).join('|')
    expect(detail).toContain('laya_model_download')
  })
})
