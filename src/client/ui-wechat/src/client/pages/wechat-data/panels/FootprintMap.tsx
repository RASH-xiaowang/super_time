/**
 * 朋友圈足迹地图 —— 中国分省热力（2026-10-17 第 4 轮：只显示中国各省）。
 *
 * ## 为什么从世界地图改成中国分省
 *
 * 上一轮用 `GeoEchartsMap` 渲染世界地图，但本机 590 次打卡里 553 次在中国、
 * 其余 37 次散在东南亚 —— 世界地图上中国是一整块紫色，看不出「去了哪些省」
 * （用户截图 + 反馈「足迹地图只显示中国各省就行」）。改成 `ChinaMap`
 * （与「数据总览」下钻中国时同一套渲染器）后，每个省独立着色，一眼看出分布。
 *
 * ## 数据怎么变成省份
 *
 * 足迹数据只有 `city`（`南宁市` / `杭州` / `大理白族自治州`），没有省份。
 * 这里用 `CITY_PROVINCE` 表把城市名映射到省份，再聚成
 * `RegionNode{ key:'中国', children: [省 → 市] }` 交给 `ChinaMap`。
 *
 * 映射表只覆盖本机实际出现的城市 + 常见城市；未命中的城市归到「省份未填」，
 * 不瞎猜（`ChinaMap` 的 `chinaChildByKey` 对「省份未填」返回 null，不着色）。
 */
import { useMemo } from 'react'
import type { MomentsGeoPoint, RegionNode } from '@deepseek-ai/dsh-wechat-data/types'
import { ChinaMap } from './ChinaMap.tsx'
import kitCss from '../ui/kit.module.css'
import css from './moments-insights.module.css'

/**
 * 微信 XML 的 `<location country>` 有时写英文（本机实测 `Thailand`），
 * 与同行的中文城市名混在一起很突兀。只映射常见几个，未命中就原样显示。
 */
const COUNTRY_ZH: Record<string, string> = {
  China: '中国',
  Thailand: '泰国',
  Japan: '日本',
  Singapore: '新加坡',
  Malaysia: '马来西亚',
  Vietnam: '越南',
  'South Korea': '韩国',
  Korea: '韩国',
  'United States': '美国',
  USA: '美国',
  France: '法国',
  Italy: '意大利',
  Germany: '德国',
  'United Kingdom': '英国',
  Australia: '澳大利亚',
  Indonesia: '印度尼西亚',
  Philippines: '菲律宾',
  Cambodia: '柬埔寨',
  Laos: '老挝',
  Myanmar: '缅甸',
  'Hong Kong': '中国香港',
  Macau: '中国澳门',
  Taiwan: '中国台湾',
}

/** 把英文国家名换成中文；未命中原样返回。 */
export function zhCountry(name: string): string {
  return COUNTRY_ZH[name] ?? name
}

/**
 * 城市名 → 省份（只覆盖中国城市）。
 *
 * 键是**去掉「市」后缀**的城市名：微信 XML 里同一个城市有时写 `南宁市`、
 * 有时写 `南宁`（本机两种都有），统一去后缀再查表才不会漏。
 * 自治州（`大理白族自治州`）保留全名，因为去掉后缀就认不出了。
 *
 * 只收本机实际出现的城市 + 常见城市；未命中的归「省份未填」，不瞎猜。
 */
