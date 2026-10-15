/**
 * Knowledge-base Remote 边界类型。
 *
 * 这些类型原先在 `remotes/kb.ts` 里以匿名对象逐处重写，前端又镜像了一份。
 * 收进共享契约后，两端都只引用这里，避免 `getKbVectorIndex` / `extractKbEntities`
 * 等接口因各自演化而静默漂移。
 */
import type { KbModelRole, KbModelSettings, ResolvedModel } from './query/kb/model-config.ts';
import type { KbEntitySummary } from './query/kb/extract.ts';
import type { KbVectorBuildResult, KbVectorIndexStatus } from './query/kb-vectors.ts';
/** `getKbVectorIndex` 的返回值。 */
export interface KbVectorIndexView {
    kbId: number;
    model: string;
    source: 'inherit' | 'inline';
    configured: boolean;
    status: KbVectorIndexStatus;
    job: {
        done: number;
        total: number;
        startedAt: number;
        error: string;
    } | null;
}
/** `getKbModelConfig` 的返回值。 */
export interface KbModelConfigView {
    kbId: number;
    settings: KbModelSettings;
    global: Record<KbModelRole, string>;
    resolved: Record<KbModelRole, ResolvedModel>;
    entities: KbEntitySummary;
}
/** `setKbModelConfig` 的返回值。 */
export type KbModelConfigResult = {
    ok: true;
    settings: KbModelSettings;
} | {
    ok: false;
    error: string;
};
/** `extractKbEntities` 的返回值。 */
export interface KbExtractResult {
    ok: boolean;
    error?: string;
    files: number;
    saved: number;
    failed: Array<{
        id: number;
        error: string;
    }>;
    model: string;
}
/** `suggestKbLinks` 的一条候选。 */
export interface KbLinkSuggestion {
    label: string;
    kind: 'note' | 'entity';
    score: number;
}
/** `suggestKbLinks` 的返回值。 */
export interface KbLinkSuggestResult {
    ok: boolean;
    error?: string;
    candidates: KbLinkSuggestion[];
    pool: number;
    model: string;
    note?: string;
}
/** `buildKbVectorIndex` 的传输结果（底层构建结果外加 `ok`/`error`）。 */
export type KbVectorBuildWireResult = KbVectorBuildResult & {
    ok: boolean;
    error?: string;
};
