/**
 * 隐私体检面板 — React 版，忠实迁移 PrivacyScan.svelte：扫描本地消息中的
 * 隐私风险（手机号/身份证/银行卡/邮箱/密码/地址），按类别聚合样本（可展开/
 * 跳转定位）+ 风险联系人/群 Top10 + CSV 报告导出。走 Remote（getPrivacyScan）。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiExportCsv, apiGetPrivacyScan, readRenderCache, writeRenderCache } from '../api.ts'
import type { PrivacySnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, clickableKey, PanelHeader } from '../ui/kit.tsx'
import css from './list-panel.module.css'
import kitCss from '../ui/kit.module.css'

/**
 * 体检项：与后端 `query/privacy.ts` 的 CATEGORIES 一一对应（顺序、label、icon 都保持一致，
 * 由 privacy-landing.wiring.spec.ts 对着后端源码断言，防止两处漂移）。
 * desc 是"它长什么样"的人话说明 —— 用户在看到结果前需要知道自己在找什么。
 */
const PRIVACY_ITEMS: ReadonlyArray<{ key: string; label: string; icon: string; desc: string }> = [
  { key: 'phone', label: '手机号', icon: '📱', desc: '1[3-9] 开头的 11 位号码' },
  { key: 'id_card', label: '身份证号', icon: '🪪', desc: '18 位（含末位校验）' },
  { key: 'bank_card', label: '银行卡号', icon: '💳', desc: '62 / 4 / 5 开头的卡号' },
  { key: 'email', label: '邮箱', icon: '✉️', desc: 'xxx@yyy.zz 形态' },
  { key: 'password', label: '密码口令', icon: '🔑', desc: '「密码：…」这类明文口令' },
  { key: 'address', label: '地址信息', icon: '📍', desc: '小区 / 门牌 / 大厦等住址' },
]

/**
 * 体检范围：优先用总览已缓存的规模数字（同一份数据，不额外查库）。
 * 总览没打开过就退化成只说"本机解密库全部消息"，不阻塞、不额外发请求。
 */
function readScope(): { sessions: number | null; messages: number | null } {
  try {
    const base = JSON.parse(localStorage.getItem('dsh-wechat-overview-base-v1') ?? 'null') as { sessions?: number } | null
    const ins = JSON.parse(localStorage.getItem('dsh-wechat-overview-insights-v1') ?? 'null') as { messages?: { total?: number } } | null
    return {
      sessions: typeof base?.sessions === 'number' ? base.sessions : null,
      messages: typeof ins?.messages?.total === 'number' ? ins.messages.total : null,
    }
  } catch {
    return { sessions: null, messages: null }
  }
}

/**
 * 体检落地态 / 扫描中。
 *
 * 此前这里只有一行居中文字（"体检你的微信数据：扫描手机号 / 身份证 / …"），
 * 实测在 802px 高的内容区里留下 668px 连续空白（占比 87%）——
 * 用户既不知道要扫多久、也不知道扫完能拿到什么。现在把它补成完整的落地页：
 *   ① 会扫描什么（范围，带真实规模数字）  ② 结果能做什么
 *   ③ 六个体检项（各自在找什么）          ④ 隐私边界（全程本机）
 */
