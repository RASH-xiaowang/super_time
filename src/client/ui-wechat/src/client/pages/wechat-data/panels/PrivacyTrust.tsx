/**
 * 隐私与信任页 — 明示本地/AI 功能边界，并聚合隐私体检结果（敏感信息扫描、
 * 高风险联系人/群）。审计开关与打码自动化为后续项。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiClearPrivacyAudit, apiGetPrivacyAuditRows, apiGetPrivacyState, apiSetPrivacyState, readRenderCache } from '../api.ts'
import { useFreshData } from './use-fresh-data.ts'
import type { PrivacyAuditRow, PrivacySnapshot, PrivacyStateSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Button, ErrorState, LoadingState, PanelHeader } from '../ui/kit.tsx'
import { CardCanvas } from './card-canvas.tsx'
import { CanvasCard } from './card-canvas-card.tsx'
import kitCss from '../ui/kit.module.css'
import css from './privacy-trust.module.css'
import { useWechatDataUpdated } from './hooks.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import { ExportProgressStatus } from './ExportProgressStatus.tsx'
import { useExportTask } from './export-task.ts'

const LOCAL_FEATURES = [
  '搜索 / 全库统一搜索', '统计与总览', '导出（CSV/HTML/TXT 等）', '关系图谱',
  '资金账本', '联系人 360°', '群聊洞察', '朋友圈洞察', '数据健康', '备份管家', '隐私体检',
  '待办提取（本地关键词匹配，不调用模型）',
]

const AI_FEATURES = ['微信问答', '每日总结', '周期总结', '群总结任务', '消息分析', '推荐回复 / AI回复', '知识库模型处理', 'AI 年度叙述']

/**
 * 审计里的功能 key（后端 `privacyGate(feature, …)` 的第一个参数）→ 界面中文名。
 *
 * 第 59 轮之前审计表永远是空的，所以没人注意到这里会把 `ask_wechat` 这种内部标识
 * 直接显示给用户。未知 key 原样显示（不隐藏），这样以后新增出网功能时不会变成空白行。
 */
const FEATURE_LABELS: Readonly<Record<string, string>> = {
  ask_wechat: '微信问答',
  daily_summary: '每日总结',
  period_summary: '周期总结',
  summary_task: '群总结任务',
  analyze_message: '消息分析',
  ai_reply_analyze: 'AI回复',
  task_callback: '消息列表回复投递',
  suggest_reply: '推荐回复',
  annual_narrative: 'AI 年度叙述',
  ask_optimize: '问答查询优化',
  portrait_personality: '人物性格',
  ask_embed: '聊天向量检索',
  ask_rerank: '问答精排',
  kb_embed: '知识库向量处理',
  kb_file_summary: '知识库文件摘要',
  kb_extract: '知识库实体抽取',
  kb_link_suggest: '知识库链接建议',
}

/**
 * Render the privacy & trust panel.
 * @param props - `embedded`：作为「微信数据配置」弹窗里的一节渲染，不再自建 height:100%
 *   的滚动容器与内边距（由弹窗右区负责滚动）。
 * @returns the privacy trust element tree.
 */
