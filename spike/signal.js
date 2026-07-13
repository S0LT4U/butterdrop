// Disposable spike: HTTP static server + WebSocket signaling relay for a
// WebRTC test (PC-rendered Butterchurn -> the TV's browser). Relays SDP/ICE
// between the single 'sender' and 'receiver', and logs receiver getStats
// beacons so metrics are visible here without seeing the TV.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('../node_modules/ws');

const PORT = 8730;
const DIR = __dirname;
const NM = path.join(DIR, '..', 'node_modules');

const STATIC = {
  '/sender': ['sender.html', 'text/html'],
  '/sender.js': ['sender.js', 'text/javascript'],
  '/receiver': ['receiver.html', 'text/html'],
  '/receiver.js': ['receiver.js', 'text/javascript'],
};
const LIB = {
  '/lib/butterchurn.min.js': ['butterchurn', 'lib', 'butterchurn.min.js'],
  '/lib/butterchurnPresets.min.js': ['butterchurn-presets', 'lib', 'butterchurnPresets.min.js'],
};

function lanIp() {
  const cands = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      let score = 0;
      if (/vethernet|wsl|virtual|loopback|bluetooth|vmware|hyper-v|npcap|vpn/i.test(name)) score -= 10;
      if (a.address.startsWith('192.168.')) score += 5;
      cands.push({ ip: a.address, score });
    }
  }
  cands.sort((x, y) => y.score - x.score);
  return cands.length ? cands[0].ip : 'localhost';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/stats' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      console.log(`[receiver stats] ${body.slice(0, 500)}`);
      res.writeHead(204);
      res.end();
    });
    return;
  }
  const s = STATIC[url.pathname];
  if (s) return serve(res, path.join(DIR, s[0]), s[1]);
  const l = LIB[url.pathname];
  if (l) return serve(res, path.join(NM, ...l), 'text/javascript');
  res.writeHead(404);
  res.end('not found');
});

function serve(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// Signaling: one peer per role; relay messages to the other role.
const wss = new WebSocketServer({ server, path: '/ws' });
const peers = {};
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      peers[msg.role] = ws;
      ws.role = msg.role;
      console.log(`[signal] ${msg.role} connected`);
      if (peers.sender && peers.receiver) {
        console.log('[signal] both peers present — telling sender to start');
        peers.sender.send(JSON.stringify({ type: 'begin' }));
      }
      return;
    }
    // Relay SDP/ICE to the other role.
    const target = ws.role === 'sender' ? peers.receiver : peers.sender;
    if (target && target.readyState === target.OPEN) target.send(raw.toString());
  });
  ws.on('close', () => {
    if (ws.role) {
      delete peers[ws.role];
      console.log(`[signal] ${ws.role} disconnected`);
    }
  });
});

server.listen(PORT, () => {
  const ip = lanIp();
  console.log(`Spike server on http://${ip}:${PORT}`);
  console.log(`  sender   : http://${ip}:${PORT}/sender   (open on the PC)`);
  console.log(`  receiver : http://${ip}:${PORT}/receiver (cast/open on the TV)`);
});
