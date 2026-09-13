const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('studioAPI', {
  keys: () => ipcRenderer.invoke('studio:keys'),
  generateKeys: () => ipcRenderer.invoke('studio:generate-keys'),
  syncClientPub: () => ipcRenderer.invoke('studio:sync-client-pub'),
  importRequest: () => ipcRenderer.invoke('studio:import-request'),
  issue: (form) => ipcRenderer.invoke('studio:issue', form),
  verifyFile: () => ipcRenderer.invoke('studio:verify-file'),
  copy: (text) => ipcRenderer.invoke('studio:copy', text),
})
