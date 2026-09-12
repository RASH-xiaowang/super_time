import { jsx as _jsx } from "react/jsx-runtime";
import { GeoEchartsMap } from "./GeoEchartsMap.js";
import { worldChildByName } from "./world-map-data.js";
import { provinceAdcode } from "./world-geo.js";
/** China GeoJSON candidates, in preference order (same CDN as the world map first). */
const CHINA_GEO_URLS = [
    'https://cdn.jsdelivr.net/npm/chinese-global-compliant-geodata@1.0.0/dist/src/geojson/countries/as/chn/global/chn-level-1.json',
    'https://unpkg.com/chinese-global-compliant-geodata@1.0.0/dist/src/geojson/countries/as/chn/global/chn-level-1.json',
    'https://geo.datav.aliyun.com/areas_v3/bound/geojson?code=100000_full',
];
/**
 * Registered feature name: Aliyun uses numeric adcodes, the Chinese-name dataset
 * uses Chinese province names. Boundary-line features (「境界线」) are dropped.
 * @param feature - one China GeoJSON feature.
 * @returns the registered name, or '' to skip the feature.
 */
function chinaFeatureName(feature) {
    const p = feature.properties;
    const name = p?.name;
    if (name === '境界线')
        return '';
    const ad = p?.adcode;
    if (typeof ad === 'string' && ad)
        return ad;
    if (typeof ad === 'number' && Number.isFinite(ad))
        return String(ad);
    if (typeof name === 'string' && name)
        return name;
    const upper = p?.NAME;
    return typeof upper === 'string' && upper ? upper : '';
}
/** Tooltip display label for a China feature. */
function chinaFeatureLabel(feature) {
    const p = feature.properties;
    const name = p?.name;
    return typeof name === 'string' && name ? name : '';
}
/**
 * Match a registered feature key to the region snapshot child. Adcodes map via
 * provinceAdcode; Chinese names (including 香港/澳门/台湾) map via the world alias table.
 */
function chinaChildByKey(children, key) {
    if (/^\d{6}$/.test(key))
        return children.find(c => provinceAdcode(c.name) === key) ?? null;
    return worldChildByName(children, key);
}
/**
 * Render the China map.
 * @param props - component props.
 * @returns the map container element.
 */
export function ChinaMap({ node, onDrill, onFallback, overlay }) {
    return (_jsx(GeoEchartsMap, { node: node, mapName: "china", urls: CHINA_GEO_URLS, featureName: chinaFeatureName, featureLabel: chinaFeatureLabel, childByKey: key => chinaChildByKey(node?.children ?? [], key), onDrill: onDrill, onFallback: onFallback, overlay: overlay ?? null }));
}
//# sourceMappingURL=ChinaMap.js.map