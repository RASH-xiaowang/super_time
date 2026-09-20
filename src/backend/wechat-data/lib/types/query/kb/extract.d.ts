/**
 * 文档实体抽取 —— 知识图谱的**推断层**。
 *
 * ── 与 `entities.ts` 的关系：并列、互不引用 ─────────────────────────────
 *   `entities.ts` 是**观测层**：全部本地、确定性、不出网、不调模型，产出的是
 *   「文档里确实存在的章节」与「确实提到了某个名字的边」。那三条规矩原样保留。
 *   本模块是**推断层**：让模型读一遍文件，说出它认为里面有哪些实体。
 *   两者必须分开，因为**可信度不同**：观测到的东西可以当事实引用，
 *   推断出来的东西必须标成推断（画布上是虚线），否则模型的一次幻觉就成了
 *   用户知识库里「确实有关系」的假证据。合流发生在 gateway 的 `getKnowledgeGraph`，
 *   边 kind 用 `suggest` 区分。
 *
 * ── 为什么按文件、不按 chunk（沿用 entities.ts 头注那条理由）─────────────
 *   一个 38 块的文件按块抽就是 38 次请求，成本与失败率都乘以块数，
 *   而产出（同一批主题词）高度重复。按文件一次出全篇，粒度够用。
 *
 * ── 为什么模型只「说名字」，不「建链接」────────────────────────────────
 *   本模块写的是 `kb_doc_entities` 这张**独立表**，绝不碰笔记正文、也不写 wiki 边。
 *   链接永远只由笔记正文里的 `[[目标]]` 派生（`notes.ts` 的 `parseWikiLinks`）。
 *   这样「模型建议过但用户没采纳」的东西不会出现在图上，
 *   撤销一个建议 = 删那几个字，不需要「回滚一次模型写入」。
 */
import { DatabaseSync } from 'node:sqlite';
/** 实体表的表名（守卫用例按名字断言）。 */
export declare const KB_ENTITIES_TABLE = "kb_doc_entities";
/** 允许的实体类别。模型给出别的值一律归到 `topic`（而不是照收）。 */
export declare const ENTITY_KINDS: readonly ["person", "org", "product", "place", "topic"];
export type EntityKind = (typeof ENTITY_KINDS)[number];
/** 一条抽出来的实体。 */
export interface DocEntity {
    fileId: number;
    fileName: string;
    label: string;
    kind: EntityKind;
    /** 模型给的重要度（0-100）；缺失时按 50。 */
    weight: number;
    /** 是哪个模型抽的（换模型后用户要能看出这批不是当前模型给的）。 */
    model: string;
    /** 抽取时间（毫秒）。 */
    at: number;
}
/** 一次抽取的落库结果。 */
export interface ExtractResult {
    ok: boolean;
    fileId?: number;
    /** 写进去的实体条数。 */
    saved?: number;
    /** 模型返回但被丢弃的行数（格式不对 / 名字过长 / 重复）。 */
    dropped?: number;
    error?: string;
}
/** 单个文件最多留多少条实体（模型爱堆列表，不封顶会把图谱画成一团毛线）。 */
export declare const MAX_ENTITIES_PER_FILE = 24;
/**
 * 解析模型返回的实体清单。
 *
 * 期望每行 `kind|label` 或 `kind<TAB>label`，可选第三段是重要度。
 * 实现上**极尽宽容**：Markdown 列表符号、引号、`-`/`*` 前缀、大小写、多余空格都吃掉；
 * 但**不猜**结构 —— 解析不出来的行直接丢，计入 `dropped`。
 * 为什么不做成抛错：一次格式跑偏就让整轮抽取失败，用户看到的是「又白发了一个请求」。
 * @param raw - 模型原文。
 * @returns 解析出的实体（已去重、已截断、已封顶）。
 */
export declare function parseEntityLines(raw: string): {
    items: Array<{
        label: string;
        kind: EntityKind;
        weight: number;
    }>;
    dropped: number;
};
/**
 * 造一个文件的抽取提示词。
 *
 * 三条内容约束都写在这里而不是靠 system 提示：
 *   · 只写文档里出现过的名字（防「补全常识」）；
 *   · 宁少勿多（模型爱堆一串通用词，那些在图上没有信息量）；
 *   · 严格行格式（解析器已经尽量宽容，但格式跑偏的代价是丢行）。
 * @param fileName - 文件名（模型判断类别时很依赖它）。
 * @param digest - 已经按预算截断过的正文摘要串。
 * @param truncated - 是否被截断过：截断过就必须写明，否则模型会声称这是整份文件的实体。
 * @returns 提示词。
 */
