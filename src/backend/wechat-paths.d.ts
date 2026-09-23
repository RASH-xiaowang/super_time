/**
 * `wechat-paths.js` 的类型面 —— **手写**声明（H11 的 `llm-retry.d.ts` 同一套路），不是构建产物。
 *
 * 为什么不交给 tsc 从 JSDoc 生成：宿主 JSDoc 里那些 `@returns {object}` / `@param {{…}}`
 * 一旦变成真声明，就比 `any` 更窄**而且错** —— 实测会把测试面的错误数从 74 顶到 120
 * （`store.profiles` 每一行都成了 `object`，读任何字段都报 TS2339）。
 * 生成能保住「形状对得上」，保不住「形状别写错」，所以这里由人写、由
 * `tests/host-decl-alignment.spec.ts` 盯着**双向差集**：漏一个导出＝地图缺一块，
 * 多一个导出＝发明了一个运行时不存在的成员（类型全绿、运行时无定义，最坏的那种）。
 *
 * 只声明模块真正对外提供的东西；实现内部细节不在这里露面。
 */

/**
 * 设定运行期状态目录（主进程与后端进程都要调用，且必须传同一个 userData）。
 * @param options.userDataPath - Electron `app.getPath('userData')`。
 * @param options.legacyAssetsDir - 老配置所在目录，默认随包资产目录（参数供单测注入）。
 * @returns 状态目录绝对路径。
 */

/**
 * 配置文件的值：JSON 里能出现的那几种。留 `undefined` 是因为
 * 「键不存在」与「键存在但值为 null」在 M1 之后是两件事（后者会真的清空）。
 */
export type ConfigValue = string | number | boolean | null | undefined

/** `resolvePaths` 的产物：哪些键从 env / 参数 / 配置文件哪一层来的。内容随版本变，按开放对象处理。 */
export type ResolvedInfo = Record<string, unknown>

/**
 * 微信自身的设置快照（键名就是微信里的配置名，如 `_db_dir`、`_nchat_rate`）。
 * **必须带索引签名**：调用方（含单测）按字符串键取值是常态。
 */
export type WechatSettings = Record<string, ConfigValue> & { _db_dir?: string }

/** 宿主配置（路径 + 微信设置），见 `resolvePaths` / `loadConfig`。 */
export interface HostConfig {
  dataRoot: string
  decryptedDir: string
  decodedImagesDir: string
  sourceDir: string
  baseDir: string
  selfWxid: string
  silkBinary: string
  resolved: ResolvedInfo
  wechatSettings: WechatSettings
  wechatSettingsMeta: Record<string, unknown>
  [k: string]: unknown
}

/**
 * 一份模型配置的全部可配字段（与 `defaultLlmConfig()` 一一对应）。
 *
 * **故意不开索引签名**：`saveLlmConfig` 只认 `Object.keys(defaultLlmConfig())` 里的那些键，
 * 多给的键会被**静默丢掉**（wechat-paths.js 里那句 `for (const k of Object.keys(base))`）。
 * 一旦这里写成 `Record<string, unknown>`，「把 `embeddingApiUrl` 拼错成 `embeddingApiUrl2`」
 * 就又能变成一个悄悄不生效的键 —— 那正是 `saveSummaryTask` 那刀（#82）刚清掉的那类坑。
 */
export interface LlmConfig {
  provider: string
  model: string
  apiKey: string
  apiUrl: string
  apiPath: string
  embeddingModel: string
  embedPath: string
  embeddingApiUrl: string
  embeddingApiKey: string
  rerankModel: string
  rerankPath: string
  rerankApiUrl: string
  rerankApiKey: string
  timeoutMs: number
  rerankTimeoutMs: number
}

/**
 * 一条已保存的模型配置。`id` / `label` / `usedAt` 是它自己的元数据，其余就是 {@link LlmConfig} 那套。
 * 能按必填写是因为 `normalizeLlmProfile` **先补默认值再返回**（见 wechat-paths.js 里
 * 「补缺省字段、id/label 可读、usedAt 数值化」那条注释），不是 `Partial`。
 */
export interface LlmProfile extends LlmConfig {
  id: string
  label: string
  usedAt: number
}

