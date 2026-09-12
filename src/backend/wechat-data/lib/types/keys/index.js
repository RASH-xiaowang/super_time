/**
 * WeChat key-recovery modules, migrated from WeChatDataAnalysis (key_v4,
 * dll_key_scan, image_key_memory_scan, image_key_resolver, isaac64,
 * key_store, key_service). Exports the orchestration used by the gateway's
 * auto-get-key Remote methods.
 */
export { extractXorKeysFromDll } from "./dll-key-scan.js";
export { recoverDbKeyV4, scanProcessKeyCandidates, isPotentialKey, findKeyAddresses } from "./db-key-v4.js";
export { Isaac64 } from "./isaac64.js";
export { scanImageKeyOnce, iterMemoryAesCandidates, findVerifiedAesKeyInChunk } from "./image-key-memory-scan.js";
export { cleanWxid, deriveImageKeys, verifyAesKey, detectImageFormat, inferXorKeyFromV2Tails, scanV2Templates, trustedXorForVerifiedAesKey, resolveLocalImageKey, } from "./image-key-resolver.js";
export { loadAccountKeysStore, getAccountKeysFromStore, upsertAccountKeysInStore, removeAccountKeysFromStore, keyStorePath, } from "./key-store.js";
export { findWechatPid, scanDllInternalKey, fetchDbKey, fetchImageKey, getKeysInfoSummary, } from "./service.js";
//# sourceMappingURL=index.js.map