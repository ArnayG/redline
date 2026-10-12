#!/usr/bin/env node
/* ==========================================================================
   Redline (FORGE) — tools/build-zip.js
   Packs the site for GoDaddy / cPanel (Apache + PHP) into dist/redline-cpanel.zip. Zero dependencies (zlib only).

     node tools/build-zip.js                       -> dist/redline-cpanel.zip   (everything inside a "redline/" folder)
     node tools/build-zip.js --folder game         -> top folder "game/"
     node tools/build-zip.js --out /tmp/x.zip      -> custom output path
     node tools/build-zip.js --list                -> print the file list too

   Contents: the pages, css/, js/, api/signal.php, .htaccess, manifest.webmanifest + icon.svg and DEPLOY-CPANEL.txt. Left out: tests/, tools/, specs,
   Node-only files (api/signal.js, vercel.json), scratch/audit files. Every local <script src> / <link href> in the
   shipped HTML gets ?v=<content hash> so browsers pick up a new upload straight away.
   Exports (for tests): build(opts) -> {out, bytes, files:[{name,size}], build}, readZip(buf), crc32(buf).
   ========================================================================== */
'use strict';
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..');

var PAGES = ['index.html', 'hub.html', 'race.html', 'race3d.html', 'drift.html', 'lowpoly-preview.html', 'shapes-preview.html'];
var DIRS = ['css', 'js'];
var EXTRA = [
  ['.htaccess', '.htaccess'],
  ['manifest.webmanifest', 'manifest.webmanifest'],
  ['icon.svg', 'icon.svg'],
  ['api/signal.php', 'api/signal.php']
];
var SKIP_FILE = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.(md|log|map|bak|orig|tmp)$|(^|\/)_[^/]*-preview\.html$/i;

/* ---------------------------------------------------------------- CRC32 */
var CRC_TABLE = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---------------------------------------------------------------- zip writer (PKZIP 2.0, deflate, UTF-8 names) */
function dosTime(d) {
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
    date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
  };
}
/** entries: [{name, data:Buffer|null (null = directory)}] -> Buffer */
function writeZip(entries, when) {
  var dt = dosTime(when || new Date());
  var locals = [], centrals = [], offset = 0;
  entries.forEach(function (e) {
    var isDir = e.data == null;
    var name = Buffer.from(e.name, 'utf8');
    var raw = isDir ? Buffer.alloc(0) : e.data;
    var comp = isDir ? raw : zlib.deflateRawSync(raw, { level: 9 });
    var method = 8;
    if (isDir || comp.length >= raw.length) { comp = raw; method = 0; }
    var crc = isDir ? 0 : crc32(raw);
    var flags = 0x0800; // UTF-8 names
    var lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dt.time, 10); lh.writeUInt16LE(dt.date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    var ch = Buffer.alloc(46);
    var mode = isDir ? 0o40755 : 0o100644;
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt16LE(dt.time, 12); ch.writeUInt16LE(dt.date, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  });
  var cd = Buffer.concat(centrals);
  var end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat(locals.concat([cd, end]));
}

/** Minimal reader (central directory) used by the tests: -> [{name, data:Buffer|null, crc, method}] (CRC-checked). */
function readZip(buf) {
  var eocd = -1;
  for (var i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('no end of central directory');
  var n = buf.readUInt16LE(eocd + 10), off = buf.readUInt32LE(eocd + 16), out = [];
  for (var k = 0; k < n; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central header ' + k);
    var method = buf.readUInt16LE(off + 10), crc = buf.readUInt32LE(off + 16), csize = buf.readUInt32LE(off + 20);
    var usize = buf.readUInt32LE(off + 24), nl = buf.readUInt16LE(off + 28), xl = buf.readUInt16LE(off + 30), cl = buf.readUInt16LE(off + 32);
    var lo = buf.readUInt32LE(off + 42), name = buf.slice(off + 46, off + 46 + nl).toString('utf8');
    if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('bad local header ' + name);
    var ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    var comp = buf.slice(ds, ds + csize);
    var data = /\/$/.test(name) ? null : method === 8 ? zlib.inflateRawSync(comp) : method === 0 ? Buffer.from(comp) : null;
    if (data && (data.length !== usize || crc32(data) !== crc)) throw new Error('CRC/size mismatch ' + name);
    out.push({ name: name, data: data, crc: crc, method: method });
    off += 46 + nl + xl + cl;
  }
  return out;
}

/* ---------------------------------------------------------------- collect */
function walk(dir, rel, out) {
  fs.readdirSync(dir).sort().forEach(function (f) {
    var p = path.join(dir, f), r = rel ? rel + '/' + f : f;
    var st = fs.statSync(p);
    if (st.isDirectory()) walk(p, r, out);
    else if (st.isFile() && !SKIP_FILE.test(r)) out.push(r);
  });
  return out;
}
function hash(buf, n) { return crypto.createHash('sha1').update(buf).digest('hex').slice(0, n || 10); }

/** Add ?v=<hash> to local script/link URLs. Unknown / external / already-versioned URLs are left as they are. */
function stampHtml(html, fileHash) {
  return html.replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*)(["'])([^"'?#]+\.(?:js|css))\2/gi, function (m, pre, q, url) {
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) return m;
    var h = fileHash(url);
    return h ? pre + q + url + '?v=' + h + q : m;
  });
}

