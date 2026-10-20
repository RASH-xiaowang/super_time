/**
 * 数据健康中心 — 解密 SQLite 遍历统计、WAL/SHM、搜索索引、插件存储与
 * 解码缓存占用，支持重建搜索索引。
 *
 * W3-11.7：本面板是「库文件已损坏」那条处方（wechat-host.js 的 READABLE_ERRORS）
 * 指向的目的地，所以它必须真的能体检、能修：
 *   · `apiCheckDbIntegrity` 逐库 `PRAGMA integrity_check` —— 只报大小/数量的旧版
 *     健康中心分不出「坏库」与「好库」，用户照着处方走过来只会看到一片 ✅；
 *   · `apiRepairCorruptDbs` 从本机原始 db_storage **只重解密损坏的那几个**（不动其它库）。
 * 体检挂在「重新检查」上而不是进入面板就自动跑：本机十个库合计两百多兆，
 * 一次全扫要论秒 —— 与遍历统计同档的显式动作纪律。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiBuildSearchIndex, apiCheckDbIntegrity, apiGetDbHealth, apiGetDbStatus, apiGetDecryptStatus, apiDecryptAllDatabases, apiRepairCorruptDbs, readRenderCache, writeRenderCache } from '../api.ts'
import type { DbHealthSnapshot, DbIntegrityResult, DbStatusSnapshot, DecryptStatus } from '@deepseek-ai/dsh-wechat-data/types'
import { Button, Card, LoadingState, PanelHeader, StatCard, StatGrid, Toolbar } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './health.module.css'
import { HealthIntegrityCards } from './health-integrity.tsx'
import { fmtBytes } from '../utils/format.ts'
import { useTransientNotice, useWechatDataUpdated } from './hooks.tsx'
import { desktopOnlyGate } from '../ui/desktop-only.tsx'

/**
 * Render the data health panel.
 * @param props - `embedded`：作为「设置」弹窗里的一节渲染（不自建 height:100% 与内边距）。
 * @returns the health element tree.
 */
