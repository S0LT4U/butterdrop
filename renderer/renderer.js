'use strict';

const bc = window.butterchurn && (window.butterchurn.default || window.butterchurn);
const canvas = document.getElementById('canvas');
const hud = document.getElementById('hud');
const picker = document.getElementById('picker');
const pickerList = document.getElementById('picker-list');

const SYSTEM_SOURCE = 'system';

let running = false;
let stream = null;
let audioCtx = null;
let visualizer = null;
let sourceNode = null;
let rafId = null;
let cycleTimer = null;
let hudTimer = null;

let presetKeys = [];
let presetIndex = 0;
let presets = {};
let blendSeconds = 2.7;
let intervalSeconds = 30;

let pickerOpen = false;
let pickerItems = [];
let pickerSelected = 0;

function savedSource() {
  return localStorage.getItem('audioSource') || SYSTEM_SOURCE;
}

function collectPresets() {
  const packs = [
    window.butterchurnPresets,
    window.butterchurnPresetsExtra,
    window.butterchurnPresetsExtra2,
  ];
  const all = {};
  for (const pack of packs) {
    if (!pack) continue;
    const mod = pack.default || pack;
    const packPresets = typeof mod.getPresets === 'function' ? mod.getPresets() : mod;
    Object.assign(all, packPresets);
  }
  return all;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function showHud(text, ms = 3000) {
  hud.textContent = text;
  hud.classList.add('visible');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => hud.classList.remove('visible'), ms);
}

function sizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  if (visualizer) {
    visualizer.setRendererSize(canvas.width, canvas.height);
  }
}

function loadPreset(index, blend) {
  if (!visualizer || presetKeys.length === 0) return;
  presetIndex = ((index % presetKeys.length) + presetKeys.length) % presetKeys.length;
  const name = presetKeys[presetIndex];
  visualizer.loadPreset(presets[name], blend);
  showHud(name);
}

function nextPreset(blend = blendSeconds) {
  loadPreset(presetIndex + 1, blend);
  restartCycle();
}

function prevPreset() {
  loadPreset(presetIndex - 1, blendSeconds);
  restartCycle();
}

function restartCycle() {
  clearInterval(cycleTimer);
  cycleTimer = setInterval(() => loadPreset(presetIndex + 1, blendSeconds), intervalSeconds * 1000);
}

function renderLoop() {
  rafId = requestAnimationFrame(renderLoop);
  visualizer.render();
}

// --- Audio sources ---

async function getAudioStream(sourceId) {
  if (sourceId === SYSTEM_SOURCE) {
    // Main process grants this with system-audio loopback — no picker shown.
    const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    s.getVideoTracks().forEach((t) => t.stop());
    if (s.getAudioTracks().length === 0) {
      throw new Error('No loopback audio track available');
    }
    return s;
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: sourceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
}

function attachStream(newStream) {
  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch {}
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
  }
  stream = newStream;
  sourceNode = audioCtx.createMediaStreamSource(stream);
  visualizer.connectAudio(sourceNode);
}

async function switchSource(sourceId, label) {
  try {
    const newStream = await getAudioStream(sourceId);
    attachStream(newStream);
    localStorage.setItem('audioSource', sourceId);
    showHud(`Source: ${label}`);
    console.log(`Audio source switched: ${label}`);
  } catch (err) {
    console.error(`Failed to switch source: ${err.message}`);
    showHud(`Couldn't use that source: ${err.message}`, 5000);
  }
}

// --- Source picker overlay ---

async function listSources() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const items = [
    { id: SYSTEM_SOURCE, label: 'System Audio', badge: 'everything Windows plays' },
  ];
  inputs.forEach((d, i) => {
    items.push({ id: d.deviceId, label: d.label || `Audio input ${i + 1}`, badge: 'input' });
  });
  return items;
}

function renderPicker() {
  pickerList.innerHTML = '';
  pickerItems.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = 'item' + (i === pickerSelected ? ' selected' : '');
    const label = document.createElement('span');
    label.textContent = item.label;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = item.badge;
    el.append(label, badge);
    el.addEventListener('click', () => {
      pickerSelected = i;
      applyPickerSelection();
    });
    el.addEventListener('mousemove', () => {
      if (pickerSelected !== i) {
        pickerSelected = i;
        renderPicker();
      }
    });
    pickerList.appendChild(el);
  });
}