function PrivacyLanding({ scanning }: { scanning: boolean }): React.JSX.Element {
  const { sessions, messages } = readScope()
  const scope = sessions !== null || messages !== null
    ? `本机解密库的全部消息${sessions !== null ? ` · ${sessions.toLocaleString()} 个会话` : ''}${messages !== null ? ` · ${messages.toLocaleString()} 条消息` : ''}`
    : '本机解密库的全部消息'
  return (
    <div className={css.pvLand}>
      <div className={css.pvLandGrid}>
        <div className={css.pvLandCard}>
          <h4 className={css.pvLandTitle}>{scanning ? '正在扫描…' : '会扫描什么'}</h4>
          <p className={css.pvLandScope}>{scope}</p>
          <ul className={css.pvLandList}>
            <li>逐条匹配下面 6 类敏感信息，命中即留样本（前后 24 字上下文）</li>
            <li>统计命中所属的会话与联系人，形成风险排行</li>
            <li>结果只写在本机渲染缓存里，退出即失效</li>
          </ul>
        </div>
        <div className={css.pvLandCard}>
          <h4 className={css.pvLandTitle}>结果能做什么</h4>
          <ul className={css.pvLandList}>
            <li>按类别聚合命中条数，展开看具体样本</li>
            <li>点样本直接跳到那条消息所在会话定位</li>
            <li>风险联系人 / 群 Top 10，判断该清理哪一段聊天</li>
            <li>一键导出 CSV 风险清单</li>
          </ul>
        </div>
        <div className={css.pvLandCard}>
          <h4 className={css.pvLandTitle}>体检不会做什么</h4>
          <ul className={css.pvLandList}>
            <li>不修改、不删除任何消息 —— 只读扫描</li>
            <li>不联网、不上传，命中内容不出本机</li>
            <li>不写入数据库，重启后结果需重新扫描</li>
          </ul>
        </div>
      </div>
      <div className={css.pvItems}>
        {PRIVACY_ITEMS.map((it) => (
          <div key={it.key} className={css.pvItem} title={`${it.label}：${it.desc}`}>
            <span className={css.pvItemIcon}>{it.icon}</span>
            <span className={css.pvItemText}>
              <span className={css.pvItemLabel}>{it.label}</span>
              <span className={css.pvItemDesc}>{it.desc}</span>
            </span>
          </div>
        ))}
      </div>
      <div className={css.pvGuard}>
        <span className={css.pvGuardIcon}>🔒</span>
        <span>全程在本机完成：不联网、不上传，扫描只读取已解密的本地库{scanning ? '；全库扫描通常需要数十秒，中途不要切走页签' : '；全库扫描较重，建议在空闲时执行'}。</span>
      </div>
    </div>
  )
}

/**
 * Render the privacy-scan panel.
 * @param props - `onOpenChat` 跳到某条命中所属的会话；
 *   `embedded`：作为「微信数据配置」弹窗里的一节渲染，整页交给弹窗右区滚动
 *   （本页内层的 .scroll 不再自建滚动区）。
 * @returns the privacy element tree.
 */
