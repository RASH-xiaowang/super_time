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

/** 模型用途与内容投递分别说明；这些文字不是额外的出网开关。 */
const AI_FEATURES: ReadonlyArray<{ name: string; desc: string }> = [
  { name: '微信问答', desc: '聊天与知识库命中片段发给所选模型；查询优化、向量检索与精排按各自模型配置发送查询或候选文本' },
  { name: '每日总结', desc: '收集当日消息后调用所选模型生成要点' },
  { name: '周期总结', desc: '收集区间消息后调用所选模型生成要点' },
  { name: '群总结任务', desc: '按任务收集指定群消息调用模型；保存推送地址的已启用任务还会将总结正文和 target 发往 Webhook（不额外附带原始消息）' },
  { name: '消息分析', desc: 'analyze_message：点击分析时发送该消息及之前最多 20 条上下文；语音先在本机转写' },
  { name: '推荐回复 / AI回复', desc: '所选模型接收当前会话上下文及按配置启用的知识库片段、图片等；AI回复默认关闭，生成正文先落消息列表再按规则投递' },
  { name: 'AI 队友记忆与提案', desc: '开启 AI回复后，用户级与当前会话记忆作为不可信背景经 ai_reply_analyze 进入模型提示词；只标记采纳不发送，Webhook 发送才投递提案正文；群聊知识库回复保留为待确认草稿' },
  { name: '知识库模型处理', desc: '文件摘要、实体抽取、向量索引与链接建议会按各自功能发送文件正文、摘要或查询文本' },
  { name: 'AI 年度叙述', desc: '按月整理的聊天材料送至所选模型生成年度叙述' },
]

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
  ai_reply_analyze: 'AI回复（含队友记忆）',
  task_callback: '消息列表回复投递',
  suggest_reply: '推荐回复',
  annual_narrative: 'AI 年度叙述',
  ask_optimize: '问答查询优化',
  ask_embed: '聊天向量检索',
  ask_rerank: '问答精排',
  kb_embed: '知识库向量处理',
  kb_file_summary: '知识库文件摘要',
  kb_extract: '知识库实体抽取',
  kb_link_suggest: '知识库链接建议',
}

/** 非模型网络面同样登记，不能把头像宣称为唯一例外。 */
const AVATAR_NOTE = '此外还有任务触发投递、消息列表下游 Webhook、远程头像/图片/视频、地图底图、语音模型下载，以及连接测试与余额查询；范围与时机见启动隐私声明。没有全局出网开关。'

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
      <PanelHeader title="数据边界与出网" desc="数据边界 · AI 出网说明 · 敏感信息扫描结果" />

      {/* 卡片区改用**等宽瀑布流画布**（2026-11-19，与「年度报告」「数据总览」同一套）。
          这几张卡的高度差异很大：「数据边界」是三段长文、「隐私体检」常常只有一行摘要，
          旧的两列栅格会把它们拉成等高，矮卡下方留白。
          导出进度与页头留在画布外 —— 它们是面板级动作，不该参与摆放。 */}
      <CardCanvas year={0} scope="privacy-trust">
        <CanvasCard id="trust-boundary" title="数据边界">
        <p className={css.lead}>微信数据在本机解析/入库/分析；检索统计、导出、图谱、备份等均为纯本地操作。启用不同 AI 功能时，聊天上下文、知识库材料、图片或队友记忆可能按对应功能说明发送到所选模型；可在模型设置中更换服务商，不代表阻止出网。</p>
        <p className={css.lead}>{AVATAR_NOTE}</p>
      </CanvasCard>

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
            {AI_FEATURES.map(f => (
              <div key={f.name} className={css.aiRow}>
                <span className={css.aiName}>☁️ {f.name}</span>
                <span className={kitCss.textMeta}>{f.desc}</span>
              </div>
            ))}
          </div>
        </CanvasCard>

      <CanvasCard id="trust-audit" title="AI 出站审计" extra={<span className={kitCss.textCaption}>每次放行的功能、次数与字符数</span>}>
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
        {!loading && !scan && !error && <div className={kitCss.emptyInline}>尚无扫描结果 —— 侧栏「隐私体检」页点一次扫描即可</div>}
        {error && <ErrorState message={error} />}
        {scan && (
          <div className={css.scanSummary}>
            <span><b>{scan.total_hits}</b> 命中</span>
            <span><b>{scan.involved_sessions}</b> 会话</span>
            <span className={kitCss.textCaption}>分类明细与高风险联系人见侧栏「隐私体检」</span>
          </div>
        )}
      </CanvasCard>
      </CardCanvas>

      <ExportProgressStatus state={exportTask.state} />

      <p className={css.footnote}>说明：敏感字段打码与 AI 调用审计均为本机即时生效；本地模型优先切换为后续项。应用内已没有任何出网开关（2026-09-30 起全部移除）。审计记录的是**被放行去出站**的调用次数与字符数（含随后因密钥/网络被模型方拒绝的）。</p>
    </div>
  )
}
