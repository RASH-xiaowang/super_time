import { KbVectorBuildResult } from '../query/kb-vectors.ts';
import type { KbRemoteCtx } from './kb.ts';
export declare function kbBuildIndexIn(rc: KbRemoteCtx, options: {
    kbId: number;
    force?: boolean;
    jobId?: string;
}): Promise<KbVectorBuildResult & {
    ok: boolean;
    error?: string;
}>;
