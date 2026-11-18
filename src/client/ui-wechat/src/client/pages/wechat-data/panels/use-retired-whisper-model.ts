/**
 * 已下线识别模型的迁移提示。
 *
 * `tiny` / `base` / `medium` 已从产品清单下线（中文准确率不足，或被更优模型全面压制），
 * 但老配置里可能还写着它们。这个钩子做两件事，**都不静默**：
 *   ① 把表单里的选择改成当前推荐的替代模型（尚未保存，用户仍要点「保存配置」）；
 *   ② 在语音提示位写明「哪个模型下线了、换成了哪个、保存后生效」。
 *
 * 只在首次拿到模型清单时跑一次：之后用户手动点别的卡片不会被这个钩子覆盖回去。
 * 独立成文件而不是塞回 `useSettingsState`，是为了不让那个已经 800 行的钩子继续变长
 * （M21 函数行数棘轮）。
 */
import { useEffect, useRef } from 'react'
import type { WhisperStatus } from '@deepseek-ai/dsh-wechat-data/types'
import { recommendedWhisperModel } from './settings-common.tsx'

/** 提示位只认这两种 message；这里只需要 err。 */
export interface RetiredWhisperModelMessage {
  kind: 'err'
  text: string
}

export interface RetiredWhisperModelInput {
  /** 模型清单；null = 还没探测完，此时不做任何判断。 */
  whisperStatus: WhisperStatus | null
  whisperDevice: 'cpu' | 'gpu'
  /** 当前表单里选中的模型 id（可能来自老配置）。 */
  whisperModel: string
  setWhisperModel: (id: string) => void
  setWhisperDirMsg: (msg: RetiredWhisperModelMessage) => void
}

/** 当前推荐模型：与 `WhisperModelLibrary` 里的「推荐」徽标保持同一口径。 */
export { recommendedWhisperModel }

export function useRetiredWhisperModel(input: RetiredWhisperModelInput): void {
  const { whisperStatus, whisperDevice, whisperModel, setWhisperModel, setWhisperDirMsg } = input
  const checked = useRef(false)

  useEffect(() => {
    // 清单还没到 / 已经跑过一次 / 还没有选择：都不动。
    if (checked.current || whisperStatus === null || whisperModel.trim() === '') return
    checked.current = true
    if (whisperStatus.models.some((model) => model.id === whisperModel)) return

    const replacement = recommendedWhisperModel(whisperDevice)
    setWhisperModel(replacement)
    setWhisperDirMsg({
      kind: 'err',
      text: `「${whisperModel}」已下线（中文准确率不足），已为你切换到「${replacement}」；点「保存配置」后生效`,
    })
  }, [setWhisperDirMsg, setWhisperModel, whisperDevice, whisperModel, whisperStatus])
}
