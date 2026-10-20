/**
 * 手机浏览器审计的视口常量与命令行视口解析（Wave 3 从入口文件机械拆出，行为未改）。
 *
 * 注意：这里只放**纯常量与纯函数**。CLI 派生量（LABEL/OUT_DIR/…）依赖 `process.argv`
 * 与仓库路径，仍留在入口，避免两处各自解析一遍参数。
 *
 * @module scripts/responsive-audit-browser/config
 */
import { hasFlag, opt } from '../responsive-audit/setup.mjs'

/** 手机浏览器四档视口（竖屏三档 + 横屏一档；横屏是「窄高」的另一半问题面）。 */
export const BROWSER_VIEWPORTS = [
  { label: '375x667', w: 375, h: 667, device: 'iPhone SE / 8（最小常见竖屏）' },
  { label: '390x844', w: 390, h: 844, device: 'iPhone 12–15（主流竖屏）' },
  { label: '414x896', w: 414, h: 896, device: 'iPhone XR / 11（大屏竖屏）' },
  { label: '844x390', w: 844, h: 390, device: '主流机横屏（高度只有 390）' },
]
/** `--quick`：竖屏主流 + 横屏，两档足够暴露「窄 / 矮」两个极端。 */
export const QUICK_VIEWPORTS = ['390x844', '844x390']

/** 手机 Chrome UA（Android Chrome 是远程访问的真实主用户；iOS 也走 Chrome/Safari 同内核）。 */
export const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36'

/** 问题格截图质量（JPEG；与桌面审计同口径）。 */
export const SCREENSHOT_QUALITY = 70

/**
 * 解析视口参数：`--viewports=WxH,...` 覆盖默认矩阵；`--quick` 取两档。
 * @returns {Array<{label:string,w:number,h:number,device?:string}>}
 */
export function parseBrowserViewports () {
  const quick = hasFlag('quick')
  const raw = opt('viewports', '')
  if (raw === '') {
    return quick ? BROWSER_VIEWPORTS.filter((v) => QUICK_VIEWPORTS.includes(v.label)) : BROWSER_VIEWPORTS
  }
  const out = []
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)x(\d+)$/.exec(part)
    if (!m) throw new Error(`无法解析视口「${part}」，格式应为 390x844`)
    out.push({ label: part, w: Number(m[1]), h: Number(m[2]) })
  }
  return out
}
