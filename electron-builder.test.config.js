'use strict';

/**
 * 打包态冒烟专用配置：在 packaged package.json 里写入测试钩子标记。
 *
 * 这个标记只用于 `npm run pack` 生成的本地测试包；正式发行仍走 package.json
 * 的 build 配置，因此不会继承截图/安全探针入口。
 */
const pkg = require('./package.json');

module.exports = {
  ...pkg.build,
  extraMetadata: {
    ...(pkg.build.extraMetadata || {}),
    supertimeTestHooks: true,
  },
};
