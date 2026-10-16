'use strict';

/**
 * Electron 主进程的调试自动化入口。
 *
 * 这些环境变量只服务于「启动真实窗口 → 操纵渲染层 → 截图 → 退出」的开发与打包冒烟，
 * 不是产品行为。它们原来直接写在 `main.js` 的 `app.whenReady()` 回调里，把大量
 * 渲染层 DOM selector 钉进了主进程；抽到这里后，主进程只负责在启动末尾挂上钩子，
 * 页面结构的细节仍属于自动化脚本与渲染层自己。
 *
 * 支持的环境变量：
 *   - SUPERTIME_SCREENSHOT=path：截图输出路径；本模块是否启用只看它。
 *   - SUPERTIME_THEME=light|dark：截图前强制主题。
 *   - SUPERTIME_TAB=label：精确匹配一个按钮文字并点击。
 *   - SUPERTIME_CLICK='labelA|labelB'：依次点击按钮（精确优先，其次前缀匹配）。
 *   - SUPERTIME_MAP_DEBUG=1：打印世界板块布局信息。
 *   - SUPERTIME_SCROLL=1|N：打印可滚动区域并滚动到指定位置。
 */

const fs = require('node:fs');

const DEFAULT_DELAY_MS = 9000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把 `SUPERTIME_CLICK` 拆成按顺序点击的按钮标签。 */
function clickLabels(env = process.env) {
  return String(env.SUPERTIME_CLICK || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 把 `SUPERTIME_SCROLL` 转成数字目标；环境变量缺省时与 Number(undefined) 同为 NaN。 */
function scrollTarget(env = process.env) {
  return Number(env.SUPERTIME_SCROLL);
}

/**
 * 执行一次完整的截图自动化。
 *
 * 依赖通过参数注入：单测给假 webContents，打包/开发态由 `installScreenshotAutomation`
 * 传真实 `mainWindow.webContents`。
 */
async function runScreenshotAutomation(options = {}) {
  const {
    window,
    env = process.env,
    writeFileSync = fs.writeFileSync,
    sleep = delay,
  } = options;
  const webContents = window && window.webContents;
  if (!webContents) throw new Error('screenshot automation: window not available');
  if (!env.SUPERTIME_SCREENSHOT) return { started: false };

  if (env.SUPERTIME_THEME === 'light' || env.SUPERTIME_THEME === 'dark') {
    await webContents.executeJavaScript(`(() => {
      const wantLight = ${JSON.stringify(env.SUPERTIME_THEME)} === 'light';
      const isLight = document.documentElement.classList.contains('theme-light');
      if (isLight !== wantLight) {
        const btn = document.querySelector('[data-theme-toggle]');
        btn?.click();
      }
      window.scrollTo(0, 0);
      return true;
    })()`);
    await sleep(400);
  }

  if (env.SUPERTIME_TAB) {
    await webContents.executeJavaScript(`(() => {
      const label = ${JSON.stringify(env.SUPERTIME_TAB)};
      const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === label);
      btn?.click();
      return true;
    })()`);
    await sleep(500);
  }

  // SUPERTIME_TAB 只能点一次且必须整串相等；这里支持先切页签、再展开面板等多步交互。
  const labels = clickLabels(env);
  for (const label of labels) {
    const clicked = await webContents.executeJavaScript(`(() => {
      const want = ${JSON.stringify(label)};
      const btns = Array.from(document.querySelectorAll('button'));
      const hit = btns.find(b => (b.textContent || '').trim() === want)
        || btns.find(b => (b.textContent || '').trim().startsWith(want));
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    console.log('[click]', label, clicked ? 'ok' : '按钮未找到');
    await sleep(500);
  }

  if (env.SUPERTIME_MAP_DEBUG === '1') {
    const mapInfo = await webContents.executeJavaScript(`(() => {
      const s = Array.from(document.querySelectorAll('section')).find(x => (x.textContent || '').includes('世界板块'));
      if (!s) return { found: false };
      const cs = getComputedStyle(s);
      const p = s.parentElement;
      const pc = p ? getComputedStyle(p) : null;
      return {
        found: true,
        text: s.textContent?.slice(0, 80),
        h: s.getBoundingClientRect().height,
        display: cs.display,
        flex: cs.flex,
        minH: cs.minHeight,
        overflow: cs.overflow,
        parentClass: p?.className,
        parentH: p?.getBoundingClientRect().height,
        parentDisplay: pc?.display,
        parentOverflow: pc?.overflow,
        parentMinH: pc?.minHeight,
        bodyH: s.children[1]?.getBoundingClientRect().height,
        bodyTextH: s.children[1]?.textContent?.length,
        canvasCount: s.querySelectorAll('canvas').length,
        hasEcharts: !!s.querySelector('.map, [class*="map"]'),
      };
    })()`);
    console.log('[map debug]', JSON.stringify(mapInfo));
  }

  const target = scrollTarget(env);
  if (env.SUPERTIME_SCROLL === '1' || target > 0) {
    const info = await webContents.executeJavaScript(`(() => {
      const c = document.querySelector('[class*="content"]');
      const p = c?.closest('[class*="panel"]');
      const scrollables = Array.from(document.querySelectorAll('*')).filter(el => el.scrollHeight > el.clientHeight + 10);
      return {
        innerHeight: window.innerHeight,
        rootH: document.getElementById('root')?.getBoundingClientRect().height,
        panelH: p?.getBoundingClientRect().height,
        contentClientH: c?.clientHeight,
        contentScrollH: c?.scrollHeight,
        contentOverflow: c ? getComputedStyle(c).overflow : null,
        scrollables: scrollables.slice(0, 5).map(el => ({ cls: el.className, client: el.clientHeight, scroll: el.scrollHeight })),
      };
    })()`);
    console.log('[scroll debug]', JSON.stringify(info));
    await webContents.executeJavaScript(`(() => {
      const candidates = Array.from(document.querySelectorAll('*')).filter(el => el.scrollHeight > el.clientHeight + 10);
      const target = candidates.slice().sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || candidates[candidates.length - 1];
      if (target) target.scrollTop = ${target || 520};
      return candidates.length;
    })()`);
    await sleep(300);
  }

  const image = await webContents.capturePage();
  const output = String(env.SUPERTIME_SCREENSHOT);
  writeFileSync(output, image.toPNG());
  console.log('[screenshot] saved', output);
  return { started: true };
}

/**
 * 在窗口加载与后端启动之后安装截图钩子。未启用时返回 null。
 * `app.quit()` 由调用方注入：真实退出必须走 Electron 生命周期，不能自己 require('electron')。
 */
function installScreenshotAutomation(options = {}) {
  const {
    getWindow,
    app,
    env = process.env,
    initialDelayMs = DEFAULT_DELAY_MS,
    setTimeoutFn = setTimeout,
  } = options;
  if (!env.SUPERTIME_SCREENSHOT) return null;
  return setTimeoutFn(async () => {
    try {
      await runScreenshotAutomation({ window: getWindow(), env });
    } catch (e) {
      console.error('[screenshot] failed', e);
    }
    app.quit();
  }, initialDelayMs);
}

module.exports = {
  DEFAULT_DELAY_MS,
  clickLabels,
  scrollTarget,
  runScreenshotAutomation,
  installScreenshotAutomation,
};
