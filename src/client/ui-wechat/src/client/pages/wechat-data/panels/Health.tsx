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
 *
 * 取数与动作已抽到 `health-actions.ts`：本组件只负责渲染，且 WAL 推送只刷统计，
 * 不会顺带触发全库体检。
 */
import { Button, LoadingState, PanelHeader, StatCard, StatGrid, Toolbar } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './health.module.css'
import { HealthIntegrityCards } from './health-integrity.tsx'
import { CardCanvas } from './card-canvas.tsx'
import { CanvasCard } from './card-canvas-card.tsx'
import { fmtBytes } from '../utils/format.ts'
import { useTransientNotice, useWechatDataUpdated } from './hooks.tsx'
import { useHealthPanelActions } from './health-actions.ts'
import { desktopOnlyGate } from '../ui/desktop-only.tsx'

/**
 * Render the data health panel.
 * @param props - `embedded`：作为「设置」弹窗里的一节渲染（不自建 height:100% 与内边距）。
 * @returns the health element tree.
 */
export function HealthPanel({ embedded = false }: {
  embedded?: boolean
} = {}): React.JSX.Element {
  // 提示语自动消失（L20）：原手写的 `window.setTimeout(…, 3000)` 已由 hook 统一管理。
  const { notice, flash } = useTransientNotice()
  // ⚠️ 降级判定必须在所有 hooks 之后（见函数末尾的 `blocked` 分支）：
  // 放在 hooks 之前会让 hook 数量随能力表变化而变，React 抛
  // "Rendered more hooks than during the previous render" ⇒ 整棵根树被卸载 ⇒ 黑屏。
  const {
    snap, status, decrypt, integrity, integrityError, loading, retrying, repairing, building, error,
    load, loadStats, repair, retryDecrypt, rebuild,
  } = useHealthPanelActions(flash)

  const corruptedCount = integrity?.corrupted.length ?? 0

  // WAL 增量推送：同步在跑时健康/解密状态跟着变（缓存先上屏，不闪骨架）。
  // **同步事件只刷统计**：体检（逐库 `PRAGMA integrity_check`）仍是「重新检查」的
  // 显式动作，不能每个事件都全扫一遍 —— 那会拖慢同步并长期占用快照句柄。
  useWechatDataUpdated(() => { void loadStats() })

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
          desc={snap ? new Date(snap.updatedAt * 1000).toLocaleString('zh-CN') : undefined}
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

          {/* 卡片区改用**等宽瀑布流画布**（2026-11-19，与「年度报告」「数据总览」同一套）。
              这里最能体现画布的价值：「损坏的库」卡可能装三组列表 + 三段说明、高过千像素，
              而旁边的「DB 状态摘要」可能只有两行 —— 旧的两列网格会把它们拉成等高，
              矮卡下方留一大片空白。画布让每张卡各自按内容取高、按最短列落位。
              KPI 那条 `StatGrid` 留在画布外：它是「一眼看的六个数字」，横条形态更合适。 */}
          <CardCanvas year={0} scope="health">
            <CanvasCard id="health-stores" title="插件存储文件">
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
            </CanvasCard>

            {/* W3-11.7：体检结论区（拆到 health-integrity.tsx：HealthPanel
                因此回到函数尺寸棘轮以内，而这一族卡片只依赖体检结论与修复动作）。
                2026-10-13 起还有第三类「本机体检不了」（微信自带 FTS 分词器）——
                它也要看得见，否则用户会以为「没显示 = 全绿」。
                现在四种状态各成卡：体检没跑成 / 尚未体检 / 未发现损坏 / 问题明细；
                体检失败的原因单独传入，绝不再被空数组渲染成「没有损坏」。 */}
            <HealthIntegrityCards
              integrity={integrity}
              repairing={repairing}
              onRepair={() => { void repair() }}
              error={integrityError}
              checked={integrity !== null}
            />

            {/* W3-2.5：失败明细卡。「失败 N」只是个计数，这里要回答
                「哪几个、因为什么、现在能不能修」—— 否则用户在健康中心
                看到一個數字，什么也做不了。 */}
            {(decrypt?.failures.length ?? 0) > 0 && (
              <CanvasCard id="health-failures" title={`解密失败明细（${String(decrypt?.failures.length ?? 0)}）`}>
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
              </CanvasCard>
            )}

            <CanvasCard id="health-status" title="DB 状态摘要">
              {(status?.lines ?? []).length === 0 ? (
                <div className={kitCss.emptyInline}>暂无状态行</div>
              ) : (
                <div className={css.lines}>
                  {status?.lines.map(line => <div key={line} className={css.line}>{line}</div>)}
                </div>
              )}
            </CanvasCard>
          </CardCanvas>
        </>
      )}
    </div>
  )
}
