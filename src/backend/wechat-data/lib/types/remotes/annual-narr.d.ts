import { StreamControl } from '../query/zip.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { PrivacyGateFn } from '../gateway-privacy.ts';
import type { OperationCategory, OperationStatus } from '../types.ts';
export interface createAnnualNarrRemotesInputs {
    normalizeJobId: (jobId?: unknown) => string;
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    streamControl: (jobId?: string) => StreamControl;
    finishStreamJob: (jobId: string, error?: string) => void;
    ctx: () => Context;
    privacyGate: PrivacyGateFn;
}
/** 一段的结果。 */
export interface AnnualSegmentResult {
    label: string;
    text: string;
    /** 这一段有没有成功（失败时 text 是失败原因，如实说）。 */
    ok: boolean;
}
/** AI 年报叙述结果。 */
export interface AnnualNarrativeResult {
    ok: boolean;
    year: number;
    segments: AnnualSegmentResult[];
    /** 拼接好的全文（段与段之间空行）。 */
    text: string;
    /** 段数是否被 MAX_SEGMENTS 截断（界面要说，别让用户以为覆盖了整年）。 */
    truncated: boolean;
    error?: string;
}
export declare function createAnnualNarrRemotes(rc: createAnnualNarrRemotesInputs): {
    /**
     * 生成 AI 年报叙述：分段取材、逐段 LLM、逐段进度、可取消。
     * @param options - 年份 + 可选的进度任务标识。
     * @returns 各段结果 + 拼接全文。
     */
    generateAnnualNarrative(options: {
        year: number;
        jobId?: string;
    }): Promise<AnnualNarrativeResult>;
};
