/** World GeoJSON fetch candidates, pinned to an immutable version. */
export const WORLD_GEO_URLS = [
    'https://cdn.jsdelivr.net/npm/@surbowl/world-geo-json-zh@2.1.5/world.zh.json',
    'https://unpkg.com/@surbowl/world-geo-json-zh@2.1.5/world.zh.json',
];
/** Variant feature names (Chinese or English) -> snapshot's canonical label. */
const WORLD_NAME_ALIASES = {
    China: '中国',
    中国香港: '中国香港',
    香港: '中国香港',
    'Hong Kong': '中国香港',
    中国澳门: '中国澳门',
    澳门: '中国澳门',
    Macao: '中国澳门',
    Macau: '中国澳门',
    中国台湾: '中国台湾',
    台湾: '中国台湾',
    Taiwan: '中国台湾',
    'United States': '美国',
    'United States Minor Outlying Islands': '美国本土外小岛屿',
    'United Kingdom': '英国',
    'Republic of Korea': '韩国',
    大韩民国: '韩国',
    "Democratic People's Republic of Korea": '朝鲜',
    朝鲜民主主义人民共和国: '朝鲜',
    Russia: '俄罗斯',
    俄罗斯联邦: '俄罗斯',
    Czechia: '捷克',
    'Czech Republic': '捷克',
    捷克共和国: '捷克',
    'Bosnia and Herzegovina': '波黑',
    波斯尼亚和黑塞哥维那: '波黑',
};
/**
 * Read the feature name used for registration and matching.
 * @param feature - one world GeoJSON feature.
 * @returns the feature name, or '' when the feature carries none.
 */
export function worldFeatureName(feature) {
    const p = feature.properties;
    const name = p?.name;
    if (typeof name === 'string' && name)
        return name;
    const upper = p?.NAME;
    if (typeof upper === 'string' && upper)
        return upper;
    return '';
}
/**
 * Match a GeoJSON feature name to a region snapshot child.
 * @param children - region snapshot children (countries).
 * @param name - feature name from the GeoJSON.
 * @returns the matching child, or null when unrecognised.
 */
export function worldChildByName(children, name) {
    const exact = children.find(c => c.name === name);
    if (exact)
        return exact;
    const alias = WORLD_NAME_ALIASES[name];
    if (!alias)
        return null;
    return children.find(c => c.name === alias) ?? null;
}
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
export function worldUnmatchedChildren(children, features) {
    const matched = new Set();
    for (const f of features) {
        const name = worldFeatureName(f);
        const child = name ? worldChildByName(children, name) : null;
        if (child)
            matched.add(child.key);
    }
    return children.filter(c => !matched.has(c.key));
}
/**
 * Fetch the first GeoJSON candidate that answers with a 2xx response.
 * @param urls - candidate URLs in preference order.
 * @returns the parsed JSON body.
 * @throws when every candidate fails (network, non-2xx or parse error).
 */
export async function fetchFirstJson(urls) {
    let lastError = null;
    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (!res.ok)
                throw new Error(`geo http ${res.status}`);
            return await res.json();
        }
        catch (e) {
            lastError = e instanceof Error ? e : new Error(String(e));
        }
    }
    throw lastError ?? new Error('no geo source');
}
//# sourceMappingURL=world-map-data.js.map