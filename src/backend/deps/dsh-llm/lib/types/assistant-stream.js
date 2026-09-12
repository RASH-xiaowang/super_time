/** Lossless compact representation of one model-stream attempt. */
import { assertNever, deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
function safeTime(value) {
    if (!Number.isSafeInteger(value))
        throw new TypeError(`Assistant stream time must be a safe integer, got ${String(value)}`);
    return value;
}
function safeIndex(value, label) {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        throw new TypeError(`${label} index must be a non-negative safe integer`);
    }
    return value;
}
function snapshotChunk(chunk) {
    const snapshot = snapshotJsonValue(chunk);
    if (snapshot === undefined)
        throw new TypeError('Assistant stream chunk must be losslessly JSON-serializable');
    return snapshot;
}
function safeGap(previous, next) {
    const gap = next - previous;
    return Number.isSafeInteger(gap) && previous + gap === next ? gap : undefined;
}
/** Incrementally compacts one attempt without retaining a second raw-chunk list. */
export class AssistantStreamAccumulator {
    records = [];
    /**
     * Add one timed chunk to the compact attempt stream.
     * @param value - model chunk and its original Session timestamp.
     * @returns a detached immutable copy for assembly and live publication.
     */
    push(value) {
        const time = safeTime(value.time);
        const chunk = snapshotChunk(value.chunk);
        const timed = deepFreeze({ time, chunk });
        const previous = this.records.at(-1);
        switch (chunk.type) {
            case 'text-delta':
            case 'reasoning-delta': {
                safeIndex(chunk.index, chunk.type);
                if (typeof chunk.text !== 'string')
                    throw new TypeError(`${chunk.type} text must be a string`);
                const type = chunk.type === 'text-delta' ? 'text-chunks' : 'reasoning-chunks';
                const gap = previous !== undefined && previous.type === type ? safeGap(previous.lastTime, time) : undefined;
                if (previous !== undefined && previous.type === type && previous.index === chunk.index && gap !== undefined) {
                    previous.dt.push(gap);
                    previous.texts.push(chunk.text);
                    previous.lastTime = time;
                }
                else {
                    this.records.push({ type, time0: time, index: chunk.index, dt: [], texts: [chunk.text], lastTime: time });
                }
                return timed;
            }
            case 'tool-call-delta': {
                safeIndex(chunk.index, chunk.type);
                if (typeof chunk.id !== 'string')
                    throw new TypeError('tool-call-delta id must be a string');
                if (Object.hasOwn(chunk, 'name') && typeof chunk.name !== 'string') {
                    throw new TypeError('tool-call-delta name must be a string');
                }
                if (typeof chunk.argumentsDelta !== 'string') {
                    throw new TypeError('tool-call-delta argumentsDelta must be a string');
                }
                if (chunk.id.length === 0 || chunk.name === '') {
                    this.records.push({ type: 'chunk', time, chunk });
                    return timed;
                }
                const gap = previous?.type === 'tool-call-chunks' ? safeGap(previous.lastTime, time) : undefined;
                const sameName = previous?.type === 'tool-call-chunks'
                    && Object.hasOwn(previous, 'name') === Object.hasOwn(chunk, 'name')
                    && previous.name === chunk.name;
                if (previous?.type === 'tool-call-chunks'
                    && previous.index === chunk.index
                    && previous.id === chunk.id
                    && sameName
                    && gap !== undefined) {
                    previous.dt.push(gap);
                    previous.args.push(chunk.argumentsDelta);
                    previous.lastTime = time;
                }
                else {
                    this.records.push({
                        type: 'tool-call-chunks',
                        time0: time,
                        index: chunk.index,
                        dt: [],
                        id: chunk.id,
                        ...Object.hasOwn(chunk, 'name') ? { name: chunk.name } : {},
                        args: [chunk.argumentsDelta],
                        lastTime: time,
                    });
                }
                return timed;
            }
            case 'block-start':
            case 'block-end':
            case 'usage':
            case 'finish':
                this.records.push({ type: 'chunk', time, chunk });
                return timed;
            default:
                return assertNever(chunk, 'AssistantStreamAccumulator.push');
        }
    }
    /**
     * Return the current compact attempt stream.
     * @returns a detached immutable record list suitable for a durable event.
     */
    snapshot() {
        const records = this.records.map((record) => {
            if (record.type === 'chunk')
                return { ...record };
            const { lastTime: _lastTime, ...durable } = record;
            if (durable.type === 'tool-call-chunks') {
                return { ...durable, dt: [...durable.dt], args: [...durable.args] };
            }
            return { ...durable, dt: [...durable.dt], texts: [...durable.texts] };
        });
        return deepFreeze(records);
    }
}
/**
 * Expand compact records into the exact timed chunk sequence.
 * @param stream - compact records from one durable Assistant settlement.
 * @returns detached timed chunks with every original delta boundary preserved.
 * @throws {TypeError} when a record or reconstructed timestamp is invalid.
 */
