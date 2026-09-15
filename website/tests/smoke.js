/**
 * Super Time 官网 · 冒烟测试 + 响应式契约验证
 *
 * 运行：
 *   cd "C:/Users/Administrator/.workbuddy/binaries/node/workspace" && \
 *   NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules" \
 *   "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" \
 *   "D:/super-time-wechat/website/tests/smoke.js"
 * 退出码 0 = 全绿；明细见 tests/smoke.log
 *
 * 设计说明：本机没有任何浏览器内核（无 Chrome/Edge/Playwright 缓存），jsdom 也无布局引擎，
 * 所以布局不靠"渲染后量像素"，改为两条可复现的路径：
 *   A) 真实 DOM + 桩（canvas / IntersectionObserver / matchMedia），把 JS 代码路径真跑一遍；
 *   B) 解析真实 CSS 级联（含媒体查询求值），对 22 个分辨率做盒模型算术校验。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const out = [];
let failures = 0;
const ok = m => out.push('  PASS  ' + m);
const bad = m => { out.push('  FAIL  ' + m); failures++; };
const assert = (c, m) => (c ? ok(m) : bad(m));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ==========================================================================
   一、CSS 级联解析器（含媒体查询求值）
   ========================================================================== */
const CSS = (HTML.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1].replace(/\/\*[\s\S]*?\*\//g, '');

function splitMedia(css) {
  const media = [];
  let rest = '', i = 0;
  for (;;) {
    const idx = css.indexOf('@media', i);
    if (idx === -1) { rest += css.slice(i); break; }
    rest += css.slice(i, idx);
    const open = css.indexOf('{', idx);
    let depth = 0, k = open;
    for (; k < css.length; k++) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}' && --depth === 0) break;
    }
    media.push({ query: css.slice(idx + 6, open).trim(), body: css.slice(open + 1, k) });
    i = k + 1;
  }
  return { base: rest, media };
}

function parseRules(text) {
  const rules = [];
  let i = 0;
  for (;;) {
    const open = text.indexOf('{', i);
    if (open === -1) break;
    const sel = text.slice(i, open).trim();
    let depth = 0, k = open;
    for (; k < text.length; k++) {
      if (text[k] === '{') depth++;
      else if (text[k] === '}' && --depth === 0) break;
    }
    if (!sel.startsWith('@')) {
      const decls = {};
      text.slice(open + 1, k).split(';').forEach(p => {
        const c = p.indexOf(':');
        if (c > -1) decls[p.slice(0, c).trim()] = p.slice(c + 1).trim();
      });
      sel.split(',').forEach(s => rules.push({ sel: s.trim(), decls }));
    }
    i = k + 1;
  }
  return rules;
}

const SPLIT = splitMedia(CSS);
const BASE_RULES = parseRules(SPLIT.base);

function mqMatches(query, env) {
  return query.split(/\s+and\s+/).map(s => s.trim()).every(p => {
    let m;
    if ((m = p.match(/^\(max-width:\s*(\d+)px\)$/))) return env.vw <= +m[1];
    if ((m = p.match(/^\(min-width:\s*(\d+)px\)$/))) return env.vw >= +m[1];
    if ((m = p.match(/^\(max-height:\s*(\d+)px\)$/))) return env.vh <= +m[1];
    if (p === '(orientation:landscape)') return env.vw > env.vh;
    if (p === '(hover:none)') return env.hover === 'none';
    if ((m = p.match(/^\(hover:\s*(\w+)\)$/))) return env.hover === m[1];
    if (p.startsWith('(prefers-reduced-motion')) return env.reduce === true;
    return false;
  });
}

function rulesFor(env) {
  const list = BASE_RULES.slice();
  SPLIT.media.forEach(b => { if (mqMatches(b.query, env)) list.push(...parseRules(b.body)); });
  return list;
}
function declFor(rules, selector, prop) {
  let val = null;
  for (const r of rules) if (r.sel === selector && r.decls[prop] !== undefined) val = r.decls[prop];
  return val;
}
function evalLen(expr, env) {
  if (!expr) return NaN;
  expr = String(expr).trim();
  const m = expr.match(/^(clamp|min|max)\((.*)\)$/);
  if (m) {
    const args = m[2].split(',').map(a => evalLen(a, env));
    if (m[1] === 'clamp') return Math.min(Math.max(args[0], args[1]), args[2]);
    if (m[1] === 'min') return Math.min(...args);
    return Math.max(...args);
  }
  let v;
  if ((v = expr.match(/^(-?[\d.]+)px$/))) return +v[1];
  if ((v = expr.match(/^(-?[\d.]+)vw$/))) return env.vw * +v[1] / 100;
  if ((v = expr.match(/^(-?[\d.]+)vh$/))) return env.vh * +v[1] / 100;
  if ((v = expr.match(/^var\((--[\w-]+)\)$/))) {
    return evalLen(declFor(rulesFor(env), ':root', v[1]), env);
  }
  return NaN;
}

