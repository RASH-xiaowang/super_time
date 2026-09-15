/**
 * 数据健康中心 — 解密 SQLite 遍历统计、WAL/SHM、搜索索引、插件存储与
 * 解码缓存占用，支持重建搜索索引。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiBuildSearchIndex, apiGetDbHealth, apiGetDbStatus, readRenderCache, writeRenderCache } from '../api.ts'
import type { DbHealthSnapshot, DbStatusSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Button, Card, PanelHeader, StatCard, StatGrid } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './health.module.css'
import { fmtBytes } from '../utils/format.ts'
import { useTransientNotice } from './hooks.tsx'

/**
 * Render the data health panel.
 * @param props - optional tab navigation callback for quick jumps;
 *   `embedded`：作为「设置」弹窗里的一节渲染（不自建 height:100% 与内边距）。
 * @returns the health element tree.
 */
export function HealthPanel({ onNavigate, embedded = false }: {
  onNavigate?: (tab: string) => void
  embedded?: boolean
} = {}): React.JSX.Element {
  const [snap, setSnap] = useState<DbHealthSnapshot | null>(() => readRenderCache<{ snap: DbHealthSnapshot | null; status: DbStatusSnapshot | null }>('health')?.snap ?? null)
  const [status, setStatus] = useState<DbStatusSnapshot | null>(() => readRenderCache<{ snap: DbHealthSnapshot | null; status: DbStatusSnapshot | null }>('health')?.status ?? null)
  const [loading, setLoading] = useState(false)
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 提示语自动消失（L20）：原手写的 `window.setTimeout(…, 3000)` 已由 hook 统一管理。
  const { notice, flash } = useTransientNotice()

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const cached = readRenderCache<{ snap: DbHealthSnapshot | null; status: DbStatusSnapshot | null }>('health')
      if (cached) { setSnap(cached.snap); setStatus(cached.status) }
      const [h, s] = await Promise.all([apiGetDbHealth(), apiGetDbStatus().catch(() => null)])
      setSnap(h)
      setStatus(s)
      writeRenderCache('health', { snap: h, status: s })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  // 数据健康遍历统计较重：不进入页签即自动执行，初始仅展示渲染缓存，
  // 由「重新检查」按钮按需触发全量统计。
  useEffect(() => {
    const cached = readRenderCache<{ snap: DbHealthSnapshot | null; status: DbStatusSnapshot | null }>('health')
    if (cached) { setSnap(cached.snap); setStatus(cached.status) }
  }, [])

  const rebuild = useCallback(async (): Promise<void> => {
    setBuilding(true)
    try {
      const r = await apiBuildSearchIndex({ force: true })
      // r.message 只在「跳过不可读分片」这类场景出现：有它在就说明索引是残缺的，
      // 不能只报「已完成」，否则用户看到 199 行也说不出哪里不对。
      flash(r.message ? `重建完成：${r.rows} 行索引（${r.message}）` : `重建完成：${r.rows} 行索引`)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBuilding(false)
    }
  }, [load])

  return (
    <div className={embedded ? kitCss.panelEmbed : kitCss.panelShell}>
      <PanelHeader
        title="数据健康中心"
        desc={`解密库/索引/插件存储/解码缓存占用 · 本地检查${snap ? ` · 快照 ${new Date(snap.updatedAt * 1000).toLocaleString('zh-CN')}` : ''}`}
        actions={(
          <>
            <Button variant="outline" size="sm" onClick={() => { void load() }} disabled={loading}>{loading ? '检查中…' : '重新检查'}</Button>
            <Button variant="outline" size="sm" onClick={() => { void rebuild() }} disabled={building}>{building ? '重建中…' : '重建搜索索引'}</Button>
          </>
        )}
      />

      {notice && <div className={css.notice}>{notice}</div>}
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {loading && !snap && <div className={kitCss.emptyInline}>检查中…</div>}
      {!loading && !snap && !error && <div className={kitCss.emptyInline}>点击「重新检查」生成数据健康报告</div>}

      {snap && (
        <>
          <StatGrid>
            <StatCard icon="🗄️" value={snap.dbFiles} label="解密库文件" />
            <StatCard icon="💾" value={fmtBytes(snap.dbBytes)} label="解密库大小" tone="purple" />
            <StatCard icon="📝" value={`${snap.walFiles} / ${snap.shmFiles}`} label="WAL / SHM" tone="amber" />
            <StatCard icon="🔍" value={snap.searchIndex.exists ? `${snap.searchIndex.rows} 行` : '未构建'} label="搜索索引" tone={snap.searchIndex.exists ? 'green' : 'red'} />
            <StatCard icon="🖼️" value={snap.decodedImagesCount} label="解码缓存" tone="blue" />
            <StatCard icon="🧮" value={fmtBytes(snap.decodedImagesBytes)} label="缓存大小" />
          </StatGrid>

          {onNavigate && (
            <Card title="快捷入口">
              <div className={css.actions}>
                <Button variant="outline" size="sm" onClick={() => { onNavigate('settings') }}>前往系统设置</Button>
                <Button variant="outline" size="sm" onClick={() => { onNavigate('privacytrust') }}>数据边界与出网</Button>
                <Button variant="outline" size="sm" onClick={() => { onNavigate('files') }}>文件资产</Button>
              </div>
            </Card>
          )}

          <div className={kitCss.cardGrid}>
            <Card title="插件存储文件">
              {snap.stores.length === 0 ? (
                <div className={kitCss.emptyInline}>暂无插件存储文件</div>
              ) : (
                <div className={css.storeList}>
                  {snap.stores.map(s => (
                    <div key={s.name} className={css.storeRow}>
                      <span className={css.storeName}>{s.name}</span>
                      <span className={css.storeSize}>{fmtBytes(s.size)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="DB 状态摘要">
              {(status?.lines ?? []).length === 0 ? (
                <div className={kitCss.emptyInline}>暂无状态行</div>
              ) : (
                <div className={css.lines}>
                  {status?.lines.map(line => <div key={line} className={css.line}>{line}</div>)}
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
