// Throwaway test: does a HIDDEN Electron window keep rendering Butterchurn via
// requestAnimationFrame? Tests two configs and logs each window's reported FPS.
// Run: npx electron spike/rafwin-main.js
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function makeWin(label, opts) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
    ...opts,
  });
  win.webContents.on('console-message', (e) => {
    const msg = e.message || '';
    if (msg.startsWith('FPS')) console.log(`[${label}] ${msg}`);
  });
  win.loadFile(path.join(__dirname, 'rafwin.html'));
  return win;
}

app.whenReady().then(() => {
  // Config A: never shown, backgroundThrottling:false.
  makeWin('hidden', {});

  // Config B: shown but positioned far off-screen (compositor sees it).
  const offscreen = makeWin('offscreen-shown', { x: -4000, y: -4000, width: 320, height: 180 });
  offscreen.once('ready-to-show', () => offscreen.showInactive());

  console.log('Running 16s — watch FPS per window (expect ~30-60 if not throttled, ~1 if throttled)…');
  setTimeout(() => {
    console.log('done');
    app.quit();
  }, 16000);
});

app.on('window-all-closed', () => app.quit());
