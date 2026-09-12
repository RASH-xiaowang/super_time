/**
 * Squarified treemap layout for the WeChat world-region map.
 *
 * Given weighted items and a viewport rectangle, produce one rectangle per
 * item whose area is proportional to its weight. Implements the standard
 * squarify algorithm (Bruls, Huizing & van Wijk) so blocks stay near-square
 * and readable. Pure function with no I/O, so it is trivially unit-testable.
 */
/** A weighted input item. */
export interface TreemapItem {
    /** Non-negative weight (area share). */
    value: number;
}
/** A computed rectangle (absolute position + size). */
export interface TreemapRect {
    x: number;
    y: number;
    w: number;
    h: number;
}
interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}
/**
 * Squarify a list of weights into rectangles within the given box.
 * @param items - weighted items (each gets one output rect, index-aligned).
 * @param box - target rectangle.
 * @returns one rect per input item (zero-weight items get a zero-size rect).
 */
export declare function squarify(items: TreemapItem[], box: Box): TreemapRect[];
/**
 * Lay items with one chosen item centered and the rest filling the frame
 * around it. The centered item gets a square-ish block at the middle; the
 * remainder is squarified into the surrounding strips. Used at the world level
 * so the dominant country (中国) sits in the center.
 * @param items - weighted items (each gets one output rect, index-aligned).
 * @param box - target rectangle.
 * @param centerIndex - index of the item to center.
 * @returns one rect per input item.
 */
export declare function centeredSquarify(items: TreemapItem[], box: Box, centerIndex: number): TreemapRect[];
export {};
//# sourceMappingURL=treemap.d.ts.map