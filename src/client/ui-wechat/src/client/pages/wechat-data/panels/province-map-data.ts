/**
 * Chinese province drill-down GeoJSON helpers.
 *
 * A province map uses Aliyun DataV `areas_v3` territory GeoJSON
 * (`<adcode>_full`, e.g. 450000_full for 广西) whose feature names carry an
 * administrative suffix (南宁市, 东城区). The region snapshot emits short
 * labels (南宁, 东城), so this module normalises both sides before matching.
 */
import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types'
import type { WorldGeoFeature } from './world-map-data.ts'

/** Aliyun DataV territory GeoJSON URL for one province (city-level features). */
export function provinceGeoUrl(adcode: string): string {
  return `https://geo.datav.aliyun.com/areas_v3/bound/geojson?code=${adcode}_full`
}

/** Administrative suffixes stripped before name matching. */
const CITY_SUFFIX = /(市|地区|自治州|自治县|林区|新区|特别行政区|区|县|旗|盟)$/

/**
 * Normalise an administrative name for matching by dropping its suffix.
 * @param name - administrative name (南宁市 / 东城区 / 南宁 / 东城).
 * @returns the normalised key (南宁 / 东城).
 */
export function cityNormalized(name: string): string {
  return name.replace(CITY_SUFFIX, '')
}

/**
 * Registered feature name (and tooltip label) for a province feature — the
 * Aliyun full name, e.g. 南宁市.
 * @param feature - one province GeoJSON feature.
 * @returns the feature name, or '' when absent.
 */
export function provinceFeatureName(feature: WorldGeoFeature): string {
  const p = feature.properties
  const name = p?.name
  return typeof name === 'string' && name ? name : ''
}

/** Tooltip display label for a province feature (same Aliyun full name). */
export function provinceFeatureLabel(feature: WorldGeoFeature): string {
  return provinceFeatureName(feature)
}

/**
 * Match an Aliyun feature name (南宁市 / 东城区) to a region snapshot city.
 * @param children - province node children (cities).
 * @param name - registered feature name.
 * @returns the matching city node, or null when unrecognised.
 */
export function provinceCityChild(children: readonly RegionNode[], name: string): RegionNode | null {
  const key = cityNormalized(name)
  if (!key) return null
  return children.find(c => cityNormalized(c.name) === key) ?? null
}
