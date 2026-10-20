/**
 * 错误码参考（设置 → 高级里的「错误码参考」折叠卡）。
 *
 * 数据只收 `docs/ERROR-CODES.md` 第 2/3 节里**有机器码**、用户真会撞上的项；
 * 不复制文档全文，也不从运行时错误里反推（那会变成第二套错误源）。
 * 每条都给「是什么 / 怎么办」，避免只显示一个冷冰冰的 code。
 */
export interface ErrorCatalogEntry {
  code: string
  what: string
  fix: string
}

export const ERROR_CATALOG: readonly ErrorCatalogEntry[] = [
  {
    code: 'BACKEND_NOT_READY',
    what: '后端 worker 还在启动/重启，等待到上限仍未就绪。',
    fix: '稍后重试；持续出现看 wechat/logs 里的重启记录。',
  },
  {
    code: 'LICENSE_CHECK_FAILED',
    what: '授权校验自身异常（许可证文件损坏/读盘失败/指纹异常）。',
    fix: '重新导入许可证；这是 fail-closed，不是放行。',
  },
  {
    code: 'LICENSE_REQUIRED',
    what: '本机没有可用许可证。',
    fix: '走激活流程重新签发/导入。',
  },
  {
    code: 'FEATURE_DENIED',
    what: '当前许可证的功能位不包含该方法所属功能。',
    fix: '升级到含该功能的授权。',
  },
  {
    code: 'REMOTE_BUSY',
    what: '并发闸已满（普通 32 / 重活 4），或交互请求挤出了低优先级等待项。',
    fix: '稍后重试或降低批量；这是背压，不是数据损坏。',
  },
  {
    code: 'QUEUE_WAIT_TIMEOUT',
    what: '请求在队列里等待超过上限（默认 240s），队列长期不排空。',
    fix: '稍后重试；查 backend-state.callQueue 的 queued/active 与积压方法。',
  },
  {
    code: 'MUTATION_DISPATCH_REVOKED',
    what: '写请求在队列里跨过了后端重启（旧 epoch），派发前被撤销。',
    fix: '重试保存/删除；这是防旧代际写落到新 worker，不是数据损坏。',
  },
  {
    code: 'ARGS_SCHEMA',
    what: '参数与该方法登记的生成 schema 不符，入口守卫直接拒绝。',
    fix: '检查调用参数形状；白名单外的方法会先记入 info().argGuard.mismatched。',
  },
]
