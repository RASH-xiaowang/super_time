/**
 * ClawBot 绑定**四态**的展示映射（单一事实源；2026-10-13 从 `clawbot-settings.tsx` 抽出）。
 *
 * ## 为什么单独成一个文件
 *
 * 设置视图要挂 `<ClawbotInstancesCard>`，而实例卡也要这四个映射 —— 两边互相 import
 * 就成了**值 import 环**（`module-cycle-guard.spec.ts` 对值环零容忍）。
 * 抽到第三处之后依赖是单向的：`settings → status`、`instances → status`、`panel → 两者`。
 *
 * ## 映射只许有一份
 *
 * 组件库的 `StateDot` 没有灰/离线态（见需求基线 §5.4(3) 的映射表），所以四态 → 三态点
 * 与四态 → 配色都必须由这里决定；抄第二份的结果是「加了新状态时一处显示、另一处不显示」，
 * 而这类漂移在界面上极难被发现（本项目已经栽过好几次）。
 *
 * @module panels/clawbot-status
 */
import type { ClawbotBindingSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import css from './clawbot.module.css'

/** 「绑定四态」的中文标签（容器只做视图切换，这里才是展示方）。 */
export const CLAWBOT_STATUS_LABEL: Record<ClawbotBindingSnapshot['binding']['status'], string> = {
  unbound: '未绑定',
  binding: '绑定中',
  bound: '已绑定',
  'unbound-by-user': '已解绑',
}

/** 绑定状态 → `StateDot` 四态（组件没有灰/offline 态，见需求基线 §5.4(3) 的映射表）。 */
export function statusDot(state: ClawbotBindingSnapshot['binding']['status']): 'done' | 'warning' | 'ongoing' | 'error' {
  if (state === 'bound') return 'done'
  if (state === 'binding') return 'warning'
  if (state === 'unbound-by-user') return 'error'
  return 'ongoing'
}

/** 绑定状态 → 状态文字配色（显式映射，不走动态类名查询）。 */
export function statusClass(state: ClawbotBindingSnapshot['binding']['status']): string | undefined {
  if (state === 'bound') return css.stBound
  if (state === 'binding') return css.stBinding
  if (state === 'unbound-by-user') return css.stUnboundByUser
  return css.stUnbound
}
