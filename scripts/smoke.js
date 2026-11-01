import http from 'node:http';

const base = new URL(process.argv[2] || 'http://localhost:3000');
const failures = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

const get = (path) => fetch(new URL(path, base));

function rawGet(path, headers) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: base.hostname, port: base.port, path, headers, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
}

/** Status of a WebSocket handshake (101 when it upgrades). */
function upgradeStatus(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: base.hostname,
      port: base.port,
      path,
      agent: false,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
}

const STATIC_IMPORT = /^\s*import\s*['"]([^'"]+)['"]|^\s*(?:import|export)\s[^'";]*?\sfrom\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveSpecifier(spec, from, importMap) {
  for (const [key, target] of Object.entries(importMap)) {
    if (spec === key) return new URL(target, base);
    if (key.endsWith('/') && spec.startsWith(key)) return new URL(target + spec.slice(key.length), base);
  }
  return new URL(spec, from);
}

async function loadModuleGraph(entries, importMap) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const res = await fetch(url);
    const type = res.headers.get('content-type') || '';
    if (res.status !== 200 || !type.startsWith('text/javascript')) {
      check(`module ${url.pathname}`, false, `${res.status} ${type}`);
      continue;
    }
    const source = await res.text();
    const own = url.pathname.startsWith('/js/');
    const specs = [...source.matchAll(STATIC_IMPORT)].map((m) => m[1] || m[2]);
    if (own) specs.push(...[...source.matchAll(DYNAMIC_IMPORT)].map((m) => m[1]));
    for (const spec of specs) queue.push(resolveSpecifier(spec, url, importMap));
  }
  return seen.size;
}

check('healthz', (await get('/healthz')).status === 200);

const index = await get('/');
const html = await index.text();
const csp = index.headers.get('content-security-policy') || '';
check('index.html is served', index.status === 200 && html.includes('<canvas id="scene">'));
check('CSP allows the import map by hash', /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/.test(csp));
check('framing is denied', index.headers.get('x-frame-options') === 'DENY');
check('building links load the app', (await get('/o/example-org')).status === 200);

const importMapJson = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
const importMap = importMapJson ? JSON.parse(importMapJson[1]).imports : {};
check('import map maps three', typeof importMap.three === 'string');

for (const [, href] of html.matchAll(/<link rel="stylesheet" href="(\/[^"]+)"/g)) {
  const res = await get(href);
  check(`stylesheet ${href}`, res.status === 200 && (res.headers.get('content-type') || '').startsWith('text/css'));
}

const entries = [...html.matchAll(/<script[^>]*\bsrc="(\/[^"]+)"/g)].map(([, src]) => new URL(src, base));
check('index.html loads a script', entries.length > 0);
const count = await loadModuleGraph(entries, importMap);
check('every module the app imports is served', count > 1, `${count} modules`);

check('files outside public/ are not served', (await get('/server.js')).status === 404 && (await get('/package.json')).status === 404);
check('unknown host is refused', (await rawGet('/', { Host: 'evil.example' })) === 421);

const api = await get('/api/status');
const body = await api.json().catch(() => ({}));
check('API requests are proxied (503 with no API running)', api.status === 503 && typeof body.error === 'string', String(api.status));

let status = await upgradeStatus('/api/live');
check('the multiplayer WebSocket is proxied (503 with no API running)', status === 503, String(status));
status = await upgradeStatus('/api/elsewhere');
check('WebSocket upgrades elsewhere are refused', status === 404, String(status));
status = await upgradeStatus('/api/live', { Host: 'evil.example' });
check('WebSocket upgrades for an unknown host are refused', status === 421, String(status));

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
