/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-wechat-data`.
 * @module @deepseek-ai/dsh-wechat-data/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-wechat-data';
/** Cordis companion plugin name. */
export const name = 'wechat-data-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: the WeChat data gateway reads decrypted SQLite; its
 * contracts are asserted by the package's query specs.
 */
const install = () => { };
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
//# sourceMappingURL=invariant.js.map