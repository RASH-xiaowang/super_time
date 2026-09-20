/**
 * 文档实体层 —— 把「文件里面的内容」变成知识图谱能用的节点。
 *
 * 为什么要有这一层：知识图谱原本只有笔记节点 + `[[链接]]` 边，用户在「文件」分段里
 * 登记了几十份资料，图上却一个都看不见 —— 图谱被定义成「笔记的结构」，而不是
 * 「这个知识库里有什么」。这一层把文件与文件内部的章节结构抬成节点，
 * 让图能回答「哪些资料彼此相关」。
 *
 * 三条硬约束，决定了这里能做什么、不能做什么：
 *   ① **只到文件与章节两级，绝不到 chunk。** 分块是 500 字一块、单文件上限两万块
 *      （`chunk.ts` 的 `CHUNK_MAX_CHARS` / `MAX_CHUNKS_PER_FILE`），一份百页 PDF 就是
 *      150–250 个块。拿块当节点会同时撑爆额度、并造出设计稿
 *      `GRAPH-KNOWLEDGE-REDESIGN.html` §「为什么不新增节点类型」里警告过的
 *      「以枢纽为中心的星形」塌陷。
 *   ② **全部本地、确定性、不出网。** 这里不调用模型、不做 embedding。
 *      `KB-WEKNORA-GAP.md` 把「chunk 级 LLM 抽取实体」列为尚未实现的 G-07，
 *      那是另一档功能，不该借这条路偷偷进来。
 *   ③ **本层只看 `wechat_kb_files.db`。** 笔记存在另一个 db 文件里，
 *      `notes.ts` 那层物理上看不见文件（它自己的注释就写着 `fileCount` 在这里恒为 0）。
 *      所以「笔记 ↔ 文件」的合并只发生在 gateway 层，不在这里。
 */
import type { DatabaseSync } from 'node:sqlite';
/** 文件节点的 id 前缀。 */
export declare const FILE_NODE_PREFIX = "file:";
/** 章节节点的 id 前缀。 */
export declare const DOC_NODE_PREFIX = "doc:";
/** 单个文件最多贡献多少个章节节点（超出按出现顺序截断）。 */
export declare const MAX_SECTIONS_PER_FILE = 24;
/** `findFilesMentioning` 的默认返回上限（一份标题被几十份文件提到时不至于炸开）。 */
export declare const DEFAULT_MENTION_FILE_LIMIT = 20;
/** 一个登记文件。 */
export interface KbFileNode {
    id: number;
    /** 文件名（不含路径）。 */
    label: string;
    ext: string;
    chunkCount: number;
    charCount: number;
    parseState: string;
}
/** 一个章节实体：**跨文件归并**后的同名章节。 */
export interface KbSectionNode {
    /** `doc:` 前缀之后的归一化键（小写）。 */
    key: string;
    /** 展示用的标签（保留首次见到的大小写）。 */
    label: string;
    /**
     * 出现过这一节的文件，以及**各自**的出现次数（按首次出现顺序）。
     * 逐文件计数而不是只留一个总数：containment 边的权重要按「这一节在这个文件里
     * 出现了几次」来定，只给总数的话，「一份文件里出现 5 次」和「5 份文件各出现 1 次」
     * 会画成一样的线，而前者明显是这份文档的主干、后者只是撞名。
     */
    files: Array<{
        id: number;
        count: number;
    }>;
    /** 总出现次数（各文件之和），详情面板用。 */
    occurrences: number;
}
/**
 * 把一条 `kb_chunks.heading` 归一化成可当实体名的标签。
 *
 * 存进去的 heading 长这样：`测试说明文档（Markdown） › 简介`、`二、里程碑（续 2）`、
 * `员工名单 › 列名 姓名	部门	工号`、以及大量空串。直接拿来当节点会画出一堆
 * 「（续 3）」和带制表符的列名串。四条规则各对应一个真实来源：
 *   · **取 `›` 的末段** —— 存法是 `父 › 本段`（`chunk.ts` 的 `joinHeading`），
 *     而跨文件合并要求键里不能带着各文件自己的文档名，否则「简介」永远合不成一个节点；
 *   · **剥掉结尾的 `（续 N）`** —— 长段被硬切时 `withContinuation` 追加的后缀，
 *     是分块器留下的痕迹而不是一节的名字；整条 heading 本来就空时，剥完就剩空串；
 *   · **丢弃以 `列名` 开头的** —— xlsx/csv 的列名摘要（`chunk.ts` 里那行
 *     `joinHeading(block.heading, '列名 ' + clipped)`），它描述表结构、且含制表符；
 *   · **长度夹在 [2, 40]** —— 越界的多半是解析事故。
 * @param raw - 原始 heading（可为空串）。
 * @returns 归一化后的标签；不该成为节点时返回 `null`。
 */
