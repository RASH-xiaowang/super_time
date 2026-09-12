/**
 * Chinese city drill-down GeoJSON helpers.
 *
 * A city map uses Aliyun DataV `<cityAdcode>_full` (e.g. 450100_full for 南宁市)
 * which contains the city's districts. The region snapshot carries no city
 * adcode, so this module first resolves it from the province GeoJSON
 * (`450000_full`) by name (南宁市 ↔ 南宁), then builds the city URL.
 */
import { fetchFirstJson } from './world-map-data.ts'
import { cityNormalized, provinceFeatureName, provinceGeoUrl } from './province-map-data.ts'

interface GeoCollection {
  features?: Array<{ properties?: Record<string, unknown> }>
}

/** Aliyun DataV district GeoJSON URL for one city adcode. */
export function cityGeoUrl(adcode: string): string {
  return `https://geo.datav.aliyun.com/areas_v3/bound/geojson?code=${adcode}_full`
}

/**
 * Resolve a city adcode from the province GeoJSON by normalised city name.
 * @param provinceAdcode - province adcode (e.g. 450000).
 * @param cityName - region snapshot city label (e.g. 南宁 or 南宁市).
 * @returns the city adcode, or null when the province file is unreachable or the city is absent.
 */
export async function fetchCityAdcode(provinceAdcode: string, cityName: string): Promise<string | null> {
  const data = await fetchFirstJson([provinceGeoUrl(provinceAdcode)]) as GeoCollection
  const key = cityNormalized(cityName)
  for (const f of data.features ?? []) {
    if (cityNormalized(provinceFeatureName(f)) !== key) continue
    const ad = f.properties?.adcode
    if (typeof ad === 'string' && ad) return ad
    if (typeof ad === 'number' && Number.isFinite(ad)) return String(ad)
  }
  return null
}
