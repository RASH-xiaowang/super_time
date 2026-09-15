/**
 * Rewrite an in-archive path to its `app.asar.unpacked` sibling.
 *
 * Dev paths (no `app.asar` segment) and already-unpacked paths come back
 * unchanged. The second guard matters: a path that already contains
 * `app.asar.unpacked` would otherwise be rewritten to
 * `app.asar.unpacked/.unpacked/...`, because the search finds the `app.asar`
 * prefix *inside* the marker.
 * @param p - Absolute path.
 * @returns The unpacked sibling in a packaged build; `p` otherwise.
 */
export declare function unpackedAware(p: string): string;
/**
 * Resolve a candidate path to one that is a **real file on disk**.
 *
 * Use this instead of a bare `existsSync(candidate)` whenever the caller is
 * about to *execute* or *write* the path — that is exactly where the asar `fs`
 * patch stops applying. In a packaged build the answer is the
 * `app.asar.unpacked` sibling (and `''` when it is missing, i.e. when
 * `asarUnpack` does not cover the file: a clear "not found" beats handing an
 * unrunnable path to `spawn`).
 * @param candidate - Absolute path, possibly inside `app.asar`.
 * @param exists - Existence probe; injectable so the packaged layout can be
 *   simulated without Electron.
 * @returns A real on-disk path, or `''` when there is none.
 */
export declare function onDiskPath(candidate: string, exists?: (p: string) => boolean): string;