async function openPicker() {
  pickerItems = await listSources();
  console.log(`Sources available: ${pickerItems.length}`);
  const current = savedSource();
  pickerSelected = Math.max(0, pickerItems.findIndex((it) => it.id === current));
  renderPicker();
  picker.classList.add('open');
  document.body.style.cursor = 'default';
  pickerOpen = true;
}

function closePicker() {
  picker.classList.remove('open');
  document.body.style.cursor = 'none';
  pickerOpen = false;
}

function applyPickerSelection() {
  const item = pickerItems[pickerSelected];
  closePicker();
  if (item && item.id !== savedSource()) {
    switchSource(item.id, item.label);
  }
}

// --- Lifecycle ---

async function start(options) {
  if (running) {
    if (options && options.showPicker) openPicker();
    return;
  }
  running = true;
  intervalSeconds = (options && options.presetIntervalSeconds) || 30;
  blendSeconds = (options && options.presetBlendSeconds) || 2.7;

  try {
    audioCtx = new AudioContext();
    await audioCtx.resume();

    sizeCanvas();
    visualizer = bc.createVisualizer(audioCtx, canvas, {
      width: canvas.width,
      height: canvas.height,
      pixelRatio: window.devicePixelRatio || 1,
    });

    let sourceId = savedSource();
    try {
      attachStream(await getAudioStream(sourceId));
    } catch (err) {
      // Saved device may be unplugged — fall back to system loopback.
      if (sourceId !== SYSTEM_SOURCE) {
        console.error(`Saved source unavailable (${err.message}), falling back to system audio`);
        sourceId = SYSTEM_SOURCE;
        localStorage.setItem('audioSource', sourceId);
        attachStream(await getAudioStream(sourceId));
      } else {
        throw err;
      }
    }

    presets = collectPresets();
    presetKeys = shuffle(Object.keys(presets));
    console.log(`Presets loaded: ${presetKeys.length}`);
    loadPreset(0, 0);
    restartCycle();
    renderLoop();
    console.log(`Visualizer started (source: ${sourceId === SYSTEM_SOURCE ? 'system loopback' : 'input device'})`);

    if (options && options.showPicker) openPicker();
  } catch (err) {
    running = false;
    console.error(`Failed to start visualizer: ${err.message}`);
    showHud(`Audio capture failed: ${err.message}`, 8000);
  }
}

function stop() {
  if (!running) return;
  running = false;
  closePicker();
  cancelAnimationFrame(rafId);
  clearInterval(cycleTimer);
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  sourceNode = null;
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  visualizer = null;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  console.log('Visualizer stopped');
}

window.addEventListener('resize', sizeCanvas);

window.addEventListener('keydown', (e) => {
  if (pickerOpen) {
    switch (e.key) {
      case 'ArrowUp':
        pickerSelected = (pickerSelected - 1 + pickerItems.length) % pickerItems.length;
        renderPicker();
        break;
      case 'ArrowDown':
        pickerSelected = (pickerSelected + 1) % pickerItems.length;
        renderPicker();
        break;
      case 'Enter':
        applyPickerSelection();
        break;
      case 'Escape':
        closePicker();
        break;
    }
    e.preventDefault();
    return;
  }
  switch (e.key) {
    case 'Escape':
      window.vizAPI.hide();
      break;
    case ' ':
    case 'ArrowRight':
      nextPreset();
      break;
    case 'ArrowLeft':
      prevPreset();
      break;
    case 's':
    case 'S':
      openPicker();
      break;
  }
});

window.vizAPI.onStart((options) => start(options));
window.vizAPI.onStop(() => stop());
window.vizAPI.onNextPreset(() => nextPreset());
window.vizAPI.onOpenPicker(() => {
  if (!running) return;
  if (pickerOpen) {
    closePicker();
  } else {
    openPicker();
  }
});

if (!bc) {
  console.error('Butterchurn failed to load');
}
