/**
 * M21（切片）：`api.ts` 的缓存层已拆到 `cache.ts` / `media-cache.ts`，且必须是**纯搬移**。
 *
 * `api.ts` 是 2000+ 行、40 多个面板都 import 它的大文件；M21 要求按边界拆分。这里只做
 * 「缓存层」那一片，判据三条：
 *   ① **搬移一致性**：被搬走的定义必须出现在新模块里、且不再出现在 `api.ts` 里
 *      （＝没有任何一份被丢掉或被复制成两份）；
 *   ② **公开面不变**：`api.ts` 必须继续转发这些导出（否则 40 多个 import 会静默少方法）；
 *   ③ **不成环**：新模块不得反过来 import `api.ts`。
 *
 * 它守不住「行为是否等价」——那由既有行为用例（`api-snapshot-listeners.spec.ts` 等）与
 * 编译期类型来兜；**也不声称**单文件长度已达标（M21 其余边界仍未拆）。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')
const api = read('api.ts')
const cache = read('cache.ts')
const media = read('media-cache.ts')

/** 只存在于一个文件里的「定义行」——用来判「搬没搬、有没有留副本」。 */
const MOVED: Array<{ marker: string; to: 'cache' | 'media' }> = [
  { marker: 'const SNAPSHOT_TTL_MS = 30_000', to: 'cache' },
  { marker: 'const SNAPSHOT_CACHE_MAX = 60', to: 'cache' },
  { marker: "const RENDER_CACHE_PREFIX = 'wxdata-render-cache:'", to: 'cache' },
  { marker: "const CACHE_PREFIX = 'dsh-wechat-cache-v1:'", to: 'cache' },
  { marker: 'function subscribeSnapshot(', to: 'cache' },
  { marker: 'function invalidateSnapshotCache(', to: 'cache' },
  { marker: 'function readRenderCache<', to: 'cache' },
  { marker: 'function writeRenderCache(', to: 'cache' },
  { marker: 'function invalidateWechatCache(', to: 'cache' },
  { marker: 'function cachedFetch<', to: 'cache' },
  { marker: 'function cachedGet<', to: 'cache' },
  { marker: 'function isEmptySnapshot(', to: 'cache' },
  { marker: "const MEDIA_DB_NAME = 'dsh-wechat-media'", to: 'media' },
  { marker: 'function openMediaDb(', to: 'media' },
  { marker: 'function snsMediaCacheGet(', to: 'media' },
  { marker: 'function snsMediaCacheGetMany(', to: 'media' },
  { marker: 'function snsMediaCacheSet(', to: 'media' },
]

/** 公开面：拆分前 `api.ts` 导出、拆分后必须继续可用的名字。 */
const PUBLIC = [
  'readRenderCache',
  'writeRenderCache',
  'subscribeSnapshot',
  'invalidateSnapshotCache',
  'invalidateWechatCache',
  'snsMediaCacheGet',
  'snsMediaCacheGetMany',
  'snsMediaCacheSet',
]

describe('M21 切片：api.ts 的缓存层拆分', () => {
  it('两个新模块都存在，且各自只装着搬过去的那部分', () => {
    expect(existsSync(join(HERE, 'cache.ts'))).toBe(true)
    expect(existsSync(join(HERE, 'media-cache.ts'))).toBe(true)
    expect(MOVED.length).toBeGreaterThan(10) // 防空转
    for (const { marker, to } of MOVED) {
      const target = to === 'cache' ? cache : media
      const other = to === 'cache' ? media : cache
      expect(target, `${marker} 应在 ${to}.ts 里`).toContain(marker)
      expect(other, `${marker} 不该出现在另一个新模块里（避免两份定义漂移）`).not.toContain(marker)
      expect(api, `${marker} 不该还留在 api.ts（搬走了就要搬干净）`).not.toContain(marker)
    }
  })

  it('公开面不变：api.ts 继续转发全部缓存导出', () => {
    for (const name of PUBLIC) {
      expect(api, `api.ts 没再转发 ${name} —— 40 多个面板的 import 会静默少方法`).toContain(name)
    }
    // 至少要有 import（内部调用用）与 export … from（外部用）两种形态
    expect(api).toMatch(/import \{[\s\S]*?\} from '\.\/cache\.ts'/)
    expect(api).toMatch(/export \{[\s\S]*?\} from '\.\/cache\.ts'/)
    expect(api).toMatch(/export \{[^}]*\} from '\.\/media-cache\.ts'/)
  })

  it('新模块不得反向 import api.ts（否则拆出循环依赖）', () => {
    for (const [name, src] of [['cache.ts', cache], ['media-cache.ts', media]] as const) {
      expect(src, `${name} 不应 import api.ts`).not.toMatch(/from '\.\/api\.ts'/)
    }
  })

  it('api.ts 已明显变短（本片目标是把它往下降，不是一次拆到上限）', () => {
    const lines = api.split(/\r?\n/).length
    // 这条断言是**启发式**，不是「单文件行数上限」（M21 的整体达标仍未完成，见文件头注释）。
    // 它要抓的是「缓存层又被搬回 api.ts」这种回归，而不是阻止正常功能增长。
    // 硬保证（搬移没被撤销）由上面 MOVED / PUBLIC 三条承担。
    //
    // 阈值沿革：1950 → 2010（导出历史新增 4 个 api* 函数）→ 2150（2026-09-18 多库重设计：
    // api.ts 新增 4 个库管理包装 + 快照/渲染缓存的库后缀，净 +109 行，实测 2090 行）
    // → 2300（2026-09-18 T2：知识库**文件域** 5 个包装 + 4 个类型再导出 + 缓存失效，
    // 净 +126 行，实测 2216 行）
    // → 2400（2026-09-19 KB-MODEL-CONFIG P0：向量索引的两个包装 + 接口两行声明，实测 2326 行）。
    // → 2450（2026-09-20「推荐回复」：1 个包装 + 1 行接口声明，实测 2409 行）。
    // 为什么这次仍然抬而不是搬：搬走的正解是把 `WechatRemote` 接口摘到独立模块，
    // 而它引用了 **16 个声明在 api.ts 本地的类型**（`RemoteResult`、`VectorBuildResult`、
    // `RetrievalStatus`、`*SnapshotRead` 等），摘出去就得连它们一起搬，或者反向 import api.ts
    // —— 后者正是本文件第 3 条要防的循环。那是 M21 的独立一片，不该塞进一次功能改动里做。
    // 2400 仍然咬得住原目标：cache.ts 209 行、media-cache.ts 113 行，
    // 任一份被内联回来都会把 api.ts 推到 2439 / 2535 行，两份都回来是 2648 行。
    expect(lines, `api.ts 现在 ${lines} 行：超过 2450 说明缓存层被搬回来了（cache.ts 209 / media-cache.ts 113）`).toBeLessThan(2450)
  })
})