/** `loadLlmStore` 与三个 profile 变更函数的返回：当前生效配置 + 已保存的配置集。 */
export interface LlmStore {
  config: LlmConfig
  profiles: LlmProfile[]
  activeProfileId: string
}

/** 建 profile 的入参：`id` 省略就是新增；`config` 只给要改的那几个字段。 */
export interface UpsertLlmProfileInput {
  id?: string
  label?: string
  config?: Partial<LlmConfig>
  activate?: boolean
}

/** `configure` 的入参（宿主路径配置）。 */
export interface ConfigureOptions {
  stateDir?: string
  resourcesPath?: string
  isPackaged?: boolean
  env?: NodeJS.ProcessEnv
  [k: string]: unknown
}

export function configure(options?: ConfigureOptions): string;
/** 运行期状态目录。 */
export function stateDirPath(): string;
/** 随包分发的只读资产目录。 */
export function assetsDirPath(): string;
/** 是否运行在打包态。 */
/** 路径配置文件路径（外部可读）。 */
export function isPackaged(): boolean;
export function configPath(): string;
/** LLM 配置文件路径（微信问答模型配置）。 */
export function llmConfigPath(): string;
/** 读取 config.json（缺失或损坏时返回默认值）。 */
export function loadConfig(): HostConfig;
/** 将配置写入 config.json（自动创建状态目录）。 */
export function saveConfig(config: HostConfig): HostConfig;
/**
 * 把配置里非空的路径字段应用到 process.env（DSH_WECHAT_*）。
 * @param config - 可选，默认 loadConfig()；env - 可选，默认 process.env。
 */
