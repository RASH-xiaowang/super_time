/**
 * 原图能力自检面板 — 图片链路本地化说明与自检（密钥/数据库路径/解密能力），
 * 高清原图获取走本地缓存与解码，不依赖任何原生注入或桥接。
 */
import { useEffect, useState } from 'react'
import { LazyMount } from './hooks.tsx'
import { apiGetDbHealth, apiGetStorageStats, apiGetWechatConfig, readRenderCache, writeRenderCache } from '../api.ts'
import type { ConfigSnapshot, DbHealthSnapshot, StorageSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, PanelHeader, StatCard, StatGrid } from '../ui/kit.tsx'
import css from './list-panel.module.css'
import { fmtBytes } from '../utils/format.ts'
import kitCss from '../ui/kit.module.css'

/**
 * Render the original-image capability self-check panel.
 * @param props - optional tab navigation callback for quick jumps;
 *   `embedded`：作为「设置」弹窗里的一节渲染（整页交给弹窗右区滚动）。
 * @returns the panel element tree.
 */
export function HookPanel({ onNavigate, embedded = false }: {
  onNavigate?: (tab: string) => void
  embedded?: boolean
} = {}): React.JSX.Element {
  const [cfg, setCfg] = useState<ConfigSnapshot | null>(() => readRenderCache<ConfigSnapshot>('hook-config'))
  const [health, setHealth] = useState<DbHealthSnapshot | null>(null)
  const [storage, setStorage] = useState<StorageSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [statsVisible, setStatsVisible] = useState(false)

  useEffect(() => {
    const cached = readRenderCache<ConfigSnapshot>('hook-config')
    if (cached) setCfg(cached)
    apiGetWechatConfig()
      .then((c) => { setCfg(c); writeRenderCache('hook-config', c) })
      .catch((e: unknown) => { setError((e as Error).message) })
      .finally(() => { setLoading(false) })
  }, [])

  // 健康/存储统计较重：滚动到统计区块附近时才计算，不阻塞页签首屏。
  useEffect(() => {
    if (!statsVisible) return
    let alive = true
    apiGetDbHealth().then((h) => { if (alive) setHealth(h) }).catch(() => { /* 统计失败不阻塞自检 */ })
    apiGetStorageStats().then((s) => { if (alive) setStorage(s) }).catch(() => { /* 统计失败不阻塞自检 */ })
    return () => { alive = false }
  }, [statsVisible])

  const hasKeys = Boolean(cfg && (cfg.key_format || cfg.db_dir))

  return (
    <div className={embedded ? css.panelEmbedded : css.panel}>
      <PanelHeader title="原图能力自检" desc="本地解码 · 无注入 / 无桥接" />
      <div className={css.scroll}>
        <Card title="图片如何本地解码？">
          <div className={css.hookIntro}>
            微信 4.x 的消息图片通过「已解码缓存 → .dat 解密 → hardlink 定位」链路在本地完成读取与解码
            （DSH 图片接口，密钥来自本机自动扫描或手动配置）。高清原图依赖本机缓存与系统解码器
            （wxgf/HEVC 支持）；本页不进行任何进程注入。
          </div>
          <div className={css.hookFlow}>
            <div className={css.hookFlowItem}>
              <span className={css.hookFlowIcon}>📥</span>
              <b className={css.hookFlowTitle}>已解码缓存</b>
              <small className={css.hookFlowSub}>优先读取，零解密</small>
            </div>
            <span className={css.hookFlowArrow}>→</span>
            <div className={css.hookFlowItem}>
              <span className={css.hookFlowIcon}>🔓</span>
              <b className={css.hookFlowTitle}>.dat 解密</b>
              <small className={css.hookFlowSub}>图片密钥本地解密</small>
            </div>
            <span className={css.hookFlowArrow}>→</span>
            <div className={css.hookFlowItem}>
              <span className={css.hookFlowIcon}>🗺️</span>
              <b className={css.hookFlowTitle}>hardlink 定位</b>
              <small className={css.hookFlowSub}>原始文件定位</small>
            </div>
          </div>
        </Card>

        <div className={css.hookGrid}>
          <div className={css.hookStat} data-tone={hasKeys ? 'green' : 'amber'}>
            <span className={css.hookStatValue}>{hasKeys ? '已配置' : '待配置'}</span>
            <span className={kitCss.textCaption}>图片密钥</span>
            <span className={css.hookStatHint}>AES / XOR</span>
          </div>
          <div className={css.hookStat}>
            <span className={css.hookStatValue} title={cfg?.db_dir || '—'}>{cfg?.db_dir ? (cfg.db_dir.length > 26 ? cfg.db_dir.slice(0, 26) + '…' : cfg.db_dir) : '—'}</span>
            <span className={kitCss.textCaption}>数据库路径</span>
            <span className={css.hookStatHint}>decrypted 原始库</span>
          </div>
          <div className={css.hookStat}>
            <span className={css.hookStatValue}>{cfg?.key_format || '—'}</span>
            <span className={kitCss.textCaption}>密钥格式</span>
            <span className={css.hookStatHint}>wx_key_v4.1 等</span>
          </div>
          <div className={css.hookStat} data-tone="red">
            <span className={css.hookStatValue}>不启用</span>
            <span className={kitCss.textCaption}>注入能力</span>
            <span className={css.hookStatHint}>纯本地，无注入</span>
          </div>
        </div>

        <LazyMount onShow={() => { setStatsVisible(true) }}>
          <div className={css.hookGrid}>
            <div className={css.hookStat} data-tone="purple">
              <span className={css.hookStatValue}>{health ? `${health.decodedImagesCount.toLocaleString()} 张` : '统计中…'}</span>
              <span className={kitCss.textCaption}>解码缓存</span>
              <span className={css.hookStatHint}>{health ? fmtBytes(health.decodedImagesBytes) : '滚动到此处后统计'}</span>
            </div>
            <div className={css.hookStat} data-tone="blue">
              <span className={css.hookStatValue}>{storage ? `${storage.total_count.toLocaleString()} 项` : '统计中…'}</span>
              <span className={kitCss.textCaption}>媒体资源</span>
              <span className={css.hookStatHint}>{storage ? fmtBytes(storage.total_size) : ''}</span>
            </div>
            <div className={css.hookStat} data-tone={hasKeys ? 'green' : 'red'}>
              <span className={css.hookStatValue}>{hasKeys ? '密钥就绪' : '仅 CDN 缩略图'}</span>
              <span className={kitCss.textCaption}>本地图片链路</span>
              <span className={css.hookStatHint}>{hasKeys ? '可本地解码' : '建议配置图片密钥'}</span>
            </div>
          </div>
        </LazyMount>

        {(onNavigate || health || storage) && (
          <div className={css.hookActions}>
            {onNavigate && <button type="button" className={css.catBtn} onClick={() => { onNavigate('files') }}>查看文件资产</button>}
            {onNavigate && <button type="button" className={css.catBtn} onClick={() => { onNavigate('storage') }}>查看存储占用</button>}
            {onNavigate && <button type="button" className={css.catBtn} onClick={() => { onNavigate('settings') }}>前往设置</button>}
          </div>
        )}

        {loading && !error && <div className={css.empty}>正在读取配置…</div>}
        {error && <div className={kitCss.error} role="alert">⚠️ {error}</div>}
        {cfg && cfg.db_dir && (
          <Card title="当前图片能力">
            <div className={css.hookEntryList}>
              <div className={css.hookEntryItem}>· 已配置图片密钥时，消息图片可按 MD5 走「已解码缓存 → .dat 解密 → hardlink 定位」链路（DSH 图片接口）。</div>
              <div className={css.hookEntryItem}>· 未配置密钥时，仅能展示 CDN 缩略图；建议在「设置」中配置图片 AES 密钥与 XOR 值。</div>
              <div className={css.hookEntryItem}>· 原图（wxgf/HEVC）需系统解码器；可用缩略图 _t/_h 兜底。</div>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