function build(opts) {
  opts = opts || {};
  var root = opts.root || ROOT;
  var folder = String(opts.folder || 'redline').replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9._-]+$/.test(folder)) throw new Error('bad --folder name: ' + folder);
  var out = opts.out || path.join(root, 'dist', 'redline-cpanel.zip');

  var files = []; // [rel, srcPath]
  PAGES.forEach(function (p) { if (fs.existsSync(path.join(root, p))) files.push([p, path.join(root, p)]); });
  DIRS.forEach(function (d) { walk(path.join(root, d), d, []).forEach(function (r) { files.push([r, path.join(root, r)]); }); });
  EXTRA.forEach(function (x) {
    var src = path.join(root, x[0]);
    if (!fs.existsSync(src)) throw new Error('missing ' + x[0]);
    files.push([x[1], src]);
  });

  var data = {};
  files.forEach(function (f) { data[f[0]] = fs.readFileSync(f[1]); });
  var hashes = {};
  Object.keys(data).forEach(function (k) { hashes[k] = hash(data[k]); });
  var buildId = hash(Buffer.from(Object.keys(hashes).sort().map(function (k) { return k + ':' + hashes[k]; }).join('\n')), 12);

  // Pages without an icon make the browser fetch /favicon.ico at the DOMAIN root (404 in a sub-folder install):
  // give them index.html's inline icon.
  var iconTag = (data['index.html'] && /<link\b[^>]*rel=["'](?:shortcut )?icon["'][^>]*>/i.exec(data['index.html'].toString('utf8')) || [])[0] ||
    '<link rel="icon" href="data:,">';
  PAGES.forEach(function (p) {
    if (!data[p]) return;
    var html = data[p].toString('utf8');
    if (!/<link\b[^>]*rel=["'](?:shortcut )?icon["']/i.test(html)) html = html.replace(/<head\b[^>]*>/i, function (m) { return m + '\n  ' + iconTag; });
    var base = path.posix.dirname(p);
    var stamped = stampHtml(html, function (url) {
      var key = path.posix.normalize(path.posix.join(base, url));
      return hashes[key] || null;
    });
    data[p] = Buffer.from(stamped, 'utf8');
  });

  var now = opts.date || new Date();
  var deploy = fs.readFileSync(path.join(root, 'tools', 'cpanel', 'DEPLOY-CPANEL.txt'), 'utf8')
    .replace(/\{\{BUILD\}\}/g, buildId).replace(/\{\{DATE\}\}/g, now.toISOString().slice(0, 19).replace('T', ' ') + ' UTC');
  data['DEPLOY-CPANEL.txt'] = Buffer.from(deploy.replace(/\r?\n/g, '\r\n'), 'utf8'); // CRLF: readable in Notepad too

  var names = Object.keys(data).sort(function (a, b) {
    // index.html and .htaccess first (nice in listings), then alphabetical
    var pa = a === 'index.html' ? 0 : a === '.htaccess' ? 1 : 2, pb = b === 'index.html' ? 0 : b === '.htaccess' ? 1 : 2;
    return pa - pb || (a < b ? -1 : a > b ? 1 : 0);
  });
  var dirs = {};
  dirs[folder + '/'] = 1;
  names.forEach(function (n) { var parts = n.split('/'); for (var i = 1; i < parts.length; i++) dirs[folder + '/' + parts.slice(0, i).join('/') + '/'] = 1; });
  var entries = Object.keys(dirs).sort().map(function (d) { return { name: d, data: null }; })
    .concat(names.map(function (n) { return { name: folder + '/' + n, data: data[n] }; }));

  var zip = writeZip(entries, now);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zip);
  return {
    out: out, bytes: zip.length, folder: folder, build: buildId,
    files: names.map(function (n) { return { name: folder + '/' + n, size: data[n].length }; }),
    rawBytes: names.reduce(function (s, n) { return s + data[n].length; }, 0)
  };
}

module.exports = { build: build, readZip: readZip, writeZip: writeZip, crc32: crc32, stampHtml: stampHtml, PAGES: PAGES };

if (require.main === module) {
  var argv = process.argv.slice(2);
  var arg = function (n) { var i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    var r = build({ folder: arg('folder'), out: arg('out') && path.resolve(arg('out')) });
    if (argv.indexOf('--list') >= 0) r.files.forEach(function (f) { console.log('  ' + f.name + '  ' + f.size); });
    console.log('Redline cPanel package: ' + path.relative(process.cwd(), r.out) + '  (' + (r.bytes / 1024).toFixed(0) + ' KB zipped, ' +
      (r.rawBytes / 1024).toFixed(0) + ' KB unzipped, ' + r.files.length + ' files, build ' + r.build + ')');
    console.log('Upload it in cPanel File Manager -> public_html -> Upload, then Extract. Site: https://yourdomain/' + r.folder + '/');
  } catch (e) {
    console.error('build failed: ' + (e && e.message));
    process.exit(1);
  }
}
