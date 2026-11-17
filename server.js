const http = require('http');
const net = require('net');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const log = [];

function acceptKey(k) { return crypto.createHash('sha1').update(k + GUID).digest('base64'); }

function mkFrame(op, payload, mask) {
  const len = payload.length;
  let hdr;
  if (len < 126) hdr = Buffer.from([0x80 | op, (mask ? 0x80 : 0) | len]);
  else if (len < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | op; hdr[1] = (mask ? 0x80 : 0) | 126; hdr.writeUInt16BE(len, 2); }
  else { hdr = Buffer.alloc(10); hdr[0] = 0x80 | op; hdr[1] = (mask ? 0x80 : 0) | 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
  if (!mask) return Buffer.concat([hdr, payload]);
  const key = crypto.randomBytes(4);
  const p = Buffer.from(payload);
  for (let i = 0; i < p.length; i++) p[i] ^= key[i % 4];
  return Buffer.concat([hdr, key, p]);
}

function parseFrames(buf) {
  const out = [];
  let o = buf;
  while (o.length >= 2) {
    const b0 = o[0], b1 = o[1];
    const op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (o.length < 4) break; len = o.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (o.length < 10) break; len = Number(o.readBigUInt64BE(2)); off = 10; }
    let mk = null;
    if (masked) { if (o.length < off + 4) break; mk = o.slice(off, off + 4); off += 4; }
    if (o.length < off + len) break;
    let pl = Buffer.from(o.slice(off, off + len));
    if (mk) for (let i = 0; i < pl.length; i++) pl[i] ^= mk[i % 4];
    out.push({ op, payload: pl });
    o = o.slice(off + len);
  }
  return { frames: out, rest: o };
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/report')) {
    let outbound;
    try {
      const t0 = Date.now();
      const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8000) });
      outbound = { ok: true, ms: Date.now() - t0, body: (await r.text()).slice(0, 200) };
    } catch (e) { outbound = { ok: false, err: String((e && e.message) || e) }; }
    let outboundTcp = 'untested';
    try {
      outboundTcp = await new Promise((resolve) => {
        const s = net.connect(443, '1.1.1.1', () => { resolve('tcp443 ok'); s.destroy(); });
        s.setTimeout(6000, () => { resolve('tcp443 timeout'); s.destroy(); });
        s.on('error', (e) => resolve('tcp443 err ' + e.message));
      });
    } catch (e) { outboundTcp = 'err ' + e.message; }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: 1, version: 'ws-tunnel-1', env: { PORT: process.env.PORT, HOSTNAME: process.env.HOSTNAME }, outbound, outboundTcp, log: log.slice(-10) }, null, 2));
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('probe alive (ws tunnel)\n');
});

server.on('connect', (req, clientSocket, head) => {
  const [host, port] = req.url.split(':');
  const up = net.connect(Number(port) || 443, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(clientSocket); clientSocket.pipe(up);
  });
  up.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => up.destroy());
});

server.on('upgrade', (req, socket) => {
  if (!req.url.startsWith('/tunnel') || !req.headers['sec-websocket-key']) { socket.destroy(); return; }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acceptKey(req.headers['sec-websocket-key']) + '\r\n\r\n');
  let buf = Buffer.alloc(0), target = null, up = null, done = false;
  const send = (op, pl) => { if (!done) { try { socket.write(mkFrame(op, pl, false)); } catch (e) {} } };
  const cleanup = () => { if (done) return; done = true; try { up && up.destroy(); } catch (e) {} try { socket.destroy(); } catch (e) {} };
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    const r = parseFrames(buf); buf = r.rest;
    for (const f of r.frames) {
      if (f.op === 8) return cleanup();
      if (f.op === 9) { send(10, f.payload); continue; }
      if (f.op !== 1 && f.op !== 2) continue;
      if (!target) {
        target = f.payload.toString().trim();
        const i = target.lastIndexOf(':');
        const h = target.slice(0, i), p = Number(target.slice(i + 1)) || 443;
        log.push({ t: Date.now(), open: target });
        up = net.connect(p, h, () => send(1, Buffer.from('OK')));
        up.on('data', (d2) => send(2, d2));
        up.on('close', () => { send(8, Buffer.alloc(0)); cleanup(); });
        up.on('error', (e) => { send(1, Buffer.from('ERR ' + e.message)); cleanup(); });
      } else if (up && up.writable) up.write(f.payload);
    }
  });
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

server.listen(PORT, '0.0.0.0', () => console.log('probe+tunnel on ' + PORT));
