/**
 * 「输入 @ 打开检索范围选择」的纯逻辑。
 *
 * 只认**单字符插入**，且 @ 必须位于文本开头或空白之后：
 *   · `@`
 *   · `帮我查一下 @`
 * 不认 `a@b.com` 这类邮箱片段；粘贴、拖放、删除也不会误弹。
 */

/**
 * 判断本次输入是否刚刚插入了一个可触发范围选择的 @。
 * @param previous - 修改前的文本。
 * @param next - 修改后的文本。
 * @param caret - 修改后的光标位置。
 * @param inputType - 原生 `InputEvent.inputType`（未知时允许继续按文本形状判断）。
 * @returns 触发字符在 `next` 中的下标；不是触发输入时返回 `null`。
 */
export function detectScopeTrigger(
  previous: string,
  next: string,
  caret: number | null,
  inputType?: string,
): number | null {
  if (caret === null || !Number.isInteger(caret) || caret < 1) return null
  if (next.length !== previous.length + 1) return null
  if (next[caret - 1] !== '@') return null
  // 粘贴会整段插入，不能被当成「刚输入了一个 @」。
  if (inputType !== undefined && inputType !== 'insertText') return null
  // 删掉这个 @ 必须精确还原上一版，排除替换选区等复合编辑。
  if (next.slice(0, caret - 1) + next.slice(caret) !== previous) return null
  const before = next[caret - 2] ?? ''
  if (before !== '' && !/\s/.test(before)) return null
  return caret - 1
}

/**
 * 从文本中移除触发用的 @（只删指定的那一个）。
 * @param value - 当前文本。
 * @param index - 触发字符下标；为空或该位置已不是 @ 时原样返回。
 * @returns 清理后的文本。
 */
export function removeScopeTrigger(value: string, index: number | null): string {
  if (index === null || index < 0 || value[index] !== '@') return value
  return value.slice(0, index) + value.slice(index + 1)
}
