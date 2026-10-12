/* ==========================================================================
   FORGE Atelier — js/charts.js
   CB.charts : Canvas 2D instrumentation for the configurator.

   Every factory has the shape   CB.charts.<kind>(canvas, data, compare?, opts?)  and returns a handle:
       {
         redraw(newData, newCompare?, newOpts?)  update in place (no re-creation, keeps hover state).
                                                 Pass newCompare === null to clear the comparison series;
                                                 omit it to keep the current one.
         update(...)                             alias of redraw
         setCompare(compare)                     set / clear (null) the comparison series
         setOptions(partialOpts)                 merge options and redraw
         resize()                                force a re-measure
         destroy()                               remove listeners / observers, clear the canvas
         canvas, kind
       }

   Factories (SPEC §CB.charts):
       dyno(canvas, metrics, compareMetrics?, opts?)     power + torque vs rpm (dual aligned axes), peak markers,
                                                         power band, redline band.  opts: {powerUnit:'hp'|'kw',
                                                         torqueUnit:'nm'|'lbft', label, compareLabel}
       accel(canvas, metrics, compareMetrics?, opts?)    speed vs time, gear bands, shift markers, 0-100 / 0-200
                                                         (or 0-60 / 0-100 mph) and quarter-mile markers, Vmax.
                                                         opts: {units:'metric'|'imperial'}
       gears(canvas, metrics, opts?)                     sawtooth rpm vs road speed per gear, redline band,
                                                         shift drops, peak-power line.  opts: {units}
       radar(canvas, ratings, compareRatings?, opts?)    10-axis ratings radar (accepts ratings or metrics)
       downforce(canvas, metrics, compareMetrics?, opts?) downforce vs drag force (both kgf) vs speed
       weight(canvas, metrics, opts?)                    front/rear distribution bar, corner weights, CG and a
                                                         mass breakdown (metrics.weightBreakdown if supplied,
                                                         otherwise estimated from opts.build || CB.state.get()).
       priceDonut(canvas, pricing, opts?)                price composition by group, hover pop-out, center total
       amortization(canvas, financeResult, opts?)        stacked principal / interest per payment + balance line

   Notes
     * HiDPI: backing store = CSS size x devicePixelRatio.
     * Size: the canvas is set to width:100%. Height = opts.height, else the CSS height if the author gave the
       canvas one, else it fills its parent's free height, else falls back to an aspect ratio per chart kind.
     * Theme: CSS variables (--bg --panel --panel-2 --line --text --text-dim --accent --accent-2 --good --warn --bad
       --font --mono, optional --chart-1..--chart-8) are read at draw time; a MutationObserver on <html>/<body>
       attributes redraws all live charts when the theme flips.
     * Charts whose canvas is detached from the document for > 2 s destroy themselves (panels that re-render
       without calling destroy() do not leak observers).
     * Keyboard: canvases are focusable; arrow keys walk data points / axes / segments, Esc clears.
     * Animates in on first visible draw (300 ms ease-out); radar / weight / donut morph on redraw.
   ========================================================================== */
window.CB = window.CB || {};

