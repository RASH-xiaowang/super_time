import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types';
import { type WorldGeoFeature } from './world-map-data.ts';
/** Props for the generic ECharts map. */
export interface GeoEchartsMapProps {
    /** Region node whose children are the geographic regions; null renders nothing. */
    node: RegionNode | null;
    /** `registerMap` key. */
    mapName: string;
    /** GeoJSON URLs tried in order when `geo` is not provided. */
    urls: readonly string[];
    /** Preloaded GeoJSON; avoids a second fetch when the parent probed first. */
    geo?: unknown;
    /** GeoJSON feature -> registered name (adcode for China, zh name for world). */
    featureName: (feature: WorldGeoFeature) => string;
    /** GeoJSON feature -> display label for the tooltip. */
    featureLabel: (feature: WorldGeoFeature) => string;
    /** Registered name -> region node (null = no friends in that region). */
    childByKey: (key: string) => RegionNode | null;
    /** Called when a region with friends is clicked. */
    onDrill: (child: RegionNode) => void;
    /** Called when GeoJSON fetch or chart initialisation fails. */
    onFallback: () => void;
    /** Optional overlay rendered inside the map container (e.g. back button). */
    overlay?: React.JSX.Element | null;
}
/**
 * Render an ECharts map.
 * @param props - component props.
 * @returns the map container element.
 */
export declare function GeoEchartsMap(props: GeoEchartsMapProps): React.JSX.Element;
//# sourceMappingURL=GeoEchartsMap.d.ts.map