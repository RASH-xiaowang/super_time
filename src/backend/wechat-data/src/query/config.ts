/**
 * WeChat configuration management, rewritten as a local module. Reads/writes
 * the owned config.json under the DSH data root, detects WeChat accounts, and
 * verifies database keys (SQLCipher 4: PBKDF2-HMAC-SHA512 + AES-256).
 */
import { execFileSync } from 'node:child_process'
import { createDecipheriv, createHmac, pbkdf2Sync } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'

const PAGE_SZ = 4096
const SALT_SZ = 16
const IV_SZ = 16
const HMAC_SZ = 64
const RESERVE_SZ = 80
const PBKDF2_ITERS = 256000
const SQLITE_HDR = new TextEncoder().encode('SQLite format 3\x00')

/** Read only the first database page (verification needs just the header page). */
function readFirstPage(file: string): Buffer {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(PAGE_SZ)
    const n = readSync(fd, buf, 0, PAGE_SZ, 0)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

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

/** 同步小睡（写路径是同步的，只能这样让出一点时间给占用者释放句柄）。 */
function sleepMsSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 环境不支持 Atomics.wait 就不等：退化成「不重试」 */
  }
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖。
 *
 * 直接 writeFileSync 到目标路径时，写一半被杀进程/磁盘满会留下**截断的 JSON**；
 * 而 config.json 里有数据根路径与密钥字段，读到截断内容会静默回落默认值
 * （用户看到的是「配置莫名丢了」），且下一次保存就把残缺内容覆盖掉。
 * 宿主层 `src/backend/wechat-paths.js` 有一份等价实现（那边是 CJS，无法共享）。
 * @param target - 目标文件绝对路径。
 * @param text - 要写入的文本。
 */
export function writeFileAtomic(target: string, text: string): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  // rename 覆盖目标时，Windows 上**任何**持有目标的句柄都会让它 EPERM —— 不只是 SQLite：
  // 实测连密集 `statSync` 的瞬态句柄、杀软扫描、备份工具都算（这条正是 M4 的结论）。
  // 一次瞬态占用不该让「保存配置」失败，所以做有界重试（最多 5 次 × 20ms）。
  let lastErr: unknown = null
  for (let i = 0; i < 5; i += 1) {
    try {
      renameSync(tmp, target)
      return
    } catch (e) {
      lastErr = e
      sleepMsSync(20)
    }
  }
  try { rmSync(tmp, { force: true }) } catch { /* 清理失败不掩盖原错误 */ }
  throw lastErr
}

/**
 * 覆盖前先保住「解析不了的原文件」（改名成 `.corrupt-<时间戳>`）并告警。
 * 否则损坏文件会被默认值+补丁无声覆盖，事后无从追查。
 * @param target - 目标文件绝对路径。
 */
/** 损坏备份的保留份数：超过就删最旧（备份含完整密钥，不能让磁盘随损坏次数线性增长）。 */
const MAX_CORRUPT_BACKUPS = 3
/** 备份文件名用的单调计数（同一毫秒内多次备份不能撞名）。 */
let corruptSeq = 0

/**
 * 只保留最近 `MAX_CORRUPT_BACKUPS` 份损坏备份。
 * @param target - 原文件绝对路径。
 */
function pruneCorruptBackups(target: string): void {
  try {
    const dir = dirname(target)
    const prefix = basename(target) + '.corrupt-'
    const all = readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of all.slice(MAX_CORRUPT_BACKUPS)) {
      try { rmSync(join(dir, f), { force: true }) } catch { /* 删不掉就留着 */ }
    }
  } catch { /* 列目录失败不影响主流程 */ }
}

