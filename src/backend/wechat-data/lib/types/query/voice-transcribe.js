/**
 * Local voice batch transcription: silk → WAV (wx_silk) → whisper-cli with the
 * selected ggml model → text cached as `<decoded>/voices/<svr_id>.txt`, WAVs
 * cached alongside so later runs only re-infer.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { recentVoiceMessages, silkToWav, svrIdByChatLocal, voiceDataBySvr } from "./voice.js";
import { WHISPER_DOWNLOAD_FILES } from "./whisper.js";
/** voice cache dir layout mirrors st_control: decoded_images/voices/. */
function voicesDir(decodedDir) {
    return join(decodedDir, 'voices');
}
/** Cached transcript path for one voice message. */
export function transcriptPath(decodedDir, svrId) {
    return join(voicesDir(decodedDir), svrId + '.txt');
}
/** Cached transcript text (empty when none). */
export function cachedTranscript(decodedDir, svrId) {
    try {
        const t = readFileSync(transcriptPath(decodedDir, svrId), 'utf8').trim();
        return t;
    }
    catch {
        return '';
    }
}
// ---------------------------------------------------------------------------
// ASCII path aliases. whisper.cpp on Windows builds file paths from ANSI argv
// and opens them as UTF-8: any model/wav path containing non-ASCII characters
// aborts the process (0xC0000409). Junctions under an ASCII base give whisper
// an ASCII path to the same files.
/** Real parent dir → created ASCII junction path (per batch). */
const aliasLinks = new Map();
function isAscii(s) {
    return !/[^\x00-\x7f]/.test(s);
}
/** Pick a creatable ASCII alias base under (or near) the decoded data root. */
function pickAliasBase(decodedDir) {
    const candidates = [join(decodedDir, '..', 'whisper-aliases'), join(tmpdir(), 'dsh-whisper-aliases')];
    for (const c of candidates) {
        if (!isAscii(c))
            continue;
        try {
            mkdirSync(c, { recursive: true });
            return c;
        }
        catch { /* try next */ }
    }
    return tmpdir();
}
/** Ensure the ASCII junction for one real directory exists; returns its path. */
function ensureAsciiLink(realDir, aliasBase) {
    const cached = aliasLinks.get(realDir);
    if (cached)
        return cached;
    let link = join(aliasBase, 'wpa-' + createHash('sha1').update(realDir.toLowerCase()).digest('hex').slice(0, 12));
    try {
        if (existsSync(link)) {
            const target = readlinkSync(link).replace(/[\\/]+$/, '').toLowerCase();
            if (target !== realDir.replace(/[\\/]+$/, '').toLowerCase()) {
                rmSync(link, { recursive: true, force: true });
                symlinkSync(realDir, link, 'junction');
            }
        }
        else {
            symlinkSync(realDir, link, 'junction');
        }
    }
    catch {
        link = realDir; // junctions unavailable: whisper will surface the aborted path
    }
    aliasLinks.set(realDir, link);
    return link;
}
/**
 * Map a file path to an ASCII equivalent (junction alias for non-ASCII parent
 * dirs) so whisper-cli can open it; ASCII paths pass through untouched.
 * @param filePath - model/wav/output path to hand to whisper.
 * @param aliasBase - ASCII dir that holds the junction links.
 * @returns an ASCII-safe path to the same file.
 */
export function asciiPathForWhisper(filePath, aliasBase) {
    if (isAscii(filePath))
        return filePath;
    return join(ensureAsciiLink(dirname(filePath), aliasBase), basename(filePath));
}
/** Run whisper-cli on one WAV; returns the transcript text. */
function whisperOne(bin, modelPath, wavPath, outBase) {
    const done = spawnSync(bin, ['-m', modelPath, '-f', wavPath, '-l', 'auto', '-np', '--no-timestamps', '-otxt', '-of', outBase], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 600_000,
    });
    if (done.status === 0 && existsSync(outBase + '.txt')) {
        const text = readFileSync(outBase + '.txt', 'utf8').trim();
        if (text)
            return text;
    }
    if (done.error)
        throw new Error(`whisper-cli 启动失败: ${done.error.message}`);
    // Fallback: parse stdout (plain segment text).
    const stdout = done.stdout.trim();
    if (stdout)
        return stdout;
    throw new Error(done.stderr.trim() || `whisper-cli 退出码 ${String(done.status)}`);
}
/**
 * Transcribe one voice message (or return its cached transcript): silk → WAV →
 * whisper-cli → text cached as `<svr_id>.txt`.
 * @returns { text } on success (possibly cached), { error } otherwise.
 */
