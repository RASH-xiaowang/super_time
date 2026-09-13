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
      {!error && loading && !data && <div className={css.empty}>正在扫描本地消息中的敏感信息…</div>}
      {!error && !loading && !data && <div className={css.empty}>体检你的微信数据：扫描手机号 / 身份证 / 银行卡 / 邮箱 / 密码 / 地址等敏感信息。</div>}
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
