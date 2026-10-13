#!/usr/bin/env node
/* FORGE Atelier — tools/dev-server.js  (zero dependencies)
   Serves the static site from the repo root AND /api/signal (the real api/signal.js handler) so online multiplayer
   works locally without Vercel.

     node tools/dev-server.js                     -> http://127.0.0.1:8080  (in-memory signalling store)
     node tools/dev-server.js --port 3000 --host 0.0.0.0   (LAN: friends on the same Wi-Fi can join)
     node tools/dev-server.js --upstash           (use UPSTASH_REDIS_REST_URL/_TOKEN or KV_REST_API_* from env)
     node tools/dev-server.js --no-api            (simulate a deployment without the backend -> clients use Manual mode)
   Env: PORT, HOST also accepted. */
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');
var signal = require('../api/signal.js');

var ROOT = path.resolve(__dirname, '..');
var argv = process.argv.slice(2);
function arg(name, def) { var i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && argv[i + 1].indexOf('--') !== 0 ? argv[i + 1] : def; }
function flag(name) { return argv.indexOf('--' + name) >= 0; }

var PORT = Number(arg('port', process.env.PORT || 8080));
var HOST = arg('host', process.env.HOST || '127.0.0.1');

var MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.webmanifest': 'application/manifest+json'
};

function makeApi() {
  if (flag('no-api')) return signal.createHandler({ env: {} });
  if (flag('upstash')) return signal.createHandler();
  return signal.createHandler({ redis: signal.createMemoryRedis() });
}

function createServer(opts) {
  opts = opts || {};
  var api = opts.api || makeApi();
  var root = opts.root || ROOT;
  return http.createServer(function (req, res) {
    var url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.statusCode = 400; return res.end('bad url'); }
    var p = decodeURIComponent(url.pathname);
    // api/signal.php is the PHP twin for cPanel hosting; this server answers it with the same Node handler (like the
    // vercel.json rewrite), so the client's first probe succeeds. Other .php files and the PHP data dir are never served.
    if (p === '/api/signal' || p === '/api/signal.js' || p === '/api/signal.php') return api(req, res);
    if (/\.php$/i.test(p) || /^\/api\/_data(\/|$)/.test(p)) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json; charset=utf-8'); return res.end('{"ok":false,"code":"not-found"}'); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end('method not allowed'); }
    var file = path.normalize(path.join(root, p));
    if (file !== root && file.indexOf(root + path.sep) !== 0) { res.statusCode = 403; return res.end('forbidden'); }
    fs.stat(file, function (err, st) {
      if (!err && st.isDirectory()) { file = path.join(file, 'index.html'); st = fs.existsSync(file) ? fs.statSync(file) : null; err = st ? null : err || new Error('no index'); }
      if (err || !st || !st.isFile()) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('404 ' + p); }
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Content-Length', st.size);
      res.setHeader('Cache-Control', 'no-cache');
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });
}

module.exports = { createServer: createServer, MIME: MIME };

if (require.main === module) {
  var server = createServer();
  server.listen(PORT, HOST, function () {
    var mode = flag('no-api') ? 'disabled (no-backend)' : flag('upstash') ? 'Upstash (env)' : 'in-memory';
    console.log('Redline dev server  http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT + '/   signalling: ' + mode);
  });
  server.on('error', function (e) {
    if (e.code === 'EADDRINUSE') { console.error('Port ' + PORT + ' is busy — try: node tools/dev-server.js --port ' + (PORT + 1)); process.exit(1); }
    throw e;
  });
  process.on('SIGINT', function () { server.close(); process.exit(0); });
}
