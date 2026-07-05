'use strict';

// Butterdrop TV client: receives raw audio samples from the media PC over
// WebSocket, renders Butterchurn locally on this device's GPU, and plays the
// audio (mute with the M key, the remote page, or the device's own volume).

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

let audioCtx = null;
let visualizer = null;
let outputGain = null;
let soundOn = params.get('sound') !== '0';
let ws = null;
let started = false;
let serverRate = 48000;
let channels = 2;
let toastTimer = null;

// Ring buffers (~8s) of received samples per channel, consumed with linear
// resampling to bridge server/client sample-rate differences.
let ringL = null;
let ringR = null;
let ringSize = 0;
let writeIdx = 0;
let readPos = 0;
let buffered = 0;

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

function initRing() {
  ringSize = serverRate * 8;
  ringL = new Float32Array(ringSize);
  ringR = new Float32Array(ringSize);
  writeIdx = 0;
  readPos = 0;
  buffered = 0;
}

function pushSamples(int16) {
  const frames = channels === 2 ? int16.length / 2 : int16.length;
  for (let i = 0; i < frames; i++) {
    if (channels === 2) {
      ringL[writeIdx] = int16[i * 2] / 0x8000;
      ringR[writeIdx] = int16[i * 2 + 1] / 0x8000;
    } else {
      ringL[writeIdx] = int16[i] / 0x8000;
      ringR[writeIdx] = ringL[writeIdx];
    }
    writeIdx = (writeIdx + 1) % ringSize;
  }
  buffered = Math.min(buffered + frames, ringSize);
  // If the reader fell too far behind (tab was backgrounded), skip ahead to
  // keep audio and visuals in sync with the music.
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
      if (msg.type === 'format') {
        const newChannels = msg.channels || 1;
        if (msg.sampleRate !== serverRate || newChannels !== channels) {
          serverRate = msg.sampleRate;
          channels = newChannels;
          initRing();
        }
      } else if (msg.type === 'nextPreset') {
        nextPreset();
      } else if (msg.type === 'prevPreset') {
        prevPreset();
      } else if (msg.type === 'sound') {
        setSound(msg.on);
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
  try {
    startInner();
    report(`started ok: ua=${navigator.userAgent.slice(0, 120)}`);
  } catch (err) {
    report(`start failed: ${err.message} | ${err.stack ? err.stack.slice(0, 300) : ''}`);
    statusEl.classList.remove('hidden');
    statusText.textContent = `Start failed: ${err.message}`;
    started = false;
  }
}

function startInner() {

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume();

  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  visualizer = bc.createVisualizer(audioCtx, canvas, {
    width: canvas.width,
    height: canvas.height,
    pixelRatio: window.devicePixelRatio || 1,
  });

  // Feed received samples into Butterchurn and out the device's speakers.
  const feeder = audioCtx.createScriptProcessor(2048, 1, 2);
  outputGain = audioCtx.createGain();
  outputGain.gain.value = soundOn ? 1 : 0;
  feeder.connect(outputGain);
  outputGain.connect(audioCtx.destination);
  feeder.onaudioprocess = (e) => {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    const r = serverRate / audioCtx.sampleRate;
    for (let i = 0; i < outL.length; i++) {
      if (buffered < 2) {
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
  visualizer.connectAudio(feeder);

  presets = collectPresets();
  presetKeys = shuffle(Object.keys(presets));
  presetIndex = 0;
  visualizer.loadPreset(presets[presetKeys[0]], 0);
  setInterval(() => nextPreset(), 30000);

  initRing();
  connect();

  // Some TV web views start the audio engine suspended (autoplay policy),
  // which silences playback and freezes analysis. Keep nudging it, and
  // report state to the server so problems are visible in the PC logs.
  setInterval(() => {
    if (audioCtx.state !== 'running') {
      audioCtx.resume().catch(() => {});
    }
    if (ws && ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: 'status',
          ctx: audioCtx.state,
          buffered: Math.round(buffered),
          soundOn,
          sampleRate: audioCtx.sampleRate,
        })
      );
    }
  }, 5000);

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
