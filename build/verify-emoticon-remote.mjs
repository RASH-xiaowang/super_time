import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

const mod = await import('file:///D:/super-time-wechat/src/backend/wechat-data/lib/index.js')
const names = remoteMethods(mod.WechatDataGateway.prototype).map((m) => m.exportName || m.method)
const has = names.includes('getEmoticonDataUrl')
console.log('methods', names.length)
console.log('getEmoticonDataUrl', has ? 'OK' : 'MISSING')
if (!has) process.exit(1)
