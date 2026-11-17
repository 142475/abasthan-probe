const http = require('http');
const net = require('net');

const PORT = process.env.PORT || 3000;
const log = [];

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/report')) {
    let outbound;
    try {
      const t0 = Date.now();
      const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8000) });
      outbound = { ok: true, ms: Date.now() - t0, body: (await r.text()).slice(0, 200) };
    } catch (e) {
      outbound = { ok: false, err: String(e && e.message || e) };
    }
    let outboundTcp = 'untested';
    try {
      outboundTcp = await new Promise((resolve) => {
        const s = net.connect(443, '1.1.1.1', () => { resolve('tcp443 ok'); s.destroy(); });
        s.setTimeout(6000, () => { resolve('tcp443 timeout'); s.destroy(); });
        s.on('error', (e) => resolve('tcp443 err ' + e.message));
      });
    } catch (e) { outboundTcp = 'err ' + e.message; }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      method: req.method, url: req.url, headers: req.headers,
      env: { PORT: process.env.PORT, HOSTNAME: process.env.HOSTNAME },
      outbound, outboundTcp, connectLog: log.slice(-10)
    }, null, 2));
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('probe alive\n');
});

server.on('connect', (req, clientSocket, head) => {
  const [host, port] = req.url.split(':');
  log.push({ t: new Date().toISOString(), connect: req.url });
  const up = net.connect(Number(port) || 443, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(clientSocket);
    clientSocket.pipe(up);
  });
  up.on('error', (e) => { log.push({ connectFail: req.url, err: e.message }); clientSocket.destroy(); });
  clientSocket.on('error', () => up.destroy());
});

server.listen(PORT, '0.0.0.0', () => console.log('probe listening on ' + PORT));
