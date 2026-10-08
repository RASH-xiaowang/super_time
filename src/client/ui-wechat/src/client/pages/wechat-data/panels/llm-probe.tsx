/**
 * 单条端点探针按钮 + 结果行（2026-09-30 从「四条挤在一起」改成**每块面板自带一条**）。
 *
 * 为什么这么摆：向量与精排的地址 / Key / 路径与对话模型本来就可以不同（实测有
 * 「对话 DeepSeek、向量与精排 SiliconFlow」这种组合）。把测试按钮放进各自的面板里，
 * 点下去看到的结论就贴在那一块的输入框下方 —— 不用回头找"这条消息是哪一类的"。
 *
 * 三条探针的代价不同，写在各自按钮的悬浮提示里：
 *   · chat   = `GET /models`（**不产生费用**）；
 *   · embed  = 一条最小请求（固定测试串，约 3 个 token）；
 *   · rerank = 一条最小请求（固定测试串，约 6 个 token）。
 * `余额查询` 不属于"模型端点"，见下面的 {@link LlmBalanceButton}。
 */
import { useCallback, useState } from 'react'
import {
  apiGetLlmBalance,
  apiTestLlmConnection,
  formatBalance,
  type WechatLlmConfig,
} from '../api.ts'
import css from './ai-model.module.css'

/** 端点解析：地址/Key/路径按"留空回落上一套"的规则算（与后端取数时同一套口径）。 */
function endpointOf(kind: 'chat' | 'embed' | 'rerank', cfg: WechatLlmConfig): { apiUrl: string; apiKey: string; path?: string; model?: string } {
  if (kind === 'embed') {
    return {
      apiUrl: cfg.embeddingApiUrl?.trim() || cfg.apiUrl,
      apiKey: cfg.embeddingApiKey?.trim() || cfg.apiKey,
      path: cfg.embedPath?.trim() || '/embeddings',
      model: cfg.embeddingModel?.trim() || cfg.model,
    }
  }
  if (kind === 'rerank') {
    return {
      apiUrl: cfg.rerankApiUrl?.trim() || cfg.apiUrl,
      apiKey: cfg.rerankApiKey?.trim() || cfg.apiKey,
      path: cfg.rerankPath?.trim() || '/rerank',
      model: cfg.rerankModel?.trim() || '',
    }
  }
  return { apiUrl: cfg.apiUrl, apiKey: cfg.apiKey }
}

/** 按钮提示里如实写清代价与前置条件。 */
function hintOf(kind: 'chat' | 'embed' | 'rerank', blocked: boolean): string {
  if (kind === 'chat') return blocked ? '先填 API 地址' : '向该地址请求 GET /models：通不通、耗时多少、对方是不是 OpenAI 兼容接口。不产生费用'
  if (kind === 'embed') return blocked ? '未填向量模型（或地址）：向量检索会退化为纯本地稀疏通道，没有可测的端点' : '向向量端点发一条最小请求（固定测试串）：能拿到向量维度就算通。约 3 个 token'
  return blocked ? '未填重排序模型：精排整段会跳过（由本地启发式排序），没有可测的端点' : '向重排序端点发一条最小请求（固定测试串）：能拿到相关度就算通。约 6 个 token'
}

export interface LlmProbeButtonProps {
  /** 测哪一条端点。 */
  kind: 'chat' | 'embed' | 'rerank'
  /** 当前表单草稿配置。 */
  cfg: WechatLlmConfig
  /** 按钮文案（如「测试连接」/「测试向量」/「测试精排」）。 */
  label: string
}

/**
 * 渲染一条端点测试按钮与其结果行。
 * @param props - 端点类别 / 草稿配置 / 文案。
 * @returns 按钮 + 结果行。
 */
