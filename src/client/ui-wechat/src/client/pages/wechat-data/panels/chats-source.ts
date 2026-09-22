/**
 * Chats 面板的**全部源码**：`Chats.tsx` + 它的拆分模块（`chats-*.tsx`）。
 *
 * M21 把 Chats.tsx 拆成「面板 + 三个顶层件模块 + 渲染树」之后，源码级守卫
 * （取原图接线、虚拟化接线、推荐回复入口…）一律读这份联合：断言问的是「会话这一块功能」，
 * 不该关心那段代码住在哪个文件里。前缀扫描用 readdir（下次再拆一刀不必回来补名字）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export function readChatsSource(): string {
  const mods = readdirSync(HERE).filter((f) => /^chats-[a-z-]+\.tsx$/.test(f)).sort()
  return ['Chats.tsx', ...mods].map((f) => readFileSync(join(HERE, f), 'utf8')).join('\n')
}
