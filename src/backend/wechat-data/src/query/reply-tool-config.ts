/**
 * 「AI 回复工具」的配置读写（2026-11-24）。
 *
 * ## 为什么需要一个专门的读写口
 *
 * 天气与网页搜索这两个工具的就绪状态取决于四个配置项，而它们此前只在
 * `config.json` / `secrets.json` / 环境变量里可改 —— 界面上**没有任何入口**，
 * 于是「本地工具」页里那两张卡永远写着「待配置」，用户无从下手。
 *
 * 这里只做三件事：读快照（密钥只回「是否已保存」）、校验、写回。
 * 校验放在这里而不是网关：它与「读回来的快照」「工具的就绪判定」必须同一口径，
 * 否则会出现「保存成功但工具仍然说未配置」。
 *
 * ## 密钥为什么不回读
 *
 * 与任务中心的凭据同一口径：一旦能把密钥读回界面，它就会出现在截图、日志、
 * 剪贴板与「复制诊断信息」里。所以快照只回 `apiKeySaved`，保存时「缺省 = 保持不变」。
 *
 * @module query/reply-tool-config
 */
import { readReplyToolsConfig, saveConfig } from '../config/wechat-config.ts'
import type {
  LocalToolConfig,
  LocalToolConfigInput,
  LocalToolConfigSaveResult,
  LocalToolConfigOption,
} from '../types-local-tools.ts'

/** 天气数据源可选项。加新厂商时同步 `reply-tools/weather.ts` 的判据。 */
const WEATHER_PROVIDERS: readonly LocalToolConfigOption[] = [
  { value: '', label: '（未选择）' },
  { value: 'open-meteo', label: 'Open-Meteo', hint: '非商用免费；商用需要 API Key' },
]

/** 天气使用方式。 */
const WEATHER_ACCESS_MODES: readonly LocalToolConfigOption[] = [
  { value: '', label: '（未选择）' },
  { value: 'noncommercial', label: '非商用', hint: '免费额度，无需 Key' },
  { value: 'commercial', label: '商用', hint: '需要填写 Open-Meteo API Key' },
]

/** 网页搜索服务。 */
const SEARCH_PROVIDERS: readonly LocalToolConfigOption[] = [
  { value: '', label: '（未选择）' },
  { value: 'brave', label: 'Brave Search', hint: '需要 API Key（免费档够用）' },
]

/** API Key 的最大长度（Brave / Open-Meteo 都远小于这个数，超出基本是粘错了）。 */
const API_KEY_MAX = 200

/** 允许的取值（空串 = 未选择）。 */
function valuesOf(options: readonly LocalToolConfigOption[]): string[] {
  return options.map((option) => option.value)
}

/** 读当前配置快照（密钥只回是否已保存）。 */
export function readLocalToolConfig(decryptedDir: string): LocalToolConfig {
  const cfg = readReplyToolsConfig(decryptedDir)
  return {
    weather: {
      provider: cfg.weatherProvider,
      access: cfg.weatherAccess,
      apiKeySaved: cfg.weatherApiKey !== '',
    },
    search: {
      provider: cfg.searchProvider,
      apiKeySaved: cfg.searchApiKey !== '',
    },
    weatherProviders: [...WEATHER_PROVIDERS],
    weatherAccessModes: [...WEATHER_ACCESS_MODES],
    searchProviders: [...SEARCH_PROVIDERS],
  }
}

/** 保存结果（形状在共享契约里，与 Remote 的返回类型同一份）。 */
export type { LocalToolConfigSaveResult }

/**
 * 保存配置。
 *
 * 只处理**出现**的字段：`undefined` 表示「这次不改」。空串对 provider/access 是合法值
 * （= 取消选择），对 API Key 则不是 —— 密钥字段空串按「没改」处理（见模块头）。
 * @param decryptedDir - 解密数据根。
 * @param input - 要写入的字段（不可信）。
 * @returns 保存结果（成功时带新快照）。
 */
export function saveLocalToolConfig(
  decryptedDir: string,
  input: LocalToolConfigInput | undefined,
): LocalToolConfigSaveResult {
  if (input === undefined || input === null || typeof input !== 'object') {
    return { ok: false, error: '缺少配置' }
  }
  const patch: Record<string, unknown> = {}

  const provider = pickOne(input.weatherProvider, valuesOf(WEATHER_PROVIDERS), '天气数据源')
  if (provider.error !== undefined) return { ok: false, error: provider.error }
  if (provider.value !== undefined) {
    patch['reply_weather_provider'] = provider.value
    // 切到「未选择」时把使用方式一起清掉：留着 commercial 而 provider 为空，
    // 下次选回 open-meteo 会立刻要求 Key，用户会以为是新配的东西在报错。
    if (provider.value === '') patch['reply_weather_access'] = ''
  }

  const access = pickOne(input.weatherAccess, valuesOf(WEATHER_ACCESS_MODES), '天气使用方式')
  if (access.error !== undefined) return { ok: false, error: access.error }
  if (access.value !== undefined) patch['reply_weather_access'] = access.value

  const search = pickOne(input.searchProvider, valuesOf(SEARCH_PROVIDERS), '网页搜索服务')
  if (search.error !== undefined) return { ok: false, error: search.error }
  if (search.value !== undefined) patch['reply_search_provider'] = search.value

  const weatherKey = cleanKey(input.weatherApiKey, 'Open-Meteo API Key')
  if (weatherKey.error !== undefined) return { ok: false, error: weatherKey.error }
  if (weatherKey.value !== undefined) patch['reply_weather_api_key'] = weatherKey.value

  const searchKey = cleanKey(input.searchApiKey, 'Brave API Key')
  if (searchKey.error !== undefined) return { ok: false, error: searchKey.error }
  if (searchKey.value !== undefined) patch['reply_search_api_key'] = searchKey.value

  if (Object.keys(patch).length === 0) {
    // 什么都没改也回成功：用户点了「保存」但没动输入框，不该弹一个红条。
    return { ok: true, config: readLocalToolConfig(decryptedDir) }
  }
  try {
    const saved = saveConfig(decryptedDir, patch)
    if (!saved.ok) return { ok: false, error: saved.error ?? '保存失败' }
    return { ok: true, config: readLocalToolConfig(decryptedDir) }
  } catch (e) {
    return { ok: false, error: '保存配置失败：' + ((e as Error)?.message ?? String(e)) }
  }
}

/** 枚举字段：`undefined` = 不改；不在白名单里 = 拒绝。 */
function pickOne(
  raw: unknown,
  allowed: readonly string[],
  label: string,
): { value?: string; error?: string } {
  if (raw === undefined) return {}
  if (typeof raw !== 'string') return { error: `${label}取值类型不对` }
  const value = raw.trim()
  if (!allowed.includes(value)) return { error: `不支持的${label}：${value || '（空）'}` }
  return { value }
}

/** 密钥字段：空白/缺省 = 不改；含空白字符或过长 = 拒绝（几乎都是粘错了）。 */
function cleanKey(raw: unknown, label: string): { value?: string; error?: string } {
  if (raw === undefined) return {}
  if (typeof raw !== 'string') return { error: `${label}取值类型不对` }
  const value = raw.trim()
  if (value === '') return {}
  if (value.length > API_KEY_MAX) return { error: `${label} 过长（超过 ${String(API_KEY_MAX)} 个字符）` }
  if (/\s/.test(value)) return { error: `${label} 里不能有空格或换行（可能是粘贴时带进了空白）` }
  return { value }
}