(function (CB) {
  'use strict';

  var HAS_DOM = typeof document !== 'undefined' && typeof window !== 'undefined';
  var U = CB.util || {};

  /* ------------------------------------------------------------------ small helpers */
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { v = Number(v); return isFinite(v) ? v : (d === undefined ? 0 : d); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function arr(a) { return Array.isArray(a) ? a : []; }
  function last(a) { return a[a.length - 1]; }
  function easeOut(t) { return 1 - Math.pow(1 - clamp(t, 0, 1), 3); }
  function easeInOut(t) { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  function fmtN(n, d) {
    if (typeof U.fmtNum === 'function') return U.fmtNum(n, d || 0);
    n = Number(n); if (!isFinite(n)) return '—';
    return n.toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function fmtMoney(n, compact) {
    if (typeof U.fmtMoney === 'function') return U.fmtMoney(Math.round(n), { compact: !!compact });
    n = Math.round(Number(n) || 0);
    var s = n < 0 ? '-' : '', a = Math.abs(n);
    if (compact && a >= 1e6) return s + '$' + (a / 1e6).toFixed(2) + 'M';
    if (compact && a >= 1e3) return s + '$' + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k';
    return s + '$' + fmtN(a, 0);
  }
  function signed(n, d, unit) {
    if (!isFinite(n)) return '';
    var s = n > 0 ? '+' : n < 0 ? '−' : '±';
    return s + fmtN(Math.abs(n), d) + (unit ? ' ' + unit : '');
  }
  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function titleCase(s) {
    return String(s || '').replace(/[-_.]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function decimalsFor(step) {
    if (!isFinite(step) || step <= 0) return 0;
    if (step >= 1) return Math.abs(step - Math.round(step)) < 1e-9 ? 0 : 1;
    return clamp(Math.ceil(-Math.log10(step) - 1e-9), 0, 4);
  }

  /* ------------------------------------------------------------------ nice-number ticks */
  function niceNum(range, round) {
    if (!(range > 0)) return 1;
    var e = Math.floor(Math.log10(range)), f = range / Math.pow(10, e), nf;
    if (round) nf = f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10;
    else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nf * Math.pow(10, e);
  }
  /** smallest "nice" step (1, 2, 2.5, 5 x 10^k) that is >= v */
  function niceCeil(v) {
    if (!(v > 0)) return 1;
    var e = Math.floor(Math.log10(v)), b = Math.pow(10, e), m = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < m.length; i++) if (m[i] * b >= v - 1e-9 * b) return m[i] * b;
    return 10 * b;
  }
  /** Heckbert nice ticks.  fixed=true keeps [min,max] as the domain and only returns ticks inside it. */
  function niceTicks(min, max, count, fixed) {
    min = num(min, 0); max = num(max, 1);
    if (max < min) { var tmp = min; min = max; max = tmp; }
    if (max - min < 1e-9) { max = min + (Math.abs(min) > 1 ? Math.abs(min) * 0.1 : 1); }
    count = Math.max(2, count || 5);
    var step = niceNum(niceNum(max - min, false) / (count - 1), true);
    var lo = Math.floor(min / step + 1e-9) * step, hi = Math.ceil(max / step - 1e-9) * step;
    var dmin = fixed ? min : lo, dmax = fixed ? max : hi;
    var ticks = [], d = decimalsFor(step);
    for (var v = fixed ? Math.ceil(min / step - 1e-9) * step : lo; v <= dmax + step * 1e-6; v += step) {
      ticks.push(Number(v.toFixed(d + 2)));
      if (ticks.length > 60) break;
    }
    return { min: dmin, max: dmax, step: step, ticks: ticks, decimals: d };
  }

  /* ------------------------------------------------------------------ color helpers */
  var colorCache = {}, colorCtx = null;
  function parseColor(c) {
    c = String(c || '').trim();
    if (colorCache[c]) return colorCache[c];
    var out = { r: 128, g: 128, b: 128, a: 1 }, s = c;
    if (HAS_DOM) {
      try {
        colorCtx = colorCtx || document.createElement('canvas').getContext('2d');
        colorCtx.fillStyle = '#808080'; colorCtx.fillStyle = c; s = String(colorCtx.fillStyle);
      } catch (e) { s = c; }
    }
    var m;
    if (s.charAt(0) === '#') {
      var h = s.slice(1);
      if (h.length === 3) h = h.replace(/./g, '$&$&');
      out = { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
      if (h.length === 8) out.a = parseInt(h.slice(6, 8), 16) / 255;
    } else if ((m = s.match(/rgba?\(([^)]+)\)/))) {
      var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
      out = { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    if (!isFinite(out.r)) out = { r: 128, g: 128, b: 128, a: 1 };
    colorCache[c] = out;
    return out;
  }
  function rgba(c, a) {
    var p = parseColor(c);
    return 'rgba(' + Math.round(p.r) + ',' + Math.round(p.g) + ',' + Math.round(p.b) + ',' + clamp((a == null ? 1 : a) * p.a, 0, 1).toFixed(3) + ')';
  }
  function mixColor(c1, c2, t) {
    var a = parseColor(c1), b = parseColor(c2);
    return 'rgb(' + Math.round(lerp(a.r, b.r, t)) + ',' + Math.round(lerp(a.g, b.g, t)) + ',' + Math.round(lerp(a.b, b.b, t)) + ')';
  }
  function luminance(c) {
    var p = parseColor(c);
    function ch(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(p.r) + 0.7152 * ch(p.g) + 0.0722 * ch(p.b);
  }

  /* ------------------------------------------------------------------ theme (read at draw time) */
  var FALLBACK_DARK = {
    bg: '#0b0b0d', bg2: '#111114', panel: '#141519', panel2: '#1b1c21', line: '#2b2c33', text: '#ecebe6',
    textDim: '#9b9890', accent: '#c9a56b', accent2: '#6aa6d8', good: '#3fbf7f', warn: '#e3a33a', bad: '#e5484d'
  };
  var FALLBACK_LIGHT = {
    bg: '#f6f5f2', bg2: '#efede8', panel: '#ffffff', panel2: '#f4f2ee', line: '#dedad2', text: '#16161a',
    textDim: '#66635c', accent: '#9a7436', accent2: '#2a6fb0', good: '#1f8f57', warn: '#b7791f', bad: '#c9302c'
  };
  // Validated categorical palette (dataviz reference instance), dark + light steps.
  var CAT_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
  var CAT_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
  var FONT = 'Inter, "SF Pro Display", "Segoe UI", system-ui, -apple-system, sans-serif';
  var MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

  function readTheme(el) {
    var cs = null;
    try { cs = HAS_DOM ? getComputedStyle(el && el.isConnected ? el : document.documentElement) : null; } catch (e) { cs = null; }
    var lightAttr = HAS_DOM && document.documentElement.getAttribute('data-theme') === 'light';
    var FB = lightAttr ? FALLBACK_LIGHT : FALLBACK_DARK;
    function v(name, fb) {
      var s = cs ? cs.getPropertyValue(name) : '';
      s = s && s.trim();
      return s || fb;
    }
    var th = {
      bg: v('--bg', FB.bg), bg2: v('--bg-2', FB.bg2), panel: v('--panel', FB.panel), panel2: v('--panel-2', FB.panel2),
      line: v('--line', FB.line), text: v('--text', FB.text), textDim: v('--text-dim', FB.textDim),
      accent: v('--accent', FB.accent), accent2: v('--accent-2', FB.accent2),
      good: v('--good', FB.good), warn: v('--warn', FB.warn), bad: v('--bad', FB.bad),
      font: v('--font', FONT), mono: v('--mono', MONO)
    };
    th.dark = luminance(th.panel) < 0.35;
    var cat = th.dark ? CAT_DARK : CAT_LIGHT;
    th.cat = cat.map(function (c, i) { return v('--chart-' + (i + 1), c); });
    // Surface the chart sits on (for 2px gaps / rings): the closest non-transparent background.
    th.surface = th.panel;
    try {
      var n = el && el.isConnected ? el : null, guard = 0;
      while (n && n.nodeType === 1 && guard++ < 12) {
        var bgc = getComputedStyle(n).backgroundColor;
        if (bgc && bgc !== 'transparent' && parseColor(bgc).a > 0.5) { th.surface = bgc; break; }
        n = n.parentElement;
      }
    } catch (e) { /* keep panel */ }
    th.grid = rgba(th.line, th.dark ? 0.75 : 0.9);
    th.gridFaint = rgba(th.line, th.dark ? 0.38 : 0.5);
    th.axis = mixColor(th.line, th.textDim, 0.35);
    th.tipBg = rgba(th.dark ? mixColor(th.panel2, '#000', 0.15) : th.panel, 0.97);
    th.shadow = th.dark ? 'rgba(0,0,0,0.45)' : 'rgba(20,20,30,0.16)';
    return th;
  }
  function font(th, size, weight, mono) { return (weight || 400) + ' ' + size + 'px ' + (mono ? th.mono : th.font); }

  /* ------------------------------------------------------------------ drawing primitives */
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function crisp(v) { return Math.round(v) + 0.5; }
  function hline(ctx, x0, x1, y, color, width, dash) {
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width || 1; ctx.setLineDash(dash || []);
    ctx.beginPath(); ctx.moveTo(x0, crisp(y)); ctx.lineTo(x1, crisp(y)); ctx.stroke(); ctx.restore();
  }
  function vline(ctx, x, y0, y1, color, width, dash) {
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width || 1; ctx.setLineDash(dash || []);
    ctx.beginPath(); ctx.moveTo(crisp(x), y0); ctx.lineTo(crisp(x), y1); ctx.stroke(); ctx.restore();
  }
  function hatch(ctx, x, y, w, h, color, spacing) {
    if (w <= 0 || h <= 0) return;
    spacing = spacing || 6;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
    for (var i = -h; i < w + h; i += spacing) { ctx.moveTo(x + i, y + h); ctx.lineTo(x + i + h, y); }
    ctx.stroke(); ctx.restore();
  }
  function dot(ctx, x, y, r, fill, ring, ringW) {
    ctx.beginPath(); ctx.arc(x, y, r + (ring ? (ringW || 2) : 0), 0, Math.PI * 2);
    if (ring) { ctx.fillStyle = ring; ctx.fill(); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }
    ctx.fillStyle = fill; ctx.fill();
  }
  function ringDot(ctx, x, y, r, stroke, fill) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 1.75; ctx.strokeStyle = stroke; ctx.stroke();
  }
  function diamond(ctx, x, y, r, fill, ring) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
    if (ring) { ctx.fillStyle = ring; ctx.fillRect(-r - 1.5, -r - 1.5, 2 * r + 3, 2 * r + 3); }
    ctx.fillStyle = fill; ctx.fillRect(-r, -r, 2 * r, 2 * r); ctx.restore();
  }

  /** Monotone cubic (Fritsch–Carlson) path through screen points – smooth without overshoot. */
  function traceSmooth(ctx, pts, moveFirst) {
    var n = pts.length;
    if (!n) return;
    if (moveFirst !== false) ctx.moveTo(pts[0][0], pts[0][1]); else ctx.lineTo(pts[0][0], pts[0][1]);
    if (n < 3) { for (var k = 1; k < n; k++) ctx.lineTo(pts[k][0], pts[k][1]); return; }
    var dx = [], dy = [], m = [], t = [], i;
    for (i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; dy[i] = pts[i + 1][1] - pts[i][1]; m[i] = dx[i] ? dy[i] / dx[i] : 0; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (i = 1; i < n - 1; i++) t[i] = (m[i - 1] * m[i] <= 0) ? 0 : (m[i - 1] + m[i]) / 2;
    for (i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
      var a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
      if (s > 9) { var tau = 3 / Math.sqrt(s); t[i] = tau * a * m[i]; t[i + 1] = tau * b * m[i]; }
    }
    for (i = 0; i < n - 1; i++) {
      var h = dx[i] / 3;
      ctx.bezierCurveTo(pts[i][0] + h, pts[i][1] + h * t[i], pts[i + 1][0] - h, pts[i + 1][1] - h * t[i + 1], pts[i + 1][0], pts[i + 1][1]);
    }
  }
  function strokeSeries(ctx, pts, color, width, dash, alpha) {
    if (pts.length < 2) return;
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = color; ctx.lineWidth = width || 2; ctx.setLineDash(dash || []);
    ctx.beginPath(); traceSmooth(ctx, pts); ctx.stroke(); ctx.restore();
  }
  function fillUnder(ctx, pts, baseY, topY, color, a0, a1) {
    if (pts.length < 2) return;
    ctx.save();
    var g = ctx.createLinearGradient(0, topY, 0, baseY);
    g.addColorStop(0, rgba(color, a0)); g.addColorStop(1, rgba(color, a1));
    ctx.fillStyle = g;
    ctx.beginPath(); traceSmooth(ctx, pts);
    ctx.lineTo(last(pts)[0], baseY); ctx.lineTo(pts[0][0], baseY); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /** Label pill.  opts: {align:'left'|'center'|'right', vAlign:'top'|'middle'|'bottom', color, bg, border, size, mono, weight, bounds} */
  function pill(ctx, th, text, x, y, o) {
    o = o || {};
    var size = o.size || 10.5, padX = o.padX != null ? o.padX : 6, h = size + 8;
    ctx.save();
    ctx.font = font(th, size, o.weight || 600, o.mono !== false);
    var w = ctx.measureText(text).width + padX * 2;
    var bx = o.align === 'right' ? x - w : o.align === 'left' ? x : x - w / 2;
    var by = o.vAlign === 'bottom' ? y - h : o.vAlign === 'top' ? y : y - h / 2;
    if (o.bounds) {
      bx = clamp(bx, o.bounds.l, Math.max(o.bounds.l, o.bounds.r - w));
      by = clamp(by, o.bounds.t, Math.max(o.bounds.t, o.bounds.b - h));
    }
    if (!o.measureOnly) {
      roundRect(ctx, bx, by, w, h, h / 2);
      ctx.fillStyle = o.bg || th.tipBg; ctx.fill();
      if (o.border !== false) { ctx.lineWidth = 1; ctx.strokeStyle = o.border || th.line; ctx.stroke(); }
      ctx.fillStyle = o.color || th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + w / 2, by + h / 2 + 0.5);
    }
    ctx.restore();
    return { x: bx, y: by, w: w, h: h };
  }
  function rectsOverlap(a, b, pad) {
    pad = pad || 0;
    return a && b && a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
  }

  /** Legend (line keys for lines, rect keys for areas/bars).  Returns total height used. */
  function legendLayout(ctx, th, items, maxW) {
    ctx.font = font(th, 11, 500);
    var rows = [[]], x = 0, rowH = 18;
    items.forEach(function (it) {
      var w = 18 + ctx.measureText(it.label).width + 16;
      if (x + w > maxW && rows[rows.length - 1].length) { rows.push([]); x = 0; }
      rows[rows.length - 1].push({ it: it, x: x, w: w });
      x += w;
    });
    return { rows: rows, h: rows.length * rowH, rowH: rowH };
  }
  function drawLegend(ctx, th, items, x, y, maxW) {
    if (!items || !items.length) return 0;
    var L = legendLayout(ctx, th, items, maxW);
    ctx.save();
    ctx.font = font(th, 11, 500); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    L.rows.forEach(function (row, ri) {
      var cy = y + ri * L.rowH + L.rowH / 2;
      row.forEach(function (cell) {
        var it = cell.it, kx = x + cell.x;
        ctx.globalAlpha = it.alpha == null ? 1 : it.alpha;
        if (it.type === 'rect') {
          roundRect(ctx, kx, cy - 5, 12, 10, 2); ctx.fillStyle = it.color; ctx.fill();
        } else if (it.type === 'band') {
          ctx.fillStyle = rgba(it.color, 0.22); ctx.fillRect(kx, cy - 6, 12, 12);
          hatch(ctx, kx, cy - 6, 12, 12, rgba(it.color, 0.6), 4);
        } else {
          ctx.strokeStyle = it.color; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.setLineDash(it.dash || []);
          ctx.beginPath(); ctx.moveTo(kx, cy); ctx.lineTo(kx + 13, cy); ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = th.textDim;
        ctx.fillText(it.label, kx + 18, cy + 0.5);
      });
    });
    ctx.restore();
    return L.h;
  }

  /** Tooltip.  rows: [{label, value, color?, dash?, key:'line'|'dot'|'rect'|'none', sep?, dim?}] */
  function drawTip(ctx, env, ax, ay, title, rows) {
    var th = env.th, pad = 9, lh = 17;
    rows = rows.filter(Boolean);
    ctx.save();
    ctx.font = font(th, 10.5, 600);
    var tw = title ? ctx.measureText(String(title).toUpperCase()).width + 0.6 * String(title).length : 0;
    var lw = 0, vw = 0;
    rows.forEach(function (r) {
      if (r.sep) return;
      ctx.font = font(th, 11, 400); lw = Math.max(lw, ctx.measureText(r.label || '').width);
      ctx.font = font(th, 11.5, 600, true); vw = Math.max(vw, ctx.measureText(r.value == null ? '—' : String(r.value)).width);
    });
    var hasKey = rows.some(function (r) { return r.color; });
    var W = Math.max(tw, (hasKey ? 18 : 0) + lw + 18 + vw) + pad * 2;
    var H = pad * 2 + (title ? 17 : 0) + rows.reduce(function (s, r) { return s + (r.sep ? 7 : lh); }, 0) - 3;
    var x = ax + 16;
    if (x + W > env.w - 4) x = ax - 16 - W;
    if (x < 4) x = clamp(ax - W / 2, 4, env.w - W - 4);
    var y = clamp(ay - H / 2, 4, Math.max(4, env.h - H - 4));
    ctx.shadowColor = th.shadow; ctx.shadowBlur = 14; ctx.shadowOffsetY = 4;
    roundRect(ctx, x, y, W, H, 7); ctx.fillStyle = th.tipBg; ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.lineWidth = 1; ctx.strokeStyle = th.line; ctx.stroke();
    var cy = y + pad;
    ctx.textBaseline = 'middle';
    if (title) {
      ctx.font = font(th, 10.5, 600); ctx.fillStyle = th.textDim; ctx.textAlign = 'left';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0.6px';
      ctx.fillText(String(title).toUpperCase(), x + pad, cy + 6);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      cy += 17;
    }
    rows.forEach(function (r) {
      if (r.sep) { hline(ctx, x + pad, x + W - pad, cy + 2, th.gridFaint); cy += 7; return; }
      var my = cy + lh / 2 - 1.5, lx = x + pad;
      if (hasKey) {
        if (r.color) {
          if (r.key === 'rect') { roundRect(ctx, lx, my - 4.5, 10, 9, 2); ctx.fillStyle = r.color; ctx.fill(); }
          else if (r.key === 'dot') { dot(ctx, lx + 5, my, 3.5, r.color); }
          else {
            ctx.save(); ctx.strokeStyle = r.color; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.setLineDash(r.dash || []);
            ctx.beginPath(); ctx.moveTo(lx, my); ctx.lineTo(lx + 11, my); ctx.stroke(); ctx.restore();
          }
        }
        lx += 18;
      }
      ctx.font = font(th, 11, 400); ctx.fillStyle = th.textDim; ctx.textAlign = 'left';
      ctx.fillText(r.label || '', lx, my);
      ctx.font = font(th, 11.5, r.dim ? 400 : 600, true); ctx.fillStyle = r.dim ? th.textDim : (r.valueColor || th.text); ctx.textAlign = 'right';
      ctx.fillText(r.value == null ? '—' : String(r.value), x + W - pad, my);
      cy += lh;
    });
    ctx.restore();
  }

  function drawEmpty(ctx, env, msg, sub) {
    var th = env.th, w = env.w, h = env.h;
    ctx.save();
    ctx.strokeStyle = th.gridFaint; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    roundRect(ctx, 8.5, 8.5, w - 17, h - 17, 8); ctx.stroke(); ctx.setLineDash([]);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = font(th, 12, 600); ctx.fillStyle = th.textDim;
    ctx.fillText(msg || 'No data', w / 2, h / 2 - (sub ? 8 : 0));
    if (sub) { ctx.font = font(th, 11, 400); ctx.fillStyle = rgba(th.textDim, 0.75); ctx.fillText(sub, w / 2, h / 2 + 10); }
    ctx.restore();
    env.out.summary = msg || 'No data';
  }

  /* ------------------------------------------------------------------ cartesian frame */
  /**
   * cfg: { top, x:{min,max,fixed,fmt,title,ticks?}, y:{min,max,fmt,title,key}, y2?:{max,fmt,title,key} }
   * The y2 axis shares the y gridlines: its step is the smallest nice step covering y2.max over the same
   * number of intervals, so both scales land exactly on the same lines.
   */
  function xyFrame(ctx, env, cfg) {
    var th = env.th, w = env.w, h = env.h;
    var top = cfg.top || 12;
    var bottom = h - (8 + 13 + (cfg.x.title ? 16 : 0));
    var ph = Math.max(10, bottom - top);
    var ny = clamp(Math.round(ph / 44) + 1, 3, 8);
    var yt = niceTicks(num(cfg.y.min, 0), Math.max(num(cfg.y.max, 1), num(cfg.y.min, 0) + 1e-6), ny);
    var y2t = null;
    if (cfg.y2) {
      var n = yt.ticks.length - 1, st = niceCeil(Math.max(num(cfg.y2.max, 1), 1e-6) / n), d2 = decimalsFor(st);
      y2t = { min: 0, max: st * n, step: st, decimals: d2, ticks: [] };
      for (var i = 0; i <= n; i++) y2t.ticks.push(Number((st * i).toFixed(d2 + 2)));
    }
    var yf = cfg.y.fmt || function (v) { return fmtN(v, yt.decimals); };
    var y2f = cfg.y2 ? (cfg.y2.fmt || function (v) { return fmtN(v, y2t.decimals); }) : null;
    ctx.font = font(th, 10.5, 400, true);
    var yw = 0, y2w = 0;
    yt.ticks.forEach(function (v) { yw = Math.max(yw, ctx.measureText(yf(v)).width); });
    if (y2t) y2t.ticks.forEach(function (v) { y2w = Math.max(y2w, ctx.measureText(y2f(v)).width); });
    var l = 8 + (cfg.y.title ? 17 : 0) + yw + 8;
    var r = w - (y2t ? 8 + (cfg.y2.title ? 17 : 0) + y2w + 8 : 16);
    var pw = Math.max(10, r - l);
    var nx = clamp(Math.floor(pw / 74) + 1, 2, 12);
    var xt = cfg.x.ticks || niceTicks(cfg.x.min, cfg.x.max, nx, !!cfg.x.fixed);
    var F = {
      l: l, r: r, t: top, b: bottom, pw: pw, ph: ph, x: xt, y: yt, y2: y2t, cfg: cfg,
      xf: cfg.x.fmt || function (v) { return fmtN(v, xt.decimals); }, yf: yf, y2f: y2f
    };
    F.sx = function (v) { return l + (v - xt.min) / ((xt.max - xt.min) || 1) * pw; };
    F.ix = function (px) { return xt.min + (px - l) / pw * (xt.max - xt.min); };
    F.sy = function (v) { return bottom - (v - yt.min) / ((yt.max - yt.min) || 1) * ph; };
    F.sy2 = y2t ? function (v) { return bottom - v / (y2t.max || 1) * ph; } : F.sy;
    F.inside = function (p, padX) { padX = padX || 0; return p && p.x >= l - padX && p.x <= r + padX && p.y >= top - 10 && p.y <= bottom + 18; };
    return F;
  }
  function drawXYGrid(ctx, env, F) {
    var th = env.th, cfg = F.cfg;
    ctx.save();
    // vertical grid
    F.x.ticks.forEach(function (v) {
      var x = F.sx(v);
      if (x < F.l + 1 || x > F.r - 1) return;
      vline(ctx, x, F.t, F.b, th.gridFaint);
    });
    // horizontal grid
    F.y.ticks.forEach(function (v, i) {
      var y = F.sy(v);
      hline(ctx, F.l, F.r, y, i === 0 ? th.axis : th.grid, 1, i === 0 ? null : [2, 3]);
    });
    // tick labels
    ctx.font = font(th, 10.5, 400, true); ctx.fillStyle = th.textDim; ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    F.y.ticks.forEach(function (v) { ctx.fillText(F.yf(v), F.l - 8, F.sy(v)); });
    if (F.y2) { ctx.textAlign = 'left'; F.y2.ticks.forEach(function (v) { ctx.fillText(F.y2f(v), F.r + 8, F.sy2(v)); }); }
    ctx.textBaseline = 'top';
    F.x.ticks.forEach(function (v) {
      var x = F.sx(v), s = F.xf(v), tw = ctx.measureText(s).width;
      if (x < F.l - 2 || x > F.r + 2) return;
      ctx.textAlign = 'left';
      ctx.fillText(s, clamp(x - tw / 2, 2, env.w - tw - 2), F.b + 6);
    });
    // axis titles
    ctx.font = font(th, 10.5, 600); ctx.fillStyle = th.textDim;
    if (cfg.x.title) { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(cfg.x.title, F.l + F.pw / 2, env.h - 3); }
    function vTitle(text, x, rot, key) {
      ctx.save(); ctx.translate(x, F.t + F.ph / 2); ctx.rotate(rot);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var tw = ctx.measureText(text).width;
      if (key) {
        ctx.strokeStyle = key; ctx.lineWidth = 2; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-tw / 2 - 16, 0); ctx.lineTo(-tw / 2 - 5, 0); ctx.stroke();
      }
      ctx.fillText(text, key ? 0 : 0, 0.5);
      ctx.restore();
    }
    if (cfg.y.title) vTitle(cfg.y.title, 10, -Math.PI / 2, cfg.y.key);
    if (F.y2 && cfg.y2.title) vTitle(cfg.y2.title, env.w - 10, Math.PI / 2, cfg.y2.key);
    ctx.restore();
  }
  function xPill(ctx, env, F, x, text) {
    return pill(ctx, env.th, text, x, F.b + 2, { vAlign: 'top', size: 10, bg: env.th.text, color: env.th.surface, border: false, bounds: { l: 2, r: env.w - 2, t: 0, b: env.h } });
  }
  function crosshair(ctx, env, F, x) {
    vline(ctx, x, F.t, F.b, rgba(env.th.text, 0.45), 1, [3, 3]);
  }
  function revealClip(ctx, env, F) {
    ctx.beginPath(); ctx.rect(F.l - 4, 0, (F.pw + 8) * env.progress, env.h); ctx.clip();
  }
  function nearestIdx(list, key, v) {
    var lo = 0, hi = list.length - 1;
    if (hi < 0) return -1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (list[mid][key] < v) lo = mid; else hi = mid; }
    return Math.abs(list[lo][key] - v) <= Math.abs(list[hi][key] - v) ? lo : hi;
  }
  function interpAt(list, xKey, yKey, x) {
    if (!list.length) return null;
    if (x < list[0][xKey] || x > last(list)[xKey]) return null;
    var i = nearestIdx(list, xKey, x), a = list[i], b;
    if (a[xKey] === x) return a[yKey];
    b = a[xKey] < x ? list[i + 1] : list[i - 1];
    if (!b) return a[yKey];
    var t = (x - a[xKey]) / ((b[xKey] - a[xKey]) || 1);
    return lerp(a[yKey], b[yKey], t);
  }
  /** hover index from pointer or keyboard focus */
  function hoverIndex(env, F, list, key) {
    env.out.count = list.length;
    if (env.pointer && F.inside(env.pointer, 8)) {
      env.out.cursor = 'crosshair';
      return nearestIdx(list, key, F.ix(clamp(env.pointer.x, F.l, F.r)));
    }
    if (env.focusIdx != null && list.length) return clamp(env.focusIdx, 0, list.length - 1);
    return -1;
  }

  /* ------------------------------------------------------------------ registry / theme observer */
  var live = [];
  var themeObs = null, themeRaf = 0;
  function redrawAll() {
    live.slice().forEach(function (c) { if (!c.dead) c.schedule(); });
  }
  function ensureThemeWatch() {
    if (!HAS_DOM || themeObs) return;
    var fire = function () {
      if (themeRaf) return;
      themeRaf = requestAnimationFrame(function () { themeRaf = 0; colorCache = {}; redrawAll(); });
    };
    try {
      themeObs = new MutationObserver(fire);
      themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
      if (document.body) themeObs.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    } catch (e) { themeObs = { disconnect: function () {} }; }
    try {
      var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
      if (mq && mq.addEventListener) mq.addEventListener('change', fire);
    } catch (e) { /* ignore */ }
    try { window.addEventListener('resize', function () { live.forEach(function (c) { c.needsMeasure = true; c.schedule(); }); }); } catch (e) { /* ignore */ }
  }
  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  /* ------------------------------------------------------------------ Chart core */
  var ANIM_MS = 300, MORPH_MS = 260;

  function Chart(canvas, kindName, data, compare, opts) {
    var self = this;
    this.kindName = kindName;
    this.kind = KINDS[kindName];
    this.canvas = canvas;
    this.data = data;
    this.compare = compare || null;
    this.opts = opts || {};
    this.ctx = canvas.getContext ? canvas.getContext('2d') : null;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.pointer = null; this.focusIdx = null; this.count = 0;
    this.animStart = null; this.progress = 0;
    this.morphStart = null; this.morphT = 1; this.prevSnapshot = null; this.snapshot = null;
    this.raf = 0; this.dead = false; this.needsMeasure = true; this.mode = null;
    this.wasConnected = !!canvas.isConnected; this.detachTimer = 0;

    if (canvas.__cbChart && canvas.__cbChart !== this && typeof canvas.__cbChart.destroy === 'function') {
      try { canvas.__cbChart.destroy(true); } catch (e) { /* ignore */ }
    }
    canvas.__cbChart = this;
    this.authorHeight = canvas.style.height;
    canvas.style.display = 'block';
    if (!canvas.style.width) canvas.style.width = '100%';
    canvas.style.touchAction = 'pan-y';
    if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');
    if (!canvas.getAttribute('role')) canvas.setAttribute('role', 'img');
    canvas.classList && canvas.classList.add('cb-canvas', 'cb-canvas-' + kindName);

    this.onMove = function (e) {
      var r = canvas.getBoundingClientRect();
      self.pointer = { x: e.clientX - r.left, y: e.clientY - r.top, type: e.pointerType };
      self.schedule();
    };
    this.onLeave = function () { self.pointer = null; self.schedule(); };
    this.onDown = function (e) { self.onMove(e); };
    this.onUp = function (e) {
      if (e.pointerType === 'touch') {
        clearTimeout(self.touchTimer);
        self.touchTimer = setTimeout(function () { self.pointer = null; self.schedule(); }, 2200);
      }
    };
    this.onKey = function (e) {
      var k = e.key, n = self.count || 0, wrap = !!(self.kind && self.kind.wrap);
      if (!n) return;
      var fi = self.focusIdx, step = e.shiftKey ? Math.max(1, Math.round(n / 10)) : 1;
      if (k === 'ArrowRight' || k === 'ArrowUp') fi = fi == null ? 0 : fi + step;
      else if (k === 'ArrowLeft' || k === 'ArrowDown') fi = fi == null ? (wrap ? n - 1 : 0) : fi - step;
      else if (k === 'Home') fi = 0;
      else if (k === 'End') fi = n - 1;
      else if (k === 'Escape') fi = null;
      else return;
      e.preventDefault();
      if (fi != null) fi = wrap ? ((fi % n) + n) % n : clamp(fi, 0, n - 1);
      self.focusIdx = fi; self.pointer = null; self.schedule();
    };
    this.onBlur = function () { self.focusIdx = null; self.schedule(); };

    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('pointercancel', this.onLeave);
    canvas.addEventListener('keydown', this.onKey);
    canvas.addEventListener('blur', this.onBlur);

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(function () { self.needsMeasure = true; self.checkAttached(); self.schedule(); });
      this.ro.observe(canvas);
      if (canvas.parentElement) { this.roParent = canvas.parentElement; this.ro.observe(canvas.parentElement); }
    }
    ensureThemeWatch();
    live.push(this);
    this.schedule();
  }

  Chart.prototype.checkAttached = function () {
    var self = this;
    if (this.canvas.isConnected) {
      this.wasConnected = true;
      if (this.ro && this.canvas.parentElement && this.canvas.parentElement !== this.roParent) {
        try { if (this.roParent) this.ro.unobserve(this.roParent); } catch (e) { /* ignore */ }
        this.roParent = this.canvas.parentElement; this.ro.observe(this.roParent);
      }
      return;
    }
    if (!this.wasConnected || this.detachTimer) return;
    this.detachTimer = setTimeout(function () {
      self.detachTimer = 0;
      if (!self.canvas.isConnected) self.destroy();
    }, 2000);
  };

  Chart.prototype.measure = function () {
    var c = this.canvas, p = c.parentElement;
    if (!c.isConnected) return false;
    var rect = c.getBoundingClientRect();
    var w = rect.width;
    if (!(w > 1)) return false; // hidden (display:none tab) – wait for ResizeObserver
    var h;
    if (this.opts.height) {
      h = this.opts.height; c.style.height = h + 'px';
    } else {
      if (this.mode == null) {
        if (this.authorHeight) this.mode = 'css';
        else {
          // A canvas with height:auto takes its height from the backing store's aspect ratio, so probe
          // two different intrinsic aspects: if the rendered height follows them, nothing in CSS sizes the
          // height and we pick it ourselves ('auto'); if it stays put, a stylesheet / flex parent owns it.
          var aw = c.width, ah = c.height;
          c.style.height = '';
          c.width = 100; c.height = 10;
          var h1 = c.getBoundingClientRect().height;
          c.height = 200;
          var h2 = c.getBoundingClientRect().height;
          this.mode = (Math.abs(h2 - h1) < 1 && h1 > 4) ? 'css' : 'auto';
          c.width = aw; c.height = ah;
        }
      }
      if (this.mode === 'css') {
        h = c.getBoundingClientRect().height;
      } else {
        var kind = this.kind || {};
        c.style.height = '0px';
        var avail = 0;
        if (p) {
          var cs = getComputedStyle(p);
          avail = p.clientHeight - num(parseFloat(cs.paddingTop)) - num(parseFloat(cs.paddingBottom));
          var isRow = cs.display.indexOf('flex') >= 0 && cs.flexDirection.indexOf('row') === 0;
          if (!isRow) {
            for (var i = 0; i < p.children.length; i++) {
              var ch = p.children[i];
              if (ch === c) continue;
              var ccs = getComputedStyle(ch);
              if (ccs.position === 'absolute' || ccs.position === 'fixed' || ccs.display === 'none') continue;
              avail -= ch.offsetHeight + num(parseFloat(ccs.marginTop)) + num(parseFloat(ccs.marginBottom));
            }
          }
        }
        if (avail >= 80) h = avail;
        else if (typeof kind.heightFor === 'function') {
          // content-aware height (e.g. a stacked donut + legend in a narrow sidebar)
          var hf = null;
          try { hf = kind.heightFor(w, this.data, this.opts || {}); } catch (e) { hf = null; }
          h = isNum(hf) && hf > 0 ? hf : clamp(Math.round(w * (kind.aspect || 0.55)), kind.minH || 150, kind.maxH || 340);
        }
        else h = clamp(Math.round(w * (kind.aspect || 0.55)), kind.minH || 150, kind.maxH || 340);
        h = Math.floor(h);
        c.style.height = h + 'px';
      }
    }
    if (!(h > 1)) return false;
    var dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    var bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
    this.w = w; this.h = h; this.dpr = bw / w;
    this.needsMeasure = false;
    return true;
  };

  Chart.prototype.schedule = function () {
    var self = this;
    if (this.dead || this.raf || this.rafTimer || !HAS_DOM) return;
    // rAF never fires in hidden / background tabs; race it against a timer so charts created while the
    // tab is in the background are still measured and painted (the timer is cancelled by whichever wins).
    var run = function (t) {
      if (self.raf) { cancelAnimationFrame(self.raf); self.raf = 0; }
      if (self.rafTimer) { clearTimeout(self.rafTimer); self.rafTimer = 0; }
      self.frame(t);
    };
    var hidden = typeof document !== 'undefined' && document.hidden;
    if (!hidden) this.raf = requestAnimationFrame(run);
    this.rafTimer = setTimeout(run, hidden ? 16 : 100);
  };

  Chart.prototype.frame = function () {
    if (this.dead || !this.ctx) return;
    if (this.needsMeasure || !this.w) { if (!this.measure()) return; }
    var t = now(), reduce = reducedMotion(), again = false;
    if (this.animStart == null) this.animStart = t;
    this.progress = reduce ? 1 : clamp((t - this.animStart) / ANIM_MS, 0, 1);
    if (this.progress < 1) again = true;
    if (this.morphStart != null) {
      this.morphT = reduce ? 1 : clamp((t - this.morphStart) / MORPH_MS, 0, 1);
      if (this.morphT < 1) again = true; else { this.morphStart = null; this.prevSnapshot = null; }
    }
    this.paint();
    if (again) this.schedule();
  };

  Chart.prototype.paint = function () {
    var ctx = this.ctx, th = readTheme(this.canvas);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    var env = {
      ctx: ctx, w: this.w, h: this.h, th: th, data: this.data, compare: this.compare, opts: this.opts,
      progress: easeOut(this.progress), rawProgress: this.progress,
      morph: (this.morphStart != null && this.prevSnapshot) ? { t: easeInOut(this.morphT), prev: this.prevSnapshot } : null,
      pointer: this.pointer, focusIdx: this.focusIdx, out: {}
    };
    try {
      if (this.data == null || !this.kind) drawEmpty(ctx, env, (this.kind && this.kind.emptyText) || 'No data');
      else this.kind.draw(ctx, env);
    } catch (e) {
      if (typeof console !== 'undefined') console.error('[CB.charts.' + this.kindName + ']', e);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.clearRect(0, 0, this.w, this.h);
      env.out = {}; drawEmpty(ctx, env, 'Chart unavailable', String(e && e.message || e).slice(0, 80));
    }
    this.count = env.out.count || 0;
    if (this.focusIdx != null && this.count && this.focusIdx >= this.count) this.focusIdx = this.count - 1;
    if (env.out.snapshot !== undefined) this.snapshot = env.out.snapshot;
    var cur = env.out.cursor || '';
    if (this.canvas.style.cursor !== cur) this.canvas.style.cursor = cur;
    if (env.out.summary && env.out.summary !== this.summary) {
      this.summary = env.out.summary;
      this.canvas.setAttribute('aria-label', env.out.summary);
    }
  };

  Chart.prototype.redraw = function (data, compare, opts) {
    if (this.dead) return;
    if (this.kind && this.kind.morph && this.snapshot && this.progress >= 1) {
      this.prevSnapshot = this.snapshot; this.morphStart = now(); this.morphT = 0;
    }
    if (data !== undefined) this.data = data;
    if (arguments.length >= 2 && compare !== undefined) this.compare = compare || null;
    if (opts) this.opts = Object.assign({}, this.opts, opts);
    if (this.kind && typeof this.kind.heightFor === 'function' && this.mode === 'auto') this.needsMeasure = true;
    this.schedule();
  };

  Chart.prototype.destroy = function (silent) {
    if (this.dead) return;
    this.dead = true;
    var c = this.canvas;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.rafTimer) { clearTimeout(this.rafTimer); this.rafTimer = 0; }
    clearTimeout(this.detachTimer); clearTimeout(this.touchTimer);
    if (this.ro) try { this.ro.disconnect(); } catch (e) { /* ignore */ }
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointerleave', this.onLeave);
    c.removeEventListener('pointercancel', this.onLeave);
    c.removeEventListener('keydown', this.onKey);
    c.removeEventListener('blur', this.onBlur);
    var i = live.indexOf(this); if (i >= 0) live.splice(i, 1);
    if (c.__cbChart === this) c.__cbChart = null;
    if (!silent && this.ctx) { try { this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, c.width, c.height); } catch (e) { /* ignore */ } }
    c.style.cursor = '';
  };

  var NOOP = { destroy: function () {}, redraw: function () {}, update: function () {}, setCompare: function () {}, setOptions: function () {}, resize: function () {}, canvas: null, kind: null };

  function resolveCanvas(target) {
    if (!HAS_DOM || !target) return null;
    if (typeof target === 'string') target = document.querySelector(target.charAt(0) === '#' || target.charAt(0) === '.' ? target : '#' + target);
    if (!target) return null;
    if (target.tagName === 'CANVAS') return target;
    if (target.canvas && target.canvas.tagName === 'CANVAS') return target.canvas; // CB.ui.chart() wrapper
    var c = target.querySelector && target.querySelector('canvas');
    if (c) return c;
    if (target.appendChild) { c = document.createElement('canvas'); target.appendChild(c); return c; }
    return null;
  }

  function create(kind, target, data, compare, opts) {
    var canvas = resolveCanvas(target);
    if (!canvas || !canvas.getContext) return Object.assign({}, NOOP);
    var ch = new Chart(canvas, kind, data, compare, opts);
    return {
      canvas: canvas,
      kind: kind,
      redraw: function (d, c, o) { if (arguments.length >= 2) ch.redraw(d, c === undefined ? null : c, o); else ch.redraw(d); },
      update: function (d, c, o) { if (arguments.length >= 2) ch.redraw(d, c === undefined ? null : c, o); else ch.redraw(d); },
      setCompare: function (c) { ch.compare = c || null; ch.schedule(); },
      setOptions: function (o) { ch.opts = Object.assign({}, ch.opts, o || {}); ch.needsMeasure = true; ch.schedule(); },
      resize: function () { ch.needsMeasure = true; ch.schedule(); },
      destroy: function () { ch.destroy(); },
      get data() { return ch.data; },
      get alive() { return !ch.dead; }
    };
  }

  /* ================================================================== CHART KINDS */
  var KINDS = {};

  /* ------------------------------------------------------------------ DYNO */
  function cleanCurve(c) {
    return arr(c).filter(function (p) { return p && isNum(Number(p.rpm)); })
      .map(function (p) { return { rpm: Number(p.rpm), hp: num(p.hp), nm: num(p.nm), kw: isNum(p.kw) ? p.kw : null }; })
      .sort(function (a, b) { return a.rpm - b.rpm; });
  }

  KINDS.dyno = {
    aspect: 0.52, minH: 180, maxH: 380, emptyText: 'No dyno data',
    draw: function (ctx, env) {
      var th = env.th, m = env.data || {}, c = env.compare, o = env.opts || {};
      var curve = cleanCurve(m.curve);
      if (curve.length < 2) return drawEmpty(ctx, env, 'No dyno data', 'Configure a powertrain to see the curve');
      var cc = c ? cleanCurve(c.curve) : [];
      var kw = o.powerUnit === 'kw', lb = o.torqueUnit === 'lbft';
      var PU = kw ? 'kW' : 'hp', TU = lb ? 'lb-ft' : 'Nm';
      var P = function (p) { return kw ? (p.kw != null ? p.kw : p.hp * 0.745699872) : p.hp; };
      var T = function (p) { return lb ? p.nm * 0.737562149 : p.nm; };
      var red = num(m.redlineRpm, last(curve).rpm);
      var cred = c ? num(c.redlineRpm, cc.length ? last(cc).rpm : 0) : 0;
      var xmin = Math.min(curve[0].rpm, cc.length ? cc[0].rpm : Infinity);
      xmin = Math.max(0, Math.floor(xmin / 500) * 500);
      var xmaxRaw = Math.max(last(curve).rpm, red, cc.length ? last(cc).rpm : 0, cred);
      var xmax = Math.ceil(xmaxRaw * 1.04 / 250) * 250;
      var isEV = xmaxRaw > 11000;
      var pMax = 0, tMax = 0;
      curve.concat(cc).forEach(function (p) { pMax = Math.max(pMax, P(p)); tMax = Math.max(tMax, T(p)); });

      var items = [
        { label: (o.label ? o.label + ' · ' : '') + 'Power', color: th.accent },
        { label: (o.label ? o.label + ' · ' : '') + 'Torque', color: th.accent2 }
      ];
      if (cc.length) {
        var cl = o.compareLabel || 'Compare';
        items.push({ label: cl + ' · power', color: th.accent, dash: [5, 4], alpha: 0.75 });
        items.push({ label: cl + ' · torque', color: th.accent2, dash: [5, 4], alpha: 0.75 });
      }
      items.push({ label: 'Redline', color: th.bad, type: 'band' });
      var lgH = drawLegend(ctx, th, items, 12, 6, env.w - 24);

      var F = xyFrame(ctx, env, {
        top: 6 + lgH + 12,
        x: { min: xmin, max: xmax, fixed: true, title: isEV ? 'Motor speed (rpm-equivalent)' : 'Engine speed (rpm)' },
        y: { min: 0, max: Math.max(1, pMax * 1.14), title: 'Power (' + PU + ')', key: th.accent },
        y2: { max: Math.max(1, tMax * 1.14), title: 'Torque (' + TU + ')', key: th.accent2 }
      });
      drawXYGrid(ctx, env, F);

      // peaks
      var pk = curve[0], tk = curve[0];
      curve.forEach(function (p) { if (P(p) > P(pk)) pk = p; if (T(p) > T(tk)) tk = p; });

      // power band (>= 90 % of peak power, contiguous around the peak)
      var pi = curve.indexOf(pk), b0 = pi, b1 = pi;
      while (b0 > 0 && P(curve[b0 - 1]) >= P(pk) * 0.9) b0--;
      while (b1 < curve.length - 1 && P(curve[b1 + 1]) >= P(pk) * 0.9) b1++;
      var bx0 = F.sx(curve[b0].rpm), bx1 = F.sx(curve[b1].rpm);
      if (bx1 - bx0 > 2) {
        ctx.fillStyle = rgba(th.accent, th.dark ? 0.07 : 0.09);
        ctx.fillRect(bx0, F.t, bx1 - bx0, F.ph);
        if (bx1 - bx0 > 86) {
          ctx.save(); ctx.font = font(th, 9.5, 600); ctx.fillStyle = rgba(th.textDim, 0.9); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          if ('letterSpacing' in ctx) ctx.letterSpacing = '0.8px';
          ctx.fillText('POWER BAND', (bx0 + bx1) / 2, F.b - 5); ctx.restore();
        }
      }
      // redline band
      if (red < xmax) {
        var rx = F.sx(red);
        ctx.fillStyle = rgba(th.bad, 0.1); ctx.fillRect(rx, F.t, F.r - rx, F.ph);
        hatch(ctx, rx, F.t, F.r - rx, F.ph, rgba(th.bad, 0.22), 6);
        vline(ctx, rx, F.t, F.b, rgba(th.bad, 0.85), 1.25);
        ctx.save(); ctx.font = font(th, 9.5, 700); ctx.fillStyle = th.bad; ctx.textBaseline = 'top';
        if (F.r - rx > 58) { ctx.textAlign = 'left'; ctx.fillText(fmtN(red), rx + 5, F.t + 4); }
        else { ctx.translate(rx - 4, F.b - 6); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText('REDLINE ' + fmtN(red), 0, 0); }
        ctx.restore();
      }

      var hpPts = curve.map(function (p) { return [F.sx(p.rpm), F.sy(P(p))]; });
      var tqPts = curve.map(function (p) { return [F.sx(p.rpm), F.sy2(T(p))]; });
      ctx.save();
      revealClip(ctx, env, F);
      if (cc.length) {
        strokeSeries(ctx, cc.map(function (p) { return [F.sx(p.rpm), F.sy2(T(p))]; }), th.accent2, 1.6, [5, 4], 0.75);
        strokeSeries(ctx, cc.map(function (p) { return [F.sx(p.rpm), F.sy(P(p))]; }), th.accent, 1.6, [5, 4], 0.75);
      }
      fillUnder(ctx, hpPts, F.b, F.sy(P(pk)), th.accent, th.dark ? 0.3 : 0.22, 0);
      strokeSeries(ctx, tqPts, th.accent2, 2);
      strokeSeries(ctx, hpPts, th.accent, 2.25);
      ctx.restore();

      // peak markers
      var pa = clamp((env.rawProgress - 0.7) / 0.3, 0, 1);
      if (pa > 0) {
        ctx.save(); ctx.globalAlpha = pa;
        var bounds = { l: F.l + 2, r: F.r - 2, t: F.t - 2, b: F.b - 2 };
        var px = F.sx(pk.rpm), py = F.sy(P(pk)), tx = F.sx(tk.rpm), ty = F.sy2(T(tk));
        dot(ctx, px, py, 4, th.accent, th.surface);
        dot(ctx, tx, ty, 4, th.accent2, th.surface);
        var pText = fmtN(P(pk)) + ' ' + PU + ' @ ' + fmtN(pk.rpm) + ' rpm';
        var tText = fmtN(T(tk)) + ' ' + TU + ' @ ' + fmtN(tk.rpm) + ' rpm';
        var pr = pill(ctx, th, pText, px, py - 10, { vAlign: 'bottom', align: 'center', bounds: bounds, measureOnly: true });
        var tr = pill(ctx, th, tText, tx, ty - 10, { vAlign: 'bottom', align: 'center', bounds: bounds, measureOnly: true });
        if (rectsOverlap(pr, tr, 3)) {
          // keep the higher one above, push the other below its marker
          if (ty <= py) pr = pill(ctx, th, pText, px, py + 10, { vAlign: 'top', bounds: bounds, measureOnly: true });
          else tr = pill(ctx, th, tText, tx, ty + 10, { vAlign: 'top', bounds: bounds, measureOnly: true });
          if (rectsOverlap(pr, tr, 3)) tr = { x: tr.x, y: pr.y + pr.h + 4, w: tr.w, h: tr.h };
        }
        pill(ctx, th, pText, pr.x, pr.y, { align: 'left', vAlign: 'top', border: rgba(th.accent, 0.7) });
        pill(ctx, th, tText, tr.x, tr.y, { align: 'left', vAlign: 'top', border: rgba(th.accent2, 0.7) });
        if (cc.length) {
          var cpk = cc[0], ctk = cc[0];
          cc.forEach(function (p) { if (P(p) > P(cpk)) cpk = p; if (T(p) > T(ctk)) ctk = p; });
          ringDot(ctx, F.sx(cpk.rpm), F.sy(P(cpk)), 3.5, th.accent, th.surface);
          ringDot(ctx, F.sx(ctk.rpm), F.sy2(T(ctk)), 3.5, th.accent2, th.surface);
        }
        ctx.restore();
      }

      // hover
      var hi = hoverIndex(env, F, curve, 'rpm');
      if (hi >= 0) {
        var hp = curve[hi], hx = F.sx(hp.rpm);
        crosshair(ctx, env, F, hx);
        var rows = [
          { color: th.accent, label: 'Power', value: fmtN(P(hp)) + ' ' + PU },
          { color: th.accent2, label: 'Torque', value: fmtN(T(hp)) + ' ' + TU }
        ];
        var cp = null, ct = null;
        if (cc.length) {
          cp = interpAt(cc.map(function (p) { return { rpm: p.rpm, v: P(p) }; }), 'rpm', 'v', hp.rpm);
          ct = interpAt(cc.map(function (p) { return { rpm: p.rpm, v: T(p) }; }), 'rpm', 'v', hp.rpm);
          rows.push({ sep: true });
          rows.push({ color: th.accent, dash: [4, 3], label: (o.compareLabel || 'Compare') + ' power', value: cp == null ? '—' : fmtN(cp) + ' ' + PU + '  ' + signed(P(hp) - cp, 0) });
          rows.push({ color: th.accent2, dash: [4, 3], label: (o.compareLabel || 'Compare') + ' torque', value: ct == null ? '—' : fmtN(ct) + ' ' + TU + '  ' + signed(T(hp) - ct, 0) });
          if (cp != null) dot(ctx, hx, F.sy(cp), 3, th.accent, th.surface, 1.5);
          if (ct != null) dot(ctx, hx, F.sy2(ct), 3, th.accent2, th.surface, 1.5);
        }
        rows.push({ sep: true });
        rows.push({ label: 'Of peak power', value: fmtN(P(hp) / (P(pk) || 1) * 100, 0) + ' %', dim: true });
        if (hp.rpm > red) rows.push({ label: 'Beyond redline', value: '+' + fmtN(hp.rpm - red) + ' rpm', valueColor: th.bad });
        dot(ctx, hx, F.sy(P(hp)), 4.5, th.accent, th.surface);
        dot(ctx, hx, F.sy2(T(hp)), 4.5, th.accent2, th.surface);
        xPill(ctx, env, F, hx, fmtN(hp.rpm));
        drawTip(ctx, env, hx, (F.sy(P(hp)) + F.sy2(T(hp))) / 2, fmtN(hp.rpm) + ' rpm', rows);
      }
      env.out.summary = 'Dyno chart: peak ' + fmtN(P(pk)) + ' ' + PU + ' at ' + fmtN(pk.rpm) + ' rpm, peak ' +
        fmtN(T(tk)) + ' ' + TU + ' at ' + fmtN(tk.rpm) + ' rpm, redline ' + fmtN(red) + ' rpm.';
    }
  };

  /* ------------------------------------------------------------------ ACCEL */
  function cleanAccel(c) {
    var out = arr(c).filter(function (p) { return p && isNum(Number(p.t)) && isNum(Number(p.kph)); })
      .map(function (p) { return { t: Number(p.t), kph: Number(p.kph), gear: p.gear == null ? null : p.gear }; })
      .sort(function (a, b) { return a.t - b.t; });
    var d = 0;
    out.forEach(function (p, i) {
      if (i) d += (p.kph + out[i - 1].kph) / 2 / 3.6 * (p.t - out[i - 1].t);
      p.d = d;
    });
    return out;
  }
  function crossTime(curve, kph) {
    for (var i = 1; i < curve.length; i++) {
      if (curve[i].kph >= kph) {
        var a = curve[i - 1], b = curve[i];
        return lerp(a.t, b.t, (kph - a.kph) / ((b.kph - a.kph) || 1));
      }
    }
    return null;
  }
  function crossDist(curve, m) {
    for (var i = 1; i < curve.length; i++) {
      if (curve[i].d >= m) {
        var a = curve[i - 1], b = curve[i], f = (m - a.d) / ((b.d - a.d) || 1);
        return { t: lerp(a.t, b.t, f), kph: lerp(a.kph, b.kph, f) };
      }
    }
    return null;
  }

  KINDS.accel = {
    aspect: 0.52, minH: 180, maxH: 380, emptyText: 'No acceleration data',
    draw: function (ctx, env) {
      var th = env.th, m = env.data || {}, c = env.compare, o = env.opts || {};
      var curve = cleanAccel(m.accelCurve);
      if (curve.length < 2) return drawEmpty(ctx, env, 'No acceleration data', 'Run the physics model to simulate a launch');
      var cc = c ? cleanAccel(c.accelCurve) : [];
      var imp = o.units === 'imperial' || o.speedUnit === 'mph';
      var K = imp ? 0.621371 : 1, SU = imp ? 'mph' : 'km/h';
      var top = num(m.topSpeed_kph, 0);
      var tMax = Math.max(last(curve).t, cc.length ? last(cc).t : 0);
      var vMax = 0;
      curve.concat(cc).forEach(function (p) { vMax = Math.max(vMax, p.kph); });
      vMax = Math.max(vMax, top);

      var items = [{ label: o.label || 'Speed', color: th.accent }];
      if (cc.length) items.push({ label: o.compareLabel || 'Compare', color: th.accent2, dash: [5, 4] });
      items.push({ label: 'Gear change', color: th.text, type: 'line' });
      // Gear-change key is a diamond; draw custom after legend
      var lgH = drawLegend(ctx, th, items.slice(0, cc.length ? 2 : 1), 12, 6, env.w - 24);

      var F = xyFrame(ctx, env, {
        top: 6 + lgH + 12,
        x: { min: 0, max: Math.max(1, tMax), title: 'Time (s)' },
        y: { min: 0, max: Math.max(10, vMax * K * 1.08), title: 'Speed (' + SU + ')', key: th.accent }
      });
      F.x.min = 0;
      drawXYGrid(ctx, env, F);

      // gear bands
      var spans = [], cur = null;
      curve.forEach(function (p) {
        if (!cur || p.gear !== cur.gear) { if (cur) cur.t1 = p.t; cur = { gear: p.gear, t0: p.t, t1: p.t }; spans.push(cur); }
        else cur.t1 = p.t;
      });
      ctx.save();
      spans.forEach(function (s, i) {
        if (s.gear == null) return;
        var x0 = F.sx(s.t0), x1 = Math.min(F.r, F.sx(s.t1));
        if (i % 2 === 1) { ctx.fillStyle = rgba(th.text, th.dark ? 0.028 : 0.035); ctx.fillRect(x0, F.t, x1 - x0, F.ph); }
        if (x1 - x0 > 15) {
          ctx.font = font(th, 9.5, 600, true); ctx.fillStyle = rgba(th.textDim, 0.85); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.fillText(x1 - x0 > 30 ? ordinal(Number(s.gear) || 0) : String(s.gear), (x0 + x1) / 2, F.t + 3);
        }
      });
      ctx.restore();

      // Vmax line
      if (top > 0) {
        var vy = F.sy(top * K);
        hline(ctx, F.l, F.r, vy, rgba(th.textDim, 0.7), 1, [6, 4]);
        var lim = m.topSpeedLimitedBy ? ' · ' + ({ drag: 'drag-limited', redline: 'redline-limited', governor: 'governed' }[m.topSpeedLimitedBy] || m.topSpeedLimitedBy) : '';
        ctx.save(); ctx.font = font(th, 10, 600, true); ctx.fillStyle = th.textDim; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.fillText('Vmax ' + fmtN(top * K) + ' ' + SU + lim, F.r - 4, vy - 3); ctx.restore();
      }

      var pts = curve.map(function (p) { return [F.sx(p.t), F.sy(p.kph * K)]; });
      ctx.save();
      revealClip(ctx, env, F);
      if (cc.length) strokeSeries(ctx, cc.map(function (p) { return [F.sx(p.t), F.sy(p.kph * K)]; }), th.accent2, 1.75, [5, 4], 0.85);
      fillUnder(ctx, pts, F.b, F.t, th.accent, th.dark ? 0.2 : 0.14, 0);
      // Polyline (sim data is dense; shift plateaus should stay crisp, not smoothed)
      ctx.strokeStyle = th.accent; ctx.lineWidth = 2.25; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath(); pts.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.stroke();
      // shift markers
      for (var i = 1; i < curve.length; i++) {
        if (curve[i].gear != null && curve[i - 1].gear != null && curve[i].gear !== curve[i - 1].gear) {
          diamond(ctx, F.sx(curve[i].t), F.sy(curve[i].kph * K), 3.2, th.text, th.surface);
        }
      }
      ctx.restore();

      // benchmark markers
      var pa = clamp((env.rawProgress - 0.7) / 0.3, 0, 1);
      var marks = [];
      if (imp) {
        marks.push({ v: 60 / K, label: '0–60', given: m.zeroTo60_s });
        marks.push({ v: 100 / K, label: '0–100' });
        if (vMax * K > 165) marks.push({ v: 150 / K, label: '0–150' });
      } else {
        marks.push({ v: 100, label: '0–100', given: m.zeroTo100_s });
        marks.push({ v: 200, label: '0–200', given: m.zeroTo200_s });
        if (vMax > 320) marks.push({ v: 300, label: '0–300' });
      }
      var placed = [];
      if (pa > 0) {
        ctx.save(); ctx.globalAlpha = pa;
        var bounds = { l: F.l + 2, r: F.r - 2, t: F.t + 14, b: F.b - 2 };
        marks.forEach(function (mk) {
          var tc = crossTime(curve, mk.v);
          if (tc == null) return;
          var tt = isNum(mk.given) ? mk.given : tc;
          var x = F.sx(tc), y = F.sy(mk.v * K);
          if (x > F.r) return;
          ctx.save(); ctx.strokeStyle = rgba(th.textDim, 0.55); ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(F.l, crisp(y)); ctx.lineTo(x, crisp(y)); ctx.lineTo(crisp(x), F.b); ctx.stroke(); ctx.restore();
          dot(ctx, x, y, 3.5, th.accent, th.surface);
          var text = mk.label + ' ' + fmtN(tt, 1) + ' s';
          var r = pill(ctx, th, text, x + 8, y + 6, { align: 'left', vAlign: 'top', bounds: bounds, measureOnly: true, size: 10 });
          placed.forEach(function (q) { if (rectsOverlap(r, q, 2)) r.y = q.y + q.h + 3; });
          pill(ctx, th, text, r.x, r.y, { align: 'left', vAlign: 'top', size: 10 });
          placed.push(r);
        });
        // quarter mile
        var qm = crossDist(curve, 402.336);
        if (qm) {
          var qt = isNum(m.quarterMile_s) ? m.quarterMile_s : qm.t;
          var trap = isNum(m.quarterMileTrap_mph) ? (imp ? m.quarterMileTrap_mph : m.quarterMileTrap_mph / 0.621371) : qm.kph * K;
          var qx = F.sx(qm.t), qy = F.sy(qm.kph * K);
          if (qx <= F.r) {
            ringDot(ctx, qx, qy, 4.5, th.text, th.surface);
            var qtext = '¼ mile ' + fmtN(qt, 1) + ' s @ ' + fmtN(trap) + ' ' + SU;
            var qr = pill(ctx, th, qtext, qx + 8, qy + 8, { align: 'left', vAlign: 'top', bounds: bounds, measureOnly: true, size: 10 });
            placed.forEach(function (q) { if (rectsOverlap(qr, q, 2)) qr.y = q.y + q.h + 3; });
            pill(ctx, th, qtext, qr.x, qr.y, { align: 'left', vAlign: 'top', size: 10, border: rgba(th.text, 0.4) });
          }
        }
        ctx.restore();
      }

      // hover
      var hi = hoverIndex(env, F, curve, 't');
      if (hi >= 0) {
        var p = curve[hi], hx = F.sx(p.t), hy = F.sy(p.kph * K);
        crosshair(ctx, env, F, hx);
        var a = curve[Math.max(0, hi - 2)], b = curve[Math.min(curve.length - 1, hi + 2)];
        var g = (b.t - a.t) > 0 ? ((b.kph - a.kph) / 3.6 / (b.t - a.t)) / 9.81 : 0;
        var rows = [
          { color: th.accent, label: 'Speed', value: fmtN(p.kph * K, 1) + ' ' + SU },
          { label: 'Gear', value: p.gear == null ? '—' : ordinal(Number(p.gear) || 0) },
          { label: 'Acceleration', value: fmtN(g, 2) + ' g' },
          { label: 'Distance', value: imp ? fmtN(p.d * 3.28084) + ' ft' : fmtN(p.d) + ' m' }
        ];
        if (cc.length) {
          var cv = interpAt(cc, 't', 'kph', p.t);
          rows.push({ sep: true });
          rows.push({ color: th.accent2, dash: [4, 3], label: o.compareLabel || 'Compare', value: cv == null ? '—' : fmtN(cv * K, 1) + ' ' + SU + '  ' + signed((p.kph - cv) * K, 1) });
          if (cv != null) dot(ctx, hx, F.sy(cv * K), 3, th.accent2, th.surface, 1.5);
        }
        dot(ctx, hx, hy, 4.5, th.accent, th.surface);
        xPill(ctx, env, F, hx, fmtN(p.t, 2) + ' s');
        drawTip(ctx, env, hx, hy, 't = ' + fmtN(p.t, 2) + ' s', rows);
      }
      var z = imp ? m.zeroTo60_s : m.zeroTo100_s;
      env.out.summary = 'Acceleration chart: ' + (imp ? '0–60 mph ' : '0–100 km/h ') + (isNum(z) ? fmtN(z, 1) + ' s' : 'n/a') +
        (top ? ', top speed ' + fmtN(top * K) + ' ' + SU : '') + ', ' + Math.max(0, spans.length) + ' gear segments.';
    }
  };

  /* ------------------------------------------------------------------ GEARS (sawtooth) */
  KINDS.gears = {
    aspect: 0.52, minH: 180, maxH: 380, emptyText: 'No gearing data',
    draw: function (ctx, env) {
      var th = env.th, m = env.data || {}, o = env.opts || {};
      var gs = arr(m.gearSpeeds).filter(function (g) { return g && isNum(Number(g.maxKph)) && Number(g.maxKph) > 0; })
        .map(function (g, i) { return { gear: g.gear != null ? g.gear : i + 1, ratio: num(g.ratio, NaN), maxKph: Number(g.maxKph) }; })
        .sort(function (a, b) { return a.maxKph - b.maxKph; });
      if (!gs.length) return drawEmpty(ctx, env, 'No gearing data', 'Select a transmission to plot ratios');
      var imp = o.units === 'imperial' || o.speedUnit === 'mph';
      var K = imp ? 0.621371 : 1, SU = imp ? 'mph' : 'km/h';
      var R = num(m.redlineRpm, 7000), idle = num(m.idleRpm, 800);
      var top = num(m.topSpeed_kph, 0);
      var xmax = Math.max(last(gs).maxKph, top) * 1.04;
      var launch = clamp(num(m.launchRpm, R * 0.5), idle, R * 0.9);

      var items = [{ label: 'Shift path', color: th.accent }, { label: 'Gear lines', color: rgba(th.textDim, 0.8) }, { label: 'Redline', color: th.bad, type: 'band' }];
      var lgH = drawLegend(ctx, th, items, 12, 6, env.w - 24);
      var F = xyFrame(ctx, env, {
        top: 6 + lgH + 12,
        x: { min: 0, max: xmax * K, title: 'Road speed (' + SU + ')' },
        y: { min: 0, max: R * 1.12, title: 'Engine speed (rpm)', key: th.accent, fmt: function (v) { return v >= 1000 ? fmtN(v / 1000, v % 1000 ? 1 : 0) + 'k' : fmtN(v); } }
      });
      drawXYGrid(ctx, env, F);
      var X = function (kph) { return F.sx(kph * K); };

      // shift-light zone + redline band
      var ry = F.sy(R), sly = F.sy(R * 0.94);
      ctx.fillStyle = rgba(th.warn, 0.08); ctx.fillRect(F.l, ry, F.pw, sly - ry);
      ctx.fillStyle = rgba(th.bad, 0.1); ctx.fillRect(F.l, F.t, F.pw, ry - F.t);
      hatch(ctx, F.l, F.t, F.pw, ry - F.t, rgba(th.bad, 0.22), 6);
      hline(ctx, F.l, F.r, ry, rgba(th.bad, 0.85), 1.25);
      ctx.save(); ctx.font = font(th, 9.5, 700); ctx.fillStyle = th.bad; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0.6px';
      if (ry - F.t > 11) ctx.fillText('REDLINE ' + fmtN(R), F.l + 6, ry - 3);
      ctx.restore();
      // peak power line
      if (isNum(m.peakPowerRpm) && m.peakPowerRpm < R) {
        var py = F.sy(m.peakPowerRpm);
        hline(ctx, F.l, F.r, py, rgba(th.accent, 0.6), 1, [2, 4]);
        ctx.save(); ctx.font = font(th, 9.5, 600); ctx.fillStyle = th.textDim; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.fillText('peak power ' + fmtN(m.peakPowerRpm) + ' rpm', F.r - 4, py - 2); ctx.restore();
      }

      ctx.save();
      revealClip(ctx, env, F);
      // faint full gear lines
      gs.forEach(function (g) {
        ctx.strokeStyle = rgba(th.textDim, 0.38); ctx.lineWidth = 1; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(X(0), F.sy(0)); ctx.lineTo(X(g.maxKph), F.sy(R)); ctx.stroke();
      });
      // sawtooth shift path
      var path = [], drops = [];
      var v0 = gs[0].maxKph * launch / R;
      path.push([X(0), F.sy(launch)]);
      path.push([X(v0), F.sy(launch)]);
      // the path ends in whichever gear actually reaches top speed (drag-limited cars never use the
      // overdrive gears beyond it, and must not be drawn running backwards in them)
      var endIdx = gs.length - 1;
      if (top > 0) for (var ei = 0; ei < gs.length; ei++) { if (gs[ei].maxKph >= top) { endIdx = ei; break; } }
      var vStop = top > 0 ? Math.min(gs[endIdx].maxKph, top) : gs[endIdx].maxKph;
      if (vStop < v0) vStop = v0;
      gs.forEach(function (g, i) {
        if (i > endIdx) return;
        var isLast = i === endIdx;
        var vend = isLast ? vStop : g.maxKph;
        path.push([X(vend), F.sy(R * vend / g.maxKph)]);
        if (!isLast) {
          var nrpm = R * g.maxKph / gs[i + 1].maxKph;
          path.push([X(g.maxKph), F.sy(nrpm)]);
          drops.push({ v: g.maxKph, from: R, to: nrpm, gear: g.gear });
        }
      });
      ctx.strokeStyle = th.accent; ctx.lineWidth = 2.25; ctx.lineJoin = 'round';
      ctx.beginPath(); path.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.stroke();
      // terminal point on the path (top speed)
      var endPt = path[path.length - 1];
      dot(ctx, endPt[0], endPt[1], 3.5, th.accent, th.surface, 2);
      ctx.restore();

      var pa = clamp((env.rawProgress - 0.6) / 0.4, 0, 1);
      if (pa > 0 && top > 0 && X(top) <= F.r) {
        ctx.save(); ctx.globalAlpha = pa;
        var tx = X(top);
        vline(ctx, tx, F.sy(R) + 2, F.b, rgba(th.text, 0.35), 1, [3, 3]);
        var lim = m.topSpeedLimitedBy ? ' · ' + m.topSpeedLimitedBy + '-limited' : '';
        ctx.font = font(th, 9.5, 600); ctx.fillStyle = th.textDim; ctx.textBaseline = 'bottom';
        var tl = 'top ' + fmtN(top * K) + ' ' + SU + lim;
        var tw = ctx.measureText(tl).width;
        ctx.textAlign = tx + 6 + tw > F.r ? 'right' : 'left';
        ctx.fillText(tl, ctx.textAlign === 'right' ? tx - 6 : tx + 6, F.b - 6);
        ctx.restore();
      }
      if (pa > 0) {
        ctx.save(); ctx.globalAlpha = pa;
        // drop annotations + gear labels at redline
        var lastLabelX = -1e9;
        gs.forEach(function (g, i) {
          var x = X(Math.min(g.maxKph, xmax)), y = F.sy(R);
          if (x > F.r + 1) return;
          if (x - lastLabelX > 24) {
            var lbl = String(g.gear);
            ctx.font = font(th, 10, 700, true);
            ctx.beginPath(); ctx.arc(x, y - 11, 8, 0, Math.PI * 2); ctx.fillStyle = th.surface; ctx.fill();
            ctx.lineWidth = 1; ctx.strokeStyle = rgba(th.accent, 0.8); ctx.stroke();
            ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(lbl, x, y - 10.5);
            lastLabelX = x;
          }
        });
        ctx.font = font(th, 9.5, 500, true); ctx.fillStyle = th.textDim; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        var lastDropX = -1e9;
        drops.forEach(function (d) {
          var x = X(d.v), y = (F.sy(d.from) + F.sy(d.to)) / 2;
          if (x - lastDropX < 46 || x + 44 > F.r) return;
          ctx.fillText('−' + fmtN(d.from - d.to), x + 4, y);
          lastDropX = x;
        });
        ctx.restore();
      }

      // hover
      env.out.count = Math.round(F.pw / 4);
      var hv = null;
      if (env.pointer && F.inside(env.pointer, 6)) { hv = clamp(F.ix(clamp(env.pointer.x, F.l, F.r)) / K, 0, xmax); env.out.cursor = 'crosshair'; }
      else if (env.focusIdx != null) hv = clamp(env.focusIdx / (env.out.count - 1), 0, 1) * xmax;
      if (hv != null) {
        var hx = X(hv);
        crosshair(ctx, env, F, hx);
        var pathGear = null;
        for (var i = 0; i < gs.length; i++) { if (hv <= gs[i].maxKph) { pathGear = gs[i]; break; } }
        var rows = [];
        gs.forEach(function (g) {
          var rpm = R * hv / g.maxKph;
          var ok = rpm <= R && rpm >= idle * 0.9;
          var isPath = g === pathGear;
          rows.push({
            color: isPath ? th.accent : (ok ? rgba(th.textDim, 0.8) : null), key: 'dot',
            label: ordinal(Number(g.gear) || 0) + (isNum(g.ratio) ? '  ' + g.ratio.toFixed(2) + ':1' : ''),
            value: rpm > R ? 'over-rev' : rpm < idle * 0.9 ? 'lugging' : fmtN(rpm) + ' rpm',
            dim: !ok, valueColor: isPath ? th.text : null
          });
          if (ok) dot(ctx, hx, F.sy(rpm), isPath ? 4.5 : 3, isPath ? th.accent : th.textDim, th.surface, isPath ? 2 : 1.5);
        });
        if (pathGear && isNum(m.peakPowerRpm)) {
          // best gear for max power at this speed = rpm closest to peak power, within redline
          var best = null, bestD = Infinity;
          gs.forEach(function (g) { var rpm = R * hv / g.maxKph; if (rpm <= R && Math.abs(rpm - m.peakPowerRpm) < bestD) { bestD = Math.abs(rpm - m.peakPowerRpm); best = g; } });
          if (best) { rows.push({ sep: true }); rows.push({ label: 'Best gear for power', value: ordinal(Number(best.gear) || 0) }); }
        }
        if (isNum(m.idleRpm) || true) rows.push({ label: 'Speed / 1000 rpm (top)', value: fmtN(last(gs).maxKph * K / R * 1000, 1) + ' ' + SU, dim: true });
        xPill(ctx, env, F, hx, fmtN(hv * K) + ' ' + SU);
        drawTip(ctx, env, hx, F.t + F.ph * 0.45, fmtN(hv * K, 0) + ' ' + SU, rows);
      }
      env.out.summary = 'Gear chart: ' + gs.length + ' gears, redline ' + fmtN(R) + ' rpm, top gear max ' + fmtN(last(gs).maxKph * K) + ' ' + SU + '.';
    }
  };

  /* ------------------------------------------------------------------ RADAR */
  var RADAR_AXES = ['acceleration', 'handling', 'braking', 'track', 'sound', 'luxury', 'comfort', 'practicality', 'reliability', 'efficiency'];
  var RADAR_SHORT = { acceleration: 'Accel', handling: 'Handling', braking: 'Braking', comfort: 'Comfort', efficiency: 'Effic.', reliability: 'Reliab.', practicality: 'Practical', luxury: 'Luxury', sound: 'Sound', track: 'Track' };
  function ratingsOf(d) {
    if (!d || typeof d !== 'object') return null;
    if (d.ratings && typeof d.ratings === 'object') d = d.ratings;
    var keys = RADAR_AXES.filter(function (k) { return isNum(Number(d[k])) && d[k] !== null && d[k] !== ''; });
    if (keys.length < 3) keys = Object.keys(d).filter(function (k) { return isNum(d[k]); }).slice(0, 12);
    if (keys.length < 3) return null;
    return { keys: keys, values: keys.map(function (k) { return clamp(Number(d[k]), 0, 100); }) };
  }
  function tier(v) { return v >= 90 ? 'Exceptional' : v >= 75 ? 'Strong' : v >= 55 ? 'Above average' : v >= 40 ? 'Average' : v >= 25 ? 'Below average' : 'Weak'; }

  KINDS.radar = {
    aspect: 0.9, minH: 200, maxH: 380, wrap: true, morph: true, emptyText: 'No ratings',
    draw: function (ctx, env) {
      var th = env.th, o = env.opts || {};
      var R0 = ratingsOf(env.data);
      if (!R0) return drawEmpty(ctx, env, 'No ratings yet');
      var C0 = ratingsOf(env.compare);
      var keys = R0.keys, n = keys.length, vals = R0.values.slice();
      if (env.morph && env.morph.prev && env.morph.prev.keys.join() === keys.join()) {
        vals = vals.map(function (v, i) { return lerp(env.morph.prev.values[i], v, env.morph.t); });
      }
      env.out.snapshot = { keys: keys, values: vals.slice() };
      var cvals = C0 ? keys.map(function (k) { var j = C0.keys.indexOf(k); return j >= 0 ? C0.values[j] : null; }) : null;

      var lgH = 0;
      if (cvals) lgH = drawLegend(ctx, th, [{ label: o.label || 'This build', color: th.accent, type: 'rect' }, { label: o.compareLabel || 'Compare', color: th.accent2, dash: [5, 4] }], 10, 4, env.w - 20) + 4;
      var cx = env.w / 2, cy = lgH + (env.h - lgH) / 2;
      ctx.font = font(th, 10.5, 500);
      var short = env.w < 330;
      var labels = keys.map(function (k) { return short ? (RADAR_SHORT[k] || titleCase(k)) : titleCase(k); });
      var maxLW = 0; labels.forEach(function (l) { maxLW = Math.max(maxLW, ctx.measureText(l).width); });
      var R = Math.max(30, Math.min(env.w / 2 - maxLW - 14, (env.h - lgH) / 2 - 30));
      var ang = function (i) { return -Math.PI / 2 + i * Math.PI * 2 / n; };
      var pt = function (i, v) { var a = ang(i); return [cx + Math.cos(a) * R * v / 100, cy + Math.sin(a) * R * v / 100]; };

      // hover axis
      var hi = -1;
      env.out.count = n;
      if (env.pointer) {
        var dx = env.pointer.x - cx, dy = env.pointer.y - cy, dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= R + 34 && dist > 4) {
          var a = Math.atan2(dy, dx) + Math.PI / 2; if (a < 0) a += Math.PI * 2;
          hi = Math.round(a / (Math.PI * 2 / n)) % n;
          env.out.cursor = 'pointer';
        }
      } else if (env.focusIdx != null) hi = ((env.focusIdx % n) + n) % n;

      // rings
      ctx.save();
      [100, 80, 60, 40, 20].forEach(function (lv, ri) {
        ctx.beginPath();
        for (var i = 0; i < n; i++) { var p = pt(i, lv); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }
        ctx.closePath();
        ctx.fillStyle = ri % 2 === 0 ? rgba(th.text, th.dark ? 0.022 : 0.03) : rgba(th.surface, 0.0);
        ctx.fill();
        ctx.strokeStyle = lv === 100 ? th.grid : th.gridFaint; ctx.lineWidth = 1; ctx.stroke();
      });
      // spokes
      for (var i = 0; i < n; i++) {
        var p = pt(i, 100);
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p[0], p[1]);
        ctx.strokeStyle = i === hi ? rgba(th.accent, 0.8) : th.gridFaint; ctx.lineWidth = i === hi ? 1.5 : 1; ctx.stroke();
      }
      // ring values along the first spoke
      if (R > 70) {
        ctx.font = font(th, 8.5, 400, true); ctx.fillStyle = rgba(th.textDim, 0.75); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        [20, 40, 60, 80].forEach(function (lv) { var q = pt(0, lv); ctx.fillText(String(lv), q[0] + 3, q[1]); });
      }
      ctx.restore();

      var s = env.progress;
      function poly(values, fill, stroke, dash, width) {
        ctx.beginPath();
        var started = false;
        values.forEach(function (v, i) {
          if (v == null) return;
          var q = pt(i, v * s);
          if (!started) { ctx.moveTo(q[0], q[1]); started = true; } else ctx.lineTo(q[0], q[1]);
        });
        ctx.closePath();
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        ctx.setLineDash(dash || []); ctx.strokeStyle = stroke; ctx.lineWidth = width || 2; ctx.lineJoin = 'round'; ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.save();
      if (cvals) poly(cvals, rgba(th.accent2, 0.08), th.accent2, [5, 4], 1.6);
      poly(vals, rgba(th.accent, th.dark ? 0.22 : 0.18), th.accent, null, 2);
      vals.forEach(function (v, i) { var q = pt(i, v * s); dot(ctx, q[0], q[1], i === hi ? 4.5 : 3, th.accent, th.surface, 1.75); });
      if (cvals && hi >= 0 && cvals[hi] != null) { var cq = pt(hi, cvals[hi] * s); ringDot(ctx, cq[0], cq[1], 3.5, th.accent2, th.surface); }
      ctx.restore();

      // labels
      ctx.save();
      for (var j = 0; j < n; j++) {
        var aa = ang(j), cs = Math.cos(aa), sn = Math.sin(aa);
        var lx = cx + cs * (R + 10), ly = cy + sn * (R + 10);
        ctx.textAlign = cs > 0.25 ? 'left' : cs < -0.25 ? 'right' : 'center';
        var base = sn > 0.4 ? 'top' : sn < -0.4 ? 'bottom' : 'middle';
        var nameY = base === 'top' ? ly : base === 'bottom' ? ly - 12 : ly - 6;
        ctx.textBaseline = 'middle';
        ctx.font = font(th, 10.5, j === hi ? 600 : 500); ctx.fillStyle = j === hi ? th.text : th.textDim;
        ctx.fillText(labels[j], lx, nameY + 5);
        ctx.font = font(th, 10.5, 700, true); ctx.fillStyle = th.text;
        ctx.fillText(String(Math.round(vals[j])), lx, nameY + 17);
      }
      ctx.restore();

      // centre average
      var avg = vals.reduce(function (a, b) { return a + b; }, 0) / n;
      if (R > 80 && hi < 0) {
        pill(ctx, th, 'AVG ' + Math.round(avg), cx, cy, { size: 9.5, bg: rgba(th.surface, 0.9) });
      }

      if (hi >= 0) {
        var hp = pt(hi, vals[hi]);
        var rows = [{ color: th.accent, key: 'rect', label: o.label || 'This build', value: Math.round(vals[hi]) + ' / 100' }];
        if (cvals && cvals[hi] != null) {
          rows.push({ color: th.accent2, dash: [4, 3], label: o.compareLabel || 'Compare', value: Math.round(cvals[hi]) + ' / 100' });
          rows.push({ label: 'Difference', value: signed(Math.round(vals[hi] - cvals[hi]), 0), valueColor: vals[hi] >= cvals[hi] ? th.good : th.bad });
        }
        rows.push({ label: 'Tier', value: tier(vals[hi]), dim: true });
        drawTip(ctx, env, hp[0], hp[1], titleCase(keys[hi]), rows);
      }
      env.out.summary = 'Ratings radar: ' + keys.map(function (k, i) { return titleCase(k) + ' ' + Math.round(R0.values[i]); }).join(', ') + '. Average ' + Math.round(avg) + '.';
    }
  };

  /* ------------------------------------------------------------------ DOWNFORCE */
  function dfCurveOf(m) {
    var c = arr(m && m.downforceCurve).filter(function (p) { return p && isNum(Number(p.kph)) && isNum(Number(p.kg)); })
      .map(function (p) { return { kph: Number(p.kph), kg: Number(p.kg) }; }).sort(function (a, b) { return a.kph - b.kph; });
    if (c.length < 2 && m && isNum(m.downforce_kg_200)) {
      var vmax = Math.max(240, num(m.topSpeed_kph, 260));
      c = [];
      for (var v = 0; v <= vmax + 0.1; v += 10) c.push({ kph: v, kg: m.downforce_kg_200 * Math.pow(v / 200, 2) });
    }
    return c;
  }
  KINDS.downforce = {
    aspect: 0.5, minH: 170, maxH: 360, emptyText: 'No aero data',
    draw: function (ctx, env) {
      var th = env.th, m = env.data || {}, c = env.compare, o = env.opts || {};
      var curve = dfCurveOf(m);
      if (curve.length < 2) return drawEmpty(ctx, env, 'No aero data', 'Aero package not yet computed');
      var cc = c ? dfCurveOf(c) : [];
      var imp = o.units === 'imperial' || o.speedUnit === 'mph';
      var K = imp ? 0.621371 : 1, SU = imp ? 'mph' : 'km/h', W = imp ? 2.20462 : 1, WU = imp ? 'lbf' : 'kgf';
      var cda = num(m.cda, num(m.cd, 0.32) * num(m.frontalArea_m2, 2.1));
      var drag = function (kph) { var v = kph / 3.6; return 0.5 * 1.225 * cda * v * v / 9.81; };
      var top = num(m.topSpeed_kph, 0);
      var xmax = Math.max(last(curve).kph, top, cc.length ? last(cc).kph : 0);
      curve.forEach(function (p) { p.drag = drag(p.kph); });
      var yMax = 0;
      curve.concat(cc).forEach(function (p) { yMax = Math.max(yMax, p.kg); });
      yMax = Math.max(yMax, drag(xmax), 10);

      var items = [{ label: 'Downforce', color: th.accent, type: 'rect' }, { label: 'Aero drag', color: th.accent2 }];
      if (cc.length) items.push({ label: (o.compareLabel || 'Compare') + ' downforce', color: th.accent, dash: [5, 4], alpha: 0.75 });
      var lgH = drawLegend(ctx, th, items, 12, 6, env.w - 24);
      var F = xyFrame(ctx, env, {
        top: 6 + lgH + 12,
        x: { min: 0, max: xmax * K, title: 'Speed (' + SU + ')' },
        y: { min: 0, max: yMax * W * 1.12, title: 'Force (' + WU + ')' }
      });
      drawXYGrid(ctx, env, F);
      var X = function (k) { return F.sx(k * K); }, Y = function (kg) { return F.sy(kg * W); };

      var wt = num(m.weight_kg, 0);
      if (wt > 0 && wt * W <= F.y.max) {
        hline(ctx, F.l, F.r, Y(wt), rgba(th.textDim, 0.7), 1, [6, 4]);
        ctx.save(); ctx.font = font(th, 9.5, 600); ctx.fillStyle = th.textDim; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText('= vehicle weight (' + fmtN(wt * W) + ' ' + (imp ? 'lb' : 'kg') + ')', F.l + 6, Y(wt) - 3); ctx.restore();
      }
      if (top > 0 && top * K <= F.x.max) {
        vline(ctx, X(top), F.t, F.b, rgba(th.textDim, 0.6), 1, [4, 4]);
        ctx.save(); ctx.font = font(th, 9.5, 600); ctx.fillStyle = th.textDim; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
        ctx.fillText('Vmax', X(top) - 4, F.t + 3); ctx.restore();
      }

      var dfPts = curve.map(function (p) { return [X(p.kph), Y(p.kg)]; });
      var drPts = [];
      for (var v = 0; v <= xmax + 0.1; v += xmax / 40) drPts.push([X(v), Y(drag(v))]);
      ctx.save();
      revealClip(ctx, env, F);
      fillUnder(ctx, dfPts, F.b, F.t, th.accent, th.dark ? 0.34 : 0.26, 0.04);
      if (cc.length) strokeSeries(ctx, cc.map(function (p) { return [X(p.kph), Y(p.kg)]; }), th.accent, 1.6, [5, 4], 0.75);
      strokeSeries(ctx, drPts, th.accent2, 2);
      strokeSeries(ctx, dfPts, th.accent, 2.25);
      ctx.restore();

      // reference marker
      var refK = imp ? 150 / K : 200;
      var refKg = interpAt(curve, 'kph', 'kg', refK);
      if (isNum(m.downforce_kg_200) && !imp) refKg = m.downforce_kg_200;
      var pa = clamp((env.rawProgress - 0.7) / 0.3, 0, 1);
      if (refKg != null && refK <= xmax && pa > 0) {
        ctx.save(); ctx.globalAlpha = pa;
        var rx = X(refK), ry = Y(refKg);
        dot(ctx, rx, ry, 4, th.accent, th.surface);
        pill(ctx, th, fmtN(refKg * W) + ' ' + WU + ' @ ' + fmtN(refK * K) + ' ' + SU, rx, ry - 10, { vAlign: 'bottom', bounds: { l: F.l + 2, r: F.r - 2, t: F.t, b: F.b }, border: rgba(th.accent, 0.7) });
        ctx.restore();
      }

      var hi = hoverIndex(env, F, curve, 'kph');
      if (hi >= 0) {
        var p = curve[hi], hx = X(p.kph), d = drag(p.kph), vms = p.kph / 3.6;
        crosshair(ctx, env, F, hx);
        var rows = [
          { color: th.accent, key: 'rect', label: 'Downforce', value: fmtN(p.kg * W) + ' ' + WU },
          { color: th.accent2, label: 'Aero drag', value: fmtN(d * W) + ' ' + WU },
          { label: 'Lift / drag', value: d > 0.01 ? fmtN(p.kg / d, 2) : '—' },
          { label: 'Drag power', value: fmtN(d * 9.81 * vms / 745.7) + ' hp' }
        ];
        if (wt > 0) rows.push({ label: 'Grip added', value: '+' + fmtN(p.kg / wt * 100, 1) + ' %', dim: true });
        if (cc.length) {
          var cv = interpAt(cc, 'kph', 'kg', p.kph);
          rows.push({ sep: true });
          rows.push({ color: th.accent, dash: [4, 3], label: o.compareLabel || 'Compare', value: cv == null ? '—' : fmtN(cv * W) + ' ' + WU + '  ' + signed((p.kg - cv) * W, 0) });
        }
        dot(ctx, hx, Y(p.kg), 4.5, th.accent, th.surface);
        dot(ctx, hx, Y(d), 3.5, th.accent2, th.surface);
        xPill(ctx, env, F, hx, fmtN(p.kph * K) + ' ' + SU);
        drawTip(ctx, env, hx, Y(p.kg), fmtN(p.kph * K) + ' ' + SU, rows);
      }
      env.out.summary = 'Aero chart: ' + (refKg != null ? fmtN(refKg * W) + ' ' + WU + ' of downforce at ' + fmtN(refK * K) + ' ' + SU : 'downforce curve') + ', CdA ' + fmtN(cda, 3) + ' m².';
    }
  };

  /* ------------------------------------------------------------------ WEIGHT */
  var WEIGHT_CATS = [
    { id: 'body', name: 'Body & chassis' },
    { id: 'engine', name: 'Engine' },
    { id: 'motors', name: 'E-motors & inverters' },
    { id: 'battery', name: 'Traction battery' },
    { id: 'fuel', name: 'Fuel & fluids' },
    { id: 'driveline', name: 'Transmission & driveline' },
    { id: 'suspension', name: 'Suspension' },
    { id: 'wheels', name: 'Wheels & tyres' },
    { id: 'brakes', name: 'Brakes' },
    { id: 'aero', name: 'Aero' },
    { id: 'interior', name: 'Interior & tech' },
    { id: 'safety', name: 'Cage & safety' },
    { id: 'ballast', name: 'Ballast' },
    { id: 'other', name: 'Other' }
  ];
  function findOpt(coll, id) {
    var D = CB.data;
    if (!D) return null;
    try { if (typeof D.find === 'function') return D.find(coll, id) || null; } catch (e) { /* fall through */ }
    var list = coll.split('.').reduce(function (o, k) { return o && o[k]; }, D);
    return arr(list).filter(function (x) { return x && x.id === id; })[0] || null;
  }
  function wOf(o) { return o ? num(o.weight_kg, 0) : 0; }
  /** Rough mass estimate per subsystem from the build; scaled to the physics total. */
  function estimateBreakdown(build, total) {
    if (!build || !build.body || !CB.data) return null;
    var b = build, e = b.engine || {}, parts = {};
    var add = function (k, v) { if (isNum(v) && v > 0) parts[k] = (parts[k] || 0) + v; };
    var isEV = e.type === 'ev', isHy = e.type === 'hybrid';
    if (!isEV) {
      var lay = findOpt('engineLayouts', e.layout);
      add('engine', num(lay && (lay.baseWeight_kg || lay.weight_kg), 160) * (lay && lay.displacementRange ? lerp(0.9, 1.15, clamp((num(e.displacement_l, 3) - lay.displacementRange[0]) / ((lay.displacementRange[1] - lay.displacementRange[0]) || 1), 0, 1)) : 1));
      add('engine', wOf(findOpt('aspirations', e.aspiration)) + wOf(findOpt('exhausts', e.exhaust)) + wOf(findOpt('coolings', e.cooling)) + 18);
      add('fuel', e.fuel === 'diesel' ? 60 * 0.84 + 14 : 60 * 0.74 + 14);
    } else {
      add('fuel', 12);
    }
    if (isEV || isHy) {
      var chem = findOpt('batteryChemistries', e.chemistry);
      var whkg = num(chem && chem.whPerKg, 180);
      add('battery', num(e.battery_kwh, isEV ? 85 : 10) * 1000 / whkg * 1.45);
      add('motors', num(e.motors, 1) * (22 + num(e.motorPower_kw, 150) * 0.11));
    }
    var tr = findOpt('transmissions', (b.transmission || {}).type);
    add('driveline', wOf(tr) || 70);
    var dl = (b.drivetrain || {}).layout;
    add('driveline', dl === 'awd' ? 68 : 28);
    var st = findOpt('suspensionTypes', (b.suspension || {}).type);
    add('suspension', 4 * 13 + wOf(st));
    var w = b.wheels || {}, t = b.tires || {}, wm = findOpt('wheelMaterials', w.material);
    var d = num(w.diameter_in, 18), wf = num(wm && wm.weightFactor, 1);
    var wheel = function (wid) { return (5.5 + (d - 15) * 1.05 + num(wid, 8.5) * 0.55) * wf; };
    var tyre = function (tw, prof) { return 6.5 + (d - 15) * 0.45 + (num(tw, 245) - 175) * 0.028 + num(prof, 40) * 0.03; };
    add('wheels', 2 * (wheel(w.widthFront_in) + wheel(w.widthRear_in)) + 2 * (tyre(t.widthFront_mm, t.profileFront) + tyre(t.widthRear_mm, t.profileRear)));
    var br = b.brakes || {}, bm = findOpt('brakeMaterials', br.material);
    var rotor = num(bm && bm.weightPerRotor_kg, 9);
    add('brakes', 2 * rotor * (num(br.frontRotor_mm, 360) / 360) + 2 * rotor * (num(br.rearRotor_mm, 330) / 360) + (num(br.frontPistons, 4) + num(br.rearPistons, 2)) * 2 * 0.35 + 10);
    var a = b.aero || {}, O = (CB.data && CB.data.optionWeights) || {};
    add('aero', wOf(findOpt('aero.splitters', a.splitter)) + wOf(findOpt('aero.wings', a.wing)) + wOf(findOpt('aero.diffusers', a.diffuser)) +
      (a.canards ? num(O.canards, 2) : 0) + (a.sideSkirts ? num(O.sideSkirts, 6) : 0) + (a.activeAero ? num(O.activeAero, 9) : 0));
    var i = b.interior || {}, tc = b.tech || {}, wt = b.weight || {};
    var seats = num((b.body || {}).seats, 4) - (wt.rearSeats === false ? Math.max(0, num((b.body || {}).seats, 4) - 2) : 0);
    add('interior', 60 + seats * 17 + wOf(findOpt('seatTypes', i.seatType)) * 2 + wOf(findOpt('upholsteries', i.upholstery)) + wOf(findOpt('trims', i.trim)) +
      wOf(findOpt('audioSystems', tc.audio)) + wOf(findOpt('adasLevels', tc.adas)) + (wt.soundDeadening === false ? 0 : 22) + (wt.spareTire ? 18 : 0));
    add('safety', wOf(findOpt('rollCages', wt.rollCage)) + (i.harness ? 4 : 0) + 18);
    add('ballast', num(wt.ballast_kg, 0));
    var sum = Object.keys(parts).reduce(function (s, k) { return s + parts[k]; }, 0);
    total = num(total, 0);
    if (total > 0) {
      var body = total - sum;
      if (body < total * 0.25) { // estimates too heavy – scale non-body parts down
        var scale = (total * 0.75) / sum;
        Object.keys(parts).forEach(function (k) { if (k !== 'ballast') parts[k] *= scale; });
        body = total - Object.keys(parts).reduce(function (s, k) { return s + parts[k]; }, 0);
      }
      parts.body = body;
    } else {
      var bs = findOpt('bodyStyles', b.body.style), cm = findOpt('chassisMaterials', b.body.chassisMaterial);
      parts.body = num(bs && bs.baseWeight_kg, 1400) * 0.45 * num(cm && cm.weightFactor, 1);
    }
    return parts;
  }
  function normalizeBreakdown(src) {
    var out = {};
    if (Array.isArray(src)) {
      src.forEach(function (r) {
        if (!r) return;
        var key = r.id || r.key || r.label || r.name, kg = num(r.kg != null ? r.kg : r.weight_kg != null ? r.weight_kg : r.value, NaN);
        if (key && isNum(kg)) out[String(key)] = (out[String(key)] || 0) + kg;
      });
    } else if (src && typeof src === 'object') {
      Object.keys(src).forEach(function (k) { var v = num(src[k], NaN); if (isNum(v)) out[k] = v; });
    }
    return Object.keys(out).length ? out : null;
  }

  KINDS.weight = {
    aspect: 0.62, minH: 150, maxH: 380, morph: true, emptyText: 'No weight data',
    draw: function (ctx, env) {
      var th = env.th, m = env.data || {}, o = env.opts || {};
      var total = num(m.weight_kg, NaN), fp = num(m.weightFront_pct, NaN);
      if (!isNum(total) || total <= 0 || !isNum(fp)) return drawEmpty(ctx, env, 'No weight data');
      if (fp <= 1) fp *= 100;
      fp = clamp(fp, 0, 100);
      var imp = o.units === 'imperial';
      var W = imp ? 2.20462 : 1, WU = imp ? 'lb' : 'kg';
      var fpD = fp;
      if (env.morph && env.morph.prev && isNum(env.morph.prev.fp)) fpD = lerp(env.morph.prev.fp, fp, env.morph.t);
      env.out.snapshot = { fp: fpD };

      var pad = 12, x0 = pad, x1 = env.w - pad, bw = x1 - x0;
      var front = total * fp / 100, rear = total - front;
      var hover = null; // {type:'front'|'rear'|'row', idx}
      var P = env.pointer;

      // header
      ctx.save();
      ctx.textBaseline = 'alphabetic';
      ctx.font = font(th, 9.5, 600); ctx.fillStyle = th.textDim;
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
      ctx.textAlign = 'left'; ctx.fillText('FRONT AXLE', x0, 16);
      ctx.textAlign = 'right'; ctx.fillText('REAR AXLE', x1, 16);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.font = font(th, 17, 700, true); ctx.fillStyle = th.text;
      ctx.textAlign = 'left'; ctx.fillText(fmtN(fpD, 1) + '%', x0, 38);
      var fw = ctx.measureText(fmtN(fpD, 1) + '%').width;
      ctx.textAlign = 'right'; ctx.fillText(fmtN(100 - fpD, 1) + '%', x1, 38);
      var rw = ctx.measureText(fmtN(100 - fpD, 1) + '%').width;
      ctx.font = font(th, 10.5, 500, true); ctx.fillStyle = th.textDim;
      ctx.textAlign = 'left'; ctx.fillText(fmtN(front * W) + ' ' + WU, x0 + fw + 6, 37);
      ctx.textAlign = 'right'; ctx.fillText(fmtN(rear * W) + ' ' + WU, x1 - rw - 6, 37);
      // centre verdict
      var bias = fp - 50, verdict = Math.abs(bias) < 1.5 ? 'Balanced' : bias > 0 ? fmtN(Math.abs(bias), 1) + '% nose-heavy' : fmtN(Math.abs(bias), 1) + '% tail-heavy';
      if (bw > 330) { ctx.font = font(th, 10.5, 500); ctx.textAlign = 'center'; ctx.fillStyle = th.textDim; ctx.fillText(verdict + ' · ' + fmtN(total * W) + ' ' + WU + ' total', env.w / 2, 37); }
      ctx.restore();

      // F/R bar
      var by = 48, bh = 16, split = x0 + bw * (50 + (fpD - 50) * env.progress) / 100;
      if (P && P.y >= by - 6 && P.y <= by + bh + 6 && P.x >= x0 && P.x <= x1) { hover = { type: P.x < split ? 'front' : 'rear' }; env.out.cursor = 'pointer'; }
      if (env.focusIdx === 0) hover = { type: 'front' }; else if (env.focusIdx === 1) hover = { type: 'rear' };
      ctx.save();
      roundRect(ctx, x0, by, Math.max(0, split - x0 - 1), bh, 4);
      ctx.fillStyle = hover && hover.type === 'rear' ? rgba(th.accent, 0.55) : th.accent; ctx.fill();
      roundRect(ctx, split + 1, by, Math.max(0, x1 - split - 1), bh, 4);
      ctx.fillStyle = hover && hover.type === 'front' ? rgba(th.accent2, 0.55) : th.accent2; ctx.fill();
      // 50:50 reference
      var mx = x0 + bw / 2;
      vline(ctx, mx, by - 5, by + bh + 5, th.text, 1.5);
      ctx.font = font(th, 9, 600, true); ctx.fillStyle = th.textDim; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText('50:50', mx, by + bh + 6);
      // ideal marker per engine position (if known)
      var idealPct = isNum(m.idealFront_pct) ? m.idealFront_pct : null;
      if (idealPct != null) {
        var ix = x0 + bw * idealPct / 100;
        ctx.beginPath(); ctx.moveTo(ix, by - 2); ctx.lineTo(ix - 4, by - 8); ctx.lineTo(ix + 4, by - 8); ctx.closePath(); ctx.fillStyle = th.good; ctx.fill();
      }
      ctx.restore();

      // corners + CG line
      var cy = by + bh + 22;
      ctx.save();
      ctx.font = font(th, 10, 500, true); ctx.fillStyle = th.textDim; ctx.textBaseline = 'middle';
      var fl = front / 2 * W, rl = rear / 2 * W;
      var cgTxt = isNum(m.cgHeight_mm) ? '   CG ' + fmtN(imp ? m.cgHeight_mm / 25.4 : m.cgHeight_mm, imp ? 1 : 0) + (imp ? ' in' : ' mm') : '';
      var cornerTxt = bw > 380 ? 'Corners  FL ' + fmtN(fl) + '  FR ' + fmtN(fl) + '  RL ' + fmtN(rl) + '  RR ' + fmtN(rl) + ' ' + WU + cgTxt
        : 'F ' + fmtN(fl) + ' ×2  R ' + fmtN(rl) + ' ×2 ' + WU + cgTxt;
      ctx.textAlign = 'center'; ctx.fillText(cornerTxt, env.w / 2, cy);
      ctx.restore();

      // breakdown
      var bd = normalizeBreakdown(m.weightBreakdown || o.breakdown), estimated = false;
      if (!bd) {
        var build = o.build || (CB.state && typeof CB.state.get === 'function' ? CB.state.get() : null);
        bd = estimateBreakdown(build, total); estimated = !!bd;
      }
      var rows = [];
      if (bd) {
        var known = {};
        WEIGHT_CATS.forEach(function (c) { known[c.id] = c; });
        WEIGHT_CATS.forEach(function (c) { if (bd[c.id] > 0.5) rows.push({ id: c.id, name: c.name, kg: bd[c.id] }); });
        Object.keys(bd).forEach(function (k) { if (!known[k] && bd[k] > 0.5) rows.push({ id: k, name: titleCase(k), kg: bd[k] }); });
      }
      var top = cy + 16, avail = env.h - top - 6;
      env.out.count = 2 + rows.length;
      var rowHover = -1;
      if (rows.length && avail > 26) {
        var sum = rows.reduce(function (s, r) { return s + r.kg; }, 0) || 1;
        ctx.save();
        ctx.font = font(th, 9.5, 600); ctx.fillStyle = th.textDim; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
        ctx.fillText('MASS BREAKDOWN' + (estimated ? ' (EST.)' : ''), x0, top + 6);
        if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
        ctx.restore();
        var listTop = top + 18, rowH = 17, listAvail = env.h - listTop - 4;
        if (rows.length * rowH <= listAvail) {
          // list mode – single-hue magnitude bars, direct labels
          var labW = Math.min(150, Math.max(92, bw * 0.34)), valW = bw > 300 ? 98 : 64;
          var maxKg = Math.max.apply(null, rows.map(function (r) { return r.kg; }));
          rows.forEach(function (r, i) {
            var ry = listTop + i * rowH;
            var hit = P && P.y >= ry && P.y < ry + rowH && P.x >= x0 && P.x <= x1;
            if (hit || env.focusIdx === i + 2) { rowHover = i; env.out.cursor = 'pointer'; }
            if (rowHover === i) { roundRect(ctx, x0 - 4, ry, bw + 8, rowH - 1, 3); ctx.fillStyle = rgba(th.text, 0.05); ctx.fill(); }
            ctx.font = font(th, 10.5, 500); ctx.fillStyle = rowHover === i ? th.text : th.textDim; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            var nm = r.name;
            while (ctx.measureText(nm).width > labW - 6 && nm.length > 4) nm = nm.slice(0, -2) + '…';
            ctx.fillText(nm, x0, ry + rowH / 2);
            var bx = x0 + labW, bwid = Math.max(2, (bw - labW - valW - 8) * r.kg / maxKg * env.progress);
            roundRect(ctx, bx, ry + 4, bwid, rowH - 9, 2);
            ctx.fillStyle = rowHover === i ? th.accent : rgba(th.accent, 0.78); ctx.fill();
            ctx.font = font(th, 10.5, 600, true); ctx.fillStyle = th.text; ctx.textAlign = 'right';
            ctx.fillText(fmtN(r.kg * W) + (valW > 70 ? ' ' + WU + '  ' : '  '), x1 - 34, ry + rowH / 2);
            ctx.font = font(th, 10, 400, true); ctx.fillStyle = th.textDim;
            ctx.fillText(fmtN(r.kg / sum * 100, 0) + '%', x1, ry + rowH / 2);
          });
        } else {
          // stacked mode – fold to 7 + Other so categorical colours stay legible
          var srt = rows.slice().sort(function (a, b) { return b.kg - a.kg; });
          var keep = srt.slice(0, 7), rest = srt.slice(7);
          var keepIds = keep.map(function (r) { return r.id; });
          var segs = rows.filter(function (r) { return keepIds.indexOf(r.id) >= 0; });
          if (rest.length) segs.push({ id: 'other*', name: 'Other', kg: rest.reduce(function (s, r) { return s + r.kg; }, 0) });
          var sy = listTop, sh = 14, cx = x0;
          segs.forEach(function (sg, i) {
            var sw = (bw - (segs.length - 1) * 2) * sg.kg / sum * env.progress;
            var hit = P && P.y >= sy - 4 && P.y <= sy + sh + 4 && P.x >= cx && P.x < cx + sw + 2;
            if (hit || env.focusIdx === i + 2) { rowHover = i; env.out.cursor = 'pointer'; }
            roundRect(ctx, cx, sy, Math.max(1, sw), sh, 3);
            ctx.fillStyle = rowHover >= 0 && rowHover !== i ? rgba(th.cat[i % 8], 0.4) : th.cat[i % 8]; ctx.fill();
            sg._x = cx; sg._w = sw;
            cx += sw + 2;
          });
          rows = segs;
          var lgItems = segs.map(function (s, i) { return { label: s.name + ' ' + fmtN(s.kg / sum * 100, 0) + '%', color: th.cat[i % 8], type: 'rect' }; });
          if (env.h - (sy + sh + 8) > 18) drawLegend(ctx, th, lgItems, x0, sy + sh + 6, bw);
        }
      }

      // tooltip
      if (hover) {
        var isF = hover.type === 'front', kg = isF ? front : rear;
        drawTip(ctx, env, isF ? (x0 + split) / 2 : (split + x1) / 2, by + bh / 2, isF ? 'Front axle' : 'Rear axle', [
          { color: isF ? th.accent : th.accent2, key: 'rect', label: 'Axle load', value: fmtN(kg * W) + ' ' + WU },
          { label: 'Share', value: fmtN(isF ? fp : 100 - fp, 1) + ' %' },
          { label: 'Per corner', value: fmtN(kg / 2 * W) + ' ' + WU },
          { label: 'Bias vs 50:50', value: signed((isF ? fp : 100 - fp) - 50, 1, '%'), dim: true }
        ]);
      } else if (rowHover >= 0 && rows[rowHover]) {
        var r = rows[rowHover], sumAll = rows.reduce(function (s, q) { return s + q.kg; }, 0) || 1;
        var tipY = r._x != null ? (top + 18 + 7) : (top + 18 + rowHover * 17 + 8);
        var tipX = r._x != null ? r._x + r._w / 2 : (P ? P.x : env.w / 2);
        drawTip(ctx, env, tipX, tipY, r.name, [
          { label: 'Mass', value: fmtN(r.kg * W) + ' ' + WU },
          { label: 'Of kerb weight', value: fmtN(r.kg / sumAll * 100, 1) + ' %' },
          { label: 'Power-to-weight', value: isNum(m.powerToWeight_hpPerTon) ? fmtN(m.powerToWeight_hpPerTon) + ' hp/t' : '—', dim: true },
          estimated ? { label: 'Source', value: 'estimated', dim: true } : null
        ]);
      }
      env.out.summary = 'Weight distribution: ' + fmtN(fp, 1) + '% front, ' + fmtN(100 - fp, 1) + '% rear, total ' + fmtN(total * W) + ' ' + WU + '.' +
        (rows.length ? ' Breakdown: ' + rows.map(function (r) { return r.name + ' ' + fmtN(r.kg * W) + ' ' + WU; }).join(', ') + '.' : '');
    }
  };

  /* ------------------------------------------------------------------ PRICE DONUT */
  var PRICE_GROUPS = [
    { id: 'base', name: 'Base & body', match: ['base', 'body', 'chassis', 'vehicle', 'msrp'] },
    { id: 'powertrain', name: 'Powertrain', match: ['engine', 'transmission', 'drivetrain', 'powertrain', 'battery', 'ev', 'motor', 'electric'] },
    { id: 'chassis', name: 'Chassis & dynamics', match: ['suspension', 'brakes', 'wheels', 'tires', 'tyres', 'aero', 'weight', 'chassis-dyn'] },
    { id: 'exterior', name: 'Exterior', match: ['exterior', 'paint', 'livery'] },
    { id: 'interior', name: 'Interior', match: ['interior', 'cabin'] },
    { id: 'tech', name: 'Technology', match: ['tech', 'technology', 'electronics', 'options'] },
    { id: 'fees', name: 'Taxes & fees', match: ['fees', 'fee', 'tax', 'taxes', 'destination', 'delivery', 'duty'] },
    { id: 'other', name: 'Other', match: [] }
  ];
  function groupFor(section) {
    var s = String(section || '').toLowerCase();
    for (var i = 0; i < PRICE_GROUPS.length; i++) if (PRICE_GROUPS[i].match.indexOf(s) >= 0) return i;
    for (var j = 0; j < PRICE_GROUPS.length; j++) {
      if (PRICE_GROUPS[j].match.some(function (m) { return s.indexOf(m) >= 0; })) return j;
    }
    return PRICE_GROUPS.length - 1;
  }
  function sectionTitle(id) {
    try { if (CB.panels && CB.panels[id] && CB.panels[id].title) return CB.panels[id].title; } catch (e) { /* ignore */ }
    return titleCase(id || 'Other');
  }
  function priceGroups(pricing) {
    var lines = Array.isArray(pricing) ? pricing : arr(pricing && pricing.lines);
    var groups = PRICE_GROUPS.map(function (g, i) { return { idx: i, id: g.id, name: g.name, amount: 0, lines: [], sections: {} }; });
    var credits = [], sumLines = 0;
    lines.forEach(function (l) {
      if (!l) return;
      var a = num(l.amount, 0);
      sumLines += a;
      if (a < 0) { credits.push(l); return; }
      if (a === 0) return;
      var g = groups[groupFor(l.section)];
      g.amount += a; g.lines.push(l);
      g.sections[l.section || 'other'] = (g.sections[l.section || 'other'] || 0) + a;
    });
    if (!Array.isArray(pricing) && pricing) {
      var already = groups[6].amount > 0;
      var linesAreTotal = isNum(pricing.total) && Math.abs(sumLines - pricing.total) < 1;
      if (!already && !linesAreTotal) {
        [['destination', 'Destination & delivery'], ['gasGuzzlerTax', 'Gas-guzzler tax'], ['luxuryTax', 'Luxury tax'], ['salesTax', 'Sales tax'], ['fees', 'Fees']].forEach(function (f) {
          var v = num(pricing[f[0]], 0);
          if (v > 0) { groups[6].amount += v; groups[6].lines.push({ label: f[1], amount: v, section: 'fees' }); }
        });
      }
      if (isNum(pricing.evCredit) && pricing.evCredit !== 0 && !credits.some(function (c) { return /credit/i.test(c.label || ''); })) {
        credits.push({ label: 'EV credit', amount: -Math.abs(pricing.evCredit) });
      }
    }
    return { groups: groups.filter(function (g) { return g.amount > 0.5; }), credits: credits };
  }

  KINDS.priceDonut = {
    aspect: 0.62, minH: 190, maxH: 380, wrap: true, morph: true, emptyText: 'No pricing',
    // Wide containers put the legend beside the ring; narrow ones (the summary sidebar) stack ring above
    // a full legend, so the canvas grows to fit every group instead of squeezing the ring.
    heightFor: function (w, data) {
      var n = 0;
      try { n = priceGroups(data).groups.length; } catch (e) { n = 6; }
      if (w > 340 && w >= 420) return clamp(Math.round(w * 0.55), 190, 380);
      var ring = clamp(Math.round(w * 0.62), 150, 230);
      return ring + 8 + Math.min(Math.max(n, 1), 10) * 20 + 6;
    },
    draw: function (ctx, env) {
      var th = env.th, p = env.data, o = env.opts || {};
      var G = priceGroups(p);
      var groups = G.groups;
      if (!groups.length) return drawEmpty(ctx, env, 'No pricing yet');
      var sum = groups.reduce(function (s, g) { return s + g.amount; }, 0);
      var total = (!Array.isArray(p) && p && isNum(p.total)) ? p.total : sum + G.credits.reduce(function (s, c) { return s + num(c.amount); }, 0);
      // morph: interpolate fractions per group id
      var fr = {};
      groups.forEach(function (g) { fr[g.id] = g.amount / sum; });
      if (env.morph && env.morph.prev) {
        var prev = env.morph.prev.fr || {};
        Object.keys(fr).forEach(function (k) { fr[k] = lerp(prev[k] || 0, fr[k], env.morph.t); });
      }
      env.out.snapshot = { fr: Object.assign({}, fr) };
      var fsum = Object.keys(fr).reduce(function (s, k) { return s + fr[k]; }, 0) || 1;

      var wide = env.w >= env.h * 1.25 && env.w > 340;
      var legendW = wide ? Math.min(250, env.w * 0.48) : env.w - 24;
      var rowH = 20;
      var legendH = wide ? 0 : Math.min(groups.length, Math.floor((env.h * 0.62) / rowH), Math.max(0, Math.floor((env.h - 150) / rowH))) * rowH;
      var dW = wide ? env.w - legendW - 24 : env.w, dH = env.h - legendH - (wide ? 0 : 8);
      var R = Math.max(30, Math.min(dW, dH) / 2 - 12), r0 = R * 0.62;
      var cx = wide ? 12 + dW / 2 : env.w / 2, cy = wide ? env.h / 2 : 8 + dH / 2;
      var hi = -1;
      env.out.count = groups.length;

      // segment angles
      var a = -Math.PI / 2, segs = [];
      var span = Math.PI * 2 * env.progress;
      groups.forEach(function (g) {
        var sw = span * fr[g.id] / fsum;
        segs.push({ g: g, a0: a, a1: a + sw }); a += sw;
      });
      // hit test segments
      if (env.pointer) {
        var dx = env.pointer.x - cx, dy = env.pointer.y - cy, dd = Math.sqrt(dx * dx + dy * dy);
        if (dd >= r0 - 4 && dd <= R + 10) {
          var ang = Math.atan2(dy, dx);
          if (ang < -Math.PI / 2) ang += Math.PI * 2;
          segs.forEach(function (s, i) { if (ang >= s.a0 && ang < s.a1) hi = i; });
        }
      }
      // legend layout + hit test
      var lx = wide ? env.w - legendW - 8 : 12, ly = wide ? Math.max(8, env.h / 2 - (groups.length * rowH) / 2) : env.h - legendH - 2;
      var visibleRows = wide ? Math.min(groups.length, Math.floor((env.h - 16) / rowH)) : Math.floor(legendH / rowH);
      if (env.pointer && hi < 0) {
        for (var li = 0; li < visibleRows; li++) {
          var ry = ly + li * rowH;
          if (env.pointer.x >= lx - 4 && env.pointer.x <= lx + legendW && env.pointer.y >= ry && env.pointer.y < ry + rowH) hi = li;
        }
      }
      if (hi < 0 && env.focusIdx != null) hi = ((env.focusIdx % groups.length) + groups.length) % groups.length;
      if (hi >= 0) env.out.cursor = 'pointer';

      // draw segments
      ctx.save();
      segs.forEach(function (s, i) {
        if (s.a1 - s.a0 <= 0.0005) return;
        var pop = i === hi ? 6 : 0, mid = (s.a0 + s.a1) / 2;
        var ox = Math.cos(mid) * pop, oy = Math.sin(mid) * pop;
        ctx.beginPath();
        ctx.arc(cx + ox, cy + oy, R + (i === hi ? 2 : 0), s.a0, s.a1);
        ctx.arc(cx + ox, cy + oy, r0, s.a1, s.a0, true);
        ctx.closePath();
        ctx.fillStyle = hi >= 0 && hi !== i ? rgba(th.cat[s.g.idx], 0.38) : th.cat[s.g.idx];
        ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = th.surface; ctx.stroke(); // 2px surface gap
      });
      ctx.restore();

      // centre text
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var compact = r0 < 62;
      if (hi >= 0) {
        var g = segs[hi].g;
        ctx.font = font(th, 9.5, 600); ctx.fillStyle = th.textDim;
        ctx.fillText(g.name.toUpperCase(), cx, cy - r0 * 0.36);
        ctx.font = font(th, compact ? 13 : 17, 700, true); ctx.fillStyle = th.text;
        ctx.fillText(fmtMoney(g.amount, compact), cx, cy);
        ctx.font = font(th, 10.5, 500, true); ctx.fillStyle = th.textDim;
        ctx.fillText(fmtN(g.amount / sum * 100, 1) + '% of options', cx, cy + r0 * 0.36);
      } else {
        ctx.font = font(th, 9.5, 600); ctx.fillStyle = th.textDim;
        ctx.fillText(o.centerLabel || 'TOTAL', cx, cy - r0 * 0.36);
        ctx.font = font(th, compact ? 13 : 18, 700, true); ctx.fillStyle = th.text;
        ctx.fillText(fmtMoney(total * env.progress, compact || total >= 1e7), cx, cy);
        var cred = G.credits.reduce(function (s, c) { return s + num(c.amount); }, 0);
        if (cred < 0) { ctx.font = font(th, 10, 500, true); ctx.fillStyle = th.good; ctx.fillText('incl. ' + fmtMoney(cred, true) + ' credit', cx, cy + r0 * 0.36); }
        else if (!Array.isArray(p) && p && isNum(p.msrp) && Math.abs(p.msrp - total) > 1) { ctx.font = font(th, 10, 500, true); ctx.fillStyle = th.textDim; ctx.fillText('MSRP ' + fmtMoney(p.msrp, true), cx, cy + r0 * 0.36); }
      }
      ctx.restore();

      // legend rows
      ctx.save();
      for (var k = 0; k < visibleRows; k++) {
        var gg = groups[k], yy = ly + k * rowH + rowH / 2;
        if (k === hi) { roundRect(ctx, lx - 4, yy - rowH / 2 + 1, legendW, rowH - 2, 4); ctx.fillStyle = rgba(th.text, 0.05); ctx.fill(); }
        roundRect(ctx, lx, yy - 5, 10, 10, 2); ctx.fillStyle = th.cat[gg.idx]; ctx.fill();
        ctx.font = font(th, 11, k === hi ? 600 : 500); ctx.fillStyle = k === hi ? th.text : th.textDim; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(gg.name, lx + 16, yy);
        ctx.font = font(th, 10, 400, true); ctx.fillStyle = th.textDim; ctx.textAlign = 'right';
        ctx.fillText(fmtN(gg.amount / sum * 100, 0) + '%', lx + legendW - 8, yy);
        ctx.font = font(th, 11, 600, true); ctx.fillStyle = th.text;
        ctx.fillText(fmtMoney(gg.amount, legendW < 220), lx + legendW - 44, yy);
      }
      if (visibleRows < groups.length) {
        ctx.font = font(th, 10, 400); ctx.fillStyle = th.textDim; ctx.textAlign = 'left';
        ctx.fillText('+' + (groups.length - visibleRows) + ' more (hover the ring)', lx, ly + visibleRows * rowH + 8);
      }
      ctx.restore();

      // tooltip with top line items of the hovered group
      if (hi >= 0 && env.pointer) {
        var hg = segs[hi].g;
        var top = hg.lines.slice().sort(function (a, b) { return num(b.amount) - num(a.amount); });
        var rows = [{ color: th.cat[hg.idx], key: 'rect', label: 'Group total', value: fmtMoney(hg.amount) }];
        var secs = Object.keys(hg.sections);
        if (secs.length > 1) secs.forEach(function (s) { rows.push({ label: sectionTitle(s), value: fmtMoney(hg.sections[s]), dim: true }); });
        rows.push({ sep: true });
        top.slice(0, 5).forEach(function (l) { rows.push({ label: String(l.label || l.name || 'Item').slice(0, 34), value: fmtMoney(l.amount) }); });
        if (top.length > 5) rows.push({ label: '+' + (top.length - 5) + ' more items', value: fmtMoney(top.slice(5).reduce(function (s, l) { return s + num(l.amount); }, 0)), dim: true });
        drawTip(ctx, env, env.pointer.x, env.pointer.y, hg.name, rows);
      }
      env.out.summary = 'Price breakdown, total ' + fmtMoney(total) + ': ' + groups.map(function (g) { return g.name + ' ' + fmtMoney(g.amount); }).join(', ') + '.';
    }
  };

  /* ------------------------------------------------------------------ AMORTIZATION */
  KINDS.amortization = {
    aspect: 0.5, minH: 180, maxH: 360, emptyText: 'No finance schedule',
    draw: function (ctx, env) {
      var th = env.th, f = env.data || {}, o = env.opts || {};
      var sched = arr(f.schedule).filter(function (r) { return r && isNum(Number(r.balance)); })
        .map(function (r, i) {
          var p = num(r.principal, 0), it = num(r.interest, 0);
          return { month: num(r.month, i + 1), principal: p, interest: it, pay: num(r.payment, p + it), balance: Number(r.balance) };
        });
      if (sched.length < 2) return drawEmpty(ctx, env, 'No finance schedule', 'Choose a term and APR to see amortization');
      var cum = 0;
      sched.forEach(function (r) { cum += r.interest; r.cumInterest = cum; });
      var n = sched.length, payMax = 0, balMax = 0;
      sched.forEach(function (r) { payMax = Math.max(payMax, r.principal + r.interest); balMax = Math.max(balMax, r.balance + r.principal); });
      var startBal = sched[0].balance + sched[0].principal;
      balMax = Math.max(balMax, startBal);

      var items = [
        { label: 'Principal', color: th.accent, type: 'rect' },
        { label: 'Interest', color: th.accent2, type: 'rect' },
        { label: 'Balance', color: th.text }
      ];
      // headline numbers: right of the legend when there is room, otherwise on their own row beneath it
      var ti = isNum(f.totalInterest) ? f.totalInterest : cum;
      var mo = isNum(f.monthly) ? f.monthly : sched[0].pay;
      var headline = n + ' × ' + fmtMoney(mo) + '  ·  interest ' + fmtMoney(ti, env.w < 420);
      ctx.save(); ctx.font = font(th, 10.5, 600, true);
      var hw = ctx.measureText(headline).width;
      ctx.restore();
      var LL = legendLayout(ctx, th, items, 1e6), LR = LL.rows[0] || [];
      var legendNeed = LR.length ? LR[LR.length - 1].x + LR[LR.length - 1].w : 240;
      var sameRow = env.w - 24 - hw - 18 >= legendNeed;
      var lgH = drawLegend(ctx, th, items, 12, 6, sameRow ? env.w - 24 - hw - 18 : env.w - 24);
      ctx.save(); ctx.font = font(th, 10.5, 600, true); ctx.fillStyle = th.textDim; ctx.textBaseline = 'middle';
      if (sameRow) { ctx.textAlign = 'right'; ctx.fillText(headline, env.w - 12, 6 + 9); }
      else { ctx.textAlign = 'left'; ctx.fillText(headline, 12, 6 + lgH + 9); lgH += 18; }
      ctx.restore();

      var yearTicks = null;
      if (n > 24) {
        var ys = n > 96 ? 24 : 12, tk = [];
        for (var m = 0; m <= n; m += ys) tk.push(m);
        yearTicks = { min: 0, max: n, step: ys, ticks: tk, decimals: 0 };
      }
      var F = xyFrame(ctx, env, {
        top: 6 + lgH + 12,
        x: { min: 0, max: n, fixed: true, ticks: yearTicks, title: n > 24 ? 'Month (gridlines = years)' : 'Month' },
        y: { min: 0, max: payMax * 1.18, title: 'Payment ($/mo)', fmt: function (v) { return fmtMoney(v, v >= 10000); } },
        y2: { max: balMax * 1.02, title: 'Balance ($)', key: th.text, fmt: function (v) { return fmtMoney(v, true); } }
      });
      drawXYGrid(ctx, env, F);

      var X = function (mth) { return F.sx(mth - 0.5); };
      ctx.save();
      revealClip(ctx, env, F);
      // stacked areas (step-ish, use straight segments for exactness)
      var pTop = sched.map(function (r) { return [X(r.month), F.sy(r.principal)]; });
      var iTop = sched.map(function (r) { return [X(r.month), F.sy(r.principal + r.interest)]; });
      ctx.beginPath();
      pTop.forEach(function (q, i) { if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
      ctx.lineTo(last(pTop)[0], F.b); ctx.lineTo(pTop[0][0], F.b); ctx.closePath();
      ctx.fillStyle = rgba(th.accent, th.dark ? 0.62 : 0.55); ctx.fill();
      ctx.beginPath();
      iTop.forEach(function (q, i) { if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
      for (var j = pTop.length - 1; j >= 0; j--) ctx.lineTo(pTop[j][0], pTop[j][1]);
      ctx.closePath();
      ctx.fillStyle = rgba(th.accent2, th.dark ? 0.55 : 0.5); ctx.fill();
      // 2px surface seam between stacked fills
      ctx.strokeStyle = th.surface; ctx.lineWidth = 1.5;
      ctx.beginPath(); pTop.forEach(function (q, i) { if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.stroke();
      // balance line on secondary scale
      var bPts = [[F.sx(0), F.sy2(startBal)]].concat(sched.map(function (r) { return [F.sx(r.month), F.sy2(r.balance)]; }));
      strokeSeries(ctx, bPts, th.text, 2);
      ctx.restore();

      // crossover marker
      var cross = null;
      for (var c = 0; c < n; c++) { if (sched[c].principal >= sched[c].interest) { cross = sched[c]; break; } }
      var pa = clamp((env.rawProgress - 0.7) / 0.3, 0, 1);
      if (cross && cross.month > sched[0].month && pa > 0) {
        ctx.save(); ctx.globalAlpha = pa;
        var cxp = X(cross.month);
        vline(ctx, cxp, F.t, F.b, rgba(th.textDim, 0.8), 1, [2, 3]);
        pill(ctx, th, 'Principal > interest from month ' + cross.month, cxp + 6, F.t + 4, { align: 'left', vAlign: 'top', size: 9.5, bounds: { l: F.l, r: F.r, t: F.t, b: F.b } });
        ctx.restore();
      }
      // half-paid marker on balance
      var half = null;
      for (var hh = 0; hh < n; hh++) if (sched[hh].balance <= startBal / 2) { half = sched[hh]; break; }
      if (half && pa > 0) {
        ctx.save(); ctx.globalAlpha = pa;
        ringDot(ctx, F.sx(half.month), F.sy2(half.balance), 4, th.text, th.surface);
        pill(ctx, th, '50% equity · mo ' + half.month, F.sx(half.month) + 8, F.sy2(half.balance) - 6, { align: 'left', vAlign: 'bottom', size: 9.5, bounds: { l: F.l, r: F.r, t: F.t, b: F.b } });
        ctx.restore();
      }

      // hover
      var hi = -1;
      env.out.count = n;
      if (env.pointer && F.inside(env.pointer, 6)) { hi = clamp(Math.round(F.ix(env.pointer.x) + 0.5) - 1, 0, n - 1); env.out.cursor = 'crosshair'; }
      else if (env.focusIdx != null) hi = clamp(env.focusIdx, 0, n - 1);
      if (hi >= 0) {
        var r = sched[hi], hx = X(r.month);
        crosshair(ctx, env, F, hx);
        dot(ctx, hx, F.sy(r.principal), 3.5, th.accent, th.surface);
        dot(ctx, hx, F.sy(r.principal + r.interest), 3.5, th.accent2, th.surface);
        dot(ctx, hx, F.sy2(r.balance), 4, th.text, th.surface);
        var yr = Math.floor((r.month - 1) / 12) + 1, mm = ((r.month - 1) % 12) + 1;
        drawTip(ctx, env, hx, F.sy2(r.balance), 'Month ' + r.month + ' · year ' + yr + ', month ' + mm, [
          { label: 'Payment', value: fmtMoney(r.pay) },
          { color: th.accent, key: 'rect', label: 'Principal', value: fmtMoney(r.principal) + '  ' + fmtN(r.principal / (r.pay || 1) * 100, 0) + '%' },
          { color: th.accent2, key: 'rect', label: 'Interest', value: fmtMoney(r.interest) + '  ' + fmtN(r.interest / (r.pay || 1) * 100, 0) + '%' },
          { sep: true },
          { color: th.text, label: 'Balance', value: fmtMoney(r.balance) },
          { label: 'Interest to date', value: fmtMoney(r.cumInterest), dim: true },
          { label: 'Equity', value: fmtN((1 - r.balance / (startBal || 1)) * 100, 1) + ' %', dim: true }
        ]);
        xPill(ctx, env, F, hx, 'mo ' + r.month);
      }
      env.out.summary = 'Amortization: ' + n + ' payments of ' + fmtMoney(mo) + ', total interest ' + fmtMoney(ti) + (cross ? ', principal exceeds interest from month ' + cross.month : '') + '.';
    }
  };

  /* ================================================================== public API */
  var api = {
    dyno: function (canvas, metrics, compareMetrics, opts) { return create('dyno', canvas, metrics, compareMetrics, opts); },
    accel: function (canvas, metrics, compareMetrics, opts) { return create('accel', canvas, metrics, compareMetrics, opts); },
    gears: function (canvas, metrics, opts) { return create('gears', canvas, metrics, null, opts); },
    radar: function (canvas, ratings, compareRatings, opts) { return create('radar', canvas, ratings, compareRatings, opts); },
    downforce: function (canvas, metrics, compareMetrics, opts) {
      // tolerate downforce(canvas, metrics, opts)
      if (compareMetrics && !compareMetrics.downforceCurve && !compareMetrics.downforce_kg_200 && opts === undefined) { opts = compareMetrics; compareMetrics = null; }
      return create('downforce', canvas, metrics, compareMetrics, opts);
    },
    weight: function (canvas, metrics, opts) { return create('weight', canvas, metrics, null, opts); },
    priceDonut: function (canvas, pricing, opts) { return create('priceDonut', canvas, pricing, null, opts); },
    amortization: function (canvas, financeResult, opts) { return create('amortization', canvas, financeResult, null, opts); },

    /* utilities */
    niceTicks: niceTicks,
    redrawAll: redrawAll,
    destroyAll: function (root) {
      live.slice().forEach(function (c) { if (!root || (root.contains && root.contains(c.canvas))) c.destroy(); });
    },
    live: function () { return live.length; },
    kinds: Object.keys(KINDS),
    estimateBreakdown: estimateBreakdown,
    _priceGroups: priceGroups
  };
  // Generic factory: CB.charts.create('dyno', canvas, data, compare, opts)
  api.create = function (kind, canvas, data, compare, opts) {
    if (!KINDS[kind]) { if (typeof console !== 'undefined') console.warn('[CB.charts] unknown chart kind', kind); return Object.assign({}, NOOP); }
    return create(kind, canvas, data, compare, opts);
  };
  CB.charts = api;
})(window.CB);