export function preserveIfUnparseable(target: string): void {
  let text: string
  try {
    text = readFileSync(target, 'utf8')
  } catch {
    return // 不存在（首次运行）或读不到
  }
  try {
    JSON.parse(text)
    return
  } catch {
    // 后缀带 pid + 单调计数：只用 Date.now() 时同一毫秒内的多次备份会静默互相覆盖
    corruptSeq += 1
    const backup = `${target}.corrupt-${Date.now()}-${process.pid}-${corruptSeq}`
    try {
      renameSync(target, backup)
      console.warn(`[config] ${basename(target)} 内容不是合法 JSON，已备份为 ${basename(backup)} 后重写`)
      pruneCorruptBackups(target)
    } catch (e) {
      console.warn(`[config] ${basename(target)} 损坏且无法备份：${(e as Error).message}`)
    }
  }
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


/** Common WeChat 4.x data bases (parents of `xwechat_files`) to scan. */
const DEFAULT_DATA_BASES = [
  'E:\\Tencent',
  'D:\\Tencent',
  'C:\\Tencent',
  process.env.USERPROFILE ? join(process.env.USERPROFILE, 'Tencent') : '',
  process.env.USERPROFILE ? join(process.env.USERPROFILE, 'Documents') : '',
].filter(Boolean)

/**
 * WeChat 4.x data bases recorded per-user in
 * `%APPDATA%/Tencent/xwechat/config/*.ini` — each line is the data root chosen
 * at install/first login (e.g. `E:\Tencent\Weixin`, the parent of
 * `xwechat_files`). The client rewrites these files on every login, so this is
 * the authoritative source for a customized data location.
 */
function iniDataBases(): string[] {
  const configDir = process.env.APPDATA
    ? join(process.env.APPDATA, 'Tencent', 'xwechat', 'config')
    : ''
  if (!configDir || !existsSync(configDir)) return []
  const bases: string[] = []
  for (const name of readdirSync(configDir)) {
    if (!name.endsWith('.ini')) continue
    try {
      for (const line of readFileSync(join(configDir, name), 'utf8').split(/\r?\n/)) {
        const base = line.trim()
        if (base) bases.push(base)
      }
    } catch { /* unreadable ini is skipped */ }
  }
  return bases
}

/**
 * WeChat 4.x install path from `HKCU\Software\Tencent\Weixin\InstallPath`
 * (Windows only; '' elsewhere). The install dir is also a valid data base when
 * the user kept the default data layout.
 */
export function weixinInstallPath(): string {
  if (process.platform !== 'win32') return ''
  try {
    const out = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Tencent\\Weixin', '/v', 'InstallPath'],
      { encoding: 'utf8', windowsHide: true },
    )
    const match = /\sInstallPath\s+REG_\w+\s+(.+)/i.exec(out)
    return (match?.[1] ?? '').trim()
  } catch { /* registry absent or reg.exe unavailable */ }
  return ''
}

/** Version-folder pattern under the WeChat install dir (e.g. 4.1.12.26). */
const VERSION_DIR_RE = /^\d+\.\d+\.\d+(?:\.\d+)?$/

/**
 * WeChat version folder name inside the install dir.
 * @param installDir - install path (defaults to the registry InstallPath).
 * @returns the version, or '' when the install dir is unknown.
 */
export function weixinVersion(installDir?: string): string {
  const dir = installDir ?? weixinInstallPath()
  if (!dir || !existsSync(dir)) return ''
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && VERSION_DIR_RE.test(entry.name)) return entry.name
    }
  } catch { /* unreadable install dir */ }
  return ''
}

/**
 * Collect the `xwechat_files` roots to scan: default data bases, per-user
 * config ini files, and the registry install path, deduped
 * case-insensitively. A configured base may itself already be the
 * `xwechat_files` dir, so both join forms are added; the account loop filters
 * by `db_storage` presence.
 * @returns absolute candidate roots (existence caller-checked).
 */
export function collectScanRoots(): string[] {
  const seen = new Set<string>()
  const roots: string[] = []
  const add = (base: string): void => {
    if (!base) return
    for (const root of [join(base, 'xwechat_files'), base]) {
      const key = root.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      roots.push(root)
    }
  }
  for (const base of [...DEFAULT_DATA_BASES, ...iniDataBases(), weixinInstallPath()]) add(base)
  return roots
}

/**
 * Detect installed WeChat 4.x accounts by scanning `xwechat_files` roots.
 * @param roots - explicit scan roots; defaults to {@link collectScanRoots}.
 * @returns detected accounts with db_dir, last active and db file count.
 */
