/* ==========================================================================
   FORGE Atelier — js/game/replay.js
   CB.game.replay : race replay recording, compact serialization, storage,
   interpolating playback, broadcast-style replay UI and Photo Mode.

   Pure core (Node-testable, no DOM):
     createRecorder(session, opts) -> { capture(snapshot), finish() -> Replay, ... }
     attach(session, opts)         -> recorder that auto-captures session.snapshot()
     snapshotAt(replay, t, opts)   -> RACE-SPEC compatible snapshot (interpolated)
     serialize(replay, opts)       -> base64 string (quantized + delta + varint + LZ, size-capped)
     deserialize(str)              -> Replay
     encode / decode               -> Uint8Array binary form
     resample / trim / pruneCars   -> size reduction helpers
     store                         -> localStorage 'forge.replays.v1' (last 5, size-capped, memory fallback)
     filters                       -> pure pixel ops on ImageData-like objects
   Browser:
     createPlayer(replay, renderer, hud, opts) -> { play, pause, seek, speed, setCamera, followCar, duration, ... }
     openUI(replay, opts)          -> replay screen inside #race-root (timeline, cars, cameras, speed, photo mode)
     openBrowser(opts)             -> stored replays library (watch / rename / pin / export / import / delete)
     photoMode(ui)                 -> free camera, filters, overlays, PNG export

   Binary container (before base64):
     'FRPL' | u8 formatVersion | u8 flags(bit0 = LZ) | u32 rawLength | u32 crc32(raw) | body
     raw  = varint(headerLen) header(JSON utf8) | streams...
     each numeric stream = varint(byteLen) + zigzag varints of n-th order deltas of quantized ints
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.game = CB.game || {};

CB.game.replay = (function () {
  'use strict';

  var FORMAT_VERSION = 1;
  var STORAGE_KEY = 'forge.replays.v1';
  var MAX_STORED = 5;
  var DEFAULT_ITEM_CAP = 1200000;     // chars of base64 per replay
  var DEFAULT_TOTAL_CAP = 4200000;    // chars for the whole store
  var TAU = Math.PI * 2;
  var SURFACES = ['asphalt', 'kerb', 'grass', 'sand', 'wall', 'gravel', 'dirt', 'pit', 'other'];
  var PHASES = ['grid', 'countdown', 'racing', 'finished'];
  var CAMERAS = ['director', 'chase', 'cockpit', 'orbit-car', 'helicopter', 'trackside', 'tv', 'north', 'free'];
  var CAMERA_LABELS = {
    director: 'Director', chase: 'Chase', cockpit: 'Cockpit', 'orbit-car': 'Orbit', helicopter: 'Heli', trackside: 'Trackside',
    tv: 'TV', north: 'Map', free: 'Free'
  };
  /* replay camera -> CB.race.renderer3d camera mode (+ an optional replay-side camera controller layered on top
     of the built-in mode via renderer.setCameraController). 'north' (labelled Map) is the 2D top-down view that
     renderer3d delegates to CB.race.renderer; 'trackside' has no separate 3D rig and aliases TV broadcast. */
  var CAMERA_3D = {
    director: { mode: 'tv', ctl: null }, chase: { mode: 'chase', ctl: null }, cockpit: { mode: 'cockpit', ctl: null },
    'orbit-car': { mode: 'chase', ctl: 'orbit' }, helicopter: { mode: 'heli', ctl: null }, trackside: { mode: 'tv', ctl: null },
    tv: { mode: 'tv', ctl: null }, north: { mode: 'map', ctl: null }, free: { mode: 'chase', ctl: 'free' }
  };
  /* camera buttons offered by the replay UI per backend (free is reached through photo mode / setFreeCamera) */
  var UI_CAMERAS_3D = ['director', 'chase', 'cockpit', 'orbit-car', 'helicopter', 'tv', 'north'];
  var UI_CAMERAS_2D = ['director', 'chase', 'orbit-car', 'helicopter', 'trackside', 'tv', 'north'];
  var MARKER_STYLE = {
    lap: { color: '#e8e2d0', glyph: '|', label: 'Lap' },
    overtake: { color: '#3dbf8a', glyph: '▲', label: 'Overtake' },
    collision: { color: '#e5533d', glyph: '✕', label: 'Contact' },
    wall: { color: '#f2a541', glyph: '✕', label: 'Wall hit' },
    fastestLap: { color: '#a66bff', glyph: '◆', label: 'Fastest lap' },
    penalty: { color: '#ffd23f', glyph: '!', label: 'Penalty' },
    trackLimits: { color: '#ffd23f', glyph: '·', label: 'Track limits' },
    jumpstart: { color: '#ffd23f', glyph: '!', label: 'Jump start' },
    finish: { color: '#ffffff', glyph: '⚑', label: 'Finish' },
    start: { color: '#3dbf8a', glyph: '●', label: 'Lights out' },
    offtrack: { color: '#b08a4a', glyph: '~', label: 'Off track' },
    spin: { color: '#ff7a59', glyph: '↻', label: 'Spin' }
  };

  /* ================================================================ utils */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function wrapAngle(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }
  function angleLerp(a, b, t) { return a + wrapAngle(b - a) * t; }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function uid(p) { return (p || 'r') + '_' + Date.now().toString(36) + Math.floor(Math.random() * 1e8).toString(36); }
  function deepClone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function hashStr(s) { var h = 2166136261 >>> 0; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0; var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function fmtTime(s, withMs) {
    if (!isNum(s)) return '—';
    var neg = s < 0; s = Math.abs(s);
    var m = Math.floor(s / 60), r = s - m * 60;
    var str = m + ':' + (r < 10 ? '0' : '') + (withMs === false ? Math.floor(r) : r.toFixed(withMs || 3));
    return (neg ? '-' : '') + str;
  }
  function fmtClock(s) { s = Math.max(0, num(s, 0)); var m = Math.floor(s / 60), r = Math.floor(s - m * 60); return m + ':' + (r < 10 ? '0' : '') + r; }
  function fmtBytes(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; }
  function bsearch(arr, n, t) { // largest i with arr[i] <= t (or 0)
    var lo = 0, hi = n - 1;
    if (n <= 0) return -1;
    if (t <= arr[0]) return 0;
    if (t >= arr[hi]) return hi;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (arr[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }

  /* ================================================================ bytes */

  function ByteWriter(cap) { this.buf = new Uint8Array(cap || 1024); this.len = 0; }
  ByteWriter.prototype.ensure = function (n) {
    if (this.len + n <= this.buf.length) return;
    var c = this.buf.length * 2; while (c < this.len + n) c *= 2;
    var nb = new Uint8Array(c); nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
  };
  ByteWriter.prototype.u8 = function (v) { this.ensure(1); this.buf[this.len++] = v & 255; };
  ByteWriter.prototype.u32 = function (v) {
    this.ensure(4); var b = this.buf, l = this.len;
    b[l] = v & 255; b[l + 1] = (v >>> 8) & 255; b[l + 2] = (v >>> 16) & 255; b[l + 3] = (v >>> 24) & 255; this.len += 4;
  };
  ByteWriter.prototype.varint = function (v) { // unsigned, up to 2^53
    this.ensure(8);
    while (v >= 128) { this.buf[this.len++] = (v % 128) | 128; v = Math.floor(v / 128); }
    this.buf[this.len++] = v;
  };
  ByteWriter.prototype.svarint = function (v) { this.varint(v >= 0 ? v * 2 : -v * 2 - 1); };
  ByteWriter.prototype.bytes = function (arr) { this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; };
  ByteWriter.prototype.result = function () { return this.buf.slice(0, this.len); };

  function ByteReader(buf, pos) { this.buf = buf; this.pos = pos || 0; }
  ByteReader.prototype.u8 = function () { if (this.pos >= this.buf.length) throw new Error('replay: truncated data'); return this.buf[this.pos++]; };
  ByteReader.prototype.u32 = function () {
    var b = this.buf, p = this.pos; if (p + 4 > b.length) throw new Error('replay: truncated data');
    this.pos += 4; return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 16777216;
  };
  ByteReader.prototype.varint = function () {
    var v = 0, mul = 1, b;
    do { b = this.u8(); v += (b & 127) * mul; mul *= 128; } while (b & 128);
    return v;
  };
  ByteReader.prototype.svarint = function () { var z = this.varint(); return z % 2 ? -(z + 1) / 2 : z / 2; };
  ByteReader.prototype.bytes = function (n) { if (this.pos + n > this.buf.length) throw new Error('replay: truncated data'); var r = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return r; };

  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c >= 0xD800 && c < 0xDC00 && i + 1 < str.length) { c = 0x10000 + ((c - 0xD800) << 10) + (str.charCodeAt(++i) - 0xDC00); }
      if (c < 128) out.push(c);
      else if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63));
      else if (c < 65536) out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
      else out.push(240 | (c >> 18), 128 | ((c >> 12) & 63), 128 | ((c >> 6) & 63), 128 | (c & 63));
    }
    return new Uint8Array(out);
  }
  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
    var s = '', i = 0, c;
    while (i < bytes.length) {
      c = bytes[i++];
      if (c >= 240) c = ((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      else if (c >= 224) c = ((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      else if (c >= 192) c = ((c & 31) << 6) | (bytes[i++] & 63);
      if (c >= 0x10000) { c -= 0x10000; s += String.fromCharCode(0xD800 + (c >> 10), 0xDC00 + (c & 1023)); }
      else s += String.fromCharCode(c);
    }
    return s;
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64R = (function () { var r = new Int16Array(256).fill(-1); for (var i = 0; i < 64; i++) r[B64.charCodeAt(i)] = i; r[45] = 62; r[95] = 63; return r; })();
  function base64Encode(bytes) {
    var parts = [], chunk = [], i, n = bytes.length;
    for (i = 0; i + 2 < n; i += 3) {
      var v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      chunk.push(B64[v >> 18], B64[(v >> 12) & 63], B64[(v >> 6) & 63], B64[v & 63]);
      if (chunk.length >= 16384) { parts.push(chunk.join('')); chunk = []; }
    }
    if (i < n) {
      var a = bytes[i], b = i + 1 < n ? bytes[i + 1] : 0, w = (a << 16) | (b << 8);
      chunk.push(B64[w >> 18], B64[(w >> 12) & 63], i + 1 < n ? B64[(w >> 6) & 63] : '=', '=');
    }
    parts.push(chunk.join(''));
    return parts.join('');
  }
  function base64Decode(str) {
    str = String(str).replace(/[^A-Za-z0-9+/\-_]/g, '');
    var n = str.length, outLen = Math.floor(n * 3 / 4), out = new Uint8Array(outLen), o = 0, acc = 0, bits = 0;
    for (var i = 0; i < n; i++) {
      var v = B64R[str.charCodeAt(i)]; if (v < 0) continue;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
    }
    return out.subarray(0, o);
  }

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* LZSS-style compressor: flag byte per 8 tokens; literal = 1 byte; match = u16 offset (1..65535) + u8 (len-4), len 4..259.
     Hash-chained match finder (depth-limited) — small, synchronous, deterministic. */
  var LZ_MIN = 4, LZ_MAX = 259, LZ_WIN = 65535, LZ_HASH = 1 << 15;
  function lzCompress(src, depth) {
    depth = depth || 24;
    var n = src.length, out = new ByteWriter(Math.max(64, n >> 1));
    var head = new Int32Array(LZ_HASH).fill(-1), prev = new Int32Array(Math.max(1, n));
    var i = 0, flagPos = -1, flagBit = 8, flags = 0;
    function hash(p) { return (((src[p] << 16) | (src[p + 1] << 8) | src[p + 2]) * 2654435761 >>> 17) & (LZ_HASH - 1); }
    function insert(p) { if (p + 2 < n) { var h = hash(p); prev[p] = head[h]; head[h] = p; } }
    function token(isMatch) {
      if (flagBit === 8) { if (flagPos >= 0) out.buf[flagPos] = flags; out.u8(0); flagPos = out.len - 1; flagBit = 0; flags = 0; }
      if (isMatch) flags |= 1 << flagBit;
      flagBit++;
    }
    while (i < n) {
      var bestLen = 0, bestOff = 0;
      if (i + LZ_MIN <= n) {
        var cand = head[hash(i)], tries = depth, maxLen = Math.min(LZ_MAX, n - i);
        while (cand >= 0 && i - cand <= LZ_WIN && tries-- > 0) {
          if (src[cand + bestLen] === src[i + bestLen]) {
            var l = 0; while (l < maxLen && src[cand + l] === src[i + l]) l++;
            if (l > bestLen) { bestLen = l; bestOff = i - cand; if (l === maxLen) break; }
          }
          cand = prev[cand];
        }
      }
      if (bestLen >= LZ_MIN) {
        token(true); out.ensure(3);
        out.buf[out.len++] = bestOff & 255; out.buf[out.len++] = bestOff >> 8; out.buf[out.len++] = bestLen - LZ_MIN;
        for (var k = 0; k < bestLen; k++) insert(i + k);
        i += bestLen;
      } else {
        token(false); out.u8(src[i]); insert(i); i++;
      }
    }
    if (flagPos >= 0) out.buf[flagPos] = flags;
    return out.result();
  }
  function lzDecompress(src, rawLen) {
    var out = new Uint8Array(rawLen), o = 0, i = 0, n = src.length;
    while (i < n && o < rawLen) {
      var flags = src[i++];
      for (var b = 0; b < 8 && i < n && o < rawLen; b++) {
        if (flags & (1 << b)) {
          var off = src[i] | (src[i + 1] << 8), len = src[i + 2] + LZ_MIN; i += 3;
          if (off <= 0 || off > o) throw new Error('replay: corrupt LZ stream');
          for (var k = 0; k < len && o < rawLen; k++, o++) out[o] = out[o - off];
        } else out[o++] = src[i++];
      }
    }
    if (o !== rawLen) throw new Error('replay: LZ length mismatch');
    return out;
  }

  /* ================================================================ channels */
  /* mem: in-memory typed storage. For integer mem types the stored value is round(v / q) (quantized at capture).
     For f32 the raw value is stored and quantized at serialization. order: delta order for the stream codec.
     nullable: null/NaN supported (f32 only, NaN in memory). angle: unwrapped before delta coding. */
  var CAR_CH = [
    { k: 'x', src: 'x', mem: 'f32', q: 0.005, order: 2 },
    { k: 'y', src: 'y', mem: 'f32', q: 0.005, order: 2 },
    { k: 'h', src: 'heading', mem: 'f32', q: 0.0002, order: 2, angle: true },
    { k: 's', src: 's', mem: 'f32', q: 0.01, order: 2 },
    { k: 'v', src: 'speed', mem: 'u16', q: 0.01, order: 1 },
    { k: 'rpm', src: 'rpm', mem: 'u16', q: 1, order: 1 },
    { k: 'gear', src: 'gear', mem: 'i8', q: 1, order: 1 },
    { k: 'steer', src: 'steerAngle', mem: 'i16', q: 0.0001, order: 1 },
    { k: 'thr', src: 'throttle', mem: 'u8', q: 1 / 255, order: 1 },
    { k: 'brk', src: 'brake', mem: 'u8', q: 1 / 255, order: 1 },
    { k: 'skid', src: 'skidding', mem: 'u8', q: 1 / 255, order: 1 },
    { k: 'spin', src: 'wheelspin', mem: 'u8', q: 1 / 255, order: 1 },
    { k: 'slipF', src: 'slipF', mem: 'i16', q: 0.0001, order: 1 },
    { k: 'slipR', src: 'slipR', mem: 'i16', q: 0.0001, order: 1 },
    { k: 'lat', src: 'lateral', mem: 'i16', q: 0.01, order: 1 },
    { k: 'pos', src: 'position', mem: 'u8', q: 1, order: 1 },
    { k: 'lap', src: 'lap', mem: 'u16', q: 1, order: 1 },
    { k: 'cur', src: 'currentLap_s', mem: 'f32', q: 0.001, order: 2 },
    { k: 'gapA', src: 'gapAhead_s', mem: 'f32', q: 0.001, order: 1, nullable: true },
    { k: 'gapL', src: 'gapLeader_s', mem: 'f32', q: 0.001, order: 1, nullable: true },
    { k: 'dBest', src: 'deltaBest_s', mem: 'f32', q: 0.001, order: 1, nullable: true },
    { k: 'flags', mem: 'u8', q: 1, order: 1 },
    { k: 'surf', mem: 'u8', q: 1, order: 1 }
  ];
  var FRAME_CH = [
    { k: 't', mem: 'f64', q: 0.0005, order: 2 },
    { k: 'phase', mem: 'u8', q: 1, order: 1 },
    { k: 'lights', mem: 'u8', q: 1, order: 1 },
    { k: 'race', mem: 'f32', q: 0.001, order: 2 }
  ];
  var MEM_TYPES = { f64: Float64Array, f32: Float32Array, u16: Uint16Array, i16: Int16Array, u8: Uint8Array, i8: Int8Array };
  var MEM_RANGE = { u16: [0, 65535], i16: [-32768, 32767], u8: [0, 255], i8: [-128, 127] };
  var FLAG = { finished: 1, dnf: 2, offTrack: 4, wrongWay: 8, lapValid: 16, handbrake: 32, onTrack: 64, absent: 128 };
  /* slowly-changing per-car fields, stored as keyframes on change */
  var SLOW_FIELDS = ['lastLap_s', 'bestLap_s', 'sectors', 'lastSectors', 'bestSectors', 'finishTime_s', 'finishPosition',
    'penalties_s', 'trackLimits', 'lapsDown', 'sector', 'jumpStart', 'reaction_s', 'collisions', 'gridPosition'];
  var SLOW_GLOBAL = ['fastestLap', 'sessionBestSectors', 'flag', 'leaderId', 'lapsTotal'];

  function memQuant(ch, v) {
    if (ch.mem === 'f32' || ch.mem === 'f64') return ch.nullable && !isNum(v) ? NaN : num(v, 0);
    var r = MEM_RANGE[ch.mem];
    return clamp(Math.round(num(v, 0) / ch.q), r[0], r[1]);
  }
  function memValue(ch, raw) { return (ch.mem === 'f32' || ch.mem === 'f64') ? raw : raw * ch.q; }
  function allocChannels(defs, cap) { var o = {}; defs.forEach(function (d) { o[d.k] = new MEM_TYPES[d.mem](cap); }); return o; }
  function growChannels(chs, defs, cap, n) {
    defs.forEach(function (d) { var nb = new MEM_TYPES[d.mem](cap); nb.set(chs[d.k].subarray(0, n)); chs[d.k] = nb; });
  }
  function surfaceCode(s) { var i = SURFACES.indexOf(String(s || 'asphalt')); return i < 0 ? SURFACES.length - 1 : i; }

  /* ================================================================ track outline */
  /* A compact, decimated copy of the circuit is embedded in each replay so playback (and the built-in view)
     works even when CB.race.tracks is unavailable or the track catalog changed. */
  function extractOutline(geom, step) {
    if (!geom) return null;
    var smp = geom.samples || geom.centerline || geom.points || [];
    if (!smp || smp.length < 4) return null;
    var L = num(geom.length, num(geom.length_m, 0));
    var ds = num(geom.ds, 2), every = Math.max(1, Math.round((step || 6) / ds));
    var o = { x: [], y: [], hw: [], kl: [], kr: [], wl: [], wr: [], length: L, width: num(geom.width_m, 12) };
    for (var i = 0; i < smp.length; i += every) {
      var p = smp[i], px = Array.isArray(p) ? p[0] : p.x, py = Array.isArray(p) ? p[1] : p.y;
      if (!isNum(px) || !isNum(py)) continue;
      var hw = num(p.hw, num(p.width, o.width) / 2);
      o.x.push(Math.round(px * 10)); o.y.push(Math.round(py * 10)); o.hw.push(Math.round(hw * 10));
      o.kl.push(Math.round(num(p.leftKerb, 0) * 10)); o.kr.push(Math.round(num(p.rightKerb, 0) * 10));
      o.wl.push(p.wallL != null && p.wallL < hw + 3 ? 1 : 0); o.wr.push(p.wallR != null && p.wallR < hw + 3 ? 1 : 0);
    }
    if (!L) { for (var j = 1; j < o.x.length; j++) L += Math.hypot(o.x[j] - o.x[j - 1], o.y[j] - o.y[j - 1]) / 10; o.length = L; }
    if (geom.startLine) o.start = { x: round1(geom.startLine.x), y: round1(geom.startLine.y), heading: round4(geom.startLine.heading) };
    if (geom.sectors && geom.sectors.length) o.sectors = geom.sectors.map(function (sc) { return round1(num(sc.start, 0)); });
    return o;
  }
  function round1(v) { return Math.round(num(v, 0) * 10) / 10; }
  function round3(v) { return Math.round(num(v, 0) * 1000) / 1000; }
  function round4(v) { return Math.round(num(v, 0) * 10000) / 10000; }
  /* outline -> pseudo geom compatible with consumers expecting {samples:[{x,y,hw,heading,nx,ny,s}], length} */
  function outlineGeom(o) {
    if (!o || !o.x || o.x.length < 3) return null;
    var n = o.x.length, samples = [], s = 0;
    for (var i = 0; i < n; i++) {
      var x = o.x[i] / 10, y = o.y[i] / 10, j = (i + 1) % n, k = (i - 1 + n) % n;
      var dx = o.x[j] / 10 - o.x[k] / 10, dy = o.y[j] / 10 - o.y[k] / 10, dl = Math.hypot(dx, dy) || 1;
      if (i > 0) s += Math.hypot(x - o.x[i - 1] / 10, y - o.y[i - 1] / 10);
      samples.push({ x: x, y: y, hw: o.hw[i] / 10, width: o.hw[i] / 5, heading: Math.atan2(dy, dx), nx: -dy / dl, ny: dx / dl, s: s,
        leftKerb: (o.kl[i] || 0) / 10, rightKerb: (o.kr[i] || 0) / 10, wallLeft: !!o.wl[i], wallRight: !!o.wr[i] });
    }
    var L = o.length || s;
    return {
      replayOutline: true, samples: samples, centerline: samples, n: n, count: n, ds: L / n, length: L, length_m: L, width_m: o.width,
      startLine: o.start || { x: samples[0].x, y: samples[0].y, heading: samples[0].heading },
      sectorStarts: o.sectors || [0, L / 3, 2 * L / 3], minimap: samples
    };
  }

  /* ================================================================ recorder */

  function carStatic(c, builds, buildIdx, opts) {
    var bi = -1;
    if (opts.captureBuilds !== false && c.build && typeof c.build === 'object') {
      var key; try { key = JSON.stringify(c.build); } catch (e) { key = null; }
      if (key) { if (buildIdx[key] == null) { buildIdx[key] = builds.length; builds.push(c.build); } bi = buildIdx[key]; }
    }
    return {
      id: String(c.id), isPlayer: !!c.isPlayer, name: c.name || String(c.id), team: c.team || '', number: c.number != null ? c.number : '',
      color: c.color || '#c9a56b', accent: c.accent || '#111111', bodyStyle: c.bodyStyle || (c.build && c.build.body && c.build.body.style) || 'coupe',
      length_m: num(c.length_m, 4.5), width_m: num(c.width_m, 1.9), redline: num(c.redline, 7500), maxGear: num(c.maxGear, 6), build: bi
    };
  }

  function createRecorder(session, opts) {
    opts = opts || {};
    var hz = clamp(num(opts.hz, 30), 5, 120);
    var maxFrames = Math.max(300, num(opts.maxFrames, 30 * 60 * 25));   // adaptive halving beyond this
    var maxCars = Math.max(1, num(opts.maxCars, 24));
    var maxEvents = num(opts.maxEvents, 6000);
    var R;

    function reset() {
      R = {
        n: 0, cap: 512, interval: 1 / hz, hz: hz, frames: null, cars: [], carIndex: {}, builds: [], buildIdx: {},
        events: [], slowGlobal: [], lastGlobalKey: '', lastCapT: -Infinity, lastSimT: -Infinity, lastPhase: null,
        overtakes: [], pending: [], prevPos: {}, offStart: {}, meta: {}, startedAt: Date.now(), finished: false,
        outline: null, captured: 0, dropped: 0, restarts: R ? R.restarts : 0, decimations: 0, goT: null
      };
      R.frames = allocChannels(FRAME_CH, R.cap);
      if (session) grabSessionInfo();
    }
    function grabSessionInfo() {
      try {
        var cfg = session.config || {};
        R.meta.trackId = cfg.trackId || (session.trackDef && session.trackDef.id) || null;
        R.meta.trackName = (session.trackDef && session.trackDef.name) || (session.track && session.track.name) || null;
        R.meta.mode = cfg.mode; R.meta.laps = cfg.laps; R.meta.weather = cfg.weather; R.meta.timeOfDay = cfg.timeOfDay;
        R.meta.difficulty = cfg.difficulty; R.meta.seed = cfg.seed;
        if (cfg.handling === 'arcade') R.meta.handling = 'arcade';   // ARCADE-SPEC: arcade sessions replay with their badge
        if (session.trackDef && session.trackDef.theme) R.meta.theme = deepClone(session.trackDef.theme);
        if (!R.outline && session.geom) R.outline = extractOutline(session.geom, opts.outlineStep);
      } catch (e) { /* defensive */ }
    }

    function addCar(c) {
      if (R.cars.length >= maxCars) return null;
      var cap = R.cap, car = { info: carStatic(c, R.builds, R.buildIdx, opts), ch: allocChannels(CAR_CH, cap), slow: [], lastSlowKey: '' };
      car.ch.flags.fill(FLAG.absent, 0, R.n);   // absent for frames before it appeared
      R.carIndex[car.info.id] = R.cars.length;
      R.cars.push(car);
      return car;
    }

    function grow() {
      var nc = R.cap * 2;
      growChannels(R.frames, FRAME_CH, nc, R.n);
      R.cars.forEach(function (car) { growChannels(car.ch, CAR_CH, nc, R.n); });
      R.cap = nc;
    }

    function halve() { // adaptive decimation: keep every second frame, halve rate
      var m = 0, i;
      for (i = 0; i < R.n; i += 2, m++) {
        FRAME_CH.forEach(function (d) { R.frames[d.k][m] = R.frames[d.k][i]; });
        R.cars.forEach(function (car) { CAR_CH.forEach(function (d) { car.ch[d.k][m] = car.ch[d.k][i]; }); car.slow.forEach(function (k) { if (k.f === i) k.f = m; }); });
      }
      R.cars.forEach(function (car) { car.slow.forEach(function (k) { k.f = Math.floor(k.f / 2); }); });
      R.slowGlobal.forEach(function (k) { k.f = Math.floor(k.f / 2); });
      R.n = m; R.interval *= 2; R.hz /= 2; R.decimations++;
    }

    function harvestEvents(snap) {
      var evs = snap.events;
      if (!evs || !evs.length) return;
      for (var i = 0; i < evs.length && R.events.length < maxEvents; i++) {
        var e = evs[i]; if (!e || !e.type) continue;
        var rec = { t: num(e.t, num(snap.t, 0)), type: String(e.type) };
        if (e.carId != null) rec.car = String(e.carId);
        if (e.otherId != null) rec.other = String(e.otherId); else if (e.other != null) rec.other = String(e.other);
        if (isNum(e.x)) rec.x = round1(e.x);
        if (isNum(e.y)) rec.y = round1(e.y);
        if (isNum(e.intensity)) rec.i = round3(e.intensity);
        if (e.value != null && (typeof e.value !== 'object')) rec.v = isNum(e.value) ? round3(e.value) : String(e.value).slice(0, 80);
        if (e.text) rec.tx = String(e.text).slice(0, 120);
        if (e.lap != null) rec.lap = e.lap;
        R.events.push(rec);
      }
    }

    function writeFrame(snap) {
      if (R.n >= R.cap) grow();
      var f = R.n, F = R.frames, t = num(snap.t, f * R.interval);
      if (f === 0 || R.meta.trackLength == null) {
        var M = R.meta;
        if (M.trackId == null && snap.trackId != null) M.trackId = snap.trackId;
        if (M.mode == null && snap.mode) M.mode = snap.mode;
        if (M.laps == null && isNum(snap.lapsTotal)) M.laps = snap.lapsTotal;
        if (M.weather == null && snap.weather) M.weather = snap.weather;
        if (M.timeOfDay == null && snap.timeOfDay) M.timeOfDay = snap.timeOfDay;
        if (isNum(snap.trackLength)) M.trackLength = snap.trackLength;
        if (Array.isArray(snap.sectorBounds)) M.sectorBounds = snap.sectorBounds.slice();
        if (snap.assists) M.assists = Object.assign({}, snap.assists);
      }
      F.t[f] = t;
      F.phase[f] = Math.max(0, PHASES.indexOf(snap.phase));
      var cd = snap.countdown || {};
      F.lights[f] = clamp(num(cd.lightsOn, 0), 0, 15) | (cd.lightsOut ? 128 : 0);
      F.race[f] = num(snap.raceTime, 0);
      if (R.goT === null && cd.lightsOut && snap.phase === 'racing') R.goT = isNum(cd.goTime) ? cd.goTime : t;
      if (R.goT === null && snap.phase === 'racing' && R.lastPhase && R.lastPhase !== 'racing') R.goT = t;

      // global slow fields
      var g = {}; SLOW_GLOBAL.forEach(function (k) { if (snap[k] !== undefined) g[k] = snap[k]; });
      var gk = JSON.stringify(g);
      if (gk !== R.lastGlobalKey) { R.slowGlobal.push({ f: f, v: JSON.parse(gk) }); R.lastGlobalKey = gk; }

      var seen = {};
      var cars = snap.cars || [];
      for (var i = 0; i < cars.length; i++) {
        var c = cars[i]; if (!c || c.id == null) continue;
        var idx = R.carIndex[String(c.id)], car = idx == null ? addCar(c) : R.cars[idx];
        if (!car) continue;
        seen[car.info.id] = true;
        var ch = car.ch;
        for (var j = 0; j < CAR_CH.length; j++) {
          var d = CAR_CH[j]; if (!d.src) continue;
          var v = c[d.src];
          if (typeof v === 'boolean') v = v ? 1 : 0;
          ch[d.k][f] = memQuant(d, v);
        }
        ch.flags[f] = (c.finished ? FLAG.finished : 0) | (c.dnf ? FLAG.dnf : 0) | (c.offTrack ? FLAG.offTrack : 0) |
          (c.wrongWay ? FLAG.wrongWay : 0) | (c.lapValid !== false ? FLAG.lapValid : 0) | (c.handbrake ? FLAG.handbrake : 0) |
          (c.onTrack !== false ? FLAG.onTrack : 0);
        ch.surf[f] = surfaceCode(c.surface);
        var sv = {}; for (var q = 0; q < SLOW_FIELDS.length; q++) { var fk = SLOW_FIELDS[q]; if (c[fk] !== undefined && c[fk] !== null) sv[fk] = c[fk]; }
        var sk = JSON.stringify(sv);
        if (sk !== car.lastSlowKey) { car.slow.push({ f: f, v: JSON.parse(sk) }); car.lastSlowKey = sk; }
      }
      R.cars.forEach(function (car) {
        if (!seen[car.info.id]) { CAR_CH.forEach(function (d) { car.ch[d.k][f] = f > 0 ? car.ch[d.k][f - 1] : 0; }); car.ch.flags[f] = FLAG.absent; }
      });
      R.n++;
      detectOvertakes(snap, t);
    }

    function detectOvertakes(snap, t) {
      if (snap.phase !== 'racing' && snap.phase !== 'finished') { R.prevPos = {}; return; }
      var pos = {}, cars = snap.cars || [], byPos = {};
      cars.forEach(function (c) { if (c && isNum(c.position) && !c.dnf) { pos[c.id] = c.position; byPos[c.position] = c; } });
      var prev = R.prevPos;
      cars.forEach(function (c) {
        if (!c || c.finished || c.dnf || !isNum(prev[c.id]) || !isNum(pos[c.id])) return;
        if (pos[c.id] < prev[c.id]) {
          // cars that were ahead before and are now behind = overtaken
          cars.forEach(function (d) {
            if (!d || d.id === c.id || !isNum(prev[d.id]) || !isNum(pos[d.id]) || d.dnf) return;
            if (prev[d.id] < prev[c.id] && pos[d.id] > pos[c.id] && !d.finished) {
              R.pending.push({ t: t, carId: String(c.id), victimId: String(d.id), position: pos[c.id], lap: c.lap });
            }
          });
        }
      });
      // confirm pendings held >= hold seconds; drop reversed ones
      var hold = num(opts.overtakeHold, 1.0);
      R.pending = R.pending.filter(function (p) {
        var a = pos[p.carId], b = pos[p.victimId];
        if (!isNum(a) || !isNum(b)) return false;
        if (a > b) return false;                     // swapped back
        if (t - p.t >= hold) {
          var dupe = R.overtakes.some(function (o) { return o.carId === p.carId && o.victimId === p.victimId && Math.abs(o.t - p.t) < 3; });
          if (!dupe) R.overtakes.push(p);
          return false;
        }
        return true;
      });
      R.prevPos = pos;
    }

    function capture(snap) {
      if (!snap || !snap.cars || R.finished) return false;
      var t = num(snap.t, R.lastSimT + R.interval);
      if (t < R.lastSimT - 1e-6 && R.n > 0) {          // session.restart() detected
        if (opts.autoReset !== false) { R.restarts++; reset(); }
        else return false;
      }
      R.lastSimT = t;
      harvestEvents(snap);
      var phaseChanged = snap.phase !== R.lastPhase;
      if (R.n > 0 && !phaseChanged && t - R.lastCapT < R.interval * 0.98) { R.dropped++; return false; }
      if (R.n > 0 && t <= R.frames.t[R.n - 1]) { R.dropped++; return false; }
      writeFrame(snap);
      R.lastCapT = t; R.lastPhase = snap.phase; R.captured++;
      if (R.n >= maxFrames) halve();
      return true;
    }

    function finish(extra) {
      extra = extra || {};
      if (!R.outline && session && session.geom) R.outline = extractOutline(session.geom, opts.outlineStep);
      var n = R.n;
      var frames = {}; FRAME_CH.forEach(function (d) { frames[d.k] = R.frames[d.k].slice(0, n); });
      var cars = R.cars.map(function (car) {
        var ch = {}; CAR_CH.forEach(function (d) { ch[d.k] = car.ch[d.k].slice(0, n); });
        return { info: Object.assign({}, car.info), ch: ch, slow: car.slow.map(function (k) { return { f: k.f, v: k.v }; }) };
      });
      var meta = Object.assign({
        id: uid('rpl'), createdAt: Date.now(), name: null, hz: R.hz, frameCount: n,
        t0: n ? frames.t[0] : 0, duration: n ? frames.t[n - 1] - frames.t[0] : 0, goT: R.goT,
        playerId: (R.cars.filter(function (c) { return c.info.isPlayer; })[0] || R.cars[0] || { info: { id: null } }).info.id,
        trackLength: null, sectorBounds: null, degraded: []
      }, R.meta, extra.meta || {});
      if (extra.results) meta.results = summarizeResults(extra.results);
      var replay = {
        format: FORMAT_VERSION, meta: meta, frames: frames, cars: cars, builds: R.builds.slice(),
        events: R.events.slice(), slowGlobal: R.slowGlobal.slice(), outline: R.outline, overtakes: R.overtakes.slice(), markers: null
      };
      if (extra.trackLength) meta.trackLength = extra.trackLength;
      if (!meta.trackLength && R.outline) meta.trackLength = R.outline.length;
      replay.markers = buildMarkers(replay);
      replay.highlights = buildHighlights(replay);
      if (opts.keepRecording !== true) R.finished = true;
      return replay;
    }

    reset();
    var api = {
      capture: capture,
      finish: finish,
      reset: reset,
      get frameCount() { return R.n; },
      get duration() { return R.n ? R.frames.t[R.n - 1] - R.frames.t[0] : 0; },
      get hz() { return R.hz; },
      get finished() { return R.finished; },
      stats: function () {
        var bytes = 0; FRAME_CH.forEach(function (d) { bytes += R.frames[d.k].byteLength; });
        R.cars.forEach(function (c) { CAR_CH.forEach(function (d) { bytes += c.ch[d.k].byteLength; }); });
        return { frames: R.n, cars: R.cars.length, hz: R.hz, captured: R.captured, dropped: R.dropped, events: R.events.length,
          overtakes: R.overtakes.length, restarts: R.restarts, decimations: R.decimations, memoryBytes: bytes };
      },
      setMeta: function (m) { Object.assign(R.meta, m || {}); }
    };
    return api;
  }

  /* captureSnapshot-every-call wrapper: patches session.snapshot so each call is recorded transparently */
  function attach(session, opts) {
    if (!session || typeof session.snapshot !== 'function') throw new Error('replay.attach: session.snapshot() required');
    var rec = createRecorder(session, opts), orig = session.snapshot, attached = true;
    session.snapshot = function () {
      var snap = orig.apply(session, arguments);
      if (attached) { try { rec.capture(snap); } catch (e) { if (typeof console !== 'undefined') console.warn('[replay] capture failed', e); } }
      return snap;
    };
    rec.detach = function () { if (attached) { attached = false; if (session.snapshot !== orig) session.snapshot = orig; } };
    rec.finishAndDetach = function (extra) {
      if (!extra || !extra.results) { try { extra = Object.assign({}, extra, { results: session.results && session.results() }); } catch (e) { /* ignore */ } }
      try { if (session.geom && !(extra && extra.trackLength)) extra = Object.assign({}, extra, { trackLength: num(session.geom.length, null) }); } catch (e2) { /* ignore */ }
      var r = rec.finish(extra); rec.detach(); return r;
    };
    return rec;
  }

  function summarizeResults(res) {
    if (!res) return null;
    try {
      return {
        mode: res.mode, trackName: res.trackName, lapsTotal: res.lapsTotal, raceTime_s: res.raceTime_s,
        fastestLap: res.fastestLap ? { carId: res.fastestLap.carId, time: res.fastestLap.time } : null,
        classification: (res.classification || []).slice(0, 24).map(function (r) {
          return { position: r.position, id: r.id, name: r.name, number: r.number, color: r.color, status: r.status,
            gapText: r.gapText, bestLap_s: r.bestLap_s, isPlayer: !!r.isPlayer, gridPosition: r.gridPosition };
        })
      };
    } catch (e) { return null; }
  }

  /* ================================================================ markers & highlights */

  function carIdxMap(replay) { var m = {}; replay.cars.forEach(function (c, i) { m[c.info.id] = i; }); return m; }

  function buildMarkers(replay) {
    var F = replay.frames, n = F.t.length, t0 = n ? F.t[0] : 0, out = [];
    var rel = function (t) { return Math.max(0, t - t0); };
    // lights out
    for (var f = 1; f < n; f++) {
      if (F.phase[f] === 2 && F.phase[f - 1] < 2) { out.push({ type: 'start', t: rel(F.t[f]), label: 'Lights out' }); break; }
    }
    // laps per car + leader laps
    replay.cars.forEach(function (car) {
      var ch = car.ch;
      for (var f2 = 1; f2 < n; f2++) {
        if (ch.flags[f2] & FLAG.absent || ch.flags[f2 - 1] & FLAG.absent) continue;
        if (ch.lap[f2] > ch.lap[f2 - 1]) {
          var slow = slowAt(car.slow, f2 + 2);
          out.push({ type: 'lap', t: rel(F.t[f2]), carId: car.info.id, lap: ch.lap[f2], leader: ch.pos[f2] === 1 || ch.pos[f2 - 1] === 1,
            value: slow && isNum(slow.lastLap_s) ? slow.lastLap_s : null, label: 'Lap ' + (ch.lap[f2] + 1) });
        }
        // off-track excursions (> 0.6 s)
        if ((ch.flags[f2] & FLAG.offTrack) && !(ch.flags[f2 - 1] & FLAG.offTrack)) {
          var e = f2; while (e < n && (ch.flags[e] & FLAG.offTrack)) e++;
          if (e < n && F.t[e] - F.t[f2] > 0.6) out.push({ type: 'offtrack', t: rel(F.t[f2]), carId: car.info.id, label: 'Off track', minor: true });
        }
        // spins: rear slip beyond ~1 rad at speed
        if (Math.abs(ch.slipR[f2] * 0.0001) > 0.9 && Math.abs(ch.slipR[f2 - 1] * 0.0001) <= 0.9 && ch.v[f2] * 0.01 > 8) {
          var last = out.filter(function (m) { return m.type === 'spin' && m.carId === car.info.id; }).pop();
          if (!last || rel(F.t[f2]) - last.t > 4) out.push({ type: 'spin', t: rel(F.t[f2]), carId: car.info.id, label: 'Spin' });
        }
      }
    });
    // overtakes
    (replay.overtakes || []).forEach(function (o) {
      out.push({ type: 'overtake', t: rel(o.t), carId: o.carId, otherId: o.victimId, position: o.position, label: 'P' + o.position });
    });
    // events -> markers (collisions merged per car pair within 0.7 s)
    var lastHit = {};
    (replay.events || []).forEach(function (e) {
      var t = rel(e.t);
      if (e.type === 'collision' || e.type === 'wall') {
        if (num(e.i, 0.5) < 0.12) return;
        var key = e.type + ':' + [e.car, e.other].sort().join('|');
        if (lastHit[key] != null && t - lastHit[key] < 0.7) return;
        lastHit[key] = t;
        out.push({ type: e.type, t: t, carId: e.car, otherId: e.other, intensity: num(e.i, 0.5), x: e.x, y: e.y, label: e.type === 'wall' ? 'Wall hit' : 'Contact' });
      } else if (e.type === 'fastestLap' || e.type === 'penalty' || e.type === 'finish' || e.type === 'jumpstart' || e.type === 'trackLimits') {
        out.push({ type: e.type, t: t, carId: e.car, value: e.v, label: e.tx || MARKER_STYLE[e.type].label, minor: e.type === 'trackLimits' });
      }
    });
    // synthesize finish markers if engine did not emit them
    if (!out.some(function (m) { return m.type === 'finish'; })) {
      replay.cars.forEach(function (car) {
        for (var f3 = 1; f3 < n; f3++) {
          if ((car.ch.flags[f3] & FLAG.finished) && !(car.ch.flags[f3 - 1] & FLAG.finished)) {
            out.push({ type: 'finish', t: rel(F.t[f3]), carId: car.info.id, label: 'P' + car.ch.pos[f3] + ' finish' }); break;
          }
        }
      });
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  /* Ranked action moments used by the auto-director and the "highlights" jump list. */
  function buildHighlights(replay, max) {
    var w = { overtake: 5, collision: 4, wall: 3, fastestLap: 3, finish: 4, spin: 3, start: 4, penalty: 1, offtrack: 1 };
    var hs = (replay.markers || []).filter(function (m) { return w[m.type]; }).map(function (m) {
      var score = w[m.type] * (m.intensity ? 0.6 + m.intensity : 1);
      if (m.type === 'overtake' && m.position) score *= 1 + 2 / m.position;      // battles for the lead weigh more
      if (m.type === 'finish' && m.label && /P1/.test(m.label)) score *= 2;
      return { t: m.t, type: m.type, carId: m.carId, otherId: m.otherId, score: Math.round(score * 100) / 100, label: m.label };
    });
    hs.sort(function (a, b) { return b.score - a.score; });
    var picked = [];
    hs.forEach(function (h) { if (picked.length < (max || 12) && !picked.some(function (p) { return Math.abs(p.t - h.t) < 4; })) picked.push(h); });
    return picked.sort(function (a, b) { return a.t - b.t; });
  }

  function slowAt(list, f) {
    if (!list || !list.length) return null;
    var lo = 0, hi = list.length - 1;
    if (f < list[0].f) return list[0].v;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (list[mid].f <= f) lo = mid; else hi = mid - 1; }
    return list[lo].v;
  }

  /* ================================================================ codec */

  function toInts(def, arr, n) {
    var out = new Array(n), i;
    var isFloat = def.mem === 'f32' || def.mem === 'f64';
    if (!isFloat) { for (i = 0; i < n; i++) out[i] = arr[i]; return out; }
    if (def.angle) {
      var u = 0, prev = 0;
      for (i = 0; i < n; i++) { var v = num(arr[i], 0); u = i === 0 ? v : u + wrapAngle(v - prev); prev = v; out[i] = Math.round(u / def.q); }
      return out;
    }
    if (def.nullable) {
      for (i = 0; i < n; i++) { var w = arr[i]; if (!isNum(w)) out[i] = 0; else { var z = Math.round(w / def.q); out[i] = (z >= 0 ? z * 2 : -z * 2 - 1) + 1; } }
      return out;
    }
    for (i = 0; i < n; i++) out[i] = Math.round(num(arr[i], 0) / def.q);
    return out;
  }
  function fromInts(def, ints, n) {
    var out = new MEM_TYPES[def.mem](n), i;
    var isFloat = def.mem === 'f32' || def.mem === 'f64';
    if (!isFloat) { for (i = 0; i < n; i++) out[i] = ints[i]; return out; }
    if (def.angle) { for (i = 0; i < n; i++) out[i] = wrapAngle(ints[i] * def.q); return out; }
    if (def.nullable) {
      for (i = 0; i < n; i++) { var z = ints[i]; if (z === 0) out[i] = NaN; else { z -= 1; out[i] = (z % 2 ? -(z + 1) / 2 : z / 2) * def.q; } }
      return out;
    }
    for (i = 0; i < n; i++) out[i] = ints[i] * def.q;
    return out;
  }
  function writeStream(w, ints, order) {
    var a = ints.slice(), k, i;
    for (k = 0; k < order; k++) { for (i = a.length - 1; i > 0; i--) a[i] = a[i] - a[i - 1]; }
    var sw = new ByteWriter(a.length + 8);
    for (i = 0; i < a.length; i++) sw.svarint(a[i]);
    var bytes = sw.result();
    w.varint(bytes.length); w.bytes(bytes);
  }
  function readStream(r, n, order) {
    var len = r.varint(), sub = new ByteReader(r.bytes(len)), a = new Array(n), i, k;
    for (i = 0; i < n; i++) a[i] = sub.pos < len ? sub.svarint() : 0;
    for (k = 0; k < order; k++) { for (i = 1; i < n; i++) a[i] = a[i] + a[i - 1]; }
    return a;
  }

  function encode(replay, opts) {
    opts = opts || {};
    var n = replay.frames.t.length;
    var header = {
      format: FORMAT_VERSION, n: n, meta: replay.meta, builds: replay.builds || [],
      cars: replay.cars.map(function (c) { return c.info; }), carSlow: replay.cars.map(function (c) { return c.slow; }),
      events: replay.events || [], slowGlobal: replay.slowGlobal || [], outline: replay.outline || null,
      overtakes: replay.overtakes || [], markers: replay.markers || [], highlights: replay.highlights || [],
      fch: FRAME_CH.map(function (d) { return [d.k, d.q, d.order]; }), cch: CAR_CH.map(function (d) { return [d.k, d.q, d.order]; })
    };
    var w = new ByteWriter(64 + n * (8 + replay.cars.length * 12));
    var hb = utf8Encode(JSON.stringify(header));
    w.varint(hb.length); w.bytes(hb);
    FRAME_CH.forEach(function (d) { writeStream(w, toInts(d, replay.frames[d.k], n), d.order); });
    replay.cars.forEach(function (car) { CAR_CH.forEach(function (d) { writeStream(w, toInts(d, car.ch[d.k], n), d.order); }); });
    var raw = w.result();
    var useLz = opts.compress !== false;
    var body = useLz ? lzCompress(raw, opts.lzDepth) : raw;
    if (useLz && body.length >= raw.length) { body = raw; useLz = false; }
    var out = new ByteWriter(body.length + 16);
    out.bytes([70, 82, 80, 76]); out.u8(FORMAT_VERSION); out.u8(useLz ? 1 : 0); out.u32(raw.length); out.u32(crc32(raw)); out.bytes(body);
    return out.result();
  }

  function decode(bytes) {
    if (!bytes || bytes.length < 14 || bytes[0] !== 70 || bytes[1] !== 82 || bytes[2] !== 80 || bytes[3] !== 76) throw new Error('replay: not a Redline replay');
    var r = new ByteReader(bytes, 4), ver = r.u8(), flags = r.u8(), rawLen = r.u32(), crc = r.u32();
    if (ver > FORMAT_VERSION) throw new Error('replay: format v' + ver + ' is newer than supported v' + FORMAT_VERSION);
    var body = bytes.subarray(r.pos), raw = flags & 1 ? lzDecompress(body, rawLen) : body;
    if (crc32(raw) !== crc) throw new Error('replay: checksum mismatch (corrupted data)');
    var rr = new ByteReader(raw), hl = rr.varint(), header = JSON.parse(utf8Decode(rr.bytes(hl))), n = header.n;
    function defsFrom(list, base) {
      return (list || []).map(function (e) { var b = base.filter(function (d) { return d.k === e[0]; })[0]; return b ? Object.assign({}, b, { q: e[1], order: e[2] }) : null; });
    }
    var fdefs = defsFrom(header.fch, FRAME_CH), cdefs = defsFrom(header.cch, CAR_CH);
    var frames = {};
    (header.fch || []).forEach(function (e, i) { var d = fdefs[i] || { mem: 'f32', q: e[1] }; var ints = readStream(rr, n, e[2]); if (fdefs[i]) frames[d.k] = fromInts(d, ints, n); });
    FRAME_CH.forEach(function (d) { if (!frames[d.k]) frames[d.k] = new MEM_TYPES[d.mem](n); });
    var cars = header.cars.map(function (info, ci) {
      var ch = {};
      (header.cch || []).forEach(function (e, i) { var ints = readStream(rr, n, e[2]); if (cdefs[i]) ch[cdefs[i].k] = fromInts(cdefs[i], ints, n); });
      CAR_CH.forEach(function (d) { if (!ch[d.k]) ch[d.k] = new MEM_TYPES[d.mem](n); });
      return { info: info, ch: ch, slow: (header.carSlow && header.carSlow[ci]) || [] };
    });
    var rep = {
      format: header.format, meta: header.meta || {}, frames: frames, cars: cars, builds: header.builds || [],
      events: header.events || [], slowGlobal: header.slowGlobal || [], outline: header.outline || null,
      overtakes: header.overtakes || [], markers: header.markers || null, highlights: header.highlights || null
    };
    if (!rep.markers) rep.markers = buildMarkers(rep);
    if (!rep.highlights) rep.highlights = buildHighlights(rep);
    return rep;
  }

  function cloneReplay(rep) {
    return {
      format: rep.format, meta: deepClone(rep.meta), builds: (rep.builds || []).slice(),
      frames: (function () { var o = {}; Object.keys(rep.frames).forEach(function (k) { o[k] = rep.frames[k].slice(); }); return o; })(),
      cars: rep.cars.map(function (c) { var ch = {}; Object.keys(c.ch).forEach(function (k) { ch[k] = c.ch[k].slice(); }); return { info: Object.assign({}, c.info), ch: ch, slow: c.slow.slice() }; }),
      events: (rep.events || []).slice(), slowGlobal: (rep.slowGlobal || []).slice(), outline: rep.outline,
      overtakes: (rep.overtakes || []).slice(), markers: (rep.markers || []).slice(), highlights: (rep.highlights || []).slice()
    };
  }

  /* keep frames by index list; remaps keyframe indices */
  function selectFrames(rep, keep) {
    var out = cloneReplay(rep), m = keep.length;
    var remap = function (f) { var lo = 0, hi = m - 1; if (f <= keep[0]) return 0; while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (keep[mid] <= f) lo = mid; else hi = mid - 1; } return lo; };
    Object.keys(rep.frames).forEach(function (k) { var src = rep.frames[k], a = new src.constructor(m); for (var i = 0; i < m; i++) a[i] = src[keep[i]]; out.frames[k] = a; });
    rep.cars.forEach(function (c, ci) {
      Object.keys(c.ch).forEach(function (k) { var src = c.ch[k], a = new src.constructor(m); for (var i = 0; i < m; i++) a[i] = src[keep[i]]; out.cars[ci].ch[k] = a; });
      out.cars[ci].slow = remapSlow(c.slow, remap);
    });
    out.slowGlobal = remapSlow(rep.slowGlobal || [], remap);
    out.meta.frameCount = m;
    return out;
  }
  function remapSlow(list, remap) {
    var res = [];
    list.forEach(function (k) { var nf = remap(k.f); if (res.length && res[res.length - 1].f === nf) res[res.length - 1] = { f: nf, v: k.v }; else res.push({ f: nf, v: k.v }); });
    return res;
  }

  function resample(rep, hz) {
    var F = rep.frames, n = F.t.length, iv = 1 / hz, keep = [], last = -Infinity;
    for (var i = 0; i < n; i++) {
      var phaseChange = i > 0 && F.phase[i] !== F.phase[i - 1];
      if (i === 0 || i === n - 1 || phaseChange || F.t[i] - last >= iv * 0.98) { keep.push(i); last = F.t[i]; }
    }
    var out = selectFrames(rep, keep);
    out.meta.hz = Math.min(num(rep.meta.hz, 30), hz);
    return out;
  }

  function trim(rep, tStart, tEnd) {
    var F = rep.frames, n = F.t.length, t0 = n ? F.t[0] : 0, keep = [];
    tStart = Math.max(0, num(tStart, 0)); tEnd = num(tEnd, Infinity);
    for (var i = 0; i < n; i++) { var rt = F.t[i] - t0; if (rt >= tStart - 1e-9 && rt <= tEnd + 1e-9) keep.push(i); }
    if (!keep.length) keep.push(Math.max(0, n - 1));
    var out = selectFrames(rep, keep), nt0 = out.frames.t[0], shift = nt0 - t0, dur = out.frames.t[keep.length - 1] - nt0;
    out.meta.t0 = nt0; out.meta.duration = dur;
    out.events = out.events.filter(function (e) { return e.t >= nt0 - 1e-9 && e.t <= nt0 + dur + 1e-9; });
    var sh = function (m) { return Object.assign({}, m, { t: m.t - shift }); };
    var inR = function (m) { return m.t >= -1e-9 && m.t <= dur + 1e-9; };
    out.markers = out.markers.map(sh).filter(inR);
    out.highlights = out.highlights.map(sh).filter(inR);
    out.overtakes = out.overtakes.filter(function (o) { return o.t >= nt0 && o.t <= nt0 + dur; });
    out.meta.trimmed = [tStart, Math.min(tEnd, num(rep.meta.duration, tEnd))];
    return out;
  }

  function pruneCars(rep, keepIds) {
    var set = {}; keepIds.forEach(function (id) { set[String(id)] = true; });
    var out = cloneReplay(rep);
    out.cars = out.cars.filter(function (c) { return set[c.info.id]; });
    var ok = function (id) { return id == null || set[id]; };
    out.events = out.events.filter(function (e) { return ok(e.car); });
    out.markers = out.markers.filter(function (m) { return ok(m.carId); });
    out.highlights = out.highlights.filter(function (m) { return ok(m.carId); });
    out.overtakes = out.overtakes.filter(function (o) { return ok(o.carId); });
    return out;
  }
  function stripBuilds(rep) {
    var out = cloneReplay(rep); out.builds = []; out.cars.forEach(function (c) { c.info.build = -1; }); return out;
  }
  function flattenMinorChannels(rep) {
    var out = cloneReplay(rep);
    out.cars.forEach(function (c) { ['slipF', 'slipR', 'lat', 'dBest', 'steer'].forEach(function (k) { var a = c.ch[k]; for (var i = 0; i < a.length; i++) a[i] = k === 'dBest' ? NaN : 0; }); });
    return out;
  }
  function keepTopCars(rep, count) {
    var n = rep.frames.t.length;
    var ranked = rep.cars.map(function (c) { return { id: c.info.id, p: c.info.isPlayer ? -1 : (n ? c.ch.pos[n - 1] || 99 : 99) }; })
      .sort(function (a, b) { return a.p - b.p; }).slice(0, count).map(function (x) { return x.id; });
    return pruneCars(rep, ranked);
  }

  function thinOutline(rep, k) {
    var out = cloneReplay(rep), o = rep.outline;
    if (!o || !o.x || o.x.length < 60) return out;
    var pick = function (a) { return a ? a.filter(function (_, i) { return i % k === 0; }) : a; };
    out.outline = Object.assign({}, o, { x: pick(o.x), y: pick(o.y), hw: pick(o.hw), kl: pick(o.kl), kr: pick(o.kr), wl: pick(o.wl), wr: pick(o.wr) });
    return out;
  }
  function dropMinorEvents(rep) {
    var out = cloneReplay(rep), keep = { collision: 1, wall: 1, finish: 1, fastestLap: 1, penalty: 1 };
    out.events = out.events.filter(function (e) { return keep[e.type] && (e.type !== 'collision' && e.type !== 'wall' || num(e.i, 0.5) >= 0.12); });
    out.markers = out.markers.filter(function (m) { return !m.minor; });
    out.cars.forEach(function (c) { c.slow = c.slow.map(function (k) { var v = Object.assign({}, k.v); delete v.sectors; delete v.lastSectors; delete v.bestSectors; return { f: k.f, v: v }; }); });
    return out;
  }

  /* serialize with a size cap: progressively degrade until it fits */
  function serializeEx(rep, opts) {
    opts = opts || {};
    var cap = num(opts.maxChars, DEFAULT_ITEM_CAP);
    var steps = [
      { label: null, fn: function (r) { return r; } },
      { label: 'builds', fn: stripBuilds },
      { label: 'outline', fn: function (r) { return thinOutline(r, 2); } },
      { label: '15hz', fn: function (r) { return resample(r, 15); } },
      { label: '10hz', fn: function (r) { return resample(r, 10); } },
      { label: 'minor-channels', fn: flattenMinorChannels },
      { label: 'top-6-cars', fn: function (r) { return keepTopCars(r, 6); } },
      { label: '6hz', fn: function (r) { return resample(r, 6); } },
      { label: 'last-240s', fn: function (r) { return trim(r, Math.max(0, num(r.meta.duration, 0) - 240)); } },
      { label: 'last-90s', fn: function (r) { return trim(r, Math.max(0, num(r.meta.duration, 0) - 90)); } },
      { label: 'minor-events', fn: dropMinorEvents },
      { label: 'outline-coarse', fn: function (r) { return thinOutline(r, 3); } },
      { label: 'top-2-cars', fn: function (r) { return keepTopCars(r, 2); } }
    ];
    var cur = rep, applied = (rep.meta.degraded || []).slice(), str = null;
    for (var i = 0; i < steps.length; i++) {
      if (i > 0) { cur = steps[i].fn(cur); applied.push(steps[i].label); cur.meta.degraded = applied.slice(); }
      str = base64Encode(encode(cur, opts));
      if (str.length <= cap) return { data: str, replay: cur, degraded: applied, chars: str.length, fits: true };
    }
    return { data: str, replay: cur, degraded: applied, chars: str.length, fits: false };
  }
  function serialize(rep, opts) {
    var r = serializeEx(rep, opts);
    if (!r.fits && !(opts && opts.allowOversize)) throw new Error('replay: cannot fit replay into ' + num(opts && opts.maxChars, DEFAULT_ITEM_CAP) + ' chars');
    return r.data;
  }
  function deserialize(str) {
    if (str && typeof str === 'object' && str.frames) return str;
    return decode(base64Decode(String(str)));
  }

  /* ================================================================ snapshot reconstruction */

  var EMPTY_SECTORS = [null, null, null];

  function frameAt(rep, t) {
    var F = rep.frames, n = F.t.length;
    if (!n) return { i: 0, j: 0, a: 0, abs: 0 };
    var abs = F.t[0] + clamp(t, 0, F.t[n - 1] - F.t[0]);
    var i = bsearch(F.t, n, abs), j = Math.min(n - 1, i + 1);
    var a = j > i && F.t[j] > F.t[i] ? clamp((abs - F.t[i]) / (F.t[j] - F.t[i]), 0, 1) : 0;
    return { i: i, j: j, a: a, abs: abs };
  }
  function catmull(p0, p1, p2, p3, t) {
    var t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }
  function catmullD(p0, p1, p2, p3, t) {
    var t2 = t * t;
    return 0.5 * ((-p0 + p2) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * t + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * t2);
  }

  function carAt(rep, car, fr, L) {
    var ch = car.ch, i = fr.i, j = fr.j, a = fr.a, F = rep.frames, n = F.t.length;
    if (ch.flags[i] & FLAG.absent) { if (a > 0.5 && !(ch.flags[j] & FLAG.absent)) { i = j; a = 0; } else return null; }
    if (ch.flags[j] & FLAG.absent) j = i;
    var dt = F.t[j] - F.t[i];
    var x0 = ch.x[i], y0 = ch.y[i], x1 = ch.x[j], y1 = ch.y[j];
    var jump = Math.hypot(x1 - x0, y1 - y0) > Math.max(12, (ch.v[i] * 0.01 + 5) * Math.max(dt, 1 / 30) * 3);
    var x, y, vx, vy;
    if (jump || j === i) { var k = jump && a > 0.5 ? j : i; x = ch.x[k]; y = ch.y[k]; vx = Math.cos(ch.h[k]) * ch.v[k] * 0.01; vy = Math.sin(ch.h[k]) * ch.v[k] * 0.01; if (jump && a > 0.5) { i = j; a = 0; } }
    else {
      var h = i > 0 && !(ch.flags[i - 1] & FLAG.absent) ? i - 1 : i, q = j + 1 < n && !(ch.flags[j + 1] & FLAG.absent) ? j + 1 : j;
      var uni = dt > 0 && (h === i || Math.abs((F.t[i] - F.t[h]) / dt - 1) < 0.5) && (q === j || Math.abs((F.t[q] - F.t[j]) / dt - 1) < 0.5);
      if (uni) {
        var hx = h === i ? 2 * x0 - x1 : ch.x[h], hy = h === i ? 2 * y0 - y1 : ch.y[h];
        var qx = q === j ? 2 * x1 - x0 : ch.x[q], qy = q === j ? 2 * y1 - y0 : ch.y[q];
        x = catmull(hx, x0, x1, qx, a); y = catmull(hy, y0, y1, qy, a);
        vx = catmullD(hx, x0, x1, qx, a) / dt; vy = catmullD(hy, y0, y1, qy, a) / dt;
      } else { x = lerp(x0, x1, a); y = lerp(y0, y1, a); vx = dt > 0 ? (x1 - x0) / dt : 0; vy = dt > 0 ? (y1 - y0) / dt : 0; }
    }
    var heading = wrapAngle(angleLerp(ch.h[i], ch.h[j], a));
    var s0 = ch.s[i], s1 = ch.s[j], s = Math.abs(s1 - s0) > (L ? L / 2 : 200) ? (a < 0.5 ? s0 : s1) : lerp(s0, s1, a);
    var fl = ch.flags[a < 0.5 ? i : j], lapIdx = a < 0.5 ? i : j;
    var nl = function (k) { var p = ch[k][i], r = ch[k][j]; return isNum(p) && isNum(r) ? lerp(p, r, a) : (a < 0.5 ? (isNum(p) ? p : null) : (isNum(r) ? r : null)); };
    var slow = slowAt(car.slow, lapIdx) || {};
    var info = car.info, build = info.build >= 0 && rep.builds ? rep.builds[info.build] || null : null;
    var lap = ch.lap[lapIdx], speed = lerp(ch.v[i], ch.v[j], a) * 0.01;
    var curLap = ch.lap[i] === ch.lap[j] ? lerp(ch.cur[i], ch.cur[j], a) : ch.cur[lapIdx];
    return {
      id: info.id, isPlayer: !!info.isPlayer, wasPlayer: !!info.isPlayer, name: info.name, team: info.team, number: info.number,
      color: info.color, accent: info.accent, build: build, bodyStyle: info.bodyStyle, length_m: info.length_m, width_m: info.width_m,
      x: x, y: y, heading: heading, prevX: x, prevY: y, prevHeading: heading,
      speed: speed, vx: vx, vy: vy, rpm: lerp(ch.rpm[i], ch.rpm[j], a), redline: info.redline, gear: ch.gear[lapIdx], maxGear: info.maxGear,
      steerAngle: lerp(ch.steer[i], ch.steer[j], a) * 0.0001, throttle: lerp(ch.thr[i], ch.thr[j], a) / 255, brake: lerp(ch.brk[i], ch.brk[j], a) / 255,
      handbrake: !!(fl & FLAG.handbrake), slipF: lerp(ch.slipF[i], ch.slipF[j], a) * 0.0001, slipR: lerp(ch.slipR[i], ch.slipR[j], a) * 0.0001,
      skidding: lerp(ch.skid[i], ch.skid[j], a) / 255, wheelspin: lerp(ch.spin[i], ch.spin[j], a) / 255,
      surface: SURFACES[ch.surf[lapIdx]] || 'asphalt', lap: lap, s: s, lateral: lerp(ch.lat[i], ch.lat[j], a) * 0.01,
      raceDist: lap * (L || 0) + s, position: ch.pos[lapIdx], gridPosition: slow.gridPosition != null ? slow.gridPosition : null,
      currentLap_s: curLap, lastLap_s: slow.lastLap_s != null ? slow.lastLap_s : null, bestLap_s: slow.bestLap_s != null ? slow.bestLap_s : null,
      sectors: slow.sectors || EMPTY_SECTORS.slice(), lastSectors: slow.lastSectors || EMPTY_SECTORS.slice(), bestSectors: slow.bestSectors || EMPTY_SECTORS.slice(),
      sector: slow.sector != null ? slow.sector : 1, gapAhead_s: nl('gapA'), gapLeader_s: nl('gapL'), lapsDown: slow.lapsDown || 0,
      finished: !!(fl & FLAG.finished), finishTime_s: slow.finishTime_s != null ? slow.finishTime_s : null, finishPosition: slow.finishPosition || null,
      penalties_s: slow.penalties_s || 0, dnf: !!(fl & FLAG.dnf), wrongWay: !!(fl & FLAG.wrongWay), trackLimits: slow.trackLimits || 0,
      lapValid: !!(fl & FLAG.lapValid), offTrack: !!(fl & FLAG.offTrack), onTrack: !!(fl & FLAG.onTrack), jumpStart: !!slow.jumpStart,
      reaction_s: slow.reaction_s != null ? slow.reaction_s : null, deltaBest_s: nl('dBest'), autopilot: false, frozen: false,
      collisions: slow.collisions || 0, armed: true
    };
  }

  /* t: seconds since replay start. opts: {followId, events:[...], extras} */
  function snapshotAt(rep, t, opts) {
    opts = opts || {};
    var F = rep.frames, n = F.t.length, M = rep.meta || {};
    var fr = frameAt(rep, num(t, 0)), L = num(M.trackLength, rep.outline ? rep.outline.length : 0);
    var g = slowAt(rep.slowGlobal, fr.i) || {};
    var cars = [];
    for (var c = 0; c < rep.cars.length; c++) { var sc = carAt(rep, rep.cars[c], fr, L); if (sc) cars.push(sc); }
    var follow = opts.followId != null ? String(opts.followId) : M.playerId;
    if (!cars.some(function (x) { return x.id === follow; }) && cars.length) follow = (cars.filter(function (x) { return x.wasPlayer; })[0] || cars[0]).id;
    cars.forEach(function (x) { x.isPlayer = x.id === follow; });
    var order = cars.slice().sort(function (a, b) { return (a.position || 99) - (b.position || 99); }).map(function (x) { return x.id; });
    var lights = n ? F.lights[fr.a < 0.5 ? fr.i : fr.j] : 0, phase = n ? PHASES[F.phase[fr.a < 0.5 ? fr.i : fr.j]] || 'racing' : 'grid';
    var raceTime = n ? lerp(F.race[fr.i], F.race[fr.j], fr.a) : 0;
    return {
      t: fr.abs, phase: phase,
      countdown: { lightsOn: lights & 15, lightsOut: !!(lights & 128), goTime: M.goT != null ? M.goT : null },
      lapsTotal: g.lapsTotal != null ? g.lapsTotal : num(M.laps, 0), mode: M.mode || 'race', handling: M.handling === 'arcade' ? 'arcade' : 'sim', weather: M.weather || 'dry', timeOfDay: M.timeOfDay || 'day',
      playerId: follow, trackId: M.trackId || null, trackLength: L, sectorBounds: M.sectorBounds || null, alpha: 1,
      raceTime: raceTime, fastestLap: g.fastestLap || null, sessionBestSectors: g.sessionBestSectors || [null, null, null],
      flag: !!g.flag, leaderId: g.leaderId || order[0] || null, cars: cars, order: order,
      events: opts.events || [], ghost: null, ghostBest_s: null, assists: M.assists || {},
      replay: { t: clamp(num(t, 0), 0, num(M.duration, 0)), duration: num(M.duration, 0), originalPlayerId: M.playerId, followId: follow,
        frame: fr.i, extras: opts.extras || null }
    };
  }

  /* events (absolute t) in (relA, relB] as snapshot events */
  function eventsBetween(rep, ta, tb) {
    var t0 = rep.frames.t.length ? rep.frames.t[0] : 0, out = [];
    var A = t0 + ta, B = t0 + tb, evs = rep.events || [];
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (e.t > A && e.t <= B) out.push({ type: e.type, carId: e.car != null ? e.car : null, otherId: e.other, x: e.x, y: e.y, intensity: num(e.i, 0.5), value: e.v, text: e.tx, t: e.t, replay: true });
    }
    return out;
  }

  /* per-car numeric series (for position charts etc.) */
  function series(rep, carId, channel, points) {
    var car = rep.cars.filter(function (c) { return c.info.id === String(carId); })[0];
    if (!car || !car.ch[channel]) return [];
    var F = rep.frames, n = F.t.length, P = Math.min(n, points || 400), out = [], t0 = n ? F.t[0] : 0;
    var def = CAR_CH.filter(function (d) { return d.k === channel; })[0];
    for (var p = 0; p < P; p++) {
      var i = P > 1 ? Math.round(p * (n - 1) / (P - 1)) : 0;
      if (car.ch.flags[i] & FLAG.absent) continue;
      out.push({ t: F.t[i] - t0, v: memValue(def, car.ch[channel][i]) });
    }
    return out;
  }

  function info(rep) {
    var M = rep.meta || {}, n = rep.frames.t.length;
    var player = rep.cars.filter(function (c) { return c.info.id === M.playerId; })[0];
    var winner = null;
    if (M.results && M.results.classification && M.results.classification[0]) winner = M.results.classification[0];
    else if (n) rep.cars.forEach(function (c) { if (c.ch.pos[n - 1] === 1) winner = { name: c.info.name, id: c.info.id, color: c.info.color }; });
    return {
      id: M.id, name: M.name || ((M.trackName || M.trackId || 'Race') + ' — ' + new Date(M.createdAt || Date.now()).toLocaleString()),
      trackId: M.trackId, trackName: M.trackName || M.trackId || 'Unknown circuit', mode: M.mode, modeLabel: M.modeLabel || null, laps: M.laps,
      duration: num(M.duration, 0), cars: rep.cars.length, hz: M.hz, createdAt: M.createdAt, weather: M.weather, timeOfDay: M.timeOfDay,
      playerName: player ? player.info.name : null, playerColor: player ? player.info.color : null,
      playerFinish: player && n ? player.ch.pos[n - 1] : null, winner: winner ? winner.name : null, degraded: M.degraded || [],
      playerBest_s: player && n ? ((slowAt(player.slow, n - 1) || {}).bestLap_s || null) : null,
      overtakes: (rep.markers || []).filter(function (m) { return m.type === 'overtake'; }).length,
      collisions: (rep.markers || []).filter(function (m) { return m.type === 'collision' || m.type === 'wall'; }).length
    };
  }

  /* tiny, JSON-friendly preview: normalized circuit polyline (0..100) + the followed car's final position marker */
  function makeThumb(rep) {
    try {
      var o = rep.outline; if (!o || !o.x || o.x.length < 3) return null;
      var n = o.x.length, step = Math.max(1, Math.floor(n / 72)), xs = [], ys = [], i;
      for (i = 0; i < n; i += step) { xs.push(o.x[i]); ys.push(o.y[i]); }
      var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs), minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
      var sc = 100 / Math.max(1, maxX - minX, maxY - minY), ox = (100 - (maxX - minX) * sc) / 2, oy = (100 - (maxY - minY) * sc) / 2;
      var pts = []; for (i = 0; i < xs.length; i++) pts.push(Math.round((xs[i] - minX) * sc + ox), Math.round(100 - ((ys[i] - minY) * sc + oy)));
      var M = rep.meta || {}, pl = rep.cars.filter(function (c) { return c.info.id === M.playerId; })[0];
      return { pts: pts, color: pl ? pl.info.color : '#c9a56b', theme: M.theme ? { grass: M.theme.grass, asphalt: M.theme.asphalt } : null };
    } catch (e) { return null; }
  }
  function drawThumb(canvas, thumb) {
    var f = fitCanvas(canvas), ctx = f.ctx, W = f.w, H = f.h;
    ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
    ctx.fillStyle = (thumb && thumb.theme && thumb.theme.grass) || '#1d3a20'; ctx.fillRect(0, 0, W, H);
    if (!thumb || !thumb.pts || thumb.pts.length < 6) return;
    var s = Math.min(W, H) * 0.82 / 100, ox = (W - 100 * s) / 2, oy = (H - 100 * s) / 2;
    ctx.beginPath();
    for (var i = 0; i < thumb.pts.length; i += 2) { var x = ox + thumb.pts[i] * s, y = oy + thumb.pts[i + 1] * s; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.closePath(); ctx.lineJoin = 'round';
    ctx.strokeStyle = '#e9e9e9'; ctx.lineWidth = 4; ctx.stroke();
    ctx.strokeStyle = (thumb.theme && thumb.theme.asphalt) || '#3b3d42'; ctx.lineWidth = 2.6; ctx.stroke();
    ctx.fillStyle = thumb.color || '#c9a56b'; ctx.beginPath(); ctx.arc(ox + thumb.pts[0] * s, oy + thumb.pts[1] * s, 3, 0, TAU); ctx.fill();
  }

  /* ================================================================ storage */

  var memoryStore = null, backendOverride = null;
  function backend() {
    if (backendOverride) return backendOverride;
    try {
      var ls = globalThis.localStorage;
      if (ls && typeof ls.getItem === 'function') { var k = '__forge_rpl_probe'; ls.setItem(k, '1'); ls.removeItem(k); return ls; }
    } catch (e) { /* blocked */ }
    return null;
  }
  function readStore() {
    var be = backend(), raw = null;
    if (be) { try { raw = be.getItem(STORAGE_KEY); } catch (e) { raw = null; } }
    if (raw == null && memoryStore) return deepClone(memoryStore);
    if (!raw) return { version: 1, items: [] };
    try { var d = JSON.parse(raw); if (!d || !Array.isArray(d.items)) throw 0; return d; } catch (e) { return { version: 1, items: [] }; }
  }
  function writeStore(d) {
    memoryStore = deepClone(d);
    var be = backend(); if (!be) return { ok: true, memory: true };
    var str = JSON.stringify(d);
    try { be.setItem(STORAGE_KEY, str); return { ok: true }; } catch (e) { return { ok: false, error: e }; }
  }
  function totalChars(d) { return d.items.reduce(function (s, it) { return s + (it.data ? it.data.length : 0); }, 0); }
  function evictOne(d, protectId) {
    var cand = d.items.filter(function (it) { return !it.pinned && it.id !== protectId; });
    if (!cand.length) cand = d.items.filter(function (it) { return it.id !== protectId; });
    if (!cand.length) return null;
    cand.sort(function (a, b) { return (a.savedAt || 0) - (b.savedAt || 0); });
    var victim = cand[0]; d.items = d.items.filter(function (it) { return it !== victim; });
    return victim.id;
  }
  function emitStore(type, detail) {
    try { if (typeof document !== 'undefined' && typeof CustomEvent !== 'undefined') document.dispatchEvent(new CustomEvent('forge:replays', { detail: { type: type, detail: detail } })); } catch (e) { /* ignore */ }
  }

  var store = {
    key: STORAGE_KEY, max: MAX_STORED,
    setBackend: function (b) { backendOverride = b || null; },
    list: function () {
      return readStore().items.map(function (it) {
        var o = Object.assign({}, it), I = it.info || {}; delete o.data;
        // flat fields for generic consumers (hub list adapter, profile screens)
        o.trackId = I.trackId; o.trackName = I.trackName; o.duration = I.duration; o.mode = I.mode; o.laps = I.laps;
        o.carCount = I.cars; o.playerPosition = I.playerFinish; o.bestLap_s = I.playerBest_s; o.size = it.chars;
        return o;
      })
        .sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
    },
    save: function (rep, o) {
      o = o || {};
      var itemCap = num(o.maxChars, DEFAULT_ITEM_CAP), totalCap = num(o.totalChars, DEFAULT_TOTAL_CAP);
      var ser = serializeEx(rep, { maxChars: Math.min(itemCap, totalCap) });
      if (!ser.fits) return { ok: false, reason: 'too-large', chars: ser.chars };
      var d = readStore(), id = (rep.meta && rep.meta.id) || uid('rpl'), evicted = [];
      d.items = d.items.filter(function (it) { return it.id !== id; });
      var inf = info(ser.replay);
      var item = { id: id, name: o.name || (rep.meta && rep.meta.name) || inf.name, createdAt: inf.createdAt || Date.now(), savedAt: Date.now(),
        pinned: !!o.pinned, chars: ser.chars, degraded: ser.degraded, info: inf, thumb: makeThumb(ser.replay), data: ser.data };
      d.items.push(item);
      while (d.items.length > MAX_STORED || totalChars(d) > totalCap) { var ev = evictOne(d, id); if (!ev) break; evicted.push(ev); }
      var w = writeStore(d);
      while (!w.ok && d.items.length > 1) { var ev2 = evictOne(d, id); if (!ev2) break; evicted.push(ev2); w = writeStore(d); }
      if (!w.ok) { memoryStore = deepClone(d); w = { ok: true, memory: true }; }
      emitStore('save', { id: id });
      return { ok: true, id: id, chars: ser.chars, degraded: ser.degraded, evicted: evicted, memoryOnly: !!w.memory };
    },
    load: function (id) {
      var it = readStore().items.filter(function (x) { return x.id === id; })[0];
      if (!it) return null;
      var rep = deserialize(it.data); rep.meta.id = it.id; rep.meta.name = it.name; return rep;
    },
    raw: function (id) { var it = readStore().items.filter(function (x) { return x.id === id; })[0]; return it ? it.data : null; },
    remove: function (id) { var d = readStore(), n = d.items.length; d.items = d.items.filter(function (x) { return x.id !== id; }); writeStore(d); emitStore('remove', { id: id }); return d.items.length < n; },
    rename: function (id, name) { var d = readStore(), ok = false; d.items.forEach(function (x) { if (x.id === id) { x.name = String(name || '').slice(0, 80) || x.name; ok = true; } }); writeStore(d); return ok; },
    pin: function (id, v) { var d = readStore(), ok = false; d.items.forEach(function (x) { if (x.id === id) { x.pinned = v == null ? !x.pinned : !!v; ok = true; } }); writeStore(d); return ok; },
    clear: function () { memoryStore = { version: 1, items: [] }; var be = backend(); if (be) { try { be.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ } } emitStore('clear', {}); },
    usage: function () { var d = readStore(); return { count: d.items.length, chars: totalChars(d), cap: DEFAULT_TOTAL_CAP, max: MAX_STORED }; },
    exportString: function (id) { var data = this.raw(id); return data ? 'REDLINE-REPLAY:' + data : null; },
    importString: function (str, o) {
      var s = String(str || '').trim().replace(/^(?:REDLINE|FORGE)-REPLAY:/, '');   // FORGE-REPLAY: = exports from before the rebrand
      var rep = deserialize(s); rep.meta.id = uid('rpl'); if (o && o.name) rep.meta.name = o.name;
      return { replay: rep, result: this.save(rep, o) };
    }
  };

  /* ================================================================ pixel filters (pure) */

  var FILTER_DEFAULTS = {
    exposure: 0, contrast: 0, saturation: 0, warmth: 0, tint: 0, fade: 0, bw: 0, sepia: 0, grain: 0, vignette: 0,
    vignetteSoft: 0.55, chroma: 0, sharpen: 0, motionBlur: 0, tiltShift: 0, bloom: 0, seed: 1
  };
  var FILTER_PRESETS = {
    none: {},
    noir: { bw: 1, contrast: 0.45, grain: 0.35, vignette: 0.7, exposure: -0.1 },
    vintage: { sepia: 0.55, fade: 0.25, grain: 0.3, vignette: 0.5, saturation: -0.25, warmth: 0.25, contrast: -0.1 },
    vivid: { saturation: 0.45, contrast: 0.25, sharpen: 0.4, vignette: 0.2 },
    cinematic: { contrast: 0.2, warmth: 0.18, tint: -0.12, saturation: -0.1, vignette: 0.45, fade: 0.06, tiltShift: 0.0 },
    cold: { warmth: -0.45, saturation: -0.15, contrast: 0.12, exposure: 0.05 },
    golden: { warmth: 0.5, exposure: 0.12, fade: 0.1, bloom: 0.4, vignette: 0.3 },
    miniature: { tiltShift: 0.85, saturation: 0.35, contrast: 0.15, exposure: 0.08 },
    speed: { motionBlur: 0.7, contrast: 0.2, vignette: 0.4, chroma: 0.35 },
    filmstock: { grain: 0.5, fade: 0.18, contrast: 0.08, warmth: 0.1, chroma: 0.15, vignette: 0.35 }
  };
  function filterParams(p) { return Object.assign({}, FILTER_DEFAULTS, p || {}); }
  function isIdentityPixel(p) {
    return !p.exposure && !p.contrast && !p.saturation && !p.warmth && !p.tint && !p.fade && !p.bw && !p.sepia && !p.grain && !p.vignette && !p.chroma && !p.sharpen;
  }
  /* img: {data: Uint8ClampedArray|Uint8Array RGBA, width, height}; mutates and returns img */
  function applyPixelFilters(img, params) {
    var p = filterParams(params);
    if (isIdentityPixel(p)) return img;
    var W = img.width, H = img.height, d = img.data, i, x, y;
    // tone LUT: exposure (stops) -> fade (lift) -> contrast (S around 0.5)
    var lut = new Uint8Array(256), ex = Math.pow(2, p.exposure * 2), ct = p.contrast, fade = p.fade * 0.35;
    for (i = 0; i < 256; i++) {
      var v = (i / 255) * ex;
      v = fade + v * (1 - fade);
      if (ct) { var k = ct > 0 ? 1 + ct * 2.2 : 1 + ct; v = 0.5 + (v - 0.5) * k; }
      lut[i] = clamp(Math.round(v * 255), 0, 255);
    }
    var src = (p.chroma || p.sharpen) ? new Uint8ClampedArray(d) : null;
    // sharpen (unsharp 4-neighbour) before tone
    if (p.sharpen) {
      var amt = p.sharpen * 1.2;
      for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
        i = (y * W + x) * 4;
        for (var c = 0; c < 3; c++) {
          var cc = src[i + c], lap = 4 * cc - src[i + c - 4] - src[i + c + 4] - src[i + c - W * 4] - src[i + c + W * 4];
          d[i + c] = clamp(cc + lap * amt * 0.25, 0, 255);
        }
      }
    }
    var shift = Math.round(p.chroma * Math.max(1, Math.min(W, H) / 220));
    var rng = mulberry32((p.seed | 0) + 0x5bd1e995), grain = p.grain * 46;
    var cx = W / 2, cy = H / 2, maxR = Math.hypot(cx, cy), vig = p.vignette, vs = clamp(p.vignetteSoft, 0.05, 1);
    var sat = 1 + p.saturation, wr = p.warmth * 22, tn = p.tint * 18;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        i = (y * W + x) * 4;
        var r = d[i], g = d[i + 1], b = d[i + 2];
        if (shift) {
          var xr = Math.min(W - 1, x + shift), xb = Math.max(0, x - shift);
          r = src[(y * W + xr) * 4]; b = src[(y * W + xb) * 4 + 2];
          if (p.sharpen) { r = d[(y * W + xr) * 4]; b = d[(y * W + xb) * 4 + 2]; }
        }
        r = lut[r]; g = lut[g]; b = lut[b];
        // white balance
        if (wr || tn) { r += wr; b -= wr; g += tn; r -= tn * 0.3; b -= tn * 0.3; }
        var Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (sat !== 1) { r = Y + (r - Y) * sat; g = Y + (g - Y) * sat; b = Y + (b - Y) * sat; }
        if (p.bw) { r = lerp(r, Y, p.bw); g = lerp(g, Y, p.bw); b = lerp(b, Y, p.bw); }
        if (p.sepia) {
          var sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b;
          r = lerp(r, sr, p.sepia); g = lerp(g, sg, p.sepia); b = lerp(b, sb, p.sepia);
        }
        if (vig) {
          var dd = Math.hypot(x - cx, y - cy) / maxR, f = clamp((dd - (1 - vs)) / vs, 0, 1);
          var m = 1 - vig * 0.85 * f * f * (3 - 2 * f);
          r *= m; g *= m; b *= m;
        }
        if (grain) { var nz = (rng() + rng() - 1) * grain; r += nz; g += nz; b += nz; }
        d[i] = r < 0 ? 0 : r > 255 ? 255 : r; d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g; d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
    }
    return img;
  }
  var filters = { defaults: FILTER_DEFAULTS, presets: FILTER_PRESETS, params: filterParams, apply: applyPixelFilters, isIdentity: isIdentityPixel };

  /* ================================================================ track resolution */

  function resolveTrack(rep, o) {
    o = o || {};
    var M = rep.meta || {}, def = o.trackDef || null, geom = o.geom || null, real = !!geom;
    var T = CB.race && CB.race.tracks;
    if (!def && T && M.trackId != null) { try { def = typeof T.get === 'function' ? T.get(M.trackId) : (T.byId && T.byId[M.trackId]) || null; } catch (e) { def = null; } }
    if (!geom && def && T && typeof T.build === 'function') { try { geom = T.build(def); real = !!geom; } catch (e) { geom = null; } }
    if (!geom) { geom = outlineGeom(rep.outline); real = false; }
    if (!def) def = { id: M.trackId || 'replay', name: M.trackName || 'Circuit', theme: M.theme || null, width_m: rep.outline ? rep.outline.width : 12 };
    return { geom: geom, def: def, real: real };
  }

  /* ================================================================ camera rig */

  function geomSamplesOf(geom) {
    if (!geom) return [];
    var a = geom.samples || geom.centerline || geom.points || [];
    return Array.isArray(a) ? a : [];
  }
  function sx(p) { return Array.isArray(p) ? p[0] : p.x; }
  function sy(p) { return Array.isArray(p) ? p[1] : p.y; }

  function createCameraRig(geom) {
    var smp = geomSamplesOf(geom), posts = [];
    if (smp.length > 8) {
      var L = num(geom.length, 0) || smp.length * num(geom.ds, 2), every = Math.max(1, Math.round(150 / (L / smp.length)));
      for (var i = 0; i < smp.length; i += every) {
        var p = smp[i], q = smp[(i + 3) % smp.length], r = smp[(i - 3 + smp.length) % smp.length];
        var h1 = Math.atan2(sy(p) - sy(r), sx(p) - sx(r)), h2 = Math.atan2(sy(q) - sy(p), sx(q) - sx(p));
        var curv = isNum(p.curvature) ? p.curvature : wrapAngle(h2 - h1);
        var nx = isNum(p.nx) ? p.nx : -Math.sin(h1), ny = isNum(p.ny) ? p.ny : Math.cos(h1);
        var side = curv > 0 ? -1 : 1, off = num(p.hw, 6) + 16 + (posts.length % 3) * 6;  // outside of the corner
        posts.push({ x: sx(p) + nx * off * side, y: sy(p) + ny * off * side });
      }
    }
    var cam = { x: 0, y: 0, zoom: 6, rot: 0, init: false }, st = { orbit: 0, heli: 0, post: -1, heliX: 0, heliY: 0, lastMode: null, t: 0 };
    function nearestPost(x, y) {
      var best = -1, bd = Infinity;
      for (var i = 0; i < posts.length; i++) { var d = Math.hypot(posts[i].x - x, posts[i].y - y); if (d < bd) { bd = d; best = i; } }
      return { i: best, d: bd };
    }
    function target(mode, car, snap, dt, vw, vh, free) {
      var base = Math.min(vw, vh) / 760, out = { x: car ? car.x : 0, y: car ? car.y : 0, zoom: 7 * base, rot: 0, snap: false };
      if (!car) return out;
      var spd = Math.abs(car.speed || 0), vx = num(car.vx, Math.cos(car.heading) * spd), vy = num(car.vy, Math.sin(car.heading) * spd);
      switch (mode) {
        case 'cockpit':   // no interior in the top-down view: a tight heading-up chase stands in for it
          out.x = car.x + vx * 0.22; out.y = car.y + vy * 0.22; out.rot = car.heading - Math.PI / 2;
          out.zoom = clamp(15 - spd * 0.07, 8, 15) * base; break;
        case 'chase':
          out.x = car.x + vx * 0.32; out.y = car.y + vy * 0.32; out.rot = car.heading - Math.PI / 2;
          out.zoom = clamp(10.5 - spd * 0.06, 5, 10.5) * base; break;
        case 'north':
          out.x = car.x + vx * 0.25; out.y = car.y + vy * 0.25; out.rot = 0; out.zoom = clamp(8 - spd * 0.035, 4.2, 8) * base; break;
        case 'orbit-car':
          st.orbit += dt * 0.32;
          out.rot = car.heading - Math.PI / 2 + st.orbit; out.zoom = (11 + Math.sin(st.orbit * 0.7) * 3.2) * base; break;
        case 'helicopter':
          if (st.lastMode !== 'helicopter') { st.heliX = car.x; st.heliY = car.y; }
          var k = 1 - Math.exp(-dt * 0.9); st.heliX = lerp(st.heliX, car.x + vx * 0.8, k); st.heliY = lerp(st.heliY, car.y + vy * 0.8, k);
          st.heli += dt * 0.045; out.x = st.heliX; out.y = st.heliY; out.rot = st.heli; out.zoom = 2.6 * base; break;
        case 'trackside':
        case 'tv':
          if (!posts.length) { out.rot = 0; out.zoom = 5 * base; break; }
          var np = nearestPost(car.x + vx * 0.6, car.y + vy * 0.6);
          if (st.post < 0 || np.i !== st.post && np.d < Math.hypot(posts[st.post].x - car.x, posts[st.post].y - car.y) * 0.72) { st.post = np.i; out.snap = true; }
          var P = posts[st.post], dx = car.x - P.x, dy = car.y - P.y, dist = Math.hypot(dx, dy);
          if (mode === 'tv') { out.x = lerp(P.x, car.x, 0.8); out.y = lerp(P.y, car.y, 0.8); out.rot = 0; out.zoom = clamp(vh * 0.32 / Math.max(28, dist * 0.55), 2.2 * base, 9 * base); }
          else { out.x = lerp(P.x, car.x, 0.72); out.y = lerp(P.y, car.y, 0.72); out.rot = Math.atan2(dy, dx) - Math.PI / 2; out.zoom = clamp(vh * 0.36 / Math.max(22, dist * 0.6), 3 * base, 12 * base); }
          break;
        case 'free':
          if (free) { out.x = free.x; out.y = free.y; out.zoom = free.zoom * base; out.rot = free.rot; out.snap = true; }
          break;
      }
      return out;
    }
    return {
      posts: posts,
      update: function (mode, car, snap, dt, vw, vh, free) {
        var tg = target(mode, car, snap, dt, vw, vh, free);
        var modeChanged = st.lastMode !== mode; st.lastMode = mode;
        if (!cam.init || tg.snap) { cam.x = tg.x; cam.y = tg.y; cam.zoom = tg.zoom; cam.rot = tg.rot; cam.init = true; }
        else {
          var kp = 1 - Math.exp(-dt * (mode === 'chase' ? 9 : mode === 'helicopter' ? 3 : 5)), kz = 1 - Math.exp(-dt * 2.5), kr = 1 - Math.exp(-dt * (mode === 'chase' ? 5 : 3));
          if (modeChanged) { kp = Math.max(kp, 0.12); }
          cam.x = lerp(cam.x, tg.x, kp); cam.y = lerp(cam.y, tg.y, kp); cam.zoom = lerp(cam.zoom, tg.zoom, kz); cam.rot = angleLerp(cam.rot, tg.rot, kr);
        }
        return { x: cam.x, y: cam.y, zoom: cam.zoom, rot: cam.rot };
      },
      cut: function () { cam.init = false; st.post = -1; },
      state: function () { return { x: cam.x, y: cam.y, zoom: cam.zoom, rot: cam.rot }; }
    };
  }

  /* ================================================================ built-in view renderer */

  var DEFAULT_THEME = { grass: '#2f5a2c', asphalt: '#3b3d42', kerbA: '#d23a2e', kerbB: '#f2f2f2', sand: '#c9b27a', sky: '#9cc3e6', barrier: '#bfc4cc' };

  function fitCanvas(canvas) {
    var dpr = Math.min(3, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1);
    var w = canvas.clientWidth || canvas.width || 800, h = canvas.clientHeight || canvas.height || 450;
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    return { w: w, h: h, dpr: dpr, ctx: canvas.getContext('2d') };
  }

  function createView(canvas, geom, trackDef, opts) {
    opts = opts || {};
    var theme = Object.assign({}, DEFAULT_THEME, (trackDef && trackDef.theme) || (geom && geom.theme) || opts.theme || {});
    var smp = geomSamplesOf(geom), hasP2D = typeof Path2D !== 'undefined';
    var skids = [], parts = [], lastSkid = {}, rngP = mulberry32(7);
    var night = opts.timeOfDay === 'night', dusk = opts.timeOfDay === 'dusk', wet = opts.weather === 'wet' || opts.weather === 'damp';
    function offsetPath(off, from, to) {
      var path = hasP2D ? new Path2D() : null, pts = [];
      for (var i = from; i <= to; i++) {
        var p = smp[i % smp.length], nx = num(p.nx, 0), ny = num(p.ny, 0), hw = num(p.hw, num(p.width, 12) / 2);
        pts.push([sx(p) + nx * off(p, hw), sy(p) + ny * off(p, hw)]);
      }
      if (path) pts.forEach(function (q, k) { if (k) path.lineTo(q[0], q[1]); else path.moveTo(q[0], q[1]); });
      return { path: path, pts: pts };
    }
    var center = smp.length ? offsetPath(function () { return 0; }, 0, smp.length) : null;
    var avgW = smp.length ? smp.reduce(function (s, p) { return s + num(p.hw, 6) * 2; }, 0) / smp.length : 12;
    // kerb runs
    var kerbs = [];
    [1, -1].forEach(function (side) {
      var run = null;
      for (var i = 0; i < smp.length; i++) {
        var kw = side > 0 ? num(smp[i].leftKerb, 0) : num(smp[i].rightKerb, 0);
        if (kw > 0.2) { if (!run) run = { from: i, to: i, w: kw }; run.to = i; run.w = Math.max(run.w, kw); }
        else if (run) { kerbs.push({ side: side, from: run.from, to: run.to, w: run.w }); run = null; }
      }
      if (run) kerbs.push({ side: side, from: run.from, to: run.to, w: run.w });
    });
    kerbs.forEach(function (k) { k.geo = offsetPath(function (p, hw) { return k.side * (hw + k.w / 2); }, k.from, k.to + 1); });
    var walls = [];
    [1, -1].forEach(function (side) {
      var run = null;
      for (var i = 0; i < smp.length; i++) {
        var isW = side > 0 ? (smp[i].wallLeft || (isNum(smp[i].wallL) && smp[i].wallL < num(smp[i].hw, 6) + 3)) : (smp[i].wallRight || (isNum(smp[i].wallR) && smp[i].wallR < num(smp[i].hw, 6) + 3));
        if (isW) { if (!run) run = { from: i, to: i }; run.to = i; } else if (run) { walls.push({ side: side, from: run.from, to: run.to }); run = null; }
      }
      if (run) walls.push({ side: side, from: run.from, to: run.to });
    });
    walls.forEach(function (w) { w.geo = offsetPath(function (p, hw) { var wv = w.side > 0 ? num(p.wallL, hw + 1) : num(p.wallR, hw + 1); return w.side * Math.min(wv, hw + 2.5); }, w.from, w.to + 1); });

    function strokeGeo(ctx, g) {
      if (!g) return;
      if (g.path) { ctx.stroke(g.path); return; }
      ctx.beginPath(); g.pts.forEach(function (q, k) { if (k) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.stroke();
    }
    function drawTrack(ctx, zoom) {
      if (!center) return;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = theme.sand; ctx.globalAlpha = 0.55; ctx.lineWidth = avgW + 16; strokeGeo(ctx, center); ctx.globalAlpha = 1;
      ctx.strokeStyle = shadeHex(theme.grass, -18); ctx.lineWidth = avgW + 5; strokeGeo(ctx, center);
      ctx.strokeStyle = '#e9e9e9'; ctx.lineWidth = avgW + 0.5; strokeGeo(ctx, center);
      ctx.strokeStyle = theme.asphalt; ctx.lineWidth = avgW - 0.6; strokeGeo(ctx, center);
      // rubbered racing line
      ctx.strokeStyle = 'rgba(0,0,0,0.13)'; ctx.lineWidth = avgW * 0.28; strokeGeo(ctx, center);
      kerbs.forEach(function (k) {
        ctx.lineCap = 'butt'; ctx.lineWidth = k.w;
        ctx.strokeStyle = theme.kerbB; ctx.setLineDash([]); strokeGeo(ctx, k.geo);
        ctx.strokeStyle = theme.kerbA; ctx.setLineDash([2.2, 2.2]); strokeGeo(ctx, k.geo); ctx.setLineDash([]);
      });
      walls.forEach(function (w) { ctx.lineCap = 'round'; ctx.strokeStyle = theme.barrier || '#c0c4cc'; ctx.lineWidth = 0.9; strokeGeo(ctx, w.geo); });
      // start/finish checker
      var s0 = smp[0], nx = num(s0.nx, 0), ny = num(s0.ny, 1), hw = num(s0.hw, avgW / 2), hd = Math.atan2(ny, nx) - Math.PI / 2;
      ctx.save(); ctx.translate(sx(s0), sy(s0)); ctx.rotate(hd);
      var cells = Math.max(4, Math.round(hw * 2 / 1.2)), cw = hw * 2 / cells;
      for (var c = 0; c < cells; c++) for (var r = 0; r < 2; r++) { ctx.fillStyle = (c + r) % 2 ? '#111' : '#fff'; ctx.fillRect(-0.6 + r * 0.6, -hw + c * cw, 0.6, cw); }
      ctx.restore();
    }
    function drawCar(ctx, c, highlight, zoom) {
      var L = num(c.length_m, 4.5), W = num(c.width_m, 1.9), style = c.bodyStyle || 'coupe';
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.heading || 0);
      // shadow
      ctx.fillStyle = 'rgba(0,0,0,0.32)'; roundRect(ctx, -L / 2 + 0.25, -W / 2 - 0.25, L, W, 0.5); ctx.fill();
      // wheels
      ctx.fillStyle = '#111';
      var wx = L * 0.32, wy = W / 2 - 0.12, ww = 0.68, wh = 0.3, st = num(c.steerAngle, 0);
      [[wx, wy, st], [wx, -wy, st], [-wx, wy, 0], [-wx, -wy, 0]].forEach(function (w) { ctx.save(); ctx.translate(w[0], w[1]); ctx.rotate(w[2]); ctx.fillRect(-ww / 2, -wh / 2, ww, wh); ctx.restore(); });
      // body
      var nose = style === 'formula' || style === 'hypercar' ? 0.75 : style === 'truck' || style === 'suv' ? 0.25 : 0.45;
      ctx.fillStyle = c.color || '#c9a56b';
      ctx.beginPath();
      ctx.moveTo(-L / 2, -W / 2 + 0.15); ctx.lineTo(L / 2 - nose, -W / 2 + 0.05); ctx.quadraticCurveTo(L / 2, -W / 2 + 0.2, L / 2, 0);
      ctx.quadraticCurveTo(L / 2, W / 2 - 0.2, L / 2 - nose, W / 2 - 0.05); ctx.lineTo(-L / 2, W / 2 - 0.15); ctx.closePath(); ctx.fill();
      // stripe
      ctx.fillStyle = c.accent || '#111'; ctx.globalAlpha = 0.85; ctx.fillRect(-L / 2, -0.17, L - 0.15, 0.34); ctx.globalAlpha = 1;
      // cabin glass
      var cab = style === 'pickup' || style === 'truck' ? [0.05, 0.3] : style === 'wagon' || style === 'suv' ? [-0.3, 0.45] : style === 'roadster' ? [-0.05, 0.22] : [-0.12, 0.35];
      ctx.fillStyle = style === 'roadster' ? '#2a2a2a' : 'rgba(20,28,40,0.88)';
      roundRect(ctx, L * cab[0] - L * cab[1] / 2, -W * 0.36, L * cab[1], W * 0.72, 0.25); ctx.fill();
      // number disc
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(-L * 0.28, 0, 0.36, 0, TAU); ctx.fill();
      if (zoom > 7) { ctx.save(); ctx.rotate(Math.PI / 2); ctx.scale(1, -1); ctx.fillStyle = '#111'; ctx.font = '700 0.42px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(c.number != null ? c.number : ''), 0, L * 0.28); ctx.restore(); }
      // brake lights
      if (c.brake > 0.12) { ctx.fillStyle = 'rgba(255,40,30,' + clamp(0.5 + c.brake, 0, 1) + ')'; ctx.fillRect(-L / 2 - 0.05, -W / 2 + 0.2, 0.14, 0.42); ctx.fillRect(-L / 2 - 0.05, W / 2 - 0.62, 0.14, 0.42); }
      if (highlight) { ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = Math.max(0.12, 1.4 / zoom); roundRect(ctx, -L / 2 - 0.35, -W / 2 - 0.35, L + 0.7, W + 0.7, 0.6); ctx.stroke(); }
      ctx.restore();
    }
    function headlights(ctx, c) {
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.heading || 0);
      var g = ctx.createRadialGradient(2, 0, 0.5, 14, 0, 26);
      g.addColorStop(0, 'rgba(255,244,214,0.55)'); g.addColorStop(1, 'rgba(255,244,214,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(2, -0.7); ctx.lineTo(30, -9); ctx.lineTo(30, 9); ctx.lineTo(2, 0.7); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    function addEffects(snap, dt) {
      (snap.cars || []).forEach(function (c) {
        var sk = Math.max(num(c.skidding, 0), num(c.wheelspin, 0) * 0.8);
        var prev = lastSkid[c.id];
        if (sk > 0.3 && prev && Math.hypot(c.x - prev.x, c.y - prev.y) < 8) {
          var rx = -Math.cos(c.heading) * num(c.length_m, 4.5) * 0.32, ry = -Math.sin(c.heading) * num(c.length_m, 4.5) * 0.32;
          var nx = -Math.sin(c.heading) * 0.75, ny = Math.cos(c.heading) * 0.75;
          skids.push({ x0: prev.x + rx + nx, y0: prev.y + ry + ny, x1: c.x + rx + nx, y1: c.y + ry + ny, a: sk });
          skids.push({ x0: prev.x + rx - nx, y0: prev.y + ry - ny, x1: c.x + rx - nx, y1: c.y + ry - ny, a: sk });
          if (skids.length > 5000) skids.splice(0, skids.length - 5000);
          if (rngP() < sk * 0.6) parts.push({ x: c.x + rx, y: c.y + ry, vx: (rngP() - 0.5) * 2, vy: (rngP() - 0.5) * 2, life: 1.4, max: 1.4, r: 1, kind: 'smoke' });
        }
        lastSkid[c.id] = { x: c.x, y: c.y };
        if (wet && Math.abs(c.speed) > 20 && rngP() < 0.5) parts.push({ x: c.x - Math.cos(c.heading) * 2.6, y: c.y - Math.sin(c.heading) * 2.6, vx: -c.vx * 0.1, vy: -c.vy * 0.1, life: 0.6, max: 0.6, r: 0.8, kind: 'spray' });
      });
      (snap.events || []).forEach(function (e) {
        if ((e.type === 'collision' || e.type === 'wall') && isNum(e.x)) {
          for (var i = 0; i < 6 + num(e.intensity, 0.5) * 14; i++) parts.push({ x: e.x, y: e.y, vx: (rngP() - 0.5) * 24, vy: (rngP() - 0.5) * 24, life: 0.5, max: 0.5, r: 0.18, kind: 'spark' });
        }
      });
      parts.forEach(function (p) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy *= 0.96; p.life -= dt; p.r += dt * (p.kind === 'smoke' ? 2.2 : 0); });
      parts = parts.filter(function (p) { return p.life > 0; });
      if (parts.length > 900) parts.splice(0, parts.length - 900);
    }
    var lastT = null;
    return {
      __replayView: true,
      cameras: CAMERAS.slice(),
      render: function (snap, cam, ro) {
        ro = ro || {};
        var f = fitCanvas(canvas), ctx = f.ctx, W = f.w, H = f.h;
        var dt = lastT == null ? 1 / 60 : clamp(Math.abs(snap.t - lastT), 0, 0.1);
        if (!ro.noEffects) lastT = snap.t;
        cam = cam || { x: 0, y: 0, zoom: 4, rot: 0 };
        if (dt > 0 && !ro.noEffects) addEffects(snap, dt);
        ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
        ctx.fillStyle = theme.grass; ctx.fillRect(0, 0, W, H);
        ctx.save();
        ctx.translate(W / 2, H / 2); ctx.rotate(cam.rot); ctx.scale(cam.zoom, -cam.zoom); ctx.translate(-cam.x, -cam.y);
        // grass texture: faint mowing stripes
        ctx.save(); ctx.globalAlpha = 0.06; ctx.fillStyle = '#000';
        var span = Math.max(W, H) / cam.zoom, gx0 = Math.floor((cam.x - span) / 20) * 20;
        for (var gx = gx0; gx < cam.x + span; gx += 40) ctx.fillRect(gx, cam.y - span, 20, span * 2);
        ctx.restore();
        drawTrack(ctx, cam.zoom);
        ctx.lineCap = 'round';
        skids.forEach(function (s) { ctx.strokeStyle = 'rgba(14,14,14,' + (0.32 * s.a) + ')'; ctx.lineWidth = 0.3; ctx.beginPath(); ctx.moveTo(s.x0, s.y0); ctx.lineTo(s.x1, s.y1); ctx.stroke(); });
        var cars = (snap.cars || []).slice().sort(function (a, b) { return (a.isPlayer ? 1 : 0) - (b.isPlayer ? 1 : 0); });
        if (night || dusk) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; cars.forEach(function (c) { headlights(ctx, c); }); ctx.restore(); }
        cars.forEach(function (c) { drawCar(ctx, c, c.isPlayer, cam.zoom); });
        parts.forEach(function (p) {
          var a = p.life / p.max;
          ctx.fillStyle = p.kind === 'spark' ? 'rgba(255,200,90,' + a + ')' : p.kind === 'spray' ? 'rgba(220,230,240,' + a * 0.35 + ')' : 'rgba(230,230,230,' + a * 0.3 + ')';
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
        });
        ctx.restore();
        if (night || dusk) { ctx.fillStyle = night ? 'rgba(8,12,30,0.5)' : 'rgba(80,40,30,0.18)'; ctx.fillRect(0, 0, W, H); }
        if (wet && opts.weather === 'wet') {
          var rr = mulberry32(ro.noEffects ? 99 : Math.floor(num(snap.t, 0) * 30));
          ctx.strokeStyle = 'rgba(200,215,235,0.25)'; ctx.lineWidth = 1;
          for (var r = 0; r < 120; r++) { var rx = rr() * W, ry = rr() * H; ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx - 3, ry + 12); ctx.stroke(); }
        }
      },
      reset: function () { skids = []; parts = []; lastSkid = {}; lastT = null; },
      setCamera: function () {}, cycleCamera: function () {}, resize: function () { fitCanvas(canvas); }, destroy: function () { skids = parts = []; }
    };
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  function shadeHex(hex, pct) {
    if (CB.util && typeof CB.util.shade === 'function') { try { return CB.util.shade(hex, pct); } catch (e) { /* fallthrough */ } }
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')); if (!m) return hex;
    var v = parseInt(m[1], 16), f = 1 + pct / 100;
    var r = clamp(Math.round(((v >> 16) & 255) * f), 0, 255), g = clamp(Math.round(((v >> 8) & 255) * f), 0, 255), b = clamp(Math.round((v & 255) * f), 0, 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  /* ================================================================ player */

  /* ================================================================ 3D replay cameras (pure helpers, Node-testable) */

  /* which world renderer a replay viewer uses: '3d' (CB.race.renderer3d), 'race2d' (CB.race.renderer) or 'builtin'
     (this file's createView). o: { builtin, graphics, real, has3d, supported3d, has2d } */
  function pickBackend(o) {
    o = o || {};
    if (o.builtin === true) return 'builtin';
    if (o.graphics !== '2d' && o.real && o.has3d && o.supported3d) return '3d';
    if (o.real && o.has2d) return 'race2d';
    return 'builtin';
  }
  /* replay camera -> { mode: renderer3d mode, ctl: null | 'orbit' | 'free' }, constrained to the modes the renderer offers */
  function camera3dFor(mode, available) {
    var m = CAMERA_3D[mode] || CAMERA_3D.chase, out = { mode: m.mode, ctl: m.ctl };
    if (available && available.length && available.indexOf(out.mode) < 0) out.mode = available.indexOf('chase') >= 0 ? 'chase' : available[0];
    return out;
  }
  /* camera buttons for a backend; available = renderer3d.cameraModes() */
  function uiCameras(is3D, available) {
    if (!is3D) return UI_CAMERAS_2D.slice();
    return UI_CAMERAS_3D.filter(function (c) { var m = CAMERA_3D[c].mode; return !available || !available.length || available.indexOf(m) >= 0; });
  }
  function v3sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function v3cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function v3norm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function v3dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  /* up vector for a camera rolled by `roll` radians about its view axis (GL axes, world up +Y) */
  function rollUp(eye, target, roll) {
    var f = v3norm(v3sub(target, eye)), r = v3cross(f, [0, 1, 0]);
    if (Math.hypot(r[0], r[1], r[2]) < 1e-6) r = [1, 0, 0];
    r = v3norm(r); var u = v3cross(r, f), c = Math.cos(roll || 0), s = Math.sin(roll || 0);
    return v3norm([u[0] * c + r[0] * s, u[1] * c + r[1] * s, u[2] * c + r[2] * s]);
  }
  /* slow orbit around the followed car. pose {x, y, heading, elev} in sim coords; a = orbit angle (rad);
     safe(cx, cy, ex, ey) -> fraction of the boom inside the walls; ground(x, zGL) -> terrain height */
  function orbitCam3d(pose, a, dims, safe, ground) {
    var len = clamp(num(dims && dims.length, 4.5), 2.5, 8);
    var r = len * 1.55 + 2.4 + Math.sin(a * 0.7) * len * 0.3, hgt = 1.0 + 0.9 * (0.5 + 0.5 * Math.sin(a * 0.45));
    var ang = num(pose.heading, 0) + a, el = num(pose.elev, 0);
    var ex = pose.x + Math.cos(ang) * r, ey = pose.y + Math.sin(ang) * r;
    if (typeof safe === 'function') {
      var fr = num(safe(pose.x, pose.y, ex, ey, 0.3), 1);
      if (fr < 1) { fr = Math.max(0.42, fr); ex = pose.x + (ex - pose.x) * fr; ey = pose.y + (ey - pose.y) * fr; }
    }
    var eh = el + hgt;
    if (typeof ground === 'function') { var gy = num(ground(ex, -ey), -Infinity); if (eh < gy + 0.5) eh = gy + 0.5; }
    var eye = [ex, eh, -ey], target = [pose.x, el + 0.6, -pose.y];
    return { eye: eye, target: target, up: [0, 1, 0], fovDeg: 52 };
  }
  /* free photo camera: orbit (yaw, pitch, dist) around a target that is either locked to the subject (ox, oy relative to
     its position) or fixed in the world (ox, oy absolute); oh = target height above the subject's road elevation */
  function defaultFree3d(pose) {
    return { yaw: num(pose && pose.heading, 0) + Math.PI - 0.55, pitch: 0.2, dist: 8.5, fov: 48, roll: 0, ox: 0, oy: 0, oh: 0.7, lock: true };
  }
  function freeCam3d(F, pose) {
    pose = pose || { x: 0, y: 0, heading: 0, elev: 0 };
    var bx = F.lock ? pose.x : 0, by = F.lock ? pose.y : 0, el = num(pose.elev, 0);
    var tx = bx + num(F.ox, 0), ty = by + num(F.oy, 0), th = el + num(F.oh, 0.7);
    var p = clamp(num(F.pitch, 0.2), -0.6, 1.55), d = clamp(num(F.dist, 8), 0.6, 2000), cp = Math.cos(p);
    var eye = [tx + Math.cos(F.yaw) * cp * d, th + Math.sin(p) * d, -(ty + Math.sin(F.yaw) * cp * d)], target = [tx, th, -ty];
    return { eye: eye, target: target, up: rollUp(eye, target, num(F.roll, 0)), fovDeg: clamp(num(F.fov, 50), 8, 110) };
  }
  /* inverse of freeCam3d: free camera that reproduces a renderer3d camera state {mode, eye, target, fov} */
  function seedFree3d(state, pose, lock) {
    lock = lock !== false;
    if (!state || !state.eye || !state.target || /^(cockpit|hood|bumper|map)$/.test(state.mode || '')) { var df = defaultFree3d(pose); df.lock = lock; if (!lock && pose) { df.ox = pose.x; df.oy = pose.y; } return df; }
    var e = state.eye, t = state.target, dx = e[0] - t[0], dy = -(e[2] - t[2]), dh = e[1] - t[1], d = Math.max(0.6, Math.hypot(dx, dy, dh));
    var px = lock && pose ? pose.x : 0, py = lock && pose ? pose.y : 0;
    return { yaw: Math.atan2(dy, dx), pitch: Math.asin(clamp(dh / d, -1, 1)), dist: d, fov: num(state.fov, 50), roll: 0,
      ox: t[0] - px, oy: -t[2] - py, oh: t[1] - num(pose && pose.elev, 0), lock: lock };
  }
  /* screen-space pan of a free camera (dx, dy CSS px; viewH CSS px) */
  function panFree3d(F, dx, dy, viewH) {
    var k = 2 * F.dist * Math.tan(clamp(num(F.fov, 50), 8, 110) * Math.PI / 360) / Math.max(1, viewH || 600);
    var fx = -Math.cos(F.yaw), fy = -Math.sin(F.yaw), rx = -Math.sin(F.yaw), ry = Math.cos(F.yaw);
    var fwd = dy / Math.max(0.25, Math.sin(clamp(F.pitch, 0.05, 1.55)) + 0.25);
    F.ox += -rx * dx * k + fx * fwd * k; F.oy += -ry * dx * k + fy * fwd * k;
    return F;
  }
  /* project a GL world point with a camera state -> CSS px (null when behind the camera) */
  function project3d(cam, p, W, H) {
    var f = v3norm(v3sub(cam.target, cam.eye)), r = v3norm(v3cross(f, cam.up || [0, 1, 0])), u = v3cross(r, f), d = v3sub(p, cam.eye);
    var z = v3dot(d, f); if (z < 0.1) return null;
    var t = Math.tan(num(cam.fov != null ? cam.fov : cam.fovDeg, 60) * Math.PI / 360), asp = W / Math.max(1, H);
    return { x: W / 2 + v3dot(d, r) / (z * t * asp) * W / 2, y: H / 2 - v3dot(d, u) / (z * t) * H / 2, z: z };
  }

  var EXT_CAMERA_MAP = { chase: 'chase', cockpit: 'chase', north: 'north', tv: 'tv', 'orbit-car': 'chase', helicopter: 'north', trackside: 'tv', free: 'chase' };

  function isCanvas(x) { return !!(x && typeof x.getContext === 'function'); }

  function createPlayer(rep, renderer, hud, opts) {
    opts = opts || {};
    if (typeof rep === 'string') rep = deserialize(rep);
    if (!rep || !rep.frames) throw new Error('replay.createPlayer: replay required');
    var M = rep.meta || {}, duration = Math.max(0, num(M.duration, rep.frames.t.length ? rep.frames.t[rep.frames.t.length - 1] - rep.frames.t[0] : 0));
    var canvas = opts.canvas || (isCanvas(renderer) ? renderer : null) || (renderer && renderer.canvas) || null;
    if (isCanvas(renderer)) renderer = undefined;
    var trk = resolveTrack(rep, opts);
    var builtin = false, ownRenderer = false, ownHud = false, is3D = false;
    var timeOfDay = M.timeOfDay || 'day', weather = M.weather || 'dry';
    var RS = (function () { try { return (CB.race && CB.race.ui && typeof CB.race.ui.getSettings === 'function' && CB.race.ui.getSettings()) || {}; } catch (e) { return {}; } })();

    function makeBuiltin() { builtin = true; ownRenderer = true; return createView(canvas, trk.geom, trk.def, { timeOfDay: timeOfDay, weather: weather, theme: M.theme }); }
    if (!renderer && canvas) {
      var R3 = CB.race && CB.race.renderer3d, R2 = CB.race && CB.race.renderer;
      var backend = pickBackend({
        builtin: opts.builtin, graphics: opts.graphics || RS.graphics, real: trk.real,
        has3d: !!(R3 && typeof R3.create === 'function'),
        supported3d: (function () { try { return !!(R3 && (typeof R3.isSupported !== 'function' || R3.isSupported())); } catch (e) { return false; } })(),
        has2d: !!(R2 && typeof R2.create === 'function')
      });
      if (backend === '3d') {
        try {
          var q = opts.quality || (RS.quality && RS.quality !== 'auto' ? RS.quality : 'high');
          renderer = R3.create(canvas, trk.geom, trk.def, { timeOfDay: timeOfDay, weather: weather, quality: q, camera: 'chase', camera2d: 'north',
            autoQuality: opts.autoQuality !== false, units: opts.units, replay: true });
          ownRenderer = true; is3D = true;
        } catch (e3) { renderer = null; is3D = false; if (typeof console !== 'undefined') console.warn('[replay] 3D renderer failed, using 2D view', e3); }
      }
      if (!renderer && backend !== 'builtin' && R2 && typeof R2.create === 'function') {
        try { renderer = CB.race.renderer.create(canvas, trk.geom, trk.def, { timeOfDay: timeOfDay, weather: weather, replay: true }); ownRenderer = true; }
        catch (e) { renderer = null; if (typeof console !== 'undefined') console.warn('[replay] race renderer failed, using built-in view', e); }
      }
      if (!renderer || typeof renderer.render !== 'function') renderer = makeBuiltin();
    } else if (renderer && renderer.__replayView) builtin = true;
    else if (renderer && renderer.is3D) is3D = true;
    if (hud === undefined && canvas && opts.hud !== false && CB.race && CB.race.hud && typeof CB.race.hud.create === 'function') {
      try { hud = CB.race.hud.create(canvas, trk.geom, trk.def, { units: opts.units || 'kph', mode: M.mode, replay: true }); ownHud = true; } catch (e) { hud = null; }
    }
    var extCams = (renderer && (renderer.cameras || (CB.race && CB.race.renderer && CB.race.renderer.cameras))) || [];
    function modes3d() { try { return renderer && typeof renderer.cameraModes === 'function' ? renderer.cameraModes() : (CB.race.renderer3d && CB.race.renderer3d.CAMERA_MODES) || []; } catch (e) { return []; } }

    var rig = createCameraRig(trk.geom);
    var listeners = {};
    var S = {
      t: clamp(num(opts.start, 0), 0, duration), playing: false, speed: 1, camera: opts.camera || 'director', followId: M.playerId,
      hudVisible: opts.hudVisible !== false, overlay: opts.overlay !== false, loop: !!opts.loop, range: null,
      lastReal: null, raf: 0, live: true, destroyed: false, emitFrom: null, free: null, post: { zoom: 1, rot: 0, panX: 0, panY: 0 },
      dir: { start: 0, until: -1, cam: 'helicopter', target: null, shot: 0, label: '' }, lastExtCam: null, lastSnap: null, lastCam: null, reverse: false,
      inset: { top: 0, bottom: 0 },
      fails3d: 0, ctl: null, ctlFree: null, free3d: null, orbit: { a: 0 }, pose3d: null, dims3d: null, cutPending: false
    };
    /* 3D: replay-side camera controller layered on renderer3d's built-in modes (orbit / free); it also records the
       followed car's interpolated pose so photo mode can seed its free camera from what is on screen */
    function camCtl(c) {
      S.pose3d = c.pose; S.dims3d = c.dims;
      if (S.ctl === 'orbit') return orbitCam3d(c.pose, S.orbit.a, c.dims, c.safeFraction, c.groundY);
      if (S.ctl === 'free' && S.ctlFree) return freeCam3d(S.ctlFree, c.pose);
      return false;
    }
    if (is3D && typeof renderer.setCameraController === 'function') { try { renderer.setCameraController(camCtl); } catch (e) { /* ignore */ } }
    var scratch = null;

    function emit(name, data) { (listeners[name] || []).slice().forEach(function (fn) { try { fn(data, api); } catch (e) { if (typeof console !== 'undefined') console.error(e); } }); }
    function carIds() { return rep.cars.map(function (c) { return c.info.id; }); }

    function director(snap) {
      var D = S.dir, t = S.t;
      var upcoming = (rep.highlights || []).filter(function (h) { return h.t > t - 0.3 && h.t < t + 3.5; })[0];
      var mustCut = t >= D.until || t < D.start || (upcoming && upcoming.carId && upcoming.carId !== D.target && t - D.start > 2.5 && D.reason !== upcoming.t);
      if (!mustCut) return;
      var rnd = mulberry32(hashStr(String(Math.floor(t * 4))) + D.shot * 7919);
      D.shot++;
      var cams, target = null, reason = null, label = '';
      if (snap.phase === 'grid' || snap.phase === 'countdown') {
        target = (snap.cars.filter(function (c) { return c.gridPosition === 1 || c.position === 1; })[0] || snap.cars[0] || {}).id;
        cams = ['helicopter', 'trackside']; label = 'The grid';
      } else if (upcoming && upcoming.carId) {
        target = upcoming.carId; reason = upcoming.t; label = (MARKER_STYLE[upcoming.type] || {}).label || '';
        cams = upcoming.type === 'overtake' ? ['trackside', 'chase', 'tv'] : upcoming.type === 'finish' ? ['trackside', 'orbit-car'] : ['trackside', 'helicopter', 'chase'];
        if (is3D && upcoming.type === 'overtake') cams.push('cockpit');
      } else {
        // closest battle near the front
        var best = null, bs = Infinity;
        snap.cars.forEach(function (c) {
          if (c.finished || c.dnf || !isNum(c.gapAhead_s) || c.gapAhead_s <= 0 || c.position <= 1) return;
          var score = c.gapAhead_s + c.position * 0.25;
          if (score < bs) { bs = score; best = c; }
        });
        if (best && best.gapAhead_s < 1.6) { target = best.id; label = 'Battle for P' + (best.position - 1); }
        else { var pool = snap.cars.filter(function (c) { return !c.dnf; }); var pick = rnd() < 0.45 ? snap.cars.filter(function (c) { return c.wasPlayer; })[0] : pool[Math.floor(rnd() * pool.length)]; target = (pick || pool[0] || {}).id; label = ''; }
        cams = ['chase', 'trackside', 'orbit-car', 'helicopter', 'tv', 'trackside'];
        if (is3D) cams.push('cockpit');
      }
      if (snap.phase === 'finished' || (duration - t < 6)) { var win = snap.cars.filter(function (c) { return c.position === 1; })[0]; if (win && !upcoming) { target = win.id; cams = ['orbit-car', 'helicopter']; label = 'Winner'; } }
      var cam = cams[Math.floor(rnd() * cams.length)];
      if (cam === D.cam && cams.length > 1) cam = cams[(cams.indexOf(cam) + 1) % cams.length];
      D.cam = cam; D.target = target; D.reason = reason; D.label = label;
      D.start = t; D.until = t + 5 + rnd() * 4.5;
      rig.cut(); S.cutPending = true;
      emit('director', { camera: cam, carId: target, label: label });
    }

    function effectiveCamera() { return S.camera === 'director' ? S.dir.cam : S.camera; }
    function effectiveFollow() { return S.camera === 'director' && S.dir.target ? S.dir.target : S.followId; }

    function applyPost(post) {
      if (!canvas) return;
      var cover = function (rot) {
        var c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot)), w = canvas.width, h = canvas.height;
        return Math.max((w * c + h * s) / w, (w * s + h * c) / h);
      };
      if (Math.abs(post.zoom - 1) < 1e-3 && Math.abs(post.rot) < 1e-4 && !post.panX && !post.panY) return;
      if (!scratch) scratch = document.createElement('canvas');
      if (scratch.width !== canvas.width || scratch.height !== canvas.height) { scratch.width = canvas.width; scratch.height = canvas.height; }
      var sc = scratch.getContext('2d'); sc.setTransform(1, 0, 0, 1, 0, 0); sc.clearRect(0, 0, scratch.width, scratch.height); sc.drawImage(canvas, 0, 0);
      var ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height, k = Math.max(1, post.zoom) * cover(post.rot);
      var dpr = w / Math.max(1, canvas.clientWidth || w);
      var maxPx = (k - 1) * w / 2, maxPy = (k - 1) * h / 2;
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
      ctx.translate(w / 2 + clamp(post.panX * dpr, -maxPx, maxPx), h / 2 + clamp(post.panY * dpr, -maxPy, maxPy)); ctx.rotate(post.rot); ctx.scale(k, k); ctx.translate(-w / 2, -h / 2);
      ctx.drawImage(scratch, 0, 0); ctx.restore();
    }

    function drawOverlay(ctx, snap, W, H) {
      var car = snap.cars.filter(function (c) { return c.isPlayer; })[0];
      ctx.save();
      // REPLAY badge
      var blink = S.playing ? (Math.floor(now() / 600) % 2 === 0) : true;
      ctx.font = '700 12px "Helvetica Neue", system-ui, sans-serif'; ctx.textBaseline = 'middle';
      // with the race HUD on, its timing tower (top-left), lap/position panel (top-right) and start lights /
      // countdown caption (top-centre) own the top edge: the REPLAY badge and the director's shot label move to a
      // bottom-centre strip instead (between the HUD minimap and gauge cluster)
      var hudOn = !!(S.hudVisible && hud);
      var dirLabel = S.camera === 'director' && S.dir.label ? S.dir.label.toUpperCase() : '';
      ctx.font = '700 11px "Helvetica Neue", system-ui, sans-serif';
      var dlw = dirLabel ? ctx.measureText(dirLabel).width + 22 : 0;
      ctx.font = '700 12px "Helvetica Neue", system-ui, sans-serif';
      var bx = hudOn ? Math.round(W / 2 - (100 + (dlw ? dlw + 8 : 0)) / 2 + (dlw ? dlw + 8 : 0)) : W - 118, by = hudOn ? Math.round(H - 40) : 18;
      // a host UI with chrome over the canvas (openUI's header / transport bar) reserves an inset: the badge then sits
      // top-left just below the header, with the director label beside it, clear of the header buttons and car list
      var inTop = hudOn ? 0 : S.inset.top, inBot = hudOn ? 0 : S.inset.bottom;
      if (inTop > 0) { bx = 22; by = inTop + 6; }
      ctx.fillStyle = 'rgba(10,10,12,0.72)'; roundRectPx(ctx, bx, by, 100, 26, 4); ctx.fill();
      ctx.fillStyle = blink ? '#e5533d' : 'rgba(229,83,61,0.35)'; ctx.beginPath(); ctx.arc(bx + 15, by + 13, 4.5, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ecebe6'; ctx.fillText('REPLAY', bx + 27, by + 13.5);
      ctx.fillStyle = 'rgba(243,239,230,0.6)'; ctx.font = '600 10px ui-monospace, monospace';
      ctx.fillText(S.speed === 1 ? '1×' : S.speed + '×', bx + 80, by + 13.5);
      // lower third: followed car
      if (car && !S.hudVisible) {
        var lx = 22, ly = inBot > 0 ? H - inBot - 66 : H - 92, lw = Math.min(360, W - 44);
        ctx.fillStyle = 'rgba(10,10,12,0.78)'; roundRectPx(ctx, lx, ly, lw, 54, 6); ctx.fill();
        ctx.fillStyle = car.color || '#c9a56b'; ctx.fillRect(lx, ly, 6, 54);
        ctx.fillStyle = '#ecebe6'; ctx.font = '800 22px "Helvetica Neue", system-ui, sans-serif'; ctx.fillText('P' + (car.position || '-'), lx + 18, ly + 27);
        ctx.font = '700 14px "Helvetica Neue", system-ui, sans-serif'; ctx.fillText(String(car.name || ''), lx + 70, ly + 20);
        ctx.font = '500 11px system-ui, sans-serif'; ctx.fillStyle = 'rgba(243,239,230,0.65)';
        var sub = (car.team ? car.team + ' · ' : '') + '#' + car.number + ' · ' + Math.round(car.speed * 3.6) + ' km/h · Lap ' + Math.min((car.lap || 0) + 1, snap.lapsTotal || 99);
        ctx.fillText(sub, lx + 70, ly + 38);
      }
      if (dirLabel) {
        var lx0 = hudOn ? bx - 8 - dlw : inTop > 0 ? bx + 108 : 22, ly0 = hudOn || inTop > 0 ? by + 1 : 18;
        ctx.font = '700 11px "Helvetica Neue", system-ui, sans-serif';
        ctx.fillStyle = 'rgba(200,169,106,0.92)'; roundRectPx(ctx, lx0, ly0, dlw, 24, 3); ctx.fill();
        ctx.fillStyle = '#111'; ctx.fillText(dirLabel, lx0 + 11, ly0 + 12.5);
      }
      ctx.restore();
    }

    function render(realDt, renderOpts) {
      renderOpts = renderOpts || {};
      if (!renderer || S.destroyed) return null;
      var events = [];
      if (S.emitFrom != null && S.t >= S.emitFrom && S.t - S.emitFrom < 1.5) events = eventsBetween(rep, S.emitFrom, S.t);
      S.emitFrom = S.t;
      var snap = snapshotAt(rep, S.t, { followId: S.camera === 'director' ? (S.dir.target || S.followId) : S.followId, events: events });
      if (S.camera === 'director' && !renderOpts.noDirector) { director(snap); if (snap.playerId !== effectiveFollow()) snap = snapshotAt(rep, S.t, { followId: effectiveFollow(), events: events }); }
      var follow = snap.cars.filter(function (c) { return c.isPlayer; })[0] || null;
      var camMode = renderOpts.camera || effectiveCamera(), dt = clamp(num(realDt, 1 / 60), 0, 0.25);
      var W = canvas ? (canvas.clientWidth || canvas.width) : 800, H = canvas ? (canvas.clientHeight || canvas.height) : 450;
      if (builtin) {
        var cam = rig.update(camMode, follow, snap, dt * Math.max(0.25, S.playing ? S.speed : 1), W, H, renderOpts.free || S.free);
        S.lastCam = cam;
        renderer.render(snap, cam, renderOpts);
      } else if (is3D) {
        var m3 = camera3dFor(camMode, modes3d());
        S.ctl = m3.ctl; S.ctlFree = renderOpts.free3d || S.free3d;
        if (m3.ctl === 'orbit' && !renderOpts.silent) S.orbit.a += dt * 0.3 * (S.playing ? Math.max(0.25, S.speed) : 0.35);
        if (m3.mode !== S.lastExtCam && typeof renderer.setCamera === 'function') { try { renderer.setCamera(m3.mode); } catch (e) { /* ignore */ } S.lastExtCam = m3.mode; }
        // a director cut (new car / shot) snaps the camera instead of springing across the circuit
        if (S.cutPending) { S.cutPending = false; try { if (renderer.setCameraController) renderer.setCameraController(camCtl); } catch (e) { /* ignore */ } }
        try { renderer.render(snap, 1); S.fails3d = 0; }
        catch (e3d) {
          // a renderer that keeps throwing is swapped for the top-down view so playback never stalls
          if (++S.fails3d >= 3) { fallbackTo2D(e3d); return render(realDt, renderOpts); }
        }
      } else {
        var ext = extCams.indexOf(camMode) >= 0 ? camMode : (EXT_CAMERA_MAP[camMode] || 'chase');
        if (ext !== S.lastExtCam && typeof renderer.setCamera === 'function') { try { renderer.setCamera(ext); } catch (e) { /* ignore */ } S.lastExtCam = ext; }
        renderer.render(snap, 1);
        var post = renderOpts.post || null;
        if (!post && camMode === 'orbit-car' && extCams.indexOf('orbit-car') < 0) { S.post.rot = (S.post.rot || 0) + dt * 0.25 * (S.playing ? 1 : 0); post = { zoom: 1.05, rot: S.post.rot, panX: 0, panY: 0 }; }
        if (!post && camMode === 'free' && S.free) post = { zoom: S.free.zoom / 7, rot: S.free.rot, panX: S.free.panX || 0, panY: S.free.panY || 0 };
        if (post) applyPost(post);
      }
      if (canvas) {
        var ctx = canvas.getContext('2d'), dpr = canvas.width / Math.max(1, canvas.clientWidth || canvas.width);
        ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (S.hudVisible && hud && typeof hud.draw === 'function' && !renderOpts.noHud) { try { hud.draw(ctx, snap); } catch (e) { /* hud errors must not stop playback */ } }
        if (S.overlay && !renderOpts.noOverlay) drawOverlay(ctx, snap, canvas.clientWidth || canvas.width / dpr, canvas.clientHeight || canvas.height / dpr);
        ctx.restore();
      }
      S.lastSnap = snap;
      if (!renderOpts.silent) emit('frame', { t: S.t, snap: snap });
      return snap;
    }

    function tick(realDt) {
      if (S.destroyed) return;
      if (S.playing) {
        var nt = S.t + realDt * S.speed * (S.reverse ? -1 : 1);
        var lo = S.range ? S.range[0] : 0, hi = S.range ? S.range[1] : duration;
        if (nt >= hi) {
          if (S.loop || S.range) { nt = lo; resetRenderer(); S.emitFrom = null; }
          else { nt = hi; S.playing = false; emit('ended', { t: nt }); emit('pause', { t: nt }); }
        } else if (nt <= lo && S.reverse) { nt = lo; S.playing = false; emit('pause', { t: nt }); }
        if (S.reverse) S.emitFrom = null;
        S.t = nt;
      }
      if (S.live) render(realDt);
    }
    function loop(ts) {
      if (S.destroyed) return;
      var t = num(ts, now()), dt = S.lastReal == null ? 1 / 60 : (t - S.lastReal) / 1000;
      S.lastReal = t;
      tick(clamp(dt, 0, 0.1));
      S.raf = requestAnimationFrame(loop);
    }
    function startLoop() { if (!S.raf && typeof requestAnimationFrame === 'function' && canvas && opts.manualLoop !== true) { S.lastReal = null; S.raf = requestAnimationFrame(loop); } }
    function fallbackTo2D(err) {
      if (typeof console !== 'undefined') console.warn('[replay] 3D renderer failing, switching to the 2D view', err);
      try { if (renderer.setCameraController) renderer.setCameraController(null); } catch (e) { /* ignore */ }
      try { if (ownRenderer && renderer.destroy) renderer.destroy(); } catch (e) { /* ignore */ }
      is3D = false; renderer = makeBuiltin(); S.lastExtCam = null; rig.cut();
      emit('backend', { backend: 'builtin' });
    }
    function resetRenderer() { try { if (renderer && typeof renderer.reset === 'function') renderer.reset(); } catch (e) { /* ignore */ } rig.cut(); S.cutPending = true; }

    var api = {
      replay: rep, geom: trk.geom, trackDef: trk.def, realTrack: trk.real,
      get duration() { return duration; },
      get time() { return S.t; },
      get playing() { return S.playing; },
      get camera() { return S.camera; },
      get effectiveCamera() { return effectiveCamera(); },
      get following() { return effectiveFollow(); },
      get builtin() { return builtin; },
      get is3D() { return is3D; },
      /* renderer3d mode actually on screen ('map' = 2D top-down delegate) */
      get mode3d() { try { return is3D && renderer.getCamera ? renderer.getCamera() : null; } catch (e) { return null; } },
      get glCanvas() { return is3D && renderer ? renderer.glCanvas || null : null; },
      get pose3d() { return S.pose3d ? Object.assign({}, S.pose3d) : null; },
      cameraState3d: function () { try { return is3D && renderer.getCameraState ? renderer.getCameraState() : null; } catch (e) { return null; } },
      get renderer() { return renderer; },
      get hud() { return hud; },
      get canvas() { return canvas; },
      get lastSnapshot() { return S.lastSnap; },
      get lastCamera() { return S.lastCam || rig.state(); },
      get cameras() { return canvas ? uiCameras(is3D, is3D ? modes3d() : null) : CAMERAS.slice(); },
      play: function () { if (S.t >= duration - 1e-3 && !S.reverse) api.seek(S.range ? S.range[0] : 0); S.playing = true; startLoop(); emit('play', { t: S.t }); return api; },
      pause: function () { if (S.playing) { S.playing = false; emit('pause', { t: S.t }); } if (!S.raf && canvas) render(0, { silent: false }); return api; },
      toggle: function () { return S.playing ? api.pause() : api.play(); },
      seek: function (t) {
        var nt = clamp(num(t, 0), 0, duration);
        if (nt < S.t - 1e-6 || Math.abs(nt - S.t) > 1.5) resetRenderer();
        S.t = nt; S.emitFrom = null; S.dir.until = -1;
        emit('seek', { t: nt });
        if (!S.raf && canvas) render(0);
        return api;
      },
      skip: function (dt) { return api.seek(S.t + dt); },
      step: function (frames) { var iv = 1 / num(M.hz, 30); api.pause(); return api.seek(S.t + iv * (frames || 1)); },
      speed: function (x) {
        if (x === undefined) return S.speed;
        S.speed = clamp(num(x, 1), 0.25, 4); emit('speed', { speed: S.speed }); return api;
      },
      setReverse: function (v) { S.reverse = !!v; return api; },
      setCamera: function (mode) {
        if (CAMERAS.indexOf(mode) < 0) mode = 'chase';
        if (mode === 'free' && is3D && !S.free3d) S.free3d = seedFree3d(api.cameraState3d(), S.pose3d, true);
        if (mode === 'free' && !S.free) { var c = S.lastCam || rig.state(); S.free = { x: c.x, y: c.y, zoom: c.zoom / (Math.min(canvas ? canvas.clientWidth || 800 : 800, canvas ? canvas.clientHeight || 450 : 450) / 760) || 7, rot: c.rot, panX: 0, panY: 0 }; }
        S.camera = mode; S.dir.until = -1; rig.cut(); emit('camera', { camera: mode });
        if (!S.raf && canvas) render(0);
        return api;
      },
      cycleCamera: function (dir) { var list = api.cameras.filter(function (c) { return c !== 'free'; }), i = list.indexOf(S.camera); return api.setCamera(list[(i + (dir || 1) + list.length) % list.length]); },
      followCar: function (id) {
        if (id == null) return S.followId;
        id = String(id); if (carIds().indexOf(id) < 0) return api;
        S.followId = id; if (S.camera === 'director') S.camera = 'chase';
        rig.cut(); emit('follow', { carId: id }); if (!S.raf && canvas) render(0);
        return api;
      },
      nextCar: function (dir) {
        var snap = S.lastSnap || snapshotAt(rep, S.t), order = snap.order || carIds();
        var i = order.indexOf(effectiveFollow()); return api.followCar(order[(i + (dir || 1) + order.length) % order.length]);
      },
      setFreeCamera: function (fc) { S.free = Object.assign(S.free || {}, fc || {}); if (S.camera !== 'free') S.camera = 'free'; if (!S.raf && canvas) render(0); return api; },
      getFreeCamera: function () { return S.free ? Object.assign({}, S.free) : null; },
      setFreeCamera3d: function (fc) { S.free3d = Object.assign(S.free3d || defaultFree3d(S.pose3d), fc || {}); if (S.camera !== 'free') S.camera = 'free'; if (!S.raf && canvas) render(0); return api; },
      getFreeCamera3d: function () { return S.free3d ? Object.assign({}, S.free3d) : null; },
      setHud: function (v) { S.hudVisible = v == null ? !S.hudVisible : !!v; return api; },
      setOverlay: function (v) { S.overlay = v == null ? !S.overlay : !!v; return api; },
      setOverlayInset: function (top, bottom) { S.inset = { top: Math.max(0, num(top, 0)), bottom: Math.max(0, num(bottom, 0)) }; if (!S.raf && canvas && !S.destroyed) render(0, { silent: true }); return api; },
      get hudVisible() { return S.hudVisible; },
      setLoop: function (v) { S.loop = !!v; return api; },
      setRange: function (a, b) { S.range = a == null ? null : [clamp(a, 0, duration), clamp(b == null ? duration : b, 0, duration)]; return api; },
      setLive: function (v) { S.live = !!v; return api; },
      render: function (o) { return render(0, o); },
      renderAt: function (t, o) { var keep = S.t, kf = S.emitFrom; S.t = clamp(t, 0, duration); S.emitFrom = null; var snap = render(0, Object.assign({ silent: true, noDirector: true }, o || {})); S.t = keep; S.emitFrom = kf; return snap; },
      tick: tick,
      snapshot: function (t) { return snapshotAt(rep, t == null ? S.t : t, { followId: effectiveFollow() }); },
      markers: function () { return (rep.markers || []).slice(); },
      highlights: function () { return (rep.highlights || []).slice(); },
      cars: function () { return rep.cars.map(function (c) { return Object.assign({}, c.info); }); },
      resize: function () { try { if (renderer && renderer.resize) renderer.resize(); } catch (e) { /* ignore */ } if (!S.raf && canvas) render(0); },
      on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); return function () { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; }); }; },
      destroy: function () {
        S.destroyed = true; S.playing = false;
        if (S.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(S.raf);
        S.raf = 0; listeners = {};
        if (ownHud && hud && hud.destroy) { try { hud.destroy(); } catch (e) { /* ignore */ } }
        if (is3D && renderer && renderer.setCameraController) { try { renderer.setCameraController(null); } catch (e) { /* ignore */ } }
        if (ownRenderer && renderer && renderer.destroy) { try { renderer.destroy(); } catch (e) { /* ignore */ } }
        S.lastSnap = null;
      }
    };
    if (opts.followId) S.followId = String(opts.followId);
    if (canvas) { startLoop(); if (opts.autoplay) api.play(); }
    else if (opts.autoplay) S.playing = true;
    return api;
  }
  function roundRectPx(ctx, x, y, w, h, r) { roundRect(ctx, x, y, w, h, r); }

  /* ================================================================ DOM helpers */

  var hasDOM = typeof document !== 'undefined' && typeof window !== 'undefined';
  function h(tag, attrs) {
    var e = document.createElement(tag), i;
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k]; if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    for (i = 2; i < arguments.length; i++) {
      var c = arguments[i]; if (c == null || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x != null) e.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
      else e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return e;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob), a = h('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }
  function downloadText(text, name) { downloadBlob(new Blob([text], { type: 'text/plain' }), name); }
  function slug(s) { return String(s || 'replay').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'replay'; }
  function notifyAchievement(ev) {
    var A = CB.game.achievements, P = CB.game.profile;
    if (!A || typeof A.check !== 'function') return;
    try {
      var prof = P && typeof P.get === 'function' ? P.get() : null;
      var list = A.check(prof, ev) || [];
      list.forEach(function (a) { if (typeof A.toast === 'function') { try { A.toast(a); } catch (e) { /* ignore */ } } });
    } catch (e) { /* achievements are optional */ }
  }
  var ICONS = {
    play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" fill="currentColor"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M11 6l-7 6 7 6zM20 6l-7 6 7 6z" fill="currentColor"/></svg>',
    fwd: '<svg viewBox="0 0 24 24"><path d="M13 6l7 6-7 6zM4 6l7 6-7 6z" fill="currentColor"/></svg>',
    stepB: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM19 5L9 12l10 7z" fill="currentColor"/></svg>',
    stepF: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM5 5l10 7-10 7z" fill="currentColor"/></svg>',
    camera: '<svg viewBox="0 0 24 24"><path d="M4 7h3.2L9 4.8h6L16.8 7H20a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12.6" r="3.6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5z M8 4v5h7V4 M8 20v-6h8v6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    share: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.6 6 .7-4.5 4.1 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.8l6-.7z" fill="currentColor"/></svg>',
    film: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4" stroke="currentColor" stroke-width="1.4"/></svg>',
    loop: '<svg viewBox="0 0 24 24"><path d="M4 12a6 6 0 0 1 6-6h8l-3-3M20 12a6 6 0 0 1-6 6H6l3 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 6.2L20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8z" fill="currentColor"/></svg>'
  };

  var STYLE_ID = 'game-replay-styles';
  var CSS = [
    '.grp-root{position:absolute;inset:0;z-index:60;background:#07080a;color:var(--text,#ecebe6);font:var(--fs-sm)/1.35 var(--font,"Inter",system-ui,-apple-system,sans-serif);overflow:hidden;user-select:none;-webkit-user-select:none}',
    '.grp-root.grp-fixed{position:fixed;z-index:9000}',
    '.grp-canvas,.grp-photo,.grp-guides{position:absolute;inset:0;width:100%;height:100%;display:block}',
    '.grp-photo{display:none;cursor:grab}.grp-photo.grab{cursor:grabbing}.grp-guides{pointer-events:none;display:none}',
    '.grp-root.photo .grp-photo,.grp-root.photo .grp-guides{display:block}',
    '.grp-top{position:absolute;left:0;right:0;top:0;display:flex;align-items:center;gap:12px;padding:14px 18px;background:linear-gradient(#000c,#0000);transition:opacity .35s,transform .35s}',
    '.grp-title{display:flex;flex-direction:column;min-width:0}.grp-title b{font-size:var(--fs-md);letter-spacing:.14em;text-transform:uppercase;font-weight:700}',
    '.grp-title span{font-size:var(--fs-xs);color:var(--text-dim,#9b9890);letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.grp-sp{flex:1}',
    '.grp-btn{appearance:none;border:1px solid var(--line-soft,rgba(255,255,255,.06));background:var(--glass,rgba(18,19,23,.72));color:var(--text,#ecebe6);border-radius:var(--radius-sm,9px);height:32px;padding:0 12px;display:inline-flex;align-items:center;gap:7px;font:600 var(--fs-sm)/1 inherit;font-family:inherit;letter-spacing:.03em;cursor:pointer;transition:background .15s,border-color .15s,color .15s,transform .1s;backdrop-filter:blur(6px)}',
    '.grp-btn:hover{background:var(--panel-hover,#1f2026);border-color:var(--line,#2b2c33)}.grp-btn:active{transform:translateY(1px)}',
    '.grp-btn.on{background:var(--accent,#c9a56b);color:var(--accent-ink,#17130b);border-color:var(--accent,#c9a56b)}.grp-btn.icon{width:32px;padding:0;justify-content:center}',
    '.grp-btn svg{width:16px;height:16px}.grp-btn.big{width:44px;height:44px;border-radius:50%;padding:0;justify-content:center;background:var(--text-strong,#fff);color:var(--bg,#0b0b0d);border:0}.grp-btn.big svg{width:20px;height:20px}',
    '.grp-btn.big:hover{background:#fff}.grp-btn.gold{background:var(--accent,#c9a56b);color:var(--accent-ink,#17130b);border-color:var(--accent,#c9a56b)}.grp-btn.danger:hover{background:var(--bad-soft,rgba(229,72,77,.14));border-color:var(--bad,#e5484d);color:var(--bad,#e5484d)}',
    '.grp-bottom{position:absolute;left:0;right:0;bottom:0;padding:44px 18px 14px;background:linear-gradient(#0000,#000d 55%);transition:opacity .35s,transform .35s}',
    '.grp-root.idle .grp-top,.grp-root.idle .grp-bottom,.grp-root.idle .grp-cars{opacity:0;pointer-events:none}.grp-root.idle{cursor:none}',
    '.grp-root.hideui .grp-top,.grp-root.hideui .grp-bottom,.grp-root.hideui .grp-cars{display:none}',
    /* race HUD toggled on: it brings its own timing tower, so the replay standings go away and the scene canvas is
       inset between the replay header and transport bar so HUD graphics never sit under the replay chrome */
    '.grp-root.hud-on .grp-cars{display:none}',
    '.grp-root.hud-on:not(.hideui) .grp-canvas{top:var(--grp-top-h,62px);bottom:auto;height:calc(100% - var(--grp-top-h,62px) - var(--grp-bot-h,124px))!important}',
    '.grp-tl{position:relative;height:58px;cursor:pointer;margin-bottom:10px}.grp-tl canvas{position:absolute;inset:0;width:100%;height:100%}',
    '.grp-tip{position:absolute;bottom:62px;transform:translateX(-50%);background:var(--glass-strong,rgba(14,15,18,.9));border:1px solid var(--line,#2b2c33);border-radius:var(--radius-xs);padding:5px 8px;font-size:var(--fs-xs);white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .12s}',
    '.grp-tip.show{opacity:1}.grp-tip b{color:var(--accent,#c9a56b)}',
    '.grp-ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.grp-time{font:600 var(--fs-sm) var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);letter-spacing:.02em;min-width:150px;color:var(--text,#ecebe6)}.grp-time i{font-style:normal;color:var(--text-dim,#9b9890)}',
    '.grp-group{display:inline-flex;border:1px solid var(--line,#2b2c33);border-radius:var(--radius-sm,9px);overflow:hidden;background:var(--glass,rgba(18,19,23,.72))}',
    '.grp-group .grp-btn{border:0;border-radius:0;background:transparent;height:30px;padding:0 9px}.grp-group .grp-btn.on{background:var(--accent,#c9a56b);color:var(--accent-ink,#17130b)}',
    '.grp-group .grp-btn+.grp-btn{border-left:1px solid var(--line-soft,rgba(255,255,255,.06))}',
    '.grp-lbl{font-size:var(--fs-2xs);letter-spacing:.14em;text-transform:uppercase;color:var(--text-faint,#6c6a64);margin:0 2px 0 6px}',
    '.grp-cars{position:absolute;right:14px;top:70px;bottom:150px;width:220px;overflow:auto;padding:4px;transition:opacity .35s;scrollbar-width:thin}',
    '.grp-car{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--radius-xs);cursor:pointer;background:var(--glass,rgba(18,19,23,.72));margin-bottom:4px;border:1px solid transparent;transition:background .15s,border-color .15s}',
    '.grp-car:hover{background:var(--panel-hover,#1f2026)}.grp-car.on{border-color:var(--accent,#c9a56b);background:var(--accent-soft,rgba(201,165,107,.14))}',
    '.grp-car .p{font:700 var(--fs-sm) var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);width:26px;color:var(--text-dim,#9b9890)}.grp-car .sw{width:6px;height:22px;border-radius:2px}',
    '.grp-car .n{flex:1;min-width:0}.grp-car .n b{display:block;font-size:var(--fs-sm);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.grp-car .n span{font-size:var(--fs-2xs);color:var(--text-dim,#9b9890)}',
    '.grp-car .you{font-size:var(--fs-2xs);letter-spacing:.12em;background:var(--accent,#c9a56b);color:var(--accent-ink,#17130b);border-radius:3px;padding:1px 4px;font-weight:700}',
    '.grp-menu{position:absolute;min-width:240px;max-height:340px;overflow:auto;background:var(--glass-strong,rgba(14,15,18,.9));border:1px solid var(--line,#2b2c33);border-radius:var(--radius,12px);padding:6px;box-shadow:var(--shadow-lg,0 18px 40px #000a);z-index:5}',
    '.grp-menu button{display:flex;width:100%;gap:8px;align-items:center;text-align:left;background:none;border:0;color:var(--text,#ecebe6);padding:7px 8px;border-radius:var(--radius-xs);cursor:pointer;font-size:var(--fs-sm);font-family:inherit}',
    '.grp-menu button:hover{background:var(--accent-softer,rgba(201,165,107,.07))}.grp-menu .g{width:16px;text-align:center}.grp-menu .t{margin-left:auto;font:var(--fs-xs) var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--text-dim,#9b9890)}',
    '.grp-toast{position:absolute;left:50%;top:70px;transform:translate(-50%,-10px);background:var(--glass-strong,rgba(14,15,18,.9));border:1px solid var(--accent-ring,rgba(201,165,107,.45));color:var(--text,#ecebe6);padding:9px 16px;border-radius:var(--radius-xs);font-size:var(--fs-sm);opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;z-index:9}',
    '.grp-toast.show{opacity:1;transform:translate(-50%,0)}',
    '.grp-pp{position:absolute;right:0;top:0;bottom:0;width:300px;background:var(--glass-strong,rgba(14,15,18,.9));border-left:1px solid var(--line-soft,rgba(255,255,255,.06));overflow:auto;padding:16px 16px 90px;display:none;scrollbar-width:thin}',
    '.grp-root.photo .grp-pp{display:block}.grp-root.photo .grp-top,.grp-root.photo .grp-bottom,.grp-root.photo .grp-cars{display:none}',
    '.grp-pp h3{margin:0 0 4px;font-size:var(--fs-sm);letter-spacing:.18em;text-transform:uppercase}.grp-pp .hint{font-size:var(--fs-xs);color:var(--text-dim,#9b9890);margin-bottom:12px}',
    '.grp-pp h4{margin:16px 0 8px;font-size:var(--fs-2xs);letter-spacing:.16em;text-transform:uppercase;color:var(--accent,#c9a56b)}',
    '.grp-row{display:grid;grid-template-columns:86px 1fr 38px;align-items:center;gap:8px;margin:5px 0;font-size:var(--fs-xs);color:var(--text,#ecebe6)}',
    '.grp-row input[type=range]{width:100%;accent-color:var(--accent,#c9a56b)}.grp-row output{font:var(--fs-2xs) var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);text-align:right;color:var(--text-dim,#9b9890)}',
    '.grp-presets{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}',
    '.grp-presets button{background:var(--panel,#141519);border:1px solid var(--line-soft,rgba(255,255,255,.06));color:var(--text,#ecebe6);border-radius:var(--radius-xs);padding:8px 4px;font-weight:600;font-size:var(--fs-2xs);font-family:inherit;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}',
    '.grp-presets button.on,.grp-presets button:hover{border-color:var(--accent,#c9a56b);color:var(--accent,#c9a56b)}',
    '.grp-pp select,.grp-pp input[type=text]{width:100%;background:var(--panel,#141519);color:var(--text,#ecebe6);border:1px solid var(--line,#2b2c33);border-radius:var(--radius-xs);padding:7px;font-size:var(--fs-sm);font-family:inherit}',
    '.grp-chk{display:flex;align-items:center;gap:8px;font-size:var(--fs-sm);margin:6px 0;cursor:pointer}.grp-chk input{accent-color:var(--accent,#c9a56b)}',
    '.grp-ppfoot{position:sticky;bottom:-90px;margin:18px -16px -90px;padding:14px 16px;background:var(--panel,#141519);border-top:1px solid var(--line-soft,rgba(255,255,255,.06));display:flex;gap:8px;flex-wrap:wrap}',
    '.grp-flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;transition:opacity .5s}.grp-flash.on{opacity:.85;transition:none}',
    '.grp-lib{position:fixed;inset:0;z-index:9500;background:var(--scrim,rgba(4,4,6,.62));display:flex;align-items:center;justify-content:center;font:var(--fs-sm)/1.4 var(--font,"Inter",system-ui,-apple-system,sans-serif);color:var(--text,#ecebe6);backdrop-filter:blur(6px)}',
    '.grp-lib.is-inline{position:absolute;z-index:auto;background:none;-webkit-backdrop-filter:none;backdrop-filter:none;padding:clamp(12px,2.5vw,28px)}',
    '.grp-lib.is-inline .grp-libbox{width:min(1100px,100%);max-height:100%;height:100%}',
    '.grp-libbox{width:min(880px,94vw);max-height:88vh;display:flex;flex-direction:column;background:var(--panel,#141519);border:1px solid var(--line-soft,rgba(255,255,255,.06));border-radius:var(--radius-xl,22px);box-shadow:var(--shadow-lg,0 30px 80px #000c);overflow:hidden}',
    '.grp-libhead{display:flex;align-items:center;gap:10px;padding:18px 20px;border-bottom:1px solid var(--line-soft,rgba(255,255,255,.06))}.grp-libhead h2{margin:0;font-family:var(--serif,Georgia,serif);font-size:var(--fs-xl);font-weight:600;letter-spacing:-.01em;color:var(--text-strong,#fff)}',
    '.grp-meter{height:4px;width:120px;background:var(--line,#2b2c33);border-radius:2px;overflow:hidden}.grp-meter i{display:block;height:100%;background:var(--accent,#c9a56b)}',
    '.grp-liblist{overflow:auto;padding:14px 20px 20px;display:grid;gap:10px}',
    '.grp-item{display:grid;grid-template-columns:64px 1fr auto;gap:14px;align-items:center;background:var(--bg,#0b0b0d);border:1px solid var(--line-soft,rgba(255,255,255,.06));border-radius:var(--radius,12px);padding:12px}',
    '.grp-item canvas{width:64px;height:48px;background:#1d3a20;border-radius:var(--radius-xs)}.grp-item b{font-size:var(--fs-md)}.grp-item .meta{font-size:var(--fs-xs);color:var(--text-dim,#9b9890);margin-top:3px}',
    '.grp-item .acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.grp-item .pin{color:var(--accent,#c9a56b)}',
    '.grp-badge{display:inline-block;font-size:var(--fs-2xs);letter-spacing:.1em;text-transform:uppercase;border:1px solid var(--line,#2b2c33);border-radius:3px;padding:1px 5px;margin-left:6px;color:var(--text-dim,#9b9890)}',
    '.grp-empty{padding:50px 20px;text-align:center;color:var(--text-dim,#9b9890)}.grp-empty svg{width:42px;height:42px;opacity:.5;display:block;margin:0 auto 10px}',
    '@media (max-width:760px){.grp-cars{display:none}.grp-pp{width:100%;top:45%}.grp-time{min-width:0}}'
  ].join('\n');
  function injectStyles() {
    if (!hasDOM || document.getElementById(STYLE_ID)) return;
    document.head.appendChild(h('style', { id: STYLE_ID, text: CSS }));
  }

  /* ================================================================ replay UI */

  var activeUI = null;

  function openUI(rep, opts) {
    if (!hasDOM) throw new Error('replay.openUI requires a DOM');
    opts = opts || {};
    if (typeof rep === 'string') rep = store.load(rep) || deserialize(rep);
    if (!rep || !rep.frames) throw new Error('replay.openUI: replay required');
    if (activeUI) activeUI.close();
    injectStyles();
    var M = rep.meta || {}, inf = info(rep);
    var host = opts.root || document.getElementById('race-root');
    var root = h('div', { class: 'grp-root' + (host ? '' : ' grp-fixed'), id: 'game-replay', tabindex: '-1' });
    (host || document.body).appendChild(root);
    var canvas = h('canvas', { class: 'grp-canvas' }), photoCanvas = h('canvas', { class: 'grp-photo' }), guides = h('canvas', { class: 'grp-guides' });
    var flash = h('div', { class: 'grp-flash' }), toastEl = h('div', { class: 'grp-toast' });
    root.appendChild(canvas); root.appendChild(photoCanvas); root.appendChild(guides);

    var units = opts.units || (function () { try { return CB.game.profile.get().settings.units; } catch (e) { return 'kph'; } })();
    var player = createPlayer(rep, opts.renderer, opts.hud, {
      canvas: canvas, geom: opts.geom, trackDef: opts.trackDef, units: units === 'mph' ? 'mph' : 'kph', camera: opts.camera || 'director',
      autoplay: opts.autoplay !== false, start: opts.startAt, builtin: opts.builtin, hudVisible: opts.hudVisible === true, followId: opts.followId
    });
    // the replay is a full-screen viewer like driving: hide the global nav while it is open, restore on close
    var navWasHidden = false;
    try { navWasHidden = document.documentElement.classList.contains('cb-driving'); } catch (e) { /* ignore */ }
    function setNavHidden(on) {
      try { if (CB.router && typeof CB.router.setDriving === 'function') CB.router.setDriving(on); else document.documentElement.classList.toggle('cb-driving', !!on); } catch (e) { /* ignore */ }
    }
    setNavHidden(true);
    var saved = !!(M.id && store.list().some(function (x) { return x.id === M.id; }));
    notifyAchievement({ type: 'replay', action: 'watch' });

    function toast(msg, ms) {
      toastEl.textContent = msg; toastEl.classList.add('show');
      clearTimeout(toast._t); toast._t = setTimeout(function () { toastEl.classList.remove('show'); }, ms || 2200);
    }

    /* ---- top bar */
    var hlBtn = h('button', { class: 'grp-btn', html: ICONS.spark + '<span>Highlights</span>' });
    var saveBtn = h('button', { class: 'grp-btn' + (saved ? ' on' : ''), html: ICONS.save + '<span>' + (saved ? 'Saved' : 'Save') + '</span>' });
    var exportBtn = h('button', { class: 'grp-btn', html: ICONS.share + '<span>Export</span>', title: 'Download .redlinereplay file' });
    var photoBtn = h('button', { class: 'grp-btn gold', html: ICONS.camera + '<span>Photo mode</span>' });
    var closeBtn = h('button', { class: 'grp-btn icon', html: ICONS.close, title: 'Close replay (Esc)' });
    var top = h('div', { class: 'grp-top' },
      h('div', { class: 'grp-title' }, h('b', { text: 'Replay · ' + inf.trackName }),
        h('span', { text: [modeText(inf), inf.laps ? inf.laps + ' laps' : null, carsText(inf.cars), inf.weather, inf.timeOfDay,
          new Date(inf.createdAt || Date.now()).toLocaleString()].filter(Boolean).join(' · ') + (inf.degraded.length ? ' · reduced quality' : '') })),
      h('div', { class: 'grp-sp' }), hlBtn, saveBtn, exportBtn, photoBtn, closeBtn);
    root.appendChild(top);

    /* ---- cars panel */
    var carsEl = h('div', { class: 'grp-cars' });
    root.appendChild(carsEl);
    var carRows = {};
    rep.cars.forEach(function (c) {
      var row = h('div', { class: 'grp-car', title: 'Follow ' + c.info.name },
        h('span', { class: 'p', text: '-' }), h('span', { class: 'sw', style: { background: c.info.color } }),
        h('div', { class: 'n' }, h('b', { text: c.info.name }), h('span', { text: '#' + c.info.number + (c.info.team ? ' · ' + c.info.team : '') })),
        c.info.isPlayer ? h('span', { class: 'you', text: 'YOU' }) : null);
      row.addEventListener('click', function () { player.followCar(c.info.id); refreshButtons(); });
      carRows[c.info.id] = row; carsEl.appendChild(row);
    });
    var lastOrderKey = '';
    function refreshCars(snap) {
      if (!snap) return;
      var key = snap.order.join(',') + '|' + snap.playerId;
      if (key === lastOrderKey) return; lastOrderKey = key;
      snap.order.forEach(function (id, i) {
        var row = carRows[id]; if (!row) return;
        row.querySelector('.p').textContent = 'P' + (i + 1);
        row.classList.toggle('on', id === snap.playerId);
        carsEl.appendChild(row);
      });
    }

    /* ---- timeline */
    var tl = h('div', { class: 'grp-tl' }), tlc = h('canvas'), tip = h('div', { class: 'grp-tip' });
    tl.appendChild(tlc);
    var dur = Math.max(0.001, player.duration), markers = player.markers();
    var posTraces = {};
    function trace(id) { if (!posTraces[id]) posTraces[id] = series(rep, id, 'pos', 360); return posTraces[id]; }
    var leaderLaps = markers.filter(function (m) { return m.type === 'lap' && m.leader; });
    var hoverX = null, dragging = false;
    function visibleMarkers(follow) {
      return markers.filter(function (m) {
        if (m.type === 'lap') return m.leader || m.carId === follow;
        if (m.minor) return m.carId === follow;
        return true;
      });
    }
    function drawTimeline() {
      var f = fitCanvas(tlc), ctx = f.ctx, W = f.w, H = f.h, follow = player.following;
      ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      var barY = H - 16, x = function (t) { return clamp(t / dur, 0, 1) * W; };
      // position trace of followed car
      var tr = trace(follow), nCars = Math.max(2, rep.cars.length);
      if (tr.length > 1) {
        ctx.beginPath();
        tr.forEach(function (p, i) { var px = x(p.t), py = 4 + (clamp(p.v, 1, nCars) - 1) / (nCars - 1) * (barY - 14); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
        var car = rep.cars.filter(function (c) { return c.info.id === follow; })[0];
        ctx.strokeStyle = (car && car.info.color) || '#c9a56b'; ctx.globalAlpha = 0.75; ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1;
        ctx.fillStyle = '#ecebe655'; ctx.font = '9px ui-monospace,monospace'; ctx.fillText('P1', 2, 10); ctx.fillText('P' + nCars, 2, barY - 8);
      }
      // bar
      ctx.fillStyle = '#ffffff1f'; roundRect(ctx, 0, barY, W, 6, 3); ctx.fill();
      ctx.fillStyle = '#c9a56b'; roundRect(ctx, 0, barY, Math.max(6, x(player.time)), 6, 3); ctx.fill();
      // leader lap ticks
      ctx.fillStyle = '#ecebe6a0'; ctx.font = '9px ui-monospace,monospace'; ctx.textAlign = 'center';
      leaderLaps.forEach(function (m) { var px = x(m.t); ctx.fillRect(px - 0.5, barY - 4, 1, 14); if (W / Math.max(1, leaderLaps.length) > 34) ctx.fillText('L' + (m.lap + 1), px, barY + 18 > H ? barY - 6 : H - 1); });
      // markers
      visibleMarkers(follow).forEach(function (m) {
        if (m.type === 'lap') { if (!m.leader && m.carId === follow) { ctx.fillStyle = '#c9a56b'; ctx.fillRect(x(m.t) - 1, barY - 2, 2, 10); } return; }
        var st = MARKER_STYLE[m.type] || { color: '#fff' }, px = x(m.t), mine = m.carId === follow || m.otherId === follow;
        ctx.fillStyle = st.color; ctx.globalAlpha = mine ? 1 : 0.55;
        var r = mine ? 4 : 3, py = barY - 7;
        ctx.beginPath();
        if (m.type === 'overtake') { ctx.moveTo(px, py - r); ctx.lineTo(px + r, py + r); ctx.lineTo(px - r, py + r); }
        else if (m.type === 'collision' || m.type === 'wall') { ctx.save(); ctx.translate(px, py); ctx.rotate(Math.PI / 4); ctx.rect(-r * 0.4, -r, r * 0.8, r * 2); ctx.rect(-r, -r * 0.4, r * 2, r * 0.8); ctx.restore(); }
        else if (m.type === 'fastestLap') { ctx.moveTo(px, py - r); ctx.lineTo(px + r, py); ctx.lineTo(px, py + r); ctx.lineTo(px - r, py); }
        else ctx.arc(px, py, r * 0.8, 0, TAU);
        ctx.fill(); ctx.globalAlpha = 1;
      });
      // playhead
      var hx = x(player.time);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx, barY + 3, 6, 0, TAU); ctx.fill();
      if (hoverX != null) { ctx.fillStyle = '#ffffff40'; ctx.fillRect(hoverX - 0.5, 0, 1, H); }
      ctx.textAlign = 'left';
    }
    function tlTime(ev) { var r = tl.getBoundingClientRect(); return clamp((ev.clientX - r.left) / r.width, 0, 1) * dur; }
    function nearestMarker(ev) {
      var r = tl.getBoundingClientRect(), px = ev.clientX - r.left, best = null, bd = 7;
      visibleMarkers(player.following).forEach(function (m) { if (m.type === 'lap' && !m.leader) return; var d = Math.abs(m.t / dur * r.width - px); if (d < bd) { bd = d; best = m; } });
      return best;
    }
    function carName(id) { var c = rep.cars.filter(function (x) { return x.info.id === id; })[0]; return c ? c.info.name : ''; }
    function markerText(m) {
      var st = MARKER_STYLE[m.type] || { label: m.type };
      var s = '<b>' + esc(st.label) + '</b> ' + fmtClock(m.t);
      if (m.type === 'lap') s = '<b>Lap ' + (m.lap + 1) + '</b> ' + fmtClock(m.t) + (m.value ? ' · ' + fmtTime(m.value) : '') + (m.carId ? ' · ' + esc(carName(m.carId)) : '');
      else if (m.type === 'overtake') s += ' · ' + esc(carName(m.carId)) + ' passes ' + esc(carName(m.otherId)) + ' for P' + m.position;
      else if (m.carId) s += ' · ' + esc(carName(m.carId)) + (m.otherId ? ' & ' + esc(carName(m.otherId)) : '');
      return s;
    }
    tl.addEventListener('pointerdown', function (ev) {
      var m = nearestMarker(ev);
      if (m && m.type !== 'lap') { player.seek(Math.max(0, m.t - 2.5)); if (m.carId) player.followCar(m.carId); refreshButtons(); return; }
      dragging = true; tl.setPointerCapture(ev.pointerId); player.seek(tlTime(ev));
    });
    tl.addEventListener('pointermove', function (ev) {
      var r = tl.getBoundingClientRect(); hoverX = ev.clientX - r.left;
      if (dragging) player.seek(tlTime(ev));
      var m = nearestMarker(ev);
      tip.innerHTML = m ? markerText(m) : fmtTime(tlTime(ev), 1);
      tip.style.left = clamp(hoverX, 60, r.width - 60) + 'px'; tip.classList.add('show');
    });
    tl.addEventListener('pointerup', function () { dragging = false; });
    tl.addEventListener('pointerleave', function () { hoverX = null; tip.classList.remove('show'); });

    /* ---- controls */
    var playBtn = h('button', { class: 'grp-btn big', title: 'Play / pause (Space)' });
    var timeEl = h('div', { class: 'grp-time' });
    function btn(html, title, fn, cls) { var b = h('button', { class: 'grp-btn ' + (cls || ''), html: html, title: title }); b.addEventListener('click', fn); return b; }
    var speedGroup = h('div', { class: 'grp-group' }), camGroup = h('div', { class: 'grp-group' });
    [0.25, 0.5, 1, 2, 4].forEach(function (s) { var b = btn(s === 0.25 ? '¼×' : s === 0.5 ? '½×' : s + '×', 'Speed ' + s + '×', function () { player.speed(s); refreshButtons(); }); b.dataset.speed = s; speedGroup.appendChild(b); });
    player.cameras.filter(function (c) { return c !== 'free'; }).forEach(function (c) { var b = btn(CAMERA_LABELS[c], c + ' camera', function () { player.setCamera(c); refreshButtons(); }); b.dataset.cam = c; camGroup.appendChild(b); });
    var hudBtn = btn('HUD', 'Toggle HUD (H)', function () { player.setHud(); refreshButtons(); });
    var loopBtn = btn(ICONS.loop, 'Loop', function () { looping = !looping; player.setLoop(looping); refreshButtons(); }, 'icon');
    var looping = false;
    var ctl = h('div', { class: 'grp-ctl' },
      btn(ICONS.stepB, 'Previous frame (,)', function () { player.step(-1); }, 'icon'),
      btn(ICONS.back, 'Back 5 s (←)', function () { player.skip(-5); }, 'icon'),
      playBtn,
      btn(ICONS.fwd, 'Forward 5 s (→)', function () { player.skip(5); }, 'icon'),
      btn(ICONS.stepF, 'Next frame (.)', function () { player.step(1); }, 'icon'),
      timeEl, h('div', { class: 'grp-sp' }),
      h('span', { class: 'grp-lbl', text: 'Speed' }), speedGroup,
      h('span', { class: 'grp-lbl', text: 'Camera' }), camGroup, hudBtn, loopBtn);
    playBtn.addEventListener('click', function () { player.toggle(); refreshButtons(); });
    var bottom = h('div', { class: 'grp-bottom' }, tl, tip, ctl);
    root.appendChild(bottom); root.appendChild(flash); root.appendChild(toastEl);

    function refreshButtons() {
      playBtn.innerHTML = player.playing ? ICONS.pause : ICONS.play;
      Array.prototype.forEach.call(speedGroup.children, function (b) { b.classList.toggle('on', Number(b.dataset.speed) === player.speed()); });
      Array.prototype.forEach.call(camGroup.children, function (b) { b.classList.toggle('on', b.dataset.cam === player.camera); });
      hudBtn.classList.toggle('on', player.hudVisible); loopBtn.classList.toggle('on', looping);
      syncHudLayout();
    }
    var hudLayoutOn = null;
    function syncHudLayout(force) {
      var on = !!player.hudVisible, bare = root.classList.contains('hideui');
      var th = Math.round(top.offsetHeight || 62), bh = Math.round(Math.max(0, (bottom.offsetHeight || 168) - 40));
      if (on) { root.style.setProperty('--grp-top-h', th + 'px'); root.style.setProperty('--grp-bot-h', bh + 'px'); }
      // HUD off: the canvas is full-bleed under the chrome, so keep the REPLAY badge / lower third clear of it
      try { player.setOverlayInset(on || bare ? 0 : th, on || bare ? 0 : bh); } catch (e) { /* ignore */ }
      if (on === hudLayoutOn && !force) return;
      hudLayoutOn = on; root.classList.toggle('hud-on', on);
      try { player.resize(); } catch (e) { /* ignore */ }
    }
    function updateTime() {
      var t = player.time, snap = player.lastSnapshot;
      var lap = snap ? (snap.cars.filter(function (c) { return c.isPlayer; })[0] || {}).lap : null;
      timeEl.innerHTML = fmtTime(t, 1) + ' <i>/ ' + fmtTime(dur, 1) + (lap != null && snap.lapsTotal ? ' · Lap ' + Math.min(lap + 1, snap.lapsTotal) + '/' + snap.lapsTotal : '') + '</i>';
    }
    var frameN = 0;
    var offFrame = player.on('frame', function (d) { frameN++; if (frameN % 2 === 0) { drawTimeline(); updateTime(); } if (frameN % 15 === 0) refreshCars(d.snap); });
    ['play', 'pause', 'seek', 'camera', 'follow', 'speed', 'ended'].forEach(function (e) { player.on(e, function () { refreshButtons(); drawTimeline(); updateTime(); }); });

    /* ---- highlights menu */
    var menu = null;
    function closeMenu() { if (menu) { menu.remove(); menu = null; } }
    hlBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (menu) return closeMenu();
      var hs = player.highlights();
      menu = h('div', { class: 'grp-menu' });
      if (!hs.length) menu.appendChild(h('div', { style: { padding: '10px', color: '#ecebe680' }, text: 'No notable moments recorded.' }));
      hs.forEach(function (hl) {
        var st = MARKER_STYLE[hl.type] || {};
        var b = h('button', {}, h('span', { class: 'g', style: { color: st.color }, text: st.glyph || '•' }),
          h('span', { text: (st.label || hl.type) + (hl.carId ? ' — ' + carName(hl.carId) : '') }), h('span', { class: 't', text: fmtClock(hl.t) }));
        b.addEventListener('click', function () { player.seek(Math.max(0, hl.t - 2.5)); if (hl.carId) { player.setCamera('trackside'); player.followCar(hl.carId); } player.play(); closeMenu(); refreshButtons(); });
        menu.appendChild(b);
      });
      var playAll = h('button', {}, h('span', { class: 'g', text: '▶' }), h('span', { text: 'Highlight reel (auto director)' }));
      playAll.addEventListener('click', function () { player.setCamera('director'); player.seek(0); player.play(); closeMenu(); refreshButtons(); });
      menu.insertBefore(playAll, menu.firstChild);
      var r = hlBtn.getBoundingClientRect(), rr = root.getBoundingClientRect();
      menu.style.top = (r.bottom - rr.top + 6) + 'px'; menu.style.right = (rr.right - r.right) + 'px';
      root.appendChild(menu);
    });
    root.addEventListener('click', function (ev) { if (menu && !menu.contains(ev.target)) closeMenu(); });

    /* ---- save / export */
    saveBtn.addEventListener('click', function () {
      var res = store.save(rep, { name: opts.name });
      if (!res.ok) { toast('Replay too large to store'); return; }
      saved = true; saveBtn.classList.add('on'); saveBtn.querySelector('span').textContent = 'Saved';
      rep.meta.id = res.id;
      toast('Replay saved' + (res.degraded.length ? ' (compressed: ' + res.degraded.join(', ') + ')' : '') + (res.evicted.length ? ' · oldest removed' : '') + ' · ' + fmtBytes(res.chars));
      notifyAchievement({ type: 'replay', action: 'saved' });
      if (opts.onSave) { try { opts.onSave(res); } catch (e) { /* ignore */ } }
    });
    exportBtn.addEventListener('click', function () {
      try {
        var ser = serializeEx(rep, { maxChars: 8e6 });
        downloadText('REDLINE-REPLAY:' + ser.data, 'redline-' + slug(inf.trackName) + '-' + new Date().toISOString().slice(0, 10) + '.redlinereplay');
        toast('Exported ' + fmtBytes(ser.chars));
      } catch (e) { toast('Export failed: ' + e.message); }
    });

    /* ---- idle auto-hide */
    var idleT = null;
    function poke() { root.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(function () { if (player.playing && !menu && !photo.active) root.classList.add('idle'); }, 3200); }
    root.addEventListener('pointermove', poke); root.addEventListener('pointerdown', poke);

    /* ---- keyboard */
    function onKey(ev) {
      if (!root.isConnected) return;
      var tag = (ev.target && ev.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (photo.active) { if (photo.onKey(ev)) { ev.preventDefault(); ev.stopImmediatePropagation(); } return; }
      var k = ev.key, handled = true;
      if (k === ' ' || k === 'k') player.toggle();
      else if (k === 'ArrowLeft') player.skip(ev.shiftKey ? -1 : -5);
      else if (k === 'ArrowRight') player.skip(ev.shiftKey ? 1 : 5);
      else if (k === ',') player.step(-1);
      else if (k === '.') player.step(1);
      else if (k === '[' || k === '-') player.speed(prevSpeed(player.speed(), -1));
      else if (k === ']' || k === '=' || k === '+') player.speed(prevSpeed(player.speed(), 1));
      else if (k === 'c' || k === 'C') player.cycleCamera(ev.shiftKey ? -1 : 1);
      else if (k === 'Tab') player.nextCar(ev.shiftKey ? -1 : 1);
      else if (k === 'ArrowUp') player.nextCar(-1);
      else if (k === 'ArrowDown') player.nextCar(1);
      else if (k === 'h' || k === 'H') player.setHud();
      else if (k === 'u' || k === 'U') { root.classList.toggle('hideui'); syncHudLayout(true); }
      else if (k === 'p' || k === 'P') photo.open();
      else if (k === 'Home') player.seek(0);
      else if (k === 'End') player.seek(dur);
      else if (k === 'd' || k === 'D') player.setCamera('director');
      else if (/^[1-9]$/.test(k)) { var snap = player.lastSnapshot; if (snap && snap.order[+k - 1]) player.followCar(snap.order[+k - 1]); }
      else if (k === 'Escape') { if (menu) closeMenu(); else close(); }
      else handled = false;
      if (handled) { ev.preventDefault(); ev.stopImmediatePropagation(); refreshButtons(); poke(); }
    }
    window.addEventListener('keydown', onKey, true);
    function onResize() { syncHudLayout(true); drawTimeline(); if (photo.active) photo.recompose(); }
    window.addEventListener('resize', onResize);

    var photo = createPhotoMode({ root: root, player: player, rep: rep, canvas: canvas, photoCanvas: photoCanvas, guides: guides, flash: flash, toast: toast, info: inf, units: units === 'mph' ? 'mph' : 'kph', onExport: opts.onPhoto });
    photoBtn.addEventListener('click', function () { photo.open(); });
    closeBtn.addEventListener('click', function () { close(); });

    function close() {
      if (!ui.open) return;
      ui.open = false;
      photo.destroy();
      window.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onResize);
      offFrame(); player.destroy(); clearTimeout(idleT);
      root.remove();
      if (!navWasHidden) setNavHidden(false);
      if (activeUI === ui) activeUI = null;
      if (opts.onClose) { try { opts.onClose(); } catch (e) { /* ignore */ } }
    }
    var ui = { open: true, el: root, player: player, replay: rep, close: close, photo: photo, toast: toast, save: function () { saveBtn.click(); } };
    activeUI = ui;
    refreshButtons(); drawTimeline(); updateTime(); poke();
    try { root.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    if (opts.photo) photo.open();
    return ui;
  }
  function prevSpeed(cur, dir) { var L = [0.25, 0.5, 1, 2, 4], i = L.indexOf(cur); if (i < 0) i = 2; return L[clamp(i + dir, 0, L.length - 1)]; }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  /** "Drift · Score attack" / "Grand prix": the launcher's label when it gave one, else the engine mode. */
  function modeText(inf) { return inf && inf.modeLabel ? String(inf.modeLabel) : cap((inf && inf.mode) || 'race'); }
  function carsText(n) { n = n || 0; return n + (n === 1 ? ' car' : ' cars'); }

  /* ================================================================ photo mode */
  /* Pipeline (all canvas compositing, no deps):
       scene (studio free camera via built-in view, or race renderer + post transform)
       -> motion-blur trail (temporal accumulation of sub-frames over a virtual shutter)
       -> tilt-shift (blurred copy masked by a vertical gradient) -> bloom (thresholded low-res glow, additive)
       -> pixel grade (applyPixelFilters: exposure/contrast/sat/WB/fade/B&W/sepia/chroma/sharpen/vignette/grain)
       -> frame overlays (letterbox, borders, polaroid, film strip, broadcast graphics, magazine cover, caption, logo, date)
       -> crop to aspect -> PNG (canvas.toBlob) */

  CSS += '\n' + [
    '.grp-pbar{position:absolute;left:18px;bottom:18px;display:none;gap:8px;z-index:6}',
    '.grp-root.photo .grp-pbar{display:flex}',
    '.grp-root.photo.pp-hidden .grp-pp{display:none}',
    '.grp-pp .seg{display:flex;gap:4px;flex-wrap:wrap;margin:6px 0}.grp-pp .seg button{flex:1;min-width:52px;background:var(--panel,#141519);border:1px solid var(--line,#2b2c33);color:var(--text,#ecebe6);border-radius:var(--radius-xs,6px);padding:6px 4px;font:600 var(--fs-2xs) inherit;font-family:inherit;letter-spacing:.05em;cursor:pointer}',
    '.grp-pp .seg button.on{border-color:var(--accent,#c9a56b);color:var(--accent-ink,#17130b);background:var(--accent,#c9a56b)}',
    '.grp-pp .tline{font:var(--fs-xs) var(--mono,ui-monospace,monospace);color:var(--text-dim,#9b9890);margin:2px 0 6px}',
    '.grp-pp .tools{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}.grp-pp .tools .grp-btn{height:28px;font-size:var(--fs-xs)}',
    '.grp-libtools{display:flex;gap:8px;align-items:center;padding:0 20px 12px;flex-wrap:wrap}',
    '.grp-libtools textarea{flex:1;min-width:240px;height:54px;background:var(--bg,#0b0b0d);color:var(--text,#ecebe6);border:1px solid var(--line,#2b2c33);border-radius:var(--radius-sm,9px);padding:6px;font:var(--fs-xs) var(--mono,ui-monospace,monospace);resize:vertical}',
    '.grp-item input.rn{background:var(--bg,#0b0b0d);color:var(--text,#ecebe6);border:1px solid var(--accent,#c9a56b);border-radius:var(--radius-xs,6px);padding:4px 6px;font:var(--fs-sm) inherit;font-family:inherit;width:100%}'
  ].join('\n');

  var ASPECTS = [['free', 0, 'Screen'], ['16:9', 16 / 9, '16:9'], ['21:9', 21 / 9, '21:9'], ['3:2', 1.5, '3:2'], ['4:3', 4 / 3, '4:3'], ['1:1', 1, '1:1'], ['4:5', 0.8, '4:5'], ['9:16', 9 / 16, '9:16']];
  var FRAME_STYLES = [['none', 'None'], ['thin', 'Hairline'], ['gallery', 'Gallery mat'], ['polaroid', 'Instant'], ['film', 'Film strip'], ['broadcast', 'Broadcast'], ['magazine', 'Cover']];
  var FILTER_SLIDERS = [
    ['Adjust', [['exposure', 'Exposure', -1, 1], ['contrast', 'Contrast', -1, 1], ['saturation', 'Saturation', -1, 1], ['warmth', 'Warmth', -1, 1],
      ['tint', 'Tint', -1, 1], ['fade', 'Fade', 0, 1], ['sharpen', 'Sharpen', 0, 1]]],
    ['Effects', [['motionBlur', 'Motion blur', 0, 1], ['tiltShift', 'Tilt-shift', 0, 1], ['bloom', 'Bloom', 0, 1], ['vignette', 'Vignette', 0, 1],
      ['vignetteSoft', 'Vign. soft', 0.05, 1], ['grain', 'Film grain', 0, 1], ['chroma', 'Chromatic', 0, 1], ['bw', 'B & W', 0, 1], ['sepia', 'Sepia', 0, 1]]]
  ];

  var _filterOK = null;
  function ctxFilterOK() {
    if (_filterOK !== null) return _filterOK;
    try { var c = document.createElement('canvas').getContext('2d'); c.filter = 'blur(2px)'; _filterOK = c.filter === 'blur(2px)'; } catch (e) { _filterOK = false; }
    return _filterOK;
  }
  function mkCanvas(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
  function blurCanvas(src, radius) {
    var w = src.width, h = src.height, out = mkCanvas(w, h), c = out.getContext('2d');
    c.drawImage(src, 0, 0);                       // un-blurred underlay hides transparent edge bleed
    if (radius <= 0.3) return out;
    if (ctxFilterOK()) { c.filter = 'blur(' + radius.toFixed(2) + 'px)'; c.drawImage(src, 0, 0); c.filter = 'none'; return out; }
    var k = clamp(Math.round(radius / 1.4), 2, 24), tmp = mkCanvas(w / k, h / k), tc = tmp.getContext('2d');
    tc.imageSmoothingEnabled = true; tc.drawImage(src, 0, 0, tmp.width, tmp.height);
    var tmp2 = mkCanvas(tmp.width, tmp.height), t2 = tmp2.getContext('2d');
    t2.drawImage(tmp, 0, 0); t2.globalAlpha = 0.5; t2.drawImage(tmp, 1, 0); t2.drawImage(tmp, -1, 0); t2.drawImage(tmp, 0, 1); t2.drawImage(tmp, 0, -1);
    c.imageSmoothingEnabled = true; c.drawImage(tmp2, 0, 0, w, h);
    return out;
  }
  /* largest centered rect of aspect a inside w×h (a = 0 -> full) */
  function cropRect(w, h, a) {
    if (!a) return { x: 0, y: 0, w: w, h: h };
    var cw = w, ch = w / a; if (ch > h) { ch = h; cw = h * a; }
    return { x: Math.round((w - cw) / 2), y: Math.round((h - ch) / 2), w: Math.round(cw), h: Math.round(ch) };
  }
  /* screen delta (CSS px, relative) -> world delta for the built-in view transform R(rot)·diag(z,-z) */
  function screenToWorld(dx, dy, zoom, rot) {
    var c = Math.cos(rot), s = Math.sin(rot);
    var ux = dx * c + dy * s, uy = -dx * s + dy * c;
    return { x: ux / zoom, y: -uy / zoom };
  }
  function worldToScreen(wx, wy, cam, W, H) {
    var dx = (wx - cam.x) * cam.zoom, dy = -(wy - cam.y) * cam.zoom, c = Math.cos(cam.rot), s = Math.sin(cam.rot);
    return { x: W / 2 + dx * c - dy * s, y: H / 2 + dx * s + dy * c };
  }
  function prefUnits() { try { return CB.game.profile.get().settings.units === 'mph' ? 'mph' : 'kph'; } catch (e) { return 'kph'; } }

  function createPhotoMode(c) {
    var root = c.root, player = c.player, rep = c.rep, canvas = c.canvas, pc = c.photoCanvas, guides = c.guides, inf = c.info || info(rep);
    var M = rep.meta || {}, hz = num(M.hz, 30), units = c.units || prefUnits();
    var P = {
      view: player.is3D ? 'free3d' : player.builtin ? 'studio' : 'race', extCam: 'chase', T0: 0, off: 0, focus: null,
      f3: defaultFree3d(null),
      cam: { x: 0, y: 0, zoom: 8, rot: 0 }, lock: true, lockOff: { x: 0, y: 0 },
      post: { zoom: 1, rot: 0, panX: 0, panY: 0 },
      f: filterParams({}), preset: 'none', aspect: 'free', frame: 'none', letterbox: false, info: false, logo: true, date: false,
      tags: false, ring: false, hud: false, guides: true, caption: '', tiltPos: 0.55
    };
    var S = { active: false, raf: 0, dirty: true, lastCompose: 0, interacting: 0, wasPlaying: false, savedCam: null, savedFollow: null,
      studio: null, lastSnap: null, lastCamUsed: null, drag: null, panel: null, outputs: {}, exportCount: 0, busy: false };

    function T() { return clamp(P.T0 + P.off, 0, player.duration); }
    function base() { return Math.min(canvas.clientWidth || 800, canvas.clientHeight || 450) / 760; }
    function studio() {
      if (S.studio) return S.studio;
      if (player.builtin && player.renderer && player.renderer.__replayView) S.studio = player.renderer;
      else S.studio = createView(canvas, player.geom, player.trackDef, { timeOfDay: M.timeOfDay, weather: M.weather, theme: M.theme });
      return S.studio;
    }
    function useStudio() { return P.view === 'studio'; }
    function useFree3d() { return P.view === 'free3d' && player.is3D; }
    /* the WebGL layer under the 2D canvas, when the last scene render drew 3D into it */
    function sceneGL() { return !useStudio() && player.is3D && player.glCanvas && player.mode3d !== 'map' ? player.glCanvas : null; }
    /* copy the composited scene (3D layer + 2D HUD/overlay canvas) — call synchronously right after a render so the
       WebGL drawing buffer (preserveDrawingBuffer: false) is still valid */
    function drawScene(oc, w, hh) { var gc = sceneGL(); if (gc) oc.drawImage(gc, 0, 0, w, hh); oc.drawImage(canvas, 0, 0, w, hh); }
    function poseFor(id) {
      var pz = player.pose3d, snap = snapshotAt(rep, T(), { followId: id }), car = carIn(snap, id);
      return car ? { x: car.x, y: car.y, heading: car.heading, elev: pz ? num(pz.elev, 0) : 0 } : pz;
    }
    function setLock3d(on) {
      var F = P.f3, pz = poseFor(P.focus); on = !!on;
      if (on === !!F.lock || !pz) { F.lock = on; return; }
      if (on) { F.ox -= pz.x; F.oy -= pz.y; } else { F.ox += pz.x; F.oy += pz.y; }
      F.lock = on;
    }
    function carIn(snap, id) { return snap.cars.filter(function (x) { return x.id === id; })[0] || null; }
    function camAt(snap) {
      var car = carIn(snap, P.focus), cam = { x: P.cam.x, y: P.cam.y, zoom: P.cam.zoom, rot: P.cam.rot };
      if (P.lock && car) { cam.x = car.x + P.lockOff.x; cam.y = car.y + P.lockOff.y; }
      return cam;
    }
    function relock() {
      var snap = snapshotAt(rep, T(), { followId: P.focus }), car = carIn(snap, P.focus);
      if (car) { P.lockOff.x = P.cam.x - car.x; P.lockOff.y = P.cam.y - car.y; }
    }
    function syncCamFromLock() {
      if (!P.lock) return;
      var snap = snapshotAt(rep, T(), { followId: P.focus }), car = carIn(snap, P.focus);
      if (car) { P.cam.x = car.x + P.lockOff.x; P.cam.y = car.y + P.lockOff.y; }
    }

    /* render one scene frame into the main canvas at time tt */
    function sceneAt(tt, sub) {
      if (useStudio()) {
        var snap = snapshotAt(rep, tt, { followId: P.focus, events: [] });
        var cam = camAt(snap);
        var drawSnap = P.ring ? snap : Object.assign({}, snap, { cars: snap.cars.map(function (x) { return Object.assign({}, x, { isPlayer: false }); }) });
        studio().render(drawSnap, cam, { noEffects: !!sub });
        var ctx = canvas.getContext('2d'), dpr = canvas.width / Math.max(1, canvas.clientWidth || canvas.width), W = canvas.clientWidth || canvas.width, H = canvas.clientHeight || canvas.height;
        ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (P.tags && !sub) drawTags(ctx, snap, cam, W, H);
        if (P.hud && player.hud && typeof player.hud.draw === 'function') { try { player.hud.draw(ctx, snap); } catch (e) { /* ignore */ } }
        ctx.restore();
        if (!sub) { S.lastSnap = snap; S.lastCamUsed = cam; }
        return snap;
      }
      if (useFree3d()) {
        var s3 = player.renderAt(tt, { camera: 'free', free3d: P.f3, noOverlay: true, noHud: !P.hud });
        if (P.tags && !sub && s3 && canvas) {
          var cs = player.cameraState3d(), c2 = canvas.getContext('2d'), dp = canvas.width / Math.max(1, canvas.clientWidth || canvas.width);
          if (cs) { c2.save(); c2.setTransform(dp, 0, 0, dp, 0, 0); drawTags3d(c2, s3, cs, canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height); c2.restore(); }
        }
        if (!sub) S.lastSnap = s3;
        return s3;
      }
      var s2 = player.renderAt(tt, { camera: P.extCam, noOverlay: true, noHud: !P.hud, post: player.is3D ? null : { zoom: P.post.zoom, rot: P.post.rot, panX: P.post.panX, panY: P.post.panY } });
      if (!sub) S.lastSnap = s2;
      return s2;
    }
    function drawTags3d(ctx, snap, cam, W, H) {
      var el = player.pose3d ? num(player.pose3d.elev, 0) : 0;
      ctx.font = '700 11px "Helvetica Neue", system-ui, sans-serif'; ctx.textBaseline = 'middle';
      snap.cars.forEach(function (car) {
        var p = project3d(cam, [car.x, el + 1.9, -car.y], W, H); if (!p || p.z > 250 || p.x < -40 || p.y < -40 || p.x > W + 40 || p.y > H + 40) return;
        var txt = 'P' + car.position + '  ' + car.name, tw = ctx.measureText(txt).width + 16, y = p.y - 16;
        ctx.fillStyle = 'rgba(10,10,12,0.78)'; roundRect(ctx, p.x - tw / 2, y - 11, tw, 20, 4); ctx.fill();
        ctx.fillStyle = car.color || '#c9a56b'; ctx.fillRect(p.x - tw / 2, y - 11, 3, 20);
        ctx.fillStyle = '#ecebe6'; ctx.textAlign = 'center'; ctx.fillText(txt, p.x + 1, y - 0.5);
        ctx.strokeStyle = 'rgba(243,239,230,0.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, y + 9); ctx.lineTo(p.x, p.y); ctx.stroke();
      });
      ctx.textAlign = 'left';
    }
    function drawTags(ctx, snap, cam, W, H) {
      ctx.font = '700 11px "Helvetica Neue", system-ui, sans-serif'; ctx.textBaseline = 'middle';
      snap.cars.forEach(function (car) {
        var p = worldToScreen(car.x, car.y, cam, W, H); if (p.x < -40 || p.y < -40 || p.x > W + 40 || p.y > H + 40) return;
        var txt = 'P' + car.position + '  ' + car.name, tw = ctx.measureText(txt).width + 16, y = p.y - 6 - num(car.length_m, 4.5) * cam.zoom * 0.6;
        ctx.fillStyle = 'rgba(10,10,12,0.78)'; roundRect(ctx, p.x - tw / 2, y - 11, tw, 20, 4); ctx.fill();
        ctx.fillStyle = car.color || '#c9a56b'; ctx.fillRect(p.x - tw / 2, y - 11, 3, 20);
        ctx.fillStyle = '#ecebe6'; ctx.textAlign = 'center'; ctx.fillText(txt, p.x + 1, y - 0.5);
        ctx.strokeStyle = 'rgba(243,239,230,0.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, y + 9); ctx.lineTo(p.x, p.y - 4); ctx.stroke();
      });
      ctx.textAlign = 'left';
    }

    /* full pipeline at a given output scale (fraction of the main canvas device resolution) */
    function compose(scale, final) {
      var W0 = canvas.width, H0 = canvas.height, w = Math.max(1, Math.round(W0 * scale)), hgt = Math.max(1, Math.round(H0 * scale));
      var out = mkCanvas(w, hgt), oc = out.getContext('2d'), f = P.f, t = T();
      // 1. motion blur trail: average sub-frames over the shutter, then re-stamp the sharp current frame
      var N = f.motionBlur > 0.01 ? 2 + Math.round(f.motionBlur * (final ? 18 : (S.interacting ? 4 : 9))) : 1, shutter = f.motionBlur * 0.24;
      if (N > 1) {
        for (var k = 0; k < N; k++) {
          var tt = clamp(t - shutter * (1 - k / (N - 1)), 0, player.duration);
          sceneAt(tt, k < N - 1);
          oc.globalAlpha = 1 / (k + 1); drawScene(oc, w, hgt);
        }
        oc.globalAlpha = 0.3; drawScene(oc, w, hgt); oc.globalAlpha = 1;
      } else { sceneAt(t, false); drawScene(oc, w, hgt); }
      var cr = cropRect(w, hgt, aspectValue());
      var px = w / Math.max(1, canvas.clientWidth || W0);          // output px per CSS px
      // 2. tilt-shift
      if (f.tiltShift > 0.01) {
        var bl = blurCanvas(out, (1.5 + f.tiltShift * 9) * px), m = mkCanvas(w, hgt), mc = m.getContext('2d');
        mc.drawImage(bl, 0, 0); mc.globalCompositeOperation = 'destination-in';
        var cpos = clamp(P.tiltPos, 0.1, 0.9), band = 0.05 + (1 - f.tiltShift) * 0.16, ramp = 0.18;
        var g = mc.createLinearGradient(0, cr.y, 0, cr.y + cr.h);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(clamp(cpos - band - ramp, 0.001, 0.998), 'rgba(0,0,0,1)'); g.addColorStop(clamp(cpos - band, 0.002, 0.998), 'rgba(0,0,0,0)');
        g.addColorStop(clamp(cpos + band, 0.003, 0.999), 'rgba(0,0,0,0)'); g.addColorStop(clamp(cpos + band + ramp, 0.004, 0.999), 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,1)');
        mc.fillStyle = g; mc.fillRect(0, 0, w, hgt); oc.drawImage(m, 0, 0);
      }
      // 3. bloom
      if (f.bloom > 0.01) {
        var sm = mkCanvas(w / 4, hgt / 4), sc = sm.getContext('2d'); sc.drawImage(out, 0, 0, sm.width, sm.height);
        try {
          var id = sc.getImageData(0, 0, sm.width, sm.height), d = id.data;
          for (var i = 0; i < d.length; i += 4) {
            var l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255, kk = clamp((l - 0.6) / 0.4, 0, 1); kk *= kk;
            d[i] *= kk; d[i + 1] *= kk; d[i + 2] *= kk;
          }
          sc.putImageData(id, 0, 0);
          var glow = blurCanvas(sm, 2 + f.bloom * 4);
          oc.save(); oc.globalCompositeOperation = 'lighter'; oc.globalAlpha = clamp(f.bloom, 0, 1) * 0.95; oc.imageSmoothingEnabled = true; oc.drawImage(glow, 0, 0, w, hgt); oc.restore();
        } catch (e) { /* tainted or unsupported: skip bloom */ }
      }
      // 4. pixel grade
      if (!isIdentityPixel(f)) {
        try { var img = oc.getImageData(0, 0, w, hgt); applyPixelFilters(img, Object.assign({}, f, { seed: final ? (Date.now() & 0xffff) : f.seed })); oc.putImageData(img, 0, 0); }
        catch (e2) { /* ignore */ }
      }
      // 5. overlays
      drawOverlays(oc, cr, px, S.lastSnap);
      return { canvas: out, crop: cr };
    }
    function aspectValue() {
      var a = ASPECTS.filter(function (x) { return x[0] === P.aspect; })[0];
      return a ? a[1] : 0;
    }

    function focusCar(snap) { return snap ? (carIn(snap, P.focus) || snap.cars.filter(function (x) { return x.isPlayer; })[0] || snap.cars[0] || null) : null; }
    function spd(car) { var v = num(car && car.speed, 0) * 3.6; return units === 'mph' ? Math.round(v / 1.609344) + ' mph' : Math.round(v) + ' km/h'; }
    function drawOverlays(o, cr, px, snap) {
      var u = Math.min(cr.w, cr.h) / 100, car = focusCar(snap), sans = '"Helvetica Neue", Helvetica, system-ui, sans-serif';
      o.save();
      o.beginPath(); o.rect(cr.x, cr.y, cr.w, cr.h); o.clip();
      if (P.letterbox) { var bh = Math.max(0, (cr.h - cr.w / 2.39) / 2); o.fillStyle = '#000'; o.fillRect(cr.x, cr.y, cr.w, bh); o.fillRect(cr.x, cr.y + cr.h - bh, cr.w, bh); }
      var fr = P.frame, inner = { x: cr.x, y: cr.y, w: cr.w, h: cr.h };
      if (fr === 'thin') {
        o.strokeStyle = 'rgba(255,255,255,0.85)'; o.lineWidth = Math.max(1, 0.25 * u); o.strokeRect(cr.x + 3 * u, cr.y + 3 * u, cr.w - 6 * u, cr.h - 6 * u);
        inner = { x: cr.x + 3 * u, y: cr.y + 3 * u, w: cr.w - 6 * u, h: cr.h - 6 * u };
      } else if (fr === 'gallery') {
        var b = 7 * u; o.fillStyle = '#f2eee6';
        o.fillRect(cr.x, cr.y, cr.w, b); o.fillRect(cr.x, cr.y + cr.h - b * 1.25, cr.w, b * 1.25); o.fillRect(cr.x, cr.y, b, cr.h); o.fillRect(cr.x + cr.w - b, cr.y, b, cr.h);
        o.strokeStyle = 'rgba(0,0,0,0.35)'; o.lineWidth = Math.max(1, 0.18 * u); o.strokeRect(cr.x + b, cr.y + b, cr.w - 2 * b, cr.h - b * 2.25);
        o.fillStyle = '#5b554a'; o.font = '500 ' + (1.9 * u) + 'px Georgia, "Times New Roman", serif'; o.textAlign = 'center'; o.textBaseline = 'middle';
        o.fillText(P.caption || (inf.trackName + (car ? ' — ' + car.name : '')), cr.x + cr.w / 2, cr.y + cr.h - b * 0.62);
        inner = { x: cr.x + b, y: cr.y + b, w: cr.w - 2 * b, h: cr.h - b * 2.25 };
      } else if (fr === 'polaroid') {
        var sd = 4.5 * u, bt = 17 * u; o.fillStyle = '#fbfaf6';
        o.fillRect(cr.x, cr.y, cr.w, sd); o.fillRect(cr.x, cr.y + cr.h - bt, cr.w, bt); o.fillRect(cr.x, cr.y, sd, cr.h); o.fillRect(cr.x + cr.w - sd, cr.y, sd, cr.h);
        o.fillStyle = '#2b2f3a'; o.font = 'italic 600 ' + (4.2 * u) + 'px "Marker Felt","Bradley Hand","Segoe Print","Comic Sans MS",cursive'; o.textAlign = 'left'; o.textBaseline = 'middle';
        o.fillText(P.caption || ((car ? car.name + ' · ' : '') + inf.trackName), cr.x + sd + 2 * u, cr.y + cr.h - bt / 2);
        o.font = '500 ' + (2 * u) + 'px ' + sans; o.fillStyle = '#8a8578'; o.textAlign = 'right';
        o.fillText(new Date(inf.createdAt || Date.now()).toLocaleDateString(), cr.x + cr.w - sd - 2 * u, cr.y + cr.h - bt / 2);
        inner = { x: cr.x + sd, y: cr.y + sd, w: cr.w - 2 * sd, h: cr.h - sd - bt };
      } else if (fr === 'film') {
        var fb = 8 * u; o.fillStyle = '#0b0a09'; o.fillRect(cr.x, cr.y, cr.w, fb); o.fillRect(cr.x, cr.y + cr.h - fb, cr.w, fb);
        var hw = 2.6 * u, hh = 3.4 * u, gap = 6.2 * u;
        o.fillStyle = '#d9d2c3';
        for (var x = cr.x + gap / 2; x < cr.x + cr.w; x += gap) { roundRect(o, x, cr.y + (fb - hh) / 2, hw, hh, 0.5 * u); o.fill(); roundRect(o, x, cr.y + cr.h - (fb + hh) / 2, hw, hh, 0.5 * u); o.fill(); }
        o.fillStyle = '#f2a541'; o.font = '700 ' + (1.6 * u) + 'px ui-monospace, Menlo, monospace'; o.textBaseline = 'middle'; o.textAlign = 'left';
        var fn = 1 + (S.exportCount % 36);
        o.fillText('REDLINE 400  ' + fn + '  ▸  ' + fn + 'A', cr.x + 2 * u, cr.y + cr.h - fb - 1.6 * u);
        o.textAlign = 'right'; o.fillText('SAFETY FILM  ' + (inf.trackName || '').toUpperCase(), cr.x + cr.w - 2 * u, cr.y + fb + 1.8 * u);
        inner = { x: cr.x, y: cr.y + fb, w: cr.w, h: cr.h - 2 * fb };
      } else if (fr === 'broadcast') {
        drawBroadcast(o, cr, u, car, snap, sans);
      } else if (fr === 'magazine') {
        o.fillStyle = 'rgba(0,0,0,0.25)'; var gtop = o.createLinearGradient(0, cr.y, 0, cr.y + cr.h * 0.3); gtop.addColorStop(0, 'rgba(0,0,0,0.55)'); gtop.addColorStop(1, 'rgba(0,0,0,0)');
        o.fillStyle = gtop; o.fillRect(cr.x, cr.y, cr.w, cr.h * 0.3);
        o.fillStyle = '#ecebe6'; o.textAlign = 'center'; o.textBaseline = 'top';
        o.font = '700 ' + (16 * u) + 'px "Didot","Bodoni 72",Georgia,"Times New Roman",serif'; o.fillText('REDLINE', cr.x + cr.w / 2, cr.y + 3 * u);
        o.font = '600 ' + (1.8 * u) + 'px ' + sans; o.fillStyle = '#c9a56b';
        o.fillText(('Issue ' + (1 + (hashStr(String(M.id || '')) % 98)) + ' · ' + new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })).toUpperCase(), cr.x + cr.w / 2, cr.y + 20.5 * u);
        var gb = o.createLinearGradient(0, cr.y + cr.h * 0.62, 0, cr.y + cr.h); gb.addColorStop(0, 'rgba(0,0,0,0)'); gb.addColorStop(1, 'rgba(0,0,0,0.7)');
        o.fillStyle = gb; o.fillRect(cr.x, cr.y + cr.h * 0.62, cr.w, cr.h * 0.38);
        o.textAlign = 'left'; o.textBaseline = 'alphabetic'; o.fillStyle = '#ecebe6';
        o.font = '700 ' + (5.2 * u) + 'px Georgia, "Times New Roman", serif';
        o.fillText(P.caption || (car ? car.name + ' at ' + inf.trackName : inf.trackName), cr.x + 5 * u, cr.y + cr.h - 9 * u);
        o.font = '500 ' + (2.1 * u) + 'px ' + sans; o.fillStyle = '#ecebe6c0';
        o.fillText(car ? ('P' + car.position + ' · ' + spd(car) + ' · ' + (car.team || 'Privateer') + ' · #' + car.number) : '', cr.x + 5 * u, cr.y + cr.h - 5 * u);
      }
      if (P.info && car && fr !== 'broadcast') {
        var bw = 30 * u, bx = inner.x + 3 * u, by = inner.y + inner.h - 13 * u;
        o.fillStyle = 'rgba(10,10,12,0.72)'; roundRect(o, bx, by, bw, 10 * u, 0.8 * u); o.fill();
        o.fillStyle = car.color || '#c9a56b'; o.fillRect(bx, by, 0.8 * u, 10 * u);
        o.textAlign = 'left'; o.textBaseline = 'alphabetic'; o.fillStyle = '#ecebe6';
        o.font = '800 ' + (3.6 * u) + 'px ' + sans; o.fillText('P' + (car.position || '-'), bx + 2.6 * u, by + 6.4 * u);
        o.font = '700 ' + (2.1 * u) + 'px ' + sans; o.fillText(String(car.name || '').slice(0, 22), bx + 10 * u, by + 4.2 * u);
        o.font = '500 ' + (1.6 * u) + 'px ' + sans; o.fillStyle = 'rgba(243,239,230,0.7)';
        o.fillText(spd(car) + ' · L' + Math.min((car.lap || 0) + 1, (snap && snap.lapsTotal) || 99) + ' · ' + fmtTime(car.currentLap_s, 1), bx + 10 * u, by + 7.4 * u);
      }
      if (P.logo) {
        o.textAlign = 'right'; o.textBaseline = 'alphabetic'; o.fillStyle = 'rgba(243,239,230,0.78)';
        o.font = '800 ' + (2.6 * u) + 'px ' + sans; var lx = inner.x + inner.w - 3 * u, ly = inner.y + inner.h - 3 * u;
        if (fr === 'magazine') { ly = inner.y + 26 * u; }
        o.fillText('REDLINE', lx, ly); var lw = o.measureText('REDLINE').width;
        o.fillStyle = '#e0412f'; o.fillRect(lx - lw, ly + 0.6 * u, lw, 0.35 * u);
        o.font = '500 ' + (1.2 * u) + 'px ' + sans; o.fillStyle = 'rgba(243,239,230,0.6)'; o.fillText('PHOTO MODE', lx, ly + 2.4 * u);
      }
      if (P.date) {
        var d = new Date(inf.createdAt || Date.now()), pad = function (v) { return (v < 10 ? '0' : '') + v; };
        var ds = "'" + String(d.getFullYear()).slice(2) + ' ' + pad(d.getMonth() + 1) + ' ' + pad(d.getDate());
        o.textAlign = 'right'; o.textBaseline = 'alphabetic'; o.font = '700 ' + (3 * u) + 'px "DS-Digital", ui-monospace, Menlo, monospace';
        o.shadowColor = 'rgba(255,120,40,0.85)'; o.shadowBlur = 1.4 * u; o.fillStyle = '#ff8a3d';
        o.fillText(ds, inner.x + inner.w - 3 * u, inner.y + inner.h - (P.logo ? 8.5 : 3) * u); o.shadowBlur = 0;
      }
      if (P.caption && (fr === 'none' || fr === 'thin' || fr === 'film')) {
        o.textAlign = 'center'; o.textBaseline = 'alphabetic'; o.font = '600 ' + (2.6 * u) + 'px ' + sans;
        o.fillStyle = 'rgba(0,0,0,0.5)'; o.fillText(P.caption, inner.x + inner.w / 2 + 0.15 * u, inner.y + 6.2 * u + 0.15 * u);
        o.fillStyle = '#ecebe6'; o.fillText(P.caption, inner.x + inner.w / 2, inner.y + 6.2 * u);
      }
      o.restore();
    }
    function drawBroadcast(o, cr, u, car, snap, sans) {
      // live timing tower (top-left)
      var order = snap ? snap.order.slice(0, 6) : [], rowH = 3.2 * u, tx = cr.x + 3 * u, ty = cr.y + 3 * u, tw = 24 * u;
      o.fillStyle = 'rgba(10,10,12,0.85)'; o.fillRect(tx, ty, tw, rowH * 1.2);
      o.fillStyle = '#c9a56b'; o.fillRect(tx, ty + rowH * 1.2 - 0.3 * u, tw, 0.3 * u);
      o.fillStyle = '#ecebe6'; o.font = '800 ' + (1.6 * u) + 'px ' + sans; o.textBaseline = 'middle'; o.textAlign = 'left';
      o.fillText('LAP ' + Math.min(((car && car.lap) || 0) + 1, (snap && snap.lapsTotal) || 99) + ' / ' + ((snap && snap.lapsTotal) || '-'), tx + 1.5 * u, ty + rowH * 0.6);
      order.forEach(function (id, i) {
        var c2 = carIn(snap, id); if (!c2) return;
        var y = ty + rowH * 1.2 + i * rowH;
        o.fillStyle = id === (car && car.id) ? 'rgba(200,169,106,0.92)' : 'rgba(10,10,12,0.72)'; o.fillRect(tx, y, tw, rowH - 0.2 * u);
        o.fillStyle = c2.color || '#888'; o.fillRect(tx + 4 * u, y + 0.5 * u, 0.5 * u, rowH - 1.2 * u);
        o.fillStyle = id === (car && car.id) ? '#111' : '#ecebe6'; o.font = '700 ' + (1.5 * u) + 'px ' + sans;
        o.fillText(String(i + 1), tx + 1.4 * u, y + rowH / 2); o.fillText(String(c2.name || '').split(' ').pop().slice(0, 10).toUpperCase(), tx + 5.4 * u, y + rowH / 2);
        o.textAlign = 'right'; o.font = '500 ' + (1.3 * u) + 'px ui-monospace, monospace';
        o.fillText(i === 0 ? 'LEADER' : isNum(c2.gapLeader_s) ? '+' + c2.gapLeader_s.toFixed(1) : '', tx + tw - 1.2 * u, y + rowH / 2); o.textAlign = 'left';
      });
      // REPLAY bug
      o.fillStyle = 'rgba(10,10,12,0.8)'; roundRect(o, cr.x + cr.w - 17 * u, cr.y + 3 * u, 14 * u, 4 * u, 0.6 * u); o.fill();
      o.fillStyle = '#e5533d'; o.beginPath(); o.arc(cr.x + cr.w - 14.8 * u, cr.y + 5 * u, 0.8 * u, 0, TAU); o.fill();
      o.fillStyle = '#ecebe6'; o.font = '800 ' + (1.7 * u) + 'px ' + sans; o.fillText('REPLAY', cr.x + cr.w - 13 * u, cr.y + 5.1 * u);
      // lower third
      if (car) {
        var lx = cr.x + 6 * u, ly = cr.y + cr.h - 15 * u, lw = Math.min(56 * u, cr.w - 12 * u);
        o.fillStyle = 'rgba(10,10,12,0.86)'; o.fillRect(lx, ly, lw, 8 * u);
        o.fillStyle = car.color || '#c9a56b'; o.fillRect(lx, ly, 1 * u, 8 * u);
        o.fillStyle = '#c9a56b'; o.fillRect(lx, ly + 8 * u, lw * 0.6, 0.5 * u);
        o.fillStyle = '#ecebe6'; o.font = '800 ' + (4 * u) + 'px ' + sans; o.fillText('P' + (car.position || '-'), lx + 3 * u, ly + 4.2 * u);
        o.font = '800 ' + (2.3 * u) + 'px ' + sans; o.fillText(String(car.name || '').toUpperCase(), lx + 13 * u, ly + 3 * u);
        o.font = '500 ' + (1.6 * u) + 'px ' + sans; o.fillStyle = 'rgba(243,239,230,0.72)';
        o.fillText((car.team || 'Privateer') + '  ·  #' + car.number + '  ·  ' + spd(car) + '  ·  ' + inf.trackName, lx + 13 * u, ly + 5.8 * u);
      }
    }

    /* ---- preview: compose at reduced resolution into the photo canvas; guides on top */
    function previewScale() { var lim = S.interacting ? 760 : 1400; return Math.min(1, lim / Math.max(1, canvas.width)); }
    function refresh() {
      if (!S.active) return;
      var res = compose(previewScale(), false);
      if (pc.width !== res.canvas.width || pc.height !== res.canvas.height) { pc.width = res.canvas.width; pc.height = res.canvas.height; }
      var g = pc.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(res.canvas, 0, 0);
      drawGuides();
      S.dirty = false; S.lastCompose = now();
      updateReadouts();
    }
    function drawGuides() {
      var f = fitCanvas(guides), g = f.ctx, W = f.w, H = f.h;
      g.setTransform(f.dpr, 0, 0, f.dpr, 0, 0); g.clearRect(0, 0, W, H);
      var cr = cropRect(W, H, aspectValue());
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(0, 0, W, cr.y); g.fillRect(0, cr.y + cr.h, W, H - cr.y - cr.h); g.fillRect(0, cr.y, cr.x, cr.h); g.fillRect(cr.x + cr.w, cr.y, W - cr.x - cr.w, cr.h);
      if (!P.guides) return;
      g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 1; g.beginPath();
      for (var i = 1; i < 3; i++) { g.moveTo(cr.x + cr.w * i / 3, cr.y); g.lineTo(cr.x + cr.w * i / 3, cr.y + cr.h); g.moveTo(cr.x, cr.y + cr.h * i / 3); g.lineTo(cr.x + cr.w, cr.y + cr.h * i / 3); }
      g.stroke();
      g.strokeStyle = 'rgba(200,169,106,0.8)'; g.lineWidth = 1.5;
      var L = 16; [[cr.x, cr.y, 1, 1], [cr.x + cr.w, cr.y, -1, 1], [cr.x, cr.y + cr.h, 1, -1], [cr.x + cr.w, cr.y + cr.h, -1, -1]].forEach(function (k) {
        g.beginPath(); g.moveTo(k[0] + k[2] * L, k[1]); g.lineTo(k[0], k[1]); g.lineTo(k[0], k[1] + k[3] * L); g.stroke();
      });
      if (P.f.tiltShift > 0.01) {
        var y = cr.y + cr.h * P.tiltPos; g.setLineDash([6, 6]); g.strokeStyle = 'rgba(200,169,106,0.55)';
        g.beginPath(); g.moveTo(cr.x, y); g.lineTo(cr.x + cr.w, y); g.stroke(); g.setLineDash([]);
      }
    }
    function loop() {
      if (!S.active) return;
      if (S.interacting && now() - S.interacting > 220) { S.interacting = 0; S.dirty = true; }
      if (S.dirty && now() - S.lastCompose > (S.interacting ? 30 : 60)) refresh();
      S.raf = requestAnimationFrame(loop);
    }
    function dirty(interactive) { S.dirty = true; if (interactive) S.interacting = now(); }

    /* ---- free camera input */
    function onDown(ev) {
      if (!S.active) return;
      pc.setPointerCapture && pc.setPointerCapture(ev.pointerId);
      S.drag = { x: ev.clientX, y: ev.clientY, rotate: ev.button === 2 || ev.shiftKey || ev.altKey };
      pc.classList.add('grab'); ev.preventDefault();
    }
    function onMove(ev) {
      var d = S.drag; if (!d) return;
      var dx = ev.clientX - d.x, dy = ev.clientY - d.y; d.x = ev.clientX; d.y = ev.clientY;
      var orb = player.is3D && !useStudio();   // 3D: drag orbits (yaw + tilt) around the target
      if (d.rotate) rotateBy((orb ? -dx : dx) * 0.006, orb ? dy * 0.004 : 0);
      else panBy(dx, dy);
      dirty(true);
    }
    function onUp() { S.drag = null; pc.classList.remove('grab'); dirty(false); }
    /* 3D broadcast view: any pan / zoom / rotate gesture hands over to the free camera, starting from the shot on screen */
    function toFree3d() {
      if (!player.is3D || P.view !== 'race') return;
      P.f3 = seedFree3d(player.cameraState3d(), poseFor(P.focus), true);
      setView('free3d');
    }
    function panBy(dx, dy) {
      toFree3d();
      if (useFree3d()) { panFree3d(P.f3, dx, dy, canvas.clientHeight || 450); return; }
      if (useStudio()) {
        var w = screenToWorld(dx, dy, P.cam.zoom, P.cam.rot);
        P.cam.x -= w.x; P.cam.y -= w.y; P.lockOff.x -= w.x; P.lockOff.y -= w.y;
      } else {
        var lim = function (k, sz) { return (k - 1) * sz / 2; };
        P.post.panX = clamp(P.post.panX + dx, -lim(P.post.zoom, canvas.clientWidth || 800) - 1, lim(P.post.zoom, canvas.clientWidth || 800) + 1);
        P.post.panY = clamp(P.post.panY + dy, -lim(P.post.zoom, canvas.clientHeight || 450) - 1, lim(P.post.zoom, canvas.clientHeight || 450) + 1);
      }
    }
    function rotateBy(a, b) {
      toFree3d();
      if (useFree3d()) { P.f3.yaw = wrapAngle(P.f3.yaw + a); if (b) P.f3.pitch = clamp(P.f3.pitch + b, -0.3, 1.5); return; }
      if (useStudio()) P.cam.rot = wrapAngle(P.cam.rot + a); else P.post.rot = wrapAngle(P.post.rot + a);
    }
    function zoomBy(f, cx, cy) {
      toFree3d();
      if (useFree3d()) { P.f3.dist = clamp(P.f3.dist / f, 1.2, 600); return; }
      if (useStudio()) {
        var W = canvas.clientWidth || 800, H = canvas.clientHeight || 450, z0 = P.cam.zoom, z1 = clamp(z0 * f, 0.15 * base(), 60 * base());
        if (cx != null) {
          var rx = cx - W / 2, ry = cy - H / 2, a = screenToWorld(rx, ry, z0, P.cam.rot), b = screenToWorld(rx, ry, z1, P.cam.rot);
          P.cam.x += a.x - b.x; P.cam.y += a.y - b.y; P.lockOff.x += a.x - b.x; P.lockOff.y += a.y - b.y;
        }
        P.cam.zoom = z1;
      } else { P.post.zoom = clamp(P.post.zoom * f, 1, 5); panBy(0, 0); }
    }
    function onWheel(ev) {
      if (!S.active) return; ev.preventDefault();
      var r = pc.getBoundingClientRect();
      if (ev.ctrlKey && Math.abs(ev.deltaX) < Math.abs(ev.deltaY) * 0.2 && false) return;
      if (ev.shiftKey) rotateBy(ev.deltaY * 0.0025);
      else zoomBy(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
      dirty(true); syncSliders();
    }
    var touches = {};
    function onTouch(ev) {
      if (!S.active) return;
      var ts = ev.touches; if (ts.length !== 2) { touches = {}; return; }
      ev.preventDefault();
      var a = ts[0], b = ts[1], dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), ang = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
      if (touches.d) { zoomBy(dist / touches.d); rotateBy(ang - touches.a); dirty(true); }
      touches = { d: dist, a: ang };
    }
    pc.addEventListener('pointerdown', onDown); pc.addEventListener('pointermove', onMove); pc.addEventListener('pointerup', onUp); pc.addEventListener('pointercancel', onUp);
    pc.addEventListener('wheel', onWheel, { passive: false }); pc.addEventListener('touchmove', onTouch, { passive: false });
    pc.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

    /* ---- panel */
    var sliders = {}, readouts = {};
    function slider(label, get, set, min, max, step, fmt) {
      var inp = h('input', { type: 'range', min: min, max: max, step: step || 0.01 }), out = h('output');
      inp.value = get();
      var show = function () { out.textContent = fmt ? fmt(+inp.value) : (+inp.value).toFixed(2); };
      inp.addEventListener('input', function () { set(+inp.value); show(); dirty(true); });
      inp.addEventListener('change', function () { dirty(false); });
      inp.addEventListener('dblclick', function () { if (inp.dataset.def != null) { inp.value = inp.dataset.def; set(+inp.value); show(); dirty(false); } });
      show();
      var row = h('label', { class: 'grp-row' }, h('span', { text: label }), inp, out);
      row._sync = function () { inp.value = get(); show(); };
      return row;
    }
    function seg(options, get, set) {
      var wrap = h('div', { class: 'seg' });
      options.forEach(function (o) {
        var b = h('button', { type: 'button', text: o[1] || o[0] });
        b.addEventListener('click', function () { set(o[0]); sync(); dirty(false); });
        b.dataset.v = o[0]; wrap.appendChild(b);
      });
      function sync() { Array.prototype.forEach.call(wrap.children, function (b) { b.classList.toggle('on', b.dataset.v === String(get())); }); }
      wrap._sync = sync; sync();
      return wrap;
    }
    function check(label, key) {
      var inp = h('input', { type: 'checkbox' }); inp.checked = !!P[key];
      inp.addEventListener('change', function () { P[key] = inp.checked; dirty(false); });
      var l = h('label', { class: 'grp-chk' }, inp, h('span', { text: label })); l._sync = function () { inp.checked = !!P[key]; }; return l;
    }
    var syncers = [];
    function reg(el) { if (el && el._sync) syncers.push(el); return el; }
    function syncSliders() { syncers.forEach(function (el) { el._sync(); }); }

    function buildPanel() {
      var pp = h('div', { class: 'grp-pp' });
      pp.appendChild(h('h3', { text: 'Photo mode' }));
      pp.appendChild(h('div', { class: 'hint', text: 'Drag to pan · wheel to zoom · Shift/right-drag or Q/E to rotate · , . scrub · Enter to capture · H hides panel · Esc exits' }));

      pp.appendChild(h('h4', { text: 'Moment' }));
      readouts.time = h('div', { class: 'tline' });
      pp.appendChild(readouts.time);
      pp.appendChild(reg(slider('Scrub', function () { return P.off; }, function (v) { P.off = v; syncCamFromLock(); }, -6, 6, 1 / hz, function (v) { return (v >= 0 ? '+' : '') + v.toFixed(2); })));
      var focusSel = h('select');
      rep.cars.forEach(function (car) { focusSel.appendChild(h('option', { value: car.info.id, text: '#' + car.info.number + '  ' + car.info.name + (car.info.isPlayer ? '  (you)' : '') })); });
      focusSel.addEventListener('change', function () { setFocus(focusSel.value, true); });
      focusSel._sync = function () { focusSel.value = P.focus; };
      pp.appendChild(h('label', { class: 'grp-row', style: { gridTemplateColumns: '86px 1fr' } }, h('span', { text: 'Subject' }), reg(focusSel)));

      pp.appendChild(h('h4', { text: 'Camera' }));
      if (player.is3D) pp.appendChild(reg(seg([['free3d', 'Free camera'], ['race', 'Broadcast'], ['studio', 'Top-down']], function () { return P.view; }, function (v) { setView(v); })));
      else if (!player.builtin) pp.appendChild(reg(seg([['race', 'Broadcast'], ['studio', 'Free (studio)']], function () { return P.view; }, function (v) { setView(v); })));
      var camBox = h('div');
      pp.appendChild(camBox);
      function fillCam() {
        camBox.innerHTML = '';
        var DEG = 180 / Math.PI, F = P.f3;
        if (useFree3d()) {
          camBox.appendChild(reg(slider('Orbit', function () { return wrapAngle(P.f3.yaw) * DEG; }, function (v) { P.f3.yaw = v / DEG; }, -180, 180, 0.5, function (v) { return Math.round(v) + '°'; })));
          camBox.appendChild(reg(slider('Tilt', function () { return P.f3.pitch * DEG; }, function (v) { P.f3.pitch = v / DEG; }, -15, 85, 0.5, function (v) { return Math.round(v) + '°'; })));
          camBox.appendChild(reg(slider('Distance', function () { return Math.log(P.f3.dist) / Math.LN2; }, function (v) { P.f3.dist = Math.pow(2, v); }, 0.3, 9, 0.01, function (v) { return Math.pow(2, v).toFixed(1) + ' m'; })));
          camBox.appendChild(reg(slider('Lens', function () { return P.f3.fov; }, function (v) { P.f3.fov = v; }, 10, 100, 0.5, function (v) { return Math.round(12 / Math.tan(v * Math.PI / 360)) + 'mm'; })));
          camBox.appendChild(reg(slider('Height', function () { return P.f3.oh; }, function (v) { P.f3.oh = v; }, -0.5, 8, 0.05, function (v) { return v.toFixed(1) + ' m'; })));
          camBox.appendChild(reg(slider('Roll', function () { return P.f3.roll * DEG; }, function (v) { P.f3.roll = v / DEG; }, -35, 35, 0.5, function (v) { return Math.round(v) + '°'; })));
          var lk = h('input', { type: 'checkbox' }); lk.checked = !!F.lock;
          lk.addEventListener('change', function () { setLock3d(lk.checked); dirty(false); });
          camBox.appendChild(h('label', { class: 'grp-chk' }, lk, h('span', { text: 'Track subject (camera follows while scrubbing / motion blur pans)' })));
          camBox.appendChild(reg(check('Name tags', 'tags')));
        } else if (player.is3D && P.view === 'race') {
          camBox.appendChild(reg(seg([['chase', 'Chase'], ['cockpit', 'Cockpit'], ['tv', 'TV'], ['helicopter', 'Heli']], function () { return P.extCam; }, function (v) { P.extCam = v; })));
          camBox.appendChild(h('div', { class: 'hint', text: 'Drag, scroll or rotate to take over with the free camera from this shot.' }));
        } else if (useStudio()) {
          camBox.appendChild(reg(slider('Zoom', function () { return Math.log(P.cam.zoom / base()) / Math.LN2; }, function (v) { P.cam.zoom = Math.pow(2, v) * base(); }, -2.5, 5.9, 0.01, function (v) { return Math.pow(2, v).toFixed(1) + '×'; })));
          camBox.appendChild(reg(slider('Rotate', function () { return P.cam.rot * 180 / Math.PI; }, function (v) { P.cam.rot = v * Math.PI / 180; }, -180, 180, 0.5, function (v) { return Math.round(v) + '°'; })));
          var lockChk = h('input', { type: 'checkbox' }); lockChk.checked = P.lock;
          lockChk.addEventListener('change', function () { P.lock = lockChk.checked; if (P.lock) relock(); dirty(false); });
          camBox.appendChild(h('label', { class: 'grp-chk' }, lockChk, h('span', { text: 'Track subject (camera follows while scrubbing / motion blur pans)' })));
          camBox.appendChild(reg(check('Highlight subject', 'ring')));
          camBox.appendChild(reg(check('Name tags', 'tags')));
        } else {
          camBox.appendChild(reg(seg([['chase', 'Chase'], ['north', 'North'], ['tv', 'TV']], function () { return P.extCam; }, function (v) { P.extCam = v; })));
          camBox.appendChild(reg(slider('Zoom', function () { return P.post.zoom; }, function (v) { P.post.zoom = v; panBy(0, 0); }, 1, 5, 0.01, function (v) { return v.toFixed(2) + '×'; })));
          camBox.appendChild(reg(slider('Rotate', function () { return P.post.rot * 180 / Math.PI; }, function (v) { P.post.rot = v * Math.PI / 180; }, -180, 180, 0.5, function (v) { return Math.round(v) + '°'; })));
        }
        camBox.appendChild(reg(check('Show HUD', 'hud')));
        var tools = h('div', { class: 'tools' });
        tools.appendChild(h('button', { class: 'grp-btn', type: 'button', text: 'Reset camera', onclick: function () { resetCam(); syncSliders(); dirty(false); } }));
        if (useFree3d()) {
          var shot = function (dy, pitch, dist, fov, oh) { return function () { var pz = poseFor(P.focus), hd = pz ? pz.heading : 0; P.f3.yaw = wrapAngle(hd + dy); P.f3.pitch = pitch; P.f3.dist = dist; P.f3.fov = fov; P.f3.oh = oh; P.f3.roll = 0; if (P.f3.lock) { P.f3.ox = 0; P.f3.oy = 0; } else if (pz) { P.f3.ox = pz.x; P.f3.oy = pz.y; } syncSliders(); dirty(false); }; };
          tools.appendChild(h('button', { class: 'grp-btn', type: 'button', text: 'Rear 3/4', onclick: shot(Math.PI - 0.55, 0.2, 8.5, 48, 0.7) }));
          tools.appendChild(h('button', { class: 'grp-btn', type: 'button', text: 'Front 3/4', onclick: shot(0.6, 0.12, 7.5, 42, 0.6) }));
          tools.appendChild(h('button', { class: 'grp-btn', type: 'button', text: 'Side', onclick: shot(Math.PI / 2, 0.04, 9, 35, 0.6) }));
          tools.appendChild(h('button', { class: 'grp-btn', type: 'button', text: 'Low', onclick: shot(0.35, -0.02, 5, 70, 0.25) }));
          tools.appendChild(h('button', { class: 'grp-btn', type: 'button', text: 'Aerial', onclick: shot(Math.PI - 0.3, 1.1, 40, 50, 0) }));
        }
        if (useStudio()) {
          tools.appendChild(h('button', { class: 'grp-btn', type: 'button', text: 'Top-down', onclick: function () { P.cam.rot = 0; syncSliders(); dirty(false); } }));
          tools.appendChild(h('button', { class: 'grp-btn', type: 'button', text: 'Behind car', onclick: function () { var car = focusCar(snapshotAt(rep, T(), { followId: P.focus })); if (car) { P.cam.rot = car.heading - Math.PI / 2; } syncSliders(); dirty(false); } }));
          tools.appendChild(h('button', { class: 'grp-btn', type: 'button', text: 'Wide', onclick: function () { P.cam.zoom = 1.6 * base(); syncSliders(); dirty(false); } }));
        }
        camBox.appendChild(tools);
      }
      fillCam(); S.fillCam = fillCam;

      pp.appendChild(h('h4', { text: 'Look' }));
      var presets = h('div', { class: 'grp-presets' });
      Object.keys(FILTER_PRESETS).forEach(function (k) {
        var b = h('button', { type: 'button', text: k });
        b.addEventListener('click', function () { applyPreset(k); Array.prototype.forEach.call(presets.children, function (x) { x.classList.toggle('on', x === b); }); });
        if (k === P.preset) b.classList.add('on');
        presets.appendChild(b);
      });
      pp.appendChild(presets);
      FILTER_SLIDERS.forEach(function (grp) {
        pp.appendChild(h('h4', { text: grp[0] }));
        grp[1].forEach(function (sd) {
          var row = reg(slider(sd[1], function () { return P.f[sd[0]]; }, function (v) { P.f[sd[0]] = v; }, sd[2], sd[3], 0.01));
          row.querySelector('input').dataset.def = FILTER_DEFAULTS[sd[0]];
          pp.appendChild(row);
        });
        if (grp[0] === 'Effects') pp.appendChild(reg(slider('Focus line', function () { return P.tiltPos; }, function (v) { P.tiltPos = v; }, 0.1, 0.9, 0.01)));
      });
      pp.appendChild(h('div', { class: 'tools' },
        h('button', { class: 'grp-btn', type: 'button', text: 'Reset look', onclick: function () { applyPreset('none'); } }),
        h('button', { class: 'grp-btn', type: 'button', text: 'Randomize', onclick: function () { randomLook(); } })));

      pp.appendChild(h('h4', { text: 'Frame' }));
      pp.appendChild(h('div', { class: 'grp-lbl', style: { margin: '0' }, text: 'Aspect' }));
      pp.appendChild(reg(seg(ASPECTS.map(function (a) { return [a[0], a[2]]; }), function () { return P.aspect; }, function (v) { P.aspect = v; })));
      pp.appendChild(h('div', { class: 'grp-lbl', style: { margin: '6px 0 0' }, text: 'Border & graphics' }));
      pp.appendChild(reg(seg(FRAME_STYLES, function () { return P.frame; }, function (v) { P.frame = v; })));
      var cap2 = h('input', { type: 'text', placeholder: 'Caption (optional)', maxlength: '80' });
      cap2.addEventListener('input', function () { P.caption = cap2.value; dirty(false); });
      pp.appendChild(cap2);
      [['Cinema letterbox (2.39:1)', 'letterbox'], ['Driver info card', 'info'], ['Redline watermark', 'logo'], ['Date stamp', 'date'], ['Composition guides (not exported)', 'guides']].forEach(function (x) { pp.appendChild(reg(check(x[0], x[1]))); });

      var foot = h('div', { class: 'grp-ppfoot' });
      S.capBtn = h('button', { class: 'grp-btn gold', type: 'button', html: ICONS.camera + '<span>Export PNG</span>', onclick: function () { exportPNG(); } });
      foot.appendChild(S.capBtn);
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write) foot.appendChild(h('button', { class: 'grp-btn', type: 'button', text: 'Copy', onclick: function () { exportPNG({ clipboard: true }); } }));
      foot.appendChild(h('button', { class: 'grp-btn', type: 'button', text: 'Hide panel', onclick: function () { root.classList.add('pp-hidden'); } }));
      foot.appendChild(h('button', { class: 'grp-btn', type: 'button', text: 'Exit', onclick: function () { close(); } }));
      pp.appendChild(foot);
      root.appendChild(pp);

      var bar = h('div', { class: 'grp-pbar' },
        h('button', { class: 'grp-btn gold', type: 'button', html: ICONS.camera + '<span>Capture</span>', onclick: function () { exportPNG(); } }),
        h('button', { class: 'grp-btn', type: 'button', text: 'Panel', onclick: function () { root.classList.toggle('pp-hidden'); } }),
        h('button', { class: 'grp-btn', type: 'button', text: 'Exit photo mode', onclick: function () { close(); } }));
      root.appendChild(bar);
      S.panel = pp; S.bar = bar;
    }
    function updateReadouts() {
      if (!readouts.time) return;
      var car = focusCar(S.lastSnap);
      readouts.time.textContent = fmtTime(T(), 2) + ' / ' + fmtTime(player.duration, 1) + (car ? '  ·  P' + car.position + '  ·  ' + spd(car) : '');
    }
    function applyPreset(k) {
      var seed = P.f.seed; P.preset = k; P.f = filterParams(FILTER_PRESETS[k] || {}); P.f.seed = seed;
      syncSliders(); dirty(false);
    }
    function randomLook() {
      var r = mulberry32((Date.now() & 0xffffff) ^ 0x9e3779b9), f = filterParams({});
      f.contrast = (r() - 0.3) * 0.6; f.saturation = (r() - 0.45) * 0.9; f.warmth = (r() - 0.5) * 0.8; f.tint = (r() - 0.5) * 0.3;
      f.vignette = r() * 0.7; f.grain = r() < 0.5 ? r() * 0.5 : 0; f.fade = r() < 0.4 ? r() * 0.3 : 0; f.bw = r() < 0.15 ? 1 : 0;
      f.bloom = r() < 0.4 ? r() * 0.6 : 0; f.motionBlur = r() < 0.35 ? r() * 0.7 : 0; f.seed = P.f.seed;
      P.f = f; P.preset = 'custom'; syncSliders(); dirty(false);
    }
    function setFocus(id, recenter) {
      P.focus = String(id);
      if (!useStudio()) { player.followCar(P.focus); if (useFree3d() && recenter) { P.f3.ox = 0; P.f3.oy = 0; if (!P.f3.lock) { var pz = poseFor(P.focus); if (pz) { P.f3.ox = pz.x; P.f3.oy = pz.y; } } } }
      else if (recenter) { var snap = snapshotAt(rep, T(), { followId: P.focus }), car = carIn(snap, P.focus); if (car) { P.cam.x = car.x; P.cam.y = car.y; P.lockOff = { x: 0, y: 0 }; } }
      syncSliders(); dirty(false);
    }
    function setView(v) {
      if (v === P.view) return;
      if (v === 'studio') {
        // carry framing over: centre on subject with a chase-like orientation
        resetCam(true);
      } else if (S.studio && S.studio !== player.renderer) { try { if (player.renderer && player.renderer.reset) player.renderer.reset(); } catch (e) { /* ignore */ } }
      P.view = v; if (S.fillCam) S.fillCam(); syncSliders(); dirty(false);
    }
    function resetCam(forStudio) {
      var snap = snapshotAt(rep, T(), { followId: P.focus }), car = carIn(snap, P.focus);
      if (useStudio() || forStudio) {
        var lc = player.builtin ? player.lastCamera : null;
        if (lc && isNum(lc.zoom) && !forStudio && S.entryCam) { P.cam = Object.assign({}, S.entryCam); }
        else if (car) { P.cam = { x: car.x, y: car.y, zoom: 9 * base(), rot: car.heading - Math.PI / 2 }; }
        P.lockOff = car ? { x: P.cam.x - car.x, y: P.cam.y - car.y } : { x: 0, y: 0 };
      }
      if (useFree3d() && !forStudio) { var pz = poseFor(P.focus); P.f3 = S.entryF3 ? Object.assign({}, S.entryF3) : defaultFree3d(pz); }
      P.post = { zoom: 1, rot: 0, panX: 0, panY: 0 };
    }

    /* ---- export */
    function exportPNG(o) {
      o = o || {};
      if (S.busy || !S.active) return;
      S.busy = true;
      var finish = function () { S.busy = false; dirty(false); };
      setTimeout(function () {
        try {
          var res = compose(1, true), cr = res.crop, fin = mkCanvas(cr.w, cr.h);
          fin.getContext('2d').drawImage(res.canvas, cr.x, cr.y, cr.w, cr.h, 0, 0, cr.w, cr.h);
          S.exportCount++;
          c.flash.classList.add('on'); setTimeout(function () { c.flash.classList.remove('on'); }, 60);
          var name = 'forge-photo-' + slug(inf.trackName) + '-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png';
          var done = function (blob) {
            if (!blob) { c.toast('Export failed'); finish(); return; }
            if (o.clipboard) {
              navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(function () { c.toast('Copied to clipboard · ' + cr.w + '×' + cr.h); }, function () { c.toast('Clipboard blocked — downloading instead'); downloadBlob(blob, name); });
            } else { downloadBlob(blob, name); c.toast('Saved ' + name + ' · ' + cr.w + '×' + cr.h + ' · ' + fmtBytes(blob.size)); }
            notifyAchievement({ type: 'photo', action: 'exported', width: cr.w, height: cr.h, frame: P.frame, preset: P.preset });
            if (typeof c.onExport === 'function') { try { c.onExport({ name: name, blob: blob, width: cr.w, height: cr.h }); } catch (e) { /* ignore */ } }
            finish();
          };
          if (fin.toBlob) fin.toBlob(done, 'image/png');
          else {
            var url = fin.toDataURL('image/png'), bin = atob(url.split(',')[1]), arr = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            done(new Blob([arr], { type: 'image/png' }));
          }
        } catch (e) { c.toast('Export failed: ' + (e && e.message)); finish(); }
      }, 30);
    }

    /* ---- keyboard (returns true if handled) */
    function onKey(ev) {
      if (!S.active) return false;
      var k = ev.key, step = ev.shiftKey ? 60 : 18;
      if (k === 'Escape') { if (root.classList.contains('pp-hidden')) root.classList.remove('pp-hidden'); else close(); return true; }
      if (k === 'Enter' || k === 'x' || k === 'X') { exportPNG(); return true; }
      if (k === 'h' || k === 'H') { root.classList.toggle('pp-hidden'); return true; }
      if (k === 'g' || k === 'G') { P.guides = !P.guides; syncSliders(); drawGuides(); return true; }
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { panBy(step, 0); dirty(true); return true; }
      if (k === 'ArrowRight' || k === 'd' || k === 'D') { panBy(-step, 0); dirty(true); return true; }
      if (k === 'ArrowUp' || k === 'w' || k === 'W') { panBy(0, step); dirty(true); return true; }
      if (k === 'ArrowDown' || k === 's' || k === 'S') { panBy(0, -step); dirty(true); return true; }
      if (k === 'q' || k === 'Q') { rotateBy(-0.04); dirty(true); syncSliders(); return true; }
      if (k === 'e' || k === 'E') { rotateBy(0.04); dirty(true); syncSliders(); return true; }
      if (k === '+' || k === '=') { zoomBy(1.12); dirty(true); syncSliders(); return true; }
      if (k === '-' || k === '_') { zoomBy(1 / 1.12); dirty(true); syncSliders(); return true; }
      if (k === ',' || k === '.') { P.off = clamp(P.off + (k === ',' ? -1 : 1) / hz * (ev.shiftKey ? 10 : 1), -6, 6); syncCamFromLock(); syncSliders(); dirty(false); return true; }
      if (k === 'Tab') { var ids = rep.cars.map(function (x) { return x.info.id; }), i = ids.indexOf(P.focus); setFocus(ids[(i + (ev.shiftKey ? -1 : 1) + ids.length) % ids.length], true); return true; }
      if (/^[1-8]$/.test(k)) { var pr = Object.keys(FILTER_PRESETS)[+k - 1]; if (pr) applyPreset(pr); return true; }
      return false;
    }

    /* ---- lifecycle */
    function open() {
      if (S.active) return;
      S.active = true; S.wasPlaying = player.playing; S.savedCam = player.camera; S.savedFollow = player.followCar();
      player.pause(); player.setLive(false);
      P.T0 = player.time; P.off = 0; P.focus = player.following || M.playerId || (rep.cars[0] && rep.cars[0].info.id);
      if (player.builtin && player.lastCamera && isNum(player.lastCamera.zoom)) { P.cam = Object.assign({}, player.lastCamera); S.entryCam = Object.assign({}, P.cam); relock(); }
      else { resetCam(true); S.entryCam = Object.assign({}, P.cam); }
      P.post = { zoom: 1, rot: 0, panX: 0, panY: 0 };
      if (player.is3D) {
        // start the free 3D camera on exactly the shot that was on screen (the subject stays the followed car)
        P.view = 'free3d';
        P.extCam = { chase: 'chase', cockpit: 'cockpit', tv: 'tv', trackside: 'tv', helicopter: 'helicopter', 'orbit-car': 'chase' }[player.effectiveCamera] || 'chase';
        // the renderer's camera is only meaningful once it has drawn the subject (photo mode opened straight from the
        // results screen has not rendered a frame yet: its default camera looks at the world origin, far from the car)
        var cs0 = player.cameraState3d(), pz0 = poseFor(P.focus);
        if (cs0 && cs0.target && pz0 && Math.hypot(cs0.target[0] - pz0.x, -cs0.target[2] - pz0.y) > 8) cs0 = null;   // every 3D view aims at the car
        P.f3 = seedFree3d(cs0, pz0, true); S.entryF3 = Object.assign({}, P.f3);
        if (P.focus) player.followCar(P.focus);
      } else P.extCam = { chase: 'chase', north: 'north', tv: 'tv', trackside: 'tv', helicopter: 'north' }[player.effectiveCamera] || 'chase';
      if (!S.panel) buildPanel(); else if (S.fillCam) S.fillCam();
      syncSliders();   // the Subject picker and sliders show this opening's focus and camera (a new panel starts on car #1)
      root.classList.add('photo'); root.classList.remove('pp-hidden', 'idle');
      notifyAchievement({ type: 'photo', action: 'open' });
      S.dirty = true; S.lastCompose = 0;
      if (typeof requestAnimationFrame === 'function') S.raf = requestAnimationFrame(loop); else refresh();
    }
    function close() {
      if (!S.active) return;
      S.active = false;
      if (S.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(S.raf); S.raf = 0;
      root.classList.remove('photo', 'pp-hidden');
      if (S.studio && S.studio !== player.renderer) { try { S.studio.destroy(); } catch (e) { /* ignore */ } S.studio = null; }
      player.setLive(true);
      try { if (player.renderer && player.renderer.reset) player.renderer.reset(); } catch (e2) { /* ignore */ }
      if (S.savedFollow) player.followCar(S.savedFollow);
      player.seek(T());
      player.setCamera(S.savedCam || 'chase');
      if (S.wasPlaying) player.play();
    }
    function destroy() {
      close();
      pc.removeEventListener('pointerdown', onDown); pc.removeEventListener('pointermove', onMove); pc.removeEventListener('pointerup', onUp);
      pc.removeEventListener('wheel', onWheel); pc.removeEventListener('touchmove', onTouch);
    }
    return {
      get active() { return S.active; },
      open: open, close: close, destroy: destroy, onKey: onKey, exportPNG: exportPNG,
      recompose: function () { dirty(false); },
      params: P,
      setFilters: function (f) { Object.assign(P.f, f || {}); syncSliders(); dirty(false); },
      setPreset: applyPreset,
      setFrame: function (fr) { P.frame = fr; syncSliders(); dirty(false); },
      setAspect: function (a) { P.aspect = a; syncSliders(); dirty(false); },
      compose: function (scale) { return compose(num(scale, 1), true); }
    };
  }

  /* standalone photo mode on a replay (opens the replay UI paused, straight into photo mode) */
  function photoMode(target, opts) {
    if (target && target.photo && typeof target.photo.open === 'function') { target.photo.open(); return target.photo; }
    var ui = openUI(target, Object.assign({}, opts, { autoplay: false, photo: true }));
    return ui.photo;
  }

  /* ================================================================ replay library */

  var activeLib = null;
  function openBrowser(opts) {
    if (!hasDOM) throw new Error('replay.openBrowser requires a DOM');
    opts = opts || {};
    if (activeLib) activeLib.close();
    injectStyles();
    var inline = !!opts.root && opts.inline !== false;   // router screen (#/replays): no scrim, Esc belongs to the router
    var wrap = h('div', { class: 'grp-lib' + (inline ? ' is-inline' : ''), id: 'game-replay-library' }), box = h('div', { class: 'grp-libbox' });
    wrap.appendChild(box);
    var meter = h('div', { class: 'grp-meter' }, h('i')), usageTxt = h('span', { class: 'grp-lbl' });
    var importBtn = h('button', { class: 'grp-btn', type: 'button', html: ICONS.share + '<span>Import</span>' });
    var closeBtn = h('button', { class: 'grp-btn icon', type: 'button', html: ICONS.close, title: 'Close' });
    box.appendChild(h('div', { class: 'grp-libhead' }, h('span', { html: ICONS.film, style: { width: '22px', height: '22px', display: 'inline-flex', color: '#c9a56b' } }),
      h('h2', { text: 'Replays' }), h('div', { class: 'grp-sp' }), usageTxt, meter, importBtn, closeBtn));
    var tools = h('div', { class: 'grp-libtools', style: { display: 'none' } });
    var ta = h('textarea', { placeholder: 'Paste a REDLINE-REPLAY:… string, or choose a .redlinereplay file' });
    var file = h('input', { type: 'file', accept: '.redlinereplay,.forgereplay,.txt,text/plain', style: { display: 'none' } });
    var fileBtn = h('button', { class: 'grp-btn', type: 'button', text: 'Choose file…', onclick: function () { file.click(); } });
    var doImport = h('button', { class: 'grp-btn gold', type: 'button', text: 'Import', onclick: function () { importText(ta.value); } });
    tools.appendChild(ta); tools.appendChild(fileBtn); tools.appendChild(doImport); tools.appendChild(file);
    box.appendChild(tools);
    var list = h('div', { class: 'grp-liblist' });
    box.appendChild(list);
    var toastEl = h('div', { class: 'grp-toast', style: { top: '24px' } }); wrap.appendChild(toastEl);
    function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(function () { toastEl.classList.remove('show'); }, 2400); }

    importBtn.addEventListener('click', function () { tools.style.display = tools.style.display === 'none' ? 'flex' : 'none'; });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0]; if (!f) return;
      var rd = new FileReader(); rd.onload = function () { importText(String(rd.result || '')); }; rd.readAsText(f);
    });
    function importText(txt) {
      try {
        var r = store.importString(txt);
        if (!r.result.ok) { toast('Imported but too large to store — opening anyway'); watch(r.replay); return; }
        ta.value = ''; tools.style.display = 'none'; toast('Imported “' + info(r.replay).name + '”'); render();
      } catch (e) { toast('Import failed: ' + e.message); }
    }
    function watch(repOrId) {
      var rp = typeof repOrId === 'string' ? store.load(repOrId) : repOrId;
      if (!rp) { toast('Could not load replay'); return; }
      close();
      openUI(rp, Object.assign({}, opts.ui || {}, { onClose: function () { if (opts.reopen !== false) openBrowser(opts); if (opts.onClose) opts.onClose(); } }));
    }
    function render() {
      list.innerHTML = '';
      var items = store.list(), u = store.usage();
      usageTxt.textContent = items.length + '/' + u.max + ' · ' + fmtBytes(u.chars);
      meter.firstChild.style.width = Math.min(100, u.chars / u.cap * 100) + '%';
      var lastRep = lastReplay && !items.some(function (it) { return lastReplay.meta && it.id === lastReplay.meta.id; }) ? lastReplay : null;
      if (lastRep) {
        var li = info(lastRep), cv = h('canvas');
        var row = h('div', { class: 'grp-item', style: { borderColor: '#c9a56b66' } }, cv,
          h('div', {}, h('b', { text: 'Last race' }), h('span', { class: 'grp-badge', text: 'unsaved' }),
            h('div', { class: 'meta', text: [li.trackName, modeText(li), fmtClock(li.duration), carsText(li.cars), li.playerFinish ? 'You: P' + li.playerFinish : null].filter(Boolean).join(' · ') })),
          h('div', { class: 'acts' },
            h('button', { class: 'grp-btn gold', type: 'button', html: ICONS.play + '<span>Watch</span>', onclick: function () { watch(lastRep); } }),
            h('button', { class: 'grp-btn', type: 'button', html: ICONS.save + '<span>Save</span>', onclick: function () { var r = store.save(lastRep); if (r.ok) { lastRep.meta.id = r.id; notifyAchievement({ type: 'replay', action: 'saved' }); toast('Saved'); } else toast('Too large to store'); render(); } })));
        list.appendChild(row); setTimeout(function () { drawThumb(cv, makeThumb(lastRep)); }, 0);
      }
      if (!items.length && !lastRep) {
        list.appendChild(h('div', { class: 'grp-empty', html: ICONS.film + 'No saved replays yet.<br>Finish a race and press <b>Save</b> on the replay screen.' }));
        return;
      }
      items.forEach(function (it) {
        var I = it.info || {}, cv = h('canvas'), nameEl = h('b', { text: it.name || I.name || 'Replay' });
        var metaTxt = [I.trackName, modeText(I), I.laps ? I.laps + ' laps' : null, fmtClock(I.duration), carsText(I.cars),
          I.playerFinish ? 'P' + I.playerFinish : null, I.playerBest_s ? 'best ' + fmtTime(I.playerBest_s) : null,
          I.overtakes ? I.overtakes + ' overtakes' : null, fmtBytes(it.chars || 0), new Date(it.savedAt || it.createdAt || Date.now()).toLocaleString()].filter(Boolean).join(' · ');
        var confirmDel = false;
        var del = h('button', { class: 'grp-btn danger', type: 'button', text: 'Delete' });
        del.addEventListener('click', function () {
          if (!confirmDel) { confirmDel = true; del.textContent = 'Sure?'; setTimeout(function () { confirmDel = false; del.textContent = 'Delete'; }, 2500); return; }
          store.remove(it.id); toast('Deleted'); render();
        });
        var row = h('div', { class: 'grp-item' }, cv,
          h('div', { style: { minWidth: 0 } }, nameEl, it.pinned ? h('span', { class: 'grp-badge pin', text: 'pinned' }) : null,
            (it.degraded && it.degraded.length) ? h('span', { class: 'grp-badge', title: it.degraded.join(', '), text: 'compressed' }) : null,
            h('div', { class: 'meta', text: metaTxt })),
          h('div', { class: 'acts' },
            h('button', { class: 'grp-btn gold', type: 'button', html: ICONS.play + '<span>Watch</span>', onclick: function () { watch(it.id); } }),
            h('button', { class: 'grp-btn', type: 'button', html: ICONS.camera, title: 'Open in photo mode', onclick: function () { var rp = store.load(it.id); if (!rp) return; close(); photoMode(rp, Object.assign({}, opts.ui || {}, { onClose: function () { if (opts.reopen !== false) openBrowser(opts); } })); } }),
            h('button', { class: 'grp-btn icon' + (it.pinned ? ' on' : ''), type: 'button', html: ICONS.star, title: it.pinned ? 'Unpin' : 'Pin (protect from auto-removal)', onclick: function () { store.pin(it.id); render(); } }),
            h('button', { class: 'grp-btn', type: 'button', text: 'Rename', onclick: function () {
              var inp = h('input', { class: 'rn', type: 'text', value: it.name || '' }); nameEl.replaceWith(inp); inp.focus(); inp.select();
              var commit = function () { store.rename(it.id, inp.value); render(); };
              inp.addEventListener('keydown', function (ev) { ev.stopPropagation(); if (ev.key === 'Enter') commit(); if (ev.key === 'Escape') render(); });
              inp.addEventListener('blur', commit);
            } }),
            h('button', { class: 'grp-btn', type: 'button', html: ICONS.share, title: 'Download .redlinereplay', onclick: function () { var s = store.exportString(it.id); if (s) downloadText(s, 'redline-' + slug(it.name || I.trackName) + '.redlinereplay'); } }),
            del));
        list.appendChild(row);
        setTimeout(function () { drawThumb(cv, it.thumb); }, 0);
      });
    }
    function onKey(ev) {
      if (!wrap.isConnected) { close(); return; }   // the router tore the screen down
      if (inline) return;
      if (ev.key === 'Escape' && !/INPUT|TEXTAREA/.test((ev.target && ev.target.tagName) || '')) { ev.preventDefault(); close(); }
    }
    function onStore() { if (wrap.isConnected) render(); }
    function close() {
      if (!lib.open) return; lib.open = false;
      window.removeEventListener('keydown', onKey, true); document.removeEventListener('forge:replays', onStore);
      wrap.remove(); if (activeLib === lib) activeLib = null;
    }
    closeBtn.addEventListener('click', function () { close(); if (opts.onClose) opts.onClose(); });
    wrap.addEventListener('click', function (ev) { if (ev.target === wrap && !inline) { close(); if (opts.onClose) opts.onClose(); } });
    if (inline && !opts.onClose) closeBtn.style.display = 'none';
    window.addEventListener('keydown', onKey, true); document.addEventListener('forge:replays', onStore);
    (opts.root || document.body).appendChild(wrap);
    var lib = { open: true, el: wrap, close: close, refresh: render };
    activeLib = lib;
    render();
    return lib;
  }

  /* ================================================================ last replay + auto recording */

  var lastReplay = null, lastListeners = [];
  function setLast(rep) {
    lastReplay = rep || null;
    lastListeners.slice().forEach(function (fn) { try { fn(rep); } catch (e) { /* ignore */ } });
    try { if (hasDOM && typeof CustomEvent !== 'undefined') document.dispatchEvent(new CustomEvent('forge:replay-ready', { detail: { replay: rep, info: rep ? info(rep) : null } })); } catch (e2) { /* ignore */ }
    return rep;
  }

  /* Opt-in, non-invasive integration: wraps CB.race.engine.createSession so every session is recorded.
     The replay finalizes a few seconds after the session's phase becomes 'finished' (or all cars are done),
     when a new session starts, or when the race overlay closes ('cb:race-closed'). Returns an uninstall fn. */
  var installed = null;
  function install(opts) {
    opts = opts || {};
    if (installed) return installed.uninstall;
    var E = CB.race && CB.race.engine;
    if (!E || typeof E.createSession !== 'function') return function () {};
    var orig = E.createSession, current = null;
    var tail = num(opts.tailSeconds, 8), minFrames = num(opts.minFrames, 90);
    function finalize(cur, reason) {
      if (!cur || cur.done) return null;
      cur.done = true;
      var rec = cur.rec, rep = null;
      try {
        if (rec.frameCount >= minFrames) {
          rep = rec.finishAndDetach({ meta: { endReason: reason } });
          if (cur.session && cur.session.trackDef && !rep.meta.trackName) rep.meta.trackName = cur.session.trackDef.name;
          setLast(rep);
          if (opts.autoSave === true || (opts.autoSave === 'race' && rep.meta.mode === 'race')) { var r = store.save(rep); if (r.ok) rep.meta.id = r.id; }
          if (typeof opts.onReplay === 'function') opts.onReplay(rep);
        } else rec.detach();
      } catch (e) { if (typeof console !== 'undefined') console.warn('[replay] finalize failed', e); try { rec.detach(); } catch (e2) { /* ignore */ } }
      if (current === cur) current = null;
      return rep;
    }
    E.createSession = function (cfg) {
      var session = orig.apply(this, arguments);
      if (current) finalize(current, 'new-session');
      if (!session || typeof session.snapshot !== 'function' || (cfg && cfg.replay === false)) return session;
      function setup() {
        // attach() wraps session.snapshot (capture); we wrap once more to watch for the end of the session.
        // rec.detach() restores the engine's original snapshot fn, removing both layers.
        var rec = attach(session, opts.recorder), cur = { session: session, rec: rec, done: false, finishedAt: null };
        if (cfg && cfg.track && cfg.track.name) rec.setMeta({ trackName: cfg.track.name, theme: cfg.track.theme || undefined });
        var inner = session.snapshot;
        session.snapshot = function () {
          var snap = inner.apply(session, arguments);
          if (!cur.done && snap && snap.cars && snap.cars.length) {
            var allDone = snap.cars.every(function (x) { return x.finished || x.dnf; });
            if (snap.phase === 'finished' || allDone) {
              if (cur.finishedAt == null) cur.finishedAt = num(snap.t, 0);
              if (num(snap.t, 0) - cur.finishedAt >= (allDone ? Math.min(3, tail) : tail)) finalize(cur, 'finished');
            }
          }
          return snap;
        };
        current = cur;
        return cur;
      }
      try {
        var cur0 = setup();
        var origRestart = session.restart;
        if (typeof origRestart === 'function') {
          session.restart = function () {
            var cur = current && current.session === session ? current : cur0;
            if (cur.done) cur0 = setup(); else { cur.rec.reset(); cur.finishedAt = null; }
            return origRestart.apply(session, arguments);
          };
        }
        session.replayRecorder = function () { return (current && current.session === session ? current : cur0).rec; };
        session.finishReplay = function () { return finalize(current && current.session === session ? current : cur0, 'manual'); };
      } catch (e) { if (typeof console !== 'undefined') console.warn('[replay] could not attach recorder', e); }
      return session;
    };
    function onClosed() { if (current) finalize(current, 'closed'); }
    if (hasDOM) document.addEventListener('cb:race-closed', onClosed);
    installed = {
      uninstall: function () { if (E.createSession !== orig) E.createSession = orig; if (hasDOM) document.removeEventListener('cb:race-closed', onClosed); installed = null; },
      current: function () { return current; }, finalize: function () { return current ? finalize(current, 'manual') : null; }
    };
    return installed.uninstall;
  }

  /* convenience: open the most relevant replay (last race, else newest stored) */
  function watchLast(opts) {
    var rp = lastReplay;
    if (!rp) { var it = store.list()[0]; rp = it ? store.load(it.id) : null; }
    if (!rp) return null;
    return openUI(rp, opts);
  }

  /* ================================================================ public API */

  var api = {
    FORMAT_VERSION: FORMAT_VERSION, STORAGE_KEY: STORAGE_KEY, MAX_STORED: MAX_STORED, CAMERAS: CAMERAS.slice(), MARKER_STYLE: MARKER_STYLE,
    // recording
    createRecorder: createRecorder, attach: attach, install: install,
    // data
    serialize: serialize, serializeEx: serializeEx, deserialize: deserialize, encode: encode, decode: decode,
    snapshotAt: snapshotAt, eventsBetween: eventsBetween, series: series, info: info, markers: buildMarkers, highlights: buildHighlights,
    resample: resample, trim: trim, pruneCars: pruneCars, clone: cloneReplay, outlineGeom: outlineGeom, makeThumb: makeThumb,
    // storage
    store: store, storage: store,
    list: function () { return store.list(); }, save: function (rep, o) { return store.save(rep, o); }, load: function (id) { return store.load(id); },
    remove: function (id) { return store.remove(id); },
    last: function () { return lastReplay; }, setLast: setLast, onReplay: function (fn) { lastListeners.push(fn); return function () { lastListeners = lastListeners.filter(function (f) { return f !== fn; }); }; },
    // playback / UI
    createPlayer: createPlayer, createView: createView, createCameraRig: createCameraRig,
    openUI: openUI, open: function (rep, o) { return openUI(rep, o); }, watch: function (idOrRep, o) { return openUI(idOrRep, o); }, watchLast: watchLast,
    openBrowser: openBrowser, openLibrary: openBrowser, photoMode: photoMode,
    close: function () { if (activeUI) activeUI.close(); if (activeLib) activeLib.close(); },
    get active() { return activeUI; },
    // photo
    filters: filters, cropRect: cropRect,
    // 3D viewer camera mapping / free-camera math
    camera3d: { map: CAMERA_3D, forMode: camera3dFor, pickBackend: pickBackend, uiCameras: uiCameras, orbit: orbitCam3d, free: freeCam3d,
      seedFree: seedFree3d, defaultFree: defaultFree3d, panFree: panFree3d, rollUp: rollUp, project: project3d },
    _internal: { base64Encode: base64Encode, base64Decode: base64Decode, lzCompress: lzCompress, lzDecompress: lzDecompress, crc32: crc32,
      utf8Encode: utf8Encode, utf8Decode: utf8Decode, ByteWriter: ByteWriter, ByteReader: ByteReader, extractOutline: extractOutline,
      frameAt: frameAt, wrapAngle: wrapAngle, screenToWorld: screenToWorld, worldToScreen: worldToScreen, CAR_CH: CAR_CH, FRAME_CH: FRAME_CH, FLAG: FLAG,
      resetMemory: function () { memoryStore = null; lastReplay = null; } }
  };
  return api;
})();

if (typeof module !== 'undefined') module.exports = CB.game.replay;