export function applyConfig(config?: HostConfig, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/**
 * 把后端启动后解析到的真实路径记录到 config.json 的 resolved 节。
 * @param info - wechat-host 的 info() 返回值（root/decrypted/decoded/selfUsername）。
 */
export function recordResolved(info?: ResolvedInfo): ResolvedInfo;
/**
 * 把「数据配置」保存的微信设置 (db_dir/开关等) 镜像到 config.json，供用户查看/手工编辑。
 * **派生字段一律不镜像**（见 DERIVED_SETTING_KEYS）：它们随安装位置与数据根变化，
 * 镜像过去只会把别的机器/别的安装位置的路径推回来。
 * **凭据字段也不镜像**（见 SECRET_SETTING_KEYS）：它们有单独的、受权限保护的文件。
 *
 * **是合并不是整体替换**：这个函数不只被界面保存调用，也会被主进程的内部保存调用
 * （启动期把旧密钥交给后端、空 patch 保存等），而那些 patch 往往是**部分字段**。
 * 整体替换会让一次内部保存把镜像里的普通设置全部抹掉（实测踩过两次：空 patch 保存 +
 * 只在镜像里的密钥搬迁），而镜像本来就是「最近一次设置的样子」，合并才是正确语义。
 * 界面的保存会带上全部字段，所以对它而言合并与替换等价。
 * @param settings - saveWechatConfig 的 patch（不写入元数据字段）。
 */
export function recordWechatSettings(settings?: WechatSettings): WechatSettings;
/** 读取 config.json 中记录过的微信设置（patch 形态，派生字段已剔除）。 */
export function loadWechatSettings(): WechatSettings;
/**
 * 取出宿主镜像里的密钥字段（**只读，不删除**）。
 *
 * 为什么需要：`saveWechatConfig` 返回前 `wechat-host.js` 会调 `recordWechatSettings(patch)`
 * 把整份镜像**重写**成「已过滤密钥」的干净版 —— 那些**只存在于镜像里**的密钥（后端
 * config.json 里没有对应值 → `saveConfig` 的 `carried` 也捞不到）会在那一步被无声丢掉。
 * 所以调用方（`main.js` 的 `applySavedWechatSettings`）必须把它们**并进同一次回灌 patch**：
 * 后端会把它们写进 `secrets.json`，而回写镜像时会顺手把副本过滤掉 —— 迁移与去副本一步完成，
 * 也就不需要再单独「清理镜像」了（原先那个 `pruneMirroredSecrets` 因此删掉：正常顺序下它
 * 永远是空转，留着只会让人以为它在干活）。
 *
 * 这里不做「值是否等于默认值」的判断：后端 `saveConfig` 的 `secretIsMeaningful` 才是唯一
 * 口径（宿主层再抄一份默认值只会漂移）。空串这里就滤掉，省一次无意义的 RPC 字段。
 * @returns {Record<string, unknown>} 非空的密钥字段。
 */
export function mirroredSecretValues(): Record<string, unknown>;
/** 读取 LLM 配置（缺失时返回默认值）。 */
export function loadLlmConfig(): {
    provider: string;
    model: string;
    apiKey: string;
    apiUrl: string;
    apiPath: string;
    embeddingModel: string;
    embedPath: string;
    embeddingApiUrl: string;
    embeddingApiKey: string;
    rerankModel: string;
    rerankPath: string;
    rerankApiUrl: string;
    rerankApiKey: string;
    rerankTimeoutMs: number;
    timeoutMs: number;
};
/**
 * 保存「当前配置」表单。
 *
 * 顶层扁平字段照旧写入（老路径不变）；同时**更新使用中的那条 profile** ——
 * 否则「改了表单再保存」之后切换条上显示的还是旧值，点它反而会把刚做的改动顶掉。
 * 没有任何 profile 时**不自动创建**：新增走显式的 `upsertLlmProfile`，
 * 免得用户只是改了个字段就凭空多出一条配置。
 * @param {object} cfg - 扁平配置（字段名与 llm.json 顶层一致）。
 * @returns {object} 落盘后的扁平配置。
 */
/**
 * 写 llm.json。**入参是给到的那部分，不是整份**：实现会先把磁盘上的旧值合进来
 * （见 wechat-paths.js 里 `saveLlmConfig` 走的那条 merge 路径），所以调用方通常只带
 * 一两个字段。返回落盘后的**完整**配置。
 */
export function saveLlmConfig(cfg: Partial<LlmConfig>): LlmConfig;
/**
 * 读「当前生效配置 + 已保存的模型配置」。
 *
 * 顶层扁平字段**仍是当前生效值的权威**：`loadLlmConfig`（每次请求都会调）与旧版本读取
 * 都只认它，所以升级、回退都不会坏。`profiles` / `activeProfileId` 是新增的配置集。
 *
 * 懒迁移：老文件只有扁平字段、没有任何 profiles 时，按它生成一条 profile 并认作使用中。
 * 不做这一步的话，界面会出现「徽标说已配置、切换条却空着」的自相矛盾 ——
 * 这个文件里已经因为同类矛盾修过一次（配置模板下拉的回填）。
 * @returns {{config: object, profiles: Array<object>, activeProfileId: string}}
 */
export function loadLlmStore(): LlmStore;
/**
 * 切换使用中的模型配置。
 *
 * 成套切换是这里的核心不变量（见 `LLM_PROFILE_FIELDS` 的说明）；因为 wechat-host 每次请求
 * 都重读 llm.json（`llmConfigFromEnv`），切换后**下一次提问立即生效，不需要重启应用**。
 * @param {string} id - 目标 profile id。
 * @returns {{config: object, profiles: Array<object>, activeProfileId: string}}
 */
export function activateLlmProfile(id: string): LlmStore;
/**
 * 新增 / 更新一条模型配置。
 * @param {object} options - { id?: string, label?: string, config?: object, activate?: boolean }
 *   缺 `id` 为新增；`activate` 默认为 true（新增出来就是想用它）。
 * @returns {{config: object, profiles: Array<object>, activeProfileId: string}}
 */
export function upsertLlmProfile(options?: UpsertLlmProfileInput): LlmStore;
/**
 * 删除一条模型配置。
 *
 * 两条硬规则：① 至少保留一条 —— 删空之后切换条与「已配置」徽标必然互相矛盾；
 * ② 删掉的正是使用中的那条时，自动切到最近使用的一条，否则顶层「当前生效值」会指向
 * 一个已不存在的配置。
 * @param {string} id - 目标 profile id（不存在时原样返回，不报错）。
 * @returns {{config: object, profiles: Array<object>, activeProfileId: string}}
 */
export function deleteLlmProfile(id: string): LlmStore;
/**
 * 一条模型配置里「成套」的字段。
 *
 * 为什么必须成套：这些字段描述的是**同一家厂商的同一次连接**。只换其中几项会拼出
 * 「A 家的地址 + B 家的 Key」这种组合 —— 下一次提问必然 401，而用户从界面上看不出问题在哪
 * （历史上「套用厂商模板只改供应商/模型/地址、Key 保留旧值」就是这个毛病）。
 */
export const LLM_PROFILE_FIELDS: string[];
export namespace FIELD_TO_ENV {
    let dataRoot: string;
    let decryptedDir: string;
    let decodedImagesDir: string;
    let sourceDir: string;
    let baseDir: string;
    let selfWxid: string;
    let silkBinary: string;
}
/**
 * 由运行环境自行解析、**不该跨机复用**的设置项。
 *
 * 它们都是绝对路径，且要么随安装位置变化（whisper 引擎/模型），要么随数据根变化
 * （decrypted/decoded/keys）。后端每次启动都会按当前机器重新解析，所以镜像里
 * 一旦留下它们，就只会把「上一台机器/上一次安装位置」的路径再推回后端。
 */
export const DERIVED_SETTING_KEYS: Set<string>;
/**
 * 凭据类设置项：**不镜像**进 config.json。
 *
 * 理由：config.json 是「用户可手工编辑、出问题会被整目录拷贝或交给支持人员」的文件
 * （H1/N6 那条泄漏路径的载体），密钥镜像一份进去等于凭空多一份副本。
 * 密钥的真源是后端写的 `<STATE_DIR>/secrets.json`（见 `config/wechat-config.ts` 的
 * `SECRET_FIELDS` —— M24 之后配置实现从 `query/config.ts` 下沉到了 `config/` 层，
 * `query/config.ts` 现在只是转发门面）。
 */
export const SECRET_SETTING_KEYS: Set<string>;
/**
 * 原子写：先写同目录临时文件，再 rename 覆盖目标。
 *
 * 为什么不直接 writeFileSync：写一半被杀进程 / 磁盘满，目标文件会变成**截断的 JSON**。
 * 而 config.json 里既有数据根路径、也有微信设置镜像（历史上还放过解密密钥），
 * 读到截断内容会静默回落默认值 —— 用户看到的现象是「配置莫名其妙丢了」，
 * 而且**下一次保存就把残缺内容覆盖掉**，原始字节再也找不回来。
 * rename 在同一卷上是原子的：要么是旧文件，要么是完整的新文件。
 * @param {string} target - 目标文件绝对路径。
 * @param {string} text - 要写入的文本。
 */
export function writeFileAtomic(target: string, text: string): void;
export function preserveIfUnparseable(target: string): void;
/**
 * 生成**可安全迁移**的 `config.json` 内容。
 *
 * 顶层路径字段（`dataRoot` / `decryptedDir` / `decodedImagesDir` / `sourceDir` / `baseDir` /
 * `selfWxid` / `silkBinary` / `resolved`）**一律不迁移**：它们要么指向真实数据源、要么是
 * 上一台机器/上一次安装位置解析出来的绝对路径。剔除后应用会在新状态下重新解析，
 * 并在需要用户确认数据源时报「数据源未配置」，而不是拿旧路径直接开工。
 * @param raw - 仓库 `wechat/config.json` 的解析结果（可能是任意形状）。
 * @returns `{ config, dropped }`：待写入的内容，以及被剔除的字段名（用于日志）。
 */
export function sanitizeMigratedConfig(raw: unknown): {
    config: HostConfig;
    dropped: string[];
};
/**
 * 开发态一次性迁移：把项目 `wechat/` 下的老配置搬进 STATE_DIR。
 * 打包态直接返回 —— 安装目录里的任何配置都不许被继承（跨机泄漏的根源）。
 *
 * `config.json` 走 `sanitizeMigratedConfig`（数据源与凭据不搬，N6）；`llm.json` 原样搬。
 * 任一步失败都只影响该文件，且不会中断启动。
 * @param legacyDir - 老配置所在目录；默认随包资产目录（参数供单测注入临时布局）。
 */
export function migrateLegacyState(legacyDir?: string): void;
