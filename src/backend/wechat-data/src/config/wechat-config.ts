/**
 * 自有配置的真源：`<数据根>/config.json` + `<数据根>/secrets.json`。
 *
 * 为什么独立成层（M24）：原先这些实现压在 `query/config.ts` 里，而 `keys/service.ts` 与
 * `keys/db-key-v4.ts` 也需要它 —— 于是最底层的 keys 反向 import 了上层 query，与
 * `query/image-key.ts` → `keys/key-store.ts` 构成双向依赖。抽出来之后依赖方向是
 * `config ← keys ← query`（单向）。
 *
 * 本文件只做配置读写，不 import 包内其它模块（`atomic-json.ts` 是更底的一层）。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { preserveIfUnparseable, writeFileAtomic } from './atomic-json.ts'

/**
 * Locate the WeChat config.json for a data root. The plugin owns its config
 * under the DSH data root (`<root>/config.json`, i.e. the parent of
 * `decrypted`).
 * @param decryptedDir - decrypted data root (the parent is the owned root).
 * @returns the owned config file path.
 */
function configPath(decryptedDir: string): string {
  return join(decryptedDir, '..', 'config.json')
}

/** Raw config file cache keyed by mtime+size (read-heavy callers: sync, media). */
const configCache = new Map<string, { sig: string; raw: Record<string, unknown> | null }>()

