// @vitest-environment node
/**
 * W3-3.3 / W3-2.5：两件事的**可区分性**守卫（都是「界面必须把不同的事说成不同的话」）。
 *
 * ## 为什么值得单立一条
 *
 * 这两处此前的共同形态是「只有一个数 / 只有一句正在做」，用户看完不知道该不该等、该修什么：
 *   · 索引重建时只显示「构建中…」—— 用户以为越建越快，实际这段时间读到的是**旧索引**；
 *   · 解密失败只显示「失败 N」—— 用户完全不知道是哪几个库、因为什么、该做什么。
 *
 * 判据都是**源码级**的：文案与字段是否存在，本质是「接线在不在」，编译期抓不到。
 * 反向哨兵确认判据没有退化成恒真（把关键串抹掉必须转红）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string): string => readFileSync(p, 'utf8')
const HEALTH = 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Health.tsx'
const VIEW = 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-view.tsx'
const CFG = 'src/backend/wechat-data/src/remotes/config.ts'
const KEYSDEC = 'src/backend/wechat-data/src/remotes/keysdec.ts'

describe('W3-3.3：索引重建期间要说清「读到的还是旧索引」', () => {
  it('Health 的重建按钮按下时给出这句话', () => {
    const h = read(HEALTH)
    expect(h, '重建时没有告知「走的是旧索引」').toContain('旧索引')
    expect(h, '重建提示没说「可能变慢」').toContain('可能变慢')
  })

  it('chats 面板构建索引时同样给出进度与退路', () => {
    const v = read(VIEW)
    expect(v, '构建中没有分片进度读数').toMatch(/正在构建\{indexProgress/)
    // 取消（停止）按钮的存在条件：有本面板发起的那一批在跑。
    expect(v, '构建中没有「停止」按钮 ⇒ 用户只能等它跑完').toContain('>停止</button>')
  })
})

describe('W3-2.5：解密失败必须给出明细与下一步', () => {
  it('后端：失败明细进了实时快照（不是只在一次性结果里）', () => {
    const cfg = read(CFG)
    expect(cfg, 'getDecryptStatus 没把 failures 带出去 ⇒ 面板永远只有计数').toContain('failures: rc.decryptState.failures')
    const kd = read(KEYSDEC)
    expect(kd, '解密跑完没把失败明细写进快照').toContain('rc.decryptState.failures = r.failed.slice(0, 20)')
    // 新一轮必须清空：否则上一轮的失败会挂在下一轮头上（用户看到的是别人的失败）。
    expect(kd, '新一轮开始时没有清空上一轮的失败明细').toContain('rc.decryptState.failures = []')
  })

  it('前端：Health 有明细卡 + 重试入口，且重试只在有失败时出现', () => {
    const h = read(HEALTH)
    expect(h, '没有失败明细卡片').toContain('解密失败明细')
    expect(h, '明细卡没有给出下一步').toContain('退出微信后点上面的「重试解密」')
    expect(h, '没有重试入口').toContain('retryDecrypt')
    // 「只在有失败时出现」：按钮的存在条件必须是 failures.length > 0。
    expect(h).toMatch(/\(decrypt\?\.failures\.length \?\? 0\) > 0 && \(/)
  })

  it('前端：重试的四个分支都出声（成功 / 部分失败 / 抛错 / 收尾）', () => {
    const h = read(HEALTH)
    expect(h).toContain('解密完成：成功 ${r.okCount}/${r.total}')
    expect(h).toContain('仍有 ${r.failed.length} 个失败')
    expect(h).toMatch(/catch \(e\) \{[\s\S]{0,120}setError\(\(e as Error\)\.message\)/)
    expect(h).toMatch(/finally \{[\s\S]{0,120}setRetrying\(false\)/)
  })
})