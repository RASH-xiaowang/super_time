import { jsx as _jsx } from "react/jsx-runtime";
/**
 * 市区街道地图（ECharts `map` 系列，阿里 DataV 城市 GeoJSON）。
 *
 * 在「中国 → 省 → 市」层级渲染城市的区县地图（如南宁市的兴宁区、青秀区等）。区域快照
 * 不含区级好友，因此各区颜色按 0 值展示，真正的朋友数据由两侧头像栏提供；GeoJSON 拉取
 * 失败时回退到父级维护的好友面板（onFallback）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { GeoEchartsMap } from "./GeoEchartsMap.js";
import { cityGeoUrl } from "./city-map-data.js";
import { fetchCityAdcode } from "./city-map-data.js";
import { provinceFeatureLabel, provinceFeatureName } from "./province-map-data.js";
import css from './world-map.module.css';
/**
 * Render the city district map.
 * @param props - component props.
 * @returns the map container element.
 */
export function CityMap({ node, provinceAdcode, onFallback, overlay }) {
    const [adcode, setAdcode] = useState(null);
    const onFallbackRef = useRef(onFallback);
    onFallbackRef.current = onFallback;
    useEffect(() => {
        let alive = true;
        setAdcode(null);
        void (async () => {
            try {
                const code = await fetchCityAdcode(provinceAdcode, node.name);
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- cleanup can flip alive while the fetch awaits.
                if (!alive)
                    return;
                if (code)
                    setAdcode(code);
                else
                    onFallbackRef.current();
            }
            catch {
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- cleanup can flip alive before a settled rejection resumes.
                if (alive)
                    onFallbackRef.current();
            }
        })();
        return () => { alive = false; };
    }, [node.name, provinceAdcode]);
    const urls = useMemo(() => (adcode ? [cityGeoUrl(adcode)] : []), [adcode]);
    if (!adcode) {
        return (_jsx("div", { className: css.china3d, children: _jsx("div", { className: css.loading, children: "\u6B63\u5728\u52A0\u8F7D\u57CE\u5E02\u5730\u56FE\u2026" }) }));
    }
    return (_jsx(GeoEchartsMap, { node: node, mapName: "city", urls: urls, featureName: provinceFeatureName, featureLabel: provinceFeatureLabel, childByKey: () => null, onDrill: () => { }, onFallback: onFallback, overlay: overlay ?? null }));
}
//# sourceMappingURL=CityMap.js.map