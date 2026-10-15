/**
 * 变异登记 · **keys.json 多账号分槽（W2-2.2 的 db_key 侧）**（2026-10-14，M581 起）。
 *
 * 这批钉的是「自动取到的数据库密钥按账号分槽」这条修复里的三种退化：
 *
 *   M581 把 `dbKeySlotFor` 改成永远回全局槽 ⇒ 一台机器两个账号时，后者又覆盖前者的库密钥；
 *   M582 把 db_key 的归属校验改成永远放行 ⇒ 全局槽里明确属于别的账号的可用密钥被拿来硬用；
 *   M583 复活已确认零引用的 `getKeysInfoSummary` ⇒ P3-8 的零引用导出清单重新长出死代码。
 *
 * @module mutations-registry/batch3zb
 */
export const MUTATIONS_BATCH3ZB = [
  {
    id: 'M581-db-key-slot-falls-back-to-global',
    why: '把 dbKeySlotFor 的账号路由改回全局槽 ⇒ 两台账号的自动取钥又互相覆盖，而行为测试里「写进自己槽」直接红',
    file: 'src/backend/wechat-data/src/keys/service.ts',
    from: 'export function dbKeySlotFor(decrypted: string): string {\n  return accountKeySlotFor(resolveSelfUsername(decrypted))\n}',
    to: 'export function dbKeySlotFor(decrypted: string): string {\n  return DEFAULT_KEY_SLOT\n}',
    spec: 'src/backend/wechat-data/tests/db-key-saved-fastpath.spec.ts',
  },
  {
    id: 'M582-db-key-ownership-always-allowed',
    why: '把 db_key 的归属判定改成永远放行 ⇒ 全局槽里「明确属于别的账号」的库密钥也会被拿来硬用（source 从 saved_all_keys 变成 saved_store）',
    file: 'src/backend/wechat-data/src/keys/service.ts',
    from: '  return owner === self',
    to: '  return true',
    spec: 'src/backend/wechat-data/tests/db-key-saved-fastpath.spec.ts',
  },
  {
    id: 'M583-dead-keys-summary-resurrected',
    why: '把已确认零引用并删掉的 getKeysInfoSummary 再导出一份 ⇒ P3-8「删掉的死导出不许复活」判据必须红',
    file: 'src/backend/wechat-data/src/keys/service.ts',
    from: 'export function dbKeySlotFor(decrypted: string): string {',
    to: 'export function getKeysInfoSummary(): { hasDbKey: boolean; hasImageKey: boolean } { return { hasDbKey: false, hasImageKey: false } }export function dbKeySlotFor(decrypted: string): string {',
    spec: 'src/backend/wechat-data/tests/p3-8-export-discipline.spec.ts',
  },
]
