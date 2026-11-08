/** 消息列表批量模式：选择范围、可执行数量和批量动作编排。 */
import { useEffect, useState } from 'react'
import type { MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import {
  batchDeleteEligibility,
  batchProbeEligibility,
  batchResendEligibility,
  isBatchSelectable,
} from './message-list-view.ts'

export function useMessageListBatch(input: {
  records: MessageListRecord[]
  busy: boolean
  onResend: (records: MessageListRecord[]) => Promise<boolean>
  onProbe: (records: MessageListRecord[]) => Promise<boolean>
  onDelete: (records: MessageListRecord[]) => Promise<boolean>
}) {
  const [active, setActive] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const selectable = input.records.filter(isBatchSelectable)
  const selectableIds = new Set(selectable.map((record) => record.id))
  const selectedRecords = input.records.filter((record) => selectedIds.has(record.id))
  const resendable = selectedRecords.filter((record) => batchResendEligibility(record).eligible)
  const probeable = selectedRecords.filter((record) => batchProbeEligibility(record).eligible)
  const deletable = selectedRecords.filter((record) => batchDeleteEligibility(record).eligible)
  const selectedSelectableCount = selectedRecords.filter((record) => selectableIds.has(record.id)).length
  const allSelected = selectable.length > 0 && selectedSelectableCount === selectable.length

  useEffect(() => {
    const availableIds = new Set(
      input.records.filter(isBatchSelectable).map((record) => record.id),
    )
    setSelectedIds((current) => {
      let changed = false
      const next = new Set<number>()
      for (const id of current) {
        if (availableIds.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : current
    })
  }, [input.records])

  const toggleMode = (): void => {
    setSelectedIds(new Set())
    setActive((current) => !current)
  }

  const toggleAll = (): void => {
    setSelectedIds(allSelected ? new Set() : new Set(selectable.map((record) => record.id)))
  }

  const clear = (): void => {
    setSelectedIds(new Set())
  }

  const toggle = (id: number): void => {
    if (!selectableIds.has(id)) return
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const runResend = async (): Promise<void> => {
    if (input.busy || resendable.length === 0) return
    if (await input.onResend(resendable)) setSelectedIds(new Set())
  }

  const runProbe = async (): Promise<void> => {
    if (input.busy || probeable.length === 0) return
    if (await input.onProbe(probeable)) setSelectedIds(new Set())
  }

  const runDelete = async (): Promise<void> => {
    if (input.busy || deletable.length === 0) return
    if (await input.onDelete(deletable)) setSelectedIds(new Set())
  }

  return {
    active,
    selectedIds,
    selectableCount: selectable.length,
    selectedCount: selectedRecords.length,
    resendableCount: resendable.length,
    probeableCount: probeable.length,
    deletableCount: deletable.length,
    allSelected,
    toggleMode,
    toggleAll,
    clear,
    toggle,
    runResend,
    runProbe,
    runDelete,
  }
}