export function detectWechatAccounts(
  roots?: readonly string[],
): Array<{ wxid: string; db_dir: string; last_active?: number; db_files?: number }> {
  const out: Array<{ wxid: string; db_dir: string; last_active?: number; db_files?: number }> = []
  for (const root of roots ?? collectScanRoots()) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      const dbStorage = join(dir, 'db_storage')
      if (!existsSync(dbStorage)) continue
      // wxid is the dir name before the instance suffix (e.g. wxid_xxx_63e5)
      const wxid = normalizeWxidDir(entry.name) || '未知账号'
      let lastActive: number | undefined
      try {
        const msgDir = join(dbStorage, 'message')
        if (existsSync(msgDir)) {
          let newest = 0
          for (const f of readdirSync(msgDir)) {
            try { newest = Math.max(newest, statSync(join(msgDir, f)).mtimeMs) } catch { /* skip */ }
          }
          lastActive = newest ? Math.floor(newest / 1000) : undefined
        }
      } catch { /* skip */ }
      const acct: { wxid: string; db_dir: string; last_active?: number; db_files?: number } = { wxid, db_dir: dbStorage }
      if (lastActive) acct.last_active = lastActive
      const dbs = scanDbFiles(dbStorage)
      if (dbs.length > 0) acct.db_files = dbs.length
      out.push(acct)
    }
  }
  return out
}

/** AES-256-CBC decrypt (no padding). */
function aes256CbcDecrypt(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const d = createDecipheriv('aes-256-cbc', key, iv)
  d.setAutoPadding(false)
  return Buffer.concat([d.update(data), d.final()])
}

/** AES-256-ECB decrypt one block. */
function aes256EcbDecryptBlock(key: Buffer, block: Buffer): Buffer {
  const d = createDecipheriv('aes-256-ecb', key, null)
  d.setAutoPadding(false)
  return d.update(block)
}

/**
 * SQLCipher page-1 key verification (wx_key_v4.1 PBKDF2).
 * @param page1 - first page (4096 bytes) of the encrypted database.
 * @param wxKeyBin - 32-byte raw database key.
 * @returns whether the HMAC and AES checks pass.
 */
export function verifyDbKey(page1: Buffer, wxKeyBin: Buffer): { hmacOk: boolean; aesOk: boolean } {
  if (page1.length < PAGE_SZ) return { hmacOk: false, aesOk: false }
  page1 = page1.subarray(0, PAGE_SZ)
  const salt = page1.subarray(0, SALT_SZ)
  const derivedKey = pbkdf2Sync(wxKeyBin, salt, PBKDF2_ITERS, 32, 'sha512')
  // HMAC verify
  const macSalt = Buffer.from(salt.map(b => b ^ 0x3a))
  const macKey = pbkdf2Sync(derivedKey, macSalt, 2, 32, 'sha512')
  const hmacData = page1.subarray(16, PAGE_SZ - RESERVE_SZ + IV_SZ)
  const storedHmac = page1.subarray(PAGE_SZ - HMAC_SZ, PAGE_SZ)
  const mac = createHmac('sha512', macKey)
  mac.update(hmacData)
  const pgno = Buffer.alloc(4)
  pgno.writeUInt32LE(1, 0)
  mac.update(pgno)
  const hmacOk = mac.digest().equals(Buffer.from(storedHmac))
  // AES verify
  const firstBlockDec = aes256EcbDecryptBlock(derivedKey, page1.subarray(16, 32))
  const correctedIv = Buffer.from(firstBlockDec.map((b, i) => b ^ (SQLITE_HDR[i] ?? 0)))
  const encrypted = page1.subarray(16, PAGE_SZ - RESERVE_SZ)
  const decrypted = aes256CbcDecrypt(derivedKey, correctedIv, encrypted)
  const aesOk = decrypted.subarray(0, 16).equals(Buffer.from(SQLITE_HDR))
  return { hmacOk, aesOk }
}

/**
 * Verify one database file with a 64-hex key.
 * @param dbPath - path to the encrypted database file.
 * @param encKeyHex - 64-char hex (32-byte) database key.
 * @returns validity plus per-check flags and any error.
 */