export function HealthPanel({ embedded = false }: {
  embedded?: boolean
} = {}): React.JSX.Element {
  // ⚠️ 降级判定必须在所有 hooks 之后（见函数末尾的 `blocked` 分支）。
  // 放在 hooks 之前会让 hook 数量随能力表变化而变，React 抛
  // "Rendered more hooks than during the previous render" ⇒ 整棵根树被卸载 ⇒ 黑屏。
  const [snap, setSnap] = useState<DbHealthSnapshot | null>(() => readRenderCache<{ snap: DbHealthSnapshot | null; status: DbStatusSnapshot | null }>('health')?.snap ?? null)
  const [status, setStatus] = useState<DbStatusSnapshot | null>(() => readRenderCache<{ snap: DbHealthSnapshot | null; status: DbStatusSnapshot | null }>('health')?.status ?? null)
  const [loading, setLoading] = useState(false)
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** W3-2.5：最近一次解密的失败明细（哪个库、因为什么）。 */
  const [decrypt, setDecrypt] = useState<DecryptStatus | null>(null)
  /** W3-2.5：是否正在重试解密（与「重建索引」各占一个忙闲闸门，互不干扰）。 */
  const [retrying, setRetrying] = useState(false)
  /**
   * W3-11.7：逐库完整性体检结论。**不进渲染缓存** —— 它是「现在坏没坏」的最新信号，
   * 修完之后缓存里那份旧的「坏 1 个」会把已修好的状态继续说成坏的；每次「重新检查」
   * 重取一次的成本（论秒）也本来就在显式动作里。
   */
  const [integrity, setIntegrity] = useState<DbIntegrityResult | null>(null)
  /** 修复（只重解密损坏的那几个）进行中；与重试解密/重建索引各占一个闸门。 */
  const [repairing, setRepairing] = useState(false)
  // 提示语自动消失（L20）：原手写的 `window.setTimeout(…, 3000)` 已由 hook 统一管理。
  const { notice, flash } = useTransientNotice()

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const cached = readRenderCache<{ snap: DbHealthSnapshot | null; status: DbStatusSnapshot | null }>('health')
      if (cached) { setSnap(cached.snap); setStatus(cached.status) }
      // 体检失败（比如整棵目录都读不动）不许把大小统计一起拖没：单独 catch 成 null，
      // 界面上「体检没跑成」与「没有损坏」是两件事，不能显示成后者。
      const [h, s, d, g] = await Promise.all([
        apiGetDbHealth(),
        apiGetDbStatus().catch((): null => null),
        apiGetDecryptStatus().catch((): null => null),
        apiCheckDbIntegrity().catch((): null => null),
      ])
      setSnap(h)
      setStatus(s)
      setDecrypt(d)
      setIntegrity(g)
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

  /** W3-2.5：重试解密。失败最常见的原因是「库还被微信占着」，重试往往立刻就好。 */
  const retryDecrypt = useCallback(async (): Promise<void> => {
    setRetrying(true)
    try {
      const r = await apiDecryptAllDatabases()
      setDecrypt(await apiGetDecryptStatus())
      flash(r.failed.length === 0
        ? `解密完成：成功 ${r.okCount}/${r.total}`
        : `解密完成：成功 ${r.okCount}/${r.total}，仍有 ${r.failed.length} 个失败`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRetrying(false)
    }
  }, [flash])

  /**
   * W3-11.7：修复损坏的库（体检 → 只重解密损坏的那几个 → 复检）。
   *
   * 修完必须**重新体检 + 刷统计**：修复会原子替换快照，`getDbHealth` 的大小/
   * 搜索索引状态都跟着变；不复检就那句「修复完成」只是「重解密跑完了」，
   * 不代表库真的好了（后端复检不过时 `ok:false`，这里如实转述）。
   */
  const repair = useCallback(async (): Promise<void> => {
    setRepairing(true)
    try {
      const r = await apiRepairCorruptDbs()
      setDecrypt(await apiGetDecryptStatus().catch((): null => null))
      setIntegrity(await apiCheckDbIntegrity().catch((): null => null))
      await load()
      flash(r.found === 0
        ? '体检没有发现损坏的库，无需修复'
        : `修复完成：${r.found} 个损坏中恢复 ${r.repaired} 个`
          + (r.stillCorrupted.length > 0 ? `，仍坏 ${r.stillCorrupted.length} 个` : '')
          + (r.unrepairable.length > 0 ? `，修不了 ${r.unrepairable.length} 个` : ''))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRepairing(false)
    }
  }, [flash, load])

  const rebuild = useCallback(async (): Promise<void> => {
    setBuilding(true)
    // W3-3.3：重建期间读者读到的是**旧索引**（ROLLBACK 保证），所以要把话说清楚 ——
    // 否则用户以为「正在建」等于「已经更快了」。与 chats 面板那句同一口径。
    flash('正在重建：期间搜索走的是旧索引，可能变慢；建完会自动切到新的')
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

  const corruptedCount = integrity?.corrupted.length ?? 0
  const unreadableCount = integrity?.unreadable.length ?? 0
  const uncheckableCount = integrity?.uncheckable.length ?? 0

  // WAL 增量推送：同步在跑时健康/解密状态跟着变（缓存先上屏，不闪骨架）。
  useWechatDataUpdated(() => { void load() })

  // 浏览器态整节换成降级卡（hooks 之后判定，hook 数量恒定）。
  const blocked = desktopOnlyGate('health')
  if (blocked !== null) return blocked

  return (
    <div className={embedded ? kitCss.panelEmbed : kitCss.panelShell}>
      {/* 微信化：嵌进设置弹窗时不再画页头（节名由左导航表达），只留一行节内工具行。 */}
      {embedded ? (
        <Toolbar
          left={<span className={kitCss.textCaption}>本地检查{snap ? ` · 快照 ${new Date(snap.updatedAt * 1000).toLocaleString('zh-CN')}` : ''}</span>}
          right={(
            <>
              <Button variant="outline" size="sm" onClick={() => { void load() }} disabled={loading}>{loading ? '检查中…' : '重新检查'}</Button>
              <Button variant="outline" size="sm" onClick={() => { void rebuild() }} disabled={building}>{building ? '重建中…' : '重建索引'}</Button>
              {(decrypt?.failures.length ?? 0) > 0 && (
                <Button variant="outline" size="sm" onClick={() => { void retryDecrypt() }} disabled={retrying}>{retrying ? '重试中…' : '重试解密'}</Button>
              )}
              {corruptedCount > 0 && (
                <Button variant="outline" size="sm" onClick={() => { void repair() }} disabled={repairing}>{repairing ? '修复中…' : '修复损坏的库'}</Button>
              )}
            </>
          )}
        />
      ) : (
        <PanelHeader
          title="数据健康中心"
          desc={`解密库/索引/插件存储/解码缓存占用 · 本地检查${snap ? ` · 快照 ${new Date(snap.updatedAt * 1000).toLocaleString('zh-CN')}` : ''}`}
          actions={(
            <>
              <Button variant="outline" size="sm" onClick={() => { void load() }} disabled={loading}>{loading ? '检查中…' : '重新检查'}</Button>
              <Button variant="outline" size="sm" onClick={() => { void rebuild() }} disabled={building}>{building ? '重建中…' : '重建搜索索引'}</Button>
              {/* W3-2.5：只在**确有失败明细**时出现 —— 没有失败却挂一个「重试解密」
               会让用户以为解密常态是坏的。 */}
              {(decrypt?.failures.length ?? 0) > 0 && (
                <Button variant="outline" size="sm" onClick={() => { void retryDecrypt() }} disabled={retrying}>{retrying ? '重试中…' : '重试解密'}</Button>
              )}
              {/* W3-11.7：只在体检发现损坏时出现 —— 没有损坏时挂个「修复」按钮，
                用户会以为这里的库常态是坏的。 */}
              {corruptedCount > 0 && (
                <Button variant="outline" size="sm" onClick={() => { void repair() }} disabled={repairing}>{repairing ? '修复中…' : '修复损坏的库'}</Button>
              )}
            </>
          )}
        />
      )}

      {notice && <div className={css.notice}>{notice}</div>}
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {loading && !snap && <LoadingState variant="compact" label="检查中…" />}
      {!loading && !snap && !error && <div className={kitCss.emptyInline}>点击「重新检查」生成数据健康报告</div>}

      {snap && (
        <>
          <StatGrid>
            {/* W3-11.7：有损坏时这枚卡片转红并把数量说清 —— 头部动作区那个「修复」按钮
                是点得到的那一个，这张卡是「为什么这里有个修复按钮」的那一行字。 */}
            <StatCard icon="🗄️" value={corruptedCount > 0 ? `${snap.dbFiles}（坏 ${corruptedCount}）` : snap.dbFiles} label="解密库文件" tone={corruptedCount > 0 ? 'red' : undefined} />
            <StatCard icon="💾" value={fmtBytes(snap.dbBytes)} label="解密库大小" tone="purple" />
            <StatCard icon="📝" value={`${snap.walFiles} / ${snap.shmFiles}`} label="WAL / SHM" tone="amber" />
            <StatCard icon="🔍" value={snap.searchIndex.exists ? `${snap.searchIndex.rows} 行` : '未构建'} label="搜索索引" tone={snap.searchIndex.exists ? 'green' : 'red'} />
            <StatCard icon="🖼️" value={snap.decodedImagesCount} label="解码缓存" tone="blue" />
            <StatCard icon="🧮" value={fmtBytes(snap.decodedImagesBytes)} label="缓存大小" />
          </StatGrid>

          {/* 2026-09-30 删掉「快捷入口」卡片：三个按钮全是**重复导航**
              （侧栏已有「文件与存储」「数据边界与出网」），其中「前往系统设置」更是
              在设置弹窗里点它回到设置 —— 用户要求精简时就该先删这种。 */}

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

            {/* W3-11.7：损坏库明细 + 一键修复（拆到 health-integrity.tsx：HealthPanel
                因此回到函数尺寸棘轮以内，而这一族卡片只依赖体检结论与修复动作）。
                2026-10-13 起还有第三类「本机体检不了」（微信自带 FTS 分词器）——
                它也要看得见，否则用户会以为「没显示 = 全绿」。 */}
            {(corruptedCount > 0 || unreadableCount > 0 || uncheckableCount > 0) && (
              <HealthIntegrityCards integrity={integrity} repairing={repairing} onRepair={() => { void repair() }} />
            )}

            {/* W3-2.5：失败明细卡。「失败 N」只是个计数，这里要回答
                「哪几个、因为什么、现在能不能修」—— 否则用户在健康中心
                看到一個數字，什么也做不了。 */}
            {(decrypt?.failures.length ?? 0) > 0 && (
              <Card title={`解密失败明细（${String(decrypt?.failures.length ?? 0)}）`}>
                <div className={css.lines}>
                  {decrypt?.failures.map((x) => (
                    <div key={x.db} className={css.line}>
                      <b>{x.db}</b>
                      <span className={css.failWhy}>：{x.error}</span>
                    </div>
                  ))}
                </div>
                {/* 直接给出下一步：失败最常见的原因是库还被微信占着。 */}
                <div className={css.failHint}>最常见的原因是这些库正被微信客户端占用：退出微信后点上面的「重试解密」。</div>
              </Card>
            )}

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
