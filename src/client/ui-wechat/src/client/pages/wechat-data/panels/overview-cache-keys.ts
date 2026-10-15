import { OVERVIEW_CACHE_PREFIX } from '../cache.ts'

/**
 * 总览面板的 localStorage 键。它们过去是裸字符串，失效契约因此看不到；
 * 这里集中收口，key 仍与旧值兼容，`invalidateAndNotify('')` 现在能一起清掉。
 */
export const CACHE_BASE = OVERVIEW_CACHE_PREFIX + 'base-v1'
export const CACHE_INSIGHTS = OVERVIEW_CACHE_PREFIX + 'insights-v1'
export const CACHE_LEDGER = OVERVIEW_CACHE_PREFIX + 'ledger-v1'
export const CACHE_STOR = OVERVIEW_CACHE_PREFIX + 'storage-v1'
export const CACHE_TIME = OVERVIEW_CACHE_PREFIX + 'last-updated-v1'
