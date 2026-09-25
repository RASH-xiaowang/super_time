/**
 * 本地决策分析卡（laya）。
 *
 * 放在会话消息流末尾：显示**最新一条对方消息**的逐命题判断
 * （字面提问与否 / 是否在试探 / 是否不高兴 / 真实意图分布 / 紧张度 / 最该做的动作）。
 *
 * ## 三条设计约束
 * 1. **纯本地**：走 onnxruntime，不经 LLM、不过出网闸门。卡片头部明确标「不出网」。
 * 2. **不做自动全量**：一次推理 0.4–0.7 s（实测 574–1012 tokens），所以是**按需触发**
 *    （会话工具区的按钮），不是每条消息都跑。
 * 3. **模型缺失是正常路径**：不编造判断，如实显示缺什么、该放哪 —— 与
 *    `query/retrieval/pipeline.ts` 的稠密通道降级同一姿态。
 *
 * 自包含取数（组件挂载即分析一次），与 `chats-contact-info-view.tsx` 的分工一致：
 * 面板只负责「打开/关闭」，数据与竞态都在组件里。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiAnalyzeMessages, apiGetLayaStatus } from '../api.ts'
import type { LayaAnalysisView, LayaAnswer, LayaStatus } from '@deepseek-ai/dsh-wechat-data/types'
import css from './message-analysis-card.module.css'

export interface MessageAnalysisCardProps {
  /** 会话 username（分析范围就是这个会话）。 */
  talker: string
  /** 会话显示名（卡片标题里用）。 */
  displayName?: string
  onClose: () => void
}

/** 一条命题的呈现。三种题型各有各的读法，这里按题型分派。 */
function AnswerBlock({ a }: { a: LayaAnswer }): React.JSX.Element {
  if (a.kind === 'score') {
    const max = a.scale ?? 10
    const filled = Math.round(((a.score ?? 0) / max) * 10)
    return (
      <div className={css.block}>
        <div className={css.blockHead}>
          <span className={css.blockQ}>{a.question}</span>
          <span className={css.score}>
            <span className={css.scoreNum}>{(a.score ?? 0).toFixed(1)}</span>
            <span className={css.scoreMax}> / {max}</span>
          </span>
        </div>
        <div className={css.gauge} role="img" aria-label={`${a.question}：${(a.score ?? 0).toFixed(1)} / ${max}`}>
          {Array.from({ length: 10 }, (_, i) => (
            <span key={i} className={i < filled ? css.tickOn : css.tick} />
          ))}
        </div>
        <div className={css.topLevel}>{a.options.find((o) => o.key === a.top)?.label ?? ''}</div>
      </div>
    )
  }

  if (a.kind === 'noul') {
    return (
      <div className={css.block}>
        <div className={css.blockHead}>
          <span className={css.blockQ}>{a.question}</span>
          <span className={css.binary}>
            {a.options.map((o) => (
              <span key={o.key} className={a.top === o.key ? css.chipOn : css.chip}>
                {o.label} {(o.probability * 100).toFixed(0)}%
              </span>
            ))}
          </span>
        </div>
      </div>
    )
  }

  // choice：概率分布（已按概率降序）
  return (
    <div className={css.block}>
      <div className={css.blockQ}>{a.question}</div>
      <div className={css.rows}>
        {a.options.map((o, i) => (
          <div key={o.key} className={i === 0 ? css.rowTop : css.row}>
            <span className={css.rowLabel}>{o.label}</span>
            <span className={css.bar}>
              <span className={css.fill} style={{ width: `${Math.max(1, o.probability * 100)}%` }} />
            </span>
            <span className={css.rowPct}>{(o.probability * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function MessageAnalysisCard({ talker, displayName, onClose }: MessageAnalysisCardProps): React.JSX.Element {
  const [result, setResult] = useState<LayaAnalysisView | null>(null)
  const [status, setStatus] = useState<LayaStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const run = useCallback(async (): Promise<void> => {
    if (talker === '') return
    setBusy(true)
    setErr('')
    try {
      const [st, r] = await Promise.all([apiGetLayaStatus(), apiAnalyzeMessages({ talker })])
      setStatus(st)
      setResult(r)
      if (!r.ok) setErr(r.error ?? '分析失败')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [talker])

  // 打开即分析一次；换会话重新分析（talker 变 → run 换身份 → 重跑）
  useEffect(() => { void run() }, [run])

  const ready = result !== null && result.ok && result.answers.length > 0

  return (
    <div className={css.card} data-st-card="message-analysis">
      <div className={css.head}>
        <span className={css.title}>
          <span className={css.dot} aria-hidden="true" />
          本地决策分析
        </span>
        <span className={css.meta}>
          {busy ? '推理中…' : ready ? `${result.inferenceMs} ms · ${result.tokens} tokens` : ''}
          {status?.installed === false ? '模型未就绪' : ''}
        </span>
        <button type="button" className={css.close} onClick={onClose} aria-label="关闭分析">&times;</button>
      </div>

      {busy && result === null && <p className={css.hint}>正在本地推理（首次需加载模型，约 1–2 秒）…</p>}

      {err !== '' && (
        <div className={css.notice}>
          <p className={css.noticeText}>{err}</p>
          {status !== null && !status.installed && (
            <>
              <p className={css.noticeHint}>
                本地决策模型是可选的：把模型文件放到下面这个目录即可（约 1.26 GB，图 + 权重 + 分词器）。
              </p>
              <p className={css.path}>{status.dir}</p>
              {status.missing.length > 0 && <p className={css.noticeHint}>缺：{status.missing.join('；')}</p>}
            </>
          )}
        </div>
      )}

      {ready && (
        <>
          <div className={css.quote}>
            <span className={css.quoteWho}>{displayName ?? '对方'}</span>
            <span className={css.quoteText}>{result.latestPeer}</span>
          </div>
          <div className={css.blocks}>
            {result.answers.map((a) => <AnswerBlock key={a.qid} a={a} />)}
          </div>
          <div className={css.foot}>
            <span className={css.footMeta}>
              {result.contextLines} 条上下文
              {result.model.bytes > 0 ? ` · 模型 ${(result.model.bytes / 1024 / 1024 / 1024).toFixed(1)} GB` : ''}
            </span>
            <button type="button" className={css.refresh} onClick={() => { void run() }} disabled={busy}>
              重新分析
            </button>
          </div>
          <p className={css.disclaimer}>
            概率是本地模型的判断，不是事实；「不出网」指推理完全在本机完成，这些内容不会离开这台电脑。
          </p>
        </>
      )}
    </div>
  )
}
