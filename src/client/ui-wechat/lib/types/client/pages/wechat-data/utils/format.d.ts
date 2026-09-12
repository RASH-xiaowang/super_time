/**
 * WeChat formatting / icon helpers, migrated from st_control utils/format.ts.
 * All pure functions with no side effects.
 */
/**
 * Session/message divider time: today HH:mm, else full date + time.
 * @param ts - Timestamp (number, ISO string, or Date) to format; falsy yields an empty string.
 * @returns Formatted divider: 'HH:mm' when today, else 'YYYY-MM-DD HH:mm'.
 */
export declare function formatDividerTime(ts: number | string | Date | undefined): string;
/**
 * First character of a name for avatars.
 * @param name - Display name to derive the letter from.
 * @returns The avatar letter ('?' when the name is empty).
 */
export declare function avatarLetter(name: string): string;
/**
 * Deterministic avatar color from a name.
 * @param name - Name used to seed the color hash.
 * @returns A hex color string.
 */
export declare function colorFromName(name: string): string;
/**
 * Voice duration seconds -> m:ss label.
 * @param sec - Duration in seconds (null/undefined treated as 0).
 * @returns Formatted 'm:ss' duration label.
 */
export declare function fmtDur(sec: number | null | undefined): string;
/**
 * Linear icon svg (24 viewBox, 1.6 stroke, currentColor).
 * @param paths - SVG path fragment(s) rendered inside the svg element.
 * @param size - Icon width/height in px (default 16).
 * @returns An inline SVG string.
 */
export declare function iconSvg(paths: string, size?: number): string;
/**
 * Icon path snippets (feather-style stroke fragments) keyed by icon name, for iconSvg().
 */
export declare const ICON_PATHS: {
    file: string;
    image: string;
    music: string;
    video: string;
    sheet: string;
    gear: string;
    link: string;
    pin: string;
    mic: string;
    note: string;
    chat: string;
    clip: string;
    download: string;
    search: string;
    gift: string;
    archive: string;
    present: string;
    card: string;
    app: string;
    users: string;
};
/**
 * File extension -> icon SVG.
 * @param ext - File extension (case-insensitive).
 * @returns An inline SVG string for the matching icon (generic file icon as fallback).
 */
export declare function fileIcon(ext: string): string;
/**
 * Favorites type label -> icon SVG.
 * @param typeLabel - Favorites type label (Chinese label or fallback).
 * @returns An inline SVG string for the matching icon.
 */
export declare function favIcon(typeLabel: string): string;
//# sourceMappingURL=format.d.ts.map