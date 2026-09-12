import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Generic ECharts `map` renderer shared by the China drill-down and the world
 * level. Takes preloaded GeoJSON (`geo`) or fetches the first reachable URL,
 * registers the map with feature names normalised to `featureName`, colours
 * regions by friend count (`visualMap`), shows a hover tooltip and drills into
 * a region on click. Fetch/init failures call `onFallback` so the parent can
 * show the offline SVG map instead.
 */
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { MapChart } from 'echarts/charts';
import { TooltipComponent, VisualMapComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { fetchFirstJson } from "./world-map-data.js";
import css from './world-map.module.css';
echarts.use([MapChart, TooltipComponent, VisualMapComponent, CanvasRenderer]);
/**
 * Render an ECharts map.
 * @param props - component props.
 * @returns the map container element.
 */
export function GeoEchartsMap(props) {
    const elRef = useRef(null);
    const propsRef = useRef(props);
    useEffect(() => {
        propsRef.current = props;
    });
    useEffect(() => {
        let alive = true;
        let chart = null;
        const el = elRef.current;
        if (!el) {
            /* v8 ignore next -- React attaches the ref before the effect runs. */
            props.onFallback();
            return;
        }
        const { node, geo, urls, mapName, featureName, featureLabel, childByKey, onDrill, onFallback } = propsRef.current;
        if (!node) {
            onFallback();
            return;
        }
        void (async () => {
            try {
                const data = geo ?? await fetchFirstJson(urls);
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- cleanup can flip alive while the fetch awaits.
                if (!alive)
                    return;
                const features = (data.features ?? []).filter(f => featureName(f));
                // Build a minimal GeoJSON with only type + features: the Chinese
                // compliant dataset carries an EPSG:4490 `crs` field that ECharts'
                // GeoJSON parser does not consume and would otherwise blank the map.
                const registered = {
                    type: 'FeatureCollection',
                    features: features.map(f => ({
                        ...f,
                        properties: { ...(f.properties ?? {}), name: featureName(f) },
                    })),
                };
                echarts.registerMap(mapName, registered);
                chart = echarts.init(el);
                const labelBy = new Map();
                for (const f of features) {
                    const name = featureName(f);
                    labelBy.set(name, featureLabel(f));
                }
                const max = features.reduce((a, f) => Math.max(a, childByKey(featureName(f))?.count ?? 0), 0) || 1;
                const dataItems = features.map(f => ({
                    name: featureName(f),
                    value: childByKey(featureName(f))?.count ?? 0,
                }));
                chart.setOption({
                    tooltip: {
                        trigger: 'item',
                        formatter: (params) => {
                            const name = params.name;
                            const label = labelBy.get(name) ?? name;
                            const child = childByKey(name);
                            const top = (child?.children.slice(0, 3).map(c => `${c.name} ${c.count}`) ?? []).join('<br/>');
                            return `${label}<br/>${params.value} 位好友${top ? `<br/>${top}` : ''}`;
                        },
                        backgroundColor: 'rgba(2,8,18,0.85)',
                        borderColor: 'rgba(0,240,255,0.4)',
                        textStyle: { color: '#dff' },
                    },
                    visualMap: {
                        min: 0,
                        max,
                        calculable: true,
                        inRange: { color: ['rgba(0,240,255,0.25)', 'rgba(168,85,247,0.95)'] },
                        textStyle: { color: 'rgba(200,255,255,0.8)' },
                        left: 10,
                        bottom: 10,
                    },
                    series: [{
                            type: 'map',
                            map: mapName,
                            roam: true,
                            scaleLimit: { min: 0.8, max: 8 },
                            data: dataItems,
                            label: { show: false, color: '#dff', fontSize: 10 },
                            itemStyle: { areaColor: 'rgba(8,40,60,0.9)', borderColor: 'rgba(0,240,255,0.45)', borderWidth: 0.6 },
                            emphasis: { label: { show: true, color: '#fff', fontWeight: 'bold' }, itemStyle: { areaColor: 'rgba(0,240,255,0.85)' } },
                        }],
                });
                chart.on('click', (params) => {
                    const name = params.name ?? '';
                    const child = childByKey(name);
                    if (child)
                        onDrill(child);
                });
            }
            catch {
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- cleanup can flip alive before a settled rejection resumes.
                if (alive)
                    onFallback();
            }
        })();
        const ro = new ResizeObserver(() => { chart?.resize(); });
        ro.observe(el);
        return () => {
            alive = false;
            ro.disconnect();
            chart?.dispose();
        };
    }, [props.node, props.mapName, props.geo, props.urls]);
    return (_jsxs("div", { className: css.mapFrame, children: [_jsx("div", { ref: elRef, className: css.china3d }), props.overlay] }));
}
//# sourceMappingURL=GeoEchartsMap.js.map