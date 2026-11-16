/**
 * 本机进程存活探测。
 *
 * 只用于判断「某个 pid 是否还在跑」——例如消息列表投递认领者是否已经退出，
 * 以决定能否立即把卡住的 `dispatching` 收口为 `sent_unconfirmed`。
 * 不读取进程命令行、不采集任何进程信息，只调用 `kill(pid, 0)` 做存在性探测。
 */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM 表示进程存在但无权发信号：仍算存活。
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
