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
 * @param readLocal - 本地读取器（默认按候选地址自动选：世界数据读 `world.zh.json`，
 *   DataV 地址读 `drill/<adcode>.json`）。
 *
 *   **为什么要能注入**：单测要分别验证「本地命中」与「本地缺失 → 走 CDN」两条路，
 *   而本地文件在仓库里是**真实存在**的（`resources/geo/`）——
 *   不注入的话「走 CDN」那条用例永远测不到（本地一命中就返回了）。
 *   生产调用方不传，用默认实现。
 * @returns 已解析的 JSON，或首条可展示的失败原因。
 */
export declare function fetchMapGeoJson(urls: readonly string[], readLocal?: (urls: readonly string[]) => unknown | null): Promise<MapGeoJsonResult>;
