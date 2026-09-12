/**
 * Whisper transcription configuration support: engine detection (whisper-cli
 * binary or a user-pinned DSH_WECHAT_WHISPER_BIN), CUDA device presence, and
 * model inventory scanned from the configured models dir. Inference runs
 * locally in this package via whipser-cli (see voice-transcribe.ts); this
 * module reports what is configured and available so the settings panel can
 * offer a real model/device/threads configuration.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, } from 'node:fs';
import { dirname, join } from 'node:path';
import { cachedBySig, fileSigOf } from "./meta.js";
/** Whisper model catalog (id/name/size labels). */
export const WHISPER_MODELS = [
    { id: 'tiny', name: 'Tiny', sizeLabel: '约 75 MB · 最快' },
    { id: 'base', name: 'Base', sizeLabel: '约 145 MB · 很快' },
    { id: 'small', name: 'Small', sizeLabel: '约 466 MB · 较快' },
    { id: 'medium', name: 'Medium', sizeLabel: '约 1.5 GB · 中等' },
    { id: 'large-v3', name: 'Large v3', sizeLabel: '约 3.1 GB · 较慢' },
    { id: 'turbo', name: 'Turbo', sizeLabel: '约 1.6 GB · 快' },
];
/** ggml model file per model id (whisper.cpp official release artifacts). */
export const WHISPER_DOWNLOAD_FILES = [
    ['tiny', 'ggml-tiny.bin'],
    ['base', 'ggml-base.bin'],
    ['small', 'ggml-small.bin'],
    ['medium', 'ggml-medium.bin'],
    ['large-v3', 'ggml-large-v3.bin'],
    ['turbo', 'ggml-large-v3-turbo.bin'],
];
/** Base order: env pin first, then the cached reachable one, then official/mirror. */
function whisperDownloadBases() {
    const pinned = process.env.DSH_WECHAT_WHISPER_MIRROR;
    const bases = [];
    if (pinned && pinned.trim().length > 0)
        bases.push(pinned.trim().replace(/\/$/, ''));
    if (reachableBase)
        bases.push(reachableBase);
    bases.push('https://huggingface.co', 'https://hf-mirror.com');
    return [...new Set(bases)];
}
/** First base that answered a download; remembered for subsequent models. */
let reachableBase = null;
/** Header-arrival timeout before a base is declared unreachable. */
const DOWNLOAD_CONNECT_TIMEOUT_MS = 20_000;
/**
 * Move one file/dir to a target (same-volume rename first, copy+remove
 * fallback). An existing destination directory is merged child-by-child and
 * then removed; existing destination files are kept untouched.
 * @returns the number of items moved (merged dirs count their moved children).
 */
function moveItem(src, dest) {
    try {
        if (existsSync(dest)) {
            if (!statSync(src).isDirectory())
                return 0; // keep existing target file
            let moved = 0;
            for (const entry of readdirSync(src, { withFileTypes: true })) {
                moved += moveItem(join(src, entry.name), join(dest, entry.name));
            }
            try {
                rmSync(src, { recursive: true, force: true });
            }
            catch { /* best effort */ }
            return moved;
        }
        mkdirSync(dirname(dest), { recursive: true });
        try {
            renameSync(src, dest);
            return 1;
        }
        catch {
            // EXDEV across volumes: recursive copy then remove.
            cpSync(src, dest, { recursive: true });
            rmSync(src, { recursive: true, force: true });
            return 1;
        }
    }
    catch { /* best effort */ }
    return 0;
}
/**
 * Move engine binary + sibling engine DLLs sitting at a models-dir root
 * (manual extraction), keeping existing targets.
 * @returns the number of items moved.
 */
function moveTopLevelEngineFiles(fromDir, toDir) {
    let moved = 0;
    try {
        for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
            if (entry.isDirectory())
                continue;
            if (/^whisper(?:-cli)?(?:\.exe)?$/i.test(entry.name) || /^(?:ggml-.+|llama)\.dll$/i.test(entry.name)) {
                moved += moveItem(join(fromDir, entry.name), join(toDir, entry.name));
            }
        }
    }
    catch { /* best effort */ }
    return moved;
}
/**
 * Migrate downloaded models (ggml-*.bin), the engine install (bin/), and any
 * top-level engine files (whisper-cli.exe / whisper.exe + sibling engine DLLs)
 * from one models dir to another (best-effort, keeps existing targets).
 * @param fromDir - old models dir.
 * @param toDir - new models dir (created when missing).
 * @returns ok + moved count, or an error description.
 */