export function expandAssistantStream(stream) {
    const chunks = [];
    for (const candidate of stream) {
        const record = validateRecord(candidate);
        if (record.type === 'chunk') {
            chunks.push({ time: record.time, chunk: record.chunk });
            continue;
        }
        const members = record.type === 'tool-call-chunks' ? record.args : record.texts;
        let time = record.time0;
        for (let index = 0; index < members.length; index += 1) {
            if (index > 0)
                time += record.dt[index - 1];
            let chunk;
            if (record.type === 'text-chunks') {
                chunk = { type: 'text-delta', index: record.index, text: members[index] };
            }
            else if (record.type === 'reasoning-chunks') {
                chunk = { type: 'reasoning-delta', index: record.index, text: members[index] };
            }
            else {
                chunk = {
                    type: 'tool-call-delta',
                    index: record.index,
                    id: record.id,
                    ...Object.hasOwn(record, 'name') ? { name: record.name } : {},
                    argumentsDelta: members[index],
                };
            }
            chunks.push({ time, chunk });
        }
    }
    return chunks;
}
function validateRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError('Assistant stream record must be an object');
    }
    const record = value;
    switch (record.type) {
        case 'text-chunks':
        case 'reasoning-chunks': {
            exactKeys(record, ['type', 'time0', 'index', 'dt', 'texts'], record.type);
            const texts = stringArray(record.texts, `${record.type} texts`);
            if (texts.length === 0)
                throw new TypeError(`${record.type} texts must be non-empty`);
            validateRun(record, texts.length, record.type);
            return record;
        }
        case 'tool-call-chunks': {
            const keys = Object.hasOwn(record, 'name')
                ? ['type', 'time0', 'index', 'dt', 'id', 'name', 'args']
                : ['type', 'time0', 'index', 'dt', 'id', 'args'];
            exactKeys(record, keys, record.type);
            const args = stringArray(record.args, 'tool-call-chunks args');
            if (args.length === 0)
                throw new TypeError('tool-call-chunks args must be non-empty');
            if (typeof record.id !== 'string' || record.id.length === 0) {
                throw new TypeError('tool-call-chunks id must be a non-empty string');
            }
            if (record.name !== undefined && (typeof record.name !== 'string' || record.name.length === 0)) {
                throw new TypeError('tool-call-chunks name must be a non-empty string');
            }
            validateRun(record, args.length, record.type);
            return record;
        }
        case 'chunk': {
            exactKeys(record, ['type', 'time', 'chunk'], 'chunk');
            const time = safeTime(record.time);
            if (typeof record.chunk !== 'object'
                || record.chunk === null
                || Array.isArray(record.chunk)) {
                throw new TypeError('Assistant stream raw chunk must be a lossless JSON object');
            }
            let chunk;
            try {
                chunk = snapshotChunk(record.chunk);
            }
            catch (error) {
                throw new TypeError('Assistant stream raw chunk must be a lossless JSON object', { cause: error });
            }
            return deepFreeze({ type: 'chunk', time, chunk });
        }
        default:
            throw new TypeError(`Unsupported Assistant stream record ${JSON.stringify(record.type)}`);
    }
}
function validateRun(record, members, label) {
    safeTime(record.time0);
    safeIndex(record.index, label);
    if (!Array.isArray(record.dt) || record.dt.some(value => !Number.isSafeInteger(value))) {
        throw new TypeError(`${label} dt must contain safe integers`);
    }
    if (record.dt.length !== members - 1) {
        throw new TypeError(`${label} dt length must be one less than its members`);
    }
    let time = record.time0;
    for (const gap of record.dt) {
        time += gap;
        if (!Number.isSafeInteger(time))
            throw new TypeError(`${label} member times must stay safe integers`);
    }
}
function stringArray(value, label) {
    if (!Array.isArray(value) || value.some(member => typeof member !== 'string')) {
        throw new TypeError(`${label} must be a string array`);
    }
    return value;
}
function exactKeys(record, keys, label) {
    if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key))) {
        throw new TypeError(`${label} Assistant stream record must contain exactly ${keys.join(', ')}`);
    }
}
//# sourceMappingURL=assistant-stream.js.map