/** Aliyun DataV district GeoJSON URL for one city adcode. */
export declare function cityGeoUrl(adcode: string): string;
/**
 * Resolve a city adcode from the province GeoJSON by normalised city name.
 * @param provinceAdcode - province adcode (e.g. 450000).
 * @param cityName - region snapshot city label (e.g. 南宁 or 南宁市).
 * @returns the city adcode, or null when the province file is unreachable or the city is absent.
 */
export declare function fetchCityAdcode(provinceAdcode: string, cityName: string): Promise<string | null>;
//# sourceMappingURL=city-map-data.d.ts.map