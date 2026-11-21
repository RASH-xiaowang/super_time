/**
 * 送去 embedding 前的**文本截断**（2026-11-20）。
 *
 * ## 为什么不能直接用 `String.prototype.slice`
 *
 * JS 字符串是 UTF-16 码元序列，emoji 等增补平面字符占**两个**码元（代理对）。
 * `slice(0, 200)` 完全可能正好切在代理对中间，留下一个**孤立的高代理项**（如 `\ud83d`）。
 *
 * JSON 序列化后它就是 `"\ud83d"` —— 一个不是合法 Unicode 标量的字符。硅基流动对这类输入
 * 直接回 `HTTP 400 { code: 20015, message: 'The parameter is invalid' }`。
 *
 * ## 真机影响（2026-11-20 实测）
 *
 * 消息域 403,350 条里，`slice(0, 200)` 切断代理对的有 **25 行**；含 emoji 的有 10,676 行。
 * 这 25 行足以让**整个构建失败**：`runBuildVectorIndex` 是「任一批失败 ⇒ 阶段一整体抛错 ⇒
 * 一行都不写」。于是消息域向量索引在这份数据上**永远建不成** —— 真机上它停在
 * 2026-09-15 那份 dim=64 的旧数据上，而状态还要报就绪，检索因此长期是错的。
 *
 * ## 口径
 *
 * 1. 截断到 `max` 个 UTF-16 码元（与既有的 `maxCharsPerDoc` 语义一致，便于对比历史）；
 * 2. 若末位是**高代理项**，丢掉它（宁可少一个字，也不要送出非法字符）；
 * 3. 兜底再清掉任何残留的孤立代理项（数据库解码本身也可能产生）。
 *
 * @param text - 原始文本。
 * @param max - 最大码元数（≤ 0 视为不截断）。
 * @returns 安全可序列化的文本。
 */

/**
 * 判断某个码元是不是「孤立」的代理项（无法与相邻码元配对的 D800–DFFF）。
 * @param text - 待判文本。
 * @returns 含孤立代理项为 true。
 */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i += 1 // 正常代理对，跳过低位
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true // 没有高位前缀的低位代理
    }
  }
  return false
}

/**
 * 把文本安全地截断到 `max` 个 UTF-16 码元，保证结果里没有孤立代理项。
 * @param text - 原始文本。
 * @param max - 最大码元数（≤ 0 视为不截断，但仍会清孤立代理项）。
 * @returns 可安全 JSON 序列化的文本。
 */
export function truncateForEmbedding(text: string, max: number): string {
  let out = max > 0 && text.length > max ? text.slice(0, max) : text
  // ① 末位是被切断的高代理项 ⇒ 丢掉（这是真机那 25 行的形态）。
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  // ② 兜底：清掉任意位置的孤立代理项（库里解码出来的脏数据）。
  return hasLoneSurrogate(out) ? out.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '') : out
}
