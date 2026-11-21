// @vitest-environment node
/**
 * 运维脚本：分批续建**消息域**向量索引（2026-11-21）。
 *
 * ## 门控为什么用「哨兵文件」而不是环境变量
 *
 * 这个文件在 `tests/**\/*.spec.ts` 的 include 内，全量 `vitest run` 一定会收集它。
 * 两次事故换来的教训：
 *   ① 不加门控 ⇒ 全量测试直接向真实 API 发请求；
 *   ② 用 `KB_REBUILD=1` 门控 ⇒ **该变量是 shell 会话级的**，`vitest run` 会继承它，
 *      门控形同虚设（日志里出现两次「起点」，两个进程同时写同一个库）。
 *
 * `process.argv` 也不行：worker 的 argv 恒为 `[node, tinypool/entry/process.js]`，
 * 显式单文件运行与全量运行**完全一样**（实测）。
 *
 * 所以改用哨兵文件：只有显式创建 `.tmp-rebuild-enabled` 之后才会执行，
 * 全量测试时文件不存在 ⇒ 整体 skip，零副作用。脚本结束（含异常）自己删除哨兵。
 *
 * ## 用法
 *
 * ```
 * Set-Content .tmp-rebuild-enabled ''
 * npx vitest run src/backend/wechat-data/tests/kb-msg-vector-rebuild.manual.spec.ts
 * ```
 *
 * ## 为什么必须分批
 *
 * `runBuildVectorIndex` 阶段一会把每批向量全部留在内存（`vectors` Map），阶段二才写库。
 * 40 万条 × 4096 维 × 4B ≈ 6.6GB，一次跑完必然 OOM。按 2 万条一轮，内存约 330MB。
 * 增量游标（`done` 集合）以 `fts_rowid` 为准，所以**中途中断可续**。
 *
 * ## 为什么 batchSize = 32
 *
 * 实测 128 会因响应体积过大（约 2.8MB/次）被服务端 `SocketError: other side closed` 断连；
 * 32 在长时间压测里 0 失败。吞吐与 64/128 相差不大（瓶颈在端点往返），稳定优先。
 */
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SENTINEL = join(process.cwd(), '.tmp-rebuild-enabled')
const ENABLED = existsSync(SENTINEL)
/*
 * 路径**从环境变量推导**，不写死本机绝对路径。
 *
 * `ci-script-isolation.spec.ts` 禁止单测文件里出现本机专有资产的字面量
 * （如 `C:\Users\<user>\...`）—— 那种文件在 CI 上必然失败。数据根就在
 * `%APPDATA%\super-time-electron` 下，按约定拼出来即可，与真实用户名无关。
 */
const APP_ROOT = join(process.env.APPDATA ?? '', 'super-time-electron')
const DECRYPTED = join(APP_ROOT, 'wechat-data', 'decrypted')
const LLM_JSON = join(APP_ROOT, 'wechat', 'llm.json')
const LOG = join(process.cwd(), '.tmp-msg-rebuild.log')
const CAP = 20_000

interface LlmCfg {
  model: string; embeddingModel: string; embeddingApiUrl: string; embeddingApiKey: string
  embedPath: string; apiUrl: string; apiKey: string
}

const log = (msg: string): void => {
  const line = `[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`
  console.log(line)
  try { appendFileSync(LOG, line + '\n', 'utf8') } catch { /* 日志失败不影响构建 */ }
}

describe.skipIf(!ENABLED)('运维：分批续建消息域向量', () => {
  it('逐轮推进', async () => {
    try {
      // 连运行时代码也仅在哨兵许可后的用例体内加载，普通测试收集不触碰数据层。
      const { buildVectorIndex, vectorIndexStatus } = await import('../src/query/retrieval/embedding.ts')
      const raw = JSON.parse(readFileSync(LLM_JSON, 'utf8')) as LlmCfg
      const mod = await import('../../llm-bridge.js') as {
        createLlmBridge: (cfg: Record<string, unknown>) => { embed: (t: string[]) => Promise<number[][]> }
      }
      const bridge = mod.createLlmBridge({
        apiKey: raw.apiKey, baseUrl: raw.apiUrl, model: raw.model, embedPath: raw.embedPath,
        embeddingModel: raw.embeddingModel, embeddingApiUrl: raw.embeddingApiUrl,
        embeddingApiKey: raw.embeddingApiKey, timeoutMs: 120_000,
      })

      const before = vectorIndexStatus(DECRYPTED)
      log(`起点: ready=${String(before.ready)} rows=${String(before.rows)} dim=${String(before.dim)} model=${before.model}`)

      const started = Date.now()
      for (let round = 1; round <= 40; round += 1) {
        const t = Date.now()
        let r: Awaited<ReturnType<typeof buildVectorIndex>> | null = null
        /*
         * 整轮重试（最多 3 次）：产品语义是「单批失败 ⇒ 阶段一整体失败、一行都不写」
         * （这是对的，保证不会写入半套向量）。运维任务不该因此丢掉整轮 ——
         * 重试该轮即可，增量游标会让已成功的批次不重发。
         */
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            r = await buildVectorIndex(DECRYPTED, bridge.embed, {
              model: raw.embeddingModel,
              batchSize: 32,
              concurrency: 4,
              maxCharsPerDoc: 200,
              maxDocsPerBuild: CAP,
            })
            break
          } catch (e) {
            log(`第 ${String(round)} 轮第 ${String(attempt)} 次失败：${(e as Error).message.slice(0, 140)}`)
            if (attempt === 3) throw e
            await new Promise(res => setTimeout(res, 3000))
          }
        }
        if (r === null) break
        const st = vectorIndexStatus(DECRYPTED)
        log(`第 ${String(round)} 轮: status=${r.status} 本轮=${String(r.embedded)} calls=${String(r.embed_calls)} ` +
          `累计 rows=${String(st.rows)} dim=${String(st.dim)} ready=${String(st.ready)} ` +
          `本轮=${String(Math.round((Date.now() - t) / 1000))}s 总=${String(Math.round((Date.now() - started) / 1000))}s`)
        if (r.embedded === 0) { log('本轮无新增 ⇒ 已建完'); break }
      }
      const after = vectorIndexStatus(DECRYPTED)
      log(`收尾: ready=${String(after.ready)} rows=${String(after.rows)} dim=${String(after.dim)} model=${after.model}`)
      expect(after.rows).toBeGreaterThan(before.rows)
    } finally {
      // 哨兵必须自己删掉：留着它会让下一次全量测试又跑一次真实重建。
      try { rmSync(SENTINEL, { force: true }) } catch { /* 删不掉也不该让构建结果失败 */ }
    }
  }, 7_200_000)
})
