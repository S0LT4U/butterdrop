'use strict';

// Butterdrop TV client: receives raw audio samples from the media PC over
// WebSocket, renders Butterchurn locally on this device's GPU, and plays the
// audio (mute with the M key, the remote page, or the device's own volume).
// Audio runs in an AudioWorklet (dedicated thread) so slow rendering can't
// cause crackle; render resolution adapts down until the device keeps up.

const bc = window.butterchurn && (window.butterchurn.default || window.butterchurn);
const canvas = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
const toast = document.getElementById('toast');

const params = new URLSearchParams(location.search);
const token = params.get('t') || '';
// Cast receivers have no way to click; they're exempt from autoplay
// restrictions, so start immediately when asked to.
const autostart = params.get('autostart') === '1';
// TV GPUs struggle at native resolution; render internally capped (the
// feedback-based visuals upscale beautifully) and let CSS stretch it.
// Override with ?res=1920 for beefier devices.
const resCap = parseInt(params.get('res'), 10) || 1280;

let audioCtx = null;
let visualizer = null;
let outputGain = null;
let feederNode = null; // ScriptProcessor fallback
let audioEl = null; // native <audio> streaming /stream.wav (primary path)
let audioMode = 'media';
let soundOn = params.get('sound') !== '0';
let ws = null;
let started = false;
let serverRate = 48000;
let channels = 2;
let toastTimer = null;
let frames = 0;
let adaptScale = 1;

// Fallback ring buffer (ScriptProcessor path only)
let ringL = null;
let ringR = null;
let ringSize = 0;
let writeIdx = 0;
let readPos = 0;
let buffered = 0;
let primed = false;

let presets = {};
let presetKeys = [];
let presetIndex = 0;

// Report problems to the PC so they show up in its logs (TVs have no console).
function report(text) {
  try {
    fetch(`/clienterr?t=${token}`, { method: 'POST', body: text }).catch(() => {});
  } catch {}
}

window.onerror = (msg, src, line) => report(`window.onerror: ${msg} @ ${src}:${line}`);

function renderSize() {
  const scale = Math.min(1, resCap / window.innerWidth) * adaptScale;
  return {
    w: Math.max(2, Math.round(window.innerWidth * scale)),
    h: Math.max(2, Math.round(window.innerHeight * scale)),
  };
}

function applySize() {
  const size = renderSize();
  canvas.width = size.w;
  canvas.height = size.h;
  if (visualizer) visualizer.setRendererSize(canvas.width, canvas.height);
}

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

function loadPresetAt(index, blend = 2.7) {
  if (!visualizer || presetKeys.length === 0) return;
  presetIndex = ((index % presetKeys.length) + presetKeys.length) % presetKeys.length;
  visualizer.loadPreset(presets[presetKeys[presetIndex]], blend);
  showToast(presetKeys[presetIndex]);
}

function nextPreset() {
  loadPresetAt(presetIndex + 1);
}

function prevPreset() {
  loadPresetAt(presetIndex - 1);
}

function setSound(on) {
  soundOn = on;
  if (outputGain) outputGain.gain.value = on ? 1 : 0;
  showToast(on ? 'Sound on' : 'Sound muted');
}

// --- ScriptProcessor fallback path ---

function initRing() {
  ringSize = serverRate * 8;
  ringL = new Float32Array(ringSize);
  ringR = new Float32Array(ringSize);
  writeIdx = 0;
  readPos = 0;
  buffered = 0;
  primed = false;
}

function pushSamples(int16) {
  const frames2 = channels === 2 ? int16.length / 2 : int16.length;
  for (let i = 0; i < frames2; i++) {
    if (channels === 2) {
      ringL[writeIdx] = int16[i * 2] / 0x8000;
      ringR[writeIdx] = int16[i * 2 + 1] / 0x8000;
    } else {
      ringL[writeIdx] = int16[i] / 0x8000;
      ringR[writeIdx] = ringL[writeIdx];
    }
    writeIdx = (writeIdx + 1) % ringSize;
  }
  buffered = Math.min(buffered + frames2, ringSize);
  if (buffered > serverRate) {
    readPos = (writeIdx - Math.floor(serverRate * 0.35) + ringSize) % ringSize;
    buffered = Math.floor(serverRate * 0.35);
  }
}

function createFallbackFeeder() {
  // 8192-sample chunks (~170 ms): heavy WebGL frames on the main thread
  // delay this callback, and bigger chunks ride out longer stalls.
  const feeder = audioCtx.createScriptProcessor(8192, 1, 2);
  feeder.onaudioprocess = (e) => {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    const target = serverRate * 0.4;
    // Servo: consume slightly faster/slower (±2%, inaudible) to hold the
    // buffer at target despite PC/TV clock drift.
    const drift = Math.max(-0.02, Math.min(0.02, ((buffered - target) / target) * 0.04));
    const r = (serverRate / audioCtx.sampleRate) * (1 + drift);
    for (let i = 0; i < outL.length; i++) {
      if (!primed) {
        if (buffered >= target) primed = true;
        else {
          outL[i] = 0;
          outR[i] = 0;
          continue;
        }
      }
      if (buffered < 2) {
        primed = false;
        outL[i] = 0;
        outR[i] = 0;
        continue;
      }
      const idx = Math.floor(readPos);
      const frac = readPos - idx;
      const j = idx % ringSize;
      const k = (idx + 1) % ringSize;
      outL[i] = ringL[j] * (1 - frac) + ringL[k] * frac;
      outR[i] = ringR[j] * (1 - frac) + ringR[k] * frac;
      readPos = (readPos + r) % ringSize;
      buffered -= r;
    }
  };
  initRing();
  return feeder;
}

