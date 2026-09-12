/**
 * Chinese province drill-down GeoJSON helpers.
 *
 * A province map uses Aliyun DataV `areas_v3` territory GeoJSON
 * (`<adcode>_full`, e.g. 450000_full for 广西) whose feature names carry an
 * administrative suffix (南宁市, 东城区). The region snapshot emits short
 * labels (南宁, 东城), so this module normalises both sides before matching.
 */
import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types';
import type { WorldGeoFeature } from './world-map-data.ts';
/** Aliyun DataV territory GeoJSON URL for one province (city-level features). */
export declare function provinceGeoUrl(adcode: string): string;
/**
 * Normalise an administrative name for matching by dropping its suffix.
 * @param name - administrative name (南宁市 / 东城区 / 南宁 / 东城).
 * @returns the normalised key (南宁 / 东城).
 */
export declare function cityNormalized(name: string): string;
/**
 * Registered feature name (and tooltip label) for a province feature — the
 * Aliyun full name, e.g. 南宁市.
 * @param feature - one province GeoJSON feature.
 * @returns the feature name, or '' when absent.
 */
export declare function provinceFeatureName(feature: WorldGeoFeature): string;
/** Tooltip display label for a province feature (same Aliyun full name). */
export declare function provinceFeatureLabel(feature: WorldGeoFeature): string;
/**
 * Match an Aliyun feature name (南宁市 / 东城区) to a region snapshot city.
 * @param children - province node children (cities).
 * @param name - registered feature name.
 * @returns the matching city node, or null when unrecognised.
 */
export declare function provinceCityChild(children: readonly RegionNode[], name: string): RegionNode | null;
//# sourceMappingURL=province-map-data.d.ts.map