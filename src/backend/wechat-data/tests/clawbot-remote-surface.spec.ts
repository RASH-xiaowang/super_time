/**
 * ClawBot 方法面守卫：十二个 `@Remote` 逐名在册、两个内部方法**不许**进方法面。
 *
 * 与 `gateway-remote-surface.spec.ts`（全量枚举）互补：那一条守「一个不多一个不少」，
 * 这一条守「ClawBot 这八个确实存在、且内部方法（bindClawbotWechat / ensureClawbotChannel）
 * 没有被顺手加上装饰器」—— 内部方法一旦上了 `@Remote`，就会进 `docs/API.md` 与前端
 * 镜像的对账面，而它们的调用方（确认收尾 / 网关启动钩子）在 worker 内直调。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gatewayClassSource, GW_DIR } from '../../tests/gateway-source.ts'

const ROOT = join(GW_DIR, '..', '..', '..', '..')

/** 十二个对外方法（顺序与外层壳一致）：**实例管理四个 + 绑定与会话八个**（多实例，2026-10-13）。 */
const CLAWBOT_REMOTES = [
  'listClawbotInstances',
  'createClawbotInstance',
  'deleteClawbotInstance',
  'setClawbotInstanceConfig',
  'getClawbotBinding',
  'createClawbotBindQr',
  'getClawbotBindState',
  'unbindClawbot',
  'listClawbotMessages',
  'checkClawbotEnv',
  'sendClawbotMessage',
  'getClawbotMedia',
] as const

/** 两个内部函数：只由 worker 内直调（确认收尾 / 启动钩子），不得进方法面。 */
const CLAWBOT_INTERNALS = ['bindClawbotWechat', 'ensureClawbotChannel'] as const

describe('ClawBot 方法面', () => {
  const src = gatewayClassSource()

  it('十二个 @Remote 逐名存在（少一个界面就有一个按钮打了没反应）', () => {
    for (const name of CLAWBOT_REMOTES) {
      expect(src, `缺 @Remote('${name}')`).toContain(`@Remote('${name}')`)
    }
  })

  it('内部函数没有被顺手加上 @Remote（进了方法面就要进文档与前端镜像）', () => {
    for (const name of CLAWBOT_INTERNALS) {
      expect(src, `内部函数 ${name} 不该出现在方法面`).not.toContain(`@Remote('${name}')`)
    }
    // 但它们确实实现于 remotes/clawbot.ts（不是被删掉了，只是没暴露）
    const remotes = readFileSync(join(GW_DIR, 'remotes', 'clawbot.ts'), 'utf8')
    for (const name of CLAWBOT_INTERNALS) {
      expect(remotes, `remotes/clawbot.ts 里找不到 ${name}（内部函数被误删？）`).toContain(name)
    }
  })

  it('docs/API.md 收录了这十二个（docs:api 重生成后仍缺 ⇒ 文档漂移）', () => {
    const api = readFileSync(join(ROOT, 'docs', 'API.md'), 'utf8')
    for (const name of CLAWBOT_REMOTES) {
      expect(api, `docs/API.md 没有 ${name}`).toContain(`\`${name}\``)
    }
  })

  it('启动钩子接线：core 里调用、本层覆写并真的拉起通道（收消息不靠界面提醒）', () => {
    expect(src, 'core 构造器没有调用 bootClawbotChannel（钩子成了摆设）').toContain('this.bootClawbotChannel()')
    expect(src, '本层没有覆写 bootClawbotChannel').toContain('override bootClawbotChannel')
    expect(src, '启动钩子没接上 ensureClawbotChannel —— 绑定过的用户进程重启后不会收消息').toContain('ensureClawbotChannel()')
  })
})