/** 取简写属性的某一边：padding:14px X → top/bottom = 14px；border-bottom:1px solid X → 1px */
function shorthandEdge(val, env, which) {
  if (!val) return NaN;
  const parts = String(val).trim().split(/\s+/);
  const pick = parts.length === 1 ? 0
    : parts.length === 2 ? (which === 'top' || which === 'bottom' ? 0 : 1)
    : parts.length === 3 ? (which === 'top' ? 0 : which === 'bottom' ? 2 : 1)
    : (which === 'top' ? 0 : which === 'bottom' ? 2 : which === 'left' ? 3 : 1);
  return evalLen(parts[which === 'border' ? 0 : pick], env);
}

/* ==========================================================================
   二、逐分辨率盒模型算术
   ========================================================================== */
const BANDS = [
  [320, 568, '超小屏 iPhone SE1'],
  [360, 640, '小屏安卓'],
  [375, 667, 'iPhone SE2/8'],
  [390, 844, 'iPhone 12/13/14'],
  [414, 896, 'iPhone Plus/XR'],
  [430, 932, 'iPhone Pro Max'],
  [480, 800, '大屏手机'],
  [540, 960, '手机/平板过渡'],
  [640, 800, '小平板'],
  [768, 1024, 'iPad mini 竖屏'],
  [820, 1180, 'iPad 10 竖屏'],
  [834, 1194, 'iPad Air 竖屏'],
  [900, 1200, '平板竖屏上限'],
  [980, 1300, 'Hero 单双栏临界'],
  [1024, 768, 'iPad 横屏'],
  [1100, 800, '小笔记本'],
  [1180, 820, '窄桌面'],
  [1280, 800, '桌面'],
  [1440, 900, '桌面'],
  [1600, 900, '宽屏临界'],
  [1920, 1080, '全高清'],
  [2560, 1440, '2K'],
];
const CJK = 1.0;    // 全角汉字字宽 = 1em
const MONO = 0.62;  // 等宽数字字宽 ≈ 0.62em

function checkBand(vw, vh) {
  const env = { vw, vh, hover: 'hover', reduce: false };
  const R = rulesFor(env);
  const maxw = evalLen(declFor(R, ':root', '--maxw'), env);
  const pad = evalLen(declFor(R, '.wrap', 'padding-left'), env);
  const contentW = Math.min(vw, maxw) - pad * 2;

  const h1 = evalLen(declFor(R, '.hero h1', 'font-size'), env);
  const cols = declFor(R, '.hero-grid', 'grid-template-columns') || '';
  const gap = evalLen(declFor(R, '.hero-grid', 'gap'), env) || 0;
  const single = /^minmax\(0,\s*1fr\)$/.test(cols.trim());
  const colW = single ? contentW : (contentW - gap) * (1.06 / 2);

  const statB = evalLen(declFor(R, '.stat b', 'font-size'), env);
  const sc = declFor(R, '.stats', 'grid-template-columns') || '';
  const statGap = evalLen(declFor(R, '.stats', 'gap'), env) || 20;
  // 列数只能按 repeat() 的计数或空白分隔项来数 —— 注意 minmax(0,1fr) 同时含 "minmax"
  // 和 "1fr" 两个关键词，用关键词计数会把单列误判成 4 列（实测踩过）。
  const rp = sc.match(/repeat\(\s*(\d+)/);
  const statN = rp ? +rp[1] : Math.max(1, sc.split(/\s+/).filter(Boolean).length);
  const statColW = (contentW - statGap * (statN - 1)) / statN;

  return { vw, vh, maxw, pad, contentW, h1, single, colW, heroNeed: 10 * CJK * h1,
           statB, statN, statColW, statNeed: 5 * MONO * statB };
}

/* ==========================================================================
   三、DOM 冒烟（带桩，跑通真实代码路径）
   ========================================================================== */
function runDomPass(cfg) {
  const res = { errs: [], metrics: {}, doc: null, window: null };
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => res.errs.push(String(e && e.message || e)));
  vc.on('error', (...a) => res.errs.push('console.error: ' + a.join(' ')));

  const dom = new JSDOM(HTML, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      if (cfg.rectWidth) {
        w.HTMLElement.prototype.getBoundingClientRect = function () {
          return { x: 0, y: 0, top: 0, left: 0, right: cfg.rectWidth, bottom: cfg.rectHeight,
                   width: cfg.rectWidth, height: cfg.rectHeight };
        };
      }
      if (cfg.stubCanvas) {
        res.metrics.clearRect = 0;
        w.HTMLCanvasElement.prototype.getContext = function () {
          const noop = () => {};
          const ctx = {
            clearRect() { res.metrics.clearRect++; },
            beginPath: noop, arc: noop, fill: noop, moveTo: noop, lineTo: noop,
            stroke: noop, setTransform: noop,
          };
          Object.defineProperty(ctx, 'fillStyle', { set() {}, get() { return ''; } });
          Object.defineProperty(ctx, 'strokeStyle', { set() {}, get() { return ''; } });
          Object.defineProperty(ctx, 'lineWidth', { set() {}, get() { return 1; } });
          return ctx;
        };
      }
      if (cfg.stubIO) {
        res.metrics.observed = 0;
        w.IntersectionObserver = class {
          constructor(cb) { this.cb = cb; }
          observe(el) { res.metrics.observed++; setTimeout(() => this.cb([{ isIntersecting: true, target: el }]), 0); }
          unobserve() {}
          disconnect() {}
        };
      }
      if (cfg.hoverCapable || cfg.touch) {
        const want = cfg.touch ? 'none' : 'hover';
        w.matchMedia = q => ({
          matches: q.indexOf('hover: ' + want) !== -1, media: q, onchange: null,
          addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
        });
      }
    },
  });
  res.window = dom.window;
  res.doc = dom.window.document;
  return res;
}

