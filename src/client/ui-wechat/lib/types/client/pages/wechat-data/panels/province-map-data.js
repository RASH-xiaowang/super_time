/** Aliyun DataV territory GeoJSON URL for one province (city-level features). */
export function provinceGeoUrl(adcode) {
    return `https://geo.datav.aliyun.com/areas_v3/bound/geojson?code=${adcode}_full`;
}
/** Administrative suffixes stripped before name matching. */
const CITY_SUFFIX = /(市|地区|自治州|自治县|林区|新区|特别行政区|区|县|旗|盟)$/;
/**
 * Normalise an administrative name for matching by dropping its suffix.
 * @param name - administrative name (南宁市 / 东城区 / 南宁 / 东城).
 * @returns the normalised key (南宁 / 东城).
 */
export function cityNormalized(name) {
    return name.replace(CITY_SUFFIX, '');
}
/**
 * Registered feature name (and tooltip label) for a province feature — the
 * Aliyun full name, e.g. 南宁市.
 * @param feature - one province GeoJSON feature.
 * @returns the feature name, or '' when absent.
 */
export function provinceFeatureName(feature) {
    const p = feature.properties;
    const name = p?.name;
    return typeof name === 'string' && name ? name : '';
}
/** Tooltip display label for a province feature (same Aliyun full name). */
export function provinceFeatureLabel(feature) {
    return provinceFeatureName(feature);
}
/**
 * Match an Aliyun feature name (南宁市 / 东城区) to a region snapshot city.
 * @param children - province node children (cities).
 * @param name - registered feature name.
 * @returns the matching city node, or null when unrecognised.
 */
export function provinceCityChild(children, name) {
    const key = cityNormalized(name);
    if (!key)
        return null;
    return children.find(c => cityNormalized(c.name) === key) ?? null;
}
//# sourceMappingURL=province-map-data.js.map