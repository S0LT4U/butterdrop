// Minimal Google Cast v2 client — zero dependencies. Hand-encodes the single
// CastMessage protobuf type over TLS :8009 and launches DashCast (a community
// Cast receiver that displays an arbitrary URL).
const tls = require('tls');
const http = require('http');
const dgram = require('dgram');
const { EventEmitter } = require('events');

const DASHCAST_APP = '84912283';
const NS_CONN = 'urn:x-cast:com.google.cast.tp.connection';
const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
const NS_DASHCAST = 'urn:x-cast:com.madmod.dashcast';

// --- CastMessage protobuf ---

function varint(n) {
  const out = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

function lenField(tag, buf) {
  return Buffer.concat([Buffer.from([tag]), varint(buf.length), buf]);
}

function encodeCastMessage({ sourceId, destinationId, namespace, payload }) {
  const msg = Buffer.concat([
    Buffer.from([0x08, 0x00]), // protocol_version = CASTV2_1_0
    lenField(0x12, Buffer.from(sourceId)),
    lenField(0x1a, Buffer.from(destinationId)),
    lenField(0x22, Buffer.from(namespace)),
    Buffer.from([0x28, 0x00]), // payload_type = STRING
    lenField(0x32, Buffer.from(payload)),
  ]);
  const frame = Buffer.alloc(4);
  frame.writeUInt32BE(msg.length);
  return Buffer.concat([frame, msg]);
}

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (true) {
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

function decodeCastMessage(buf) {
  const msg = {};
  let pos = 0;
  while (pos < buf.length) {
    const tag = buf[pos++];
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      [, pos] = readVarint(buf, pos);
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      const data = buf.slice(pos, pos + len);
      pos += len;
      if (field === 2) msg.sourceId = data.toString();
      if (field === 4) msg.namespace = data.toString();
      if (field === 6) msg.payload = data.toString();
    } else {
      break;
    }
  }
  return msg;
}

// --- Session ---

class CastSession extends EventEmitter {
  constructor(host) {
    super();
    this.host = host;
    this.socket = null;
    this.recvBuf = Buffer.alloc(0);
    this.sessionId = null;
    this.transportId = null;
    this.heartbeat = null;
    this.requestId = 10;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect({ host: this.host, port: 8009, rejectUnauthorized: false }, () => {
        this.send('receiver-0', NS_CONN, { type: 'CONNECT' });
        this.heartbeat = setInterval(() => {
          this.send('receiver-0', NS_HEARTBEAT, { type: 'PING' });
        }, 5000);
        resolve();
      });
      this.socket.on('data', (chunk) => this.onData(chunk));
      this.socket.on('error', (err) => {
        this.emit('error', err);
        reject(err);
        this.close();
      });
      this.socket.on('close', () => {
        this.emit('closed');
        this.close();
      });
      this.socket.setTimeout(10000, () => reject(new Error('Cast connection timed out')));
    });
  }

  send(dest, namespace, payload) {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(
      encodeCastMessage({
        sourceId: 'sender-0',
        destinationId: dest,
        namespace,
        payload: JSON.stringify(payload),
      })
    );
  }

  request(dest, namespace, payload) {
    const requestId = this.requestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, resolve);
      this.send(dest, namespace, { ...payload, requestId });
      setTimeout(() => {
        if (this.pending.delete(requestId)) reject(new Error(`Cast request timed out (${payload.type})`));
      }, 8000);
    });
  }

  onData(chunk) {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
    while (this.recvBuf.length >= 4) {
      const len = this.recvBuf.readUInt32BE(0);
      if (this.recvBuf.length < 4 + len) break;
      const msg = decodeCastMessage(this.recvBuf.slice(4, 4 + len));
      this.recvBuf = this.recvBuf.slice(4 + len);
      this.handle(msg);
    }
  }

  handle(msg) {
    let payload = {};
    try {
      payload = JSON.parse(msg.payload || '{}');
    } catch {
      return;
    }
    if (msg.namespace === NS_HEARTBEAT) {
      if (payload.type === 'PING') this.send(msg.sourceId, NS_HEARTBEAT, { type: 'PONG' });
      return;
    }
    if (payload.requestId && this.pending.has(payload.requestId)) {
      const resolve = this.pending.get(payload.requestId);
      this.pending.delete(payload.requestId);
      resolve(payload);
    }
    if (msg.namespace === NS_CONN && payload.type === 'CLOSE' && msg.sourceId === this.transportId) {
      // Receiver app closed (user pressed Home, another cast took over, ...)
      this.emit('closed');
      this.close();
    }
  }

  async launch(url) {
    await this.connect();
    const status = await this.request('receiver-0', NS_RECEIVER, { type: 'LAUNCH', appId: DASHCAST_APP });
    if (payloadError(status)) throw new Error(`Launch failed: ${status.type} ${status.reason || ''}`);
    const app = ((status.status && status.status.applications) || []).find((a) => a.appId === DASHCAST_APP);
    if (!app) throw new Error('DashCast did not appear in receiver status');
    this.sessionId = app.sessionId;
    this.transportId = app.transportId;
    this.send(this.transportId, NS_CONN, { type: 'CONNECT' });
    // Give the receiver a moment to finish loading before pushing the URL.
    await new Promise((r) => setTimeout(r, 1000));
    this.send(this.transportId, NS_DASHCAST, { url, force: true, reload: 0 });
  }

  async stop() {
    if (this.sessionId) {
      try {
        await this.request('receiver-0', NS_RECEIVER, { type: 'STOP', sessionId: this.sessionId });
      } catch {}
    }
    this.close();
  }

  close() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.socket = null;
  }
}

function payloadError(payload) {
  return payload.type === 'LAUNCH_ERROR' || payload.type === 'INVALID_REQUEST';
}

// --- Discovery: SSDP (DIAL) + fetch friendly names ---

function fetchDeviceName(ip) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port: 8008, path: '/ssdp/device-desc.xml', timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        const fn = /<friendlyName>([^<]+)<\/friendlyName>/.exec(body);
        resolve(fn ? fn[1] : null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function discover(timeoutMs = 3500) {
  return new Promise((resolve) => {
    const ips = new Set();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msearch = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
        'HOST: 239.255.255.250:1900\r\n' +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        'ST: urn:dial-multiscreen-org:service:dial:1\r\n\r\n'
    );
    socket.on('message', (msg, rinfo) => {
      if (/dial-multiscreen-org/i.test(msg.toString())) ips.add(rinfo.address);
    });
    socket.on('error', () => resolve([]));
    socket.bind(0, () => {
      socket.send(msearch, 1900, '239.255.255.250');
      setTimeout(() => socket.send(msearch, 1900, '239.255.255.250'), 1200);
    });
    setTimeout(async () => {
      try {
        socket.close();
      } catch {}
      const devices = [];
      for (const ip of ips) {
        const name = await fetchDeviceName(ip);
        if (name) devices.push({ name, host: ip });
      }
      resolve(devices);
    }, timeoutMs);
  });
}

module.exports = { CastSession, discover };
