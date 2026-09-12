import type { WhisperModelInfo } from '../types.ts';
/** Whisper model catalog (id/name/size labels). */
export declare const WHISPER_MODELS: ReadonlyArray<Pick<WhisperModelInfo, 'id' | 'name' | 'sizeLabel'>>;
/** ggml model file per model id (whisper.cpp official release artifacts). */
export declare const WHISPER_DOWNLOAD_FILES: ReadonlyArray<[string, string]>;
/**
 * Migrate downloaded models (ggml-*.bin), the engine install (bin/), and any
 * top-level engine files (whisper-cli.exe / whisper.exe + sibling engine DLLs)
 * from one models dir to another (best-effort, keeps existing targets).
 * @param fromDir - old models dir.
 * @param toDir - new models dir (created when missing).
 * @returns ok + moved count, or an error description.
 */
export declare function migrateWhisperModels(fromDir: string, toDir: string): {
    ok: boolean;
    moved: number;
    error?: string;
};
/**
 * Move the engine install directory (the folder holding `binPath`, when it
 * sits under `fromDir`) to the mirrored location under `toDir` and return the
 * relocated binary path; '' when binPath is outside fromDir (external engine:
 * left untouched). The move is best-effort — the returned path is the correct
 * destination either way.
 */
export declare function migrateWhisperEngineDir(binPath: string, fromDir: string, toDir: string): string;
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
export declare function whisperEnginePath(configBin?: string, modelsDir?: string): string;
/**
 * CUDA device presence (nvidia-smi replies with a device list). Process-level
 * memo: driver presence cannot change while the host runs, so probe once and
 * reuse for an hour (the nvidia-smi subprocess is otherwise spawned on every
 * settings-panel status poll).
 * @returns true when an NVIDIA CUDA device/driver is available.
 */
export declare function whisperHasCuda(): boolean;
/**
 * Scan a models dir for installed ggml binaries.
 * @param modelsDir - directory searched for `ggml-<id>[.*].bin`.
 * @returns per-model installed flags + the catalog.
 */
export declare function whisperModelsStatus(modelsDir: string): WhisperModelInfo[];
/** Default models dir under the DSH-owned wechat data root. */
export declare function defaultWhisperModelsDir(decryptedDir: string): string;
/**
 * Download and install the whisper.cpp CLI engine into
 * `<modelsDir>/bin/whisper-cli.exe` (official release zip, streamed).
 * @param modelsDir - models cache dir.
 * @param onProgress - progress callback (bytes, total).
 * @returns ok + binary path, or an error description.
 */
export declare function installWhisperEngine(modelsDir: string, onProgress: (received: number, total: number) => void): Promise<{
    ok: boolean;
    path?: string;
    error?: string;
}>;
/**
 * Stream one official ggml model file into the models dir (atomic .part →
 * rename), reporting received/total bytes.
 * @param modelId - model id from the catalog.
 * @param modelsDir - target models dir (created when missing).
 * @param onProgress - per-chunk progress callback (bytes, total bytes).
 * @returns ok + file/bytes, or an error description.
 */
export declare function whisperDownloadModel(modelId: string, modelsDir: string, onProgress: (received: number, total: number) => void): Promise<{
    ok: boolean;
    file?: string;
    bytes?: number;
    error?: string;
}>;
//# sourceMappingURL=whisper.d.ts.map