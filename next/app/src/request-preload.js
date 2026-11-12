'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fardeskRequest', {
  onShow: (callback) => ipcRenderer.on('request:data', (_event, data) => callback(data)),
  answer: (sessionId, accept) => ipcRenderer.send('request:answer', { sessionId, accept }),
});
