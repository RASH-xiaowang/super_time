/**
 * WeChat formatting / icon helpers, migrated from st_control utils/format.ts.
 * All pure functions with no side effects.
 */
/**
 * Session/message divider time: today HH:mm, else full date + time.
 * @param ts - Timestamp (number, ISO string, or Date) to format; falsy yields an empty string.
 * @returns Formatted divider: 'HH:mm' when today, else 'YYYY-MM-DD HH:mm'.
 */
export function formatDividerTime(ts) {
    if (!ts)
        return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime()))
        return String(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (isToday)
        return `${hh}:${mm}`;
    return `${y}-${m}-${day} ${hh}:${mm}`;
}
/**
 * First character of a name for avatars.
 * @param name - Display name to derive the letter from.
 * @returns The avatar letter ('?' when the name is empty).
 */
export function avatarLetter(name) {
    const c = (name || '').trim().charAt(0);
    return c && /[\u4e00-\u9fff]/.test(c) ? c : ((name || '').charAt(0).toUpperCase() || '?');
}
/**
 * Deterministic avatar color from a name.
 * @param name - Name used to seed the color hash.
 * @returns A hex color string.
 */
export function colorFromName(name) {
    const colors = ['#f44336', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3', '#009688', '#4caf50', '#ff9800', '#795548', '#607d8b', '#ff5722'];
    let h = 0;
    const s = name || '?';
    for (let i = 0; i < s.length; i++)
        h = ((h << 5) - h) + s.charCodeAt(i);
    return colors[Math.abs(h) % colors.length] ?? '#2196f3';
}
/**
 * Voice duration seconds -> m:ss label.
 * @param sec - Duration in seconds (null/undefined treated as 0).
 * @returns Formatted 'm:ss' duration label.
 */
export function fmtDur(sec) {
    const s = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
}
/**
 * Linear icon svg (24 viewBox, 1.6 stroke, currentColor).
 * @param paths - SVG path fragment(s) rendered inside the svg element.
 * @param size - Icon width/height in px (default 16).
 * @returns An inline SVG string.
 */
export function iconSvg(paths, size = 16) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
/**
 * Icon path snippets (feather-style stroke fragments) keyed by icon name, for iconSvg().
 */
export const ICON_PATHS = {
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>',
    note: '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8z"/><path d="M15 3v4a1 1 0 0 0 1 1h4"/><path d="M8 13h8M8 17h5"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    clip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    gift: '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5" rx="0"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
    archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    present: '<path d="M2 3h20"/><path d="M4 3v14h16V3"/><path d="M9 21h6M12 17v4"/>',
    card: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
    app: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
};
/**
 * File extension -> icon SVG.
 * @param ext - File extension (case-insensitive).
 * @returns An inline SVG string for the matching icon (generic file icon as fallback).
 */
export function fileIcon(ext) {
    const e = (ext || '').toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic'].includes(e))
        return iconSvg(ICON_PATHS.image);
    if (['mp3', 'wav', 'm4a', 'flac', 'aac', 'silk'].includes(e))
        return iconSvg(ICON_PATHS.music);
    if (['mp4', 'mov', 'avi', 'mkv', 'm4v'].includes(e))
        return iconSvg(ICON_PATHS.video);
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e))
        return iconSvg(ICON_PATHS.archive);
    if (['doc', 'docx', 'wps'].includes(e))
        return iconSvg(ICON_PATHS.file);
    if (['xls', 'xlsx', 'csv'].includes(e))
        return iconSvg(ICON_PATHS.sheet);
    if (['ppt', 'pptx'].includes(e))
        return iconSvg(ICON_PATHS.present);
    if (['pdf'].includes(e))
        return iconSvg(ICON_PATHS.file);
    if (['apk', 'exe', 'msi'].includes(e))
        return iconSvg(ICON_PATHS.gear);
    return iconSvg(ICON_PATHS.file);
}
/**
 * Favorites type label -> icon SVG.
 * @param typeLabel - Favorites type label (Chinese label or fallback).
 * @returns An inline SVG string for the matching icon.
 */
export function favIcon(typeLabel) {
    const map = {
        '文本': ICON_PATHS.file, '图片': ICON_PATHS.image, '语音': ICON_PATHS.mic, '视频': ICON_PATHS.video,
        '链接': ICON_PATHS.link, '位置': ICON_PATHS.pin, '文件': ICON_PATHS.file, '笔记': ICON_PATHS.note,
        '聊天记录': ICON_PATHS.chat,
    };
    return iconSvg(map[typeLabel] || ICON_PATHS.clip);
}
//# sourceMappingURL=format.js.map