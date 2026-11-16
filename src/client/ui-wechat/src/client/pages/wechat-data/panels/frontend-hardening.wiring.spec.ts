/**
 * 系统性审查（前端 P1/P2）的**接线判据**。
 *
 * 纯行为判据分别在 `data-identity.spec.ts` / `nav-config.deep-link.spec.ts` /
 * `panels/safe-external-link.spec.ts` / `ui/mobile-nav.spec.ts`；这里只钉「生产代码
 * 真的接上了这些能力」—— 单元测试绿但调用点没接，是这一轮最容易漏的形态。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const read = (name: string): string => readFileSync(join(HERE, name), 'utf8').replace(/\r\n/g, '\n')
const PANEL = read('../WechatDataPanel.tsx')
const CACHE = read('../cache.ts')
const KEEP_ALIVE = read('keep-alive.tsx')
const SETTINGS = read('settings-state.tsx')
const CHATS_MEDIA = read('chats-media.tsx')
const CHATS_SUPPORT = read('chats-support.tsx')
const MOMENTS_CARD = read('moments-card.tsx')
const MOMENTS_PORTALS = read('moments-portals.tsx')
const FAVORITES_DETAIL = read('favorites-detail.tsx')
const FAVORITES_MEDIA = read('favorites-media.tsx')

describe('保存账号 / 数据目录后确实失效缓存', () => {
  it('保存成功分支调用 applyDataIdentityAfterSave（目录 / 密钥变化才真正清）', () => {
    const saveAt = SETTINGS.indexOf('const save = async')
    const okAt = SETTINGS.indexOf('if (r.ok)', saveAt)
    const elseAt = SETTINGS.indexOf('else setSaveMsg', okAt)
    expect(saveAt, '找不到 save 函数').toBeGreaterThanOrEqual(0)
    expect(okAt, 'save 里找不到 r.ok 分支').toBeGreaterThan(saveAt)
    expect(elseAt).toBeGreaterThan(okAt)

    const success = SETTINGS.slice(okAt, elseAt)
    expect(success, '保存成功后没有失效缓存').toContain('applyDataIdentityAfterSave(')
    expect(success).toContain('db_dir: dbDir')
    expect(success).toContain('db_enc_key: dbKey')
    expect(success).toContain('image_aes_key: imgAes')
  })

  it('读取完整配置时记住比较基线（否则第一次保存永远判不出变化）', () => {
    const loadAt = SETTINGS.indexOf('const c = await apiGetWechatConfigFull()')
    expect(loadAt).toBeGreaterThanOrEqual(0)
    expect(SETTINGS.slice(loadAt, loadAt + 240)).toContain('rememberDataIdentity(c)')
  })

  it('「自动获取密钥」两条路径落盘成功后也要失效（否则只是换了个地方改密钥）', () => {
    const dbAt = SETTINGS.indexOf('const autoGetDb')
    const imgAt = SETTINGS.indexOf('const autoGetImg')
    const verifyAt = SETTINGS.indexOf('const verifyDb', imgAt)
    expect(dbAt).toBeGreaterThanOrEqual(0)
    expect(imgAt).toBeGreaterThan(dbAt)
    expect(verifyAt).toBeGreaterThan(imgAt)
    expect(SETTINGS.slice(dbAt, imgAt), '自动获取数据库密钥后没有失效').toContain('if (saved) applyDataIdentityAfterSave(')
    expect(SETTINGS.slice(imgAt, verifyAt), '自动获取图片密钥后没有失效').toContain('if (saved) applyDataIdentityAfterSave(')
  })

  it('面板启动时只取 db_dir 建指纹；保存后广播头像复位事件', () => {
    expect(PANEL).toContain('apiGetWechatConfig().then((c) => { setDataDirIdentity(c.db_dir) })')
    expect(PANEL).toContain('DATA_IDENTITY_CHANGED_EVENT')
    expect(PANEL).toContain('window.addEventListener(DATA_IDENTITY_CHANGED_EVENT')
  })

  it('cache 的默认失效实现覆盖快照 / 持久层 / 图片 / 头像', () => {
    expect(CACHE).toContain("invalidateAll: () => { invalidateWechatCache(''); clearSnapshotCache() }")
    expect(CACHE).toContain('forgetAllImages()')
    expect(CACHE).toContain('DATA_IDENTITY_CHANGED_EVENT')
    // 渲染缓存键按目录指纹命名，且前缀失效会还原逻辑键。
    expect(CACHE).toContain('scopedRenderCacheKey(key)')
    expect(CACHE).toContain('dataDirFingerprint(currentDataDir)')
    expect(CACHE).toContain('logicalRenderCacheKey')
  })
})

describe('keep-alive 按数据身份重挂 + 每 pane 错误边界', () => {
  it('订阅目录身份并在变化时丢弃旧缓存', () => {
    expect(KEEP_ALIVE).toContain('useSyncExternalStore(subscribeDataIdentity, getDataIdentitySnapshot')
    expect(KEEP_ALIVE).toContain('cacheRef.current.identity !== identity')
    expect(KEEP_ALIVE).toContain('new Map()')
  })

  it('每个 pane 的错误边界 key 带 tab + identity，resetKey 跟随是否显示', () => {
    expect(KEEP_ALIVE).toContain('ErrorBoundary')
    expect(KEEP_ALIVE).toContain('key={`${tab}:${identity}`}')
    expect(KEEP_ALIVE).toContain('label={tabLabelOf(tab)}')
    expect(KEEP_ALIVE).toContain('resetKey={tab === active}')
    expect(KEEP_ALIVE).toContain('key={`standalone:${active}:${identity}`}')
  })

  it('主内容区与根节点各有一层边界（页面级错误不再卸整棵根树）', () => {
    expect(PANEL).toContain('<ErrorBoundary label="微信数据">')
    const mainAt = PANEL.indexOf('<main className={css.content}>')
    expect(mainAt).toBeGreaterThanOrEqual(0)
    const main = PANEL.slice(mainAt, mainAt + 600)
    expect(main).toContain('<ErrorBoundary label={tabLabelOf(active)} resetKey={active}>')
    expect(main).toContain('<Suspense fallback=')
  })
})

describe('深链：原型键防护 + hashchange / 前进后退', () => {
  it('初始页签与设置落节都走自有属性白名单', () => {
    expect(PANEL).toContain('tabFromHash(initialHash)')
    expect(PANEL).toContain('ownValue<string>(DIALOG_SECTION_OF, hashKey(hash))')
    const nav = read('../nav-config.ts')
    expect(nav).toContain('Object.hasOwn(TAB_LABELS, value)')
    expect(nav).toContain('Object.hasOwn(table, key)')
  })

  it('监听 hashchange / popstate，切页签用 replaceState（不堆历史、不自我触发）', () => {
    expect(PANEL).toContain("window.addEventListener('hashchange', syncFromHash)")
    expect(PANEL).toContain("window.addEventListener('popstate', syncFromHash)")
    expect(PANEL).toContain("window.removeEventListener('hashchange', syncFromHash)")
    expect(PANEL).toContain("window.removeEventListener('popstate', syncFromHash)")
    expect(PANEL).toContain('history.replaceState(null,')
    // 旧写法会给每次切页签堆一条历史，还会和 hashchange 监听互相拉扯。
    expect(PANEL).not.toMatch(/location\.hash\s*=/)
  })
})

describe('不可信外链统一经 SafeExternalLink', () => {
  it('朋友圈两处链接展示都换成了安全链接组件', () => {
    expect(MOMENTS_CARD).toContain('<SafeExternalLink className={css.linkTitle} href={m.link_url}')
    expect(MOMENTS_PORTALS).toContain('<SafeExternalLink className={css.linkTitle} href={detail.m.link_url}')
    expect(MOMENTS_CARD).not.toMatch(/<a[^>]+href=\{m\.link_url\}/)
    expect(MOMENTS_PORTALS).not.toMatch(/<a[^>]+href=\{detail\.m\.link_url\}/)
  })

  it('收藏详情 / 收藏媒体 / 高德地图入口都走同一个白名单', () => {
    expect(FAVORITES_DETAIL).toContain('<SafeExternalLink href={d.url}')
    expect(FAVORITES_MEDIA).toContain('<SafeExternalLink className={css.favMediaLink} href={url}>')
    expect(FAVORITES_MEDIA).toContain('<SafeExternalLink className={css.favMediaLink} href={part.url}>')
    expect(FAVORITES_MEDIA).not.toContain('openLink(')
  })

  it('SafeExternalLink 只放行 http(s)，不安全地址不生成 href', () => {
    expect(CHATS_SUPPORT).toContain('export function safeExternalHref')
    expect(CHATS_SUPPORT).toContain('/^https?:\\/\\//i.test(value)')
    expect(CHATS_SUPPORT).toContain('const safe = safeExternalHref(href)')
    expect(CHATS_SUPPORT).toContain('if (safe === null)')
    expect(CHATS_SUPPORT).toContain('target="_blank" rel="noopener noreferrer"')
  })
})

describe('隐藏的保活聊天面板释放图片 data URL', () => {
  it('图片 / 表情 / 视频封面在 pane 隐藏时清空状态，显示时从缓存或接口恢复', () => {
    expect(CHATS_MEDIA).toContain("import { useKeepAliveActive } from './keep-alive.tsx'")
    expect(CHATS_MEDIA.match(/const keepAliveActive = useKeepAliveActive\(\)/g)?.length).toBeGreaterThanOrEqual(4)
    expect(CHATS_MEDIA.match(/if \(!keepAliveActive\) \{/g)?.length).toBeGreaterThanOrEqual(4)
    expect(CHATS_MEDIA).toContain('setSrc(null)')
    expect(CHATS_MEDIA).toContain('setCover(null)')
    // 依赖里必须有 keepAliveActive：pane 隐藏时 effect 才会执行释放分支。
    expect(CHATS_MEDIA).toContain('[username, localId, keepAliveActive]')
    expect(CHATS_MEDIA).toContain('[selfName, m.localId, keepAliveActive]')
    expect(CHATS_MEDIA).toContain('[md5, emojiUrl, keepAliveActive]')
    expect(CHATS_MEDIA).toContain('[selfName, m.localId, nonce, keepAliveActive]')
  })
})