export function LlmProbeButton({ kind, cfg, label }: LlmProbeButtonProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const ep = endpointOf(kind, cfg)
  // 三类各自的"没得测"条件：没地址；向量还要有模型名；精排**必须显式填**模型名。
  const blocked = !ep.apiUrl || (kind === 'embed' && !ep.model) || (kind === 'rerank' && !ep.model)

  const run = useCallback(async (): Promise<void> => {
    if (busy || blocked) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await apiTestLlmConnection({ apiUrl: ep.apiUrl, apiKey: ep.apiKey, kind, path: ep.path, model: ep.model })
      const host = ((): string => { try { return new URL(ep.apiUrl).host } catch { return ep.apiUrl } })()
      setMsg({ kind: 'ok', text: `✓ 正常：往返 ${String(r.ms)}ms · ${r.detail}（${host}）` })
    } catch (e) {
      setMsg({ kind: 'err', text: '✗ 测试失败：' + (e as Error).message })
    } finally {
      setBusy(false)
    }
  }, [busy, blocked, ep.apiUrl, ep.apiKey, ep.path, ep.model, kind])

  return (
    <>
      <div className={css.probeRow}>
        <button
          type="button"
          className={css.modelGhost}
          data-test-llm={kind}
          onClick={() => { void run() }}
          disabled={busy || blocked}
          title={hintOf(kind, blocked)}
        >
          {busy ? '测试中…' : label}
        </button>
      </div>
      {msg && (
        <div className={`${css.modelMsg} ${msg.kind === 'ok' ? css.msgOk : css.msgErr}`} role="status" data-llm-probe-msg={kind}>
          {msg.text}
        </div>
      )}
    </>
  )
}

export interface LlmBalanceButtonProps {
  /** 当前表单草稿配置（余额查的是对话模型那套地址与 Key）。 */
  cfg: WechatLlmConfig
}

/**
 * 渲染「查询余额」按钮与其结果行。
 *
 * 它**不属于**任何模型面板：余额是**账户级**信息（同一把 Key 下的额度），
 * 所以在三块面板之外单独一行，且主界面左下角还有一条每 5 分钟刷新的常显。
 * @param props - 草稿配置。
 * @returns 按钮 + 结果行。
 */
export function LlmBalanceButton({ cfg }: LlmBalanceButtonProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const run = useCallback(async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMsg(null)
    try {
      const b = await apiGetLlmBalance({ apiUrl: cfg.apiUrl, apiKey: cfg.apiKey })
      const extra = [
        b.isAvailable === false ? '余额不足' : '',
        b.granted !== null ? `赠送 ${b.granted.toFixed(2)}` : '',
        b.toppedUp !== null ? `充值 ${b.toppedUp.toFixed(2)}` : '',
      ].filter(Boolean).join(' · ')
      setMsg({
        kind: 'ok',
        text: `✓ 余额：${formatBalance(b)}${extra ? `（${extra}）` : ''} · ${new Date(b.fetchedAt).toLocaleTimeString('zh-CN')} 取回`,
      })
    } catch (e) {
      setMsg({ kind: 'err', text: '✗ 余额查询失败：' + (e as Error).message })
    } finally {
      setBusy(false)
    }
  }, [busy, cfg.apiUrl, cfg.apiKey])

  return (
    <>
      <div className={css.probeRow}>
        <button
          type="button"
          className={css.modelGhost}
          data-balance-llm=""
          onClick={() => { void run() }}
          disabled={busy || !cfg.apiUrl}
          title="按厂商惯例查询账户余额（DeepSeek: /user/balance；SiliconFlow 等: /user/info）；部分厂商不提供此接口。主界面左下角会每 5 分钟自动刷新"
        >
          {busy ? '查询中…' : '查询余额'}
        </button>
      </div>
      {msg && (
        <div className={`${css.modelMsg} ${msg.kind === 'ok' ? css.msgOk : css.msgErr}`} role="status" data-llm-probe-msg="balance">
          {msg.text}
        </div>
      )}
    </>
  )
}