const CITY_PROVINCE: Readonly<Record<string, string>> = {
  // ── 广西 ──
  南宁: '广西', 柳州: '广西', 桂林: '广西', 北海: '广西', 河池: '广西',
  钦州: '广西', 崇左: '广西', 玉林: '广西', 梧州: '广西', 防城港: '广西',
  贵港: '广西', 百色: '广西', 贺州: '广西', 来宾: '广西',
  // ── 浙江 ──
  杭州: '浙江', 宁波: '浙江', 温州: '浙江', 嘉兴: '浙江', 绍兴: '浙江',
  金华: '浙江', 台州: '浙江', 湖州: '浙江', 丽水: '浙江', 衢州: '浙江', 舟山: '浙江',
  // ── 北京 / 上海 / 天津 / 重庆 ──
  北京: '北京', 上海: '上海', 天津: '天津', 重庆: '重庆',
  // ── 广东 ──
  广州: '广东', 深圳: '广东', 东莞: '广东', 佛山: '广东', 珠海: '广东',
  中山: '广东', 惠州: '广东', 汕头: '广东', 揭阳: '广东', 江门: '广东',
  湛江: '广东', 肇庆: '广东', 清远: '广东', 韶关: '广东', 梅州: '广东',
  // ── 江苏 ──
  南京: '江苏', 苏州: '江苏', 无锡: '江苏', 常州: '江苏', 南通: '江苏',
  徐州: '江苏', 扬州: '江苏', 镇江: '江苏', 泰州: '江苏', 盐城: '江苏',
  // ── 云南 ──
  昆明: '云南', 丽江: '云南', 大理: '云南', 西双版纳: '云南', 香格里拉: '云南',
  曲靖: '云南', 玉溪: '云南', 保山: '云南', 昭通: '云南', 普洱: '云南',
  // ── 贵州 ──
  贵阳: '贵州', 遵义: '贵州', 六盘水: '贵州', 安顺: '贵州', 毕节: '贵州',
  // ── 四川 ──
  成都: '四川', 绵阳: '四川', 德阳: '四川', 宜宾: '四川', 泸州: '四川',
  南充: '四川', 乐山: '四川', 自贡: '四川',
  // ── 福建 ──
  福州: '福建', 厦门: '福建', 泉州: '福建', 漳州: '福建', 莆田: '福建',
  宁德: '福建', 龙岩: '福建', 三明: '福建', 南平: '福建',
  // ── 江西 ──
  南昌: '江西', 赣州: '江西', 九江: '江西', 上饶: '江西', 宜春: '江西',
  吉安: '江西', 抚州: '江西', 景德镇: '江西', 萍乡: '江西', 新余: '江西',
  // ── 湖南 ──
  长沙: '湖南', 株洲: '湖南', 湘潭: '湖南', 衡阳: '湖南', 岳阳: '湖南',
  常德: '湖南', 郴州: '湖南', 邵阳: '湖南', 益阳: '湖南', 怀化: '湖南',
  // ── 湖北 ──
  武汉: '湖北', 宜昌: '湖北', 襄阳: '湖北', 荆州: '湖北', 黄石: '湖北',
  十堰: '湖北', 孝感: '湖北', 荆门: '湖北', 黄冈: '湖北',
  // ── 河南 ──
  郑州: '河南', 洛阳: '河南', 开封: '河南', 新乡: '河南', 南阳: '河南',
  许昌: '河南', 安阳: '河南', 商丘: '河南', 信阳: '河南', 周口: '河南',
  // ── 河北 ──
  石家庄: '河北', 唐山: '河北', 保定: '河北', 廊坊: '河北', 邯郸: '河北',
  秦皇岛: '河北', 张家口: '河北', 承德: '河北', 沧州: '河北', 邢台: '河北',
  // ── 山西 ──
  太原: '山西', 大同: '山西', 阳泉: '山西', 长治: '山西', 晋城: '山西',
  临汾: '山西', 运城: '山西', 晋中: '山西',
  // ── 山东 ──
  济南: '山东', 青岛: '山东', 烟台: '山东', 潍坊: '山东', 临沂: '山东',
  淄博: '山东', 济宁: '山东', 泰安: '山东', 威海: '山东', 日照: '山东',
  // ── 辽宁 ──
  沈阳: '辽宁', 大连: '辽宁', 鞍山: '辽宁', 抚顺: '辽宁', 本溪: '辽宁',
  丹东: '辽宁', 锦州: '辽宁', 营口: '辽宁',
  // ── 吉林 ──
  长春: '吉林', 吉林: '吉林', 四平: '吉林', 通化: '吉林', 延吉: '吉林',
  // ── 黑龙江 ──
  哈尔滨: '黑龙江', 齐齐哈尔: '黑龙江', 大庆: '黑龙江', 牡丹江: '黑龙江',
  伊春: '黑龙江', 佳木斯: '黑龙江',
  // ── 安徽 ──
  合肥: '安徽', 芜湖: '安徽', 蚌埠: '安徽', 安庆: '安徽', 黄山: '安徽',
  马鞍山: '安徽', 阜阳: '安徽', 宿州: '安徽',
  // ── 陕西 ──
  西安: '陕西', 咸阳: '陕西', 宝鸡: '陕西', 渭南: '陕西', 延安: '陕西',
  汉中: '陕西', 榆林: '陕西',
  // ── 甘肃 ──
  兰州: '甘肃', 天水: '甘肃', 嘉峪关: '甘肃', 酒泉: '甘肃', 张掖: '甘肃',
  // ── 青海 ──
  西宁: '青海', 海东: '青海',
  // ── 宁夏 ──
  银川: '宁夏', 石嘴山: '宁夏', 吴忠: '宁夏', 固原: '宁夏',
  // ── 新疆 ──
  乌鲁木齐: '新疆', 喀什: '新疆', 伊宁: '新疆', 克拉玛依: '新疆',
  // ── 西藏 ──
  拉萨: '西藏', 日喀则: '西藏', 林芝: '西藏',
  // ── 内蒙古 ──
  呼和浩特: '内蒙古', 包头: '内蒙古', 鄂尔多斯: '内蒙古', 赤峰: '内蒙古',
  // ── 海南 ──
  海口: '海南', 三亚: '海南', 儋州: '海南',
  // ── 港澳台 ──
  香港: '香港', 澳门: '澳门', 台北: '台湾', 高雄: '台湾', 台中: '台湾',
  // ── 自治州（保留全名，去后缀就认不出）──
  大理白族自治州: '云南',
  迪庆藏族自治州: '云南',
  西双版纳傣族自治州: '云南',
  黔南布依族苗族自治州: '贵州',
  黔东南苗族侗族自治州: '贵州',
  黔西南布依族苗族自治州: '贵州',
  恩施土家族苗族自治州: '湖北',
  湘西土家族苗族自治州: '湖南',
  阿坝藏族羌族自治州: '四川',
  甘孜藏族自治州: '四川',
  凉山彝族自治州: '四川',
  伊犁哈萨克自治州: '新疆',
  昌吉回族自治州: '新疆',
  延边朝鲜族自治州: '吉林',
  海西蒙古族藏族自治州: '青海',
  海南藏族自治州: '青海',
  果洛藏族自治州: '青海',
  玉树藏族自治州: '青海',
  临夏回族自治州: '甘肃',
  甘南藏族自治州: '甘肃',
  巴音郭楞蒙古自治州: '新疆',
  博尔塔拉蒙古自治州: '新疆',
  克孜勒苏柯尔克孜自治州: '新疆',
  德宏傣族景颇族自治州: '云南',
  怒江傈僳族自治州: '云南',
  文山壮族苗族自治州: '云南',
  红河哈尼族彝族自治州: '云南',
  楚雄彝族自治州: '云南',
}

