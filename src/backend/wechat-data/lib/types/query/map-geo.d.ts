import type { MapGeoJsonResult } from '../types.ts';
/**
 * 该地址是否是地图模块允许取回的公共 GeoJSON 源。
 * @param raw - 渲染层传来的候选地址。
 * @returns true 才允许发请求；其余协议、主机、路径和查询参数都会拒绝。
 */
export declare function isAllowedMapGeoUrl(raw: string): boolean;
/**
 * 按候选顺序取回第一份可用的 GeoJSON。
 * @param urls - 候选地址；不在白名单里的项直接跳过。
 * @returns 已解析的 JSON，或首条可展示的失败原因。
 */
export declare function fetchMapGeoJson(urls: readonly string[]): Promise<MapGeoJsonResult>;