function configSig(p: string): string {
  try {
    const st = statSync(p)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

/** 已经告警过的「损坏配置」签名（按 sig 去重，避免每次读配置都刷屏）。 */
const warnedCorrupt = new Set<string>()

function readRawConfig(p: string): Record<string, unknown> | null {
  const sig = configSig(p)
  const hit = configCache.get(p)
  if (hit && hit.sig === sig) return hit.raw
  let raw: Record<string, unknown> | null = null
  if (sig) {
    try {
      raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    } catch (e) {
      // 解析失败：**不改动文件**，只告警一次（同 sig 不重复刷）。损坏内容会在下一次
      // saveConfig 覆盖前由 preserveIfUnparseable 备份留痕。
      if (!warnedCorrupt.has(sig)) {
        warnedCorrupt.add(sig)
        console.warn(`[config] ${p} 读取/解析失败，本次使用默认值：${(e as Error).message}（原文件保留，下次保存前会先备份）`)
      }
    }
  }
  configCache.set(p, { sig, raw })
  return raw
}

/** Defaults for a missing config. */
function defaultConfig(): Record<string, unknown> {
  return { db_dir: '', keys_file: null, decrypted_dir: null, decoded_image_dir: null, wechat_process: 'Weixin.exe', image_aes_key: '', image_xor_key: 136, key_format: 'wx_key_v4.1', db_enc_key: '', api_enabled: true, api_port: 5032, api_token: '', cdn_enabled: true, cdn_local_decrypt: true }
}

/**
 * 密钥类字段：**不写进 config.json**。
 *
 * 为什么：`config.json` 是「用户可以手工编辑、出问题会被整目录拷贝/交给支持人员」的文件
 * （H1/N6 那条泄漏路径的载体）。密钥单独放 `secrets.json`，并收紧到当前用户可访问。
 */
const SECRET_FIELDS = ['db_enc_key', 'image_aes_key', 'image_xor_key', 'api_token'] as const

/** 密钥文件路径：与后端 config.json 同级（数据根，不是宿主的状态目录）。 */
function secretsPath(decryptedDir: string): string {
  return join(decryptedDir, '..', 'secrets.json')
}

/** 读取结果：区分「没有这个文件」与「文件存在但读不出来」——后者绝不能当成空密钥用。 */
interface SecretsRead {
  values: Record<string, unknown>
  /** true = 文件存在但解析失败（损坏）。调用方据此决定「有没有真值可写」。 */
  corrupt: boolean
}

/**
 * 某个密钥字段的值是否「有信息量」（够格覆盖/搬运）。
 *
 * 判定：
 *   · `undefined` / `null` → 否；
 *   · 字符串字段（`db_enc_key`/`image_aes_key`/`api_token`，内置默认 `''`）→ 必须非空；
 *   · 其它（`image_xor_key`，内置默认 `136`）→ 必须**不等于内置默认值**。
 *
 * 为什么需要它（两条实测出来的路径）：
 *  ① **界面未加载完就点保存**：`Settings.tsx` 的保存按钮在配置还没读回来时也能点，而它
 *     无条件把 4 个密钥字段都放进 patch（未加载时是 `''` 与 `136`）。把「显式空串」当成
 *     「用户要清空」就会把 `secrets.json` 里的真密钥整体抹成空值，且原文件是合法 JSON、
 *     连 `.corrupt-*` 备份都不会留 —— **静默且不可逆**。
 *  ② **默认值被当成真值固化**：`image_xor_key: 136` 一旦进 secrets，config.json 里对它
 *     的手工修改就被 `getConfig` 的「secrets 优先」永久压住。
 * 代价：不再支持「把某个密钥改回默认/清空」这个动作 —— 那本来也不是一个有意义的操作
 * （清空等于没有密钥，改回 136 等于用默认值），而它带来的静默丢失风险要大得多。
 * @param field - 密钥字段名。
 * @param value - 待判定的值。
 * @returns 是否值得写进 secrets.json / 用于覆盖读回值。
 */
function secretIsMeaningful(field: string, value: unknown): boolean {
  if (value === undefined || value === null) return false
  const dflt = defaultConfig()[field]
  if (typeof dflt === 'string') return typeof value === 'string' ? value.trim() !== '' : String(value).trim() !== ''
  return String(value) !== String(dflt)
}

/** 已经就「secrets.json 损坏」告警过的指纹（按 mtime+size 去重，避免每次读配置刷屏）。 */
const warnedSecretsCorrupt = new Set<string>()

/**
 * 读取密钥文件（缺失或损坏时返回空对象）。
 *
 * **不能**在读失败时静默返回空对象而不管写入侧：`saveConfig` 会把「合并后的密钥」写回去，
 * 而 `defaultConfig()` 让那 4 个字段恒 `!== undefined` —— 于是「一次外部损坏 + 一次任意保存」
 * 就会把真密钥覆盖成空串，且原文件是合法 JSON 时连 `.corrupt-*` 备份都没有（不可逆）。
 * 真正的守卫在 `saveConfig` 的边界 ④（只在手上有真值时才写）+ `writeSecrets` 的
 * `preserveIfUnparseable`；这里负责「损坏要留下可读痕迹」，按 mtime+size 去重只告警一次。
 * 返回类型里带 `corrupt` 是**契约的一部分**：调用方不得把「读不出来」当成「没有密钥」。
 */
function readSecrets(decryptedDir: string): SecretsRead {
  const p = secretsPath(decryptedDir)
  if (!existsSync(p)) return { values: {}, corrupt: false }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
    return { values: typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}, corrupt: false }
  } catch (e) {
    let sig = p
    try {
      const st = statSync(p)
      sig = `${p}:${st.size}:${st.mtimeMs}`
    } catch { /* 拿不到 stat 就用路径 */ }
    if (!warnedSecretsCorrupt.has(sig)) {
      warnedSecretsCorrupt.add(sig)
      console.warn(`[config] ${p} 不是合法 JSON，本次不采用其中的密钥：${(e as Error).message}`
        + '（原文件保留，下次保存前会先备份）')
    }
    return { values: {}, corrupt: true }
  }
}

/**
 * 写入密钥文件（原子 + 权限收紧）。
 *
 * 覆盖前先 `preserveIfUnparseable`：把损坏的原文改名成 `.corrupt-<ts>` 留痕 —— 与
 * `config.json` 同款保护。密钥从 config.json 搬到这儿，这条保护必须跟着搬，
 * 否则数据韧性是**净下沉**。
 * Windows 上靠数据根目录的 `(OI)(CI)` 继承（见 `src/backend/secure-fs.js`）；
 * POSIX 上新文件默认 0644，这里显式设 0600。
 */
function writeSecrets(decryptedDir: string, secrets: Record<string, unknown>): void {
  const p = secretsPath(decryptedDir)
  mkdirSync(dirname(p), { recursive: true })
  preserveIfUnparseable(p)
  writeFileAtomic(p, JSON.stringify(secrets, null, 2))
  if (process.platform !== 'win32') {
    try { chmodSync(p, 0o600) } catch { /* 权限收紧失败不影响写入本身 */ }
  }
}

