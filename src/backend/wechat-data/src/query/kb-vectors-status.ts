/**
 * 知识库向量索引的**就绪判定**（2026-11-20 从 `kb-vectors.ts` 拆出）。
 *
 * ## 为什么单独成模块
 *
 * 一是 `kb-vectors.ts` 顶到了文件尺寸棘轮（1000 行）；二是这一族与「怎么建索引」
 * 完全正交：建索引是两阶段 + 出网 + 写事务，判定是**只读的几条 SQL + 纯函数**。
 * 混在一起时，想单测「什么样的库算就绪」就必须连着构建器一起走。
 *
 * ## 判定的优先级（顺序即语义）
 *
 * 结构（schema）→ 有没有行 → 有没有维度 → 模型能不能定 → 模型对不对 → 正文是否完整 → 覆盖率。
 * 越靠前越"根本"，文案也不该被后面的细节盖住：换模型要整体重算，比"补几块新增"更紧急。
 *
 * 其中「正文是否完整」这一条（`truncation-changed`）是 2026-11-20 新增的：
 * 真机实测 5,143 个分块**全部**超过 200 字（中位数 489），而旧索引只嵌了每块前 200 字 ——
 * **约 148 万字正文对语义检索不可见**，界面上却一切正常。这条判据让那类索引自动重算。
 *
 * @module query/kb-vectors-status
 */
import { DatabaseSync } from './db-open.ts'
import { CHUNK_MAX_CHARS } from './kb/chunk.ts'
import { kbFilesDbPath } from './kb-paths.ts'

/** 向量库 schema 版本；结构或哈希算法变化时自动重建。 */
export const KB_VECTOR_SCHEMA_VERSION = '1'

/**
 * 索引为什么**不能用**（空串 = 就绪）。
 *
 * 每个值都要能翻译成一句"下一步该做什么"，否则界面只能合成一句「未就绪」——
 * 那等于什么都没说（这条面板以前就吃过「读失败被显示成确实没有」的亏）。
 */
export type KbVectorStaleReason =
  | '' | 'no-index' | 'model-mismatch' | 'schema-mismatch' | 'no-dim' | 'no-model' | 'incomplete'
  /** 索引是用旧的分块截断策略建的（每块只嵌了前 N 字）⇒ 需要整份重算。 */
  | 'truncation-changed'

/**
 * 知识库分块喂给 embedding 时的**每块字符上限**。
 *
 * ## 为什么是常量，而不是配置项
 *
 * 这个值曾经取 `maxCharsPerDoc`（默认 200）。真机实测：5,143 个分块**全部**超过 200 字
 * （中位数 489、最大 500），即每块平均只嵌了 41%，全库约 **148 万字正文对语义检索
 * 完全不可见** —— 这是「关键词搜得到、换个说法搜不到」的直接来源。
 *
 * `maxCharsPerDoc` 的语义是「单条消息可能很长，截断省 token」，那是**消息域**的关切；
 * 知识库的分块本来就是 500 字上限，已经是检索的基本单位，再截一次只会丢正文。
 *
 * ## 为什么不随配置浮动
 *
 * 它同时参与就绪判定（`truncation-changed`）：若随 `maxCharsPerDoc` 变化，
 * 用户改那个与知识库无关的旋钮就会让整库索引失效、重算几万块。常量才不产生这种耦合。
 * @returns 每块参与向量的字符上限。
 */
export function kbEmbedChars(): number {
  return CHUNK_MAX_CHARS
}

/** `staleReasonOf` 的入参（对象形式，避免 7 个位置参数被调换而无人发现）。 */
export interface StaleReasonInput {
  /** 本库已入库的向量行数。 */
  rows: number
  /** 本库当前**应有**的块数（`include_in_rag = 1` 的分块）。 */
  expected: number
  /** 本库行级维度（不读全局 meta）。 */
  dim: number
  /** meta 里的 schema 版本。 */
  ver: string
  /** 本库行级出现过的模型名。 */
  models: string[]
  /** 当前解析出的嵌入模型名。 */
  current: string
  /** 建索引时实际用的每块字符上限（meta 里记的）；空串 = 老库没记过。 */
  storedChars?: string
  /** 当前策略下的每块字符上限（`kbEmbedChars()`）。 */
  curChars?: number
}

/**
 * 就绪判定的七个条件（顺序即优先级）。
 * @param input - 见 {@link StaleReasonInput}。
 * @returns 未就绪原因；空串 = 就绪。
 */
export function staleReasonOf(input: StaleReasonInput): KbVectorStaleReason {
  const { rows, expected, dim, ver, models, current, storedChars = '', curChars = 0 } = input
  if (ver !== KB_VECTOR_SCHEMA_VERSION) return 'schema-mismatch'
  if (rows === 0) return 'no-index'
  if (dim <= 0) return 'no-dim'
  if (current === '') return 'no-model'
  // 必须**恰好一个**模型且等于当前：两个说明库里混过批次（半重建），
  // 不等于当前说明换过模型 —— 两者都不能拿去算余弦。
  if (models.length !== 1 || models[0] !== current) return 'model-mismatch'
  /*
   * 截断策略变了（或老库没记录）⇒ 整份重算。放在 `incomplete` 之前：
   * 截断影响到**每一块**，比「补几块新增」更值得先做，文案也不该被后者盖住。
   * 老库没记这个键，正好说明它是按旧策略建的 —— 一律判 stale。
   */
  if (curChars > 0 && storedChars !== String(curChars)) return 'truncation-changed'
  if (rows < expected) return 'incomplete'
  return ''
}

/**
 * 本库当前**应该**有多少块参与向量检索。
 *
 * 与建库语料 SQL 完全同源（`kb_chunks ⋈ kb_files WHERE include_in_rag=1`）：
 * 只数会被送进 embedding 的块，才算「应然」。读不到文件库时返回 0（不阻断状态读取，
 * 此时 rows>0 仍按已建处理；真正的读失败由文件面板自己的 readError 报）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @returns 应有块数。
 */
export function countIndexableChunks(decryptedDir: string, kbId: number): number {
  try {
    const db = new DatabaseSync(kbFilesDbPath(decryptedDir), { readOnly: true })
    try {
      const row = db.prepare(
        'SELECT COUNT(*) AS c FROM kb_chunks c JOIN kb_files f ON f.id = c.file_id '
        + 'WHERE c.kb_id = ? AND f.include_in_rag = 1',
      ).get(kbId) as { c?: number } | undefined
      return Number(row?.c ?? 0) || 0
    } finally {
      db.close()
    }
  } catch {
    return 0
  }
}
