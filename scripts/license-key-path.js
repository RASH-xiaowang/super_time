#!/usr/bin/env node
/**
 * 签发私钥放在哪里（CODE-AUDIT-2026-09-26 P3-10）。
 *
 * ## 为什么不再从工作树里读
 *
 * `vendor-keys/` 里那份 pem 早就在 `.gitignore` 里、也没进 `build.files`，所以「会不会被提交/随包分发」
 * 这一层是关着的 —— 但**它就躺在每台开发机的仓库目录里**。剩下那些路都没关：
 * `git add -f` 一次、备份脚本把工作树整个拷走（网盘 / 移动盘 / CI 缓存归档）、
 * 或者谁把工作目录当附件发给别人 —— 签名能力就跟着出去了。
 * 拿着这把私钥可以给**任意设备指纹**签发许可证，代价与"泄漏一个 API Key"不是一个量级。
 *
 * ## 只有一条能读，且不给"退回工作树"这条路
 *
 * 解析顺序只有两级：显式路径（`--key` 或 `SUPERTIME_LICENSE_PRIVATE_KEY`）→ 用户目录
 * `~/.supertime/license-private.pem`。**两级都落在仓库里就直接拒**，不是"那就读仓库那份"：
 * 留一次退回，这道闸门从此只是建议。拒的时候把原因与出路写在消息里（要放别处请显式指路）。
 *
 * 本模块不写文件、不读文件内容 —— 位置归位置，读由调用方做，这样它能被单测直接问。
 */
const os = require('node:os')
const path = require('node:path')

/** 仓库根（本文件住在 `<root>/scripts/`）。 */
const REPO_ROOT = path.join(__dirname, '..')

/** 私钥文件名。 */
const KEY_FILE = 'license-private.pem'

/** 默认位置：用户目录下的 `.supertime`（不在任何仓库里）。 */
function defaultPrivateKeyPath(homeDir) {
  const home = homeDir || os.homedir()
  return path.join(home, '.supertime', KEY_FILE)
}

/** 环境变量名（显式指路用）。 */
const ENV_KEY = 'SUPERTIME_LICENSE_PRIVATE_KEY'

/**
 * `child` 是否等于 `root` 或在其之下（按路径段比，不比字符串前缀）。
 * 两边都先 `resolve`：相对路径要按同一个基准算，否则 `./vendor-keys/...` 这种写法会漏。
 * @param child - 待判定的路径。
 * @param root - 根目录。
 */
function isInside(child, root) {
  const c = path.resolve(String(child ?? ''))
  const r = path.resolve(String(root ?? ''))
  if (c === r) return true
  return c.startsWith(r + path.sep)
}

/**
 * 解析私钥位置。
 * @param options - 可注入的读取面（单测靠它，不碰真实 HOME）。
 * @param options.env - 环境变量对象（默认 `process.env`）。
 * @param options.homeDir - 用户目录（默认 `os.homedir()`）。
 * @param options.repoRoot - 仓库根（默认本模块所在仓库；测试里给一个临时目录）。
 * @returns 成功是 `{ ok: true, path, source }`；失败是 `{ ok: false, error, hint }`。
 */
function resolvePrivateKeyPath(options = {}) {
  const env = options.env ?? process.env
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const explicit = String(env[ENV_KEY] ?? '').trim()
  const chosen = explicit !== ''
    ? { path: path.resolve(explicit), source: ENV_KEY }
    : { path: defaultPrivateKeyPath(options.homeDir), source: '~/.supertime' }

  if (isInside(chosen.path, repoRoot)) {
    return {
      ok: false,
      error: `签发私钥不许放在仓库里（当前指向 ${chosen.path}）。`
        + '签名私钥一旦随工作树被备份 / 打包 / 附件转发出去，就能给任意设备签发许可证。',
      hint: `把文件挪到仓库之外（默认位置 ${defaultPrivateKeyPath(options.homeDir)}），`
        + `或用环境变量 ${ENV_KEY} / --key 显式指向仓库外的路径。`,
      source: chosen.source,
    }
  }
  return { ok: true, path: chosen.path, source: chosen.source }
}

/**
 * 位置解析失败时的退出消息（两个厂商工具共用一份，免得一处说一半）。
 * @param resolved - {@link resolvePrivateKeyPath} 的返回值。
 * @returns 可直接打印的多行字符串。
 */
function describeKeyFailure(resolved) {
  return `${resolved.error}\n${resolved.hint}`
}

module.exports = {
  REPO_ROOT,
  KEY_FILE,
  ENV_KEY,
  defaultPrivateKeyPath,
  resolvePrivateKeyPath,
  describeKeyFailure,
  isInside,
}