/**
 * 从 config.json **原始内容**里取密钥字段（只取非空的、且不等于内置默认值的）。
 *
 * 用途：旧数据里密钥还在 config.json 中，而 `saveConfig` 会把它们从 config.json 删掉 ——
 * 删之前必须先把真值搬进 secrets.json，否则一次保存就把密钥弄丢了。
 *
 * **只搬「有意义」的值**：`image_xor_key` 的内置默认值是 `136`，而老版本会把默认值一并
 * 写进 config.json —— 把它当成真值搬到 secrets.json 之后，`getConfig` 的「secrets 优先」
 * 规则就会让 config.json 里对它的**手工修改永久失效**（复审实测：secrets 里钉住 136 后，
 * 手工把 config.json 改成 60 读回来还是 136）。默认值不带任何信息，不搬它就等于行为不变。
 * @param decryptedDir - 已解密数据根。
 * @returns 非空的、非默认的密钥字段。
 */
function readConfigSecretFields(decryptedDir: string): Record<string, unknown> {
  const raw = readRawConfig(configPath(decryptedDir))
  const out: Record<string, unknown> = {}
  if (!raw) return out
  for (const field of SECRET_FIELDS) {
    if (secretIsMeaningful(field, raw[field])) out[field] = raw[field]
  }
  return out
}

/**
 * Read the full WeChat config (merged with defaults).
 * @param decryptedDir - decrypted data root (used to locate config.json).
 * @returns the merged config (defaults + file values + resolved paths).
 */
export function getConfig(decryptedDir: string): Record<string, unknown> {
  const p = configPath(decryptedDir)
  const cfg = defaultConfig()
  const raw = readRawConfig(p)
  if (raw) Object.assign(cfg, raw)
  // 密钥来源：secrets.json 优先（迁移后它才是唯一真源）；config.json 里若还有
  // 旧值就沿用它 —— 下一次 saveConfig 会把它搬进 secrets.json 并从这里删掉。
  const { values: secrets } = readSecrets(decryptedDir)
  for (const field of SECRET_FIELDS) {
    const fromSecrets = secrets[field]
    // 同 secretIsMeaningful：secrets 里若是空串/默认值（老版本可能写进去过），
    // 不该压住 config.json 里的真值 —— 这也是「钉住 136」的自愈路径。
    if (secretIsMeaningful(field, fromSecrets)) cfg[field] = fromSecrets
    else if (raw && raw[field] !== undefined) cfg[field] = raw[field]
  }
  // resolved fixed output paths (relative to the data root, portable)
  const wechatRoot = join(decryptedDir, '..')
  const resolved = {
    decrypted_dir: decryptedDir,
    decoded_image_dir: join(wechatRoot, 'decoded_images'),
    keys_file: join(wechatRoot, 'all_keys.json'),
  }
  cfg['resolved'] = resolved
  // Also surface the fixed output paths at the top level so the persisted
  // config.json carries them (rather than the confusing null defaults).
  cfg['decrypted_dir'] = resolved.decrypted_dir
  cfg['decoded_image_dir'] = resolved.decoded_image_dir
  cfg['keys_file'] = resolved.keys_file
  return cfg
}

/**
 * Save the WeChat config (merge patch into config.json).
 * @param decryptedDir - decrypted data root (used to locate config.json).
 * @param patch - config fields to merge in.
 * @returns ok, or an error description on failure.
 */
