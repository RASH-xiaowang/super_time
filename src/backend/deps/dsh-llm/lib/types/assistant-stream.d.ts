/** Lossless compact representation of one model-stream attempt. */
import type { ToolCallId } from './brand.ts';
import type { StreamChunk } from './types.ts';
/** One model chunk paired with its original Session timestamp. */
export interface TimedStreamChunk {
    readonly time: number;
    readonly chunk: StreamChunk;
}
/** Lossless compact records embedded in durable Assistant attempt events. */
export type AssistantStreamRecord = {
    readonly type: 'text-chunks';
    readonly time0: number;
    readonly index: number;
    readonly dt: readonly number[];
    readonly texts: readonly string[];
} | {
    readonly type: 'reasoning-chunks';
    readonly time0: number;
    readonly index: number;
    readonly dt: readonly number[];
    readonly texts: readonly string[];
} | {
    readonly type: 'tool-call-chunks';
    readonly time0: number;
    readonly index: number;
    readonly dt: readonly number[];
    readonly id: ToolCallId;
    readonly name?: string;
    readonly args: readonly string[];
} | {
    readonly type: 'chunk';
    readonly time: number;
    readonly chunk: StreamChunk;
};
/** Incrementally compacts one attempt without retaining a second raw-chunk list. */
export declare class AssistantStreamAccumulator {
    private readonly records;
    /**
     * Add one timed chunk to the compact attempt stream.
     * @param value - model chunk and its original Session timestamp.
     * @returns a detached immutable copy for assembly and live publication.
     */
    push(value: TimedStreamChunk): TimedStreamChunk;
    /**
     * Return the current compact attempt stream.
     * @returns a detached immutable record list suitable for a durable event.
     */
    snapshot(): readonly AssistantStreamRecord[];
}
/**
 * Expand compact records into the exact timed chunk sequence.
 * @param stream - compact records from one durable Assistant settlement.
 * @returns detached timed chunks with every original delta boundary preserved.
 * @throws {TypeError} when a record or reconstructed timestamp is invalid.
 */
export declare function expandAssistantStream(stream: readonly AssistantStreamRecord[]): readonly TimedStreamChunk[];
//# sourceMappingURL=assistant-stream.d.ts.map