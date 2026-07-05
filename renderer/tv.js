'use strict';

// Butterdrop TV client: receives raw audio samples from the media PC over
// WebSocket and renders Butterchurn locally on this device's GPU.

const bc = window.butterchurn && (window.butterchurn.default || window.butterchurn);
const canvas = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
const toast = document.getElementById('toast');

const token = new URLSearchParams(location.search).get('t') || '';

let audioCtx = null;
let visualizer = null;
let ws = null;
let started = false;
let serverRate = 48000;
let toastTimer = null;

// Ring buffer of received samples (~8s capacity), consumed with linear
// resampling to bridge server/client sample-rate differences.
let ring = null;
let ringSize = 0;
let writeIdx = 0;
let readPos = 0;
let buffered = 0;

let presets = {};
let presetKeys = [];
let presetIndex = 0;

function showToast(text, ms = 3000) {
  toast.textContent = text;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), ms);
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

function nextPreset(blend = 2.7) {
  if (!visualizer || presetKeys.length === 0) return;
  presetIndex = (presetIndex + 1) % presetKeys.length;
  visualizer.loadPreset(presets[presetKeys[presetIndex]], blend);
  showToast(presetKeys[presetIndex]);
}

function initRing() {
  ringSize = serverRate * 8;
  ring = new Float32Array(ringSize);
  writeIdx = 0;
  readPos = 0;
  buffered = 0;
}

function pushSamples(int16) {
  for (let i = 0; i < int16.length; i++) {
    ring[writeIdx] = int16[i] / 0x8000;
    writeIdx = (writeIdx + 1) % ringSize;
  }
  buffered = Math.min(buffered + int16.length, ringSize);
  // If the reader fell too far behind (tab was backgrounded), skip ahead to
  // keep visuals in sync with the music.
  if (buffered > serverRate) {
    readPos = (writeIdx - Math.floor(serverRate * 0.2) + ringSize) % ringSize;
    buffered = Math.floor(serverRate * 0.2);
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/audio?t=${token}`);
  ws.binaryType = 'arraybuffer';

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);
      if (msg.type === 'format' && msg.sampleRate !== serverRate) {
        serverRate = msg.sampleRate;
        initRing();
      }
      return;
    }
    pushSamples(new Int16Array(event.data));
  };

  ws.onopen = () => showToast('Connected to Butterdrop');
  ws.onclose = () => {
    showToast('Connection lost — retrying…', 10000);
    setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
}

function start() {
  if (started) return;
  started = true;
  statusEl.classList.add('hidden');

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume();

  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  visualizer = bc.createVisualizer(audioCtx, canvas, {
    width: canvas.width,
    height: canvas.height,
    pixelRatio: window.devicePixelRatio || 1,
  });

  // Feed received samples into Butterchurn through a silent processing node.
  const ratio = () => serverRate / audioCtx.sampleRate;
  const feeder = audioCtx.createScriptProcessor(2048, 1, 1);
  const silence = audioCtx.createGain();
  silence.gain.value = 0;
  feeder.connect(silence);
  silence.connect(audioCtx.destination);
  feeder.onaudioprocess = (e) => {
    const out = e.outputBuffer.getChannelData(0);
    const r = ratio();
    for (let i = 0; i < out.length; i++) {
      if (buffered < 2) {
        out[i] = 0;
        continue;
      }
      const idx = Math.floor(readPos);
      const frac = readPos - idx;
      const a = ring[idx % ringSize];
      const b = ring[(idx + 1) % ringSize];
      out[i] = a * (1 - frac) + b * frac;
      readPos = (readPos + r) % ringSize;
      buffered -= r;
    }
  };
  visualizer.connectAudio(feeder);

  presets = collectPresets();
  presetKeys = shuffle(Object.keys(presets));
  presetIndex = 0;
  visualizer.loadPreset(presets[presetKeys[0]], 0);
  setInterval(() => nextPreset(), 30000);

  initRing();
  connect();

  (function render() {
    requestAnimationFrame(render);
    visualizer.render();
  })();

  if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}

window.addEventListener('resize', () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  if (visualizer) visualizer.setRendererSize(canvas.width, canvas.height);
});

// TV remotes send Enter for the OK button.
statusEl.addEventListener('click', start);
window.addEventListener('keydown', (e) => {
  if (!started && (e.key === 'Enter' || e.key === ' ')) {
    start();
  } else if (started && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight')) {
    nextPreset();
  }
});
canvas.addEventListener('click', () => {
  if (started) nextPreset();
});

if (!bc) {
  statusText.textContent = 'Failed to load visualizer engine';
}
