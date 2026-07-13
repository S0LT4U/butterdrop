'use strict';

// Spike receiver (runs on the TV via DashCast, or any browser): accept the
// WebRTC offer, play the incoming video track fullscreen, and beacon getStats
// back to the signaling server so metrics are readable in its terminal.

const video = document.getElementById('v');
const hud = document.getElementById('hud');

let pc = null;
let ws = null;

function log(...a) {
  console.log('[receiver]', ...a);
}

function beacon(text) {
  try {
    fetch('/stats', { method: 'POST', body: text }).catch(() => {});
  } catch {}
}

window.onerror = (m, s, l) => beacon(`onerror: ${m} @ ${s}:${l}`);

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    log('signaling open');
    ws.send(JSON.stringify({ type: 'hello', role: 'receiver' }));
    beacon('receiver connected: ' + navigator.userAgent.slice(0, 100));
  };
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'offer') {
      log('got offer');
      await handleOffer(msg.sdp);
    } else if (msg.type === 'ice' && msg.candidate) {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (err) {
        log('addIce err', err.message);
      }
    }
  };
  ws.onclose = () => {
    log('signaling closed — retry');
    setTimeout(connect, 2000);
  };
}

async function handleOffer(sdp) {
  pc = new RTCPeerConnection({ iceServers: [] });
  pc.ontrack = (e) => {
    log('track received');
    video.srcObject = e.streams[0];
    video.play().catch((err) => beacon('video.play failed: ' + err.message));
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
  };
  pc.onconnectionstatechange = () => {
    log('pc state', pc.connectionState);
    beacon('pc state: ' + pc.connectionState);
  };
  await pc.setRemoteDescription({ type: 'offer', sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'answer', sdp: answer.sdp }));
  log('answer sent');
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
          `freezeDur=${(s.totalFreezesDuration || 0).toFixed(1)}s ` +
          `jitter=${((s.jitter || 0) * 1000).toFixed(0)}ms ` +
          `lost=${s.packetsLost || 0} ` +
          `kbps=${s.bytesReceived ? Math.round((s.bytesReceived * 8) / 1000) : 0}`;
      }
    });
    hud.textContent = line;
    beacon(line);
  }, 3000);
}

connect();
