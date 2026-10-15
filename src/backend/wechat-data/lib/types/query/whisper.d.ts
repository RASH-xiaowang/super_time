import type { WhisperModelInfo } from '../types.ts';
/** Whisper model catalog (id/name/size labels). */
export declare const WHISPER_MODELS: ReadonlyArray<Pick<WhisperModelInfo, 'id' | 'name' | 'sizeLabel'>>;
/** ggml model file per model id (whisper.cpp official release artifacts). */
export declare const WHISPER_DOWNLOAD_FILES: ReadonlyArray<[string, string]>;
/**
 * W3-5.5：引擎包的**固定发布 tag**（不用 `latest`）。
 *
 * 环境变量 `DSH_WECHAT_WHISPER_ENGINE_TAG` 可覆盖；空值时回落到
 * `latest`（旧行为，保护已经配好镜像的环境）。
 * 这里是一个字符串常量而不是编号——— 固定哪一版
 * 应该是一行改动，而不是到处翻 URL。
 */
export declare const WHISPER_ENGINE_TAG: string;
/**
 * 把一个 URL 流式写进 `dest`，**支持断点续传**：以 `dest` 现有长度为起点发 `Range`。
 *
 * 为什么要续传：模型有 1.5–3.1 GB，一次连接中断就让整份重下；而重试层只管到「响应头」，
 * 中途断流它看不见（这正是 M7 的 N13 遗留项里那半句「另加断点续传」）。
 * 三处刻意取舍：
 *   · 只有服务端明确回 **206** 才追加写；回 200 说明 Range 没生效，必须从头写
 *     （否则文件前段是旧内容，拼出来的包是坏的）；
 *   · 续传起点取自 `statSync(dest).size` 而**不是**我们数过的字节数 —— 写缓冲可能被丢掉，
 *     按磁盘实际长度续传永远是对的（大不了重下一小段）；
 *   · 完成后校验长度：流提前 end（不算错误）时旧实现会把**截断的文件** rename 成正式模型。
 * @param url - 下载地址。
 * @param dest - 目标文件（同一个路径会被复用/续传）。
 * @param timeoutMs - 单次尝试的**连接**超时（拿到响应头即解除）。
 * @param onProgress - 进度回调（received 含续传已有的部分；total 未知时为 0）。
 * @returns 最终字节数（含续传部分）。
 */
export declare function streamUrlToFile(url: string, dest: string, timeoutMs: number, onProgress: (received: number, total: number) => void, 
/** W3-5.5：取消信号（每个 chunk 检查一次）。 */
signal?: AbortSignal): Promise<number>;
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
/** 随包分发的 whisper 资产目录（安装目录，只读）：引擎 `bin/` 与预置 `ggml-*.bin`。 */
export declare function bundledWhisperAssetsDir(): string;
/**
 * 「这个目录能不能当**可写**的模型目录」（P2-6 那把尺子在 whisper 上的分册）。返回 null = 可以写。
 *
 * 为什么要单独一格：{@link defaultWhisperModelsDir} 在数据根下那个可写目录还没建好
 * （或镜像失败）时**会退回随包资产目录**。退回本身是对的 —— 读预置的 tiny 模型不需要写权限；
 * 错的是把这份「只读兜底」再交给写入侧：`installWhisperEngine` / `whisperDownloadModel`
 * 原本直接 `mkdirSync` + 落文件，装到 Program Files 时报的是 EACCES/ENOENT 这类看不懂的错，
 * 开发态那个目录就是仓库里的 `src/wechat/whisper` —— 一次模型下载能往仓库写进 1.5 GB。
 * 所以三个写入入口（引擎安装、模型下载、旧目录迁移）一律先问这一格，理由说人话。
 * @param modelsDir - 准备写入的目录。
 * @param bundled - 随包资产目录（默认取真实那份；单测给一个临时目录当替身）。
 * @returns 拒绝理由，或 null。
 */
