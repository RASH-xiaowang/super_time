/**
 * 微信原生提醒列表。导入按钮在待办页头；这里只把库里已有的提醒先显示出来。
 */
import { useEffect, useState } from 'react'
import { apiGetHandoffReminds } from '../api.ts'
import type { HandoffRemindItem } from '@deepseek-ai/dsh-wechat-data/types'
import { Card } from '../ui/kit.tsx'
import css from './tasks.module.css'

function stamp(time: number | null): string {
  if (time === null || !Number.isFinite(time) || time <= 0) return ''
  const ms = time < 1_000_000_000_000 ? time * 1000 : time
  return new Date(ms).toLocaleString()
}

export function HandoffRemindList(): React.JSX.Element | null {
  const [items, setItems] = useState<HandoffRemindItem[] | null>(null)

  useEffect(() => {
    let alive = true
    void apiGetHandoffReminds()
      .then((snapshot) => {
        if (alive) setItems(snapshot.items ?? [])
      })
      .catch(() => {
        if (alive) setItems([])
      })
    return () => { alive = false }
  }, [])

  if (items === null || items.length === 0) return null
  return (
    <Card>
      <div className={css.taskTitle}>微信里的提醒</div>
      <div className={css.list}>
        {items.map((item) => (
          <div key={item.id} className={css.taskRow}>
            <div className={css.taskInfo}>
              <div className={css.taskTitle}>{item.title}</div>
              {stamp(item.time) !== '' && <div className={css.taskMeta}>{stamp(item.time)}</div>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}
