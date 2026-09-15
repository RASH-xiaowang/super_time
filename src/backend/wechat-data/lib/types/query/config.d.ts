/**
 * WeChat 配置的查询侧门面（M24 重构后只剩转发）。
 *
 * 为什么要有这个文件、而不是直接把 import 路径改掉：`gateway.ts`、`query/**` 与既有 spec
 * 都从 `./config.ts` / `../query/config.ts` 取配置能力，保留同一份入口可以让这次纯依赖方向
 * 重构不动任何调用点（也才谈得上「行为逐字不变」）。
 *
 * 实现分别落在更低的两层：
 *   · `../config/**` —— `config.json` / `secrets.json`（密钥真源）、账号发现、路径解析；
 *   · `../keys/db-key-verify.ts` —— SQLCipher 页面校验与 `all_keys.json` 生成（密钥能力）。
 * 依赖方向因此是 `config ← keys ← query`：keys 不再反向 import query（M24 的问题），
 * `query/image-key.ts` → `keys/key-store.ts` 则成为同向的单向依赖。
 */
export * from '../config/index.ts';
export { verifyDbKey, verifyDatabaseKey, generateKeysFile } from '../keys/db-key-verify.ts';