export function PrivacyTrustPanel({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const [scan, setScan] = useState<PrivacySnapshot | null>(() => readRenderCache<PrivacySnapshot>('privacy-scan'))
  /* 2026-10-03 推广：state / rows 改用共用 useFreshData —— 打开即查最新（不再预填缓存）；
     查询失败才回退缓存并由 hook 标注「以下为本地缓存（可能不是最新）」。
     三处本地写（切换开关 / 清空审计）改用 hook 的 `override` 写入 —— data 由 hook 拥有。
     ⚠️ `scan` **刻意保持缓存读**：源码说明「扫描是重活，结果沿用渲染缓存，
     要最新去『隐私体检』页手动扫」——挂上取数 hook 会让打开本页触发全库敏感扫描。 */
  const fetchState = useCallback(() => apiGetPrivacyState(), [])
  const { data: state, reload: reloadState, override: overrideState } = useFreshData<PrivacyStateSnapshot>('privacy-state', fetchState)
  const fetchRows = useCallback(() => apiGetPrivacyAuditRows().catch((): never[] => []), [])
  const { data: rowsData, reload: reloadRows, override: overrideRows } = useFreshData<readonly PrivacyAuditRow[]>('privacy-audit-rows', fetchRows)
  /** 原 state 形态就是数组（`?? []`）⇒ 保持一致，避免调用点到处判空。 */
  const rows = rowsData ?? []
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const exportTask = useExportTask()

  /** 合并重查（既有调用点原样可用）。 */
  const load = useCallback(async (): Promise<void> => {
    await Promise.all([reloadState(), reloadRows()])
  }, [reloadState, reloadRows])
  // 数据落地后重载：冷启动时后端同步要跑 2–3 分钟，期间首次请求可能返回空快照，
  // 页面会停在「0 / 暂无数据」而并非真的没有数据（实测该事件在同步期约每 10 秒一次）。
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费，
  // 也避免那几个「loading 时隐藏内容」的面板每约 10 秒白闪一次。
  useWechatDataUpdated(() => { if (!state) void load() })

  const toggle = useCallback(async (key: 'redactSensitive', value: boolean): Promise<void> => {
    try {
      overrideState(await apiSetPrivacyState({ [key]: value }))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const exportAudit = useCallback((): void => {
    if (exportTask.running || rows.length === 0) return
    const header = 'id,feature,ts,chars,sessions,messages'
    const lines = rows.map(r => `${r.id},${r.feature},${r.ts},${r.chars},${r.sessions},${r.messages}`)
    void exportTask.run(async () => {
      const blob = new Blob(['\uFEFF' + header + '\n' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'wechat-privacy-audit.csv'
      a.click()
      URL.revokeObjectURL(url)
      return rows.length
    }, {
      idPrefix: 'privacy-audit-export',
      label: '导出隐私审计 CSV',
      progress: { phase: 'local', done: 0, total: 0 },
      cancelable: false,
      successMessage: (count) => `已导出 ${count} 条隐私审计记录`,
    })
  }, [exportTask, rows])

  const clearAudit = useCallback(async (): Promise<void> => {
    try {
      await apiClearPrivacyAudit()
      overrideRows([])
      overrideState(await apiGetPrivacyState())
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  return (
    <div className={embedded ? css.embedded : kitCss.panelShell}>
      <PanelHeader title="数据边界与出网" />

      {/* 卡片区改用**等宽瀑布流画布**（2026-11-19，与「年度报告」「数据总览」同一套）。
          这几张卡的高度差异很大：「数据边界」是三段长文、「隐私体检」常常只有一行摘要，
          旧的两列栅格会把它们拉成等高，矮卡下方留白。
          导出进度与页头留在画布外 —— 它们是面板级动作，不该参与摆放。 */}
      <CardCanvas year={0} scope="privacy-trust">
      <CanvasCard id="trust-guard" title="防护设置">
        {state ? (
          <div className={css.toggles}>
            <button type="button" className={css.toggle} data-active={state.redactSensitive} onClick={() => { void toggle('redactSensitive', !state.redactSensitive) }} {...desktopActionProps()}>
              敏感字段打码（手机号/身份证/银行卡/邮箱/口令） · {state.redactSensitive ? '开' : '关'}
            </button>
          </div>
        ) : (
          <LoadingState variant="compact" label="设置加载中…" />
        )}
      </CanvasCard>

      <CanvasCard id="trust-local" title="纯本地功能">
          <div className={css.chipGrid}>
            {LOCAL_FEATURES.map(f => <span key={f} className={css.localChip}>🔒 {f}</span>)}
          </div>
        </CanvasCard>

        <CanvasCard id="trust-ai" title="AI 功能（出网）">
          <div className={css.aiList}>
            {AI_FEATURES.map(name => (
              <div key={name} className={css.aiRow}>
                <span className={css.aiName}>{name}</span>
              </div>
            ))}
          </div>
        </CanvasCard>

      <CanvasCard id="trust-audit" title="AI 出站审计">
        {!state ? (
          <LoadingState variant="compact" label="设置加载中…" />
        ) : (
          <div className={css.audit}>
            <div className={css.auditRow}>
              <span className={css.auditName}>AI 出站调用（放行次数）</span>
              <span className={css.auditCount}>{state.audit.total}</span>
            </div>
            {state.audit.byFeature.map(f => (
              <div key={f.feature} className={css.auditRow}>
                <span className={css.auditName} title={f.feature}>{FEATURE_LABELS[f.feature] ?? f.feature}</span>
                <span className={css.auditCount}>{f.count} 次 · {f.chars} 字符</span>
              </div>
            ))}
            {state.audit.total === 0 && (
              <div className={kitCss.emptyInline}>还没有 AI 出站调用（问答 / 总结 / 群总结任务一旦放行就会记在这里）</div>
            )}
          </div>
        )}
        <div className={css.auditActions}>
          <Button variant="pill" onClick={exportAudit} disabled={rows.length === 0 || exportTask.running}>{exportTask.running ? '导出中…' : '导出审计 CSV'}</Button>
          <Button variant="pill" onClick={() => { void clearAudit() }} disabled={state?.audit.total === 0} {...desktopActionProps()}>清空审计</Button>
        </div>
      </CanvasCard>

      {/* 2026-09-30 精简：这一块原来把「隐私体检」的**完整结果**（分类明细 + 高风险联系人芯片）
          又抄了一遍，而侧栏「隐私体检」页本来就展示同一份数据。现在只留一行摘要，
          详情回那一页看 —— 这正是「内容重复」在这次精简里被砍掉的第一处。 */}
      <CanvasCard id="trust-scan" title="隐私体检（敏感信息扫描）">
        {loading && !scan && <LoadingState variant="compact" label="扫描结果加载中…" />}
        {!loading && !scan && !error && <div className={kitCss.emptyInline}>还没有扫描结果</div>}
        {error && <ErrorState message={error} />}
        {scan && (
          <div className={css.scanSummary}>
            <span><b>{scan.total_hits}</b> 命中</span>
            <span><b>{scan.involved_sessions}</b> 会话</span>
          </div>
        )}
      </CanvasCard>
      </CardCanvas>

      <ExportProgressStatus state={exportTask.state} />
    </div>
  )
}
