/**
 * 隐私与信任页 — 明示本地/AI 功能边界，并聚合隐私体检结果（敏感信息扫描、
 * 高风险联系人/群）。审计开关与打码自动化为后续项。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiClearPrivacyAudit, apiGetPrivacyAuditRows, apiGetPrivacyState, apiSetPrivacyState, readRenderCache, writeRenderCache } from '../api.ts'
import type { PrivacyAuditRow, PrivacySnapshot, PrivacyStateSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Button, Card, PanelHeader } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './privacy-trust.module.css'
import { useWechatDataUpdated } from './hooks.tsx'

const LOCAL_FEATURES = [
  '搜索 / 全库统一搜索', '统计与总览', '导出（CSV/HTML/TXT 等）', '关系图谱',
  '资金账本', '联系人 360°', '群聊洞察', '朋友圈洞察', '数据健康', '备份管家', '隐私体检',
  '待办提取（本地关键词匹配，不调用模型）',
]

/**
 * 会真正把内容发到模型的四个功能。
 *
 * 第 59 轮修正了一处**界面上的假话**：原来这里写着「待办提取：调用所选模型提取待办 JSON」，
 * 但 `extractTasks` 实测是本地正则（`记得|待办|要做|提醒|…`）逐行匹配、全程不出网 ——
 * 名单写错会让用户以为「关掉出网就能拦住待办」，而它本来就没出网；
 * 同时真正的出网功能「群总结任务」却不在名单里。名单现在与 gateway 里的 `privacyGate(...)`
 * 调用点一一对应（features: ask_wechat / daily_summary / summary_task / period_summary）。
 */
const AI_FEATURES: ReadonlyArray<{ name: string; desc: string }> = [
  { name: '微信问答', desc: '检索本机聊天片段后调用所选模型生成回答' },
  { name: '每日总结', desc: '收集当日消息后调用所选模型生成要点' },
  { name: '周期总结', desc: '收集区间消息后调用所选模型生成要点' },
  { name: '群总结任务', desc: '按定时任务收集指定群当日消息后调用所选模型生成总结' },
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
}

/**
 * 头像图片是本项目里**唯一会主动出网的非 AI 请求**（第 41 轮）。
 * 实测：本地 `head_image.db` 只覆盖通讯录的 17.4%，而 1,994 个联系人有头像地址
 * （https 1,594 个）；只显示本地那 17% 会让通讯录几乎整列空白。
 * 这里在「数据边界」里如实写明，避免界面宣称「纯本地」却暗中发图片请求。
 */
const AVATAR_NOTE = '头像图片是唯一例外：本地未缓存时（实测通讯录约 82%），会按微信记录的头像地址以 https 从腾讯图片 CDN（wx.qlogo.cn / mmhead.c2c.wechat.com 等）加载；不涉及聊天内容。'

/**
 * Render the privacy & trust panel.
 * @param props - `embedded`：作为「微信数据配置」弹窗里的一节渲染，不再自建 height:100%
 *   的滚动容器与内边距（由弹窗右区负责滚动）。
 * @returns the privacy trust element tree.
 */
