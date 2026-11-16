/**
 * 数据健康中心的「完整性体检」卡片组（W3-11.7，自 `Health.tsx` 拆出）。
 *
 * 为什么拆：`HealthPanel` 一个函数因此越过了 250 行的函数尺寸棘轮
 * （`function-size-ratchet.spec.ts`），而这一族卡片本来就有独立 seam ——
 * 它只依赖「体检结论 + 修复动作」两件事，不碰统计/索引/解密失败那三张卡。
 * 拆出去之后 `HealthPanel` 回到「取数 + 摆卡片」的形状。
 *
 * **三类结论分开呈现，因为下一步动作完全不同**（2026-10-13 补齐第三类）：
 *   · 损坏 ⇒ 给「修复」按钮：先在本地清掉上一代残留的 `-wal`/`-shm`（不读原始库），
 *     仍坏的才从原始 db_storage 重解密；
 *   · 查不了（占用/权限）⇒ 只说原因与下一步（退出微信后再体检），**不给修复按钮** ——
 *     那不是损坏，给按钮等于驱动一次注定失败的重解密；
 *   · 本机体检不了（缺 FTS 分词器）⇒ **什么都不用做**，而且必须说清「退出微信也没用」：
 *     上一版把这一类并进「查不了」，于是三个好端端的 `*_fts.db` 被劝去退微信，
 *     用户照做一次、两次、三次，永远是同一句 `SQL logic error`。
 */
import type { DbIntegrityResult } from '@deepseek-ai/dsh-wechat-data/types'
import { Button, Card } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './health.module.css'

/** 一条结论（库 + 原因）的渲染，三类共用。 */
function IssueLines({ items }: { items: ReadonlyArray<{ file: string; error: string }> }): React.JSX.Element {
  return (
    <div className={css.lines}>
      {items.map((x) => (
        <div key={x.file} className={css.line}>
          <b>{x.file}</b>
          <span className={css.failWhy}>：{x.error}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * 渲染完整性体检的结论区：体检失败 / 尚未体检 / 未发现损坏 / 三类问题明细。
 *
 * 「体检没跑成」「还没体检」「没有损坏」必须各占一张卡 —— 前两种一旦落进
 * 「数组都是空」的分支，就会被界面说成「未发现损坏」，把失败伪装成全绿。
 * @param props.integrity - 最近一次逐库体检结论（null = 还没体检过）。
 * @param props.repairing - 修复进行中（按钮禁用态）。
 * @param props.onRepair - 点「修复」：清本地残留 + 只重解密仍坏的那几个（后端 `repairCorruptDbs`）。
 * @param props.error - 体检请求本身失败的原因；非空时优先成卡，且绝不显示全绿。
 * @param props.checked - 调用方是否确认体检真的跑过（`integrity` 非 null 时应传 true）。
 * @returns 卡片组元素。
 */
export function HealthIntegrityCards({ integrity, repairing, onRepair, error = null, checked = false }: {
  integrity: DbIntegrityResult | null
  repairing: boolean
  onRepair: () => void
  error?: string | null
  checked?: boolean
}): React.JSX.Element {
  // ① RPC 失败：此时 integrity 被置 null，但绝不能渲染成「没有损坏」。
  if (error !== null && error !== '') {
    return (
      <Card title="体检没跑成">
        <div className={kitCss.error} role="alert">{error}</div>
        <div className={css.failHint}>这不代表库是好的，只代表这次体检没有结论。排除占用/权限问题后再点「重新检查」。</div>
      </Card>
    )
  }

  // ② 从未体检（体检是显式动作，打开面板不会自动跑）。
  if (integrity === null) {
    return (
      <Card title="完整性体检">
        <div className={kitCss.emptyInline}>尚未体检：点上方「重新检查」逐库运行 <code>PRAGMA integrity_check</code>（全量扫描需要几秒）。</div>
      </Card>
    )
  }

  const corrupted = integrity.corrupted
  const unreadable = integrity.unreadable
  const uncheckable = integrity.uncheckable

  // ③ 三类都空：只有调用方确认体检跑过，才允许说「未发现损坏」。
  if (corrupted.length === 0 && unreadable.length === 0 && uncheckable.length === 0) {
    return (
      <Card title="完整性体检">
        <div className={kitCss.emptyInline}>
          {checked ? `未发现损坏（检查 ${String(integrity.checked)} 个库）` : '尚未体检'}
        </div>
      </Card>
    )
  }

  // ④ 以下三组卡片与文案保持原样：损坏 / 没能体检 / 本机体检不了。
  return (
    <>
      {corrupted.length > 0 && (
        <Card title={`损坏的库（${String(corrupted.length)}）`}>
          <IssueLines items={corrupted} />
          {/* 「坏了几个」只是个计数，这里要回答「点了之后会发生什么」——
              修复分两步：先清本地残留旁文件（不读原始库），仍坏的才从原始 db_storage 重解密。 */}
          <div className={css.failHint}>修复 = 先在本地清掉上一代残留的 <code>-wal</code>/<code>-shm</code>（这一步不读原始库）；清完仍坏的那几个，才从本机原始 db_storage 重新解密（只动它们，其它库不碰）。修完会再体检一遍，修不好或原始库没了的会留在明细里。</div>
          {unreadable.length > 0 && (
            <>
              <IssueLines items={unreadable} />
              <div className={css.failHint}>另有 {String(unreadable.length)} 个库没能体检（上表列出）—— 多数是正被微信客户端独占，那不是损坏，退出微信后再点「重新检查」。</div>
            </>
          )}
          {uncheckable.length > 0 && (
            <>
              <IssueLines items={uncheckable} />
              <div className={css.failHint}>另有 {String(uncheckable.length)} 个库本机体检不了（上表列出）—— 它们含虚拟表、用的是微信自带的 FTS 分词器，本机 SQLite 装不上它，<code>PRAGMA integrity_check</code> 必然报错。与损坏无关，退出微信也没用；这些库的表读得出来，不用管。</div>
            </>
          )}
          <div className={css.storeRow}>
            <Button variant="outline" size="sm" onClick={onRepair} disabled={repairing}>{repairing ? '修复中…' : '修复损坏的库'}</Button>
          </div>
        </Card>
      )}

      {/* 一个没坏：后两类各自成卡 —— 沉默会被读成「全绿」，而它们各自的动作完全不同。 */}
      {corrupted.length === 0 && unreadable.length > 0 && (
        <Card title={`没能体检的库（${String(unreadable.length)}）`}>
          <IssueLines items={unreadable} />
          <div className={css.failHint}>这些库没能完成完整性体检（上表是原因）—— 与损坏无关，最常见是正被微信客户端独占。退出微信后点「重新检查」。</div>
        </Card>
      )}
      {corrupted.length === 0 && uncheckable.length > 0 && (
        <Card title={`本机体检不了的库（${String(uncheckable.length)}）`}>
          <IssueLines items={uncheckable} />
          <div className={css.failHint}>这些库含虚拟表、用的是微信自带的 FTS 分词器，本机 SQLite 装不上它，<code>PRAGMA integrity_check</code> 必然报错。与损坏无关，退出微信也没用；这些库的表读得出来，不用管。</div>
        </Card>
      )}
    </>
  )
}
