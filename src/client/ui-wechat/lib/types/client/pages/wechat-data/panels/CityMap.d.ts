import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types';
/** Options for the city map component. */
interface CityMapProps {
    /** The city region node (districts are not present in the snapshot). */
    node: RegionNode;
    /** Aliyun DataV adcode of the parent province (e.g. 450000). */
    provinceAdcode: string;
    /** Called when the adcode resolution or district GeoJSON fetch fails. */
    onFallback: () => void;
    /** Optional overlay rendered inside the map container (e.g. back button). */
    overlay?: React.JSX.Element | null;
}
/**
 * Render the city district map.
 * @param props - component props.
 * @returns the map container element.
 */
export declare function CityMap({ node, provinceAdcode, onFallback, overlay }: CityMapProps): React.JSX.Element;
export {};
//# sourceMappingURL=CityMap.d.ts.map