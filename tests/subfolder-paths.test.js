/* Sub-folder safety: FORGE must work at https://example.com/<any-folder>/ (GoDaddy / cPanel), so nothing shipped may
   reference a root-absolute path ("/js/…", fetch('/api/…'), url(/…), location.href = '/…'). Also checks that the
   signalling endpoints, phone-wheel pairing URL and multiplayer share link are built from the current page URL.
   Run: node tests/run.js subfolder */
'use strict';
var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');

var PAGES = ['index.html', 'hub.html', 'race.html', 'race3d.html', 'drift.html', 'lowpoly-preview.html', 'shapes-preview.html'];
function walk(d, out) {
  fs.readdirSync(d).forEach(function (f) {
    var p = path.join(d, f), st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out); else if (/\.(html|js|css)$/.test(f)) out.push(p);
  });
  return out;
}
var FILES = PAGES.map(function (f) { return path.join(root, f); }).filter(fs.existsSync)
  .concat(walk(path.join(root, 'js'), []), walk(path.join(root, 'css'), []));

var PATTERNS = [
  [/\b(?:src|href|action|poster|data|srcset)\s*=\s*\\?["']\/(?!\/)/gi, 'root-absolute attribute'],
  [/url\(\s*["']?\/(?!\/)/gi, 'root-absolute CSS url()'],
  [/\b(?:fetch|sendBeacon|open|importScripts|register|replace|assign|Worker)\(\s*["'`]\/(?!\/)/g, 'root-absolute fetch/navigation'],
  [/\bnew URL\(\s*["'`]\/(?!\/)/g, 'root-absolute new URL()'],
  [/(?:location|\.href|\.src)\s*=\s*["'`]\/(?!\/)/g, 'root-absolute assignment'],
  [/["'`]\/(?:api|js|css|assets|img|images|index\.html|hub\.html|race3?d?\.html|drift\.html)\b/g, 'root-absolute string literal']
];

test('subfolder: no root-absolute paths in shipped HTML / JS / CSS', function () {
  assert.ok(FILES.length > 60, 'scanned ' + FILES.length + ' files');
  var hits = [];
  FILES.forEach(function (f) {
    var s = fs.readFileSync(f, 'utf8');
    PATTERNS.forEach(function (p) {
      var re = new RegExp(p[0].source, p[0].flags), m;
      while ((m = re.exec(s))) {
        var ln = s.slice(0, m.index).split('\n').length;
        hits.push(path.relative(root, f) + ':' + ln + ' ' + p[1] + ': ' + s.split('\n')[ln - 1].trim().slice(0, 120));
      }
    });
  });
  assert.deepEqual(hits, []);
});

test('subfolder: no service worker / manifest that would assume the domain root', function () {
  FILES.forEach(function (f) {
    var s = fs.readFileSync(f, 'utf8');
    assert.ok(!/serviceWorker\s*\.\s*register\(\s*["'`]\//.test(s), f);
    assert.ok(!/<link[^>]+rel=["']manifest["'][^>]+href=["']\//.test(s), f);
  });
});

test('subfolder: redirect stubs point at relative index.html', function () {
  ['hub.html', 'race.html', 'race3d.html', 'drift.html'].forEach(function (f) {
    var s = fs.readFileSync(path.join(root, f), 'utf8');
    assert.match(s, /url=index\.html#/, f + ' meta refresh');
    assert.match(s, /var target = 'index\.html#/, f + ' script target');
  });
});

test('subfolder: signalling endpoints are relative and include the PHP twin', function () {
  var S = require(path.join(root, 'js', 'net', 'signal.js'));
  assert.deepEqual(S.ENDPOINTS, ['api/signal.php', 'api/signal']);
  S.ENDPOINTS.forEach(function (u) { assert.ok(!/^\/|^[a-z]+:/i.test(u), u); });
  assert.ok(fs.existsSync(path.join(root, 'api', 'signal.php')));
});

test('subfolder: phone-wheel QR URL and multiplayer share link keep the sub-folder', function () {
  require(path.join(root, 'js', 'util.js'));
  var W = require(path.join(root, 'js', 'input', 'phone-wheel.js'));
  var had = Object.prototype.hasOwnProperty.call(globalThis, 'window'), prev = globalThis.window;
  try {
    globalThis.window = { location: { origin: 'https://example.com', protocol: 'https:', host: 'example.com', pathname: '/games/forge/index.html', href: 'https://example.com/games/forge/index.html#/race' } };
    assert.equal(W.urlFor('ABCDE', 'online'), 'https://example.com/games/forge/index.html#/wheel/ABCDE');
    globalThis.window.location.pathname = '/forge/';
    assert.equal(W.baseUrl(), 'https://example.com/forge/index.html');
  } finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
  var lobbySrc = fs.readFileSync(path.join(root, 'js', 'net', 'lobby.js'), 'utf8');
  assert.match(lobbySrc, /function shareLink\(code, loc\)[\s\S]{0,300}loc\.pathname/);
});
