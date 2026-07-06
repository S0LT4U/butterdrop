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
  clipboard,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const tvServer = require('./tvserver');
const cast = require('./castclient');

const DEFAULT_CONFIG = {
  hotkey: 'Control+Alt+V',
  pickerHotkey: 'Alt+Shift+V',
  presetIntervalSeconds: 30,
  presetBlendSeconds: 2.7,
  tvMode: false,
  tvPort: 8720,
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

function saveConfig() {
  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

let tray = null;
let win = null;
let visible = false;
let tvActive = false;
let tvClients = 0;
let castDevices = [];
let castSession = null;
let castTargetName = '';
let castBusy = false;

function loadOrCreateToken() {
  const tokenPath = path.join(app.getPath('userData'), 'tv-token');
  try {
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    if (token) return token;
  } catch {}
  const token = crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tokenPath, token);
  return token;
}

function lanIp() {
  // Prefer real LAN adapters over virtual switches (WSL/Hyper-V/VPN) and
  // skip link-local addresses.
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;
      let score = 0;
      if (/vethernet|wsl|virtual|loopback|bluetooth|vmware|hyper-v|npcap|vpn/i.test(name)) score -= 10;
      if (addr.address.startsWith('192.168.')) score += 5;
      else if (addr.address.startsWith('10.')) score += 4;
      candidates.push({ address: addr.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].address : 'localhost';
}

function tvUrl() {
  return `http://${lanIp()}:${config.tvPort}/?t=${loadOrCreateToken()}`;
}

function startTvMode() {
  if (tvActive) return;
  tvServer.start({
    port: config.tvPort,
    token: loadOrCreateToken(),
    baseDir: __dirname,
    onClientChange: (n) => {
      tvClients = n;
      refreshTrayMenu();
    },
    onControl: (action) => handleRemoteControl(action),
  });
  sendWhenLoaded('viz:capture-start');
  tvActive = true;
  config.tvMode = true;
  saveConfig();
  refreshTrayMenu();
  console.log(`TV Mode on: ${tvUrl()}`);
}

// Known devices live in userData, NOT config.json — config is committed to
// the repo and must never contain the user's device names or LAN addresses.
function knownDevicesPath() {
  return path.join(app.getPath('userData'), 'cast-devices.json');
}

function loadKnownDevices() {
  try {
    return JSON.parse(fs.readFileSync(knownDevicesPath(), 'utf8'));
  } catch {
    return [];
  }
}

async function refreshCastDevices(notify = false) {
  const found = await cast.discover(3500);
  // SSDP can be flaky (TV standby states, multicast quirks) — also probe
  // devices we've successfully found before.
  for (const known of loadKnownDevices()) {
    if (!found.some((d) => d.host === known.host)) {
      const name = await cast.probe(known.host);
      if (name) found.push({ name, host: known.host });
    }
  }
  castDevices = found;
  if (castDevices.length) {
    fs.writeFileSync(knownDevicesPath(), JSON.stringify(castDevices, null, 2));
  }
  console.log(`Cast devices found: ${castDevices.map((d) => d.name).join(', ') || 'none'}`);
  if (notify && tray) {
    tray.displayBalloon({
      title: 'Butterdrop',
      content: castDevices.length
        ? `Found: ${castDevices.map((d) => d.name).join(', ')}`
        : 'No cast devices found on the network',
      iconType: 'info',
    });
  }
  refreshTrayMenu();
}

async function castTo(device) {
  if (castBusy) return;
  castBusy = true;
  try {
    if (!tvActive) startTvMode();
    if (castSession) {
      try {
        await castSession.stop();
      } catch {}
      castSession = null;
    }
    const session = new cast.CastSession(device.host);
    session.on('closed', () => {
      if (castSession === session) {
        castSession = null;
        castTargetName = '';
        refreshTrayMenu();
      }
    });
    session.on('error', (err) => console.error(`Cast error: ${err.message}`));
    // Cache-buster: force the receiver to load fresh page + scripts.
    await session.launch(`${tvUrl()}&autostart=1&r=${Date.now()}`);
    castSession = session;
    castTargetName = device.name;
    console.log(`Casting to ${device.name} (${device.host})`);
  } catch (err) {
    console.error(`Cast to ${device.name} failed: ${err.message}`);
  } finally {
    castBusy = false;
    refreshTrayMenu();
  }
}

async function stopCasting() {
  if (!castSession) return;
  const session = castSession;
  castSession = null;
  castTargetName = '';
  try {
    await session.stop();
  } catch {}
  refreshTrayMenu();
}

function handleRemoteControl(action) {
  if (action === 'next' && win && visible) win.webContents.send('viz:next-preset');
  if (action === 'prev' && win && visible) win.webContents.send('viz:prev-preset');
  if (action === 'cast') {
    const device = castDevices.find((d) => d.name === castTargetName) || castDevices[0];
    if (device) castTo(device);
  }
  if (action === 'stopcast') stopCasting();
}

function stopTvMode() {
  if (!tvActive) return;
  tvServer.stop();
  if (win) win.webContents.send('viz:capture-stop');
  tvActive = false;
  tvClients = 0;
  config.tvMode = false;
  saveConfig();
  refreshTrayMenu();
  console.log('TV Mode off');
}

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
      // TV Mode captures audio while the window is hidden.
      backgroundThrottling: false,
    },
  });

  // Lock down the renderer: it should never navigate or open windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

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

