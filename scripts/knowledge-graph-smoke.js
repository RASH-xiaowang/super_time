#!/usr/bin/env node
'use strict';

/**
 * 知识图谱后端冒烟：不启动 Electron，直接构造后端验证笔记存储与知识图谱契约。
 *
 * 覆盖：
 *   · @Remote 方法表含笔记 CRUD / 知识图谱 / **知识库 CRUD**（装饰器语义没坏）；
 *   · [[链接]] 解析成边、未解析目标保留为 stub（不报错、不丢信息）；
 *   · 反链/出链计数、同名标题拒绝（**同一个库内**）；
 *   · 问答沉淀（sourceKind:'ask' + sourceUsername）带出 sessionNames；
 *   · **删除笔记后指向它的链接退回 stub**（本设计的核心承诺）；
 *   · **一库一图**：同一标题可在两个库各存一份、跨库同名不会被 [[链接]] 连上、
 *     `total` 只算本库、删库时笔记「搬走」或「一并删」两条路径。
 *
 * 用法：node scripts/knowledge-graph-smoke.js
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { createWechatBackend } = require('../src/backend/wechat-host');

/** 本功能新增的 Remote 方法（缺任何一个都算失败）。 */
const REQUIRED_METHODS = [
  'getNotes', 'saveNote', 'deleteNote', 'getKnowledgeGraph',
  'getKbs', 'createKb', 'renameKb', 'deleteKb',
];