export function migrateWhisperModels(fromDir, toDir) {
    if (!fromDir || !toDir)
        return { ok: false, moved: 0, error: '目录为空' };
    if (fromDir.toLowerCase() === toDir.toLowerCase())
        return { ok: true, moved: 0 };
    if (!existsSync(fromDir))
        return { ok: true, moved: 0 };
    try {
        mkdirSync(toDir, { recursive: true });
        let moved = 0;
        for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
            const src = join(fromDir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'bin') {
                    moved += moveItem(src, join(toDir, 'bin'));
                }
                continue;
            }
            if (/^ggml-.+\.bin$/i.test(entry.name)) {
                moved += moveItem(src, join(toDir, entry.name));
            }
            // leftover download artifacts: no longer needed.
            if (entry.name === 'whisper-bin-x64.zip' || entry.name === 'whisper-bin-x64.zip.part') {
                try {
                    unlinkSync(src);
                }
                catch { /* best effort */ }
            }
        }
        moved += moveTopLevelEngineFiles(fromDir, toDir);
        try {
            rmSync(join(fromDir, '.engine-staging'), { recursive: true, force: true });
        }
        catch { /* best effort */ }
        return { ok: true, moved };
    }
    catch (e) {
        return { ok: false, moved: 0, error: e.message };
    }
}
/**
 * Move the engine install directory (the folder holding `binPath`, when it
 * sits under `fromDir`) to the mirrored location under `toDir` and return the
 * relocated binary path; '' when binPath is outside fromDir (external engine:
 * left untouched). The move is best-effort — the returned path is the correct
 * destination either way.
 */
export function migrateWhisperEngineDir(binPath, fromDir, toDir) {
    if (!binPath || !fromDir || !toDir)
        return '';
    const from = fromDir.replace(/[\\/]+$/, '');
    const norm = binPath.replace(/[\\/]+$/, '');
    const f = from.toLowerCase().replaceAll('\\', '/');
    const n = norm.toLowerCase().replaceAll('\\', '/');
    // `\` and `/` both occupy one byte, so indices stay aligned between forms.
    if (!n.startsWith(f + '/'))
        return '';
    const rel = norm.slice(from.length).split(/[\\/]+/).filter(Boolean);
    const dirSegs = rel.slice(0, -1);
    if (dirSegs.length > 0)
        moveItem(dirname(norm), join(toDir, ...dirSegs));
    else
        moveTopLevelEngineFiles(fromDir, toDir);
    return join(toDir, ...rel);
}
/** ggml file-name prefixes per model id (turbo before large-v3 — it shares the prefix). */
const MODEL_FILE_PREFIX = [
    ['turbo', 'ggml-large-v3-turbo'],
    ['large-v3', 'ggml-large-v3'],
    ['medium', 'ggml-medium'],
    ['small', 'ggml-small'],
    ['base', 'ggml-base'],
    ['tiny', 'ggml-tiny'],
];
/**
 * Resolve one engine candidate: a file path (validated) or a dir that
 * contains whisper-cli.exe / whisper.exe. An existing bare directory is not a
 * valid engine — an empty `bin/` leftover must not count as installed.
 * @returns the binary path, or '' when not present.
 */
function resolveEngineCandidate(candidate) {
    const c = candidate.trim();
    if (!c)
        return '';
    for (const name of ['whisper-cli.exe', 'whisper.exe', 'whisper-cli', 'whisper']) {
        const p = join(c, name);
        if (existsSync(p))
            return p;
    }
    try {
        if (existsSync(c) && statSync(c).isFile())
            return c;
    }
    catch { /* invalid path */ }
    return '';
}
/**
 * Detect a local whisper CLI binary. Order: persisted config path → env pin →
 * models-dir install location (bin/ + a bounded search so engine releases
 * extracted into a subdir by earlier layouts still resolve) → PATH.
 * The probe (stat + bounded dir search + PATH lookup) is cached per file
 * fingerprint for a few seconds: the settings panel polls it while a
 * download progresses, and the search only needs to re-run once the dirs
 * actually change.
 * @param configBin - persisted engine path from config (file or dir).
 * @param modelsDir - models cache dir (the engine installs under bin/).
 * @returns the binary path, or '' when none.
 */