export function PrivacyTrustPanel({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const [scan, setScan] = useState<PrivacySnapshot | null>(() => readRenderCache<PrivacySnapshot>('privacy-scan'))
  const [state, setState] = useState<PrivacyStateSnapshot | null>(() => readRenderCache<PrivacyStateSnapshot>('privacy-state'))
  const [rows, setRows] = useState<readonly PrivacyAuditRow[]>(() => readRenderCache<readonly PrivacyAuditRow[]>('privacy-audit-rows') ?? [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const cachedScan = readRenderCache<PrivacySnapshot>('privacy-scan')
      const cachedState = readRenderCache<PrivacyStateSnapshot>('privacy-state')
      const cachedRows = readRenderCache<readonly PrivacyAuditRow[]>('privacy-audit-rows')
      if (cachedScan) setScan(cachedScan)
      if (cachedState) setState(cachedState)
      if (cachedRows) setRows(cachedRows)
      // 全库敏感信息扫描较重：本页只读取设置与审计记录，扫描结果沿用渲染缓存；
      // 需要最新结果时前往「隐私体检」页点击扫描。
      const [st, rws] = await Promise.all([
        apiGetPrivacyState(),
        apiGetPrivacyAuditRows().catch((): never[] => []),
      ])
      setState(st)
      setRows(rws)
      writeRenderCache('privacy-state', st)
      writeRenderCache('privacy-audit-rows', rws)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  // 数据落地后重载：冷启动时后端同步要跑 2–3 分钟，期间首次请求可能返回空快照，
  // 页面会停在「0 / 暂无数据」而并非真的没有数据（实测该事件在同步期约每 10 秒一次）。
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费，
  // 也避免那几个「loading 时隐藏内容」的面板每约 10 秒白闪一次。
  useWechatDataUpdated(() => { if (!state) void load() })

  const toggle = useCallback(async (key: 'redactSensitive' | 'blockOutbound', value: boolean): Promise<void> => {
    try {
      setState(await apiSetPrivacyState({ [key]: value }))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const exportAudit = useCallback((): void => {
    const header = 'id,feature,ts,chars,sessions,messages'
    const lines = rows.map(r => `${r.id},${r.feature},${r.ts},${r.chars},${r.sessions},${r.messages}`)
    const blob = new Blob(['\uFEFF' + header + '\n' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'wechat-privacy-audit.csv'
    a.click()
    URL.revokeObjectURL(url)
  }, [rows])

  const clearAudit = useCallback(async (): Promise<void> => {
    try {
      await apiClearPrivacyAudit()
      setRows([])
      setState(await apiGetPrivacyState())
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  return (
    <div className={embedded ? css.embedded : kitCss.panelShell}>
      <PanelHeader title="数据边界与出网" desc="数据边界 · AI 出网说明 · 敏感信息扫描结果" />

      <Card title="数据边界">
        <p className={css.lead}>微信数据在本机解析/入库/分析；检索统计、导出、图谱、备份等均为纯本地操作。启用 AI 功能时，只有检索到的聊天片段会发送到所选 LLM 模型，可在模型设置中更换或调整。</p>
        <p className={css.lead}>{AVATAR_NOTE}</p>
      </Card>

      <Card title="防护设置">
        {state ? (
          <div className={css.toggles}>
            <button type="button" className={css.toggle} data-active={state.redactSensitive} onClick={() => { void toggle('redactSensitive', !state.redactSensitive) }}>
              敏感字段打码（手机号/身份证/银行卡/邮箱/口令） · {state.redactSensitive ? '开' : '关'}
            </button>
            <button type="button" className={css.toggle} data-active={state.blockOutbound} onClick={() => { void toggle('blockOutbound', !state.blockOutbound) }}>
              禁止 AI 出网（问答 / 每日总结 / 周期总结 / 群总结任务 一律不调用模型） · {state.blockOutbound ? '开' : '关'}
            </button>
          </div>
        ) : (
          <div className={kitCss.emptyInline}>设置加载中…</div>
        )}
      </Card>

      <div className={kitCss.cardGrid}>
        <Card title="纯本地功能">
          <div className={css.chipGrid}>
            {LOCAL_FEATURES.map(f => <span key={f} className={css.localChip}>🔒 {f}</span>)}
          </div>
        </Card>

        <Card title="AI 功能（出网）">
          <div className={css.aiList}>
            {AI_FEATURES.map(f => (
              <div key={f.name} className={css.aiRow}>
                <span className={css.aiName}>☁️ {f.name}</span>
                <span className={kitCss.textMeta}>{f.desc}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="AI 出站审计" extra={<span className={kitCss.textCaption}>每次放行的功能、次数与字符数</span>}>
        {!state ? (
          <div className={kitCss.emptyInline}>设置加载中…</div>
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
          <Button variant="pill" onClick={exportAudit} disabled={rows.length === 0}>导出审计 CSV</Button>
          <Button variant="pill" onClick={() => { void clearAudit() }} disabled={state?.audit.total === 0}>清空审计</Button>
        </div>
      </Card>

      <Card title="隐私体检（敏感信息扫描）">
        {loading && !scan && <div className={kitCss.emptyInline}>扫描结果加载中…</div>}
        {!loading && !scan && !error && <div className={kitCss.emptyInline}>最新扫描结果请前往「隐私体检」页点击扫描后展示</div>}
        {error && <div className={css.error}>{error}</div>}
        {scan && (
          <>
            <div className={css.scanSummary}>
              {/* 此处原写作 css.stat，但 privacy-trust.module.css 从未定义 .stat
                  （undefined 的 className 等于没有类）。样式实际由 .scanSummary
                  与 .scanSummary b 提供，故去掉这个无效引用即可，行为不变。 */}
              <span><b>{scan.total_hits}</b> 命中</span>
              <span><b>{scan.involved_sessions}</b> 会话</span>
            </div>
            <div className={css.catList}>
              {scan.categories.map(c => (
                <div key={c.key} className={css.catRow}>
                  <span className={css.catIcon}>{c.icon}</span>
                  <span className={css.catLabel}>{c.label}</span>
                  <span className={css.catCount}>{c.count}</span>
                </div>
              ))}
            </div>
            {scan.top_contacts.length > 0 && (
              <div className={css.risk}>
                <div className={css.riskTitle}>高风险联系人</div>
                <div className={css.chipGrid}>
                  {scan.top_contacts.slice(0, 8).map(t => (
                    <span key={t.username} className={css.riskChip}>{t.name} · {t.count}</span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      <p className={css.footnote}>说明：敏感字段打码、禁止出网与 AI 调用审计均为本机即时生效；本地模型优先切换为后续项。审计记录的是**被放行去出站**的调用次数与字符数（含随后因密钥/网络被模型方拒绝的），被「禁止出网」拦下的调用不计入。</p>
    </div>
  )
}
