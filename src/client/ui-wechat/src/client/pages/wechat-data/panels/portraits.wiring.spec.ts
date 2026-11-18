/**
 * 客户画像与标签的装配守卫。
 *
 * 这个功能横跨导航、主页面、共享抽屉和两个聊天侧入口。任何一处漏接都可能表现为
 * “页面能看，但聊天里找不到”或“标签有结论却没有证据”，所以把关键接线与信息层级
 * 一起钉在源码上。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStripped, sliceBetween } from '../../../test-helpers/wiring-kit.ts'

const DATA = join(import.meta.dirname, '..')
const PANELS = import.meta.dirname
const NAV = readStripped(join(DATA, 'nav-config.ts'))
const LOADERS = readStripped(join(DATA, 'panel-loaders.tsx'))
const SHELL = readStripped(join(DATA, 'WechatDataPanel.tsx'))
const MOBILE = readStripped(join(DATA, 'ui', 'mobile-nav.tsx'))
const PAGE = readStripped(join(PANELS, 'Portraits.tsx'))
const VIEW = readStripped(join(PANELS, 'CustomerPortraitView.tsx'))
const DIALOG = readStripped(join(PANELS, 'CustomerPortraitDialog.tsx'))
const SINGLE = readStripped(join(PANELS, 'chats-contact-info-view.tsx'))
const GROUP = readStripped(join(PANELS, 'chats-group-info-view.tsx'))
const HOOK = readStripped(join(PANELS, 'use-customer-360.ts'))
const CSS = readStripped(join(PANELS, 'portraits.module.css'))

describe('客户画像与标签：导航与主页面', () => {
  it('导航项放在「关系与社交」组，并保持可见', () => {
    const group = sliceBetween(NAV, "label: '关系与社交'", "label: '资产与资金'", '关系与社交分组')
    expect(group).toContain("tab: 'portraits'")
    expect(group).toContain("label: '客户画像与标签'")
    expect(group).not.toMatch(/tab: 'portraits'[^}]*hidden: true/)
  })

  it('懒加载、renderTab 和手机白名单三条路径都存在', () => {
    expect(LOADERS).toContain("export const PortraitsPanel = lazy(() => import('./panels/Portraits.tsx')")
    const render = sliceBetween(SHELL, 'function renderTab(', '\nconst DIALOG_SECTION_OF:', 'renderTab')
    expect(render).toContain("case 'portraits': return <PortraitsPanel onOpenChat={onOpenChat} />")
    expect(MOBILE).toContain("'portraits'")
    const keepAt = MOBILE.indexOf('const PHONE_KEEP')
    expect(keepAt, '找不到手机白名单').toBeGreaterThan(-1)
    const keep = MOBILE.slice(keepAt, keepAt + 360)
    expect(keep).toContain("'portraits'")
  })

  it('目录一次读取三个真实分类并合并，360 只对当前选中客户按需加载', () => {
    expect(PAGE).toContain('apiGetContacts({ categories: [...CUSTOMER_CATEGORY_KEYS] })')
    expect(PAGE).toContain('mergeCustomerCandidates([env.contacts])')
    expect(PAGE).toContain('useCustomer360(selected?.username ?? null)')
    expect(PAGE, '目录不能逐行请求 getContact360').not.toContain('filtered.map((customer) => apiGetContact360')
  })

  it('页面至少明确包含客户画像、客户标签两个板块', () => {
    expect(VIEW).toContain('>客户画像</h3>')
    expect(VIEW).toContain('>客户标签</h3>')
    expect(VIEW).toContain('selected.evidence')
    expect(VIEW).toContain('本机规则自动生成')
  })

  it('目录行和画像主头像都使用联系人真实头像地址，而不是只显示首字占位', () => {
    expect(PAGE).toContain('avatarUrl={customer.avatarUrl}')
    expect(VIEW).toContain('avatarUrl={identity.avatarUrl}')
  })

  it('不把无数据支撑的商业结论伪装成画像', () => {
    for (const phrase of ['高意向', '高价值', '购买力强', '消费能力强']) {
      expect(VIEW).not.toContain(phrase)
    }
  })
})

describe('聊天会话中的画像入口', () => {
  it('单聊「聊天信息」抽屉提供入口，并复用同一个画像抽屉', () => {
    expect(SINGLE).toContain('客户画像与标签')
    expect(SINGLE).toContain('<CustomerPortraitDialog')
    expect(SINGLE).toContain("context={{ source: 'session' }}")
    const entryAt = SINGLE.indexOf('data-st-portrait-entry')
    const loadingAt = SINGLE.indexOf('{loading &&')
    expect(entryAt, '单聊画像入口没渲染').toBeGreaterThan(-1)
    expect(entryAt, '画像入口必须在加载/错误分支之外，统计失败时仍可打开').toBeLessThan(loadingAt)
  })

  it('群成员卡点击打开完整画像，群主与本人上下文随成员传入', () => {
    expect(GROUP).toContain('<CustomerPortraitDialog')
    expect(GROUP).toContain('setPortraitMember(m)')
    expect(GROUP).toContain("source: 'group-member'")
    expect(GROUP).toContain('isGroupOwner: portraitMember !== null && groupInfo?.owner === portraitMember.username')
    expect(GROUP).toContain('isSelf: portraitMember?.isSelf === true')
    expect(GROUP, '轻量悬浮资料卡应继续保留').toContain('onMouseEnter=')
  })

  it('共享抽屉按需请求 360，并把加载/错误/重试接进同一内容区', () => {
    expect(DIALOG).toContain('useCustomer360(open ? identity?.username ?? null : null)')
    expect(DIALOG).toContain('onRetry={reload}')
    expect(DIALOG).toContain('error={error}')
  })

  it('共享 360 加载器订阅实时数据事件，页面与抽屉使用同一刷新口径', () => {
    expect(HOOK).toContain('useWechatDataUpdated(reload)')
  })
})

describe('响应式与现有界面风格', () => {
  it('桌面双栏 + 窄屏上下布局 + 手机单列均有明确断点', () => {
    expect(CSS).toMatch(/\.workspace \{[^}]*grid-template-columns:\s*minmax\(236px, 292px\) minmax\(0, 1fr\)/)
    expect(CSS).toContain('@media (max-width: 980px)')
    expect(CSS).toContain('@media (max-width: 700px)')
    expect(CSS).toContain('@media (max-width: 430px)')
    expect(CSS).toContain('overflow-y: auto')
  })

  it('纵向目录中的搜索框不继承横排工具栏的 320px flex-basis', () => {
    const block = sliceBetween(CSS, '.directorySearch {', '}', 'directorySearch')
    expect(block, '搜索框未覆盖 flex-basis，会变成 320px 高').toContain('flex: 0 0 auto')
    expect(CSS).toContain('grid-template-columns: minmax(0, 1.42fr) minmax(250px, 0.9fr)')
  })

  it('几何与颜色使用既有 --nm-* 令牌，不引入新的圆角字面量', () => {
    expect(CSS).toContain('border-radius: var(--nm-r-')
    expect(CSS).not.toMatch(/border-radius:\s*\d+px/)
    expect(CSS).toContain('var(--nm-bg-card)')
    expect(CSS).toContain('var(--nm-border)')
  })
})
