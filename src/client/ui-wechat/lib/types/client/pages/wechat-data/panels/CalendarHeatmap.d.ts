/** One day of the 90-day message heat series. */
export interface HeatmapDatum {
    /** ISO date string, e.g. `2025-06-01`. */
    d: string;
    /** Messages sent/received that day. */
    count: number;
}
interface CalendarHeatmapProps {
    /** Ascending 90-day per-day message counts; empty renders nothing. */
    data: HeatmapDatum[];
}
/**
 * Render the calendar heatmap.
 * @param props - heat data.
 * @returns the chart container element.
 */
export declare function CalendarHeatmap({ data }: CalendarHeatmapProps): React.JSX.Element;
export {};
//# sourceMappingURL=CalendarHeatmap.d.ts.map