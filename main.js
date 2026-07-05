const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  session,
  desktopCapturer,
  nativeImage,
  screen,
  ipcMain,
} = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULT_CONFIG = {
  hotkey: 'Control+Alt+V',
  presetIntervalSeconds: 30,
  presetBlendSeconds: 2.7,
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

const config = loadConfig();

let tray = null;
let win = null;
let visible = false;

// Audio capture via getDisplayMedia needs no user gesture in our own app.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => toggleVisualizer());
}

function createWindow() {
  win = new BrowserWindow({
    show: false,
    frame: false,
    skipTaskbar: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Surface renderer logs in the terminal for debugging.
  win.webContents.on('console-message', (event) => {
    console.log(`[renderer] ${event.message}`);
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('closed', () => {
    win = null;
    visible = false;
  });
}

function sendWhenLoaded(channel, ...args) {
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => win.webContents.send(channel, ...args));
  } else {
    win.webContents.send(channel, ...args);
  }
}

function showVisualizer() {
  if (!win) createWindow();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  win.setBounds(display.bounds);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setFullScreen(true);
  win.show();
  win.focus();
  sendWhenLoaded('viz:start', {
    presetIntervalSeconds: config.presetIntervalSeconds,
    presetBlendSeconds: config.presetBlendSeconds,
  });
  visible = true;
  refreshTrayMenu();
}

function hideVisualizer() {
  if (!win) return;
  win.webContents.send('viz:stop');
  win.setFullScreen(false);
  win.hide();
  visible = false;
  refreshTrayMenu();
}

function toggleVisualizer() {
  if (visible) {
    hideVisualizer();
  } else {
    showVisualizer();
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: `${visible ? 'Hide' : 'Show'} Visualizer\t${config.hotkey.replace('Control', 'Ctrl')}`,
      click: () => toggleVisualizer(),
    },
    {
      label: 'Next Preset',
      enabled: visible,
      click: () => win && win.webContents.send('viz:next-preset'),
    },
    { type: 'separator' },
    {
      label: 'Run at Startup',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    {
      label: 'Quit Butterdrop',
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip(`Butterdrop — ${config.hotkey.replace('Control', 'Ctrl')} to toggle visualizer`);
  tray.on('double-click', () => toggleVisualizer());
  refreshTrayMenu();
}

app.whenReady().then(() => {
  // Grant system-audio loopback whenever the renderer calls getDisplayMedia.
  // No picker dialog: always capture the primary screen's audio.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({ video: sources[0], audio: 'loopback' });
      });
    },
    { useSystemPicker: false }
  );

  ipcMain.on('viz:hide', () => hideVisualizer());

  createWindow();
  createTray();

  const registered = globalShortcut.register(config.hotkey, () => toggleVisualizer());
  if (!registered) {
    console.error(`Failed to register global hotkey: ${config.hotkey} (already in use?)`);
  } else {
    console.log(`Butterdrop running in tray. Hotkey: ${config.hotkey}`);
  }

  if (process.argv.includes('--show')) {
    showVisualizer();
  }

  // Self-test: show the visualizer, run briefly, then exit.
  if (process.argv.includes('--smoke')) {
    showVisualizer();
    setTimeout(() => {
      hideVisualizer();
      setTimeout(() => app.quit(), 500);
    }, 6000);
  }
});

// Tray app: keep running with no visible windows.
app.on('window-all-closed', () => {});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
