/** 把 `<video>` 的 MediaError 翻成用户能据此行动的中文说明。 */
export function videoPlaybackErrorText(error: MediaError | null | undefined): string {
  switch (error?.code) {
    case 1:
      return '视频加载被中断，请重试'
    case 2:
      return '视频读取失败，请确认文件已经完整下载'
    case 3:
      return '视频解码失败，文件可能损坏或编码不受支持'
    case 4:
      return '当前播放器不支持该视频编码，或文件不完整'
    default:
      return '视频无法播放，请重试'
  }
}
