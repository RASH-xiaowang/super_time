/**
 * 常用表情 Top 10 —— 缩略图 + 使用次数。
 *
 * ## 为什么单独一个文件
 *
 * `AssetInsightsPanel` 受函数体棘轮管着（250 行上限），而「拉缩略图 + 占位 + 失败兜底」
 * 有 60 多行，留在面板里会超。
 *
 * ## 为什么不再显示裸 MD5（2026-10-17 重做）
 *
 * 改前每行是 `7ec1864f4558c5f6a73b986290ba6cd2  350 次` —— 用户完全看不懂那串哈希
 * 是什么（真机截图）。现在拉真实缩略图，MD5 只在 `title` 里给（排查问题时要它）。
 */
import { useEffect, useState } from 'react'
import { apiGetEmoticonDataUrl } from '../api.ts'
import type { AssetEmoticonUsage } from '@deepseek-ai/dsh-wechat-data/types'
import css from './asset-insights.module.css'

/** 一个表情缩略图：加载中显示占位，失败显示 🙁 并把原因放进 title。 */
function EmoThumb({ md5 }: { md5: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setErr(null)
    void apiGetEmoticonDataUrl({ md5: md5.toLowerCase() })
      .then((r) => {
        if (cancelled) return
        if (r.url) setSrc(r.url)
        else setErr(r.error ?? '表情不可用')
      })
      .catch((e: unknown) => { if (!cancelled) setErr((e as Error).message) })
    return () => { cancelled = true }
  }, [md5])

  if (src !== null) {
    return <img className={css.emoThumb} src={src} alt="" loading="lazy" decoding="async" />
  }
  return <span className={css.emoThumbPh} title={err ?? '表情加载中…'}>{err === null ? '😀' : '🙁'}</span>
}

/**
 * 渲染常用表情排行。
 * @param props.rows - 后端给的 md5 + 使用次数（已按次数降序）。
 * @returns 排行列表；无数据时给空态。
 */
export function TopEmoticons({ rows }: { rows: readonly AssetEmoticonUsage[] }): React.JSX.Element {
  if (rows.length === 0) {
    return <div className={css.empty}>暂无使用记录</div>
  }
  const max = Math.max(1, ...rows.map(r => r.count))
  return (
    <div className={css.emoGrid}>
      {rows.map((r, i) => (
        <div key={r.md5} className={css.emoCard} title={`MD5：${r.md5}\n使用 ${String(r.count)} 次`}>
          <span className={css.emoRank}>{i + 1}</span>
          <EmoThumb md5={r.md5} />
          <span className={css.emoCount}>{r.count}</span>
          <div className={css.emoBar}>
            <div className={css.emoBarFill} style={{ width: `${String(Math.max(4, Math.round((r.count / max) * 100)))}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}
