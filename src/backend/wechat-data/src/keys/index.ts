/**
 * WeChat key-recovery modules, migrated from WeChatDataAnalysis (key_v4,
 * dll_key_scan, image_key_memory_scan, image_key_resolver, isaac64,
 * key_store, key_service). Exports the orchestration used by the gateway's
 * auto-get-key Remote methods.
 */
export { extractXorKeysFromDll, type DllKeyCandidate } from './dll-key-scan.ts'
export { recoverDbKeyV4, scanProcessKeyCandidates, isPotentialKey, findKeyAddresses } from './db-key-v4.ts'
export { Isaac64 } from './isaac64.ts'
export { scanImageKeyOnce, iterMemoryAesCandidates, findVerifiedAesKeyInChunk, type ProcessMemoryKeyMatch } from './image-key-memory-scan.ts'
export {
  cleanWxid, deriveImageKeys, verifyAesKey, detectImageFormat, inferXorKeyFromV2Tails,
  scanV2Templates, trustedXorForVerifiedAesKey, resolveLocalImageKey,
  type DerivedImageKeys, type ImageKeyResolution, type TemplateScanResult, type V2Template,
} from './image-key-resolver.ts'
export {
  loadAccountKeysStore, getAccountKeysFromStore, upsertAccountKeysInStore,
  removeAccountKeysFromStore, keyStorePath,
} from './key-store.ts'
export {
  findWechatPid, scanDllInternalKey, fetchDbKey, fetchImageKey, getKeysInfoSummary,
} from './service.ts'
export type { DbKeyResult, ImageKeyResult, KeyStore, StoredAccountKeys } from './types.ts'