function showVisualizer(showPicker = false) {
  if (!win) createWindow();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  win.setBounds(display.bounds);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setFullScreen(true);
  win.show();
  win.focus();
  // Windows won't always let a hotkey-triggered window take keyboard focus.
  app.focus({ steal: true });
  sendWhenLoaded('viz:start', {
    presetIntervalSeconds: config.presetIntervalSeconds,
    presetBlendSeconds: config.presetBlendSeconds,
    showPicker,
  });
  visible = true;
  refreshTrayMenu();
}

function openSourcePicker() {
  if (visible) {
    win.focus();
    app.focus({ steal: true });
    win.webContents.send('viz:open-picker');
  } else {
    showVisualizer(true);
  }
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

// In dev mode the executable is electron.exe, which needs the app path as an
// argument; a packaged build launches directly and needs no args.
function loginItemOptions() {
  if (app.isPackaged) return {};
  return { path: process.execPath, args: [`"${__dirname}"`] };
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
      enabled: visible || (tvActive && tvClients > 0),
      click: () => {
        if (win && visible) win.webContents.send('viz:next-preset');
        if (tvActive) tvServer.control({ type: 'nextPreset' });
      },
    },
    {
      label: `Select Audio Source…\t${config.pickerHotkey}`,
      click: () => openSourcePicker(),
    },
    { type: 'separator' },
    {
      label: tvActive ? `TV Mode (${tvClients} connected)` : 'TV Mode (serve to network)',
      type: 'checkbox',
      checked: tvActive,
      click: (item) => (item.checked ? startTvMode() : stopTvMode()),
    },
    {
      label: 'Cast to…',
      submenu: [
        ...castDevices.map((d) => ({
          label: d.name + (d.name === castTargetName ? ' ✓' : ''),
          click: () => castTo(d),
        })),
        ...(castDevices.length ? [{ type: 'separator' }] : []),
        {
          label: castDevices.length ? 'Refresh Devices' : 'Search for Devices',
          click: () => refreshCastDevices(true),
        },
      ],
    },
    {
      label: castTargetName ? `Stop Casting (${castTargetName})` : 'Stop Casting',
      enabled: !!castSession,
      click: () => stopCasting(),
    },
    {
      label: 'Copy TV URL',
      enabled: tvActive,
      click: () => clipboard.writeText(tvUrl()),
    },
    {
      label: 'Copy Phone Remote URL',
      enabled: tvActive,
      click: () => clipboard.writeText(`http://${lanIp()}:${config.tvPort}/remote?t=${loadOrCreateToken()}`),
    },
    { type: 'separator' },
    {
      label: 'Run at Startup',
      type: 'checkbox',
      checked: app.getLoginItemSettings(loginItemOptions()).openAtLogin,
      click: (item) =>
        app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: item.checked }),
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

  // Allow microphone/line-in capture (for the source picker); deny everything else.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });

  ipcMain.on('viz:hide', () => hideVisualizer());
  ipcMain.on('viz:audio-format', (event, rate) => tvServer.setFormat(rate));
  ipcMain.on('viz:audio', (event, buffer) => tvServer.broadcast(buffer));

  createWindow();
  createTray();

  if (config.tvMode) {
    startTvMode();
  }

  refreshCastDevices();

  // Windows screen capture (which carries the loopback audio) fails from
  // elevated processes with an opaque "Could not start video source".
  if (isElevated()) {
    console.error('Running elevated — audio capture will fail.');
    dialog.showMessageBox({
      type: 'warning',
      title: 'Butterdrop',
      message: 'Butterdrop is running as administrator.',
      detail:
        'Windows blocks screen/audio capture from elevated apps, so the visualizer cannot hear your audio. Quit and start Butterdrop from a normal (non-administrator) terminal or shortcut.',
    });
  }

  const registered = globalShortcut.register(config.hotkey, () => toggleVisualizer());
  if (!registered) {
    console.error(`Failed to register global hotkey: ${config.hotkey} (already in use?)`);
  } else {
    console.log(`Butterdrop running in tray. Hotkey: ${config.hotkey}`);
  }

  const pickerRegistered = globalShortcut.register(config.pickerHotkey, () => openSourcePicker());
  if (!pickerRegistered) {
    console.error(`Failed to register picker hotkey: ${config.pickerHotkey} (already in use?)`);
  } else {
    console.log(`Source picker hotkey: ${config.pickerHotkey}`);
  }

  if (process.argv.includes('--show')) {
    showVisualizer();
  }

  // Self-test: show the visualizer with the source picker, run briefly, then exit.
  if (process.argv.includes('--smoke')) {
    showVisualizer(true);
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
  tvServer.stop();
});

function isElevated() {
  if (process.platform !== 'win32') return false;
  try {
    // `net session` succeeds only with administrator rights.
    require('child_process').execSync('net session', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
