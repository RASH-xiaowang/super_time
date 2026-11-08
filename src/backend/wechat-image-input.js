'use strict';

/**
 * 多模态图片输入优化。
 *
 * Electron 的 nativeImage 只在主进程可用，因此这里通过依赖注入使用它，
 * 让 Node 单测无需加载 Electron。压缩失败时始终回退原图，识别成功优先于体积。
 */

const DEFAULT_MAX_EDGE = 1600;
const DEFAULT_JPEG_QUALITY = 82;
const DEFAULT_REENCODE_BYTES = 3 * 1024 * 1024;
const OPTIMIZABLE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/bmp',
]);

function originalImage(buffer, mediaType, width = 0, height = 0) {
  return {
    buffer,
    mediaType,
    optimized: false,
    width,
    height,
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/**
 * 创建图片优化器。长边超过上限或原始文件过大时，转成较小的高质量 JPEG。
 * @param {object} [options]
 * @param {object} [options.nativeImage] Electron nativeImage。
 * @param {number} [options.maxEdge] 长边上限。
 * @param {number} [options.jpegQuality] JPEG 质量。
 * @param {number} [options.reencodeBytes] 超过该字节数时重新编码。
 */
function createVisionImageOptimizer(options = {}) {
  const nativeImage = options.nativeImage;
  const maxEdge = positiveInteger(options.maxEdge, DEFAULT_MAX_EDGE);
  const jpegQuality = Math.min(100, positiveInteger(options.jpegQuality, DEFAULT_JPEG_QUALITY));
  const reencodeBytes = positiveInteger(options.reencodeBytes, DEFAULT_REENCODE_BYTES);

  return function optimize(buffer, mediaType) {
    if (
      !Buffer.isBuffer(buffer)
      || buffer.length === 0
      || !OPTIMIZABLE_MEDIA_TYPES.has(mediaType)
      || !nativeImage
      || typeof nativeImage.createFromBuffer !== 'function'
    ) {
      return originalImage(buffer, mediaType);
    }

    try {
      const source = nativeImage.createFromBuffer(buffer);
      if (!source || typeof source.getSize !== 'function' || source.isEmpty()) {
        return originalImage(buffer, mediaType);
      }
      const size = source.getSize();
      const width = Number(size?.width);
      const height = Number(size?.height);
      if (!(width > 0) || !(height > 0)) {
        return originalImage(buffer, mediaType);
      }

      const needsResize = Math.max(width, height) > maxEdge;
      if (!needsResize && buffer.length <= reencodeBytes) {
        return originalImage(buffer, mediaType, width, height);
      }

      const resized = needsResize
        ? source.resize(
          width >= height
            ? { width: maxEdge, quality: 'good' }
            : { height: maxEdge, quality: 'good' },
        )
        : source;
      const output = resized.toJPEG(jpegQuality);
      if (!Buffer.isBuffer(output) || output.length === 0 || output.length >= buffer.length) {
        return originalImage(buffer, mediaType, width, height);
      }

      const outputSize = typeof resized.getSize === 'function' ? resized.getSize() : {};
      return {
        buffer: output,
        mediaType: 'image/jpeg',
        optimized: true,
        width: positiveInteger(outputSize?.width, width),
        height: positiveInteger(outputSize?.height, height),
      };
    } catch {
      return originalImage(buffer, mediaType);
    }
  };
}

module.exports = {
  DEFAULT_MAX_EDGE,
  DEFAULT_JPEG_QUALITY,
  DEFAULT_REENCODE_BYTES,
  createVisionImageOptimizer,
};