export function PrivacyPanel({ onOpenChat, embedded = false }: {
  onOpenChat?: (username: string, localId?: number) => void
  embedded?: boolean
}): React.JSX.Element {
  const [data, setData] = useState<PrivacySnapshot | null>(() => readRenderCache<PrivacySnapshot>('privacy-scan'))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [showMore, setShowMore] = useState<ReadonlySet<string>>(new Set())

  const scan = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    const cached = readRenderCache<PrivacySnapshot>('privacy-scan')
    if (cached) setData(cached)
    try {
      const fresh = await apiGetPrivacyScan()
      setData(fresh)
      writeRenderCache('privacy-scan', fresh)
    } catch (e) {
      if (!cached) setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  // 全库敏感信息扫描较重：不再在打开页签时自动执行，由用户点击「开始扫描」触发；
  // 已有渲染缓存时直接展示缓存，避免白屏。
  useEffect(() => {
    const cached = readRenderCache<PrivacySnapshot>('privacy-scan')
    if (cached) setData(cached)
  }, [])

  const toggleCat = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const moreSamples = (key: string): void => {
    setShowMore((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const exportCsv = async (): Promise<void> => {
    try {
      const r = await apiExportCsv({ kind: 'privacy' })
      window.alert(`已导出风险清单 ${r.count} 条 → ${r.path}`)
    } catch (e) {
      window.alert('导出失败: ' + (e as Error).message)
    }
  }

  const involved = data?.involved_sessions ?? 0
  const totalHits = data?.total_hits ?? 0

  return (
    <div className={embedded ? css.panelEmbedded : css.panel}>
      <PanelHeader
        title="隐私体检"
        desc={data ? `命中 ${totalHits} 条 · 涉及 ${involved} 个会话` : '扫描手机号 / 身份证 / 银行卡 / 邮箱 / 密码 / 地址等敏感信息'}
        actions={(
          <>
            <button type="button" className={css.catBtn} data-active="true" onClick={() => { void scan() }} disabled={loading}>
              {loading ? '扫描中…' : data ? '重新扫描' : '开始扫描'}
            </button>
            {data && <button type="button" className={css.catBtn} onClick={() => { void exportCsv() }}>导出报告</button>}
          </>
        )}
      />
      {error && <div className={kitCss.error} role="alert">⚠️ {error}</div>}
      {/* 落地态与扫描中共用同一套结构：扫描期间把范围/体检项留着，
          用户知道"在扫什么、还要等什么"，而不是盯着一个词加满屏空白。 */}
      {!error && !data && <PrivacyLanding scanning={loading} />}
      {!error && data && (
        <div className={css.scroll}>
          {data.categories.map((c) => {
            const open = expanded.has(c.key)
            const more = showMore.has(c.key)
            const samples = c.samples.slice(0, more ? 200 : 5)
            return (
              <div key={c.key} className={`${css.row} ${css.pvCatRow}`}>
                <div className={css.pvCatHd} {...clickableKey(() =>{  toggleCat(c.key) })}>
                  <span className={css.rowIcon}>{c.icon}</span>
                  <span className={`${css.rowName} ${css.pvCatLabel}`}>{c.label}</span>
                  <span className={css.rowTime}>{c.count} 条{open ? ' ▾' : ' ▸'}</span>
                </div>
                {open && (
                  <div className={css.pvSamples}>
                    {samples.length === 0 && <div className={`${css.empty} ${css.pvEmptyInline}`}>无命中样本</div>}
                    {samples.map((s, i) => (
                      <div key={i} className={css.pvSampleRow}>
                        <div className={css.pvSampleHd}>
                          <span className={css.pvSampleName}>{s.name || s.username}</span>
                          <span className={css.rowTime}>{s.time}</span>
                          {onOpenChat && (
                            <button type="button" className={`${css.catBtn} ${css.pvJump}`} onClick={() =>{  onOpenChat(s.username, s.local_id) }}>跳转 ›</button>
                          )}
                        </div>
                        <div className={`${kitCss.textMeta} ${css.pvSnippet}`}>{s.snippet}</div>
                      </div>
                    ))}
                    {c.samples.length > 5 && (
                      <button type="button" className={`${css.catBtn} ${css.pvMore}`} onClick={() =>{  moreSamples(c.key) }}>
                        {more ? '收起' : `展开更多（共 ${c.samples.length} 条）`}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {data.top_contacts.length > 0 && (
            <Card title="风险联系人 TOP10">
              {data.top_contacts.map((c, i) => (
                <div key={c.username} className={css.barRow} title={c.name || c.username}>
                  <span className={css.barLabel}>{i + 1}. {c.name || c.username}</span>
                  <div className={css.barTrack}><div className={css.barFill} style={{ width: `${(c.count / (data.top_contacts[0]?.count ?? 1)) * 100}%` }} /></div>
                  <span className={css.barValue}>{c.count} 条</span>
                </div>
              ))}
            </Card>
          )}
          {data.top_groups.length > 0 && (
            <Card title="风险群聊 TOP10">
              {data.top_groups.map((c, i) => (
                <div key={c.username} className={css.barRow} title={c.name || c.username}>
                  <span className={css.barLabel}>{i + 1}. {c.name || c.username}</span>
                  <div className={css.barTrack}><div className={css.barFill} style={{ width: `${(c.count / (data.top_groups[0]?.count ?? 1)) * 100}%` }} /></div>
                  <span className={css.barValue}>{c.count} 条</span>
                </div>
              ))}
            </Card>
          )}
          {totalHits === 0 && <div className={css.empty}>无命中 · 本地消息中未发现敏感信息</div>}
        </div>
      )}
    </div>
  )
}
