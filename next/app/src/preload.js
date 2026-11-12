'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fardesk', {
  info: () => ipcRenderer.invoke('app:info'),
  permissions: (prompt) => ipcRenderer.invoke('host:permissions', prompt),
  openSettings: (which) => ipcRenderer.invoke('host:open-settings', which),
  setHosting: (active) => ipcRenderer.send('host:session', active),
  input: (msg, label) => ipcRenderer.send('host:input', msg, label),
  syncClipboard: (active) => ipcRenderer.send('clipboard:sync', active),
  writeClipboard: (text) => ipcRenderer.send('clipboard:write', text),
  onClipboard: (callback) => ipcRenderer.on('clipboard:changed', (_event, text) => callback(text)),
  onUpdate: (callback) => ipcRenderer.on('update:status', (_event, status) => callback(status)),
  installUpdate: () => ipcRenderer.send('update:install'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  attention: () => ipcRenderer.send('app:attention'),
  setBackground: (enabled) => ipcRenderer.send('app:background', enabled),
  autostart: (enabled) => ipcRenderer.invoke('app:autostart', enabled),
  micAccess: () => ipcRenderer.invoke('mic:access'),
  request: {
    show: (data) => ipcRenderer.send('request:show', data),
    hide: () => ipcRenderer.send('request:hide'),
    onAnswer: (callback) => ipcRenderer.on('request:answer', (_event, answer) => callback(answer)),
  },
  access: {
    status: () => ipcRenderer.invoke('access:status'),
    set: (password) => ipcRenderer.invoke('access:set', password),
    clear: () => ipcRenderer.invoke('access:clear'),
    challenge: (sessionId) => ipcRenderer.invoke('access:challenge', sessionId),
    verify: (sessionId, proof) => ipcRenderer.invoke('access:verify', sessionId, proof),
    forget: (sessionId) => ipcRenderer.send('access:forget', sessionId),
    derive: (password, salt) => ipcRenderer.invoke('access:derive', password, salt),
    answer: (key, nonce, sessionId) => ipcRenderer.invoke('access:answer', key, nonce, sessionId),
  },
  files: {
    begin: (id, name, size) => ipcRenderer.invoke('file:begin', id, name, size),
    chunk: (id, data) => ipcRenderer.send('file:chunk', id, data),
    end: (id) => ipcRenderer.invoke('file:end', id),
    abort: () => ipcRenderer.send('file:abort'),
    reveal: (file) => ipcRenderer.send('file:reveal', file),
  },
});
