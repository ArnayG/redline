/* Node tests for js/input/qr.js — the zero-dependency QR encoder (byte mode, ECC M, versions 1–10).
   Known vectors: the ISO/Thonky "HELLO WORLD" 1-M Reed–Solomon codewords, the format-information table for level M
   (all 8 masks, ISO 18004 Annex C) and the version-information words for versions 7–10 (Annex D).
   Round trip: an independent reader (below, written from the spec, not sharing the encoder's code) reads the format
   bits back, unmasks, de-interleaves, checks every RS block's syndromes are zero and parses the byte segment.
   Run: node tests/run.js input-qr */
'use strict';
var path = require('path');
var Q = require(path.join(__dirname, '..', 'js', 'input', 'qr.js'));

test('qr: Reed-Solomon codewords match the HELLO WORLD 1-M vector', function () {
  var data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(Q._.rsEncode(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('qr: format information words for level M, masks 0-7 (ISO 18004 table)', function () {
  var table = ['101010000010010', '101000100100101', '101111001111100', '101101101001011',
    '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
  for (var m = 0; m < 8; m++) assert.equal(Q._.formatBits(m).toString(2).padStart(15, '0'), table[m], 'mask ' + m);
});

test('qr: version information words v7-v10 (ISO 18004 Annex D)', function () {
  assert.equal(Q._.versionBits(7).toString(2).padStart(18, '0'), '000111110010010100');
  assert.equal(Q._.versionBits(8).toString(2).padStart(18, '0'), '001000010110111100');
  assert.equal(Q._.versionBits(9).toString(2).padStart(18, '0'), '001001101010011001');
  assert.equal(Q._.versionBits(10).toString(2).padStart(18, '0'), '001010010011010011');
});

test('qr: block tables add up to the total codewords of each version', function () {
  var totals = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
  for (var v = 1; v <= 10; v++) {
    var b = Q._.BLOCKS[v], n = 0, blocks = 0;
    for (var i = 1; i < b.length; i++) { n += b[i][0] * b[i][1]; blocks += b[i][0]; }
    assert.equal(n + blocks * b[0], totals[v], 'v' + v);
  }
  // byte-mode capacities at level M (ISO table): 14, 26, 42, 62, 84, 106, 122, 152, 180, 213
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(Q.capacity), [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
});

/* ---------------------------------------------------------------- independent reader */
var EXP = [], LOG = [];
(function () { var x = 1; for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = (x << 1) ^ (x & 128 ? 0x11D : 0); x &= 255; } })();
function mul(a, b) { return a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0; }
function syndromesZero(cw) {
  // codeword polynomial c(x) evaluated at a^i must be 0 for i < ec count
  for (var i = 0; i < 64; i++) {
    var s = 0;
    for (var k = 0; k < cw.length; k++) s = mul(s, EXP[i % 255]) ^ cw[k];
    if (i < cw.ecn && s !== 0) return false;
  }
  return true;
}
var FMT = {}; ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000']
  .forEach(function (s, m) { FMT[parseInt(s, 2)] = m; });
var ALIGNP = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
var ECB = [null, [10, 1, 16], [16, 1, 28], [26, 1, 44], [18, 2, 32], [24, 2, 43], [16, 4, 27], [18, 4, 31], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]];
function read(mods) {
  var n = mods.length, v = (n - 17) / 4;
  assert.ok(v === Math.floor(v) && v >= 1 && v <= 10, 'size');
  var get = function (r, c) { return mods[r][c] ? 1 : 0; };
  // format copy 1: bits 14..0 read along row 8 / column 8 near the top-left finder (MSB first)
  var seq = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]; // [row, col]
  var f = 0; for (var i = 0; i < 15; i++) f |= get(seq[i][0], seq[i][1]) << (14 - i);
  var f2 = 0; for (var j = 0; j < 7; j++) f2 |= get(n - 1 - j, 8) << (14 - j);   // copy 2: column 8 bottom (bits 14..8) …
  for (var k = 0; k < 8; k++) f2 |= get(8, n - 8 + k) << (7 - k);              // … then row 8 right (bits 7..0)
  assert.equal(f, f2, 'both format copies agree');
  assert.ok(f in FMT, 'format word is a valid level-M word');
  var mask = FMT[f];
  assert.equal(get(4 * v + 9, 8), 1, 'dark module');
  // function-module map
  var fn = []; for (var r = 0; r < n; r++) fn.push(new Array(n).fill(false));
  function box(r0, c0, h, w) { for (var r = r0; r < r0 + h; r++) for (var c = c0; c < c0 + w; c++) if (r >= 0 && c >= 0 && r < n && c < n) fn[r][c] = true; }
  box(0, 0, 9, 9); box(0, n - 8, 9, 8); box(n - 8, 0, 8, 9);
  box(6, 0, 1, n); box(0, 6, n, 1);
  var al = ALIGNP[v];
  al.forEach(function (a, ia) { al.forEach(function (b, ib) { var L = al.length - 1; if ((ia === 0 && ib === 0) || (ia === 0 && ib === L) || (ia === L && ib === 0)) return; box(a - 2, b - 2, 5, 5); }); });
  if (v >= 7) { box(0, n - 11, 6, 3); box(n - 11, 0, 3, 6); }
  var maskFn = [
    function (r, c) { return (r + c) % 2 === 0; }, function (r) { return r % 2 === 0; }, function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; }, function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return (r * c) % 2 + (r * c) % 3 === 0; }, function (r, c) { return ((r * c) % 2 + (r * c) % 3) % 2 === 0; },
    function (r, c) { return ((r + c) % 2 + (r * c) % 3) % 2 === 0; }][mask];
  // read bits in the zig-zag order
  var bits = [];
  var col = n - 1, upward = true;
  while (col > 0) {
    if (col === 6) col--;
    for (var t = 0; t < n; t++) {
      var row = upward ? n - 1 - t : t;
      for (var d = 0; d < 2; d++) { var cc = col - d; if (!fn[row][cc]) bits.push(get(row, cc) ^ (maskFn(row, cc) ? 1 : 0)); }
    }
    col -= 2; upward = !upward;
  }
  var bytes = []; for (var q = 0; q + 8 <= bits.length; q += 8) { var x = 0; for (var e = 0; e < 8; e++) x = (x << 1) | bits[q + e]; bytes.push(x); }
  // de-interleave
  var spec = ECB[v], ecn = spec[0], sizes = [];
  for (var g = 1; g < spec.length; g += 2) for (var z = 0; z < spec[g]; z++) sizes.push(spec[g + 1]);
  var blocks = sizes.map(function () { return []; }), p = 0, maxD = Math.max.apply(null, sizes);
  for (var di = 0; di < maxD; di++) sizes.forEach(function (s, bi) { if (di < s) blocks[bi].push(bytes[p++]); });
  var data = []; blocks.forEach(function (b) { data = data.concat(b); });
  var ecs = blocks.map(function () { return []; });
  for (var ei = 0; ei < ecn; ei++) ecs.forEach(function (eb) { eb.push(bytes[p++]); });
  blocks.forEach(function (b, bi) { var cw = b.concat(ecs[bi]); cw.ecn = ecn; assert.ok(syndromesZero(cw), 'RS block ' + bi + ' syndromes'); });
  // parse: byte mode only
  var bp = 0; function take(nb) { var y = 0; for (var u = 0; u < nb; u++) { y = (y << 1) | ((data[bp >> 3] >> (7 - (bp & 7))) & 1); bp++; } return y; }
  assert.equal(take(4), 4, 'byte mode indicator');
  var len = take(v < 10 ? 8 : 16), out = [];
  for (var o = 0; o < len; o++) out.push(take(8));
  return { version: v, mask: mask, text: Buffer.from(out).toString('utf8') };
}

test('qr: round trip through an independent reader for every version 1-10 and every mask', function () {
  for (var v = 1; v <= 10; v++) {
    var cap = Q.capacity(v), txt = '';
    for (var i = 0; txt.length < cap; i++) txt += 'FORGE-wheel/' + (i * 7 + v) + '#';
    txt = txt.slice(0, cap);
    for (var m = 0; m < 8; m++) {
      var qr = Q.encode(txt, { minVersion: v, mask: m });
      assert.equal(qr.version, v);
      var r = read(qr.modules);
      assert.equal(r.mask, m);
      assert.equal(r.text, txt, 'v' + v + ' mask ' + m);
    }
  }
});

test('qr: picks the smallest version, the pairing URL fits and too-long text throws', function () {
  var url = 'https://forge-racing.vercel.app/index.html#/wheel/ABCDE';
  var qr = Q.encode(url);
  assert.equal(qr.version, 4);                           // 54 bytes -> v4-M (62)
  assert.equal(read(qr.modules).text, url);
  assert.equal(Q.encode('hi').version, 1);
  var utf = 'Lenkrad · ハンドル 🚗';
  assert.equal(read(Q.encode(utf).modules).text, utf);
  assert.throws(function () { Q.encode(new Array(215).join('x')); }, /do not fit/);
  var svg = Q.toSvg(url, { size: 200 });
  assert.ok(/^<svg[^>]+viewBox="0 0 41 41"/.test(svg), 'v4 = 33 modules + 2x4 quiet zone');
  assert.ok(svg.indexOf('<path') > 0);
});
