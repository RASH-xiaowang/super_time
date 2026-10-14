/**
 * 变异登记 · wxgf 高清原图的 **ffmpeg 兜底**（2026-10-13，M521 起，移植自 WeChatDataAnalysis）。
 *
 * 微信解码库（VoipEngine.dll）不可用/失败时，参考项目用 ffmpeg 把 wxgf（Annex-B HEVC 分区）
 * 解成**全分辨率 JPEG**，而我们此前只退回 `_t` 缩略图 / hevc 占位。这一批钉三处
 * **最容易静默回退**的形状：
 *   · 兜底接线被拆 ⇒ DLL 失败时又回到缩略图降级（高清原图拿不到了，功能不报错、只是降级）；
 *   · 分区长度校验被拿掉 ⇒ 残缺码流交给解码器，坏图被当有效结果缓存；
 *   · NAL 上限保护被拿掉 ⇒ 恶意/损坏的码流让解析器从头数到尾（DoS 形状）。
 *
 * 每条都把「坏形状」注回去，要求指定 spec 的用例**当场变红**。
 *
 * @module mutations-registry/batch3q
 */
export const MUTATIONS_BATCH3Q = [
  {
    id: 'M521-wxgf-ffmpeg-fallback-unwired',
    why: 'DLL 不可用分支不再落到 ffmpeg 兜底 ⇒ 没装微信/加载失败时高清原图退回缩略图（参考项目能解出全分辨率 JPEG 的路径被静默拆掉）。判据：wxam-image.spec.ts 的「DLL 不可用时走 ffmpeg 兜底」。',
    file: 'src/backend/wechat-data/src/query/wxam-image.ts',
    from: 'return runFfmpegFallback(ffmpegFallback, payload, started, dllError)',
    to: 'return { error: dllError }',
    spec: 'src/backend/wechat-data/tests/wxam-image.spec.ts',
  },
  {
    id: 'M522-wxgf-partition-length-unchecked',
    why: '分区长度前缀不再校验 ⇒ 截断/错位的码流被交给解码器（产出坏图或被缓存成有效结果）。判据：wxgf-ffmpeg.spec.ts 的「长度前缀对不上则整体放弃」。',
    file: 'src/backend/wechat-data/src/query/wxgf-ffmpeg.ts',
    from: 'if (!(size > 0 && size <= limit - start)) return []',
    to: 'if (false) return []',
    spec: 'src/backend/wechat-data/tests/wxgf-ffmpeg.spec.ts',
  },
  {
    id: 'M523-wxgf-nal-cap-removed',
    why: 'NAL 上限保护被拿掉 ⇒ 损坏/恶意的码流让解析器从头数到尾（多帧判定的 DoS 形状被放进来）。判据：wxgf-ffmpeg.spec.ts 的「NAL 超上限必须按多帧拒掉」。',
    file: 'src/backend/wechat-data/src/query/wxgf-ffmpeg.ts',
    from: 'if (nalUnits > WXGF_MAX_NAL_UNITS) return Math.max(count, 2)',
    to: 'if (false) return Math.max(count, 2)',
    spec: 'src/backend/wechat-data/tests/wxgf-ffmpeg.spec.ts',
  },
]
