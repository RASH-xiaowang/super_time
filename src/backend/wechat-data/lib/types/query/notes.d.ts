import type { KnowledgeSnapshot, NoteMutationResult, NotesSnapshot } from '../types.ts';
/**
 * Resolution key for note titles and `[[target]]` values.
 *
 * 归一化只做三件事：去首尾空白、内部连续空白折叠成一个空格、转小写。
 * 标题唯一性与链接解析必须共用这一个函数 —— 两处若各写一套，会出现
 * 「保存时任为同名、链接时却解析不到」这类只在特定空白/大小写下复现的怪问题。
 * @param s - raw title or link target.
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
 * List notes, most recently updated first.
 * @param decryptedDir - decrypted data root (locates the note store).
 * @param options - `query` filters title/body/tags; `limit` caps rows.
 * @returns the note list plus the unpaged total.
 */
export declare function listNotes(decryptedDir: string, options?: {
    query?: string;
    limit?: number;
}): NotesSnapshot;
/**
 * Create (no `id`) or update (`id` given) one note.
 * @returns the note id, or an error for a blank/duplicate title.
 */
export declare function saveNote(decryptedDir: string, input: {
    id?: number;
    title: string;
    body?: string;
    tags?: string[] | string;
    sourceKind?: 'manual' | 'ask';
    sourceUsername?: string;
    sourceQuestion?: string;
}): NoteMutationResult;
/** Delete one note (links pointing at it become stubs on the next build). */
export declare function deleteNote(decryptedDir: string, id: number): NoteMutationResult;
/**
 * Build the knowledge graph snapshot: note nodes, `[[…]]` edges and stubs.
 * @param decryptedDir - decrypted data root (locates the note store).
 * @param names - chat username → display name, for source-chat labels.
 * @returns notes + stubs + edges + summary; empty graph when the store is unreadable.
 */
export declare function buildKnowledgeGraph(decryptedDir: string, names: Map<string, string>): KnowledgeSnapshot;
