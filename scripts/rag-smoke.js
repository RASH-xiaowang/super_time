#!/usr/bin/env node
'use strict';

/**
 * 后端冒烟：不启动 Electron，直接构造后端并验证 RAG 检索层的新 Remote 方法。
 *
 * 覆盖：
 *   · bundle 能加载、@Remote 方法表包含全部 RAG 方法（装饰器语义没坏）；
 *   · evaluateRetrieval 能跑出指标（混合 vs 纯稀疏）；
 *   · getRetrievalStatus / saveRetrievalConfig / submitAskFeedback / listRetrievalFeedback 可用；
 *   · 检索参数能落盘并读回。
 *
 * 用法：node scripts/rag-smoke.js
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { createWechatBackend } = require('../src/backend/wechat-host');

/** RAG 层新增的 Remote 方法（缺任何一个都算失败）。 */
const RAG_METHODS = [
  'getRetrievalStatus',
  'saveRetrievalConfig',
  'buildRagVectorIndex',
  'submitAskFeedback',
  'listRetrievalFeedback',
  'resetRetrievalWeights',
  'evaluateRetrieval',
];

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'supertime-rag-'));
  const backend = await createWechatBackend({ userDataPath: tmp });
  let failed = 0;
  try {
    const methods = backend.methodNames();
    console.log(`Remote 方法总数: ${methods.length}`);
    for (const m of RAG_METHODS) {
      const ok = methods.includes(m);
      if (!ok) failed += 1;
      console.log(`  ${ok ? '✅' : '❌'} ${m}`);
    }

    const status = await backend.call('getRetrievalStatus');
    if (!status.ok) { console.log('❌ getRetrievalStatus:', status.error); failed += 1; }
    else {
      console.log(`\ngetRetrievalStatus: enabled=${status.value.enabled} 向量库 ${status.value.vector.rows} 条（dim=${status.value.vector.dim}）`);
      console.log(`  意图分类自评: ${status.value.intentAccuracy.correct}/${status.value.intentAccuracy.total} = ${(status.value.intentAccuracy.accuracy * 100).toFixed(1)}%`);
    }

    const evalRes = await backend.call('evaluateRetrieval', [{ k: 10 }]);
    if (!evalRes.ok) { console.log('❌ evaluateRetrieval:', evalRes.error); failed += 1; }
    else {
      console.log('\n' + evalRes.value.report);
    }

    const saved = await backend.call('saveRetrievalConfig', [{ patch: { fusion: { k: 42 } } }]);
    if (!saved.ok || saved.value.config.fusion.k !== 42) { console.log('❌ saveRetrievalConfig:', saved.error || 'k!=42'); failed += 1; }
    else console.log('\nsaveRetrievalConfig: fusion.k=42 ✅');

    const fb = await backend.call('submitAskFeedback', [{ rating: 'up', useful: [] }]);
    if (!fb.ok) { console.log('❌ submitAskFeedback:', fb.error); failed += 1; }
    else console.log(`submitAskFeedback: ok，权重 sparse=${fb.value.adaptedWeights.sparse.toFixed(3)}`);

    const list = await backend.call('listRetrievalFeedback', [{ limit: 5 }]);
    if (!list.ok) { console.log('❌ listRetrievalFeedback:', list.error); failed += 1; }
    else console.log(`listRetrievalFeedback: 共 ${list.value.stats.total} 条（up ${list.value.stats.up} / down ${list.value.stats.down}）`);
  } finally {
    try { backend.dispose(); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (failed > 0) { console.log(`\n❌ 冒烟失败：${failed} 项`); process.exit(1); }
  console.log('\n✅ RAG 后端冒烟通过');
}

main().catch((e) => { console.error('❌ 冒烟异常:', e); process.exit(1); });