/** 省份未填的合成桶（`ChinaMap` 对它返回 null，不着色）。 */
const UNKNOWN_PROVINCE = '省份未填'

/**
 * 城市名 → 省份。
 *
 * 先查全名（自治州），再去掉「市 / 区 / 县」后缀查（`南宁市` → `南宁`）。
 * @param city - 微信 XML 的 `<location city>`。
 * @returns 省份名；判断不了返回 `省份未填`。
 */
export function cityProvince(city: string): string {
  const raw = city.trim()
  if (!raw) return UNKNOWN_PROVINCE
  const exact = CITY_PROVINCE[raw]
  if (exact !== undefined) return exact
  // 去掉行政区划后缀再查：`南宁市` → `南宁`、`离岛区` → `离岛`。
  const stripped = raw.replace(/(市|区|县|地区)$/, '')
  const byStripped = CITY_PROVINCE[stripped]
  if (byStripped !== undefined) return byStripped
  return UNKNOWN_PROVINCE
}

/**
 * 把足迹点聚成「中国 → 省 → 市」的 `RegionNode` 树。
 *
 * 只保留中国境内的点：用户要求「只显示中国各省」，境外打卡（本机 37 次）
 * 在分省地图上没有位置可放，硬塞进「省份未填」会让那个桶虚高。
 * @param points - 后端给的已修正坐标点。
 * @returns 中国节点；无中国点时 `children` 为空数组。
 */
