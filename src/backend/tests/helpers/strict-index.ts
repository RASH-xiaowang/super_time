/**
 * `noUncheckedIndexedAccess` 下的两个取值口（N32 后半）。
 *
 * 为什么要单独一个文件而不是各处写 `!` 或 `as`：测试里的下标取值分两类，
 * 而这两类的**正确失败方式**不一样 ——
 *   ① 下标越界是**用例前提没成立**（比如「断言只发了一次请求，然后读 seen[0]」）。
 *      用 `seen[0]!` 或 `as T` 把类型咽掉，越界时读到 `undefined`，
 *      于是 `seen[0].body.model` 抛一个 `Cannot read properties of undefined` ——
 *      看日志的人会以为是被测代码坏了，其实是这条用例自己的前提塌了。
 *      `at()` 让它直说「取 seen 的第 2 个，长度只有 1」。
 *   ② 正则捕获组：`matchAll` 的 `m[1]` 在类型上是 `string | undefined`，
 *      但只有当**正则本身**没有那个捕获组时才会真的是 undefined ——
 *      那是改正则以后的编码错误，同样不该咽掉（`.map(m => m[1])` 会产出一串 undefined，
 *      再配一句恒真的 `toEqual([])` 就什么都不查了）。
 *
 * 仓库里既有的口径是 `(m[1] ?? '')`（见 `query/image-original.ts`），那是对**生产代码**的
 * 稳妥写法（宁可少一个键也不要抛）；测试代码反过来，要的就是「不成立时 loudly 失败」，
 * 所以这里没有沿用 `?? ''`，而是给了会抛的访问器。
 *
 * @module tests/helpers/strict-index
 */

/**
 * 取第 `n` 个（0 基）；越界时直说「前提不成立」，不返回 `undefined`。
 * @param xs - 被索引的数组（`readonly` 也行）。
 * @param n - 下标。
 * @param what - 出错时怎么称呼这个数组，默认 `at()` 自己数出来的标识。
 * @returns 第 `n` 个元素。
 * @throws 越界时。
 */
export function at<T>(xs: readonly T[], n: number, what = '这个数组'): T {
  if (!(n >= 0 && n < xs.length)) {
    throw new Error(`${what}：只有 ${String(xs.length)} 个元素，取不到第 ${String(n + 1)} 个 —— 这条用例的前提不成立`)
  }
  return xs[n] as T
}

/**
 * 取正则匹配的第 `n` 个捕获组（`n >= 1`）。
 * @param m - `exec` / `matchAll` 得到的匹配。
 * @param n - 捕获组序号。
 * @param what - 出错时怎么称呼这个正则。
 * @returns 捕获组内容。
 * @throws 该组不存在时（正则被改坏、忘了括号）。
 */
export function grp(m: RegExpMatchArray, n: number, what = '正则'): string {
  const v = m[n]
  if (typeof v !== 'string') {
    throw new Error(`${what} 没有第 ${String(n)} 个捕获组（跑到的原文是 ${JSON.stringify(m[0])}）—— 是不是改正则以后来没同步这里`)
  }
  return v
}
