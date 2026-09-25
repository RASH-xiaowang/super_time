/**
 * laya 模型的**落点解析与分发**（纯文件层，不碰推理）。
 *
 * 与 whisper 的分工完全对应（`query/whisper.ts` 是这里的模板）：
 *   · 目录约定：`<数据根>/laya`（whisper 是 `<数据根>/whisper`）
 *   · 下载：**复用 whisper 的流式下载器**（`streamUrlToFile`：Range 续传 + `.part` 原子发布 +
 *     完成后长度校验），不重造一套
 *   · 进度：调方把进度写进 gateway 单例字段，前端 500ms 轮询（与 whisper 同款）
 *
 * **为什么是「两个文件」**：ONNX 计算图只是一半，另一半是 tokenizer——模型按 token 序列工作，
 * 没有 tokenizer 就无法把中文变成输入。两者都**不进安装包**（合计约 1.26 GB），
 * 由用户手动放置或首启下载；下载源用 `DSH_WECHAT_LAYA_MIRROR` / `DSH_WECHAT_LAYA_REPO` 覆盖。
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveWechatDataRoot } from '../dirs.ts'
import { streamUrlToFile } from '../query/whisper.ts'

/** 显式指定模型目录（优先级最高；开发机/测试用）。指向含 `laya-decision.onnx` 的目录。 */
export const LAYA_DIR_ENV = 'DSH_WECHAT_LAYA_DIR'
/** 下载镜像基址（与 whisper 的 `DSH_WECHAT_WHISPER_MIRROR` 同款）。 */
export const LAYA_MIRROR_ENV = 'DSH_WECHAT_LAYA_MIRROR'
/** 下载仓库路径（`<base>/<repo>/resolve/main/<file>`）。 */
export const LAYA_REPO_ENV = 'DSH_WECHAT_LAYA_REPO'

/** 默认下载仓库路径（宿主方把 `tools/laya/export-onnx.py` 的产物与 tokenizer 传到此处）。 */
export const LAYA_DEFAULT_REPO = 'super-time/super-time-models'

/**
 * 推理必需的文件清单。`minBytes` 是**下界**而不是精确大小：同一模型可以有
 * fp32 / fp16 / int8 多种量化产物，卡死精确字节会让量化版全被判为「未安装」；
 * 这里只挡住「截断的半成品」（本机 fp32 产物实测 1228.6 MB）。
 */
export const LAYA_ASSETS: ReadonlyArray<{ file: string; rel: string; minBytes: number; label: string }> = [
  { file: 'laya-decision.onnx', rel: 'laya-decision.onnx', minBytes: 1024 * 1024, label: '决策模型图' },
  // dynamo 导出把权重写成外置数据，onnxruntime 会在**同目录**找它 —— 少这一个文件模型就加载不起来，
  // 所以它和计算图一样是必需项（图只有几 MB，权重才有 1.2 GB）。
  { file: 'laya-decision.onnx.data', rel: 'laya-decision.onnx.data', minBytes: 64 * 1024 * 1024, label: '模型权重' },
  { file: 'tokenizer.json', rel: 'tokenizer/tokenizer.json', minBytes: 1024 * 1024, label: '分词器词表' },
  { file: 'tokenizer_config.json', rel: 'tokenizer/tokenizer_config.json', minBytes: 64, label: '分词器配置' },
]

/** 主模型文件（状态展示用）。 */
export const LAYA_MODEL_FILE = 'laya-decision.onnx'
/** 下载连接超时（1.23 GB 比 whisper 模型大，比它的 20s 略放宽）。 */
const DOWNLOAD_CONNECT_TIMEOUT_MS = 30_000

export interface LayaModelStatus {
  installed: boolean
  /** 模型目录（未安装时也给出「期望路径」，便于 UI 告诉用户放哪）。 */
  dir: string
  /** 模型文件路径。 */
  path: string
  bytes: number
  source: 'configured' | 'env' | 'data-dir'
  /** 缺失/不完整的逐项说明（已安装时为空数组）。 */
  missing: string[]
}

/** `<数据根>/laya`。数据根取 `decryptedDir` 的父目录（与 whisper 的取法一致）。 */
export function layaModelsDir(decryptedDir?: string): string {
  const root = decryptedDir ? dirname(decryptedDir) : resolveWechatDataRoot()
  return join(root, 'laya')
}

/** 解析模型目录，不读盘。 */
export function resolveLayaModelsDir(
  configured?: string,
  decryptedDir?: string,
): { dir: string; source: LayaModelStatus['source'] } {
  const pinned = typeof configured === 'string' ? configured.trim() : ''
  if (pinned) return { dir: pinned, source: 'configured' }
  const env = (process.env[LAYA_DIR_ENV] ?? '').trim()
  if (env) return { dir: env, source: 'env' }
  return { dir: layaModelsDir(decryptedDir), source: 'data-dir' }
}

