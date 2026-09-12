/**
 * 中国地图（ECharts `map` 系列，中文国名 GeoJSON + 阿里 DataV 兜底）——`GeoEchartsMap` 的薄封装。
 *
 * 世界层下钻到「中国」时，用 echarts 渲染一张可缩放/平移的中国地图，按省份好友数
 * 分级填色（choropleth），悬停显示提示、点击有数据的省份回调 onDrill 进入该省/市方块图。
 * GeoJSON 优先从与「世界地图」同源的 jsDelivr 中文国名数据包拉取（chinese-global-compliant-geodata
 * 的 chn-level-1.json，feature 名为北京/广东/香港等），失败后回退到阿里 DataV 的
 * `100000_full`（按 adcode 归一化）；两者都失败（离线）时回退到父级维护的 2D SVG 地图。
 */
import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types';
/** Options for the China map component. */
interface ChinaMapProps {
    /** The 中国 region node (children = provinces). */
    node: RegionNode | null;
    /** Called when a province with data is clicked. */
    onDrill: (child: RegionNode) => void;
    /** Called when the ECharts map cannot be initialised (offline GeoJSON fetch / render error). */
    onFallback: () => void;
    /** Optional overlay rendered inside the map container (e.g. back button). */
    overlay?: React.JSX.Element | null;
}
/**
 * Render the China map.
 * @param props - component props.
 * @returns the map container element.
 */
export declare function ChinaMap({ node, onDrill, onFallback, overlay }: ChinaMapProps): React.JSX.Element;
export {};
//# sourceMappingURL=ChinaMap.d.ts.map