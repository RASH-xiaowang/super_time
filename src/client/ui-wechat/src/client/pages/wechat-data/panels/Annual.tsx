/**
 * 年度总结面板 — 忠实迁移 AnnualSummary：年份选择 + 年度报告（Hero/人物标签/
 * 周活跃热力图/月度/消息类型/高频短语/表情宇宙/人际榜/首末句）。仅本地计算。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiExportAnnualReport, apiGetAnnual, apiGetAnnualReport, pickDirectory, readRenderCache, writeRenderCache } from '../api.ts'
import type { AnnualReport } from '@deepseek-ai/dsh-wechat-data/types'
import { ListSkeleton, useWechatDataUpdated } from './hooks.tsx'
import { Card, PanelHeader, Segmented, Toolbar } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './list-panel.module.css'
import { fmtPct } from '../utils/format.ts'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/** 数字缩写。 */
function fmtNum(n: number): string { if (n >= 10000) return (n / 10000).toFixed(1) + 'w'; if (n >= 1000) return (n / 1000).toFixed(1) + 'k'; return String(n) }

/** FancyUI-style Marquee: a horizontally auto-scrolling row, pause on hover, edge fade. */
function Marquee({ reverse, duration, children }: {
  reverse?: boolean
  duration?: number
  children: React.ReactNode[]
}): React.JSX.Element {
  return (
    <div className={css.marquee}>
      <div className={css.marqueeTrack} data-reverse={reverse || undefined} style={{ animationDuration: `${duration ?? 20}s` }}>
        {children}{children}
      </div>
      <div className={css.marqueeMaskL} aria-hidden="true" />
      <div className={css.marqueeMaskR} aria-hidden="true" />
    </div>
  )
}

/** Marquee card tile (ReviewCard-style content: icon / title / meta). */
function MarqueeCard({ icon, title, meta }: { icon?: string; title: string; meta: string }): React.JSX.Element {
  return (
    <div className={css.marqueeCard}>
      {icon && <span className={css.marqueeCardIcon}>{icon}</span>}
      <div className={css.marqueeCardBody}>
        <div className={css.marqueeCardTitle}>{title}</div>
        <div className={css.marqueeCardMeta}>{meta}</div>
      </div>
    </div>
  )
}

/** Split an array into rows of n for marquee layout. */
function splitRows<T>(arr: T[], n: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < arr.length; i += n) rows.push(arr.slice(i, i + n))
  return rows
}

/** FancyUI-style Focus: a prominent typographic sentence (eyebrow + statement). */
function Focus({ sentence, eyebrow }: { sentence: string; eyebrow?: string }): React.JSX.Element {
  return (
    <div className={css.focus}>
      {eyebrow !== undefined && <div className={css.focusEyebrow}>{eyebrow}</div>}
      <div className={css.focusSentence}>{sentence}</div>
    </div>
  )
}

