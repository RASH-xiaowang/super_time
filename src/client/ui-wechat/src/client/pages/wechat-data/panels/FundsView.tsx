/**
 * 资金往来：汇总和分析占满本页，逐笔明细从右侧抽屉展开。
 * 明细表格在抽屉里自己滚动，不跟图表挤在同一条滚动条里。
 */
import { useEffect, useState } from 'react'
import { Drawer } from '../ui/kit.tsx'
import { LedgerPanel } from './Ledger.tsx'
import { RecordsPanel } from './Records.tsx'
import css from './ledger.module.css'

export function FundsView({
  onOpenChat,
  seedQuery,
}: {
  onOpenChat?: (username: string, localId?: number) => void
  seedQuery?: { q: string; nonce: number }
}): React.JSX.Element {
  const [open, setOpen] = useState(seedQuery != null)
  useEffect(() => {
    if (seedQuery) setOpen(true)
  }, [seedQuery])
  return (
    <div className={css.funds}>
      <LedgerPanel
        onOpenChat={(username) => { onOpenChat?.(username) }}
        onOpenRecords={() => { setOpen(true) }}
      />
      <Drawer open={open} onClose={() => { setOpen(false) }} title="逐笔明细" width={920} maxWidth={960} fill>
        <div className={css.detailHost}>
          <RecordsPanel
            onOpenChat={(username, localId) => {
              setOpen(false)
              onOpenChat?.(username, localId)
            }}
            seedQuery={seedQuery}
          />
        </div>
      </Drawer>
    </div>
  )
}