export declare function buildExtractPrompt(fileName: string, digest: string, truncated: boolean): string;
/**
 * 读某个文件的正文摘要（**只取参与 RAG 的文件**）。
 *
 * 与向量语料同一条 SQL 口径：关掉出网开关的文件连一次抽取都不该有机会被发出去。
 * @param db - 已打开的文件库连接。
 * @param kbId - 库。
 * @param fileId - 文件。
 * @param budget - 字符预算。
 * @returns `{ text, totalChars, truncated }`；文件不属于该库时返回 null。
 */
export declare function readDigestForExtract(db: DatabaseSync, kbId: number, fileId: number, budget: number): {
    text: string;
    totalChars: number;
    truncated: boolean;
} | null;
/**
 * 写入一个文件的实体（**整批替换**该文件的上一次结果）。
 *
 * 为什么是替换而不是追加：同一个文件重跑一次抽取，旧结果不是「另一批事实」，
 * 而是「同一个问题的旧答案」。追加会让图谱里同一个文件挂出两套互相矛盾的主题词。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 库。
 * @param fileId - 文件。
 * @param items - 解析好的实体。
 * @param model - 用的模型名。
 * @returns `{ ok, saved }`。
 */
export declare function saveDocEntities(decryptedDir: string, kbId: number, fileId: number, items: ReadonlyArray<{
    label: string;
    kind: EntityKind;
    weight: number;
}>, model: string): {
    ok: boolean;
    saved: number;
    error?: string;
};
/**
 * 抽取一个文件的实体（模型调用由调用方注入 —— 隐私闸门与模型名解析都住在 gateway）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 库。
 * @param fileId - 文件。
 * @param ask - 「提示词 → 模型原文」的函数（已含出网闸门）。
 * @param model - 记账用的模型名。
 * @param budget - 送给模型的字符预算。
 * @returns 抽取结果。
 */
export declare function extractFileEntities(decryptedDir: string, kbId: number, fileId: number, ask: (prompt: string) => Promise<string>, model: string, budget?: number): Promise<ExtractResult>;
/**
 * 读某个库的全部实体（图谱合流用）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 库。
 * @returns 实体列表；读失败时返回空列表 + 原因（不抛错 —— 图谱不能因为推断层坏了就整页打不开）。
 */
export declare function readDocEntities(decryptedDir: string, kbId: number): {
    items: DocEntity[];
    readError?: string;
};
/** 弹层里「实体抽取」那一行的数据。 */
export interface KbEntitySummary {
    /** 开着「参与语义检索」的文件数 —— 只有这些能被抽取，也是按钮上该写的分母。 */
    ragFiles: number;
    /** 里面还没抽过的有几个。 */
    pending: number;
    /** 已存的实体条数。 */
    entities: number;
    /** 这些实体是哪个模型抽的（多个时取最近一次）；空串 = 一条都没有。 */
    model: string;
}
/**
 * 本库实体抽取的**进度概览**（给「模型」弹层那一行用，不给图谱用）。
 *
 * 与 `readDocEntities` 分开是因为两者要的粒度不同：图谱要每一条实体，这里只要四个数；
 * 而且读路径一样**不建表** —— 这个库从没抽过时答案就是「0 / 全都没抽」，不是报错。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 库。
 * @returns 概览（读失败给全零，让界面照常渲染，再由别的通道报错）。
 */
export declare function kbEntitySummary(decryptedDir: string, kbId: number): KbEntitySummary;
/** 图谱要的那种实体节点形状（与 `types.ts` 的 `docEntities` 元素一致）。 */
export interface EntityNode {
    key: string;
    label: string;
    kind: string;
    files: Array<{
        id: number;
        weight: number;
    }>;
    occurrences: number;
    model: string;
    at: number;
}
/**
 * 把逐文件的实体合并成**图谱节点 + `suggest` 边**。
 *
 * 合并的是「同一个 label 在多个文件里被抽出」⇒ 一个节点、多条边，
 * 因为「三份文件都提到同一个人」正是跨文档结构里最有信息量的一件事。
 * 但**每个文件只留一条边**（权重取该文件里该实体的最高分）——
 * 同一文件重复出边只会把图变成毛线，而那份重复并不增加任何证据。
 * @param items - `readDocEntities` 的结果。
 * @returns 节点 + 边（边的 kind 恒为 `suggest`，画布据此画虚线）。
 */
export declare function mergeDocEntities(items: ReadonlyArray<DocEntity>): {
    nodes: EntityNode[];
    edges: Array<{
        source: string;
        target: string;
        weight: number;
        kind: 'suggest';
    }>;
};
