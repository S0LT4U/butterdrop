'use strict';

// Butterdrop Smooth Cast receiver (runs on the TV via DashCast). Accepts the
// WebRTC offer relayed by the PC, plays the incoming video+audio (synced) in a
// fullscreen <video>, and beacons WebRTC stats back to the PC log.

const video = document.getElementById('v');
const statusEl = document.getElementById('status');
const params = new URLSearchParams(location.search);
const token = params.get('t') || '';
// A visualizer doesn't need low latency, so buffer several seconds to absorb
// WiFi jitter (trades lag for smoothness). Override with ?buffer= seconds.
// Moderate buffer: big enough to absorb normal jitter, small enough that the
// TV's older Chromium doesn't accumulate + drop frames. Override with ?buffer=.
const BUFFER_SEC = parseFloat(params.get('buffer')) || 2;

let pc = null;
let ws = null;

function beacon(text) {
  try {
    fetch(`/clienterr?t=${token}`, { method: 'POST', body: '[smoothcast] ' + text }).catch(() => {});
  } catch {}
}

window.onerror = (m, s, l) => beacon(`onerror: ${m} @ ${s}:${l}`);

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/rtc?t=${token}&role=receiver`);
  ws.onopen = () => beacon('receiver connected: ' + navigator.userAgent.slice(0, 90));
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'offer') {
      await handleOffer(msg.sdp);
    } else if (msg.type === 'ice' && msg.candidate) {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch {}
    }
  };
  ws.onclose = () => {
    beacon('signaling closed — retry');
    setTimeout(connect, 2000);
  };
  ws.onerror = () => {};
}

async function handleOffer(sdp) {
  pc = new RTCPeerConnection({ iceServers: [] });
  pc.ontrack = (e) => {
    // Bigger jitter buffer on each receiver (video + audio) to ride out WiFi
    // jitter. Same value on both keeps A/V synced. Older Chromium property.
    try {
      e.receiver.playoutDelayHint = BUFFER_SEC;
    } catch {}
    if (video.srcObject !== e.streams[0]) {
      video.srcObject = e.streams[0];
      video.play().catch((err) => {
        // Autoplay-with-audio blocked: start muted, then the Cast context
        // usually lets us unmute on the next tick.
        beacon('play failed, retry muted: ' + err.message);
        video.muted = true;
        video.play().then(() => {
          setTimeout(() => (video.muted = false), 500);
        }).catch(() => {});
      });
    }
    statusEl.classList.add('hidden');
  };
  pc.onicecandidate = (e) => {
    if (e.candidate && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
    }
  };
  pc.onconnectionstatechange = () => beacon('pc: ' + pc.connectionState);
  await pc.setRemoteDescription({ type: 'offer', sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'answer', sdp: answer.sdp }));
  pollStats();
}

function pollStats() {
  setInterval(async () => {
    if (!pc) return;
    const report = await pc.getStats();
    let line = `state=${pc.connectionState} `;
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        line +=
          `fps=${s.framesPerSecond || 0} decoded=${s.framesDecoded || 0} ` +
          `dropped=${s.framesDropped || 0} freezes=${s.freezeCount || 0} ` +
          `jitter=${((s.jitter || 0) * 1000).toFixed(0)}ms lost=${s.packetsLost || 0}`;
      }
    });
    beacon(line);
  }, 5000);
}

connect();
