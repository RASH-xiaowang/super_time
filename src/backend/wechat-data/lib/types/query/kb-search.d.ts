import type { KbSearchResult } from '../types.ts';
/**
 * 一次检索默认返回多少条。
 *
 * 20 而不是消息检索的 400：知识库的单元是**文件块**（一块最长 500 字），
 * 20 条已经铺满一屏可读内容；再多用户也不会逐条读，只会让一次 RPC 变慢。
 */
export declare const DEFAULT_KB_TOP_K = 20;
/** 单次检索的条数上限（防止调用方传一个把界面拖死的数）。 */
export declare const MAX_KB_TOP_K = 100;
/** 摘要窗口：命中词前后各多少字符（设计稿 §8.4）。 */
export declare const KB_SNIPPET_RADIUS = 60;
/** 检索入参。 */
export interface KbSearchOptions {
    /** 用户输入（可为多词，空格分隔）。 */
    query?: string;
    /** 最多返回多少条；不给按 `DEFAULT_KB_TOP_K`。 */
    topK?: number;
    /**
     * 只搜「允许参与 RAG」的文件（`kb_files.include_in_rag = 1`）。
     *
     * 问答路径**必须**传 true：文件级开关是用户对「我的这份文件能不能被送进模型」
     * 的显式表态，问答把它的正文写进 prompt 就等于把开关绕过去了。
     * 面板检索保持缺省（false）—— 那是用户在自己本机看自己的文件，不受该开关约束。
     */
    onlyRag?: boolean;
}
/**
 * 在某个知识库里做关键词检索。
 *
 * 排序交给 FTS5 的 `bm25`（`ORDER BY rank`），不自己算相似度 ——
 * 消息检索那条路径已经验证过它的排序比「按插入顺序取前 N」好得多，两处口径一致。
 *
 * ⚠ **不能**为了性能把 `MATCH` 写进子查询先取全局前 N 再按库过滤：
 * 那样在「甲库命中一千块、乙库只有十块」时，全局前 N 会被甲库占满，
 * 乙库明明有内容却搜不出来 —— 这是**正确性**问题，不是性能取舍。
 * 正确写法是 MATCH 与库过滤一起下推（SQLite 会先算匹配集再 join）。
 * @param decryptedDir - 解密数据根（库文件在它的父目录下）。
 * @param kbId - 目标知识库；作用域过滤**只此一处**。
 * @param opts - 查询词、条数，以及是否只搜「允许参与 RAG」的文件（问答路径要开）。
 * @returns 命中（按相关度）+ 统计 + 降级说明；库读不到时给 `readError`。
 */
export declare function searchKb(decryptedDir: string, kbId: number, opts?: KbSearchOptions): KbSearchResult;