export function verifyDatabaseKey(
  dbPath: string,
  encKeyHex: string,
): { valid: boolean; aesOk?: boolean; hmacOk?: boolean; error?: string } {
  if (!existsSync(dbPath)) return { valid: false, error: '数据库文件不存在' }
  const raw = (encKeyHex || '').trim()
  let key: Buffer
  try { key = Buffer.from(raw, 'hex') } catch { key = Buffer.alloc(0) }
  if (key.length !== 32) return { valid: false, error: '密钥必须是 64 位 hex（32 字节）' }
  try {
    const page1 = readFirstPage(dbPath)
    if (page1.length < PAGE_SZ) return { valid: false, error: '文件太小，不是有效的数据库' }
    const { hmacOk, aesOk } = verifyDbKey(page1, key)
    return { valid: hmacOk && aesOk, aesOk, hmacOk }
  } catch (e) {
    return { valid: false, error: (e as Error).message }
  }
}

/** Recursively collect .db files under a dir (depth-limited). */
export function scanDbFiles(dir: string, depth = 0): string[] {
  if (depth > 4 || !existsSync(dir)) return []
  const out: string[] = []
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) out.push(...scanDbFiles(p, depth + 1))
      else if (e.name.endsWith('.db') && !e.name.includes('-wal') && !e.name.includes('-shm')) out.push(p)
    }
  } catch { /* skip */ }
  return out
}

/**
 * Verify all DBs in db_dir and write all_keys.json (per-db per-file keys).
 * @param dbDir - directory containing the encrypted DBs to verify.
 * @param keysFile - output all_keys.json path.
 * @param encKeyHex - 64-char hex (32-byte) database key.
 * @param keyFormat - key format recorded in the file (default wx_key_v4.1).
 * @returns ok plus verified/total DB counts, or an error description.
 */
export function generateKeysFile(
  dbDir: string,
  keysFile: string,
  encKeyHex: string,
  keyFormat?: string,
): { ok: boolean; verified: number; total: number; error?: string } {
  const raw = (encKeyHex || '').trim()
  let key: Buffer
  try { key = Buffer.from(raw, 'hex') } catch { key = Buffer.alloc(0) }
  if (key.length !== 32) return { ok: false, verified: 0, total: 0, error: '密钥必须是 64 位 hex（32 字节）' }
  const dbs = scanDbFiles(dbDir)
  if (dbs.length === 0) return { ok: false, verified: 0, total: 0, error: '未找到任何 .db 文件' }
  const entries: Record<string, { key: string; valid: boolean }> = {}
  let verified = 0
  for (const db of dbs) {
    try {
      const rel = relative(dbDir, db).replace(/\\/g, '/')
      const page1 = readFirstPage(db)
      const { hmacOk, aesOk } = verifyDbKey(page1, key)
      const valid = hmacOk && aesOk
      if (valid) verified += 1
      entries[rel] = { key: raw, valid }
    } catch { /* skip unreadable */ }
  }
  const payload: Record<string, unknown> = { ...entries, _key_format: keyFormat ?? 'wx_key_v4.1', _db_dir: dbDir }
  try {
    mkdirSync(dirname(keysFile), { recursive: true })
    writeFileSync(keysFile, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, verified, total: dbs.length }
  } catch (e) {
    return { ok: false, verified, total: dbs.length, error: (e as Error).message }
  }
}

/**
 * Read all_keys.json info (format + count).
 * @param decryptedDir - decrypted data root.
 * @returns key format, key count and whether the file was loaded.
 */
export function getKeysInfo(decryptedDir: string): { keyFormat?: string; keyCount: number; loaded: boolean } {
  const p = join(decryptedDir, '..', 'all_keys.json')
  if (!existsSync(p)) return { keyCount: 0, loaded: false }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    const keys = Object.keys(raw).filter(k => !k.startsWith('_'))
    const base: { keyCount: number; loaded: boolean; keyFormat?: string } = { keyCount: keys.length, loaded: true }
    if (typeof raw['_key_format'] === 'string') base.keyFormat = raw['_key_format']
    return base
  } catch {
    return { keyCount: 0, loaded: false }
  }
}

