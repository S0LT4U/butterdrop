'use strict';

// Butterdrop Smooth Cast sender. Runs in a dedicated off-screen (showInactive)
// window so its requestAnimationFrame render loop stays at full rate. Captures
// system loopback audio, renders Butterchurn to a canvas, and streams the
// canvas (video) + the system audio over WebRTC to the TV's /video page.
// Params (port, token) come from the loadFile query string.

const bc = window.butterchurn && (window.butterchurn.default || window.butterchurn);
const canvas = document.getElementById('c');
const params = new URLSearchParams(location.search);
const PORT = params.get('port') || '8720';
const TOKEN = params.get('t') || '';
// 4 Mbps: gentle on weak TV WiFi while still ~2x the default that pixelated.
// (Override via ?bitrate= for wired/strong links.)
const BITRATE = parseInt(params.get('bitrate'), 10) || 4_000_000;

let audioCtx = null;
let loopbackStream = null;
let visualizer = null;
let pc = null;
let ws = null;
let presetKeys = [];
let presets = {};
let presetIndex = 0;
let cycleTimer = null;

function log(...a) {
  console.log('[cast-sender]', ...a);
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
    Object.assign(all, typeof mod.getPresets === 'function' ? mod.getPresets() : mod);
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

function loadPreset(i, blend) {
  if (!visualizer || !presetKeys.length) return;
  presetIndex = ((i % presetKeys.length) + presetKeys.length) % presetKeys.length;
  visualizer.loadPreset(presets[presetKeys[presetIndex]], blend);
}

function nextPreset() {
  loadPreset(presetIndex + 1, 2.7);
  restartCycle();
}

function prevPreset() {
  loadPreset(presetIndex - 1, 2.7);
  restartCycle();
}

const CYCLE_MS = parseInt(params.get('cycle'), 10) || 30000;
function restartCycle() {
  clearInterval(cycleTimer);
  cycleTimer = setInterval(() => loadPreset(presetIndex + 1, 2.7), CYCLE_MS);
}

async function getLoopback() {
  // Main's setDisplayMediaRequestHandler grants system-audio loopback here.
  const s = await navigator.mediaDevices.getDisplayMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: true,
  });
  s.getVideoTracks().forEach((t) => t.stop());
  if (!s.getAudioTracks().length) throw new Error('no loopback audio track');
  return s;
}

async function start() {
  audioCtx = new AudioContext({ sampleRate: 48000 });
  await audioCtx.resume();
  loopbackStream = await getLoopback();
  const source = audioCtx.createMediaStreamSource(loopbackStream);

  visualizer = bc.createVisualizer(audioCtx, canvas, {
    width: canvas.width,
    height: canvas.height,
    pixelRatio: 1,
  });
  visualizer.connectAudio(source);

  presets = collectPresets();
  presetKeys = shuffle(Object.keys(presets));
  log(`presets: ${presetKeys.length}`);
  loadPreset(0, 0);
  restartCycle();

  (function render() {
    requestAnimationFrame(render);
    visualizer.render();
    rafFrames++;
  })();

  connectSignaling();
}

function connectSignaling() {
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/rtc?t=${TOKEN}&role=sender`);
  ws.onopen = () => log('signaling open');
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'begin') {
      await makeOffer();
    } else if (msg.type === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    } else if (msg.type === 'ice' && msg.candidate) {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch {}
    }
  };
  ws.onclose = () => log('signaling closed');
  ws.onerror = () => {};
}

async function makeOffer() {
  if (pc) {
    try {
      pc.close();
    } catch {}
  }
  pc = new RTCPeerConnection({ iceServers: [] });
  // Video from the canvas + audio from the system loopback. BOTH tracks must
  // share ONE MediaStream, or the receiver's ontrack fires twice with
  // different streams and the audio-only one overwrites the video (black
  // screen). One stream also keeps A/V synced.
  const videoTrack = canvas.captureStream(30).getVideoTracks()[0];
  videoTrack.contentHint = 'detail';
  const audioTrack = loopbackStream.getAudioTracks()[0];
  const outStream = new MediaStream();
  outStream.addTrack(videoTrack);
  if (audioTrack) outStream.addTrack(audioTrack);
  pc.addTrack(videoTrack, outStream);
  if (audioTrack) pc.addTrack(audioTrack, outStream);

  const vsender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  try {
    const p = vsender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = BITRATE;
    // 'maintain-resolution' drops FRAMES under constraint (visible freezing on
    // busy music). A visualizer needs smooth motion far more than sharpness, so
    // 'balanced' lets it soften resolution instead of stalling.
    p.degradationPreference = 'balanced';
    await vsender.setParameters(p);
    log(`bitrate cap ${Math.round(BITRATE / 1e6)} Mbps`);
  } catch (err) {
    log('setParameters failed:', err.message);
  }

  pc.onicecandidate = (e) => {
    if (e.candidate && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
    }
  };
  pc.onconnectionstatechange = () => log('pc:', pc.connectionState);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
  log('offer sent');
  pollSenderStats();
}

let rafFrames = 0;
function pollSenderStats() {
  setInterval(async () => {
    if (!pc) return;
    const report = await pc.getStats();
    let out = '';
    report.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') {
        out += `enc fps=${s.framesPerSecond || 0} sent=${s.framesSent || 0} ` +
          `res=${s.frameWidth || 0}x${s.frameHeight || 0} ` +
          `limit=${s.qualityLimitationReason || '?'} `;
      }
    });
    log(`renderFps=${Math.round(rafFrames / 3)} ${out}`);
    rafFrames = 0;
  }, 3000);
}

// Preset control from the tray / phone remote (main routes these here).
if (window.vizAPI) {
  window.vizAPI.onNextPreset(() => nextPreset());
  window.vizAPI.onPrevPreset(() => prevPreset());
}

if (!bc) {
  log('butterchurn failed to load');
} else {
  start().catch((err) => log('start failed:', err.message));
}
