/* ==========================================================================
   FORGE — js/input/qr.js
   CB.input.qr : a tiny zero-dependency QR Code encoder (ISO/IEC 18004), byte mode, error correction level M,
   versions 1–10 (up to 213 bytes of UTF-8). Used by the "Use phone as wheel" pairing screen to show
   <origin>/index.html#/wheel/<CODE>. Pure logic, classic script, require()-able in Node (tests/input-qr.test.js).

     CB.input.qr.encode(text, opts?) -> { version, size, mask, modules: [[bool]] (row-major, true = dark) }
         opts { minVersion (1), maxVersion (10), mask (0..7; default: lowest penalty) }
         throws Error code 'too-long' when the text does not fit version maxVersion.
     CB.input.qr.toSvg(text | qr, opts?) -> '<svg …>' string   opts { quiet: 4, dark: '#000', light: '#fff', size }
     CB.input.qr.toPath(qr, quiet?) -> SVG path data of the dark modules
     CB.input.qr._ : { rsEncode(data, n), formatBits(mask), versionBits(v), dataCodewords(bytes, v), BLOCKS, ALIGN,
                       gfMul, utf8, buildMatrix } (internals exposed for the unit tests)
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.input = CB.input || {};

(function () {
  'use strict';

  /* ECC level M per version: [ec codewords per block, [blocks, data codewords per block], …groups] */
  var BLOCKS = [null,
    [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
    [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]]];
  var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  var REMAINDER = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];
  var MAX_VERSION = 10;

  /* ---------------------------------------------------------------- GF(256), poly 0x11D */
  var EXP = new Array(512), LOG = new Array(256);
  (function () { var x = 1; for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; } for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255]; })();
  function gfMul(a, b) { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]; }
  var GEN = {};
  /** Generator polynomial prod_{i<n} (x - a^i), coefficients highest degree first (monic). */
  function generator(n) {
    if (GEN[n]) return GEN[n];
    var g = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(g.length + 1).fill(0);
      for (var j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= gfMul(g[j], EXP[i]); }
      g = next;
    }
    GEN[n] = g;
    return g;
  }
  /** Reed–Solomon: the n error-correction codewords of data. */
  function rsEncode(data, n) {
    var g = generator(n), ec = new Array(n).fill(0);
    for (var i = 0; i < data.length; i++) {
      var f = data[i] ^ ec[0];
      ec.shift(); ec.push(0);
      if (f) for (var j = 0; j < n; j++) ec[j] ^= gfMul(g[j + 1], f);
    }
    return ec;
  }

  /* ---------------------------------------------------------------- data */
  function utf8(s) {
    s = String(s);
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(s));
    var out = [], e = unescape(encodeURIComponent(s));
    for (var i = 0; i < e.length; i++) out.push(e.charCodeAt(i));
    return out;
  }
  function dataCapacity(v) { var b = BLOCKS[v], n = 0; for (var i = 1; i < b.length; i++) n += b[i][0] * b[i][1]; return n; }
  function countBits(v) { return v < 10 ? 8 : 16; }
  function fits(len, v) { return 4 + countBits(v) + 8 * len <= 8 * dataCapacity(v); }
  /** Byte-mode bit stream -> padded data codewords for version v. */
  function dataCodewords(bytes, v) {
    var cap = dataCapacity(v), bits = [];
    function put(val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4); put(bytes.length, countBits(v));
    bytes.forEach(function (b) { put(b, 8); });
    put(0, Math.min(4, cap * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    var out = [];
    for (var i = 0; i < bits.length; i += 8) { var x = 0; for (var k = 0; k < 8; k++) x = (x << 1) | bits[i + k]; out.push(x); }
    for (var p = 0; out.length < cap; p++) out.push(p % 2 ? 0x11 : 0xEC);
    return out;
  }
  /** Split into blocks, add RS codewords, interleave. */
  function interleave(data, v) {
    var b = BLOCKS[v], ecn = b[0], blocks = [], off = 0;
    for (var g = 1; g < b.length; g++) for (var k = 0; k < b[g][0]; k++) {
      var d = data.slice(off, off + b[g][1]); off += b[g][1];
      blocks.push({ d: d, e: rsEncode(d, ecn) });
    }
    var out = [], maxD = Math.max.apply(null, blocks.map(function (x) { return x.d.length; }));
    for (var i = 0; i < maxD; i++) blocks.forEach(function (x) { if (i < x.d.length) out.push(x.d[i]); });
    for (var j = 0; j < ecn; j++) blocks.forEach(function (x) { out.push(x.e[j]); });
    return out;
  }

  /* ---------------------------------------------------------------- BCH codes */
  /** 15-bit format information for ECC level M (bits 00) and the mask, already XOR-masked with 0x5412. */
  function formatBits(mask) {
    var data = (0 << 3) | mask, rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }
  /** 18-bit version information (versions >= 7). */
  function versionBits(v) {
    var rem = v;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    return (v << 12) | rem;
  }

  /* ---------------------------------------------------------------- matrix */
  function grid(n, val) { var g = []; for (var i = 0; i < n; i++) { var r = []; for (var j = 0; j < n; j++) r.push(val); g.push(r); } return g; }
  function bit(x, i) { return ((x >>> i) & 1) !== 0; }
  var MASKS = [
    function (x, y) { return (x + y) % 2 === 0; },
    function (x, y) { return y % 2 === 0; },
    function (x) { return x % 3 === 0; },
    function (x, y) { return (x + y) % 3 === 0; },
    function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; },
    function (x, y) { return (x * y) % 2 + (x * y) % 3 === 0; },
    function (x, y) { return ((x * y) % 2 + (x * y) % 3) % 2 === 0; },
    function (x, y) { return ((x + y) % 2 + (x * y) % 3) % 2 === 0; }
  ];

  /** Function patterns + codewords (unmasked). Returns {size, m, fn}. */
  function buildMatrix(v, codewords) {
    var size = 17 + 4 * v, m = grid(size, false), fn = grid(size, false);
    function set(x, y, d) { m[y][x] = !!d; fn[y][x] = true; }
    // timing
    for (var i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    // finders (+ separators)
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var x = c[0] + dx, y = c[1] + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        var d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    });
    // alignment
    var al = ALIGN[v], last = al.length - 1;
    for (var a = 0; a < al.length; a++) for (var b = 0; b < al.length; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) continue;
      for (var ay = -2; ay <= 2; ay++) for (var ax = -2; ax <= 2; ax++) set(al[a] + ax, al[b] + ay, Math.max(Math.abs(ax), Math.abs(ay)) !== 1);
    }
    // format area reserved (written per mask) + dark module
    drawFormat(m, fn, size, 0);
    // version info
    if (v >= 7) {
      var vb = versionBits(v);
      for (var k = 0; k < 18; k++) { var c1 = size - 11 + (k % 3), c2 = Math.floor(k / 3); set(c1, c2, bit(vb, k)); set(c2, c1, bit(vb, k)); }
    }
    // codewords, zig-zag from the bottom right
    var n = 0, total = codewords.length * 8;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (var j = 0; j < 2; j++) {
        var xx = right - j, up = ((right + 1) & 2) === 0, yy = up ? size - 1 - vert : vert;
        if (!fn[yy][xx] && n < total) { m[yy][xx] = bit(codewords[n >>> 3], 7 - (n & 7)); n++; }
      }
    }
    return { size: size, m: m, fn: fn };
  }
  function drawFormat(m, fn, size, mask) {
    var f = formatBits(mask);
    function set(x, y, d) { m[y][x] = !!d; fn[y][x] = true; }
    for (var i = 0; i <= 5; i++) set(8, i, bit(f, i));
    set(8, 7, bit(f, 6)); set(8, 8, bit(f, 7)); set(7, 8, bit(f, 8));
    for (var j = 9; j < 15; j++) set(14 - j, 8, bit(f, j));
    for (var k = 0; k < 8; k++) set(size - 1 - k, 8, bit(f, k));
    for (var l = 8; l < 15; l++) set(8, size - 15 + l, bit(f, l));
    set(8, size - 8, true);
  }
  function applyMask(base, mask) {
    var size = base.size, m = base.m.map(function (r) { return r.slice(); }), fn = base.fn;
    for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
    drawFormat(m, grid(size, false), size, mask);
    return m;
  }
  /** ISO penalty score (N1..N4). */
  function penalty(m) {
    var n = m.length, s = 0, x, y;
    function runs(get) {
      for (var a = 0; a < n; a++) {
        var len = 1;
        for (var b = 1; b <= n; b++) {
          if (b < n && get(a, b) === get(a, b - 1)) len++;
          else { if (len >= 5) s += 3 + (len - 5); len = 1; }
        }
      }
    }
    runs(function (a, b) { return m[a][b]; }); runs(function (a, b) { return m[b][a]; });
    for (y = 0; y < n - 1; y++) for (x = 0; x < n - 1; x++) { var c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) s += 3; }
    var pat = [true, false, true, true, true, false, true];
    function finderLike(get) {
      for (var a = 0; a < n; a++) for (var b = 0; b + 7 <= n; b++) {
        var ok = true;
        for (var k = 0; k < 7 && ok; k++) if (get(a, b + k) !== pat[k]) ok = false;
        if (!ok) continue;
        var lightBefore = true, lightAfter = true;
        for (var q = 1; q <= 4; q++) { if (b - q >= 0 && get(a, b - q)) lightBefore = false; if (b + 6 + q < n && get(a, b + 6 + q)) lightAfter = false; }
        if (lightBefore || lightAfter) s += 40;
      }
    }
    finderLike(function (a, b) { return m[a][b]; }); finderLike(function (a, b) { return m[b][a]; });
    var dark = 0;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) if (m[y][x]) dark++;
    s += 10 * Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5);
    return s;
  }

  /* ---------------------------------------------------------------- public */
  function encode(text, opts) {
    opts = opts || {};
    var bytes = Array.isArray(text) ? text.slice() : utf8(text);
    var minV = Math.max(1, opts.minVersion || 1), maxV = Math.min(MAX_VERSION, opts.maxVersion || MAX_VERSION), v = minV;
    while (v <= maxV && !fits(bytes.length, v)) v++;
    if (v > maxV) { var e = new Error('QR: ' + bytes.length + ' bytes do not fit version ' + maxV + '-M'); e.code = 'too-long'; throw e; }
    var cw = interleave(dataCodewords(bytes, v), v);
    var base = buildMatrix(v, cw);
    var best = null, bestMask = 0, bestScore = Infinity;
    var masks = opts.mask != null ? [opts.mask | 0] : [0, 1, 2, 3, 4, 5, 6, 7];
    masks.forEach(function (k) {
      var mm = applyMask(base, k), sc = masks.length > 1 ? penalty(mm) : 0;
      if (sc < bestScore) { bestScore = sc; best = mm; bestMask = k; }
    });
    return { version: v, size: base.size, mask: bestMask, modules: best, bytes: bytes.length, remainderBits: REMAINDER[v] };
  }
  function toPath(qr, quiet) {
    quiet = quiet == null ? 4 : quiet;
    var d = '';
    for (var y = 0; y < qr.size; y++) {
      var x = 0;
      while (x < qr.size) {
        if (!qr.modules[y][x]) { x++; continue; }
        var x0 = x; while (x < qr.size && qr.modules[y][x]) x++;
        d += 'M' + (x0 + quiet) + ' ' + (y + quiet) + 'h' + (x - x0) + 'v1h-' + (x - x0) + 'z';
      }
    }
    return d;
  }
  function toSvg(input, opts) {
    opts = opts || {};
    var qr = typeof input === 'string' || Array.isArray(input) ? encode(input, opts) : input;
    var q = opts.quiet == null ? 4 : opts.quiet, dim = qr.size + 2 * q;
    var px = opts.size ? ' width="' + opts.size + '" height="' + opts.size + '"' : '';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '"' + px + ' shape-rendering="crispEdges" role="img" aria-label="QR code">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + (opts.light || '#fff') + '"/>' +
      '<path fill="' + (opts.dark || '#000') + '" d="' + toPath(qr, q) + '"/></svg>';
  }

  var api = {
    encode: encode, toSvg: toSvg, toPath: toPath, MAX_VERSION: MAX_VERSION,
    capacity: function (v) { return Math.floor((8 * dataCapacity(v) - 4 - countBits(v)) / 8); },
    _: { rsEncode: rsEncode, formatBits: formatBits, versionBits: versionBits, dataCodewords: dataCodewords, interleave: interleave,
         BLOCKS: BLOCKS, ALIGN: ALIGN, gfMul: gfMul, EXP: EXP, LOG: LOG, utf8: utf8, buildMatrix: buildMatrix, applyMask: applyMask, penalty: penalty, MASKS: MASKS }
  };
  CB.input.qr = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
