/**
 * 删库弹层与删库回执的**文案**（纯函数，故意从 `KbRail.tsx` 里抽出来）。
 *
 * 为什么值得单独一个模块：这几句话是「删掉这个库会丢什么」的**唯一**说明，而它们最容易
 * 写错的地方不看运行结果看不出来 —— 只看笔记条数，就会对一个「0 条笔记 / 5 个文件」的库
 * 说「这个库是空的」。真机探针（`working/cdp-kb-files.mjs` 第 10 步）实测到过这一句，
 * 当时库里有 2 个文件、5 个文本块正要被一并清掉，点下去 blob / 分块 / FTS / 向量全没。
 *
 * 抽成纯函数之后，「说什么」由单测钉住（`kb-delete-copy.spec.ts`），组件只负责摆位置 ——
 * 本仓库没有组件测试环境，文案写在 JSX 里就只能靠源码级文本断言，那只能证明「串还在」，
 * 证明不了「0 个文件时说的是什么」。
 *
 * 两条纪律（都由用例守着）：
 *   ① **文件数与笔记数同级**：`fileCount > 0` 时不许出现「空的」「不会丢」这类话；
 *   ② `movedFiles` / `removedFiles` 的 `undefined` 与 `0` **必须分开说**：
 *      `0` = 清点过、确实没有；`undefined` = 文件侧没清点成（两个库文件之间没有跨库事务，
 *      后端只能 best-effort）。混成一句会把「没清点」说成「一个都没有」—— 两句相反的话。
 */

/** 删库前已知的「库里有什么」（来源：`KbMeta` 的 `noteCount` / `fileCount`）。 */
export interface KbContentCounts {
  /** 库内笔记条数。 */
  noteCount: number
  /** 库内登记文件条数。 */
  fileCount: number
}

/** 删库结果里与文件 / 笔记有关的计数（来源：`KbMutationResult`）。 */
export interface KbDeleteOutcome {
  /** 被删库的显示名。 */
  kbName: string
  /** 用户选的分支。 */
  action: 'purge' | 'reassign'
  /** `reassign` 的目标库显示名（拿不到时退化成「目标库」）。 */
  targetName?: string
  movedNotes?: number
  removedNotes?: number
  movedFiles?: number
  removedFiles?: number
}

/**
 * 「2 条笔记」「3 个文件」——**只列出非零项**，两个都为零时返回空数组。
 * @param counts - 库里有什么。
 * @returns 片段数组，供调用方决定连接词（正文用「和」、按钮用「/」）。
 */
export function contentParts(counts: KbContentCounts): string[] {
  const parts: string[] = []
  if (counts.noteCount > 0) parts.push(`${counts.noteCount} 条笔记`)
  if (counts.fileCount > 0) parts.push(`${counts.fileCount} 个文件`)
  return parts
}

/**
 * 删库弹层的**第一句**（「这个库里有什么 · 会怎样」）。
 * @param counts - 库里有什么。
 * @returns 说明句；两者都为零时才是「空的」。
 */
export function deleteDialogLead(counts: KbContentCounts): string {
  const parts = contentParts(counts)
  if (parts.length === 0) return '这个库里没有笔记也没有文件，删除它不会丢任何内容。'
  return `这个库里有 ${parts.join(' 和 ')}。删除知识库时它们要一起删掉，还是移到别的库？`
}

/**
 * 危险按钮的标签。把条数写进按钮，用户**在点之前**就知道这一下会带走多少东西。
 * @param counts - 库里有什么。
 * @returns 「一并删除（2 条笔记 / 3 个文件）」；两者都为零时只有「一并删除」。
 */
export function purgeButtonLabel(counts: KbContentCounts): string {
  const parts = contentParts(counts)
  return parts.length === 0 ? '一并删除' : `一并删除（${parts.join(' / ')}）`
}

/**
 * `reassign` 分支是否该出现。
 *
 * 后端 `kbFilesOnKbDelete(dir, kbId, targetKbId)` **连文件一起迁移**（设计稿 §7.1），
 * 所以「0 条笔记但有文件」的库同样该给「移到…」这条路 —— 只按 `noteCount > 0` 判，
 * 一个装了几百份资料、笔记一条没写的库就只剩「一并删除」一个出口。
 * @param counts - 库里有什么。
 * @returns 是否给「移到别的库」分支。
 */
export function canMoveInstead(counts: KbContentCounts): boolean {
  return counts.noteCount > 0 || counts.fileCount > 0
}

/**
 * 删库成功后的回执（`useTransientNotice` 显示几秒）。
 *
 * 设计稿 §10 边界 7 的原话是「回执写『N 个文件与目标库内容重复，未迁移』」——
 * 那正对应这里的 `reassign` + `removedFiles > 0` 分支。
 * @param outcome - 被删的库、走的分支、后端返回的四个计数。
 * @returns 一句话回执，含笔记与文件两侧的结论。
 */
export function deleteReceipt(outcome: KbDeleteOutcome): string {
  const kb = `「${outcome.kbName}」`
  // 目标库名自带书名号，所以拼接处**不留空格**（`已移到「生活」`）；
  // 退化值「目标库」同样不留空格（`已移到目标库`）也读得通。
  const to = outcome.targetName ? `「${outcome.targetName}」` : '目标库'
  const head = outcome.action === 'purge'
    ? `已删除知识库 ${kb}：${outcome.removedNotes ?? 0} 条笔记已一并删掉`
    : `已删除知识库 ${kb}：${outcome.movedNotes ?? 0} 条笔记已移到${to}`

  const tail: string[] = []
  if (outcome.movedFiles === undefined && outcome.removedFiles === undefined) {
    // 后端没清点成（best-effort 失败）。**不能说 0** —— 那正是「一个都没有」。
    tail.push('文件侧没清点成，请到「文件」分段核对')
  } else if (outcome.action === 'purge') {
    tail.push(`${outcome.removedFiles ?? 0} 个文件已一并删掉`)
  } else {
    const moved = outcome.movedFiles ?? 0
    const removed = outcome.removedFiles ?? 0
    if (moved > 0) tail.push(`${moved} 个文件已移到${to}`)
    // §10 边界 7：目标库已有同 sha256 的文件时唯一索引不允许两行 ⇒ 不迁移，计入 removedFiles
    if (removed > 0) tail.push(`${removed} 个文件与目标库内容重复，未迁移`)
    if (tail.length === 0) tail.push('没有文件需要处理')
  }
  return `${head}；${tail.join('；')}。`
}
