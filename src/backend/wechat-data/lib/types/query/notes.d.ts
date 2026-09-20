import type { KbDeleteAction, KbListSnapshot, KbMutationResult, KnowledgeSnapshot, NoteMutationResult, NotesSnapshot } from '../types.ts';
/**
 * 默认知识库的 id。**只在这里定义一处。**
 *
 * 它同时承担两个职责：① 历史数据（`ALTER TABLE … DEFAULT 1`）的落点；
 * ② 保证「任何时刻至少有一个库」的兜底 —— 迁移末尾若 `kbs` 为空就建它。
 * 因此它**不可删除**（可重命名）：删掉之后下一次开库会复活一个空库盖住现场。
 */
export declare const DEFAULT_KB_ID = 1;
/** 默认库的显示名。 */
export declare const DEFAULT_KB_NAME = "\u9ED8\u8BA4\u77E5\u8BC6\u5E93";
/** 库名长度上限。超限**拒绝**而不是截断 —— 截断会让用户看到的名字与他输入的不一致。 */
export declare const KB_NAME_MAX = 40;
/**
 * Resolution key for note titles, knowledge-base names and `[[target]]` values.
 *
 * 归一化只做三件事：去首尾空白、内部连续空白折叠成一个空格、转小写。
 * 标题唯一性与链接解析必须共用这一个函数 —— 两处若各写一套，会出现
 * 「保存时任为同名、链接时却解析不到」这类只在特定空白/大小写下复现的怪问题。
 * 库名的唯一性也走它，于是「项目 组」与「项目组」也算同名。
 * @param s - raw title / kb name / link target.
 * @returns the comparable key ('' for blank input).
 */
export declare function normalizeTitle(s: string): string;
/**
 * Extract wiki links in source order.
 * `[[target|display]]` keeps both parts; a bare `[[target]]` is its own display.
 * @param body - note body.
 * @returns `{ target, display }` pairs; duplicates preserved (edge weight = uses).
 */
export declare function parseWikiLinks(body: string): Array<{
    target: string;
    display: string;
}>;
/**
 * Read result: 既有调用方按 items/total 用不受影响，额外带一个**只在读失败时出现**的
 * `readError` —— 「笔记库读不到」与「确实一条笔记都没有」必须可区分（N1）。
 */
export interface NotesSnapshotRead extends NotesSnapshot {
    /** 读不到库时非空（此时 items 恒为 []）；确无笔记时为 undefined。 */
    readError?: string;
}
/** 知识库列表 + 只在读失败时出现的 `readError`（同 `NotesSnapshotRead`）。 */
export interface KbListSnapshotRead extends KbListSnapshot {
    /**
     * 读不到库时非空（此时 items 恒为 []）。
     *
     * ⚠ 调用方**不能**把空列表当成「一个库都没有」而去新建默认库 —— 那会用一个新的空库
     * 盖住真正的问题（库打不开）。`readError` 非空时应当保留上一次的列表并提示可重试。
     */
    readError?: string;
}
/**
 * List every knowledge base, oldest id first, with each one's note count.
 *
 * ⚠ `fileCount` 在这里恒为 `0`：文件登记在**另一个** db 文件（`wechat_kb_files.db`）里，
 * 而这一层只打开笔记库。真值由 `gateway.getKbs` 合并 —— 只有那一层同时看得见两个库。
 * 直接拿本函数的返回值渲染删库文案，就会对一个有 5 个文件的库说「这个库是空的」。
 * @param decryptedDir - decrypted data root (locates the note store).
 * @returns the kb list; an empty list plus `readError` only when the store is unreadable.
 */
export declare function listKbs(decryptedDir: string): KbListSnapshotRead;
/**
 * Create one knowledge base.
 * @param name - display name; blank / over-long / duplicate (normalized) are rejected.
 * @returns `{ ok, id }`, or `{ ok: false, error }`.
 */
export declare function createKb(decryptedDir: string, name: string): KbMutationResult;
/**
 * Rename one knowledge base.
 *
 * 改名**不动任何笔记**：笔记存的是 `kb_id`，不是库名。用库名当外键的话，
 * 「改名」就变成「迁移全部笔记」，还要处理迁移到一半崩掉。
 * @param id - kb id.
 * @param name - new display name.
 * @returns `{ ok, id }`, or `{ ok: false, error }`.
 */
export declare function renameKb(decryptedDir: string, id: number, name: string): KbMutationResult;
/**
 * Delete one knowledge base.
 *
 * `action` **必填**：库里有笔记时删掉它，是「移走」还是「一起删」必须由调用方明说。
 * 后端不提供缺省动作 —— 默认值在这里最危险，它会让一次「我以为只是删个空壳库」
 * 直接把 37 条笔记带走。
 * @param id - kb id; the default kb is refused.
 * @param action - `{kind:'reassign', targetKbId}` or `{kind:'purge'}`.
 * @returns `{ ok, id, movedNotes | removedNotes }`, or `{ ok: false, error }`.
 */
export declare function deleteKb(decryptedDir: string, id: number, action: KbDeleteAction): KbMutationResult;
/**
 * List notes of one knowledge base, most recently updated first.
 * @param decryptedDir - decrypted data root (locates the note store).
 * @param kbId - knowledge base to read; the list, the keyword filter and `total` are all scoped to it.
 * @param options - `query` filters title/body/tags; `limit` caps rows.
 * @returns the note list plus the **same-kb** unpaged total.
 */
export declare function listNotes(decryptedDir: string, kbId: number, options?: {
    query?: string;
    limit?: number;
}): NotesSnapshotRead;
/**
 * Create (no `id`) or update (`id` given) one note in one knowledge base.
 * @param decryptedDir - decrypted data root (locates the note store).
 * @param kbId - owning knowledge base (new) / expected owner (update).
 * @param input - note fields.
 * @returns the note id, or an error for a blank/duplicate title or a foreign note.
 */
export declare function saveNote(decryptedDir: string, kbId: number, input: {
    id?: number;
    title: string;
    body?: string;
    tags?: string[] | string;
    sourceKind?: 'manual' | 'ask';
    sourceUsername?: string;
    sourceQuestion?: string;
}): NoteMutationResult;
/**
 * Delete one note of one knowledge base (links pointing at it become stubs next build).
 * @param decryptedDir - decrypted data root.
 * @param kbId - expected owner; a row belonging to another kb is **not** deleted.
 * @param id - note id.
 */
export declare function deleteNote(decryptedDir: string, kbId: number, id: number): NoteMutationResult;
/** KnowledgeSnapshot + 只在读失败时出现的 `readError`（同 `NotesSnapshotRead`）。 */
export interface KnowledgeSnapshotRead extends KnowledgeSnapshot {
    /** 读不到库时非空（此时整张图都是空的）；确无笔记时为 undefined。 */
    readError?: string;
}
/**
 * Build the knowledge graph snapshot of **one** knowledge base: note nodes,
 * `[[…]]` edges and stubs.
 *
 * 一库一图：`idByKey` 只由本库的笔记构成，因此 `[[链接]]` 永远解析不到别的库去。
 * 跨库同名既不合并、也不报错 —— 它们在各自库里是两条无关的笔记。
 * @param decryptedDir - decrypted data root (locates the note store).
 * @param kbId - the knowledge base to build from.
 * @param names - chat username → display name, for source-chat labels.
 * @returns notes + stubs + edges + summary; an empty graph plus `readError` when unreadable.
 */
export declare function buildKnowledgeGraph(decryptedDir: string, kbId: number, names: Map<string, string>): KnowledgeSnapshotRead;
