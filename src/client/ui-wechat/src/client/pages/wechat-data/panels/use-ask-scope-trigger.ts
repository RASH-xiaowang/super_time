/**
 * 问答输入框的 `@` 触发状态。
 *
 * 文本本身仍由 `AskPanel` 持有；本 hook 只负责识别触发、维护浮层开关，
 * 以及在选择完成后交回触发字符下标供清理。
 */
import { useCallback, useState, type ChangeEvent, type Dispatch, type SetStateAction } from 'react'
import { detectScopeTrigger } from './ask-scope-trigger.ts'

export interface AskScopeTrigger {
  open: boolean
  triggerAt: number | null
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void
  close: () => void
  consume: () => number | null
}

/**
 * @param question - 当前输入内容。
 * @param setQuestion - 写入当前输入内容。
 * @returns 浮层状态与输入框变更处理器。
 */
export function useAskScopeTrigger(
  question: string,
  setQuestion: Dispatch<SetStateAction<string>>,
): AskScopeTrigger {
  const [open, setOpen] = useState(false)
  const [triggerAt, setTriggerAt] = useState<number | null>(null)

  const onChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>): void => {
    const next = event.target.value
    const native = event.nativeEvent as InputEvent
    const at = detectScopeTrigger(question, next, event.target.selectionStart, native.inputType)
    setQuestion(next)
    if (at !== null) {
      setTriggerAt(at)
      setOpen(true)
      return
    }
    // 用户把触发用的 @ 删掉后，浮层不应继续悬空。
    if (triggerAt !== null && next[triggerAt] !== '@') {
      setTriggerAt(null)
      setOpen(false)
    }
  }, [question, setQuestion, triggerAt])

  const close = useCallback((): void => {
    setOpen(false)
    setTriggerAt(null)
  }, [])

  const consume = useCallback((): number | null => {
    const at = triggerAt
    setOpen(false)
    setTriggerAt(null)
    return at
  }, [triggerAt])

  return { open, triggerAt, onChange, close, consume }
}