/** 默认知识库 id（后端 `DEFAULT_KB_ID` 的镜像；这里写死是为了让冒烟能发现它被改掉）。 */
const KB = 1;

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

    // 新装一个库就有默认库，且列表要能读出来
    const kb0 = await backend.call('getKbs', []);
    check('getKbs 初始只有默认库',
      kb0.ok && kb0.value.total === 1 && kb0.value.items[0].id === KB && kb0.value.items[0].noteCount === 0,
      kb0.ok ? JSON.stringify(kb0.value.items) : kb0.error);

    // ── 2. 建两条互相引用的笔记 + 一条未解析链接 ──────────────────
    const a = await backend.call('saveNote', [KB, {
      title: '项目组',
      body: '成员见 [[李四]] 与 [[王五]]，详见 [[李四|李四同学]]',
      tags: ['工作', '团队'],
    }]);
    check('创建笔记「项目组」', a.ok && a.value.ok === true, a.error || JSON.stringify(a.value));
    const aId = a.value && a.value.id;

    const b = await backend.call('saveNote', [KB, { title: '李四', body: '负责 [[项目组]]' }]);
    check('创建笔记「李四」', b.ok && b.value.ok === true, b.error || JSON.stringify(b.value));
    const bId = b.value && b.value.id;

    // 同名（大小写/空白不同）应被拒，否则 [[链接]] 解析会有歧义
    const dup = await backend.call('saveNote', [KB, { title: '  项目组 ', body: '重复' }]);
    check('同名标题被拒', dup.ok && dup.value.ok === false, dup.value && dup.value.error);

    // 空标题应被拒
    const blank = await backend.call('saveNote', [KB, { title: '   ', body: 'x' }]);
    check('空标题被拒', blank.ok && blank.value.ok === false, blank.value && blank.value.error);

    // 漏传 kbId 必须被运行期守卫拦下（Remote 边界是 JSON，TypeScript 拦不住）
    const noKb = await backend.call('saveNote', [{ title: '没有库' }]);
    check('漏传 kbId 被拒（不静默落到某个库）',
      noKb.ok && noKb.value.ok === false && /知识库标识无效/.test(String(noKb.value.error)),
      noKb.value && noKb.value.error);

    // ── 3. 列表 ─────────────────────────────────────────────────
    const notes = await backend.call('getNotes', [KB, {}]);
    check('getNotes 返回 2 条', notes.ok && notes.value.total === 2, notes.ok ? `total=${notes.value.total}` : notes.error);
    const titleA = notes.ok ? notes.value.items.find(n => n.id === aId) : undefined;
    check('列表项带标签与出链', !!titleA && titleA.tags.length === 2 && titleA.links.length === 2,
      titleA ? `tags=${titleA.tags.join('/')} links=${titleA.links.join('/')}` : 'missing');
    check('列表项带 kbId', !!titleA && titleA.kbId === KB, titleA ? String(titleA.kbId) : 'missing');

    // ── 4. 知识图谱：边 / stub / 计数 ────────────────────────────
    const g = await backend.call('getKnowledgeGraph', [KB]);
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

    // ── 5. 问答沉淀：带出来源会话 ───────────────────────────────
    const ask = await backend.call('saveNote', [KB, {
      title: '关于交付节奏的结论',
      body: '结论源自 [[项目组]] 的讨论',
      sourceKind: 'ask',
      sourceUsername: 'wxid_demo_user',
      sourceQuestion: '项目组最近在讨论什么？',
    }]);
    check('沉淀问答笔记', ask.ok && ask.value.ok === true, ask.error || JSON.stringify(ask.value));

    const g2 = await backend.call('getKnowledgeGraph', [KB]);
    const snap2 = g2.value;
    check('sessionNames 带出来源会话',
      snap2.sessionNames.wxid_demo_user === 'wxid_demo_user',
      JSON.stringify(snap2.sessionNames));
    check('askCount=1 / manualCount=2',
      snap2.summary.askCount === 1 && snap2.summary.manualCount === 2,
      `ask=${snap2.summary.askCount} manual=${snap2.summary.manualCount}`);

    // ── 6. 删除笔记 → 指向它的链接退回 stub（核心承诺）──────────
    const del = await backend.call('deleteNote', [KB, { id: bId }]);
    check('删除笔记「李四」', del.ok && del.value.ok === true, del.error || JSON.stringify(del.value));

    const g3 = await backend.call('getKnowledgeGraph', [KB]);
    const snap3 = g3.value;
    check('删除后 noteCount=2（含沉淀笔记）', snap3.summary.noteCount === 2, String(snap3.summary.noteCount));
    check('指向已删除笔记的链接变成 stub',
      snap3.stubs.some(s => s.label === '李四'),
      JSON.stringify(snap3.stubs.map(s => s.label)));
    check('指向已删除笔记的边 kind=stub',
      (edgeOf(snap3.edges, `note:${aId}`, 'kb:李四') || {}).kind === 'stub');

    // ── 7. 更新笔记保持 id ──────────────────────────────────────
    const upd = await backend.call('saveNote', [KB, { id: aId, title: '项目组', body: '改过了 [[王五]]' }]);
    check('更新笔记复用原 id', upd.ok && upd.value.ok === true && upd.value.id === aId, JSON.stringify(upd.value));
    const g4 = await backend.call('getKnowledgeGraph', [KB]);
    const na4 = g4.value.notes.find(n => n.id === aId);
    check('更新后出链收敛为 1', na4 && na4.outLinks === 1, na4 ? String(na4.outLinks) : 'missing');

    // ══ 8. 多知识库：一库一图 ═══════════════════════════════════
    console.log('\n── 多知识库 ──');
    const mk = await backend.call('createKb', [{ name: '工作' }]);
    check('新建库「工作」', mk.ok && mk.value.ok === true, mk.error || JSON.stringify(mk.value));
    const KB2 = mk.value && mk.value.id;
    check('新库 id 与默认库不同', KB2 !== KB, `kb2=${KB2}`);

    const dupKb = await backend.call('createKb', [{ name: ' 工作 ' }]);
    check('同名的库被拒（归一化）', dupKb.ok && dupKb.value.ok === false, dupKb.value && dupKb.value.error);
    const blankKb = await backend.call('createKb', [{ name: '   ' }]);
    check('空库名被拒', blankKb.ok && blankKb.value.ok === false, blankKb.value && blankKb.value.error);

    // 同一标题在两个库各存一份都必须成功（唯一性只在库内）
    const w1 = await backend.call('saveNote', [KB2, { title: '项目组', body: '工作库那篇' }]);
    check('同标题在另一个库可以再存一份', w1.ok && w1.value.ok === true, w1.error || JSON.stringify(w1.value));
    // 但同一个库内仍然不许撞名
    const wDup = await backend.call('saveNote', [KB2, { title: '项目组', body: '再来一份' }]);
    check('同一个库内撞名仍被拒', wDup.ok && wDup.value.ok === false, wDup.value && wDup.value.error);

    const kbNotes1 = await backend.call('getNotes', [KB, {}]);
    const kbNotes2 = await backend.call('getNotes', [KB2, {}]);
    check('total 只算本库（默认库 / 工作库）',
      kbNotes1.value.total === 2 && kbNotes2.value.total === 1,
      `${kbNotes1.value.total} vs ${kbNotes2.value.total}`);

    // 工作库里那篇「项目组」在默认库里**不是**链接目标：默认库的 [[项目组]] 仍指向自己的那篇
    const gW = await backend.call('getKnowledgeGraph', [KB2]);
    check('工作库的图只有本库节点', gW.value.summary.noteCount === 1, String(gW.value.summary.noteCount));
    check('工作库的图里没有默认库的边',
      !gW.value.edges.some(e => e.source === `note:${aId}` || e.target === `note:${aId}`));

    // 跨库同名不能被连上：默认库里写 [[项目组]] 解析到的是**默认库**那一篇
    const cross = await backend.call('getKnowledgeGraph', [KB]);
    check('跨库同名不会被连上（默认库内自解析）',
      cross.value.edges.some(e => e.kind === 'wiki' && e.target === `note:${aId}`) ||
      cross.value.stubs.some(s => s.label === '项目组'),
      JSON.stringify(cross.value.stubs.map(s => s.label)));

    // 带错库去删不会删掉别的库那一篇
    const wrongDel = await backend.call('deleteNote', [KB, { id: w1.value.id }]);
    check('带错库删除被拒', wrongDel.ok && wrongDel.value.ok === false, wrongDel.value && wrongDel.value.error);
    check('工作库那篇仍在', (await backend.call('getNotes', [KB2, {}])).value.total === 1);

    // 改名不动笔记
    const rn = await backend.call('renameKb', [{ id: KB2, name: '职业' }]);
    check('改名成功', rn.ok && rn.value.ok === true, rn.error || JSON.stringify(rn.value));
    const kbList = await backend.call('getKbs', []);
    check('改名后列表反映新名字且笔记数不变',
      kbList.value.items.find(k => k.id === KB2).name === '职业' &&
      kbList.value.items.find(k => k.id === KB2).noteCount === 1,
      JSON.stringify(kbList.value.items));
    check('改名不产生新库', kbList.value.total === 2, String(kbList.value.total));

    // 默认库不可删
    const killDefault = await backend.call('deleteKb', [{ id: KB, action: { kind: 'purge' } }]);
    check('默认库不可删', killDefault.ok && killDefault.value.ok === false, killDefault.value && killDefault.value.error);

    // 缺少 action 必须被拒（后端不给默认动作）
    const noAction = await backend.call('deleteKb', [{ id: KB2 }]);
    check('缺 action 被拒', noAction.ok && noAction.value.ok === false, noAction.value && noAction.value.error);
    check('缺 action 时库还在', (await backend.call('getKbs', [])).value.total === 2);

    // 目标库里已经有同名的《项目组》→ reassign 必须**整体拒绝**：
    // 合并会让同一个库内出现两条归一化同名的笔记，[[链接]] 随即变得有歧义。
    const clash = await backend.call('deleteKb', [{ id: KB2, action: { kind: 'reassign', targetKbId: KB } }]);
    check('目标库同名冲突时 reassign 被整体拒绝',
      clash.ok && clash.value.ok === false && /同名/.test(String(clash.value.error)),
      clash.value && clash.value.error);
    check('被拒时两个库都还健在', (await backend.call('getKbs', [])).value.total === 2);

    // 先把标题改成不冲突的，再真搬
    const ready = await backend.call('saveNote', [KB2, { id: w1.value.id, title: '工作项目组' }]);
    check('为 reassign 准备无冲突标题', ready.ok && ready.value.ok === true, JSON.stringify(ready.value));

    // reassign：笔记搬回默认库，源库消失
    const mv = await backend.call('deleteKb', [{ id: KB2, action: { kind: 'reassign', targetKbId: KB } }]);
    check('reassign 成功并报告搬走条数',
      mv.ok && mv.value.ok === true && mv.value.movedNotes === 1,
      mv.error || JSON.stringify(mv.value));
    const after = await backend.call('getKbs', []);
    check('源库消失且笔记并入默认库',
      after.value.total === 1 && after.value.items[0].noteCount === 3,
      JSON.stringify(after.value.items));

    // purge：连带笔记一起删
    const mk2 = await backend.call('createKb', [{ name: '临时' }]);
    const KB3 = mk2.value && mk2.value.id;
    await backend.call('saveNote', [KB3, { title: '一次性笔记' }]);
    const purge = await backend.call('deleteKb', [{ id: KB3, action: { kind: 'purge' } }]);
    check('purge 成功并报告删除条数',
      purge.ok && purge.value.ok === true && purge.value.removedNotes === 1,
      purge.error || JSON.stringify(purge.value));
    check('purge 不影响别的库', (await backend.call('getKbs', [])).value.items[0].noteCount === 3);
  } finally {
    try { backend.dispose(); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (failed > 0) { console.log(`\n❌ 知识图谱冒烟失败：${failed} 项`); process.exit(1); }
  console.log('\n✅ 知识图谱后端冒烟通过');
}

main().catch((e) => { console.error('❌ 冒烟异常:', e); process.exit(1); });
