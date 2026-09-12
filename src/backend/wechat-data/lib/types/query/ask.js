/**
 * AI Q&A over WeChat data: builds a retrieval context (message search hits)
 * that the host gateway feeds to the DSH LLM service. The actual LLM call
 * lives in the gateway (needs ctx.llm); this module only prepares the
 * context + citations.
 */
import { searchIndexMessages } from "./search.js";
/**
 * Build the retrieval context for a question: search the message index,
 * format the top hits as numbered context lines, and return citations.
 * @param decryptedDir - decrypted data root.
 * @param question - the user question.
 * @param limit - max context hits (default 20).
 */
/** Extract CJK bigrams (2-char windows) plus the full run from a Chinese phrase. */
function searchTerms(question) {
    const runs = (question.match(/[\u4e00-\u9fffA-Za-z0-9]+/g) || []);
    const terms = [];
    for (const run of runs) {
        if (run.length > 1)
            terms.push(run);
        // CJK bigrams give FTS5 unicode61 a chance to match real words
        if (/[\u4e00-\u9fff]/.test(run)) {
            for (let i = 0; i + 2 <= run.length; i += 1) {
                const bigram = run.slice(i, i + 2);
                if (/[\u4e00-\u9fff]/.test(bigram))
                    terms.push(bigram);
            }
        }
    }
    return terms;
}
/** Start-of-day epoch ms for a YYYY-MM-DD string (NaN when invalid). */
function dayStartMs(s) {
    return new Date(s + 'T00:00:00').getTime();
}
/** End-of-day epoch ms for a YYYY-MM-DD string (NaN when invalid). */
function dayEndMs(s) {
    return new Date(s + 'T23:59:59').getTime();
}
/**
 * Build the retrieval context for a question: search the message index with
 * the raw question then CJK bigrams, union the top hits, and return citations.
 * @param decryptedDir - decrypted data root.
 * @param question - the user question.
 * @param limit - max context hits (default 20).
 * @param scope - optional talker and/or date-range filter.
 * @returns the formatted context lines plus source citations.
 */
export function buildAskContext(decryptedDir, question, limit, scope) {
    const cap = Math.min(limit ?? 20, 40);
    const seen = new Set();
    const rows = [];
    const push = (username, localId, name, time, snippet) => {
        const key = `${username}:${localId}`;
        if (seen.has(key))
            return;
        seen.add(key);
        rows.push({ name, time, snippet, username, local_id: localId });
    };
    const terms = [question.trim(), ...searchTerms(question)];
    for (const term of terms) {
        if (rows.length >= cap)
            break;
        if (!term)
            continue;
        const hits = searchIndexMessages(decryptedDir, term, cap - rows.length, scope?.username);
        for (const h of hits.hits) {
            if (scope?.from || scope?.to) {
                const tsMs = h.create_time * 1000;
                if (tsMs <= 0)
                    continue;
                if (scope.from && tsMs < dayStartMs(scope.from))
                    continue;
                if (scope.to && tsMs > dayEndMs(scope.to))
                    continue;
            }
            push(h.username, h.local_id, h.name, h.time, h.snippet);
            if (rows.length >= cap)
                break;
        }
    }
    const citations = rows;
    const lines = citations.map((c, i) => `[${i + 1}] ${c.name} (${c.time}): ${c.snippet}`);
    const context = lines.length > 0
        ? '以下是本地微信聊天记录检索结果（按相关度排序），可作为回答依据，引用时标注 [n]：\n' + lines.join('\n')
        : '（本地微信聊天记录中未检索到相关消息）';
    return { context, citations };
}
//# sourceMappingURL=ask.js.map