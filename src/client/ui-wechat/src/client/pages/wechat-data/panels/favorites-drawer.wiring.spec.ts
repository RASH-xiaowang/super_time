/**
 * 收藏详情（普通收藏与聊天记录）的抽屉接线守卫。
 *
 * 用户要求点击收藏后从右侧以抽屉展示。两类详情都必须复用 kit 的 Radix `Drawer`
 * （桌面右侧、手机底部 sheet、Esc/焦点陷阱均由它提供），不能退回居中 `Dialog`
 * 或居中的手写覆盖层。
 * @vitest-environment node
 */
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { jsxCall, readStripped } from '../../../test-helpers/wiring-kit.ts'

const HERE = dirname(import.meta.filename)
const panel = readStripped(join(HERE, 'Favorites.tsx'))
const chatlog = readStripped(join(HERE, 'favorites-chatlog-preview.tsx'))

describe('收藏详情抽屉接线', () => {
  it('普通收藏详情使用 kit Drawer，不再使用居中 Dialog', () => {
    expect(panel).toContain("import { Drawer, EmptyState, PanelHeader, useDebouncedValue } from '../ui/kit.tsx'")
    expect(panel).not.toContain("import { Dialog,")
    const drawer = jsxCall(panel, 'Drawer', '普通收藏详情')
    expect(drawer).toContain('open={detail !== null && detail.type !== 14}')
    expect(drawer).toContain('onClose={() => { setDetail(null) }}')
    expect(drawer).toContain('title={detail ? parseFavItem(detail).title : \'收藏详情\'}')
    expect(drawer).toContain('width={520}')
  })

  it('详情主体仍渲染在抽屉内', () => {
    expect(panel).toContain('<FavoriteDetail item={detail} thumbs={favImgs} />')
  })

  it('聊天记录收藏也使用 kit Drawer，不再渲染居中覆盖层', () => {
    expect(chatlog).toContain("import { Drawer } from '../ui/kit.tsx'")
    expect(chatlog).not.toContain('calOverlay')
    expect(chatlog).not.toContain('chatlogDialog')
    expect(chatlog).toContain("import { FavoritePart } from './favorites-media.tsx'")
    expect(chatlog).toContain('<FavoritePart part={part} updateTime={item.updateTime} thumbs={thumbs} />')
    const drawer = jsxCall(chatlog, 'Drawer', '聊天记录收藏')
    expect(drawer).toContain('open')
    expect(drawer).toContain('onClose={onClose}')
    expect(drawer).toContain('title={info.title}')
    expect(drawer).toContain('width={520}')
    expect(chatlog).toContain('className={cssshell.chatlogBody}')
  })
})
