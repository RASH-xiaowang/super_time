/**
 * Friend-region world-map geometry.
 *
 * The host returns a RegionMapSnapshot whose countries are Chinese labels
 * (from region.ts). This module supplies the offline SVG fallback geometry:
 * coarse continent polygons for the backdrop plus a country-centre table so
 * markers can be placed geographically. `project` maps [lon, lat] into the
 * fixed 1000x500 viewBox; `smoothClosedPath` turns a polygon into a rounded,
 * organic SVG path. When a world GeoJSON is reachable, GeoEchartsMap renders
 * the real ECharts world map instead and this SVG layer becomes the fallback.
 */
/** A geographic point as [longitude, latitude] in degrees. */
export type LatLon = readonly [number, number];
/** A projection mapping [lon, lat] into the fixed MAP_W x MAP_H viewBox. */
export type ProjectFn = (lon: number, lat: number) => {
    x: number;
    y: number;
};
/** Equirectangular (plate carrée) viewBox width used by the map SVG. */
export declare const MAP_W = 1000;
/** Equirectangular (plate carrée) viewBox height used by the map SVG. */
export declare const MAP_H = 500;
/**
 * Project a [lon, lat] point into the fixed MAP_W x MAP_H viewBox.
 * @param lon - longitude in degrees (-180..180).
 * @param lat - latitude in degrees (-90..90).
 * @returns projected x/y within the viewBox.
 */
export declare function project(lon: number, lat: number): {
    x: number;
    y: number;
};
/** A geographic bounding box in degrees. */
export interface BBox {
    lonMin: number;
    lonMax: number;
    latMin: number;
    latMax: number;
}
/** Bounding box of mainland China for the province drill-down. */
export declare const CHINA_BBOX: BBox;
/**
 * Project a [lon, lat] point into the MAP_W x MAP_H viewBox so a region
 * bounding box fills the map (used for the China province drill-down).
 * @param lon - longitude in degrees.
 * @param lat - latitude in degrees.
 * @param bbox - region bounding box in degrees.
 * @returns projected x/y within the viewBox.
 */
export declare function projectBBox(lon: number, lat: number, bbox: BBox): {
    x: number;
    y: number;
};
/**
 * Build a closed smooth SVG path through a polygon's projected points using
 * quadratic beziers through the edge midpoints, giving rounded continent
 * silhouettes instead of angular chain segments.
 * @param points - polygon vertices in [lon, lat].
 * @param proj - projection to apply (defaults to the global `project`).
 * @returns an SVG path `d` string, or '' when fewer than 3 points.
 */
export declare function smoothClosedPath(points: readonly LatLon[], proj?: ProjectFn): string;
/**
 * Continent centroids for the world map backdrop. Hand-authored coarse
 * polygons; each entry is a continent name and its [lon, lat] vertices.
 */
export declare const CONTINENTS: ReadonlyArray<{
    name: string;
    points: readonly LatLon[];
}>;
/**
 * Chinese country/region label -> [lon, lat] centroid, covering the labels
 * RegionMapSnapshot emits. Entries with a geographic centre are plotted as
 * markers; labels absent from this table are collected into an "unlocated"
 * list so the drill still works.
 */
export declare const COUNTRY_CENTERS: Readonly<Record<string, LatLon>>;
/**
 * Look up a country/region centre by its Chinese label.
 * @param name - the label emitted by the region snapshot.
 * @returns the [lon, lat] centre, or null when the label is unknown.
 */
export declare function countryCenter(name: string): LatLon | null;
/**
 * Hand-authored coarse China outline for the province drill-down backdrop.
 * Vertices are [lon, lat] in degrees.
 */
export declare const CHINA_OUTLINE: ReadonlyArray<LatLon>;
/**
 * Chinese province label -> [lon, lat] centroid for the province drill-down.
 * Covers the province labels RegionMapSnapshot emits under 中国, including the
 * synthetic 「省份未填」 bucket (placed centrally so it stays visible).
 */
export declare const PROVINCE_CENTERS: Readonly<Record<string, LatLon>>;
/**
 * Look up a province centre by its Chinese label.
 * @param name - the province label emitted by the region snapshot.
 * @returns the [lon, lat] centre, or null when the label is unknown.
 */
export declare function provinceCenter(name: string): LatLon | null;
/**
 * Chinese province label -> Aliyun DataV adcode, used to fetch a province's
 * GeoJSON and to colour the China ECharts map by friend count. Synthetic buckets
 * (「省份未填」) have no adcode and are absent.
 */
export declare const PROVINCE_ADCODE: Readonly<Record<string, string>>;
/**
 * Look up a province adcode by its Chinese label.
 * @param name - the province label emitted by the region snapshot.
 * @returns the adcode, or null when the label is unknown/synthetic.
 */
export declare function provinceAdcode(name: string): string | null;
//# sourceMappingURL=world-geo.d.ts.map