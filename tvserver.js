// TV Mode server: serves the browser-side visualizer page to devices on the
// LAN and relays raw audio samples (captured by the renderer) over WebSocket.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// Only these node_modules files are ever served.
const LIB_FILES = {
  '/lib/butterchurn.min.js': ['butterchurn', 'lib', 'butterchurn.min.js'],
  '/lib/butterchurnPresets.min.js': ['butterchurn-presets', 'lib', 'butterchurnPresets.min.js'],
  '/lib/butterchurnPresetsExtra.min.js': ['butterchurn-presets', 'lib', 'butterchurnPresetsExtra.min.js'],
  '/lib/butterchurnPresetsExtra2.min.js': ['butterchurn-presets', 'lib', 'butterchurnPresetsExtra2.min.js'],
};

let server = null;
let wss = null;
let clients = new Set();
let streamClients = new Set();
let format = { sampleRate: 48000, channels: 2 };

// Endless-WAV header for live HTTP streaming (sizes maxed out).
function wavHeader({ sampleRate, channels }) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(0xffffffff, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(0xffffffff, 40);
  return h;
}

function setFormat(newFormat) {
  format = newFormat;
  const msg = JSON.stringify({ type: 'format', ...format });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
  // WAV clients carry the format in their header; force a reconnect.
  for (const res of streamClients) res.end();
  streamClients.clear();
}

// Broadcast a control message (nextPreset / prevPreset / sound) to all screens.
function control(message) {
  const msg = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function broadcast(buffer) {
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1_000_000) {
      ws.send(buffer, { binary: true });
    }
  }
  for (const res of streamClients) {
    if (res.writableLength < 1_000_000) res.write(Buffer.from(buffer));
  }
}

function clientCount() {
  return clients.size;
}

function start({ port, token, baseDir, onClientChange, onControl }) {
  if (server) return;

  const serveFile = (res, filePath, type) => {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(data);
    });
  };

  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/') {
      if (url.searchParams.get('t') !== token) {
        res.writeHead(403);
        res.end('Forbidden: missing or bad token');
        return;
      }
      serveFile(res, path.join(baseDir, 'renderer', 'tv.html'), 'text/html');
    } else if (url.pathname === '/remote') {
      if (url.searchParams.get('t') !== token) {
        res.writeHead(403);
        res.end('Forbidden: missing or bad token');
        return;
      }
      serveFile(res, path.join(baseDir, 'renderer', 'remote.html'), 'text/html');
    } else if (url.pathname === '/control' && req.method === 'POST') {
      if (url.searchParams.get('t') !== token) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const { action } = JSON.parse(body);
          if (action === 'next') control({ type: 'nextPreset' });
          if (action === 'prev') control({ type: 'prevPreset' });
          if (action === 'sound-on') control({ type: 'sound', on: true });
          if (action === 'sound-off') control({ type: 'sound', on: false });
          if (onControl) onControl(action);
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400);
          res.end('Bad request');
        }
      });
    } else if (url.pathname === '/clienterr' && req.method === 'POST') {
      if (url.searchParams.get('t') !== token) {
        res.writeHead(403);
        res.end();
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        console.log(`[tv-client-report ${req.socket.remoteAddress}] ${body.slice(0, 500)}`);
        res.writeHead(204);
        res.end();
      });
    } else if (url.pathname === '/tv.js') {
      serveFile(res, path.join(baseDir, 'renderer', 'tv.js'), 'text/javascript');
    } else if (url.pathname === '/stream.wav') {
      if (url.searchParams.get('t') !== token) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Cache-Control': 'no-store',
        Connection: 'close',
      });
      res.write(wavHeader(format));
      streamClients.add(res);
      req.on('close', () => streamClients.delete(res));
    } else if (LIB_FILES[url.pathname]) {
      serveFile(res, path.join(baseDir, 'node_modules', ...LIB_FILES[url.pathname]), 'text/javascript');
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/audio' || url.searchParams.get('t') !== token) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.send(JSON.stringify({ type: 'format', ...format }));
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'status') {
            console.log(`[tv-client ${req.socket.remoteAddress}] ${JSON.stringify(msg)}`);
          }
        } catch {}
      });
      ws.on('close', () => {
        clients.delete(ws);
        if (onClientChange) onClientChange(clients.size);
      });
      ws.on('error', () => {});
      if (onClientChange) onClientChange(clients.size);
    });
  });

  server.on('error', (err) => {
    console.error(`TV server error: ${err.message}`);
  });

  server.listen(port, () => {
    console.log(`TV Mode server listening on port ${port}`);
  });
}

function stop() {
  for (const ws of clients) ws.terminate();
  clients.clear();
  for (const res of streamClients) res.end();
  streamClients.clear();
  if (wss) {
    wss.close();
    wss = null;
  }
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { start, stop, broadcast, setFormat, control, clientCount };
