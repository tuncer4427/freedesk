'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('freedesk', {
  info: () => ipcRenderer.invoke('app:info'),
  permissions: (prompt) => ipcRenderer.invoke('host:permissions', prompt),
  openSettings: (which) => ipcRenderer.invoke('host:open-settings', which),
  setHosting: (active) => ipcRenderer.send('host:session', active),
  input: (msg) => ipcRenderer.send('host:input', msg),
  syncClipboard: (active) => ipcRenderer.send('clipboard:sync', active),
  writeClipboard: (text) => ipcRenderer.send('clipboard:write', text),
  onClipboard: (callback) => ipcRenderer.on('clipboard:changed', (_event, text) => callback(text)),
  onUpdate: (callback) => ipcRenderer.on('update:status', (_event, status) => callback(status)),
  installUpdate: () => ipcRenderer.send('update:install'),
});
