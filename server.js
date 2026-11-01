// Worktown3D web app: serves the 3D client and proxies /api, /auth and /stripe to the Worktown3D API
// (API_URL), so the browser only ever talks to this origin.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* no .env file: use the real environment */
}

const env = process.env;
const PUBLIC = path.join(ROOT, 'public');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const INDEX = path.join(PUBLIC, 'index.html');
const PORT = Number(env.PORT) || 3000;

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const PUBLIC_URL = env.PUBLIC_URL ? parseUrl(env.PUBLIC_URL) : null;
if (env.PUBLIC_URL && (!PUBLIC_URL || !/^https?:$/.test(PUBLIC_URL.protocol) || PUBLIC_URL.pathname !== '/' || PUBLIC_URL.search || PUBLIC_URL.hash)) {
  fail('PUBLIC_URL must be just an origin, like https://worktown3d.example.com');
}
const API = parseUrl(env.API_URL || 'http://127.0.0.1:3001');
if (!API || API.protocol !== 'http:' || API.pathname !== '/' || API.search || API.username || API.password) {
  fail('API_URL must be the API\'s plain http:// origin, like http://127.0.0.1:3001');
}
const HOSTED = !!PUBLIC_URL;
const HOST = env.HOST || (HOSTED ? undefined : '127.0.0.1');
const ALLOWED_HOSTS = new Set(HOSTED ? [PUBLIC_URL.host] : [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

function inlineScriptHashes(htmlFile) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const hashes = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    hashes.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return hashes;
}

const CSP = [
  "default-src 'self'",
  `script-src 'self' ${inlineScriptHashes(INDEX).join(' ')}`,
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob:",
  // Multiplayer's WebSocket is same-origin, but not every browser counts ws(s): as 'self'.
  `connect-src 'self'${HOSTED ? ` ${PUBLIC_URL.origin.replace(/^http/, 'ws')}` : ''}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  ...(HOSTED && PUBLIC_URL.protocol === 'https:' ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body) {
  const isJson = typeof body === 'object';
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function serveStatic(res, baseDir, relPath, extraHeaders = {}) {
  const file = path.normalize(path.join(baseDir, relPath));
  if (!file.startsWith(baseDir + path.sep)) return send(res, 403, 'forbidden');
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) return send(res, 404, 'not found');
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...extraHeaders });
    fs.createReadStream(file).pipe(res);
  });
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'];

function endToEnd(headers) {
  const out = { ...headers };
  for (const h of HOP_BY_HOP) delete out[h];
  return out;
}

const proxied = (pathname) => pathname.startsWith('/api/') || pathname.startsWith('/auth/') || pathname.startsWith('/stripe/');

function proxy(req, res, url) {
  const headers = endToEnd(req.headers);
  const remote = req.socket.remoteAddress || 'unknown';
  const xff = req.headers['x-forwarded-for'];
  headers['x-forwarded-for'] = typeof xff === 'string' && xff ? `${xff}, ${remote}` : remote;
  const upstream = http.request(
    {
      hostname: API.hostname.replace(/^\[|\]$/g, ''),
      port: API.port || 80,
      path: url.pathname + url.search,
      method: req.method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode, endToEnd(up.headers));
      up.pipe(res);
    },
  );
  upstream.setTimeout(60_000, () => upstream.destroy(new Error('timeout')));
  upstream.on('error', (e) => {
    if (res.headersSent) return res.destroy();
    const reason = e.errors ? e.errors.map((x) => x.message).join(', ') : e.message || e.code;
    console.error(`[proxy] ${req.method} ${url.pathname}: ${reason}`);
    send(res, 503, { error: 'The Worktown3D API is not responding' });
  });
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

// ------------------------------------------------------------------ multiplayer WebSocket
// The API's live presence socket (/api/live). The upgrade is passed through as is (the API checks the host, the
// origin and the session), then bytes flow both ways until either side closes.
const LIVE_PATH = '/api/live';

function refuseUpgrade(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function proxyUpgrade(req, socket, head) {
  socket.on('error', () => {});
  if (!ALLOWED_HOSTS.has(req.headers.host)) return refuseUpgrade(socket, 421, 'Misdirected Request');
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://placeholder').pathname);
  } catch {
    return refuseUpgrade(socket, 400, 'Bad Request');
  }
  if (pathname !== LIVE_PATH) return refuseUpgrade(socket, 404, 'Not Found');

  const remote = req.socket.remoteAddress || 'unknown';
  const xff = req.headers['x-forwarded-for'];
  const upstream = http.request({
    hostname: API.hostname.replace(/^\[|\]$/g, ''),
    port: API.port || 80,
    path: req.url,
    method: 'GET',
    // Connection and Upgrade stay: they're what asks the API to switch protocols.
    headers: { ...req.headers, 'x-forwarded-for': typeof xff === 'string' && xff ? `${xff}, ${remote}` : remote },
  });
  upstream.setTimeout(15_000, () => upstream.destroy(new Error('timeout')));
  socket.on('close', () => upstream.destroy());
  upstream.on('upgrade', (res, apiSocket, apiHead) => {
    apiSocket.setTimeout(0); // the timeout above was for the handshake; an open socket may stay quiet
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (apiHead.length) socket.write(apiHead);
    if (head.length) apiSocket.write(head);
    apiSocket.on('error', () => socket.destroy());
    apiSocket.on('close', () => socket.destroy());
    socket.on('close', () => apiSocket.destroy());
    apiSocket.pipe(socket).pipe(apiSocket);
  });
  // The API answered without upgrading (wrong origin, signed out before the handshake…): pass its status on.
  upstream.on('response', (res) => {
    res.resume();
    refuseUpgrade(socket, res.statusCode, res.statusMessage || 'Refused');
  });
  upstream.on('error', (e) => {
    const reason = e.errors ? e.errors.map((x) => x.message).join(', ') : e.message || e.code;
    console.error(`[proxy] upgrade ${LIVE_PATH}: ${reason}`);
    refuseUpgrade(socket, 503, 'Service Unavailable');
  });
  upstream.end();
}

function handle(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (req.url === '/healthz') return send(res, 200, 'ok');
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 421, 'unknown host');
  const url = new URL(req.url, 'http://placeholder');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'bad url');
  }
  if (pathname.includes('\0')) return send(res, 400, 'bad url');

  if (proxied(pathname)) return proxy(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');

  if (pathname.startsWith('/vendor/three/')) {
    const rel = pathname.slice('/vendor/three/'.length);
    if (!rel.startsWith('build/') && !rel.startsWith('examples/jsm/')) return send(res, 404, 'not found');
    return serveStatic(res, THREE_DIR, rel);
  }
  if (pathname === '/' || pathname === '/index.html' || /^\/o\/[A-Za-z0-9-]{1,39}\/?$/.test(pathname)) {
    return serveStatic(res, PUBLIC, 'index.html', { 'Content-Security-Policy': CSP });
  }
  return serveStatic(res, PUBLIC, pathname);
}

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (e) {
    console.error('[server]', e.message);
    if (!res.headersSent) send(res, 500, 'internal error');
    else res.destroy();
  }
});
server.on('upgrade', proxyUpgrade);
server.headersTimeout = 20_000;
server.requestTimeout = 60_000;

process.on('SIGTERM', () => {
  server.close();
  setTimeout(() => process.exit(0), 5000).unref();
});

server.listen(PORT, HOST, () => {
  const where = HOSTED ? PUBLIC_URL.origin : `http://localhost:${PORT}`;
  console.log(`\n  🏢  Worktown3D is open at  ${where}  (API: ${API.origin})\n`);
});
