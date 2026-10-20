/**
 * 变异登记 · **手机端触摸目标下限**（2026-10-14，M559 起，M7）。
 *
 * 这一族守的是「手指点得中」：桌面端 22–32px 的控件用鼠标没问题，触摸上就是点不准，
 * 而触摸又没有 `:hover` 可以先提示。375px × 真实数据实测（通讯录 214 个、朋友圈 136 个、
 * 聊天 130 个、文件 18 个可点元素）修到「无一低于 40px」，这两条把成果钉住。
 *
 *   M559 去掉 mobile-viewport.css 手机档的元素级 `min-height: 44px` ⇒ 全仓可点元素退回各自
 *        的 22–32px（分类按钮 26、作者芯片 26、日期预设 24、搜索框 32）；
 *   M560 把段条手机档的覆盖退回 24px ⇒ 8 组合并视图（通讯录/朋友圈/文件与存储…）的**主导航**
 *        又变成 24px 高 —— 元素级规则被 `.segItem` 的类特异性盖住，这一处只能靠那份覆盖。
 *
 * @module mutations-registry/batch3x
 */
export const MUTATIONS_BATCH3X = [
  {
    id: 'M559-phone-touch-floor-gone',
    why: '手机档的元素级 44px 下限被去掉 ⇒ 通讯录/朋友圈/文件与存储上的分类按钮(26px)、作者芯片(26px)、日期预设(24px)、搜索框(32px) 全部退回桌面尺寸，手指点不准；触摸上没有 :hover 可以补救，桌面尺寸的量测也永远看不见。判据：mobile-shell.spec.ts 的「触摸目标下限：全局元素级 44px + 段条在手机档覆盖回 36px」。',
    file: 'src/client/ui-app/mobile-viewport.css',
    from: '    min-height: 44px;',
    to: '    min-height: 24px;',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/ui/mobile-shell.spec.ts',
  },
  {
    id: 'M560-seg-item-phone-override-gone',
    why: '分段条（8 组合并视图的主导航）手机档覆盖退回 24px：元素级 `button{min-height:44px}` 被 `.segItem` 的类特异性盖住，所以这一处**只有**那份覆盖有效 —— 删掉它，通讯录/朋友圈/文件与存储顶部的段条就还是 24px 高（实测 11 个）。⚠️ 2026-10-16 覆盖值从 44px 收到 36px（用户报「筛选区占比太大」：分段条是密集筛选控件，不是主要操作按钮，44px 会让「段条+搜索行+分类条」三行合计 222px、占 718px 内容区的 31%）。判据：mobile-shell.spec.ts 的同一条。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/ui/kit-overlay.module.css',
    from: '  .segItem { min-height: 36px; }',
    to: '  .segItem { min-height: 24px; }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/ui/mobile-shell.spec.ts',
  },
]