export function buildFootprintTree(points: readonly MomentsGeoPoint[]): RegionNode {
  const byProvince = new Map<string, Map<string, number>>()
  for (const p of points) {
    // 只收中国：`country` 为空时按城市名兜底（本机 189 个点 country 是空的）。
    const country = zhCountry(p.country)
    const province = cityProvince(p.city)
    const isChina = country === '中国' || (country === '' && province !== UNKNOWN_PROVINCE)
    if (!isChina) continue
    const city = p.city.trim() || '未知城市'
    const cities = byProvince.get(province) ?? new Map<string, number>()
    cities.set(city, (cities.get(city) ?? 0) + 1)
    byProvince.set(province, cities)
  }
  const children: RegionNode[] = [...byProvince.entries()]
    .map(([province, cities]) => {
      const cityNodes: RegionNode[] = [...cities.entries()]
        .map(([city, count]) => ({ key: city, name: city, count, children: [], friends: [] }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      const total = cityNodes.reduce((a, c) => a + c.count, 0)
      return { key: province, name: province, count: total, children: cityNodes, friends: [] }
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  const total = children.reduce((a, c) => a + c.count, 0)
  return { key: '中国', name: '中国', count: total, children, friends: [] }
}

/**
 * 渲染朋友圈足迹地图（中国分省热力）。
 * @param props.points - 已修正的 (lat, lng) 点；空数组时由调用方给空态，这里返回 null。
 * @param props.cities - 去重城市数，用于摘要文案。
 * @returns 地图元素；无中国点时 null。
 */
export function FootprintMap({ points, cities }: { points: readonly MomentsGeoPoint[]; cities: number }): React.JSX.Element | null {
  const tree = useMemo(() => buildFootprintTree(points), [points])
  if (points.length === 0) return null

  const provinceCount = tree.children.length
  const summary = `${String(tree.count)} 次打卡 · ${String(provinceCount)} 个省 · ${String(cities)} 个城市`

  return (
    <div className={css.footprintWrap}>
      <div className={css.footprintBar}>
        <span className={kitCss.textCaption}>{summary}</span>
        <span className={kitCss.textCaption}>滚轮缩放 · 拖拽平移 · 悬停看城市</span>
      </div>
      <div className={css.footprintMapBox}>
        <ChinaMap
          node={tree}
          /* 足迹地图只做展示：点省份不下钻（没有更细的底图），
             缩放交给 ECharts 自带的 roam。 */
          onDrill={() => { /* 只展示，不下钻 */ }}
          onFallback={() => { /* 底图不可达时保持空白，摘要行已经说明了数据量 */ }}
          /* 本机广西 457 次、其他省 1~28 次：线性映射下除广西外全落在最低档，
             整张图只有两种颜色（真机截图）。对数分档让 1/10/100/400 各占一档。 */
          logScale
          unit="次打卡"
        />
      </div>
    </div>
  )
}
