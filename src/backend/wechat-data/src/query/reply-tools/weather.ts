import type { ReplyToolContext, ReplyToolResult } from './types.ts'
import { replyToolError } from './types.ts'
import { readReplyPublicHttps, throwIfReplyAborted } from './public-http.ts'
import { replyDate } from './local.ts'
interface Geo { name: string; latitude: number; longitude: number; timezone: string; country_code: string; admin1?: string; population?: number }
export async function replyWeather(args: Record<string, unknown>, ctx: ReplyToolContext): Promise<ReplyToolResult> {
  const cfg = ctx.config
  if (cfg.weatherProvider !== 'open-meteo') return replyToolError('weather_provider_not_configured')
  // No silent assumption that a commercial desktop product can use the public free tier.
  if (!['noncommercial', 'commercial'].includes(cfg.weatherAccess)) return replyToolError('weather_license_mode_required')
  if (cfg.weatherAccess === 'commercial' && !cfg.weatherApiKey) return replyToolError('weather_key_missing')
  const city = String(args['city'] ?? '').trim()
  const normalized = (s: string): string => s.toLowerCase().replace(/[市县区\s]/g, '')
  if (!/^[\p{L} .'-]{2,40}$/u.test(city) || !normalized(ctx.publicText).includes(normalized(city))) return replyToolError('city_not_in_target')
  const region = typeof args['region'] === 'string' ? args['region'].trim() : ''
  if (region && (!/^[\p{L} .'-]{2,40}$/u.test(region) || !normalized(ctx.publicText).includes(normalized(region)))) return replyToolError('region_not_in_target')
  const read = ctx.read ?? readReplyPublicHttps
  const commercial = cfg.weatherAccess === 'commercial'
  const geo = new URL(`https://${commercial ? 'customer-geocoding-api' : 'geocoding-api'}.open-meteo.com/v1/search`)
  geo.searchParams.set('name', region ? city + ',' + region : city); geo.searchParams.set('count', '5'); geo.searchParams.set('language', 'zh'); geo.searchParams.set('format', 'json')
  if (args['countryCode']) geo.searchParams.set('countryCode', String(args['countryCode']))
  if (commercial) geo.searchParams.set('apikey', cfg.weatherApiKey)
  const raw = JSON.parse((await read(geo.toString(), { signal: ctx.signal })).text) as { results?: Geo[] }
  throwIfReplyAborted(ctx.signal)
  const all = (raw.results ?? []).filter(g => typeof g.name === 'string' && Number.isFinite(g.latitude) && Math.abs(g.latitude) <= 90 && Number.isFinite(g.longitude) && Math.abs(g.longitude) <= 180 && typeof g.timezone === 'string')
  if (!all.length) return replyToolError('weather_city_not_found')
  const exact = all.filter(g => normalized(g.name) === normalized(city))
  const matches = exact.length ? exact : all
  if (matches.length > 1) return { ok: false, code: 'weather_city_ambiguous', data: { choices: matches.map(g => ({ name: g.name, region: g.admin1, countryCode: g.country_code })).slice(0, 5) } }
  const place = matches[0]!
  const timezone = place.country_code === 'CN' ? 'Asia/Shanghai' : place.timezone
  const now = (ctx.now ?? (() => new Date()))()
  const today = replyDate(now, timezone)
  const day = String(args['date'] ?? 'today')
  const date = day === 'tomorrow' ? replyDate(now, timezone, 1) : day === 'today' ? today : day
  if (/(明天|tomorrow)/i.test(ctx.publicText) && date !== replyDate(now, timezone, 1)) return replyToolError('weather_date_target_mismatch')
  const delta = (Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(delta) || delta < 0 || delta > 6) return replyToolError('weather_date_out_of_range')
  const forecast = new URL(`https://${commercial ? 'customer-api' : 'api'}.open-meteo.com/v1/forecast`)
  for (const [k, v] of Object.entries({ latitude: String(place.latitude), longitude: String(place.longitude), timezone,
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,weather_code',
    current: 'temperature_2m,precipitation,weather_code', forecast_days: '7', temperature_unit: 'celsius', precipitation_unit: 'mm' })) forecast.searchParams.set(k, v)
  if (commercial) forecast.searchParams.set('apikey', cfg.weatherApiKey)
  const data = JSON.parse((await read(forecast.toString(), { signal: ctx.signal })).text) as {
    timezone?: string; utc_offset_seconds?: number
    daily?: Record<string, Array<number | string | null>>
    current?: Record<string, number | string | null>
  }
  throwIfReplyAborted(ctx.signal)
  if (data.timezone !== timezone || data.daily?.['time']?.[0] !== today) return replyToolError('weather_forecast_stale_or_timezone')
  let current: Record<string, number | string | null> | undefined
  if (data.current && typeof data.current['time'] === 'string' && typeof data.utc_offset_seconds === 'number') {
    const currentAt = Date.parse(data.current['time'] + 'Z') - data.utc_offset_seconds * 1000
    if (Number.isFinite(currentAt) && now.getTime() - currentAt >= -900000 && now.getTime() - currentAt <= 10800000) current = data.current
  }
  if (args['mode'] === 'current' && (date !== today || !current)) return replyToolError('weather_current_unavailable')
  const at = data.daily?.['time']?.indexOf(date) ?? -1
  if (at < 0) return replyToolError('weather_forecast_unavailable')
  const n = (key: string): number | null => { const value = data.daily?.[key]?.[at]; return typeof value === 'number' && Number.isFinite(value) ? value : null }
  const probability = n('precipitation_probability_max')
  if (probability === null || probability < 0 || probability > 100) return replyToolError('weather_forecast_incomplete')
  const fetchedAt = now.toISOString()
  const url = new URL(forecast); url.searchParams.delete('apikey')
  return { ok: true, data: { location: { city: place.name, region: place.admin1, countryCode: place.country_code, latitude: place.latitude, longitude: place.longitude },
    kind: args['mode'] === 'current' ? 'current' : 'forecast', date, timezone, rainProbabilityPercent: probability, precipitationMm: n('precipitation_sum'),
    temperatureMinC: n('temperature_2m_min'), temperatureMaxC: n('temperature_2m_max'), weatherCode: n('weather_code'),
    current: date === today ? current : undefined,
    fetchedAt, providerIssuedAt: null, note: 'Open-Meteo数值预报；fetchedAt是获取时间，不是模型起报时间。概率不是一定下雨；不代表官方预警。',
  }, sources: [{ title: 'Open-Meteo weather forecast (CC BY 4.0 attribution)', url: url.toString(), fetchedAt, date, timezone }] }
}