/** 渲染年度总结长图（Canvas 海报），返回 canvas。 */
function drawAnnualPoster(r: AnnualReport): HTMLCanvasElement {
  const W = 1200
  const H = 1900
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')
  if (!ctx) return c
  const accent = '#22d3ee'
  const fg = '#e6ebf2'
  const muted = '#8ea3b8'
  const bg = ctx.createLinearGradient(0, 0, 0, H)
  bg.addColorStop(0, '#0b0e13')
  bg.addColorStop(1, '#101a26')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  ctx.textAlign = 'left'
  let y = 90

  const title = String(r.year) + ' 微信年度总结'
  ctx.font = '800 56px sans-serif'
  ctx.fillStyle = accent
  ctx.fillText(title, 70, y)
  y += 26
  ctx.font = '400 18px sans-serif'
  ctx.fillStyle = muted
  ctx.fillText('总消息 ' + fmtNum(r.total) + ' 条 · 活跃 ' + String(r.active_days) + ' 天 · 文字 ' + fmtNum(r.text_chars) + ' 字 · 日均 ' + String(r.daily_avg) + ' 条', 70, y)
  y += 40
  if (r.persona_tags.length > 0) {
    ctx.font = '600 20px sans-serif'
    ctx.fillStyle = fg
    ctx.fillText('人物标签', 70, y)
    y += 34
    ctx.font = '500 17px sans-serif'
    let px = 70
    for (const t of r.persona_tags) {
      const w = ctx.measureText('#' + t).width + 26
      ctx.fillStyle = 'rgba(34,211,238,0.12)'
      roundRect(ctx, px, y - 24, w, 30, 15)
      ctx.fill()
      ctx.fillStyle = accent
      ctx.fillText('#' + t, px + 13, y - 4)
      px += w + 10
    }
    y += 40
  }

  const section = (t: string): void => {
    ctx.font = '800 30px sans-serif'
    ctx.fillStyle = fg
    ctx.fillText(t, 70, y)
    y += 26
    ctx.fillStyle = accent
    ctx.fillRect(70, y, 70, 4)
    y += 34
  }

  section('类型占比')
  const shares: Array<[string, number]> = [
    ['文字', r.text_share], ['深夜', r.night_share], ['清晨', r.morning_share], ['周末', r.weekend_share], ['群聊', r.group_share],
  ]
  const maxShare = Math.max(0.01, ...shares.map(s2 => s2[1]))
  for (const [label, v] of shares) {
    ctx.font = '500 20px sans-serif'
    ctx.fillStyle = fg
    ctx.fillText(label, 70, y)
    const bx = 190
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.fillRect(bx, y - 16, 620, 14)
    ctx.fillStyle = accent
    ctx.fillRect(bx, y - 16, Math.max(6, (v / maxShare) * 620), 14)
    ctx.fillStyle = muted
    ctx.textAlign = 'right'
    ctx.fillText(String(Math.round(v * 100)) + '%', W - 70, y)
    ctx.textAlign = 'left'
    y += 44
  }
  y += 8

  section('周活跃热力图（星期 × 小时）')
  const heatMax = Math.max(1, ...r.heat)
  const cell = 38
  const hx = 70
  const hy = y
  for (let i = 0; i < r.heat.length; i++) {
    const v = r.heat[i] ?? 0
    const col = i % 24
    const row = Math.floor(i / 24)
    ctx.fillStyle = 'rgba(34,211,238,' + String(v > 0 ? Math.max(0.08, v / heatMax) : 0.03) + ')'
    ctx.fillRect(hx + col * cell, hy + row * cell, cell - 3, cell - 3)
  }
  ctx.font = '500 14px sans-serif'
  ctx.fillStyle = muted
  for (let d = 0; d < 7; d++) {
    ctx.fillText(WEEKDAYS[d] ?? '', hx - 34, hy + d * cell + cell - 8)
  }
  y += 7 * cell + 34

  section('月度活跃')
  const monthlyMax = Math.max(1, ...r.monthly)
  const barH = 200
  for (let i = 0; i < 12; i++) {
    const v = r.monthly[i] ?? 0
    const bw = 72
    const bx = 70 + i * 92
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.fillRect(bx, y + barH, bw, -barH)
    const h = Math.max(6, (v / monthlyMax) * barH)
    ctx.fillStyle = 'rgba(34,211,238,0.7)'
    ctx.fillRect(bx, y + barH - h, bw, h)
    ctx.font = '500 15px sans-serif'
    ctx.fillStyle = muted
    ctx.textAlign = 'center'
    ctx.fillText(String(i + 1), bx + bw / 2, y + barH + 26)
    ctx.textAlign = 'left'
  }
  y += barH + 56

  if (r.top_phrases.length > 0) {
    section('高频短语')
    ctx.font = '500 18px sans-serif'
    let px = 70
    let py = y
    for (const ph of r.top_phrases.slice(0, 12)) {
      const label = ph.phrase + '(' + String(ph.count) + ')'
      const w = ctx.measureText(label).width + 22
      if (px + w > W - 70) { px = 70; py += 38 }
      ctx.fillStyle = 'rgba(255,255,255,0.07)'
      roundRect(ctx, px, py - 22, w, 30, 15)
      ctx.fill()
      ctx.fillStyle = fg
      ctx.fillText(label, px + 11, py - 2)
      px += w + 8
    }
    y = py + 40
  }

  if (r.top_emoji.length > 0) {
    section('表情宇宙')
    ctx.font = '500 22px sans-serif'
    ctx.fillStyle = fg
    ctx.fillText(r.top_emoji.slice(0, 8).map(e => e.emoji + '×' + String(e.count)).join('  '), 70, y)
    y += 36
  }

  const rank = (t: string, items: Array<{ username: string; name?: string; count: number }>): void => {
    section(t)
    const max = Math.max(1, items[0]?.count ?? 1)
    for (const it of items.slice(0, 8)) {
      ctx.font = '500 19px sans-serif'
      ctx.fillStyle = fg
      ctx.fillText(it.name || it.username, 70, y)
      ctx.fillStyle = 'rgba(255,255,255,0.08)'
      ctx.fillRect(330, y - 14, 480, 12)
      ctx.fillStyle = accent
      ctx.fillRect(330, y - 14, Math.max(6, (it.count / max) * 480), 12)
      ctx.fillStyle = muted
      ctx.textAlign = 'right'
      ctx.fillText(String(it.count) + ' 条', W - 70, y)
      ctx.textAlign = 'left'
      y += 38
    }
    y += 10
  }
  if (r.top_contacts.length > 0) rank('聊得最多的人', r.top_contacts)
  if (r.top_groups.length > 0) rank('最活跃的群聊', r.top_groups)

  section('年度首尾句')
  ctx.font = '400 20px sans-serif'
  ctx.fillStyle = muted
  ctx.fillText('首句', 70, y)
  y += 30
  ctx.fillStyle = fg
  ctx.fillText(trunc(r.first_message ?? '', 44), 70, y)
  y += 38
  ctx.fillStyle = muted
  ctx.fillText('末句', 70, y)
  y += 30
  ctx.fillStyle = fg
  ctx.fillText(trunc(r.last_message ?? '', 44), 70, y)

  ctx.font = '500 16px sans-serif'
  ctx.fillStyle = muted
  ctx.textAlign = 'center'
  ctx.fillText('由 deepseek-harness · 本地解密生成', W / 2, H - 40)
  ctx.textAlign = 'left'
  return c
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + rr, rr)
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  ctx.arcTo(x, y + h, x + rr, y + h, rr)
  ctx.arcTo(x, y + h - rr, x, y + h, rr)
  ctx.closePath()
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