export function saveConfig(decryptedDir: string, patch: Record<string, unknown>): { ok: boolean; error?: string } {
  const p = configPath(decryptedDir)
  try {
    const current = getConfig(decryptedDir)
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'resolved') continue
      if (v === undefined) continue
      current[k] = v
    }
    // decrypted/decoded/keys are resolved by the backend, never written back
    delete current['resolved']
    const imgBefore = getConfig(decryptedDir)
    // 密钥搬出 config.json：写进 secrets.json（原子 + 权限收紧），并从 config.json 删掉。
    //
    // 四条边界（都是复审实测踩出来的，缺一条都会静默毁数据）：
    //  ① **只搬「有意义」的值**（见 `secretIsMeaningful`）：既不能把 `getConfig()` 合出来的
    //     默认值（`''`、`image_xor_key: 136`）固化进 secrets.json，也不能把**界面未加载完**
    //     时提交的空串当成「用户要清空」—— 后者会把 secrets.json 里的真密钥整体抹掉，
    //     而原文件是合法 JSON、连 `.corrupt-*` 备份都不会留（静默且不可逆）。
    //  ② **旧数据要先搬再删**：config.json 里还有的真值必须在 delete 之前抄进 secrets.json。
    //  ③ **secrets.json 损坏时，只在「手上确实有真值」时才写**：真值有两个来源 —— 调用方
    //     显式给的有意义 patch，或 config.json 里还没迁移的值。两者都没有时回写只会把损坏
    //     文件冲成空壳，所以不写（原文留着，配合 `preserveIfUnparseable` 还有救回机会）。
    //     **注意别写成「损坏就一律不写」**：`carried` 正是从 config.json 读出来的、损坏时的
    //     救命稻草 —— 拒写会让 delete 把密钥从 config.json 抹掉却没落进 secrets.json。
    //  ④ **config.json 里不再保留任何密钥字段**（无条件 delete）。曾经试过「只删确实被
    //     secrets 接管的那些、把没意义的值留在原地便于手工编辑」，结果是个陷阱：
    //     `current` 来自 `getConfig()`，它会把默认值 `image_xor_key: 136` 填进来并**落盘** ——
    //     于是启动期「config.json 里还有旧密钥吗」的判据每次都误判为真，多跑一次空 patch 保存；
    //     而每次 `saveWechatConfig` 都会让宿主把整份镜像重写一遍（替换语义），白白抹掉
    //     镜像里的普通设置。现在密钥的唯一落点是 secrets.json，config.json 的密钥字段恒不存在 ——
    //     该判据也就只对**真的**旧数据为真。手工要调这几个字段就编辑 secrets.json，或走界面。
    const secretsOnDisk = readSecrets(decryptedDir)
    const nextSecrets: Record<string, unknown> = { ...secretsOnDisk.values }
    const carried = readConfigSecretFields(decryptedDir) // 旧数据（还没迁移的、有意义的）
    for (const [k, v] of Object.entries(carried)) {
      if (!secretIsMeaningful(k, nextSecrets[k])) nextSecrets[k] = v
    }
    let explicitSecretPatch = false
    for (const field of SECRET_FIELDS) {
      const fromPatch = Object.prototype.hasOwnProperty.call(patch, field) ? patch[field] : undefined
      if (secretIsMeaningful(field, fromPatch)) {
        nextSecrets[field] = fromPatch
        explicitSecretPatch = true
      }
      // config.json 里恒不留密钥字段（③）
      delete current[field]
    }
    const haveFreshValues = explicitSecretPatch || Object.keys(carried).length > 0
    if (haveFreshValues) writeSecrets(decryptedDir, nextSecrets)
    // 数据根目录可能尚未创建（首次保存配置），先确保父目录存在。
    mkdirSync(dirname(p), { recursive: true })
    // 覆盖前先备份「解析不了的原文件」，避免残缺内容被默认值无声覆盖。
    preserveIfUnparseable(p)
    writeFileAtomic(p, JSON.stringify(current, null, 2))
    configCache.delete(p)
    // Image key change => previously decoded .dat images are stale (garbled),
    // so drop the decoded_images cache for a clean re-decode on demand.
    const keyStr = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
    const aesChanged = keyStr(current['image_aes_key']) !== keyStr(imgBefore['image_aes_key'])
    const xorChanged = keyStr(current['image_xor_key']) !== keyStr(imgBefore['image_xor_key'])
    if (aesChanged || xorChanged) clearDecodedImages(join(decryptedDir, '..', 'decoded_images'))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Clear the decoded-images cache (stale when the image key changed). */
function clearDecodedImages(dir: string): void {
  try {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      try { rmSync(join(dir, name), { recursive: true, force: true }) } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}
