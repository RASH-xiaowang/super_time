/**
 * `deps-provenance.mjs` 的类型面（H11 口径：给宿主脚本补声明，而不是在调用处写 `any`）。
 *
 * 为什么必须有：`src/backend/tests/deps-provenance.spec.ts` 直接 import 这个脚本做复算 ——
 * 没有声明文件的话要么报 TS7016，要么只能 `@ts-expect-error` 咽掉，
 * 而咽掉就等于**把溯源表的契约从类型系统里删掉**（表结构一改，用例照样编译过、判据却已经失效）。
 * 形状与 `deps-provenance.mjs` 的 JSDoc 逐条对齐。
 */

/** 一行依赖记录：`in-repo` = 本仓自己的包（不指纹），`vendored` = 从上游拷进来的。 */
export interface ProvenanceRow {
  kind: 'in-repo' | 'vendored'
  /** 相对仓库根的包目录（`package.json` 里 `file:` 指的那条）。 */
  path: string
  /** package.json 里写的原始 spec（`file:src/backend/deps/...`）。 */
  declared: string
  version: string | null
  repository: string | null
  /** 整棵目录的内容指纹（只有 vendored 才有）。 */
  treeSha256?: string
  files?: number
  bytes?: number
  /** 以下都是**人手维护**的字段，`--write` 必须原样带过去。 */
  upstream?: string
  upstreamCommit?: string
  importedAt?: string
  upstreamWorkspace?: string
  note?: string
}

export interface ProvenanceTable {
  schema: number
  generatedBy: string
  packages: Record<string, ProvenanceRow>
}

export interface FileDep {
  name: string
  spec: string
  field: 'dependencies' | 'optionalDependencies' | 'devDependencies'
}

/** 递归列文件：跳过 `node_modules`/`.git`/`*.tsbuildinfo`，返回排序后的相对路径（正斜杠）。 */
export function listFiles(dir: string): string[]

/** 一棵目录的内容指纹（与 mtime 无关：路径 + 内容 sha256 逐行拼接再整体 sha256）。 */
export function treeDigest(dir: string): { treeSha256: string, files: number, bytes: number }

/** package.json 三个字段里所有 `file:` 依赖。 */
export function fileDependencies(pkg: object): FileDep[]

/** 从 package.json + 磁盘现状生成整张表；`previous` 用于保留人写字段。 */
export function buildTable(opts?: { previous?: Record<string, ProvenanceRow> | null }): ProvenanceTable

/** 表与现状的差异（四类都是「表不再可信」的不同形状）。 */
export function diffTables(
  previous: Record<string, ProvenanceRow>,
  current: Record<string, ProvenanceRow>,
): { missing: string[], extra: string[], changed: string[], absent: string[] }

/** 读现有表；文件不存在或解析失败返回 `null`（让调用方区分「没有表」与「空表」）。 */
export function readTable(tablePath?: string): Record<string, ProvenanceRow> | null

/** 表的默认位置（`--table` 可以覆盖它，守卫用例就靠这个把 `--check` 指到临时表上）。 */
export const TABLE_PATH: string