/**
 * Normalize a WeChat account dir name to the real wxid (strip instance suffix).
 * Account dirs look like `wxid_xxxxxx` or `wxid_xxxxxx_f312`; the wxid itself
 * has no underscore, so everything after the second underscore is the instance
 * id (mirrors st_control config/paths.rs normalize_wxid_dir).
 * @param name - account directory name (e.g. wxid_a1z2r51mzqlf22_63e5).
 * @returns the real wxid (input unchanged when it is not a wxid_ name).
 */
export function normalizeWxidDir(name: string): string {
  if (!name.startsWith('wxid_')) return name
  const rest = name.slice('wxid_'.length)
  const pos = rest.indexOf('_')
  return pos >= 0 ? 'wxid_' + rest.slice(0, pos) : name
}

/** Self wxid from a db_dir path (the account dir is the parent of db_storage). */
function wxidFromDbDir(dbDir: string): string {
  const d = (dbDir || '').trim().replace(/[\\/]+$/, '')
  if (!d) return ''
  const parts = d.split(/[\\/]/)
  const last = parts[parts.length - 1] ?? ''
  const acct = last.startsWith('wxid_') ? last : (parts[parts.length - 2] ?? '')
  return normalizeWxidDir(acct)
}

/**
 * Resolve the logged-in account wxid (self). Mirrors st_control's cfg.wxid()
 * which derives it from the account directory name. Resolution order:
 * env DSH_WECHAT_SELF_WXID -> config.json db_dir -> all_keys.json _db_dir ->
 * machine account scan. Unknown when every source is missing.
 * @param decryptedDir - decrypted data root (configPath locates config.json).
 * @returns the self wxid, or '' when it cannot be determined.
 */
export function resolveSelfUsername(decryptedDir: string): string {
  const envVal = process.env['DSH_WECHAT_SELF_WXID']
  if (envVal && envVal.trim().length > 0) return envVal.trim()
  const cfg = getConfig(decryptedDir)
  const dbDir = typeof cfg['db_dir'] === 'string' ? cfg['db_dir'] : ''
  const fromDbDir = wxidFromDbDir(dbDir)
  if (fromDbDir) return fromDbDir
  try {
    const keysPath = join(decryptedDir, '..', 'all_keys.json')
    if (existsSync(keysPath)) {
      const raw = JSON.parse(readFileSync(keysPath, 'utf8')) as Record<string, unknown>
      const fromKeys = wxidFromDbDir(typeof raw['_db_dir'] === 'string' ? raw['_db_dir'] : '')
      if (fromKeys) return fromKeys
    }
  } catch { /* ignore */ }
  const accounts = detectWechatAccounts()
  for (const a of accounts) {
    if (a.wxid && a.wxid.startsWith('wxid_')) return normalizeWxidDir(a.wxid)
  }
  return ''
}

/**
 * Resolve the raw WeChat `db_storage` directory the realtime sync watches.
 * Resolution order: config.json `db_dir`, then all_keys.json `_db_dir` (the
 * st_control layout records it even when no config.json exists), then the
 * `DSH_WECHAT_BASE_DIR` account pin with `db_storage` appended. Empty when
 * every source is missing — callers must fail loud, not skip silently.
 * @param decryptedDir - decrypted data root (locates config.json/all_keys.json).
 * @param env - environment mapping (defaults to process.env).
 * @returns the raw db_storage path, or '' when it cannot be resolved.
 */
export function resolveRawDbDir(
  decryptedDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const cfg = getConfig(decryptedDir)
  const fromCfg = typeof cfg['db_dir'] === 'string' ? cfg['db_dir'].trim() : ''
  if (fromCfg) return fromCfg
  try {
    const keysPath = join(decryptedDir, '..', 'all_keys.json')
    if (existsSync(keysPath)) {
      const raw = JSON.parse(readFileSync(keysPath, 'utf8')) as Record<string, unknown>
      const fromKeys = typeof raw['_db_dir'] === 'string' ? raw['_db_dir'].trim() : ''
      if (fromKeys) return fromKeys
    }
  } catch { /* ignore */ }
  const pinned = env['DSH_WECHAT_BASE_DIR']
  if (pinned !== undefined && pinned.trim().length > 0) return join(pinned.trim(), 'db_storage')
  return ''
}
