/**
 * 检索设置面板（「微信问答」右侧车道）。
 *
 * 把 RAG 检索层的可调参数、向量库状态、离线评估与反馈统计集中到一个面板里 ——
 * 目标 6「支持可配置的阈值与参数调优」的界面落点。
 *
 * 交互约定与「模型配置」面板一致：面板内的实体侧栏、不覆盖对话、Esc/外部点击收起。
 * 只声明**用户真正会调**的少量参数（显式阈值/权重文件仍可手工编辑 rag-config.json）。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  apiBuildRagVectorIndex, apiEvaluateRetrieval, apiGetRetrievalStatus,
  apiListRetrievalFeedback, apiResetRetrievalWeights, apiSaveRetrievalConfig,
  type RetrievalConfigShape, type RetrievalFeedbackItem, type RetrievalStatus,
} from '../api.ts'
import { Badge } from '../ui/kit.tsx'
import css from './retrieval.module.css'
import askCss from './ask.module.css'
import kitCss from '../ui/kit.module.css'

/** 面板要提交的参数草稿（只含界面暴露的字段，其余保持配置原值）。 */
interface Draft {
  enabled: boolean
  denseEnabled: boolean
  minSimilarity: number
  denseTopK: number
  fusionK: number
  maxChars: number
  llmAssist: boolean
  feedbackEnabled: boolean
  learningRate: number
}

/** 从配置快照生成草稿。 */
function draftOf(c: RetrievalConfigShape): Draft {
  return {
    enabled: c.enabled,
    denseEnabled: c.embedding.enabled,
    minSimilarity: c.channels.dense.minSimilarity,
    denseTopK: c.channels.dense.topK,
    fusionK: c.fusion.k,
    maxChars: c.compress.maxChars,
    llmAssist: c.intent.llmAssist,
    feedbackEnabled: c.feedback.enabled,
    learningRate: c.feedback.learningRate,
  }
}

/** 草稿 → 后端 patch（字段名与 RetrievalConfig 对齐）。 */
function patchOf(d: Draft): unknown {
  return {
    enabled: d.enabled,
    embedding: { enabled: d.denseEnabled },
    channels: { dense: { topK: d.denseTopK, minSimilarity: d.minSimilarity } },
    fusion: { k: d.fusionK },
    compress: { maxChars: d.maxChars },
    intent: { llmAssist: d.llmAssist },
    feedback: { enabled: d.feedbackEnabled, learningRate: d.learningRate },
  }
}

