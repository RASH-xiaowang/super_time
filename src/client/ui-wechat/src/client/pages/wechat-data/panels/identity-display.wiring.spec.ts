/**
 * Identity surfaces must reuse the real username for their avatar.
 *
 * These guards cover the places that previously rendered only a display name:
 * group owners, shared groups, graph self nodes, payment senders, merged-chat
 * previews, quote previews and task-trigger images.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classBlock, readStripped } from '../../../test-helpers/wiring-kit.ts'

const PANELS = import.meta.dirname
const read = (file: string): string => readStripped(join(PANELS, file))

const CARDS = read('chats-cards.tsx')
const GROUP = read('chats-group-info-view.tsx')
const PORTRAITS = read('CustomerPortraitView.tsx')
const GRAPH = read('Graph.tsx')
const GRAPH_MENU = read('GraphNodeContextMenu.tsx')
const GRAPH_MENU_CONTROLLER = read('GraphNodeMenuController.tsx')
const TASK_RECORD = read('task-center-record-modal.tsx')
const MOMENTS_SCOPE = read('moments-scope.ts')
const QUOTE_LAYOUT = read('chats-rows.module.css')
const TASK_LAYOUT = read('task-center.module.css')

describe('群名与用户名的头像接线', () => {
  it('群信息里的群主用 owner username，而不是拿展示名猜头像', () => {
    expect(GROUP).toContain('<IdentityName name={name} username={owner} size={22}>')
    expect(GROUP).toContain('value={ownerValue(groupInfo)}')
  })

  it('客户画像的共同群 chip 使用群 username，并保留人数作为独立尾部', () => {
    expect(PORTRAITS).toContain('name={group.name || group.username}')
    expect(PORTRAITS).toContain('username={group.username}')
    expect(PORTRAITS).toContain('<small>{group.memberCount} 人</small>')
  })

  it('知识图谱的“我”从会话自身身份取头像，搜索与右键菜单走同一口径', () => {
    expect(GRAPH).toContain("username={hit.kind === 'self' ? selfUsername : hit.id}")
    expect(GRAPH).toContain("selfUsername={data?.self ?? ''}")
    expect(GRAPH_MENU).toContain("target.node.kind === 'self' ? selfUsername : target.node.id")
    expect(GRAPH_MENU_CONTROLLER).toContain("selfUsername={p.selfUsername ?? ''}")
  })

  it('卡片不再渲染内部支付状态，合并转发预览仍只使用真实 username', () => {
    expect(CARDS).not.toContain('PayStatusLine')
    expect(CARDS).toContain('username={record.sourceUsername ?? \'\'}')
    expect(CARDS).toContain('function ChatlogPreview')
  })

  it('引用条使用 referUsername；昵称限宽，头像不挤掉两行摘要', () => {
    expect(CARDS).toContain("const refUsername = rich.referUsername?.trim() ?? ''")
    expect(CARDS).toContain('username={refUsername}')
    expect(CARDS).toContain('<IdentityName className={cssrows.msgQuoteWho}')
    const who = classBlock(QUOTE_LAYOUT, 'msgQuoteWho')
    expect(who).toContain('flex: 0 1 auto')
    expect(who).toContain('max-width: 42%')
    expect(who).toContain('min-width: 0')
  })

  it('任务触发图片的发送者条使用 senderUsername，图片本体不被头像覆盖', () => {
    expect(TASK_RECORD).toContain("username={img.senderUsername?.trim() ?? ''}")
    expect(TASK_RECORD).toContain('<figure')
    expect(TASK_RECORD).toContain('className={css.imageSender}')
    const item = classBlock(TASK_LAYOUT, 'imageItem')
    const sender = classBlock(TASK_LAYOUT, 'imageSender')
    expect(item).toContain('flex-direction: column')
    expect(item).toContain('min-width: 0')
    expect(sender).toContain('border-top: 1px solid var(--nm-border)')
  })

  it('朋友圈作者缺少 username 时只跳过头像映射，不让整页渲染失败', () => {
    expect(MOMENTS_SCOPE).toContain('author.username?.trim() ?? \'\'')
    expect(MOMENTS_SCOPE).toContain('moment.username?.trim() ?? \'\'')
  })

})
