import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classBlock, readText } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const read = (path: string): string => readText(join(HERE, path))

const CARDS = read('chats-cards.tsx')
const MEDIA = read('chats-media.tsx')
const MSG_CSS = read('chats.module.css')
const ROW_CSS = read('chats-rows.module.css')
const VIEW = read('chats-view.tsx')
const CHATS = read('Chats.tsx')
const MESSAGE_FILE_SAVE = read('message-file-save.ts')
const OCR = read('chats-ocr.tsx')
const REVOKED = read('revoked-content.tsx')
const API_MEDIA = readText(join(HERE, '..', 'api-media.ts'))
const MEDIA_VIEWER = readText(join(HERE, '..', 'media-viewer', 'MediaViewer.tsx'))

describe('聊天内容完整性', () => {
  it('聊天文件卡和撤回文件都把会话 + local_id 交给原文件导出', () => {
    expect(CARDS).toContain('sessionUsername?: string')
    expect(CARDS).toContain('localId={m.localId}')
    expect(CARDS).toContain('{...(sessionUsername ? { sessionUsername } : {})}')
    expect(CHATS).toContain('openFile: messageFileSave.open')
    expect(MESSAGE_FILE_SAVE).toContain('downloadMessageFile(fileName, { ...options, jobId })')
    expect(REVOKED).toContain('downloadMessageFile(name, { username, localId, jobId })')
  })

  it('公众号卡同时渲染头条正文、来源和次条摘要', () => {
    const start = CARDS.indexOf('export function MpNewsCard')
    const end = CARDS.indexOf('/**\n * 链接卡', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const card = CARDS.slice(start, end)
    expect(card).toContain('rich.desc')
    expect(card).toContain('css.msgMpDesc')
    expect(card).toContain('a.summary')
    expect(card).toContain('css.msgMpRowDesc')
  })

  it('正文不截断并保留换行，交易提醒可完整阅读', () => {
    for (const className of ['msgMpDesc', 'msgMpRowDesc', 'msgLinkDesc', 'msgAppmsgDesc']) {
      const css = className.startsWith('msgMp') ? MSG_CSS : ROW_CSS
      const block = classBlock(css, className)
      expect(block, `${className} 要保留正文换行`).toContain('white-space: pre-wrap')
      expect(block, `${className} 不能再按两行截断正文`).not.toContain('-webkit-line-clamp')
    }
  })

  it('空消息会话显示明确空态，而不是留下整片空白', () => {
    expect(VIEW).toContain('messages.length === 0')
    expect(VIEW).toContain('暂无可显示的消息')
    expect(VIEW).toContain('微信本地没有可读取的消息记录')
  })

  it('图片组缩略图复用消息图片缓存，表情在 emojiUrl 后到时也会重试', () => {
    const thumbStart = MEDIA.indexOf('export function MessageThumb')
    const thumbEnd = MEDIA.indexOf('/**\n * 图片组', thumbStart)
    expect(thumbStart).toBeGreaterThanOrEqual(0)
    expect(thumbEnd).toBeGreaterThan(thumbStart)
    const thumb = MEDIA.slice(thumbStart, thumbEnd)
    expect(thumb).toContain('recallImage(username, localId)')
    expect(thumb).toContain('rememberImage(username, localId')
    expect(thumb).toContain('withThumbWidth(src, CHAT_IMAGE_THUMB_WIDTH)')

    const emojiStart = MEDIA.indexOf('export function MessageEmoticon')
    const emoji = MEDIA.slice(emojiStart)
    expect(emoji).toContain('}, [md5, emojiUrl])')
  })

  it('聊天气泡使用 480px 缩略档，查看器加载原图', () => {
    expect(MEDIA).toContain('export const CHAT_IMAGE_THUMB_WIDTH = 480')
    const imageStart = MEDIA.indexOf('export function MessageImage')
    const image = MEDIA.slice(imageStart)
    expect(image).toContain('const displaySrc = withThumbWidth(src, CHAT_IMAGE_THUMB_WIDTH)')
    expect(image).toContain('src={displaySrc}')

    const viewerStart = MEDIA.indexOf('export function ImageViewer')
    const viewerEnd = MEDIA.indexOf('export function MessageThumb', viewerStart)
    const viewer = MEDIA.slice(viewerStart, viewerEnd)
    expect(viewer).toContain('withThumbWidth(recallImage(im.username, im.localId)?.url')
    expect(viewer).toContain('return cached.url')
    expect(viewer).toContain('return r.url')
    expect(viewer).toContain('onDownload: async (src: string) =>')
    expect(viewer).toContain('run: (jobId) => saveChatOriginal(im, src, jobId)')
    expect(MEDIA).toContain('apiExportChatImage')
    expect(MEDIA).toContain("title: '保存聊天原图'")
    expect(MEDIA).toContain("if (!result.ok) throw new Error(result.error || '聊天原图写入失败')")
  })

  it('批量会话导出改为原文件 ZIP，不再只交付 TXT', () => {
    const exp = read('chats-export.tsx')
    expect(exp.replace(/\s+/g, ' ')).toContain("format: 'txt', count: 0, zip: true")
    expect(VIEW).toContain('批量导出会话原文件 ZIP')
    expect(VIEW).toContain('导出所选 ZIP')
  })

  it('单图与连拍图片组都提供微信原生 OCR 入口，且只展示 OCR 原文', () => {
    expect(MEDIA).toContain('source={src} username={selfName} localId={m.localId} layout="side"')
    expect(MEDIA).toContain('source={src} username={username} localId={localId} layout={ocrLayout}')
    expect(MEDIA).toContain("data-self={m.isSender === 1 ? '1' : undefined}")
    expect(MEDIA).toContain("data-self={isSelf ? '1' : undefined}")
    expect(MEDIA).toContain('ImageTextActions')
    expect(ROW_CSS).toContain(".msgImageWithOcr[data-self='1'] .msgImageActionStack[data-layout='side'] { order: -1; }")
    expect(ROW_CSS).toContain(".msgImageGrid[data-self='1'] .msgImageActionStack[data-layout='overlay']")
    expect(ROW_CSS).toContain('.msgImageGroupActions')
    expect(ROW_CSS).toContain(".msgImageGroupPanel[data-self='1'] .msgImageGroupActions { align-items: flex-end; }")
    expect(OCR).toContain("runtimeCapabilities().isDesktop")
    expect(OCR).toContain('apiOcrImage(source)')
    expect(OCR).toContain('{phase.result.text}')
    expect(OCR).toContain('copyTextToClipboard(text)')
    expect(OCR).toContain('<ImageAiAction')
    expect(classBlock(ROW_CSS, 'msgImageActionStack')).toContain('flex-direction: column')
    expect(API_MEDIA).toContain("raw.engine !== 'wechat-native'")
    expect(API_MEDIA).toContain("raw.engine !== 'configured-llm'")
    expect(API_MEDIA).toContain("engine: 'wechat-native'")
    expect(API_MEDIA).toContain("engine: 'configured-llm'")
  })

  it('合并图片折叠为卡片栈，展开后在原位铺开全部图片', () => {
    expect(MEDIA).toContain('const [expanded, setExpanded] = useState(false)')
    expect(MEDIA).toContain('const backLayers = items.slice(1, 4)')
    expect(MEDIA).toContain('className={cssrows.msgImageStackLayer}')
    expect(MEDIA).toContain('className={cssrows.msgImageGroupActions}')
    expect(MEDIA).toContain('className={cssrows.msgImageGroupExpandedActions}')
    expect(MEDIA).toContain('ocrLayout="side"')
    expect(MEDIA).toContain('showOcr={false}')
    expect(MEDIA).toContain('展开 {items.length}')
    expect(MEDIA).toContain('>收起</button>')
    expect(ROW_CSS).toContain('.msgImageGroupPanel[data-self=\'1\'] { flex-direction: row-reverse; }')
    expect(ROW_CSS).toContain('.msgImageGroupExpandedActions')
    expect(ROW_CSS).toContain(".msgImageGroupExpanded[data-self='1'] .msgImageGroupExpandedActions")
    expect(ROW_CSS).toContain('.msgImageStackLayer[data-slot=\'0\']')
    expect(ROW_CSS).toContain('.msgImageGroupExpanded[data-self=\'1\']')
  })

  it('大图查看器和缩略图条都按当前位置开窗，不能随历史图片无限增长', () => {
    expect(CHATS).toContain('centeredWindow(imageMessages.length, clicked')
    expect(CHATS).toContain('.slice(range.start, range.end)')
    expect(CHATS).toContain('index: range.index')
    expect(MEDIA_VIEWER).toContain('centeredWindow(allThumbStrip.length, currentThumbIndex')
    expect(MEDIA_VIEWER).toContain('allThumbStrip.slice(thumbRange.start, thumbRange.end)')
  })

  it('语音卸载/切页签时释放媒体缓冲，而不只是 pause', () => {
    const releaseStart = MEDIA.indexOf('function releaseVoiceAudio')
    const releaseEnd = MEDIA.indexOf('/**\n * 语音消息', releaseStart)
    const release = MEDIA.slice(releaseStart, releaseEnd)
    expect(release).toContain("audio.removeAttribute('src')")
    expect(release).toContain('audio.load()')
    expect(MEDIA).toContain('releaseVoiceAudio(audioRef.current)')
    expect(CHATS).toContain('stopCurrentVoice()')
  })
})
