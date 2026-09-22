/**
 * 首次进入系统的「配置向导」判定（纯函数，不碰 DOM / IPC）。
 *
 * 为什么要有这一层：设置弹窗左导航的 `stepStates`（Settings.tsx）已经算过一次这些状态，
 * 但那套计算写在组件内部、依赖它自己的加载流程。向导要在主界面独立判断「配完没有」，
 * 两边各写一套的话迟早会出现「向导说没配好、设置里却是绿的」这种自相矛盾。
 * 所以口径收敛到这里：**四项必做（检测账号 / 数据库密钥 / 图片密钥 / 图片解码）**，
 * 语音转写列为可选（引擎没就绪不阻塞「完成」）。
 *
 * 判定逐条对齐 Settings.tsx 的 stepStates：
 *   detect: 已检测到账号，或已填数据库目录
 *   dbkey : 密钥文件已加载且含密钥，或已手填密钥
 *   imgkey: 已填图片 AES 密钥
 *   img   : 「自动获取原图（CDN）」为开启
 */

export type SetupStepKey = 'detect' | 'dbkey' | 'imgkey' | 'img'

/** 主界面能拿到的配置事实（由 api 层组装，见 SetupGuide 的取数）。 */
export interface SetupFacts {
  /** 检测到的微信账号数。 */
  accounts: number
  /** 已选定的数据库目录。 */
  dbDir: string
  /** 密钥文件是否已加载（keysInfo.loaded）。 */
  keysLoaded: boolean
  /** 密钥文件里的密钥条数（keysInfo.keyCount）。 */
  keyCount: number
  /** 手填的数据库密钥。 */
  dbKey: string
  /** 图片 AES 密钥。 */
  imgAes: string
  /** 「自动获取原图（CDN）」开关。 */
  cdnEnabled: boolean
  /** whisper 引擎是否就绪（可选项）。 */
  voiceReady: boolean
}

export interface SetupStep {
  key: SetupStepKey
  label: string
  /** 未完成时的引导语（要说清去那一节做什么）。 */
  todo: string
  /** 已完成时的说明。 */
  done: string
}

/** 必做的四步，顺序与设置里的「配置向导」分组一致。 */
/** 非空元组类型：`firstPendingStep` 的兜底要取「第一步」，声明成 `readonly SetupStep[]`
 *  就得靠断言或硬写一个 key（改了顺序就悄悄不一致）。元组让「至少有一步」成为类型事实。 */
export const SETUP_STEPS: readonly [SetupStep, ...SetupStep[]] = [
  { key: 'detect', label: '检测账号', todo: '扫描本机微信账号与安装目录', done: '已检测到微信账号' },
  { key: 'dbkey', label: '数据库密钥', todo: '获取 64 位数据库密钥以解密聊天记录', done: '密钥已就绪' },
  { key: 'imgkey', label: '图片密钥', todo: '填写图片 AES 密钥与 XOR 偏移量', done: '图片密钥已就绪' },
  { key: 'img', label: '图片解码', todo: '开启「自动获取原图（CDN）」', done: '图片解码已启用' },
]

/** 可选一步：不阻塞「配置完成」，单独列一行。 */
export const SETUP_OPTIONAL_STEP = {
  key: 'voice' as const,
  label: '语音转文字（可选）',
  todo: '按需下载 whisper 引擎与模型后即可转写语音',
  done: '引擎已就绪',
}

/** 全未完成的事实（首帧渲染用，避免先显示成「已完成」再跳回来）。 */
export function emptyFacts(): SetupFacts {
  return {
    accounts: 0, dbDir: '', keysLoaded: false, keyCount: 0,
    dbKey: '', imgAes: '', cdnEnabled: false, voiceReady: false,
  }
}

/**
 * 某一步是否已完成。
 * @param key 步骤键。
 * @param facts 当前事实。
 * @returns 完成则 true。
 */
export function stepDone(key: SetupStepKey, facts: SetupFacts): boolean {
  switch (key) {
    case 'detect': return facts.accounts > 0 || facts.dbDir.trim() !== ''
    case 'dbkey': return (facts.keysLoaded && facts.keyCount > 0) || facts.dbKey.trim() !== ''
    case 'imgkey': return facts.imgAes.trim() !== ''
    case 'img': return facts.cdnEnabled
    default: return false
  }
}

/**
 * 整体进度（只算必做四步）。
 * @param facts 当前事实。
 * @returns 已完成数、总数、是否全部完成。
 */
export function setupProgress(facts: SetupFacts): { done: number; total: number; complete: boolean } {
  const total = SETUP_STEPS.length
  const done = SETUP_STEPS.filter((s) => stepDone(s.key, facts)).length
  return { done, total, complete: done === total }
}

/** 第一个未完成的必做步骤（「继续配置」按钮要落到哪一节）。 */
export function firstPendingStep(facts: SetupFacts): SetupStepKey {
  return SETUP_STEPS.find((s) => !stepDone(s.key, facts))?.key ?? SETUP_STEPS[0].key
}
