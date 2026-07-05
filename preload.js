const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vizAPI', {
  onStart: (cb) => ipcRenderer.on('viz:start', (_event, options) => cb(options)),
  onStop: (cb) => ipcRenderer.on('viz:stop', () => cb()),
  onNextPreset: (cb) => ipcRenderer.on('viz:next-preset', () => cb()),
  onOpenPicker: (cb) => ipcRenderer.on('viz:open-picker', () => cb()),
  hide: () => ipcRenderer.send('viz:hide'),
});
