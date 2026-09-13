/**
 * 微信消息视觉体系的**静态校验**。
 *
 * 为什么需要它：本机的联系人/消息数据都在加密库里，改完样式没法抬头就看到真实
 * 聊天流，「肉眼比对」这条路走不通。于是退一步，对**构建产物**做断言 ——
 * 确认设计令牌与关键几何/色值真的穿过了 Vite 的 CSS Modules 管线（选择器被哈希、
 * 声明被压缩），并且已经没有任何旧值残留在产物里。
 *
 * 覆盖的是「值有没有到位」，不是「看起来对不对」；视觉正确性仍需在有数据的
 * 机器上人工确认（见 docs/compose/spec/wechat-message-visual-system.md 的 Verification）。
 *
 * 用法：node scripts/check-wx-tokens.js
 */
const fs = require('node:fs')
const path = require('node:path')

const DIST = path.join(__dirname, '..', 'src', 'client', 'ui-dist', 'assets')

/** 读取 ui-dist 里体积最大的那份 CSS（主样式表；WorldMap 是异步分块）。 */
function readBuiltCss() {
  if (!fs.existsSync(DIST)) {
    console.error(`找不到构建产物目录：${DIST}\n请先运行 npm run build:ui`)
    process.exit(2)
  }
  const files = fs
    .readdirSync(DIST)
    .filter((f) => f.endsWith('.css'))
    .map((f) => path.join(DIST, f))
  if (files.length === 0) {
    console.error('ui-dist/assets 下没有 CSS，请先运行 npm run build:ui')
    process.exit(2)
  }
  const main = files.reduce((a, b) => (fs.statSync(a).size >= fs.statSync(b).size ? a : b))
  return { css: fs.readFileSync(main, 'utf8'), file: main }
}

/** 必须出现的片段：新令牌定义与关键几何/色值。 */
const MUST_HAVE = [
  // ── 设计令牌（浅色端微信官方精确值） ──
  '--wx-chat-bg: #ededed',
  '--wx-bubble-self: #95ec69',
  '--wx-on-self: #000000',
  '--wx-bubble-other: #ffffff',
  '--wx-on-other: #1f2937',
  '--wx-date-text: #9e9e9e',
  '--wx-sender-name: #6b7280',
  '--wx-quote-bg: #e1e1e1',
  '--wx-card-bg: #ffffff',
  '--wx-card-hover: #f5f5f5',
  '--wx-card-title: #161616',
  '--wx-card-footer: #b2b2b2',
  '--wx-mention: #576b95',
  '--wx-link: #245fbd',
  // ── 设计令牌（深色端） ──
  '--wx-chat-bg: #191919',
  '--wx-bubble-self: #3eb575',
  '--wx-bubble-other: #2e2e2e',
  '--wx-date-text: #9f9f9f',
  '--wx-quote-bg: #252525',
  '--wx-card-bg: #2e2e2e',
  '--wx-card-title: #f5f5f5',
  // ── 几何：圆角 4px / 头像 34px / 行间距 16px ──
  '--wx-radius: 4px',
  '--wx-avatar: 34px',
  '--wx-avatar-radius: 6px',
  '--wx-gap: 10px',
  '--wx-row-gap: 16px',
  // 气泡最大宽：**刻意偏离**微信官方的 384px —— 桌面端要读大段文本，改成与时间分隔行同宽。
  // 顺带说明原值的问题：384px 还会被 .msgBubble 上另一层 `72%` 压到 276px
  // （那层的百分比相对**已封顶的** .msgCol 解析），属复合封顶，已一并修掉。
  '--wx-bubble-maxw: 100%',
  // ── 文本气泡：内边距 6/12、行高 1.6 ──
  'padding:6px 12px',
  'line-height:1.6',
  // ── 尖角改为 45° 方块（不再是 border 三角） ──
  'rotate(45deg)',
  // ── 卡片扁平官方色 ──
  '--wx-transfer: #f79c46',
  '--wx-transfer-returned: #fde1c3',
  '--wx-redpacket: #fa9d3b',
  '--wx-redpacket-footer: #faecda',
  '--wx-live-badge: rgba(250, 81, 81, .92)',
  // ── 卡片定宽（微信官方） ──
  'width:210px',
  'width:232px',
  'width:208px',
  'width:135px',
  'height:270px',
  // ── 底部类型条 / 位置卡地图 / 图片组 / 视频角标 ──
  'height:27px',
  'height:23px',
  'height:98px',
  'gap:2px',
  'right:8px',
  // ── 右键菜单令牌（深浅各一份） ──
  '--wx-ctx-bg: #242424',
  '--wx-ctx-bg: #ffffff',
]

/** 必须**消失**的旧实现：自造渐变、被删的收角令牌、border 三角尖角、旧气泡几何。 */
const MUST_NOT_HAVE = [
  // 转账/红包的自造渐变
  'linear-gradient(145deg,#fa9d3b',
  'linear-gradient(145deg,#fa5151',
  'linear-gradient(145deg,#b0a695',
  // 旧的「靠近尖角那一角收小」令牌
  '--wx-radius-tip',
  // 旧的气泡描边令牌
  '--wx-bubble-other-border',
  // 旧的正文字号
  'font-size:14.5px',
  // 旧的 border 三角尖角写法
  'border-width:5px 6px 5px 0',
  'border-width:5px 0 5px 6px',
  // 旧的消息流最大宽
  'max-width:min(520px,68%)',
]

function main() {
  const { css, file } = readBuiltCss()
  console.log(`检查产物：${path.relative(path.join(__dirname, '..'), file)}（${(css.length / 1024).toFixed(0)} KB）`)

  const missing = MUST_HAVE.filter((s) => !css.includes(s))
  const leftover = MUST_NOT_HAVE.filter((s) => css.includes(s))

  if (missing.length > 0) {
    console.error(`\n✗ 缺少 ${missing.length} 项预期值：`)
    for (const s of missing) console.error(`    ${s}`)
  }
  if (leftover.length > 0) {
    console.error(`\n✗ 残留 ${leftover.length} 项旧实现：`)
    for (const s of leftover) console.error(`    ${s}`)
  }

  if (missing.length === 0 && leftover.length === 0) {
    console.log(`\n✓ 微信消息视觉令牌校验通过（${MUST_HAVE.length} 项到位，${MUST_NOT_HAVE.length} 项旧实现已清除）`)
    return
  }
  process.exit(1)
}

main()