// --- Networking ---

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/audio?t=${token}`);
  ws.binaryType = 'arraybuffer';

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);
      if (msg.type === 'format') {
        serverRate = msg.sampleRate;
        channels = msg.channels || 1;
        if (audioMode === 'spn') initRing();
      } else if (msg.type === 'nextPreset') {
        nextPreset();
      } else if (msg.type === 'prevPreset') {
        prevPreset();
      } else if (msg.type === 'sound') {
        setSound(msg.on);
      }
      return;
    }
    if (audioMode === 'spn') {
      pushSamples(new Int16Array(event.data));
    }
  };

  ws.onopen = () => showToast('Connected to Butterdrop');
  ws.onclose = () => {
    showToast('Connection lost — retrying…', 10000);
    setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
}

// --- Lifecycle ---

async function start() {
  if (started) return;
  started = true;
  statusEl.classList.add('hidden');
  try {
    await startInner();
    report(`started ok: mode=${audioMode} ua=${navigator.userAgent.slice(0, 100)}`);
  } catch (err) {
    report(`start failed: ${err.message} | ${err.stack ? err.stack.slice(0, 300) : ''}`);
    statusEl.classList.remove('hidden');
    statusText.textContent = `Start failed: ${err.message}`;
    started = false;
  }
}

async function startInner() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume();

  applySize();
  visualizer = bc.createVisualizer(audioCtx, canvas, {
    width: canvas.width,
    height: canvas.height,
    pixelRatio: 1,
  });

  outputGain = audioCtx.createGain();
  outputGain.gain.value = soundOn ? 1 : 0;
  outputGain.connect(audioCtx.destination);

  // Primary: native <audio> element playing the endless-WAV stream. The
  // browser's media pipeline decodes and clocks it entirely off the main
  // thread — heavy preset math can't cause audio glitches. Butterchurn
  // analyzes what the element plays, so sound and visuals stay in sync.
  try {
    audioEl = new Audio(`/stream.wav?t=${token}&r=${Date.now()}`);
    audioEl.preload = 'auto';
    const mediaSrc = audioCtx.createMediaElementSource(audioEl);
    mediaSrc.connect(outputGain);
    visualizer.connectAudio(mediaSrc);
    await audioEl.play();
    audioMode = 'media';
  } catch (err) {
    report(`media stream failed (${err.message}), using script processor`);
    audioMode = 'spn';
    audioEl = null;
    feederNode = createFallbackFeeder();
    feederNode.connect(outputGain);
    visualizer.connectAudio(feederNode);
  }

  presets = collectPresets();
  presetKeys = shuffle(Object.keys(presets));
  presetIndex = 0;
  visualizer.loadPreset(presets[presetKeys[0]], 0);
  setInterval(() => nextPreset(), 30000);

  connect();

  // Telemetry + adaptive resolution: if the device can't hold ~18 fps,
  // render smaller until it can.
  setInterval(() => {
    if (audioCtx.state !== 'running') {
      audioCtx.resume().catch(() => {});
    }
    const fpsNow = Math.round(frames / 5);
    frames = 0;
    if (fpsNow > 0 && fpsNow < 18 && canvas.width > 420 && adaptScale > 0.3) {
      adaptScale *= 0.72;
      applySize();
    }
    // Media-path watchdog: only rescue a stalled element. Do NOT chase the
    // live edge — seeks and playbackRate nudges stall this pipeline and made
    // the audio surge in waves. The startup buffer (~5s) is a fixed, stable
    // latency; leave it alone.
    let lag = 0;
    if (audioMode === 'media' && audioEl) {
      const end = audioEl.buffered.length ? audioEl.buffered.end(audioEl.buffered.length - 1) : 0;
      lag = end - audioEl.currentTime;
      if (audioEl.paused || audioEl.error) {
        audioEl.play().catch(() => {});
      }
    }
    if (ws && ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: 'status',
          ctx: audioCtx.state,
          mode: audioMode,
          lag: Math.round(lag * 100) / 100,
          buffered: Math.round(buffered),
          soundOn,
          fps: fpsNow,
          res: `${canvas.width}x${canvas.height}`,
        })
      );
    }
  }, 5000);

  // Cap rendering at ~30 fps: TVs can't hold 60 anyway, and every frame we
  // skip is main-thread time the audio callback gets to run on time.
  let lastFrame = 0;
  (function render(now) {
    requestAnimationFrame(render);
    if (now - lastFrame < 31) return;
    lastFrame = now;
    visualizer.render();
    frames++;
  })(0);

  if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}

window.addEventListener('resize', applySize);

// TV remotes send Enter for the OK button.
statusEl.addEventListener('click', start);
window.addEventListener('keydown', (e) => {
  if (!started && (e.key === 'Enter' || e.key === ' ')) {
    start();
  } else if (started && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight')) {
    nextPreset();
  } else if (started && e.key === 'ArrowLeft') {
    prevPreset();
  } else if (started && (e.key === 'm' || e.key === 'M')) {
    setSound(!soundOn);
  }
});
canvas.addEventListener('click', () => {
  if (started) nextPreset();
});

if (!bc) {
  statusText.textContent = 'Failed to load visualizer engine';
} else if (autostart) {
  start();
}
