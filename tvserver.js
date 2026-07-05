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
let sampleRate = 48000;

function setFormat(rate) {
  sampleRate = rate;
  const msg = JSON.stringify({ type: 'format', sampleRate });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function broadcast(buffer) {
  if (clients.size === 0) return;
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1_000_000) {
      ws.send(buffer, { binary: true });
    }
  }
}

function clientCount() {
  return clients.size;
}

function start({ port, token, baseDir, onClientChange }) {
  if (server) return;

  const serveFile = (res, filePath, type) => {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
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
    } else if (url.pathname === '/tv.js') {
      serveFile(res, path.join(baseDir, 'renderer', 'tv.js'), 'text/javascript');
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
      ws.send(JSON.stringify({ type: 'format', sampleRate }));
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
  if (wss) {
    wss.close();
    wss = null;
  }
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { start, stop, broadcast, setFormat, clientCount };
