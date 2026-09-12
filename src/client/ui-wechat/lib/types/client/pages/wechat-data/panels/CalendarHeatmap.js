import { jsx as _jsx } from "react/jsx-runtime";
/**
 * ECharts `calendar` heatmap for the Overview message-heat pod. Renders the
 * 90-day per-day message counts as a calendar heatmap, using the same
 * space-capsule palette as the geography maps. The chart owns its canvas and
 * disposes it on unmount; it also responds to container reflow via ResizeObserver.
 */
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { HeatmapChart } from 'echarts/charts';
import { CalendarComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import css from './overview.module.css';
echarts.use([HeatmapChart, CalendarComponent, TooltipComponent, VisualMapComponent, CanvasRenderer]);
/**
 * Render the calendar heatmap.
 * @param props - heat data.
 * @returns the chart container element.
 */
export function CalendarHeatmap({ data }) {
    const elRef = useRef(null);
    useEffect(() => {
        const el = elRef.current;
        if (!el || data.length === 0)
            return;
        const first = data[0];
        const last = data[data.length - 1];
        if (!first || !last)
            return;
        const start = first.d;
        const end = last.d;
        const max = Math.max(1, ...data.map(h => h.count));
        const chart = echarts.init(el);
        chart.setOption({
            tooltip: {
                trigger: 'item',
                formatter: (params) => `${params.value[0]}<br/>${params.value[1]} 条消息`,
                backgroundColor: 'rgba(2,8,18,0.85)',
                borderColor: 'rgba(0,240,255,0.4)',
                textStyle: { color: '#dff' },
            },
            visualMap: {
                min: 0,
                max,
                type: 'piecewise',
                orient: 'horizontal',
                left: 'center',
                top: 0,
                itemWidth: 14,
                itemHeight: 12,
                textStyle: { color: 'rgba(200,255,255,0.8)' },
                inRange: { color: ['rgba(0,240,255,0.12)', 'rgba(0,240,255,0.55)', 'rgba(168,85,247,0.95)'] },
            },
            calendar: {
                top: 80,
                left: 18,
                right: 18,
                bottom: 6,
                cellSize: ['auto', 13],
                range: [start, end],
                splitLine: { show: false },
                itemStyle: { borderWidth: 0.5, borderColor: 'rgba(0,240,255,0.18)' },
                yearLabel: { show: false },
                dayLabel: { color: 'rgba(200,255,255,0.6)', fontSize: 10, nameMap: 'zh' },
                monthLabel: { color: 'rgba(168,85,247,0.85)', fontSize: 11 },
            },
            series: [{
                    type: 'heatmap',
                    coordinateSystem: 'calendar',
                    data: data.map(h => [h.d, h.count]),
                    emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,240,255,0.6)' } },
                }],
        });
        const ro = new ResizeObserver(() => { chart.resize(); });
        ro.observe(el);
        return () => {
            ro.disconnect();
            chart.dispose();
        };
    }, [data]);
    return _jsx("div", { ref: elRef, className: css.calendarHeatmap });
}
//# sourceMappingURL=CalendarHeatmap.js.map