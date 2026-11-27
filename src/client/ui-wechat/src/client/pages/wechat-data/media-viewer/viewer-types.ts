/** 统一查看器的公共类型（组件与缓存 hook 共用，避免循环依赖）。 */
export interface ViewerSource {
  /** 稳定键（缓存/预取按它去重）。 */
  key: string
  /** 已可用的缩略图 URL：原图未到时先显示它（可选）。 */
  thumb?: string | undefined
  /** 按需解析可渲染的 URL（data:/wechat-media:/blob:）；失败抛错。 */
  load: (options?: { retry?: boolean }) => Promise<string>
  /** 顶部信息条标题。 */
  title?: string | undefined
  /** 顶部信息条副标题（大小/来源等）。 */
  subtitle?: string | undefined
  /** 资源类型（默认 image）。 */
  kind?: 'image' | 'video' | undefined
  /** 视频开始播放时的定位点（毫秒）；实况照片用它对齐静态帧。 */
  startAtMs?: number | undefined
  /** 下载文件名（默认按 key 猜一个）。 */
  downloadName?: string | undefined
  /** 自定义下载动作（例如后端原文件写盘）；不给则用 `<a download>`。 */
  onDownload?: ((src: string) => void | Promise<void>) | undefined
  /** 当前环境不能执行这个下载动作时禁用按钮（例如手机端保存原文件）。 */
  downloadDisabled?: boolean | undefined
  /** 禁用下载时给用户的明确原因。 */
  downloadDisabledReason?: string | undefined
}
