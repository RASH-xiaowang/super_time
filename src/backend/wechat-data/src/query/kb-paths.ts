/**
 * 知识库域的**路径真源**（三个产物各在哪儿）。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────────
 *   知识库现在有三个落盘产物：`wechat_kb_files.db`（登记 + 分块 + FTS）、
 *   `kb-blobs/`（内容寻址的原文副本）、`wechat_kb_vectors.db`（chunk 向量）。
 *   它们的路径函数被**两个方向**需要：
 *     · `kb-files.ts`（写路径）要用 files/blobs 两个；
 *     · `kb-vectors.ts`（向量库）要用 files 的路径来读语料、用自己的路径来建库；
 *     · 而 C4 之后 `kb-files.ts` 的删除级联要反向调用 `kb-vectors.ts` 的清向量。
 *   若把这些常量留在 `kb-files.ts`，上面最后一条就构成**循环导入**
 *   （kb-vectors → kb-files → kb-vectors）。ESM 的循环导入在这里**恰好**能跑
 *   （两端都只在函数体内使用对方，不在模块初始化期求值），但那是「靠运气」——
 *   任何人把某处改成顶层求值就会变成 undefined 而不报错。
 *   抽到这里之后依赖是单向的：`kb-paths ← kb-files`、`kb-paths ← kb-vectors`，
 *   与 `kb-search.ts` 头注里那条「依赖方向必须单向、不许有环」的纪律一致。
 *
 * ── 口径：三个产物都在 `dirname(decryptedDir)` 下 ────────────────────────
 *   与 `wechat_notes.db` / `wechat_rag_vectors.db` 同级。不放进 `decrypted/` 里，
 *   是因为 `decrypted/` 语义是「从微信库里解出来的东西」，而这些是用户自己导入的
 *   资料与它们的派生物 —— 混在一起会让「备份/清理 decrypted」这类操作牵连到它们。
 */
import { dirname, join } from 'node:path'

/** 文件库文件名（登记行 + 分块 + FTS 都在这里面）。 */
export const KB_FILES_DB = 'wechat_kb_files.db'

/** blob 副本目录名（内容寻址，`<sha256>.<ext>`）。 */
export const KB_BLOBS_DIR = 'kb-blobs'

/** 向量库文件名（独立一个文件：见 `kb-vectors.ts` 头注的两条理由）。 */
export const KB_VECTORS_DB = 'wechat_kb_vectors.db'

/**
 * 每库模型设置的文件名。
 *
 * 为什么又单开一个库而不是给 `kbs` 加列：`notes.ts` 的头注自述「只读写本地库，
 * 不出网、不调用模型」，而这张表存在的唯一理由就是「本库用哪个模型出网」——
 * 放进去等于让笔记模块变成模型配置的载体之一。`KB-COMPLETION-PLAN` §C1 的约束因此保留。
 * 它与 `wechat_kb_files.db` 也不同文件：那张表是**内容**（会随删文件而变），
 * 这张是**选择**（删库时才一起消失），两者生命周期不同。
 */
export const KB_MODELS_DB = 'wechat_kb_models.db'

/** 文件库路径（导出是为了让守卫用例能断言它与笔记库是两个文件）。 */
export function kbFilesDbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), KB_FILES_DB)
}

/** blob 副本目录（导出为了探针能直接检查副本是否被删）。 */
export function kbBlobsDir(decryptedDir: string): string {
  return join(dirname(decryptedDir), KB_BLOBS_DIR)
}

/** 向量库路径（与另两个产物同址）。 */
export function kbVectorsDbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), KB_VECTORS_DB)
}

/** 每库模型设置的路径（同样在 `dirname(decryptedDir)` 下）。 */
export function kbModelsDbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), KB_MODELS_DB)
}
