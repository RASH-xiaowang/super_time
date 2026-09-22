/**
 * 设置面板的**全部源码**：`Settings.tsx` + 它的拆分模块（`settings-*.tsx?`）。
 *
 * M21 把 Settings.tsx 拆成「面板 + settings-state 钩子 + 五张卡片 + 共用件 + 授权/更新两块」之后，
 * 源码级守卫（「有没有接 useConfirm」「轮询有没有登记」「节 key 存不存在」「富提示时长」…）
 * 一律读这份联合：断言问的是「设置这一块功能」，不该关心那段代码住在哪个文件里。
 * 前缀扫描**不区分大小写**（`Settings.tsx` → `settings-state.tsx`），并且用 readdir 而不是手写清单 ——
 * 下次再拆一刀不必回来补名字（手写清单在前两刀各红过一次）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export function readSettingsSource(): string {
  const mods = readdirSync(HERE).filter((f) => /^settings-[a-z-]+\.tsx?$/.test(f)).sort()
  return ['Settings.tsx', ...mods].map((f) => readFileSync(join(HERE, f), 'utf8')).join('\n')
}
