/**
 * World GeoJSON source and helpers for the ECharts world map.
 *
 * The host region snapshot (query/region-map.ts) emits Chinese country labels.
 * The chosen data set (@surbowl/world-geo-json-zh, deprecated but stable) ships
 * a world GeoJSON whose feature names are already Chinese, so no ISO-code table
 * is needed on the client. URLs are tried in order at runtime; when none is
 * reachable the panel falls back to the offline SVG map.
 */
import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types';
/** World GeoJSON fetch candidates, pinned to an immutable version. */
export declare const WORLD_GEO_URLS: readonly ["https://cdn.jsdelivr.net/npm/@surbowl/world-geo-json-zh@2.1.5/world.zh.json", "https://unpkg.com/@surbowl/world-geo-json-zh@2.1.5/world.zh.json"];
/** One GeoJSON feature's properties (name key varies across sources). */
export interface WorldGeoFeature {
    properties?: Record<string, unknown>;
}
/**
 * Read the feature name used for registration and matching.
 * @param feature - one world GeoJSON feature.
 * @returns the feature name, or '' when the feature carries none.
 */
export declare function worldFeatureName(feature: WorldGeoFeature): string;
/**
 * Match a GeoJSON feature name to a region snapshot child.
 * @param children - region snapshot children (countries).
 * @param name - feature name from the GeoJSON.
 * @returns the matching child, or null when unrecognised.
 */
export declare function worldChildByName(children: readonly RegionNode[], name: string): RegionNode | null;
/**
 * Region children that have no feature in the GeoJSON.
 *
 * The chosen data set merges a few Chinese territories (中国香港/中国澳门/中国台湾)
 * into 中国, so those snapshot labels cannot be shaded or clicked on the map; they
 * are surfaced as chips so the drill still works.
 * @param children - region snapshot children (countries).
 * @param features - world GeoJSON features.
 * @returns the unmatched children, in snapshot order.
 */
export declare function worldUnmatchedChildren(children: readonly RegionNode[], features: readonly WorldGeoFeature[]): RegionNode[];
/**
 * Fetch the first GeoJSON candidate that answers with a 2xx response.
 * @param urls - candidate URLs in preference order.
 * @returns the parsed JSON body.
 * @throws when every candidate fails (network, non-2xx or parse error).
 */
export declare function fetchFirstJson(urls: readonly string[]): Promise<unknown>;
//# sourceMappingURL=world-map-data.d.ts.map