/**
 * Chats 面板的**全部源码**：`Chats.tsx` + 它的拆分模块（`chats-*.tsx` 与 `chats-*.ts`）。
 *
 * M21 把 Chats.tsx 拆成「面板 + 三个顶层件模块 + 渲染树」之后，源码级守卫
 * （取原图接线、虚拟化接线、推荐回复入口…）一律读这份联合：断言问的是「会话这一块功能」，
 * 不该关心那段代码住在哪个文件里。前缀扫描用 readdir（下次再拆一刀不必回来补名字）。
 *
 * `.ts` 也要收进来（#19 拆出的 `chats-polling.ts` 差点漏掉）：只扫 `.tsx` 的话，
 * 一次搬家就会让读这份联合的守卫**静默失去靶子** —— `sessions-list-refresh.wiring.spec.ts`
 * 是靠「找不到 onUpdated」当场报出来的，那条哨兵救了这个口径。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * 被扫的那一侧目录（P3-16 之后本助手住在 `src/client/test-helpers/`，
 * 而它要联合的是 **面板目录** —— 目录必须写死在这里，不能再用「我自己所在的目录」：
 * 用 HERE 的话搬家之后扫到的是 test-helpers/，联合源码会静默变成只剩 `Chats.tsx`
 * 一支都读不到 ⇒ 所有读这份联合的守卫集体失去靶子。
 */
const PANELS = join(HERE, '..', 'pages', 'wechat-data', 'panels')

export function readChatsSource(): string {
  const here = PANELS
  const mods = readdirSync(here)
    .filter((f) => /^chats-[a-z-]+\.(tsx|ts)$/.test(f))
    .sort()
  return ['Chats.tsx', ...mods].map((f) => readFileSync(join(here, f), 'utf8')).join('\n')
}