export function whisperEnginePath(configBin, modelsDir) {
    const binSig = configBin && /[/\\]/.test(configBin) ? fileSigOf(configBin) : '';
    const dirSig = modelsDir ? fileSigOf(modelsDir) : '';
    return cachedBySig('whisper-engine:' + (modelsDir ?? '') + '|' + (configBin ?? ''), `${binSig}|${dirSig}`, () => resolveWhisperEngine(configBin, modelsDir));
}
/** Uncached engine probe (see {@link whisperEnginePath}). */
function resolveWhisperEngine(configBin, modelsDir) {
    const candidates = [];
    if (configBin && configBin.trim().length > 0)
        candidates.push(configBin);
    const pinned = process.env.DSH_WECHAT_WHISPER_BIN;
    if (pinned && pinned.trim().length > 0)
        candidates.push(pinned);
    if (modelsDir) {
        candidates.push(join(modelsDir, 'bin'), join(modelsDir, 'whisper-cli.exe'));
    }
    for (const candidate of candidates) {
        const resolved = resolveEngineCandidate(candidate);
        if (resolved)
            return resolved;
    }
    if (modelsDir) {
        const found = findFile(modelsDir, 'whisper-cli.exe');
        if (found)
            return found;
    }
    for (const name of ['whisper-cli', 'whisper']) {
        try {
            const found = resolveCommand(name);
            if (found && existsSync(found))
                return found;
        }
        catch { /* not on PATH */ }
    }
    return '';
}
/** Resolve one command name/path against PATH (where/which). */
function resolveCommand(cmd) {
    if (/[/\\]/.test(cmd))
        return cmd;
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(locator, [cmd], { encoding: 'utf8', windowsHide: true });
    const first = out.split(/\r?\n/).map(s => s.trim()).find(s => s.length > 0);
    return first ?? '';
}
/**
 * CUDA device presence (nvidia-smi replies with a device list). Process-level
 * memo: driver presence cannot change while the host runs, so probe once and
 * reuse for an hour (the nvidia-smi subprocess is otherwise spawned on every
 * settings-panel status poll).
 * @returns true when an NVIDIA CUDA device/driver is available.
 */
export function whisperHasCuda() {
    return cachedBySig('whisper-cuda', 'static', () => {
        try {
            execFileSync('nvidia-smi', ['-L'], { encoding: 'utf8', windowsHide: true });
            return true;
        }
        catch {
            return false;
        }
    }, 3_600_000);
}
/**
 * Scan a models dir for installed ggml binaries.
 * @param modelsDir - directory searched for `ggml-<id>[.*].bin`.
 * @returns per-model installed flags + the catalog.
 */
export function whisperModelsStatus(modelsDir) {
    return cachedBySig('whisper-models:' + modelsDir, fileSigOf(modelsDir), () => {
        let names = [];
        try {
            names = readdirSync(modelsDir);
        }
        catch { /* dir absent: nothing installed */ }
        return WHISPER_MODELS.map(m => ({
            ...m,
            installed: MODEL_FILE_PREFIX.some(([id, prefix]) => id === m.id && names.some(n => n.toLowerCase().startsWith(prefix) && n.toLowerCase().endsWith('.bin'))),
        }));
    });
}
/** Default models dir under the DSH-owned wechat data root. */
export function defaultWhisperModelsDir(decryptedDir) {
    return join(decryptedDir, '..', 'whisper');
}
/**
 * Download and install the whisper.cpp CLI engine into
 * `<modelsDir>/bin/whisper-cli.exe` (official release zip, streamed).
 * @param modelsDir - models cache dir.
 * @param onProgress - progress callback (bytes, total).
 * @returns ok + binary path, or an error description.
 */
export async function installWhisperEngine(modelsDir, onProgress) {
    const binDir = join(modelsDir, 'bin');
    const target = join(binDir, 'whisper-cli.exe');
    if (existsSync(target))
        return { ok: true, path: target };
    mkdirSync(binDir, { recursive: true });
    const urls = [
        process.env.DSH_WECHAT_WHISPER_ENGINE_URL?.trim().replace(/\/$/, ''),
        'https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip',
        'https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-bin-x64.zip',
    ].filter((u) => Boolean(u));
    let lastError = '引擎下载失败';
    for (const url of urls) {
        const zipPath = join(modelsDir, 'whisper-bin-x64.zip');
        const ctrl = new AbortController();
        const timer = setTimeout(() => { ctrl.abort(); }, 30_000);
        try {
            const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
            clearTimeout(timer); // headers arrived: streaming may take longer than the connect budget
            if (!res.ok || res.body === null)
                throw new Error(`HTTP ${res.status}`);
            const total = Number(res.headers.get('content-length') ?? 0);
            const reader = res.body.getReader();
            const stream = createWriteStream(zipPath);
            let received = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                stream.write(value);
                received += value.byteLength;
                onProgress(received, total);
            }
            await new Promise((resolve, reject) => {
                stream.end(() => { resolve(); });
                stream.on('error', reject);
            });
            const extractedBase = extractZip(zipPath, modelsDir);
            const found = findFile(extractedBase, 'whisper-cli.exe');
            if (!found)
                throw new Error('压缩包内未找到 whisper-cli.exe');
            // The CLI depends on the sibling ggml-*.dll / llama.dll — move the whole
            // release folder contents into bin/ so DLLs sit next to the exe.
            const releaseDir = dirname(found);
            mkdirSync(binDir, { recursive: true });
            for (const name of readdirSync(releaseDir)) {
                const src = join(releaseDir, name);
                const dest = join(binDir, name);
                if (existsSync(dest))
                    continue;
                try {
                    renameSync(src, dest);
                }
                catch { /* cross-device: copy */ }
                if (!existsSync(dest)) {
                    try {
                        copyFileSync(src, dest);
                        unlinkSync(src);
                    }
                    catch { /* best effort */ }
                }
            }
            try {
                rmSync(extractedBase, { recursive: true, force: true });
            }
            catch { /* best effort */ }
            try {
                unlinkSync(zipPath);
            }
            catch { /* best effort */ }
            return existsSync(target) ? { ok: true, path: target } : { ok: false, error: 'whisper-cli.exe 安装失败（拷贝/移动未完成）' };
        }
        catch (e) {
            lastError = `${url} ${e.message}`;
            try {
                unlinkSync(zipPath);
            }
            catch { /* best effort */ }
        }
        finally {
            clearTimeout(timer);
        }
    }
    return { ok: false, error: lastError + '（可设置 DSH_WECHAT_WHISPER_ENGINE_URL 指向可达镜像，或 DSH_WECHAT_WHISPER_BIN 指向已安装的 whisper-cli.exe）' };
}
/** Extract a zip into a staging dir; top folder name is ignored. */
function extractZip(zipPath, destDir) {
    const staging = join(destDir, '.engine-staging');
    try {
        rmSync(staging, { recursive: true, force: true });
    }
    catch { /* best effort */ }
    mkdirSync(staging, { recursive: true });
    const tar = spawnSync('tar.exe', ['-xf', zipPath, '-C', staging], { windowsHide: true });
    if (tar.status === 0)
        return staging;
    // Fallback: PowerShell Expand-Archive.
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${staging}' -Force`], { windowsHide: true });
    if (ps.status !== 0)
        throw new Error('解压失败（tar/PowerShell 均不可用）');
    return staging;
}
/**
 * Deep search one filename under a dir (depth ≤ 4; dot-entries skipped so
 * staging leftovers never resolve as an engine source).
 */
