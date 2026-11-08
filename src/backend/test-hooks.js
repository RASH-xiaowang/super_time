'use strict';

/**
 * 是否允许生产包里启用截图/安全探针等自动化钩子。
 *
 * 开发态始终允许；打包态只有显式带有构建标记的测试包才允许。普通发行包即使
 * 被设置了同名环境变量也不会执行这些钩子。标记由 `electron-builder.test.config.js`
 * 通过 `extraMetadata` 写入测试包，正式发行配置不会携带。
 * @param {{ isPackaged?: boolean, packageMetadata?: object }} options
 * @returns {boolean}
 */
function isPackagedTestHooksEnabled(options = {}) {
  if (options.isPackaged !== true) return true;
  const metadata = options.packageMetadata;
  return Boolean(metadata && metadata.supertimeTestHooks === true);
}

module.exports = { isPackagedTestHooksEnabled };