export declare function normalizeHeading(raw: string): string | null;
/**
 * 读出某个库的文件与章节实体。
 * @param db - 已打开的 `wechat_kb_files.db`。
 * @param kbId - 作用域（库 id）。所有查询都带它，跨库不串。
 * @returns 文件节点与归并后的章节节点。
 */
export declare function readDocEntities(db: DatabaseSync, kbId: number): {
    files: KbFileNode[];
    sections: KbSectionNode[];
};
/** 文档实体层对图谱的贡献：节点两组 + 边两组。 */
export interface DocGraphRead {
    files: KbFileNode[];
    sections: KbSectionNode[];
    /** `file:<id>` → `doc:<key>`：这一节确实在这份文件里（结构事实，不是推断）。 */
    containEdges: Array<{
        source: string;
        target: string;
        weight: number;
        kind: 'contain';
    }>;
    /** `note:<id>` → `file:<id>`：笔记标题作为连续子串出现在该文件正文里（推断）。 */
    mentionEdges: Array<{
        source: string;
        target: string;
        weight: number;
        kind: 'mention';
    }>;
    /** 文件库读不到。**必须与「这个库没有文件」可区分**（N1 同一条纪律）。 */
    readError?: string;
}
/**
 * 读出一个库的文档实体，并算出它与笔记之间的边。
 *
 * 为什么这一层要自己开库而不是由 gateway 传句柄：与 `countKbFilesByKb` 同一个口径
 * （它也只接 `decryptedDir`），调用方不必知道文件库的存在。
 *
 * 读失败时返回**空**而不是抛：图谱的主体是笔记，一份读不到的文件库不该让整张图消失。
 * 但必须把 `readError` 带回去 —— 否则界面上「没有文件节点」会被读成「这个库没登记过文件」，
 * 而真因是库打不开。
 * @param decryptedDir - 解密数据根（`<数据根>/decrypted`）。
 * @param kbId - 作用域。
 * @param notes - 当前库的笔记（只需要 id 与标题，标题拿去查 mention）。
 * @param mentionLimitPerNote - 单条笔记最多连到几份文件。
 * @returns 节点与边；`readError` 非空时四组都是空的。
 */
export declare function readDocGraph(decryptedDir: string, kbId: number, notes: ReadonlyArray<{
    id: number;
    title: string;
}>, mentionLimitPerNote?: number): DocGraphRead;
/**
 * 哪些文件的正文里出现过这段文字。
 *
 * 走 `kb_chunks_fts` 而不是扫 `kb_chunks.text`：那张索引存的是 `bigramTokens` 切好的
 * tokens，而 `ftsPhrase` 把查询词编成**引号短语**（bigram 必须连续出现），
 * 对中文而言等价于「这段文字作为连续子串出现过」—— 正是「这篇笔记讲的是不是这份文件」
 * 想要的语义。短语编法必须与索引侧同源，所以复用 `search.ts` 导出的 `ftsPhrase`，
 * 而不是在这里再切一遍。
 * @param db - 已打开的 `wechat_kb_files.db`。
 * @param kbId - 作用域。
 * @param phrase - 要查找的文字（通常是笔记标题）。
 * @param limit - 最多返回多少个文件。
 * @returns 命中的文件 id；无有效 token 或无命中时为空数组。
 */
export declare function findFilesMentioning(db: DatabaseSync, kbId: number, phrase: string, limit?: number): number[];
