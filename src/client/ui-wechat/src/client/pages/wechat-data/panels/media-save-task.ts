/**
 * Media saves use the same job lifecycle as batch exports.
 *
 * Backend media exports settle jobs through `finishStreamJob`, so the existing
 * export task still owns progress events, polling fallback and cancellation.
 * This adapter only turns a save helper's `null` result into the canceled state.
 */
import { useCallback } from 'react'
import {
  useExportTask,
  type ExportTaskResult,
  type ExportTaskState,
} from './export-task.ts'

export interface MediaSaveRequest<T> {
  idPrefix: string
  label: string
  successMessage: (result: T) => string
  run: (jobId: string) => Promise<T | null>
}

export interface MediaSaveTask {
  state: ExportTaskState
  running: boolean
  finishing: boolean
  save: <T>(request: MediaSaveRequest<T>) => Promise<ExportTaskResult<T>>
  cancel: () => Promise<void>
  reset: () => void
}

/** Matches `isCanceledExportError` without depending on an implementation detail. */
export class MediaSaveCanceledError extends Error {
  constructor() {
    super('用户已取消保存')
    this.name = 'MediaSaveCanceledError'
  }
}

/**
 * Run one single-file media save with a generated job id.
 *
 * Returning `null` from `run` means the user dismissed the native save dialog.
 * Raising `MediaSaveCanceledError` lets `useExportTask` close the card in the
 * canceled state instead of falsely reporting success.
 */
export function useMediaSaveTask(): MediaSaveTask {
  const task = useExportTask()
  const save = useCallback(async function saveMedia<T>(
    request: MediaSaveRequest<T>,
  ): Promise<ExportTaskResult<T>> {
    return task.run(async ({ jobId }) => {
      const result = await request.run(jobId)
      if (result === null) throw new MediaSaveCanceledError()
      return result
    }, {
      idPrefix: request.idPrefix,
      label: request.label,
      successMessage: request.successMessage,
    })
  }, [task.run])

  return {
    state: task.state,
    running: task.running,
    finishing: task.finishing,
    save,
    cancel: task.cancel,
    reset: task.reset,
  }
}