/** 模型是否可用（三个必需文件都在且过下界）。 */
export function layaModelStatus(configured?: string, decryptedDir?: string): LayaModelStatus {
  const { dir, source } = resolveLayaModelsDir(configured, decryptedDir)
  const missing: string[] = []
  let bytes = 0
  for (const a of LAYA_ASSETS) {
    const p = join(dir, a.rel)
    if (!existsSync(p)) {
      missing.push(`${a.label}（缺 ${a.rel}）`)
      continue
    }
    let size = 0
    try {
      size = statSync(p).size
    } catch (e) {
      missing.push(`${a.label}（读取失败：${(e as Error).message}）`)
      continue
    }
    if (a.rel === LAYA_MODEL_FILE) bytes = size
    if (size < a.minBytes) missing.push(`${a.label}（不完整：${formatBytes(size)}）`)
  }
  return { installed: missing.length === 0, dir, path: join(dir, LAYA_MODEL_FILE), bytes, source, missing }
}

/** tokenizer 目录（`@huggingface/transformers` 从这里加载）。 */
export function layaTokenizerDir(dir: string): string {
  return join(dir, 'tokenizer')
}

/** 人类可读体积。 */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

/** 下载源基址候选（env 钉的 → 国内镜像 → 官方；与 whisper 的轮换顺序一致）。 */
export function layaDownloadBases(): string[] {
  const pinned = (process.env[LAYA_MIRROR_ENV] ?? '').trim().replace(/\/$/, '')
  const bases = pinned ? [pinned] : []
  bases.push('https://hf-mirror.com', 'https://huggingface.co')
  return [...new Set(bases)]
}

/** 下载仓库路径。 */
export function layaDownloadRepo(): string {
  const repo = (process.env[LAYA_REPO_ENV] ?? '').trim()
  return repo || LAYA_DEFAULT_REPO
}

export interface LayaDownloadResult {
  ok: boolean
  /** 已完成的文件（相对路径）。 */
  files?: string[]
  bytes?: number
  error?: string
}

/**
 * 下载缺失的文件到 `dir`（幂等：已存在且大小过下界的文件直接跳过）。
 * 任一文件失败即中止并返回错误；已下好的部分**保留**，重试时天然续传。
 */
export async function layaDownloadModel(
  dir: string,
  onProgress: (received: number, total: number, file: string) => void,
): Promise<LayaDownloadResult> {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    return { ok: false, error: `无法创建模型目录：${(e as Error).message}` }
  }

  const repo = layaDownloadRepo()
  const done: string[] = []
  let total = 0

  for (const asset of LAYA_ASSETS) {
    const target = join(dir, asset.rel)
    if (existsSync(target)) {
      try {
        if (statSync(target).size >= asset.minBytes) { done.push(asset.rel); continue }
      } catch { /* 落到重新下载 */ }
    }
    try {
      mkdirSync(dirname(target), { recursive: true })
    } catch (e) {
      return { ok: false, files: done, bytes: total, error: `无法创建目录：${(e as Error).message}` }
    }

    const tmp = `${target}.part`
    let lastError = '下载失败'
    let ok = false
    for (const base of layaDownloadBases()) {
      const url = `${base}/${repo}/resolve/main/${asset.file}`
      try {
        const bytes = await streamUrlToFile(url, tmp, DOWNLOAD_CONNECT_TIMEOUT_MS,
          (received, t) => onProgress(received, t, asset.rel))
        renameSync(tmp, target)
        total += bytes
        done.push(asset.rel)
        ok = true
        break
      } catch (e) {
        // 刻意不删 .part：下一个镜像 / 用户下一次点击可以从断点续接
        lastError = `${asset.rel} @ ${base}：${(e as Error).message}`
      }
    }
    if (!ok) return { ok: false, files: done, bytes: total, error: lastError }
  }
  return { ok: true, files: done, bytes: total }
}

/**
 * 把「用户自己下好的模型目录」接管进数据目录（避免重复下 1.26 GB）。
 * 同盘用 rename（瞬时），跨盘退化为拷贝。
 */
export function layaAdoptModelDir(sourceDir: string, decryptedDir?: string): LayaModelStatus {
  const target = layaModelsDir(decryptedDir)
  mkdirSync(target, { recursive: true })
  for (const asset of LAYA_ASSETS) {
    const from = join(sourceDir, asset.rel)
    if (!existsSync(from)) continue
    const to = join(target, asset.rel)
    if (resolve(from) === resolve(to)) continue
    mkdirSync(dirname(to), { recursive: true })
    const tmp = `${to}.part`
    try {
      renameSync(from, tmp)
    } catch {
      copyFileSync(from, tmp)
      try { unlinkSync(from) } catch { /* 源文件删不掉不算失败 */ }
    }
    renameSync(tmp, to)
  }
  return layaModelStatus(target, decryptedDir)
}
