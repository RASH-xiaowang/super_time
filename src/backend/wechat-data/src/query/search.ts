/**
 * WeChat full-text message search index (FTS5), rewritten from st_control
 * chat_search_index.rs. The index DB lives next to the decrypted dir
 * (data/wechat/wechat_search.db); search prefers the index and falls back
 * to a bounded full-table scan over the message shards.
 */

/** zstd magic bytes (WCDB compressed blobs). */

export * from './search-scaffold.ts'
export * from './search-build.ts'
export * from './search-query.ts'
