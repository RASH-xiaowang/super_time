import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types';
/** Options for the province map component. */
interface ProvinceMapProps {
    /** The province region node (children = cities). */
    node: RegionNode;
    /** Aliyun DataV adcode of the province (e.g. 450000). */
    adcode: string;
    /** Called when a city with data is clicked. */
    onDrill: (child: RegionNode) => void;
    /** Called when the GeoJSON fetch or chart initialisation fails. */
    onFallback: () => void;
    /** Optional overlay rendered inside the map container (e.g. back button). */
    overlay?: React.JSX.Element | null;
}
/**
 * Render the province city map.
 * @param props - component props.
 * @returns the map container element.
 */
export declare function ProvinceMap({ node, adcode, onDrill, onFallback, overlay }: ProvinceMapProps): React.JSX.Element;
export {};
//# sourceMappingURL=ProvinceMap.d.ts.map