/** 数字输入的安全解析（空/非法时保留原值）。 */
function numOr(raw: string, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Render the retrieval settings panel.
 * @param props.open - whether the panel is shown (closed ⇒ render nothing, no fetch).
 * @param props.onClose - close callback.
 * @returns panel element tree.
 */
export function RetrievalPanel({ open, onClose, containerRef }: {
  open: boolean
  onClose: () => void
  /** 面板根节点引用：交给调用方做「点击外部收起」判定。 */
  containerRef?: React.Ref<HTMLElement>
}): React.JSX.Element | null {
  const [status, setStatus] = useState<RetrievalStatus | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const [report, setReport] = useState<string>('')
  const [feedback, setFeedback] = useState<RetrievalFeedbackItem[]>([])

  const load = useCallback(async (): Promise<void> => {
    try {
      const s = await apiGetRetrievalStatus()
      setStatus(s)
      setDraft(draftOf(s.config))
    } catch (e) {
      setMsg({ kind: 'err', text: '读取检索状态失败：' + (e as Error).message })
    }
  }, [])

  // 只在打开时拉一次（关闭即不再请求）。
  useEffect(() => { if (open && !status) void load() }, [open, status, load])

  const save = useCallback(async (): Promise<void> => {
    if (!draft || busy) return
    setBusy('save')
    setMsg(null)
    try {
      await apiSaveRetrievalConfig(patchOf(draft))
      await load()
      setMsg({ kind: 'ok', text: '✓ 已保存检索设置（下次提问即生效）' })
    } catch (e) {
      setMsg({ kind: 'err', text: '✗ 保存失败：' + (e as Error).message })
    } finally {
      setBusy('')
    }
  }, [draft, busy, load])

  const buildVectors = useCallback(async (force: boolean): Promise<void> => {
    if (busy) return
    setBusy(force ? 'rebuild' : 'build')
    setMsg({ kind: 'info', text: force ? '正在全量重建向量索引…' : '正在增量构建向量索引…' })
    try {
      const r = await apiBuildRagVectorIndex(force)
      if (!r.ok) {
        setMsg({ kind: 'err', text: '✗ ' + (r.message || '向量索引构建失败') })
      } else {
        setMsg({
          kind: 'ok',
          text: `✓ 向量索引 ${r.status === 'up-to-date' ? '已是最新' : '构建完成'}：共 ${r.rows} 条（本次新增 ${r.embedded}）· ${r.elapsed_ms}ms`,
        })
      }
      await load()
    } catch (e) {
      setMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    } finally {
      setBusy('')
    }
  }, [busy, load])

  const evaluate = useCallback(async (): Promise<void> => {
    if (busy) return
    setBusy('eval')
    setMsg(null)
    try {
      const r = await apiEvaluateRetrieval(10)
      setReport(r.report)
      setMsg({ kind: 'info', text: '评估完成：上方为「混合检索」与「仅稀疏」的消融对照' })
    } catch (e) {
      setMsg({ kind: 'err', text: '✗ 评估失败：' + (e as Error).message })
    } finally {
      setBusy('')
    }
  }, [busy])

  const resetWeights = useCallback(async (): Promise<void> => {
    if (busy) return
    setBusy('reset')
    setMsg(null)
    try {
      await apiResetRetrievalWeights()
      await load()
      setMsg({ kind: 'ok', text: '✓ 已把重排权重重置为默认值（反馈记录保留）' })
    } catch (e) {
      setMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    } finally {
      setBusy('')
    }
  }, [busy, load])

  const loadFeedback = useCallback(async (): Promise<void> => {
    try {
      const r = await apiListRetrievalFeedback(20)
      setFeedback(r.items)
    } catch (e) {
      setMsg({ kind: 'err', text: '✗ 读取反馈失败：' + (e as Error).message })
    }
  }, [])

  if (!open) return null

  const pct = (x: number): string => (x * 100).toFixed(1) + '%'

  return (
    <section className={`${askCss.modelPanel} ${css.wrap}`} ref={containerRef} role="region" aria-label="检索设置">
      {/* 面板头与「模型配置」同构（复用 drawer 样式，保证两个侧栏外观一致） */}
      <div className={kitCss.drawerHd}>
        <span className={kitCss.drawerTitle}>检索设置（RAG）</span>
        <div className={css.hdRight}>
          {/* Tone 里没有 'warning'，最接近的告警色是 'amber'（原先传的是不存在的取值） */}
          <Badge tone={status?.enabled ? 'green' : 'amber'}>{status?.enabled ? '流水线启用' : '已回退旧检索'}</Badge>
          <button type="button" className={kitCss.drawerClose} onClick={onClose} aria-label="关闭检索设置">×</button>
        </div>
      </div>

      <div className={kitCss.drawerBd}>
        {!status || !draft ? (
          <div className={css.rowHint}>正在读取检索状态…</div>
        ) : (
          <>
            {/* —— 概览 —— */}
            <div className={css.statGrid}>
              <div className={css.stat}>
                <span className={css.statK}>意图分类自评</span>
                <span className={css.statV}>{pct(status.intentAccuracy.accuracy)}<small>{status.intentAccuracy.correct}/{status.intentAccuracy.total}</small></span>
              </div>
              <div className={css.stat}>
                <span className={css.statK}>向量库</span>
                <span className={css.statV}>{status.vector.rows}<small>条{status.vector.dim ? ` · ${status.vector.dim}维` : ''}</small></span>
              </div>
              <div className={css.stat}>
                <span className={css.statK}>反馈</span>
                <span className={css.statV}>{status.feedback.total}<small>👍{status.feedback.up} / 👎{status.feedback.down}</small></span>
              </div>
            </div>

            {/* —— 开关 —— */}
            <div className={css.group}>
              <div className={css.groupTitle}>通道与路由</div>
              <div className={css.row}>
                <span className={css.rowLabel}>多阶段检索流水线</span>
                <label className={css.switch}>
                  <input type="checkbox" checked={draft.enabled} onChange={(e) => { setDraft({ ...draft, enabled: e.target.checked }) }} />
                  <span>启用</span>
                </label>
              </div>
              <div className={css.rowHint}>关闭后回退为旧的单通道 BM25 检索（用于灰度对比或回滚）。</div>
              <div className={css.row}>
                <span className={css.rowLabel}>稠密向量通道</span>
                <label className={css.switch}>
                  <input type="checkbox" checked={draft.denseEnabled} onChange={(e) => { setDraft({ ...draft, denseEnabled: e.target.checked }) }} />
                  <span>启用</span>
                </label>
              </div>
              <div className={css.rowHint}>关闭即完全不出网做向量化（纯本机稀疏检索）；开启时建索引会把消息文本发送到所选厂商的向量接口。向量模型在「设置 → AI 大模型」中设置。</div>
              <div className={css.row}>
                <span className={css.rowLabel}>LLM 辅助意图分类</span>
                <label className={css.switch}>
                  <input type="checkbox" checked={draft.llmAssist} onChange={(e) => { setDraft({ ...draft, llmAssist: e.target.checked }) }} />
                  <span>启用</span>
                </label>
              </div>
              <div className={css.rowHint}>默认关闭：规则分类已覆盖常见问法，开启会多一次模型往返。</div>
            </div>

            {/* 向量模型已迁到「数据配置 → AI 大模型」：那里是全应用唯一的模型配置入口，
                这里只保留与检索行为相关的通道开关与阈值。 */}

            {/* —— 阈值与容量 —— */}
            <div className={css.group}>
              <div className={css.groupTitle}>阈值与容量</div>
              <div className={css.row}>
                <span className={css.rowLabel}>稠密相似度下限</span>
                <input className={css.num} type="number" step="0.05" min="0" max="1" value={draft.minSimilarity}
                  onChange={(e) => { setDraft({ ...draft, minSimilarity: numOr(e.target.value, draft.minSimilarity) }) }} />
              </div>
              <div className={css.rowHint}>噪声多就上调（0.3~0.4），召回不足就下调。</div>
              <div className={css.row}>
                <span className={css.rowLabel}>各通道召回条数</span>
                <input className={css.num} type="number" step="50" min="20" max="2000" value={draft.denseTopK}
                  onChange={(e) => { setDraft({ ...draft, denseTopK: numOr(e.target.value, draft.denseTopK) }) }} />
              </div>
              <div className={css.row}>
                <span className={css.rowLabel}>RRF 融合常数 k</span>
                <input className={css.num} type="number" step="5" min="1" max="200" value={draft.fusionK}
                  onChange={(e) => { setDraft({ ...draft, fusionK: numOr(e.target.value, draft.fusionK) }) }} />
              </div>
              <div className={css.row}>
                <span className={css.rowLabel}>上下文预算（字符）</span>
                <input className={css.num} type="number" step="500" min="1000" max="40000" value={draft.maxChars}
                  onChange={(e) => { setDraft({ ...draft, maxChars: numOr(e.target.value, draft.maxChars) }) }} />
              </div>
            </div>

            {/* —— 反馈闭环 —— */}
            <div className={css.group}>
              <div className={css.groupTitle}>反馈闭环</div>
              <div className={css.row}>
                <span className={css.rowLabel}>收集回答反馈并微调权重</span>
                <label className={css.switch}>
                  <input type="checkbox" checked={draft.feedbackEnabled} onChange={(e) => { setDraft({ ...draft, feedbackEnabled: e.target.checked }) }} />
                  <span>启用</span>
                </label>
              </div>
              <div className={css.row}>
                <span className={css.rowLabel}>权重微调步长</span>
                <input className={css.num} type="number" step="0.02" min="0" max="1" value={draft.learningRate}
                  onChange={(e) => { setDraft({ ...draft, learningRate: numOr(e.target.value, draft.learningRate) }) }} />
              </div>
              <button type="button" className={css.btn} onClick={() => { void loadFeedback() }}>查看最近反馈</button>
              {feedback.length > 0 && (
                <div className={css.fbList}>
                  {feedback.map(f => (
                    <div key={f.id} className={css.fbRow}>
                      <span className={css.fbMark}>{f.rating === 'up' ? '👍' : '👎'}</span>
                      <span className={css.fbQ} title={`${f.question}\n意图：${f.intent}\n归因特征：${(f.features || []).join(', ') || '—'}`}>
                        {f.question || '（无问题文本）'}
                        {f.features?.length ? ` · 归因：${f.features.join('/')}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* —— 动作 —— */}
            <div className={css.actions}>
              <button type="button" className={`${css.btn} ${css.btnPrimary}`} onClick={() => { void save() }} disabled={!!busy}>
                {busy === 'save' ? '保存中…' : '保存检索设置'}
              </button>
              <button type="button" className={css.btn} onClick={() => { void evaluate() }} disabled={!!busy}>
                {busy === 'eval' ? '评估中…' : '跑离线评估'}
              </button>
              <button type="button" className={css.btn} onClick={() => { void buildVectors(false) }} disabled={!!busy || !draft.denseEnabled}>
                {busy === 'build' ? '构建中…' : '增量构建向量索引'}
              </button>
              <button type="button" className={css.btn} onClick={() => { void buildVectors(true) }} disabled={!!busy || !draft.denseEnabled}>
                {busy === 'rebuild' ? '重建中…' : '全量重建'}
              </button>
              <button type="button" className={css.btn} onClick={() => { void resetWeights() }} disabled={!!busy}>
                {busy === 'reset' ? '重置中…' : '重置权重'}
              </button>
              <button type="button" className={css.btn} onClick={() => { void load() }} disabled={!!busy}>刷新状态</button>
            </div>

            {msg && <div className={`${css.msg} ${msg.kind === 'ok' ? css.msgOk : msg.kind === 'err' ? css.msgErr : css.msgInfo}`} role="status">{msg.text}</div>}
            {report && <pre className={css.report}>{report}</pre>}
          </>
        )}
      </div>
    </section>
  )
}
