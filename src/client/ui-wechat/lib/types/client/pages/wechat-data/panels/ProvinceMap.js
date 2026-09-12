import { jsx as _jsx } from "react/jsx-runtime";
/**
 * 省区城市地图（ECharts `map` 系列，阿里 DataV 省市 GeoJSON）——`GeoEchartsMap` 的薄封装。
 *
 * 在「中国 → 省份」层级按城市好友数渲染一张可缩放/平移的省份图（比如广西下钻后显示南宁、
 * 柳州等城市板块），悬停提示、点击城市回调 onDrill 进入城市好友面板。GeoJSON 运行时从
 * geo.datav.aliyun.com 的 `<adcode>_full` 拉取；失败（离线）时回退到父级维护的空间叙利化
 * 方块图（onFallback）。
 */
import { useMemo } from 'react';
import { GeoEchartsMap } from "./GeoEchartsMap.js";
import { provinceCityChild, provinceFeatureLabel, provinceFeatureName, provinceGeoUrl } from "./province-map-data.js";
/**
 * Render the province city map.
 * @param props - component props.
 * @returns the map container element.
 */
export function ProvinceMap({ node, adcode, onDrill, onFallback, overlay }) {
    const urls = useMemo(() => [provinceGeoUrl(adcode)], [adcode]);
    return (_jsx(GeoEchartsMap, { node: node, mapName: "province", urls: urls, featureName: provinceFeatureName, featureLabel: provinceFeatureLabel, childByKey: key => provinceCityChild(node.children, key), onDrill: onDrill, onFallback: onFallback, overlay: overlay ?? null }));
}
//# sourceMappingURL=ProvinceMap.js.map