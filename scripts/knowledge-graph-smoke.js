#!/usr/bin/env node
'use strict';

/**
 * 知识图谱后端冒烟：不启动 Electron，直接构造后端验证笔记存储与知识图谱契约。
 *
 * 覆盖：
 *   · @Remote 方法表含 getNotes / saveNote / deleteNote / getKnowledgeGraph（装饰器语义没坏）；
 *   · [[链接]] 解析成边、未解析目标保留为 stub（不报错、不丢信息）；
 *   · 反链/出链计数、同名标题拒绝；
 *   · 问答沉淀（sourceKind:'ask' + sourceUsername）带出 sessionNames（融合视图的连接点）；
 *   · **删除笔记后指向它的链接退回 stub**（本设计的核心承诺）。
 *
 * 用法：node scripts/knowledge-graph-smoke.js
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { createWechatBackend } = require('../src/backend/wechat-host');

/** 本功能新增的 Remote 方法（缺任何一个都算失败）。 */
const REQUIRED_METHODS = ['getNotes', 'saveNote', 'deleteNote', 'getKnowledgeGraph'];

let failed = 0;
function check(label, ok, extra = '') {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
}

/** 取一条边（无则 undefined）。 */
function edgeOf(edges, source, target) {
  return edges.find(e => e.source === source && e.target === target);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'supertime-kb-'));
  const backend = await createWechatBackend({ userDataPath: tmp });
  try {
    // ── 1. 方法注册 ───────────────────────────────────────────────
    const methods = backend.methodNames();
    console.log(`Remote 方法总数: ${methods.length}`);
    for (const m of REQUIRED_METHODS) check(`方法已注册 ${m}`, methods.includes(m));

    // ── 2. 建两条互相引用的笔记 + 一条未解析链接 ──────────────────
    const a = await backend.call('saveNote', [{
      title: '项目组',
      body: '成员见 [[李四]] 与 [[王五]]，详见 [[李四|李四同学]]',
      tags: ['工作', '团队'],
    }]);
    check('创建笔记「项目组」', a.ok && a.value.ok === true, a.error || JSON.stringify(a.value));
    const aId = a.value && a.value.id;

    const b = await backend.call('saveNote', [{ title: '李四', body: '负责 [[项目组]]' }]);
    check('创建笔记「李四」', b.ok && b.value.ok === true, b.error || JSON.stringify(b.value));
    const bId = b.value && b.value.id;

    // 同名（大小写/空白不同）应被拒，否则 [[链接]] 解析会有歧义
    const dup = await backend.call('saveNote', [{ title: '  项目组 ', body: '重复' }]);
    check('同名标题被拒', dup.ok && dup.value.ok === false, dup.value && dup.value.error);

    // 空标题应被拒
    const blank = await backend.call('saveNote', [{ title: '   ', body: 'x' }]);
    check('空标题被拒', blank.ok && blank.value.ok === false, blank.value && blank.value.error);

    // ── 3. 列表 ─────────────────────────────────────────────────
    const notes = await backend.call('getNotes', [{}]);
    check('getNotes 返回 2 条', notes.ok && notes.value.total === 2, notes.ok ? `total=${notes.value.total}` : notes.error);
    const titleA = notes.ok ? notes.value.items.find(n => n.id === aId) : undefined;
    check('列表项带标签与出链', !!titleA && titleA.tags.length === 2 && titleA.links.length === 2,
      titleA ? `tags=${titleA.tags.join('/')} links=${titleA.links.join('/')}` : 'missing');

    // ── 4. 知识图谱：边 / stub / 计数 ────────────────────────────
    const g = await backend.call('getKnowledgeGraph', []);
    if (!g.ok) { check('getKnowledgeGraph 可用', false, g.error); throw new Error('graph unavailable'); }
    const snap = g.value;
    console.log(`\n知识图谱：笔记 ${snap.summary.noteCount} · wiki 边 ${snap.summary.linkCount} · stub ${snap.summary.stubCount} · 孤立 ${snap.summary.orphanCount}`);

    check('noteCount=2', snap.summary.noteCount === 2, String(snap.summary.noteCount));
    check('note→note 双向边存在',
      !!edgeOf(snap.edges, `note:${aId}`, `note:${bId}`) && !!edgeOf(snap.edges, `note:${bId}`, `note:${aId}`));
    check('重复引用合并为一条边（李四出现 2 次）',
      (edgeOf(snap.edges, `note:${aId}`, `note:${bId}`) || {}).weight === 2,
      String((edgeOf(snap.edges, `note:${aId}`, `note:${bId}`) || {}).weight));
    check('未解析「王五」成为 stub',
      snap.stubs.length === 1 && snap.stubs[0].label === '王五' && snap.stubs[0].refCount === 1,
      JSON.stringify(snap.stubs));
    check('stub 边存在且 kind=stub',
      (edgeOf(snap.edges, `note:${aId}`, 'kb:王五') || {}).kind === 'stub');
    const na = snap.notes.find(n => n.id === aId);
    const nb = snap.notes.find(n => n.id === bId);
    check('出链/反链计数正确', na && nb && na.outLinks === 2 && nb.outLinks === 1 && na.backLinks === 1 && nb.backLinks === 1,
      na && nb ? `A out=${na.outLinks} back=${na.backLinks} | B out=${nb.outLinks} back=${nb.backLinks}` : 'missing');
    check('摘要无孤立节点', snap.summary.orphanCount === 0, String(snap.summary.orphanCount));

    // ── 5. 问答沉淀：带出来源会话（融合视图的连接点）─────────────
    const ask = await backend.call('saveNote', [{
      title: '关于交付节奏的结论',
      body: '结论源自 [[项目组]] 的讨论',
      sourceKind: 'ask',
      sourceUsername: 'wxid_demo_user',
      sourceQuestion: '项目组最近在讨论什么？',
    }]);
    check('沉淀问答笔记', ask.ok && ask.value.ok === true, ask.error || JSON.stringify(ask.value));

    const g2 = await backend.call('getKnowledgeGraph', []);
    const snap2 = g2.value;
    check('sessionNames 带出来源会话',
      snap2.sessionNames.wxid_demo_user === 'wxid_demo_user',
      JSON.stringify(snap2.sessionNames));
    check('askCount=1 / manualCount=2',
      snap2.summary.askCount === 1 && snap2.summary.manualCount === 2,
      `ask=${snap2.summary.askCount} manual=${snap2.summary.manualCount}`);

    // ── 6. 删除笔记 → 指向它的链接退回 stub（核心承诺）──────────
    const del = await backend.call('deleteNote', [{ id: bId }]);
    check('删除笔记「李四」', del.ok && del.value.ok === true, del.error || JSON.stringify(del.value));

    const g3 = await backend.call('getKnowledgeGraph', []);
    const snap3 = g3.value;
    check('删除后 noteCount=2（含沉淀笔记）', snap3.summary.noteCount === 2, String(snap3.summary.noteCount));
    check('指向已删除笔记的链接变成 stub',
      snap3.stubs.some(s => s.label === '李四'),
      JSON.stringify(snap3.stubs.map(s => s.label)));
    check('指向已删除笔记的边 kind=stub',
      (edgeOf(snap3.edges, `note:${aId}`, 'kb:李四') || {}).kind === 'stub');

    // ── 7. 更新笔记保持 id ──────────────────────────────────────
    const upd = await backend.call('saveNote', [{ id: aId, title: '项目组', body: '改过了 [[王五]]' }]);
    check('更新笔记复用原 id', upd.ok && upd.value.ok === true && upd.value.id === aId, JSON.stringify(upd.value));
    const g4 = await backend.call('getKnowledgeGraph', []);
    const na4 = g4.value.notes.find(n => n.id === aId);
    check('更新后出链收敛为 1', na4 && na4.outLinks === 1, na4 ? String(na4.outLinks) : 'missing');
  } finally {
    try { backend.dispose(); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (failed > 0) { console.log(`\n❌ 知识图谱冒烟失败：${failed} 项`); process.exit(1); }
  console.log('\n✅ 知识图谱后端冒烟通过');
}

main().catch((e) => { console.error('❌ 冒烟异常:', e); process.exit(1); });
