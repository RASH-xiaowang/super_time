/**
 * 表情网格只挂载视口里的几行。
 *
 * 七千张表情如果一次挂上百格，每格再去要图，滚动和取图会叠在一起把界面卡住。
 * 已经落盘的用相对路径直接显示；缺的只补当前这几行，每次两张。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { apiGetEmoticonDataUrl } from '../api.ts'
import type { EmoticonItem } from '@deepseek-ai/dsh-wechat-data/types'
import { EmoticonCell } from './asset-ui.tsx'
import css from './list-panel.module.css'

const ROW_PX = 118
const GAP_PX = 8
const MIN_COL_PX = 140

export function EmoticonVirtualGrid({ items, onCopy, footer }: {
  items: readonly EmoticonItem[]
  onCopy: (md5: string) => void
  footer?: ReactNode
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [extra, setExtra] = useState<Record<string, string>>({})
  const extraRef = useRef(extra)
  extraRef.current = extra

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const apply = (): void => { setWidth(el.clientWidth) }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [])

  const columns = Math.max(1, Math.floor((Math.max(0, width - 20) + GAP_PX) / (MIN_COL_PX + GAP_PX)))
  const rowCount = Math.ceil(items.length / columns)
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    overscan: 1,
  })
  const virtualRows = virtualizer.getVirtualItems()
  const visibleKey = virtualRows.map((row) => row.index).join(',')

  useEffect(() => {
    const missing: EmoticonItem[] = []
    for (const row of virtualRows) {
      const start = row.index * columns
      for (let i = 0; i < columns; i += 1) {
        const item = items[start + i]
        if (!item || item.file || extraRef.current[item.md5] || !item.cdnUrl) continue
        missing.push(item)
      }
    }
    if (missing.length === 0) return undefined
    let cancelled = false
    void (async () => {
      for (let i = 0; i < missing.length && !cancelled; i += 2) {
        const pair = missing.slice(i, i + 2)
        const saved = await Promise.all(pair.map(async (item) => {
          try {
            const result = await apiGetEmoticonDataUrl({
              md5: item.md5.toLowerCase(),
              ...(item.cdnUrl ? { emojiUrl: item.cdnUrl } : {}),
            })
            return result.file ? [item.md5, result.file] as const : null
          } catch {
            return null
          }
        }))
        if (cancelled) return
        setExtra((prev) => {
          let changed = false
          const next = { ...prev }
          for (const row of saved) {
            if (!row || next[row[0]] === row[1]) continue
            next[row[0]] = row[1]
            changed = true
          }
          return changed ? next : prev
        })
      }
    })()
    return () => { cancelled = true }
    // 只跟当前视口走。extra 用 ref 读，避免每存一张就重开下载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, columns, items])

  return (
    <div ref={scrollRef} className={css.emoScroll}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualRows.map((row) => {
          const start = row.index * columns
          const rowItems = items.slice(start, start + columns)
          return (
            <div
              key={row.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${row.start}px)`,
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gap: GAP_PX,
              }}
            >
              {rowItems.map((item, index) => (
                <EmoticonCell
                  key={item.md5}
                  e={extra[item.md5] ? { ...item, file: extra[item.md5] } : item}
                  onCopy={onCopy}
                  itemIndex={start + index}
                />
              ))}
            </div>
          )
        })}
      </div>
      {footer}
    </div>
  )
}
