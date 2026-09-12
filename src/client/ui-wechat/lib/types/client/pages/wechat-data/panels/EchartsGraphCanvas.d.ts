import { type BuiltGraph, type GraphSettings } from './graph-model.ts';
import { type PosterRatio, type PosterStyle } from './graph-poster.ts';
export interface EchartsGraphCanvasHandle {
    fitView: () => void;
    centerOn: (id: string) => void;
    runAnimation: () => void;
    relayout: () => void;
    exportSvg: () => Promise<string>;
    exportPng: (_ratio: PosterRatio, _style: PosterStyle) => Promise<string>;
    renderPoster: (_ratio: PosterRatio, _style: PosterStyle) => Promise<string>;
}
interface EchartsGraphCanvasProps {
    graph: BuiltGraph;
    dark?: boolean;
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    settings: GraphSettings;
    selfUsername?: string | undefined;
    pinnedIds?: ReadonlySet<string>;
    focusCommunity?: number | null;
    hoverCommunity?: number | null;
    onOpenChat?: ((username: string) => void) | undefined;
    onFocusNode?: ((id: string) => void) | undefined;
}
/**
 * Render the ECharts force graph.
 * @param props - graph / settings / callbacks.
 * @returns the chart container element.
 */
export declare const EchartsGraphCanvas: import("react").ForwardRefExoticComponent<EchartsGraphCanvasProps & import("react").RefAttributes<EchartsGraphCanvasHandle>>;
export {};
//# sourceMappingURL=EchartsGraphCanvas.d.ts.map