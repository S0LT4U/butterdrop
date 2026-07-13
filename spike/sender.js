'use strict';

// Spike sender: render Butterchurn (driven by a synthetic oscillator so it
// self-animates without capture permissions) to a hidden WebGL canvas, then
// composite it + a frame-counter/clock overlay onto the visible 2D canvas in a
// single render loop (so the WebGL buffer reads back reliably). Capture THAT
// canvas -> RTCPeerConnection. Frame counter travels in the video for latency.

const bc = window.butterchurn && (window.butterchurn.default || window.butterchurn);
const presetsMod = window.butterchurnPresets && (window.butterchurnPresets.default || window.butterchurnPresets);
const outCanvas = document.getElementById('canvas'); // visible + captured (2D)
const statsEl = document.getElementById('stats');

const glCanvas = document.createElement('canvas'); // hidden WebGL target
glCanvas.width = outCanvas.width;
glCanvas.height = outCanvas.height;

let pc = null;
let ws = null;
let frame = 0;

function log(...a) {
  console.log('[sender]', ...a);
}

function startVisuals() {
  const audioCtx = new AudioContext();
  const osc = audioCtx.createOscillator();
  const osc2 = audioCtx.createOscillator();
  osc.type = 'sawtooth';
  osc2.type = 'sine';
  osc.frequency.value = 90;
  osc2.frequency.value = 140;
  const lfo = audioCtx.createOscillator();
  const lfoGain = audioCtx.createGain();
  lfo.frequency.value = 0.15;
  lfoGain.gain.value = 60;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);
  osc.start();
  osc2.start();
  lfo.start();

  const viz = bc.createVisualizer(audioCtx, glCanvas, {
    width: glCanvas.width,
    height: glCanvas.height,
    pixelRatio: 1,
  });
  const merger = audioCtx.createGain();
  merger.gain.value = 1;
  osc.connect(merger);
  osc2.connect(merger);
  viz.connectAudio(merger);

  const presets = presetsMod.getPresets ? presetsMod.getPresets() : presetsMod;
  const keys = Object.keys(presets);
  const pick = () => presets[keys[Math.floor(Math.random() * keys.length)]];
  viz.loadPreset(pick(), 0);
  setInterval(() => viz.loadPreset(pick(), 2.0), 20000);

  const cx = outCanvas.getContext('2d');
  (function render() {
    requestAnimationFrame(render);
    viz.render();
    // Composite in the same frame so the WebGL buffer is fresh.
    cx.drawImage(glCanvas, 0, 0, outCanvas.width, outCanvas.height);
    cx.font = 'bold 64px monospace';
    cx.fillStyle = 'rgba(0,0,0,0.55)';
    cx.fillRect(0, 0, 560, 92);
    cx.fillStyle = '#0f0';
    cx.fillText(`f=${frame} t=${performance.now().toFixed(0)}`, 12, 68);
    frame++;
  })();
}

function connectSignaling() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    log('signaling open');
    ws.send(JSON.stringify({ type: 'hello', role: 'sender' }));
  };
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'begin') {
      log('receiver present — creating offer');
      await makeOffer();
    } else if (msg.type === 'answer') {
      log('got answer');
      await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    } else if (msg.type === 'ice' && msg.candidate) {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (err) {
        log('addIceCandidate err', err.message);
      }
    }
  };
  ws.onclose = () => log('signaling closed');
}

async function makeOffer() {
  pc = new RTCPeerConnection({ iceServers: [] }); // LAN: host candidates only
  const stream = outCanvas.captureStream(30);
  const videoTrack = stream.getVideoTracks()[0];
  // Tell the encoder this is detailed content (prioritize sharpness over
  // motion-smoothness) — Butterchurn has fine detail that blurs at low bitrate.
  videoTrack.contentHint = 'detail';
  for (const track of stream.getTracks()) pc.addTrack(track, stream);

  // Raise the bitrate cap far above WebRTC's conservative ~2 Mbps default, and
  // drop framerate before resolution if the link is constrained.
  const vsender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  try {
    const params = vsender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = 12_000_000; // 12 Mbps — crisp 720p
    params.degradationPreference = 'maintain-resolution';
    await vsender.setParameters(params);
    log('bitrate cap set to 12 Mbps, maintain-resolution');
  } catch (err) {
    log('setParameters failed:', err.message);
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
  };
  pc.onconnectionstatechange = () => log('pc state:', pc.connectionState);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
  log('offer sent');
  pollStats();
}

function pollStats() {
  setInterval(async () => {
    if (!pc) return;
    const report = await pc.getStats();
    let out = `pc=${pc.connectionState} ice=${pc.iceConnectionState}\nlocalFrame=${frame}\n`;
    report.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') {
        out += `sent: fps=${s.framesPerSecond || 0} frames=${s.framesEncoded || 0}\n`;
      }
      if (s.type === 'candidate-pair' && s.nominated) {
        out += `rtt=${((s.currentRoundTripTime || 0) * 1000).toFixed(0)}ms\n`;
      }
    });
    statsEl.textContent = out;
  }, 2000);
}

if (!bc) {
  statsEl.textContent = 'Butterchurn failed to load';
} else {
  startVisuals();
  connectSignaling();
}
