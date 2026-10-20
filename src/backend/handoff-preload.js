/**
 * 悬浮卡片的 preload（2026-10-19）：只暴露一个「返回桌面」的 IPC。
 *
 * 卡片页面不加载任何业务界面，也不该拿到 `electronAPI` ——
 * 它在浏览器交接期间是**唯一可见的桌面窗口**，能力面必须小到只有收尾这一个动作。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('handoff', {
  restore: () => ipcRenderer.send('browser-handoff:restore'),
});
