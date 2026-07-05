const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vizAPI', {
  onStart: (cb) => ipcRenderer.on('viz:start', (_event, options) => cb(options)),
  onStop: (cb) => ipcRenderer.on('viz:stop', () => cb()),
  onNextPreset: (cb) => ipcRenderer.on('viz:next-preset', () => cb()),
  onPrevPreset: (cb) => ipcRenderer.on('viz:prev-preset', () => cb()),
  onOpenPicker: (cb) => ipcRenderer.on('viz:open-picker', () => cb()),
  onCaptureStart: (cb) => ipcRenderer.on('viz:capture-start', () => cb()),
  onCaptureStop: (cb) => ipcRenderer.on('viz:capture-stop', () => cb()),
  hide: () => ipcRenderer.send('viz:hide'),
  sendAudioFormat: (format) => ipcRenderer.send('viz:audio-format', format),
  sendAudio: (buffer) => ipcRenderer.send('viz:audio', buffer),
});