function transcribeVoiceText(decryptedDir, decodedDir, modelPath, engineBin, svrId, aliasBase) {
    const vdir = voicesDir(decodedDir);
    mkdirSync(vdir, { recursive: true });
    const existing = cachedTranscript(decodedDir, svrId);
    if (existing)
        return { text: existing };
    try {
        const wavPath = join(vdir, svrId + '.wav');
        if (!existsSync(wavPath)) {
            const silk = voiceDataBySvr(decryptedDir, svrId);
            if (!silk)
                return { error: 'VoiceInfo 无语音数据' };
            const dec = silkToWav(silk, wavPath);
            if (!dec.ok)
                return { error: 'SILK 解码失败: ' + (dec.error ?? '') };
        }
        const wavPathA = asciiPathForWhisper(wavPath, aliasBase);
        const outBaseA = asciiPathForWhisper(join(vdir, svrId), aliasBase);
        const modelPathA = asciiPathForWhisper(modelPath, aliasBase);
        const text = whisperOne(engineBin, modelPathA, wavPathA, outBaseA);
        if (text) {
            writeFileSync(transcriptPath(decodedDir, svrId), text, 'utf8');
            return { text };
        }
        return { error: '转写结果为空' };
    }
    catch (e) {
        return { error: e.message };
    }
}
/**
 * Transcribe one voice message by (username, local_id) — used by the chat
 * bubble's 语音转文字 button.
 * @returns { ok:true, text } or { ok:false, error }.
 */
export function transcribeOneVoice(decryptedDir, decodedDir, modelsDir, modelId, engineBin, username, localId) {
    const modelFile = WHISPER_DOWNLOAD_FILES.find(([id]) => id === modelId)?.[1];
    if (!modelFile)
        return { ok: false, error: '未知模型: ' + modelId };
    const modelPath = join(modelsDir, modelFile);
    if (!existsSync(modelPath))
        return { ok: false, error: `模型未安装: ${modelFile}` };
    if (!existsSync(engineBin))
        return { ok: false, error: '未找到 whisper.cpp 引擎: ' + engineBin };
    const svrId = svrIdByChatLocal(decryptedDir, username, localId);
    if (!svrId)
        return { ok: false, error: '未找到语音消息' };
    const r = transcribeVoiceText(decryptedDir, decodedDir, modelPath, engineBin, svrId, pickAliasBase(decodedDir));
    return r.text ? { ok: true, text: r.text } : { ok: false, error: r.error ?? '转写失败' };
}
/**
 * Batch-transcribe the most recent voice messages.
 * @param decryptedDir - decrypted data root (VoiceInfo source).
 * @param decodedDir - decoded-images cache root (wav/txt caches).
 * @param modelsDir - model cache dir.
 * @param modelId - selected model id ('tiny' | ... | 'turbo').
 * @param engineBin - whisper-cli binary path.
 * @param limit - max voice messages to process (newest first).
 * @param onProgress - per-message progress callback.
 * @returns VoiceBatchResult with ok/done/failed/skipped counts.
 */
export function transcribeVoiceBatch(decryptedDir, decodedDir, modelsDir, modelId, engineBin, limit, onProgress) {
    const modelFile = WHISPER_DOWNLOAD_FILES.find(([id]) => id === modelId)?.[1];
    if (!modelFile)
        return Promise.resolve({ ok: false, total: 0, done: 0, failed: 0, skipped: 0, errors: [], engine: engineBin, error: '未知模型: ' + modelId });
    const modelPath = join(modelsDir, modelFile);
    if (!existsSync(modelPath)) {
        return Promise.resolve({ ok: false, total: 0, done: 0, failed: 0, skipped: 0, errors: [], engine: engineBin, model: modelFile, error: `模型未安装: ${modelFile}（请先下载或放入模型目录）` });
    }
    if (!existsSync(engineBin)) {
        return Promise.resolve({ ok: false, total: 0, done: 0, failed: 0, skipped: 0, errors: [], engine: engineBin, model: modelFile, error: '未找到 whisper.cpp 引擎: ' + engineBin });
    }
    const sources = recentVoiceMessages(decryptedDir, Math.max(1, limit));
    // whisper-cli aborts on non-ASCII file paths (UTF-8-only): alias them once.
    const aliasBase = pickAliasBase(decodedDir);
    const errors = [];
    let done = 0;
    let failed = 0;
    let skipped = 0;
    let idx = 0;
    for (const src of sources) {
        idx += 1;
        const existing = cachedTranscript(decodedDir, src.svrId);
        if (existing) {
            skipped += 1;
            onProgress(idx, sources.length, failed, src.svrId);
            continue;
        }
        const r = transcribeVoiceText(decryptedDir, decodedDir, modelPath, engineBin, src.svrId, aliasBase);
        if (r.text) {
            done += 1;
        }
        else if (r.error === '转写结果为空') {
            skipped += 1;
        }
        else {
            failed += 1;
            errors.push({ svrId: src.svrId, username: src.username, error: r.error ?? '转写失败' });
        }
        onProgress(idx, sources.length, failed, src.svrId);
    }
    return Promise.resolve({
        ok: errors.length === 0, total: sources.length, done, failed, skipped, errors, engine: engineBin, model: modelFile,
    });
}
//# sourceMappingURL=voice-transcribe.js.map