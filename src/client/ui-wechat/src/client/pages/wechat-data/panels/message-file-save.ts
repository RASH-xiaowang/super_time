/**
 * The right-click "open file" action uses the same media-save lifecycle as the
 * inline file cards. Keeping the adapter here leaves `ChatsPanel` below the
 * function-size ratchet while still exposing progress, cancellation and a
 * terminal receipt to `ChatsView`.
 */
import { useCallback } from 'react'
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import type { ExportTaskState } from './export-task.ts'
import { useMediaSaveTask } from './media-save-task.ts'
import { downloadMessageFile } from './chats-support.tsx'

export interface MessageFileSaveTask {
  state: ExportTaskState
  open: (fileName: string, message: WechatMessage) => void
  cancel: () => Promise<void>
}

interface MessageFileSaveOptions {
  username?: string
  localId?: number
  size?: number
  createTime?: number
}

/** Preserve the ownership clues already used by the message context menu. */
function messageFileSaveOptions(message: WechatMessage, sessionUsername?: string): MessageFileSaveOptions {
  const bytes = Number(message.rich?.fileSize)
  return {
    ...(sessionUsername ? { username: sessionUsername } : {}),
    ...(message.localId > 0 ? { localId: message.localId } : {}),
    ...(Number.isFinite(bytes) && bytes > 0 ? { size: bytes } : {}),
    ...(message.createTime ? { createTime: message.createTime } : {}),
  }
}

/**
 * Run the message-menu file save through `useMediaSaveTask`.
 * The old success/error notice text is retained alongside the shared status card.
 */
export function useMessageFileSaveTask(
  flash: (text: string) => void,
  sessionUsername?: string,
): MessageFileSaveTask {
  const mediaSave = useMediaSaveTask()

  const open = useCallback((fileName: string, message: WechatMessage): void => {
    const options = messageFileSaveOptions(message, sessionUsername)
    void mediaSave.save<string>({
      idPrefix: 'chat-file-menu',
      label: '打开文件 · ' + fileName,
      successMessage: (path) => '已保存原文件 → ' + path,
      run: async (jobId) => {
        const result = await downloadMessageFile(fileName, { ...options, jobId })
        if (result.error) throw new Error(result.error)
        return result.path ?? null
      },
    }).then((outcome) => {
      if (outcome.ok) flash(outcome.message)
      else if (!outcome.canceled) flash('打开失败：' + outcome.error)
    })
  }, [flash, mediaSave.save, sessionUsername])

  return {
    state: mediaSave.state,
    open,
    cancel: mediaSave.cancel,
  }
}