/**
 * Render the annual-summary panel.
 * @returns the annual element tree.
 */
export function AnnualPanel(): React.JSX.Element {
  const [years, setYears] = useState<readonly number[]>([])
  const [year, setYear] = useState(0)
  const [report, setReport] = useState<AnnualReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [expDir, setExpDir] = useState('')
  const [pickingDir, setPickingDir] = useState(false)

  const loadYears = useCallback(async (selectFirst: boolean): Promise<void> => {
    try {
      const env = await apiGetAnnual()
      const ys = env.years.filter(n => Number.isFinite(n) && n > 2000)
      setYears(ys)
      // 数据更新触发的重载**不能**重置用户已选的年份，否则正在看的报告会跳走。
      if (selectFirst && ys.length > 0) setYear(ys[0] as number)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => { void loadYears(true) }, [loadYears])

  // 数据落地后重载年份列表（冷启动同步窗口内首次请求可能返回空快照）。
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费，
  // 也避免那几个「loading 时隐藏内容」的面板每约 10 秒白闪一次。
  useWechatDataUpdated(() => { if (years.length === 0) void loadYears(false) })

  const loadReport = useCallback(async (y: number): Promise<void> => {
    if (!y) return
    setError(null)
    const cached = readRenderCache<AnnualReport>(`annual:${y}`)
    if (cached) {
      setReport(cached)
      setLoading(false)
    } else {
      setLoading(true)
    }
    try {
      const r = await apiGetAnnualReport({ year: y })
      setReport(r)
      writeRenderCache(`annual:${y}`, r)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  // 年度报告按需计算：选中/点击某个年份时才生成，不再进入页签就自动跑全量年度统计。
  //
  // 第 64 轮补了一条「有缓存就直接显示」的近路：`getAnnualReport` 实测**约 2.4 秒**
  // （2026 年、139k 条消息、按 create_time 走索引，已经是年粒度查询），
  // 所以进面板自动跑是不合适的；但**本地已经有缓存**时（`annual:<年份>` 写在 localStorage）
  // 再让用户点一下纯属白等 —— 现在挂载后若命中缓存就直接渲染。
  // 没有缓存的首次访问保持手动，并把实测代价写进提示（见下面的 hint）。
  const pickYear = useCallback((y: number): void => {
    setYear(y)
    void loadReport(y)
  }, [loadReport])
  useEffect(() => {
    // 只在「年份已选、还没有报告」时补一次；loadReport 内部会先读缓存，
    // 命中则同步 setReport（无网络/后端开销），未命中会走接口 —— 这里用 cached 判断避免后者。
    if (!year || report) return
    const cached = readRenderCache<AnnualReport>('annual:' + String(year))
    if (cached) void loadReport(year)
  }, [year, report, loadReport])

  const doExport = async (format: string): Promise<void> => {
    if (!year) return
    try {
      const opts: { year: number; format: string; dir?: string } = { year, format }
      if (expDir) opts.dir = expDir
      const r = await apiExportAnnualReport(opts)
      setNotice('已导出 ' + String(r.count) + ' 条 → ' + r.path)
      setTimeout(() => { setNotice(null) }, 5000)
    } catch (e) {
      setNotice('导出失败: ' + (e as Error).message)
    }
  }

  const chooseExportDir = async (): Promise<void> => {
    if (pickingDir) return
    setPickingDir(true)
    try {
      const dir = await pickDirectory()
      if (dir) setExpDir(dir)
    } finally {
      setPickingDir(false)
    }
  }

  const doExportPng = (): void => {
    if (!report) return
    try {
      const canvas = drawAnnualPoster(report)
      const url = canvas.toDataURL('image/png')
      const a = document.createElement('a')
      a.href = url
      a.download = '微信年度总结_' + String(report.year) + '.png'
      a.click()
      setTimeout(() => { URL.revokeObjectURL(url) }, 2000)
      setNotice('已生成年度总结长图，请查看下载')
      setTimeout(() => { setNotice(null) }, 5000)
    } catch (e) {
      setNotice('长图生成失败: ' + (e as Error).message)
    }
  }

  const heatMax = Math.max(1, ...(report?.heat ?? []))
  const monthlyMax = Math.max(1, ...(report?.monthly ?? []))
  const topContactShare = report?.top_contacts[0]?.share ?? 0
  const topGroupShare = report?.top_groups[0]?.share ?? 0

  return (
    <div className={css.panel}>
      <PanelHeader title="年度总结" desc="从解密数据中生成的微信年度报告 · 仅本地计算" />
      <Toolbar
        left={years.length > 0 ? (
          <Segmented
            options={years.map(y => ({ value: String(y), label: String(y) }))}
            value={String(year || '')}
            onChange={(v) => { pickYear(Number(v)) }}
            ariaLabel="年度选择"
          />
        ) : undefined}
        right={(
          <>
            <button type="button" className={css.catBtn} onClick={() => { void doExport('md') }}>导出 MD</button>
            <button type="button" className={css.catBtn} onClick={() => { void doExport('html') }}>导出 HTML</button>
            <button type="button" className={css.catBtn} onClick={() => { void doExport('json') }}>导出 JSON</button>
            <button type="button" className={css.catBtn} onClick={doExportPng}>导出长图 PNG</button>
            <button type="button" className={css.catBtn} onClick={() => { void chooseExportDir() }} disabled={pickingDir}>选择目录{expDir ? ' ✓' : ''}</button>
            {expDir && <span className={kitCss.textMeta} title={expDir}>{expDir}</span>}
          </>
        )}
      />
      {notice && <div className={kitCss.textMeta}>{notice}</div>}
      {loading && !report && <ListSkeleton rows={10} />}
      {error && <div className={kitCss.error} role="alert">⚠️ {error}</div>}
      {!loading && !error && !report && years.length === 0 && <div className={css.empty}>还没有可统计的消息数据</div>}
      {!loading && !error && !report && years.length > 0 && (
        /*
         * 这里必须是**可点的按钮**，不能只是一句「点击上方年份生成」的提示。
         *
         * 第 64 轮实测的洞：挂载时 `loadYears(true)` 已经把年份选成第一个（本机只有 2026），
         * 于是上方 Segmented 上「2026」**已经处于选中态**；单选 ToggleGroup 再点同一个值
         * 不会触发 onChange ⇒ `pickYear` 永远不跑 ⇒ 面板永远停在提示上（实测连点 20 秒无反应、无报错）。
         * 现在把提示本身做成生成入口，选没选中都能生成。
         */
        <div className={css.empty}>
          <button type="button" className={css.catBtn} onClick={() => { pickYear(year) }}>
            生成 {year} 年度报告
          </button>
          <div className={kitCss.textMeta}>
            本机统计约 2–3 秒；生成过会缓存，再次打开直接显示。
          </div>
        </div>
      )}
      {!loading && !error && report && (
        <div className={css.scroll}>
          <div className={css.reportGrid}>
            {/* hero — full width */}
            <Card title={`${report.year} 年，你说了 ${fmtNum(report.total)} 条消息`}>
              <div className={css.cardBody}>
                <div className={kitCss.textMeta}>在 {report.active_days} 天里累计写下 {fmtNum(report.text_chars)} 字，日均 {report.daily_avg} 条</div>
                <div className={css.statChips}>
                  <span className={css.statChip}>活跃 <b>{report.active_days} 天</b></span>
                  <span className={css.statChip}>文字 <b>{fmtPct(report.text_share)}</b></span>
                  <span className={css.statChip}>深夜 <b>{fmtPct(report.night_share)}</b></span>
                  <span className={css.statChip}>清晨 <b>{fmtPct(report.morning_share)}</b></span>
                  <span className={css.statChip}>周末 <b>{fmtPct(report.weekend_share)}</b></span>
                  <span className={css.statChip}>群聊 <b>{fmtPct(report.group_share)}</b></span>
                </div>
                <div className={css.tagRow}>
                  <span className={kitCss.textMeta}>人物标签：</span>
                  {report.persona_tags.map(t => (
                    <span key={t} className={css.tagChip}>#{t}</span>
                  ))}
                </div>
              </div>
            </Card>

            {/* weekday x hour heatmap — full width */}
            <Card title="周活跃热力图（星期 × 小时）">
              <div className={css.heatGrid}>
                {WEEKDAYS.map(w => (<div key={w} className={kitCss.textMeta}>{w}</div>))}
                {report.heat.map((v, i) => (
                  <div key={i} className={css.heatCell} title={`${WEEKDAYS[Math.floor(i / 24)]} ${i % 24}:00 · ${v} 条`} style={{ background: `rgba(34, 211, 238, ${v > 0 ? Math.max(0.08, v / heatMax) : 0.03})` }} />
                ))}
              </div>
            </Card>

            {/* monthly — full width */}
            <Card title="月度活跃">
              <div className={css.monthlyBar}>
                {report.monthly.map((m, i) => (
                  <div key={i} className={css.monthCol} title={`${i + 1}月 · ${m} 条`}>
                    <div className={css.monthFill} style={{ height: `${Math.max(2, (m / monthlyMax) * 60)}px` }} />
                    <span className={kitCss.textMeta}>{i + 1}</span>
                  </div>
                ))}
              </div>
            </Card>

            {/* paired: message types + phrases */}
            <div className={kitCss.cardGrid}>
              <Card title="消息类型">
                {splitRows(Object.entries(report.kind_counts).map(([k, v]) => ({ k, v })), 3).map((row, ri) => (
                  <Marquee key={ri} reverse={ri % 2 === 1} duration={18}>
                    {row.map(item => <MarqueeCard key={item.k} title={item.k} meta={`${String(item.v)} 条`} />)}
                  </Marquee>
                ))}
              </Card>
              <Card title="高频短语">
                {splitRows(report.top_phrases.slice(0, 12), 6).map((row, ri) => (
                  <Marquee key={ri} reverse={ri % 2 === 1} duration={22}>
                    {row.map(p => <MarqueeCard key={p.phrase} title={p.phrase} meta={`×${p.count}`} />)}
                  </Marquee>
                ))}
              </Card>
            </div>

            {/* paired: emoji universe + first/last */}
            <div className={kitCss.cardGrid}>
              <Card title="表情宇宙">
                {splitRows(report.top_emoji.slice(0, 8), 4).map((row, ri) => (
                  <Marquee key={ri} reverse={ri % 2 === 1} duration={16}>
                    {row.map(e => <MarqueeCard key={e.emoji} icon={e.emoji} title={e.emoji} meta={`×${e.count}`} />)}
                  </Marquee>
                ))}
              </Card>
              <Card title={`${report.year} 的第一句与最后一句`}>
                <Focus eyebrow="首句" sentence={report.first_message ?? '—'} />
                <Focus eyebrow="末句" sentence={report.last_message ?? '—'} />
              </Card>
            </div>

            {/* paired: top contacts + top groups */}
            <div className={kitCss.cardGrid}>
              <Card title={`聊得最多的人（占全年 ${fmtPct(topContactShare)}）`}>
                {report.top_contacts.map((c, i) => (
                  <div key={c.username} className={css.barRow}>
                    <span className={css.barLabel} title={c.name}>{i + 1}. {c.name}</span>
                    <div className={css.barTrack}><div className={css.barFill} style={{ width: `${(c.count / (report.top_contacts[0]?.count ?? 1)) * 100}%` }} /></div>
                    <span className={css.barValue}>{c.count} 条</span>
                  </div>
                ))}
              </Card>
              <Card title={`最活跃的群聊（占全年 ${fmtPct(topGroupShare)}）`}>
                {report.top_groups.map((c, i) => (
                  <div key={c.username} className={css.barRow}>
                    <span className={css.barLabel} title={c.name}>{i + 1}. {c.name}</span>
                    <div className={css.barTrack}><div className={css.barFill} style={{ width: `${(c.count / (report.top_groups[0]?.count ?? 1)) * 100}%` }} /></div>
                    <span className={css.barValue}>{c.count} 条</span>
                  </div>
                ))}
              </Card>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

