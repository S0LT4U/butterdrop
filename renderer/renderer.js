'use strict';

const bc = window.butterchurn && (window.butterchurn.default || window.butterchurn);
const canvas = document.getElementById('canvas');
const hud = document.getElementById('hud');

let running = false;
let stream = null;
let audioCtx = null;
let visualizer = null;
let rafId = null;
let cycleTimer = null;
let hudTimer = null;

let presetKeys = [];
let presetIndex = 0;
let presets = {};
let blendSeconds = 2.7;
let intervalSeconds = 30;

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

async function start(options) {
  if (running) return;
  running = true;
  intervalSeconds = (options && options.presetIntervalSeconds) || 30;
  blendSeconds = (options && options.presetBlendSeconds) || 2.7;

  try {
    // Main process grants this with system-audio loopback — no picker shown.
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    stream.getVideoTracks().forEach((t) => t.stop());

    if (stream.getAudioTracks().length === 0) {
      throw new Error('No loopback audio track available');
    }

    audioCtx = new AudioContext();
    await audioCtx.resume();

    sizeCanvas();
    visualizer = bc.createVisualizer(audioCtx, canvas, {
      width: canvas.width,
      height: canvas.height,
      pixelRatio: window.devicePixelRatio || 1,
    });

    const source = audioCtx.createMediaStreamSource(stream);
    visualizer.connectAudio(source);

    presets = collectPresets();
    presetKeys = shuffle(Object.keys(presets));
    console.log(`Presets loaded: ${presetKeys.length}`);
    loadPreset(0, 0);
    restartCycle();
    renderLoop();
    console.log('Visualizer started (system audio loopback connected)');
  } catch (err) {
    running = false;
    console.error(`Failed to start visualizer: ${err.message}`);
    showHud(`Audio capture failed: ${err.message}`, 8000);
  }
}

function stop() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(rafId);
  clearInterval(cycleTimer);
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
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
  }
});

window.vizAPI.onStart((options) => start(options));
window.vizAPI.onStop(() => stop());
window.vizAPI.onNextPreset(() => nextPreset());

if (!bc) {
  console.error('Butterchurn failed to load');
}
