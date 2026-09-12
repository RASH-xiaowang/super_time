const versionsEl = document.getElementById('versions');
const resultEl = document.getElementById('result');
const openFileBtn = document.getElementById('open-file');
const revealBtn = document.getElementById('reveal');
const pingBtn = document.getElementById('ping');
const wechatInfoEl = document.getElementById('wechat-info');
const wechatMethodEl = document.getElementById('wechat-method');
const wechatCallBtn = document.getElementById('wechat-call');
const wechatResultEl = document.getElementById('wechat-result');

let lastFiles = [];

async function renderVersions() {
  const v = await window.electronAPI.getVersions();
  const rows = [
    ['Electron', v.electron],
    ['Chromium', v.chrome],
    ['Node.js', v.node],
    ['平台 / 架构', `${v.platform} / ${v.arch}`]
  ];
  versionsEl.innerHTML = rows
    .map(([label, value]) => `<li><span>${label}</span><strong>${value}</strong></li>`)
    .join('');
}

function setResult(text) {
  resultEl.textContent = text;
}

function setWechatResult(text) {
  wechatResultEl.textContent = text;
}

async function initWechatBackend() {
  const info = await window.electronAPI.wechat.info();
  if (!info.ok) {
    wechatInfoEl.textContent = `初始化失败：${info.error?.message || '未知错误'}`;
    return;
  }
  const { root, decrypted, selfUsername, methods, llmConfigured } = info.value;
  wechatInfoEl.textContent = [
    `数据根：${root}`,
    `解密目录：${decrypted}`,
    `当前账号：${selfUsername || '未知'}`,
    `Remote 方法数：${methods.length}`,
    `LLM 桥接：${llmConfigured ? '已配置' : '未配置（AI 问答/总结降级）'}`
  ].join('　|　');

  wechatMethodEl.innerHTML = methods
    .map((m) => `<option value="${m}">${m}</option>`)
    .join('');
  wechatMethodEl.disabled = false;
  wechatCallBtn.disabled = false;
  setWechatResult(`已加载 ${methods.length} 个 Remote 方法，可调用 getDbStatus / getSessions / getContacts 等。`);
}

async function callSelectedWechatMethod() {
  const method = wechatMethodEl.value;
  if (!method) return;
  setWechatResult(`调用 ${method} …`);
  const res = await window.electronAPI.wechat.call(method, []);
  if (!res.ok) {
    setWechatResult(`调用失败 [${method}]：${res.error?.message || '未知错误'}`);
    return;
  }
  setWechatResult(`调用成功 [${method}]：\n${JSON.stringify(res.value, null, 2)}`);
}

openFileBtn.addEventListener('click', async () => {
  const res = await window.electronAPI.openFile();
  if (res.canceled) {
    lastFiles = [];
    revealBtn.disabled = true;
    setResult('已取消选择');
    return;
  }
  lastFiles = res.files;
  revealBtn.disabled = false;
  setResult(`已选择 ${res.files.length} 个文件：\n${res.files.map((f) => `• ${f}`).join('\n')}`);
});

revealBtn.addEventListener('click', async () => {
  if (lastFiles.length > 0) {
    await window.electronAPI.showInFolder(lastFiles[0]);
  }
});

pingBtn.addEventListener('click', async () => {
  const message = await window.electronAPI.ping();
  setResult(message);
});

wechatCallBtn.addEventListener('click', callSelectedWechatMethod);

window.electronAPI.wechat.onEvent(({ name, args }) => {
  console.log('[wechat-event]', name, args);
});

renderVersions();
initWechatBackend();