function findFile(dir, name, depth = 0) {
    if (depth > 4 || !existsSync(dir))
        return '';
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.'))
                continue;
            const p = join(dir, entry.name);
            if (entry.isDirectory()) {
                const found = findFile(p, name, depth + 1);
                if (found)
                    return found;
            }
            else if (entry.name.toLowerCase() === name.toLowerCase()) {
                return p;
            }
        }
    }
    catch { /* unreadable */ }
    return '';
}
/**
 * Stream one official ggml model file into the models dir (atomic .part →
 * rename), reporting received/total bytes.
 * @param modelId - model id from the catalog.
 * @param modelsDir - target models dir (created when missing).
 * @param onProgress - per-chunk progress callback (bytes, total bytes).
 * @returns ok + file/bytes, or an error description.
 */
export async function whisperDownloadModel(modelId, modelsDir, onProgress) {
    const entry = WHISPER_DOWNLOAD_FILES.find(([id]) => id === modelId);
    if (!entry)
        return { ok: false, error: '未知模型: ' + modelId };
    const file = entry[1];
    mkdirSync(modelsDir, { recursive: true });
    const finalPath = join(modelsDir, file);
    if (existsSync(finalPath))
        return { ok: true, file, bytes: 0 };
    let lastError = '下载失败';
    for (const base of whisperDownloadBases()) {
        const url = `${base}/ggerganov/whisper.cpp/resolve/main/${file}`;
        const tmp = join(modelsDir, file + '.part');
        let bytes = 0;
        let total = 0;
        try {
            // Connect/header timeout only: streaming a multi-GB model must not be
            // killed by the same timer once headers arrive.
            const ctrl = new AbortController();
            const timer = setTimeout(() => { ctrl.abort(); }, DOWNLOAD_CONNECT_TIMEOUT_MS);
            let res;
            try {
                res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
            }
            finally {
                clearTimeout(timer);
            }
            if (!res.ok || res.body === null)
                throw new Error(`HTTP ${res.status}`);
            total = Number(res.headers.get('content-length') ?? 0);
            const reader = res.body.getReader();
            const stream = createWriteStream(tmp);
            let settled = false;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    stream.write(value);
                    bytes += value.byteLength;
                    onProgress(bytes, total);
                }
                await new Promise((resolve, reject) => {
                    stream.end(() => { resolve(); });
                    stream.on('error', reject);
                });
                settled = true;
            }
            finally {
                if (!settled) {
                    try {
                        stream.destroy();
                    }
                    catch { /* best effort */ }
                    try {
                        unlinkSync(tmp);
                    }
                    catch { /* best effort */ }
                }
            }
            renameSync(tmp, finalPath);
            reachableBase = base;
            return { ok: true, file, bytes };
        }
        catch (e) {
            lastError = `${base} ${e.message}`;
            try {
                unlinkSync(tmp);
            }
            catch { /* best effort */ }
        }
    }
    return { ok: false, error: lastError };
}
//# sourceMappingURL=whisper.js.map