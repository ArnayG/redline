/* ==========================================================================
   FORGE Atelier — js/util.js
   CB.util : small, dependency-free helpers shared by every module.
   Runs in browsers (classic <script>) and in Node (require) alike.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  var hasDOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

  /* ---------------------------------------------------------------- numbers */

  function clamp(v, min, max) {
    v = Number(v);
    if (Number.isNaN(v)) v = min;
    if (min > max) { var t = min; min = max; max = t; }
    return v < min ? min : v > max ? max : v;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  /** Inverse lerp: where v sits between a..b, returned 0..1 (unclamped). */
  function invLerp(a, b, v) { return a === b ? 0 : (v - a) / (b - a); }

  /** Round to d decimals (default 0), avoiding binary float artefacts. */
  function round(n, d) {
    d = d || 0;
    var p = Math.pow(10, d);
    return Math.round((Number(n) + Number.EPSILON) * p) / p;
  }

  /** Snap value to a step grid anchored at `base` (default 0). */
  function snap(v, step, base) {
    base = base || 0;
    if (!step) return v;
    var decimals = (String(step).split('.')[1] || '').length;
    return round(base + Math.round((v - base) / step) * step, decimals);
  }

  /** Pick the closest element of a numeric array. */
  function nearest(arr, v) {
    if (!arr || !arr.length) return v;
    var best = arr[0], bd = Math.abs(arr[0] - v);
    for (var i = 1; i < arr.length; i++) {
      var d = Math.abs(arr[i] - v);
      if (d < bd) { bd = d; best = arr[i]; }
    }
    return best;
  }

  function fmtMoney(n, opts) {
    opts = opts || {};
    n = Number(n) || 0;
    var sign = n < 0 ? '-' : (opts.sign && n > 0 ? '+' : '');
    var abs = Math.abs(n);
    var decimals = opts.decimals != null ? opts.decimals : (abs % 1 !== 0 && abs < 100 ? 2 : 0);
    if (opts.compact && abs >= 1000) {
      if (abs >= 1e6) return sign + '$' + round(abs / 1e6, 2) + 'M';
      return sign + '$' + round(abs / 1e3, abs >= 1e5 ? 0 : 1) + 'k';
    }
    return sign + '$' + fmtNum(abs, decimals);
  }

  function fmtNum(n, d) {
    n = Number(n);
    if (!isFinite(n)) return '—';
    d = d || 0;
    var fixed = round(n, d).toFixed(d);
    var parts = fixed.split('.');
    var neg = parts[0].charAt(0) === '-';
    var int = neg ? parts[0].slice(1) : parts[0];
    int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + int + (parts[1] ? '.' + parts[1] : '');
  }

  /* ---------------------------------------------------------------- objects */

  function isPlainObject(o) {
    return o !== null && typeof o === 'object' && !Array.isArray(o) &&
      (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
  }

  function deepClone(o) {
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(deepClone);
    if (o instanceof Date) return new Date(o.getTime());
    var out = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = deepClone(o[k]);
    return out;
  }

  /**
   * Deep merge `src` onto `target`, returning a NEW object (inputs untouched).
   * Arrays and non-plain values in src replace wholesale. `undefined` in src is skipped.
   */
  function deepMerge(target, src) {
    if (!isPlainObject(src)) return src === undefined ? deepClone(target) : deepClone(src);
    var out = isPlainObject(target) ? deepClone(target) : {};
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      var sv = src[k];
      if (sv === undefined) continue;
      if (isPlainObject(sv) && isPlainObject(out[k])) out[k] = deepMerge(out[k], sv);
      else out[k] = deepClone(sv);
    }
    return out;
  }

  function splitPath(path) {
    if (Array.isArray(path)) return path;
    if (path == null || path === '') return [];
    return String(path).split('.');
  }

  /** get(obj, 'a.b.c', fallback) */
  function get(obj, path, fallback) {
    var keys = splitPath(path), cur = obj;
    for (var i = 0; i < keys.length; i++) {
      if (cur == null) return fallback;
      cur = cur[keys[i]];
    }
    return cur === undefined ? fallback : cur;
  }

  /**
   * Immutable set: returns a new object with structural sharing; only the objects along
   * `path` are shallow-copied. Numeric keys on arrays copy the array.
   */
  function set(obj, path, val) {
    var keys = splitPath(path);
    if (!keys.length) return val;
    var k = keys[0];
    var base = obj == null ? (/^\d+$/.test(k) ? [] : {}) : obj;
    var copy = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    copy[k] = keys.length === 1 ? val : set(base[k], keys.slice(1), val);
    return copy;
  }

  /** Deep equality for JSON-like data. */
  function equal(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
      return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) if (!equal(a[ka[i]], b[ka[i]])) return false;
    return true;
  }

  /** List leaf paths whose values differ between two objects. */
  function diff(a, b, prefix, out) {
    out = out || []; prefix = prefix || '';
    var keys = {};
    Object.keys(a || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(b || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      var p = prefix ? prefix + '.' + k : k;
      var va = a ? a[k] : undefined, vb = b ? b[k] : undefined;
      if (isPlainObject(va) && isPlainObject(vb)) diff(va, vb, p, out);
      else if (!equal(va, vb)) out.push({ path: p, from: va, to: vb });
    });
    return out;
  }

  /* ---------------------------------------------------------------- timing */

  function debounce(fn, ms) {
    var t = null;
    function d() {
      var ctx = this, args = arguments;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(ctx, args); }, ms);
    }
    d.cancel = function () { if (t) clearTimeout(t); t = null; };
    d.flush = function () { if (t) { clearTimeout(t); t = null; fn(); } };
    return d;
  }

  function throttle(fn, ms) {
    var last = 0, timer = null, lastArgs;
    return function () {
      var now = Date.now(); lastArgs = arguments;
      var ctx = this;
      if (now - last >= ms) { last = now; fn.apply(ctx, lastArgs); }
      else if (!timer) {
        timer = setTimeout(function () { last = Date.now(); timer = null; fn.apply(ctx, lastArgs); }, ms - (now - last));
      }
    };
  }

  var uidCounter = 0;
  function uid(prefix) {
    uidCounter = (uidCounter + 1) % 1679616;
    return (prefix || 'id') + '_' + Date.now().toString(36) +
      Math.floor(Math.random() * 1679616).toString(36).padStart(4, '0') + uidCounter.toString(36);
  }

  /* ---------------------------------------------------------------- color */

  function hexToRgb(hex) {
    if (typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
    var h = hex.trim().replace(/^#/, '');
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map(function (c) { return c + c; }).join('');
    if (h.length === 8) h = h.slice(0, 6);
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 0, g: 0, b: 0 };
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHex(r, g, b) {
    if (typeof r === 'object' && r) { g = r.g; b = r.b; r = r.r; }
    function c(v) { return Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0'); }
    return '#' + c(r) + c(g) + c(b);
  }

  function isHex(s) { return typeof s === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.trim()); }

  /** Normalise any 3/6-digit hex to lowercase #rrggbb (fallback if invalid). */
  function normHex(s, fallback) {
    if (!isHex(s)) return fallback === undefined ? '#000000' : fallback;
    return rgbToHex(hexToRgb(s));
  }

  /** shade(hex, pct): pct in -100..100 (or -1..1). Negative darkens towards black, positive lightens towards white. */
  function shade(hex, pct) {
    var p = Math.abs(pct) > 1 ? pct / 100 : pct;
    var c = hexToRgb(hex);
    var t = p < 0 ? 0 : 255, a = Math.abs(p);
    return rgbToHex(c.r + (t - c.r) * a, c.g + (t - c.g) * a, c.b + (t - c.b) * a);
  }

  function mix(a, b, t) {
    var x = hexToRgb(a), y = hexToRgb(b);
    t = t == null ? 0.5 : t;
    return rgbToHex(lerp(x.r, y.r, t), lerp(x.g, y.g, t), lerp(x.b, y.b, t));
  }

  /** Relative luminance 0..1 (WCAG). */
  function luminance(hex) {
    var c = hexToRgb(hex);
    function ch(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }

  /** Pick readable text color for a background. */
  function contrastText(hex) { return luminance(hex) > 0.42 ? '#111111' : '#ffffff'; }

  function rgbToHsl(hex) {
    var c = hexToRgb(hex), r = c.r / 255, g = c.g / 255, b = c.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: s, l: l };
  }

  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
  }

  /** Rotate hue (degrees) — used by chameleon paint. */
  function hueShift(hex, deg) {
    var hsl = rgbToHsl(hex);
    return hslToHex(hsl.h + deg, hsl.s, hsl.l);
  }

  /* ---------------------------------------------------------------- DOM */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SVG_TAGS = /^(svg|g|path|rect|circle|ellipse|line|polyline|polygon|text|tspan|defs|linearGradient|radialGradient|stop|clipPath|mask|use|pattern|filter|fe[A-Z]\w*|symbol|title|desc)$/;

  /**
   * el(tag, attrs, ...children)
   *  - tag: 'div', 'button.cb-btn.primary', 'span#id.cls'  (class/id shorthand supported)
   *  - attrs: { class, className, style (string|object), dataset:{}, on:{click:fn}, onclick:fn, html:'raw', text:'', ...attributes }
   *    boolean true => attribute present, false/null/undefined => omitted. Props like value/checked are set as properties.
   *  - children: strings, numbers, Nodes, arrays (flattened), null/false skipped.
   */
  function el(tag, attrs) {
    if (!hasDOM) return null;
    var children = Array.prototype.slice.call(arguments, 2);
    if (attrs && (typeof attrs !== 'object' || attrs.nodeType || Array.isArray(attrs))) {
      children.unshift(attrs); attrs = null;
    }
    var m = String(tag).match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/);
    var name = (m && m[1]) || 'div', extras = (m && m[2]) || '';
    var isSvg = SVG_TAGS.test(name) || (attrs && attrs.svg);
    var node = isSvg ? document.createElementNS(SVG_NS, name) : document.createElement(name);
    extras.replace(/([.#])([\w-]+)/g, function (_, t, v) {
      if (t === '#') node.setAttribute('id', v); else node.classList.add(v);
      return '';
    });
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === undefined || v === null || v === false || k === 'svg') return;
        if (k === 'class' || k === 'className') {
          String(v).split(/\s+/).filter(Boolean).forEach(function (c) { node.classList.add(c); });
        } else if (k === 'style') {
          if (typeof v === 'string') node.setAttribute('style', v);
          else Object.keys(v).forEach(function (sk) {
            if (sk.indexOf('--') === 0) node.style.setProperty(sk, v[sk]); else node.style[sk] = v[sk];
          });
        } else if (k === 'dataset') {
          Object.keys(v).forEach(function (dk) { node.dataset[dk] = v[dk]; });
        } else if (k === 'on') {
          Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); });
        } else if (k.indexOf('on') === 0 && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'html') {
          node.innerHTML = v;
        } else if (k === 'text') {
          node.textContent = v;
        } else if (!isSvg && (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'indeterminate')) {
          node[k] = v;
          if (k === 'disabled' && v) node.setAttribute('disabled', '');
        } else if (v === true) {
          node.setAttribute(k, '');
        } else {
          node.setAttribute(k, String(v));
        }
      });
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c === null || c === undefined || c === false || c === true) continue;
      if (Array.isArray(c)) appendChildren(node, c);
      else if (c.nodeType) node.appendChild(c);
      else node.appendChild(document.createTextNode(String(c)));
    }
  }

  /** Parse an SVG/HTML string into a DOM node (first element). */
  function htmlToNode(html) {
    if (!hasDOM) return null;
    var t = document.createElement('template');
    t.innerHTML = String(html).trim();
    return t.content.firstElementChild || t.content.firstChild;
  }

  function clear(node) { if (node) while (node.firstChild) node.removeChild(node.firstChild); return node; }

  /* ---------------------------------------------------------------- strings / encoding */

  /** UTF-8 safe base64url encode/decode (works in browsers and Node). */
  function b64urlEncode(str) {
    var b64;
    if (typeof Buffer !== 'undefined' && typeof btoa === 'undefined') {
      b64 = Buffer.from(String(str), 'utf8').toString('base64');
    } else if (typeof TextEncoder !== 'undefined') {
      var bytes = new TextEncoder().encode(String(str)), bin = '';
      for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      b64 = btoa(bin);
    } else {
      b64 = btoa(unescape(encodeURIComponent(String(str))));
    }
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(s) {
    var b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    if (typeof Buffer !== 'undefined' && typeof atob === 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
    var bin = atob(b64);
    if (typeof TextDecoder !== 'undefined') {
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(escape(bin));
  }

  function slugify(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function capitalize(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  /** Small deterministic string hash (FNV-1a 32 bit) -> unsigned int. */
  function hash(str) {
    var h = 0x811c9dc5;
    str = String(str);
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }

  /** Format a 0..1 or 0..100 fraction as percent. */
  function fmtPct(v, d) { return fmtNum(Math.abs(v) <= 1 ? v * 100 : v, d || 0) + '%'; }

  function fmtDate(ms) {
    try { return new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return String(new Date(ms)); }
  }

  /** Unit conversions used throughout the UI. */
  var units = {
    kgToLb: function (kg) { return kg * 2.20462; },
    kwToHp: function (kw) { return kw * 1.34102; },
    hpToKw: function (hp) { return hp / 1.34102; },
    nmToLbft: function (nm) { return nm * 0.737562; },
    kphToMph: function (k) { return k * 0.621371; },
    mmToIn: function (mm) { return mm / 25.4; },
    inToMm: function (i) { return i * 25.4; },
    l100ToMpg: function (l) { return l > 0 ? 235.215 / l : 0; }
  };

  CB.util = {
    clamp: clamp, lerp: lerp, invLerp: invLerp, round: round, snap: snap, nearest: nearest,
    fmtMoney: fmtMoney, fmtNum: fmtNum, fmtPct: fmtPct, fmtDate: fmtDate,
    isPlainObject: isPlainObject, deepClone: deepClone, deepMerge: deepMerge, get: get, set: set,
    equal: equal, diff: diff, splitPath: splitPath,
    debounce: debounce, throttle: throttle, uid: uid,
    hexToRgb: hexToRgb, rgbToHex: rgbToHex, isHex: isHex, normHex: normHex, shade: shade, mix: mix,
    luminance: luminance, contrastText: contrastText, rgbToHsl: rgbToHsl, hslToHex: hslToHex, hueShift: hueShift,
    el: el, htmlToNode: htmlToNode, clear: clear, escapeHtml: escapeHtml,
    b64urlEncode: b64urlEncode, b64urlDecode: b64urlDecode, slugify: slugify, capitalize: capitalize, hash: hash,
    units: units, hasDOM: hasDOM
  };
})();

if (typeof module !== 'undefined') module.exports = CB.util;