/* ==========================================================================
   四、主流程
   ========================================================================== */
(async function main() {
  try {
    /* ---------------- A. 降级分支 ---------------- */
    out.push('== A. DOM 冒烟 · 降级分支（无 canvas / 无 IO / 触摸设备） ==');
    const pA = runDomPass({});
    const W = pA.window, D = pA.doc;
    const $ = s => D.querySelector(s);
    const $$ = s => Array.from(D.querySelectorAll(s));
    const click = el => el.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }));
    const toastTxt = () => ($('#toastTxt') || {}).textContent || '';
    await sleep(420);

    out.push('-- A1. 骨架与移动端元信息 --');
    assert(!!D.doctype && D.documentElement.getAttribute('lang') === 'zh-CN', 'doctype + lang=zh-CN');
    const vp = $('meta[name="viewport"]').getAttribute('content');
    assert(/width=device-width/.test(vp), 'viewport 含 width=device-width');
    assert(/initial-scale=1/.test(vp), 'viewport 含 initial-scale=1');
    assert(/viewport-fit=cover/.test(vp), 'viewport 含 viewport-fit=cover（刘海屏安全区前提）');
    ['home', 'highlights', 'features', 'solutions', 'tech', 'about', 'faq', 'contact']
      .forEach(id => assert(!!D.getElementById(id), '存在区块 #' + id));
    const dvO = (HTML.match(/<div[ >]/g) || []).length, dvC = (HTML.match(/<\/div>/g) || []).length;
    assert(dvO === dvC, 'div 标签配平（' + dvO + ' / ' + dvC + '）');

    out.push('-- A2. 导航（折叠 + 抽屉） --');
    assert($$('#navLinks a').length === 7, '桌面导航 7 个链接');
    assert($$('#drawer a').length === 8, '抽屉 8 项（7 链接 + 1 CTA）');
    const dead = $$('a[href^="#"]').map(a => a.getAttribute('href'))
      .filter(h => h.length > 1 && !D.getElementById(h.slice(1)));
    assert(dead.length === 0, '页内锚点无死链（' + JSON.stringify(dead) + '）');
    click($('#burger'));
    assert($('#drawer').classList.contains('on'), '点汉堡后抽屉展开');
    assert($('#burger').getAttribute('aria-expanded') === 'true', 'aria-expanded 同步 true');
    click($('#drawer a'));
    assert(!$('#drawer').classList.contains('on'), '点抽屉内链接后自动关闭');
    assert($('#burger').getAttribute('aria-expanded') === 'false', '关闭后 aria-expanded 复位');
    W.dispatchEvent(new W.Event('scroll'));
    assert(true, 'scroll 监听无异常');

    out.push('-- A3. Hero 与动效层 --');
    assert(!!$('#stars'), '有粒子画布 #stars');
    assert($('#stars').style.display === 'none', '拿不到 2D context 时隐藏画布（兜底生效）');
    assert(($('#typed').textContent || '').length > 0, '打字机已写入文案');
    assert($$('#bars span').length === 12, '迷你柱状图 12 根柱');
    assert($$('#bars span').every(b => b.style.height), '每根柱均设置了高度');

    out.push('-- A4. 数字滚动 --');
    const counters = $$('[data-count]');
    assert(counters.length === 6, '6 个计数元素');
    assert(counters.every(el => el.textContent !== '0'), '全部计数已滚动');

    out.push('-- A5. 核心功能分页 --');
    assert($$('.tab').length === 4 && $$('.pane').length === 4, '4 个 tab / 4 个面板');
    assert($('#p1').classList.contains('on') && $$('.pane.on').length === 1, '默认只展示 p1');
    const tabP2 = $('.tab[data-pane="p2"]');
    click(tabP2);
    assert(tabP2.classList.contains('on') && tabP2.getAttribute('aria-selected') === 'true', 'tab 高亮与 aria 同步');
    assert($('#p2').classList.contains('on') && !$('#p1').classList.contains('on'), '面板正确切换');
    assert($$('.pane.on').length === 1, '切换后仍只有一个面板可见');
    await sleep(420);
    const fills = $$('#p2 .fill').map(f => f.style.width);
    assert(fills.length === 4 && fills.every(w => w && w !== '0%'), '进度条已填充：' + JSON.stringify(fills));

    out.push('-- A6. FAQ 手风琴 --');
    const qs = $$('.q');
    assert(qs.length === 4, '4 条 FAQ');
    click(qs[0].querySelector('button'));
    assert(qs[0].classList.contains('on') && qs[0].querySelector('.ans').style.maxHeight, '第 1 条展开并设了 maxHeight');
    click(qs[1].querySelector('button'));
    assert(qs[1].classList.contains('on') && !qs[0].classList.contains('on'), '第 1 条互斥收起');
    click(qs[1].querySelector('button'));
    assert(!qs[1].classList.contains('on'), '再次点击可收起');

    out.push('-- A7. 联系表单校验 --');
    const form = $('#form');
    const submit = () => form.dispatchEvent(new W.Event('submit', { bubbles: true, cancelable: true }));
    submit();
    assert(toastTxt() === '请填写称呼', '空提交拦称呼：' + toastTxt());
    $('#f-name').value = '张三'; $('#f-mail').value = 'not-an-email';
    submit();
    assert(toastTxt() === '请填写有效的邮箱地址', '邮箱格式校验：' + toastTxt());
    $('#f-mail').value = 'zhangsan@example.com';
    submit();
    assert(toastTxt() === '请先确认内容合规声明', '合规声明拦截：' + toastTxt());
    $('#f-ok').checked = true;
    submit();
    assert(toastTxt().indexOf('已收到') === 0, '合法提交成功：' + toastTxt());
    assert($('#f-name').value === '' && $('#toast').classList.contains('on'), '表单重置 + toast 显示');

    out.push('-- A8. 运行时错误 --');
    const realA = pA.errs.filter(e => !/Not implemented/i.test(e));
    assert(realA.length === 0, '降级分支无 JS 运行时错误' + (realA.length ? '：' + realA.join(' | ') : ''));

    /* ---------------- B/C/D. 完整分支 ---------------- */
    const FULL_PASSES = [
      { label: 'B. 完整分支 @1280×800（精确指针 + 画布 + IO）', stubCanvas: true, stubIO: true, hoverCapable: true, rectWidth: 1280, rectHeight: 800 },
      { label: 'C. 完整分支 @375×667（窄屏粒子路径 narrow=true）', stubCanvas: true, stubIO: true, hoverCapable: true, rectWidth: 375, rectHeight: 667 },
      { label: 'D. 触摸设备 @768×1024（hover:none 分支）', stubCanvas: true, stubIO: true, touch: true, rectWidth: 768, rectHeight: 1024 },
    ];
    for (const cfg of FULL_PASSES) {
      out.push('== ' + cfg.label + ' ==');
      const p = runDomPass(cfg);
      await sleep(540);
      const d = p.doc;
      const realErr = p.errs.filter(e => !/Not implemented/i.test(e));
      assert(realErr.length === 0, '无 JS 运行时错误' + (realErr.length ? '：' + realErr.join(' | ') : ''));
      assert(p.metrics.clearRect > 0, '粒子渲染循环真实执行（clearRect × ' + p.metrics.clearRect + '）');
      assert(d.getElementById('stars').style.display !== 'none', '画布保持可见（有 2D context）');
      if (cfg.stubIO) {
        assert(p.metrics.observed > 5, 'IntersectionObserver 观察到 ' + p.metrics.observed + ' 个元素');
        const rev = d.querySelectorAll('.rv.in').length, total = d.querySelectorAll('.rv').length;
        assert(rev === total, '滚动揭示全部生效（' + rev + '/' + total + '）');
      }
      if (cfg.hoverCapable) assert(!!d.getElementById('glow'), '光斑元素存在（精确指针设备）');
      if (cfg.touch) assert(true, '触摸分支未抛错');
    }

    /* ---------------- E. 断点契约 ---------------- */
    out.push('== E. 响应式断点契约 ==');
    const SPECS = [
      ['min-width:1600px', ['--maxw:1320px'], '超宽屏放宽容器'],
      ['max-width:1200px', ['.grid-3{'], '功能卡降两列'],
      ['max-width:1100px', ['.nav-act .btn-ghost{display:none}', 'grid-template-columns:minmax(0,1fr)'], '收次要按钮 + 双栏降单栏'],
      ['max-width:1024px', ['.nav-links{display:none}', '.burger{display:flex}'], '导航折叠为汉堡'],
      ['max-width:980px', ['.hide-sm{display:none}', '.mock-wrap{'], 'Hero 单栏 + 去掉强制换行'],
      ['max-width:820px', ['.tabs{overflow-x:auto', 'grid-template-columns:minmax(0,1fr)'], '平板竖屏单列 + 分页横滑'],
      ['max-width:640px', ['.form .row2{grid-template-columns:minmax(0,1fr)}'], '大屏手机单列表单'],
      ['max-width:480px', ['.hero h1{font-size'], '手机字号收敛'],
      ['max-width:360px', ['.stats{grid-template-columns:minmax(0,1fr)}'], '超小屏单列指标'],
      ['max-height:560px', [], '手机横屏压竖向留白'],
      ['hover:none', ['#glow{display:none}'], '触摸设备降级动效'],
      ['prefers-reduced-motion:reduce', [], '减弱动效'],
    ];
    SPECS.forEach(([q, needles, desc]) => {
      const blk = SPLIT.media.find(m => m.query.indexOf(q) !== -1);
      if (!blk) { bad('缺少断点 @media (' + q + ') —— ' + desc); return; }
      ok('断点存在 @media (' + q + ') —— ' + desc);
      needles.forEach(n => {
        assert(blk.body.replace(/\s+/g, '').indexOf(n.replace(/\s+/g, '')) !== -1, '  └ 含 ' + n);
      });
    });

    out.push('-- E1. 防溢出写法 --');
    const newBands = SPLIT.media.filter(m => /max-width:(1200|1100|1024|980|820|640|480|360)px/.test(m.query));
    const bare = newBands.filter(m => /grid-template-columns:\s*1fr\s+1fr/.test(m.body)).map(m => m.query);
    assert(bare.length === 0, '断点内无裸 1fr 1fr（应使用 minmax(0,1fr) 防内容撑破）：' + JSON.stringify(bare));
    assert(/scroll-padding-top:84px/.test(CSS), 'html 有 scroll-padding-top（锚点不被吸顶导航遮挡）');
    assert(/env\(safe-area-inset-bottom\)/.test(CSS), '使用底部安全区变量');
    assert(/env\(safe-area-inset-right\)/.test(CSS), '使用右侧安全区变量');
    assert(/100dvh/.test(CSS), '抽屉高度用 dvh（地址栏伸缩不裁切）');
    assert(/touch-action:manipulation/.test(CSS), '按钮设 touch-action:manipulation（去 300ms 点击延迟）');
    assert(/-webkit-tap-highlight-color:transparent/.test(CSS), '关闭移动端点击高亮方块');
    assert(/text-size-adjust:100%/.test(CSS), '禁止 iOS 横屏自动放大字号');
    assert(/overflow-wrap:break-word/.test(CSS), '文本块允许长词断行');
    assert(/hover:none/.test(CSS), '有触摸设备专属分支');

    out.push('-- E3. 移动端浏览器前缀与样式完整性 --');
    const bfW = (CSS.match(/-webkit-backdrop-filter:/g) || []).length;
    const bfS = (CSS.match(/(?<!-webkit-)backdrop-filter:/g) || []).length;
    assert(bfS > 0 && bfW === bfS,
      'backdrop-filter 标准与 -webkit- 版本成对（标准 ' + bfS + ' / 前缀 ' + bfW + '）—— iOS 15–17 Safari 只认前缀版');
    assert((CSS.match(/-webkit-text-size-adjust:100%/g) || []).length === 1
        && (CSS.match(/[^-]text-size-adjust:100%/g) || []).length === 1, 'text-size-adjust 双写');
    assert((CSS.match(/mask:linear-gradient\(#000 0 0\) content-box/g) || []).length === 4,
      'mask 同时提供标准与 -webkit- 版本（渐变描边卡在 Safari/Firefox 都不掉色）');
    const bo = (CSS.match(/\{/g) || []).length, bc = (CSS.match(/\}/g) || []).length;
    assert(bo === bc, '样式表花括号配平（{ ' + bo + ' / } ' + bc + '）');
    assert((CSS.match(/@media/g) || []).length === SPLIT.media.length,
      '媒体查询全部被解析（@media ' + SPLIT.media.length + ' 个）');

    out.push('-- E4. 汉堡按钮几何契约（防杠距/展开位移各写一套而错位） --');
    const E4 = { vw: 390, vh: 844, hover: 'hover', reduce: false };
    const R4 = rulesFor(E4);
    const boxH = evalLen(declFor(R4, '.burger', 'height'), E4);
    const barW = evalLen(declFor(R4, '.burger', '--bar-w'), E4);
    const barH = evalLen(declFor(R4, '.burger', '--bar-h'), E4);
    const barG = evalLen(declFor(R4, '.burger', '--bar-gap'), E4);
    assert(boxH === 42 && barW === 20 && barH === 2 && barG === 5,
      '几何变量齐备：盒 ' + boxH + ' / 杠 ' + barW + '×' + barH + ' / 距 ' + barG);
    assert(/column/.test(declFor(R4, '.burger', 'flex-direction') || '')
        && (declFor(R4, '.burger', 'gap') || '') === 'var(--bar-gap)',
      '用 flex 列 + gap 定间距（不再是 grid 行拉伸）');
    assert(!/\.burger span\+span\{margin-top/.test(CSS), '无被行拉伸吞掉的无效 margin-top');

    const blockH = 3 * barH + 2 * barG;
    assert(barW / boxH >= 0.45 && barW / boxH <= 0.55,
      '杠长/盒宽 = ' + (100 * barW / boxH).toFixed(1) + '% ∈ [45%,55%]');
    assert(barG / barH >= 2 && barG / barH <= 3,
      '杠距/杠厚 = ' + (barG / barH).toFixed(1) + ' ∈ [2,3]');
    assert(blockH / boxH >= 0.35 && blockH / boxH <= 0.45,
      '三杠总高/盒高 = ' + (100 * blockH / boxH).toFixed(0) + '% ∈ [35%,45%]');
    assert(Math.abs(42 - boxH) === 0 && boxH >= 40, '触控目标 ' + boxH + 'px ≥ 40px');

    const t1 = declFor(R4, '.burger.on span:nth-child(1)', 'transform') || '';
    const t3 = declFor(R4, '.burger.on span:nth-child(3)', 'transform') || '';
    assert(t1.indexOf('var(--bar-h)') !== -1 && t1.indexOf('var(--bar-gap)') !== -1,
      '展开态位移与布局同源引用变量：' + t1);
    assert(t3.indexOf('var(--bar-h)') !== -1 && t3.indexOf('var(--bar-gap)') !== -1,
      '第三杠位移同样同源：' + t3);
    assert(t1.indexOf(' + ') !== -1 && t3.indexOf('-1 *') !== -1, '两杠位移方向相反（构成 X）');
    assert(/rotate\(45deg\)/.test(t1) && /rotate\(-45deg\)/.test(t3), '旋转角度对称 ±45°');
    const pitch = barH + barG;
    assert(t1.indexOf('translateY(' + pitch + 'px)') === -1,
      '位移不再写死数字（杠距 ' + pitch + 'px 由变量推导）');

    out.push('-- E4b. 方案 B（霓虹渐变）身份契约 --');
    const grad2 = declFor(rulesFor(E4), ':root', '--grad2') || '';
    assert(grad2 === 'linear-gradient(90deg,#22d3ee,#8b5cf6)',
      '--grad2 为青→紫短渐变：' + grad2);
    const spanBg = declFor(R4, '.burger span', 'background') || '';
    assert(spanBg.indexOf('var(--grad2)') !== -1, '三杠用品牌渐变而非纯白：' + spanBg);
    assert((declFor(R4, '.burger span', 'background-size') || '') === '200% 100%',
      '渐变铺两倍宽（悬停时可位移）');
    assert(/^0% 50%$/.test(declFor(R4, '.burger span', 'background-position') || ''), '默认停在渐变左端');
    const hv = declFor(R4, '.burger:hover span', 'background-position') || '';
    assert(hv === '100% 50%', '悬停时渐变位移到右端：' + hv);
    assert(!declFor(R4, '.burger span', 'background-color'), '无覆盖渐变的纯色 background-color');
    assert((CSS.match(/#bff3ff/g) || []).length === 1,
      '#bff3ff 仅剩 hero 打字机在用（方案 A 的悬停色已清除），实际 ' + (CSS.match(/#bff3ff/g) || []).length + ' 处');

    out.push('-- E4c. 对比度无障碍（WCAG 非文本 3:1） --');
    function relLum(hex) {
      const ch = [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16) / 255).map(v =>
        v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    }
    function contrast(a, b) {
      const l1 = relLum(a), l2 = relLum(b);
      const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
      return (hi + 0.05) / (lo + 0.05);
    }
    // 按钮底盒是半透明，需与背后最深/最亮两种极端合成后再算
    const bgDecl = declFor(R4, '.burger', 'background') || '';
    const mm = bgDecl.match(/rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)/);
    assert(!!mm, '能解析按钮底盒颜色：' + bgDecl);
    const ba = mm[4] === undefined ? 1 : parseFloat(mm[4]);
    function over(backHex) {
      const bc = [1, 3, 5].map(i => parseInt(backHex.substr(i, 2), 16));
      const out = [0, 1, 2].map(i => Math.round(+mm[1 + i] * ba + bc[i] * (1 - ba)));
      return '#' + out.map(v => ('0' + v.toString(16)).slice(-2)).join('');
    }
    const stops = grad2.match(/#[0-9a-f]{6}/g) || [];
    assert(stops.length === 2, '渐变有 2 个色标：' + JSON.stringify(stops));
    [['#04050a', '页面深底'], ['#0e4a57', '极光最亮处']].forEach(([back, label]) => {
      const box = over(back);
      stops.forEach(s => {
        const cr = contrast(s, box);
        assert(cr >= 3, s + ' vs 底盒 ' + box + '（' + label + '）= ' + cr.toFixed(2) + ':1 ≥ 3:1');
      });
    });

    out.push('-- E5. 导航高度与抽屉偏移一致性（曾硬编码 66px 而实际 73px） --');
    const btnH = boxH;
    const markH = evalLen(declFor(R4, '.brand-mark', 'height'), E4) || 0;
    const padT = shorthandEdge(declFor(R4, '.nav-in', 'padding'), E4, 'top');
    const padB = shorthandEdge(declFor(R4, '.nav-in', 'padding'), E4, 'bottom');
    const bdH = shorthandEdge(declFor(R4, '.nav', 'border-bottom'), E4, 'border');
    const progH = evalLen(declFor(R4, '.nav-prog', 'height'), E4) || 0;
    const computedNav = Math.max(btnH, markH) + padT + padB + bdH + progH;
    const navhDecl = evalLen(declFor(R4, ':root', '--navh'), E4);
    assert(Math.abs(navhDecl - computedNav) <= 1,
      '--navh (' + navhDecl + ') 与实算导航高度 (' + computedNav + ' = 内容 ' +
      Math.max(btnH, markH) + ' + 内边距 ' + padT + '×2 + 边框 ' + bdH + ' + 进度条 ' + progH + ') 一致');
    assert((declFor(R4, '.drawer', 'top') || '') === 'var(--navh)',
      '抽屉 top 引用 --navh，不再硬编码长度');
    assert(/var\(--navh\)/.test(declFor(R4, '.drawer', 'max-height') || ''),
      '抽屉 max-height 同样引用 --navh');
    assert((CSS.match(/--navh:66px/) || []).length === 0, '无遗留的 66px 硬编码');

    out.push('-- E2. 硬编码宽度扫描（>320px 只允许出现在装饰层） --');
    const DECOR_OK = ['#glow', '.aurora'];
    const hardRules = [];
    const scan = rs => rs.forEach(x => {
      const m3 = x.decls.width && x.decls.width.match(/^(\d{3,})px$/);
      if (m3 && +m3[1] > 320) hardRules.push({ sel: x.sel, px: +m3[1] });
    });
    scan(BASE_RULES);
    SPLIT.media.forEach(b => scan(parseRules(b.body)));
    const unjustified = hardRules.filter(h => !DECOR_OK.some(p => h.sel === p || h.sel.indexOf(p + '.') === 0));
    assert(unjustified.length === 0,
      '>320px 硬宽未越界到布局层（越界：' + JSON.stringify(unjustified.map(h => h.sel + ':' + h.px)) + '）');
    assert(/\.aurora\{position:absolute/.test(CSS), '  └ .aurora 为绝对定位（大尺寸装饰不参与文档流）');
    assert(/#glow\{position:fixed/.test(CSS), '  └ #glow 为固定定位（不影响布局宽度）');
    out.push('  NOTE  >320px 硬宽共 ' + hardRules.length + ' 处，全部为装饰层：'
      + JSON.stringify([...new Set(hardRules.map(h => h.sel))]));

    /* ---------------- F. 逐分辨率算术校验 ---------------- */
    out.push('== F. 逐分辨率排版算术（汉字 1em / 等宽数字 0.62em） ==');
    out.push('  ' + '视口'.padEnd(12) + '设备'.padEnd(24) + '容器内宽'.padEnd(12) + '单栏'.padEnd(8)
      + 'H1字号'.padEnd(10) + 'H1需求'.padEnd(10) + '文本列宽'.padEnd(12) + '指标列宽'.padEnd(12) + '指标需求');
    BANDS.forEach(([vw, vh, tag]) => {
      const r = checkBand(vw, vh);
      out.push('  ' + (vw + '×' + vh).padEnd(12 - (String(vw).length + String(vh).length))
        + tag.padEnd(24 - Math.max(0, tag.length - 8))
        + r.contentW.toFixed(0).padEnd(12)
        + (r.single ? '是' : '否').padEnd(8)
        + r.h1.toFixed(1).padEnd(10)
        + r.heroNeed.toFixed(0).padEnd(10)
        + r.colW.toFixed(0).padEnd(12)
        + r.statColW.toFixed(0).padEnd(12)
        + r.statNeed.toFixed(0));

      assert(r.heroNeed <= r.colW * 1.01,
        vw + 'px：Hero 标题最长行 ' + r.heroNeed.toFixed(0) + 'px ≤ 文本列宽 ' + r.colW.toFixed(0) + 'px');
      assert(r.statNeed <= r.statColW * 1.01,
        vw + 'px：指标数字 ' + r.statNeed.toFixed(0) + 'px ≤ 指标列宽 ' + r.statColW.toFixed(0) + 'px');
      assert(r.pad >= 15 && r.pad <= 25,
        vw + 'px：容器内边距 ' + r.pad.toFixed(1) + 'px ∈ [15,25]');
    });

    out.push('-- F1. 单调性与连续性 --');
    let prev = null, mono = true, worst = null;
    BANDS.forEach(([vw, vh]) => {
      const r = checkBand(vw, vh);
      if (prev && r.contentW < prev.contentW - 0.5) { mono = false; worst = vw; }
      prev = r;
    });
    assert(mono, '容器内容宽度随视口单调不减（无断点塌陷）' + (worst ? '，异常于 ' + worst + 'px' : ''));

    out.push('-- F2. 断点切换处的字号跳变 --');
    const jumps = [];
    for (let vw = 320; vw <= 1600; vw++) {
      const a = checkBand(vw, 900).h1, b = checkBand(vw + 1, 900).h1;
      if (Math.abs(a - b) > 4) jumps.push(vw + 'px:' + a.toFixed(1) + '→' + b.toFixed(1));
    }
    assert(jumps.length === 0, 'H1 字号在断点处无突变（>4px 跳变）：' + JSON.stringify(jumps));
  } catch (e) {
    out.push('EXCEPTION: ' + (e && e.stack || e));
    failures++;
  }

  out.push('');
  out.push(failures === 0 ? '>>> ALL GREEN' : '>>> FAILURES: ' + failures);
  fs.writeFileSync(path.join(__dirname, 'smoke.log'), out.join('\n'), 'utf8');
  process.exit(failures === 0 ? 0 : 1);
})();
