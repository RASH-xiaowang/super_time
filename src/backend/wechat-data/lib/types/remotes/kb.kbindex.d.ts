import { KbVectorBuildWireResult } from '../types-kb-wire.ts';
import type { KbRemoteCtx } from './kb.ts';
export declare function kbBuildIndexIn(rc: KbRemoteCtx, options: {
    kbId: number;
    force?: boolean;
    jobId?: string;
}): Promise<KbVectorBuildWireResult>;