export declare function whisperWriteRefusal(modelsDir: string, bundled?: string): string | null;
/**
 * 默认模型/引擎目录：**数据根下的可写目录**（`<数据根>/whisper`），首次使用时把随包
 * 分发的引擎与模型镜像进来。
 *
 * 早先这里指向项目/安装目录的 `wechat/whisper`，于是「安装目录只读」形同虚设 ——
 * 下载一个新模型就会往安装位置写文件（装到 Program Files 时直接失败）。
 * 镜像失败（userData 不可写等）时退回随包资产目录，至少让预置的 tiny 模型仍可用。
 * @param decryptedDir - 解密库目录（其父目录即数据根）。
 */
export declare function defaultWhisperModelsDir(decryptedDir?: string): string;
/**
 * 从配置解析出**可写**的模型目录。
 *
 * 配置里若钉的是随包分发的只读资产目录（或任何仍落在 `app.asar` 里的路径），
 * 一律当作「未配置」重新解析 —— 否则装上带此改动的新版本后，旧配置会继续把
 * 模型往安装目录里写（装到 Program Files 时失败，且把本机路径留在安装目录）。
 * @param configured - config.json 里的 whisper_models_dir。
 * @param decryptedDir - 解密库目录（其父目录即数据根）。
 */
export declare function resolveWhisperModelsDir(configured: string | undefined, decryptedDir?: string): string;
/**
 * Download and install the whisper.cpp CLI engine into
 * `<modelsDir>/bin/whisper-cli.exe` (official release zip, streamed).
 * @param modelsDir - models cache dir.
 * @param onProgress - progress callback (bytes, total).
 * @returns ok + binary path, or an error description.
 */
export declare function installWhisperEngine(modelsDir: string, onProgress: (received: number, total: number) => void, 
/** W3-5.5：取消信号（每个 chunk 检查一次）。 */
signal?: AbortSignal): Promise<{
    ok: boolean;
    path?: string;
    error?: string;
}>;
/**
 * PowerShell 的单引号字面量：唯一规则是把内部的 `'` 翻倍（口径与 vendored
 * `dsh-native-command` 里的同名 helper 一致）。
 *
 * 为什么需要它：`-Command` 拿到的是**一整段脚本文本**，不是 argv —— 路径里一个撇号
 * （真实用户名就有，如 `C:\Users\O'Brien\…`）就会提前终结那个字面量，后面的内容变成
 * **要执行的代码**。`tar.exe` 那一路走的是参数数组，不过 shell，所以没有这个问题；
 * 只有拼字符串的这一路需要转义（审计 P3-11）。
 */
export declare function powershellLiteral(value: string): string;
/** Zip extraction is a small local operation; still bounded so a broken tool cannot pin the worker. */
export declare const ZIP_EXTRACT_TIMEOUT_MS = 120000;
/**
 * 解压 zip 到暂存目录（顶层目录名忽略）。导出只为让"拼出来的那条命令"能被用例钉住。
 * @param zipPath - 待解压的 zip 路径。
 * @param destDir - 目标根目录。
 * @returns 暂存目录（真正的内容在其下一层）。
 */
export declare function extractZip(zipPath: string, destDir: string): Promise<string>;
/**
 * Stream one official ggml model file into the models dir (atomic .part →
 * rename), reporting received/total bytes.
 * @param modelId - model id from the catalog.
 * @param modelsDir - target models dir (created when missing).
 * @param onProgress - per-chunk progress callback (bytes, total bytes).
 * @returns ok + file/bytes, or an error description.
 */
export declare function whisperDownloadModel(modelId: string, modelsDir: string, onProgress: (received: number, total: number) => void, 
/** W3-5.5：取消信号；已取消时抛带 `WHISPER_DOWNLOAD_CANCELED` 的错误。 */
signal?: AbortSignal): Promise<{
    ok: boolean;
    file?: string;
    bytes?: number;
    error?: string;
}>;
