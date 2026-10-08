/**
 * 真机验收脚本共用的一件事：**用真实 profile + 真实数据根起一个临时窗口**。
 *
 * ## 为什么要有它（2026-09-29 用户报障）
 *
 * 报障原话：「验收测试模式下也要使用真实数据，这样才能拿到最准确的测试数据，才能更好解决 bug 和性能问题」。
 * 当时的问题有两条，都在这一个文件里解决：
 *
 * ① **数据根是写死的**：`theme-live-audit.mjs` / `panel-audit.mjs` / `overview-layout-audit.mjs`
 *    各自硬编码 `%APPDATA%/super-time-electron/wechat-data`。但应用解到哪个根要问它自己
 *    （`wechat/config.json → resolved.dataRoot`）—— 本机设了 `DSH_HOME` 时实际是 `~/.dsh/wechat-data`。
 *    于是"验收量的是 A 盘子，用户看的是 B 盘子"，量出来的数不代表用户遇到的问题。
 *
 * ② **临时 profile 里只有一份手写的 config.json**：没有 `llm.json` ⇒ AI 面板在验收里根本
 *    拿不到模型配置（要么降级、要么直接不可用），而用户那边是配好的真模型。要"拿到最准确的
 *    测试数据"，就得把真实 profile 的配置**带过去**（只读复制，临时目录用完即删）。
 *
 * 用法：
 * ```js
 * import { seedRealProfile } from './real-profile.mjs'
 * const { dataRoot, copied } = seedRealProfile(userData)
 * ```
 * 前置：先 `mkdirSync(join(userData,'wechat'),{recursive:true})`（本函数也会兜底建）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 候选的 userData 目录名：开发态用包名，装好后用 productName。 */
const USERDATA_CANDIDATES = ['super-time-electron', 'Super Time']

/**
 * 找到**应用自己的** userData 目录（有 `wechat/config.json` 的那个优先）。
 * @returns userData 绝对路径（都没有时返回第一候选，调用方按"空 profile"处理）。
 */
export function appUserDataDir () {
  const appData = process.env.APPDATA ?? ''
  let first = ''
  for (const name of USERDATA_CANDIDATES) {
    const dir = join(appData, name)
    if (first === '') first = dir
    if (existsSync(join(dir, 'wechat', 'config.json'))) return dir
  }
  return first
}

/**
 * 应用**真正在用**的数据根：读它自己写下的 `resolved.dataRoot`。
 * @returns 数据根绝对路径。
 */
export function realDataRoot () {
  const candidates = [
    join(appUserDataDir(), 'wechat', 'config.json'),
    join(process.env.APPDATA ?? '', 'super-time-electron', 'wechat', 'config.json'),
  ]
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf8'))
      const root = cfg?.resolved?.dataRoot
      if (typeof root === 'string' && root.length > 0) return root
    } catch { /* 换下一个候选 */ }
  }
  // 都没写过：退回历史默认（并在调用方打印出来，便于一眼看出量错了）
  return join(process.env.APPDATA ?? '', 'super-time-electron', 'wechat-data')
}

/** 把真实 profile 里那几份**配置**（不含任何数据）复制进临时 profile。 */
const COPY_INTO_PROFILE = ['config.json', 'llm.json', 'secrets.json', 'keys.json', 'all_keys.json']

/**
 * 用真实 profile 的配置填充一个临时 profile，并把路径指到真实数据根。
 *
 * 复制的都是**配置**：`config.json`（含 dataRoot/解密路径）、`llm.json`（模型与 API Key）、
 * `secrets.json` / `keys.json` / `all_keys.json`（密钥映射）。
 * 这样验收窗口与用户实际运行的那一份**同数据、同模型、同密钥**，量的数才有可比性。
 * 临时目录由调用方在 `finally` 里删掉（本函数只读真实文件，不写它们）。
 * @param userData - 临时 profile 目录。
 * @returns `{ dataRoot, copied, source }`：实际用的数据根、复制了哪些文件、来源 profile。
 */
export function seedRealProfile (userData) {
  const src = appUserDataDir()
  const dataRoot = realDataRoot()
  const dstDir = join(userData, 'wechat')
  mkdirSync(dstDir, { recursive: true })
  const copied = []
  for (const name of COPY_INTO_PROFILE) {
    const from = join(src, 'wechat', name)
    if (!existsSync(from)) continue
    copyFileSync(from, join(dstDir, name))
    copied.push(name)
  }
  // `config.json` 必须在：没有就写一份最小的（只指向真实数据根），保证窗口能起来。
  const cfgPath = join(dstDir, 'config.json')
  let cfg = {}
  try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) } catch { /* 不存在或坏了就重建 */ }
  const resolved = (cfg['resolved'] ?? {})
  cfg['resolved'] = {
    ...resolved,
    dataRoot,
    decrypted: join(dataRoot, 'decrypted'),
    decoded: join(dataRoot, 'decoded_images'),
    configFile: join(dataRoot, 'config.json'),
  }
  cfg['dataRoot'] = dataRoot
  cfg['decryptedDir'] = join(dataRoot, 'decrypted')
  cfg['decodedImagesDir'] = join(dataRoot, 'decoded_images')
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
  return { dataRoot, copied, source: src }
}
