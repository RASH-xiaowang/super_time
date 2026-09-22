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
/** `api.ts` 拆出的 8 个域模块（桶按顺序 `export *` 它们）。 */
const DOMAIN_MODULES = ['api-core.ts', 'api-read.ts', 'api-kb.ts', 'api-search.ts', 'api-media.ts', 'api-export-ops.ts', 'api-config.ts', 'api-status.ts']
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

  it('公开面不变：api.ts（转发桶）继续把全部缓存导出放出来', () => {
    // M21 第十二刀把 api.ts 拆成桶 + 8 个域模块之后，「继续转发」这件事的判据变了：
    // 名字的定义/再导出落在某个域模块里，只要桶把那个模块 `export *` 出来，
    // 面板的 `from '../api.ts'` 就照样拿得到。所以这里按**可达性**判：
    // 桶转发了哪些模块 → 那些模块的源码合起来必须含这些名字与两种形态。
    const barrelTargets = [...api.matchAll(/export \* from '\.\/([\w.-]+)'/g)].map((m) => m[1] ?? '')
    expect(barrelTargets.length, 'api.ts 不再是转发桶了 —— 域模块没被转发出去').toBeGreaterThan(5)
    const reachable = barrelTargets.map((f) => read(f)).join('\n')
    for (const name of PUBLIC) {
      expect(reachable, `api.ts 侧拿不到 ${name} —— 40 多个面板的 import 会静默少方法`).toContain(name)
    }
    // 至少要有 import（内部调用用）与 export … from（外部用）两种形态，且必须仍指向 cache.ts
    expect(reachable).toMatch(/import \{[\s\S]*?\} from '\.\/cache\.ts'/)
    expect(reachable).toMatch(/export \{[\s\S]*?\} from '\.\/cache\.ts'/)
    expect(reachable).toMatch(/export \{[^}]*\} from '\.\/media-cache\.ts'/)
  })

  it('8 个域模块都不得反向 import api.ts（否则拆出循环依赖）', () => {
    // 先剥注释：模块头里**必然**会出现 `from './api.ts'` 这句话（它就是在讲这次拆分），
    // 不剥就会把自己的说明文字当成违规（这条断言第一次跑就是这么红的）。
    const noComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')
    for (const name of ['cache.ts', 'media-cache.ts', ...DOMAIN_MODULES]) {
      const src = name === 'cache.ts' ? cache : name === 'media-cache.ts' ? media : read(name)
      expect(noComments(src), `${name} 不应 import api.ts`).not.toMatch(/from '\.\/api\.ts'/)
    }
  })

  it('api.ts 已收缩为转发桶（实现被搬回来就会涨起来）', () => {
    // 这条原来是「api.ts 行数 < 阈值」的启发式（阈值一路从 1950 抬到 2450，因为正常功能增长）。
    // 拆成桶 + 域模块之后，行数上限由 `m21-file-size-ratchet.spec.ts` 统一管（每份 ≤1000 行），
    // 这里只钉「桶就是桶」—— 谁把实现搬回 api.ts，它立刻从 18 行涨上去。
    const lines = api.split(/\r?\n/).length
    expect(lines, `api.ts 现在 ${lines} 行：它应该只是转发桶（实现落在域模块里）`).toBeLessThan(60)
  })
})
