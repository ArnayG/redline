/* FORGE Atelier — CB.shapes core: real-manufacturer car shape library.
   ---------------------------------------------------------------------
   Coordinates are meters at the real car's true dimensions. Car-local axes: x forward (front bumper at +x),
   y up (ground y = 0), z right. Origin = midpoint between the axles on the ground centreline.
   Side view uses (x,y); top view (x,z); front & rear views (z,y).
   Path = [{t:'M'|'L'|'C'|'Q'|'Z', p:[[a,b],...]}]   (SVG strings and [[a,b],...] point lists are accepted
   on registration and converted).
   API: registerModel, models, modelsByStyle, defaultModel, getModel, fit, toSvgPath, bounds,
        sectionsFromViews, loftToMesh  (+ helpers: list, parsePath, toPath, flatten, sliceAt, mapPath, items,
        parseTire, tireDiameter, refBuild, isPath, STYLES).  Full documentation: js/shapes/README.md.
   Classic script, zero deps, no DOM. */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';
  var S = (CB.shapes = CB.shapes || {});
  var models = (S.models = S.models || {});
  var order = (S._order = S._order || []);

  /* ------------------------------------------------------------------ utils */
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === 'object') { var o = {}; for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = clone(v[k]); return o; }
    return v;
  }

  /* ------------------------------------------------------------------ paths */
  function isPath(v) {
    return Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0]) &&
      typeof v[0].t === 'string' && Array.isArray(v[0].p);
  }
  function isPointList(v) {
    return Array.isArray(v) && v.length > 2 && Array.isArray(v[0]) && v[0].length === 2 && typeof v[0][0] === 'number' &&
      Array.isArray(v[1]) && typeof v[1][0] === 'number';
  }
  var PATH_RE = /^\s*[Mm]\s*[-+.\d]/;

  /** Parse an SVG path string (M L H V C Q Z, absolute and relative) into segments. */
  function parsePath(str) {
    var toks = String(str).match(/[MLHVCQZmlhvcqz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
    var out = [], i = 0, cmd = null, cx = 0, cy = 0, sx = 0, sy = 0;
    function n() { return parseFloat(toks[i++]); }
    while (i < toks.length) {
      if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
      if (!cmd) break;
      var rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
      var ox = rel ? cx : 0, oy = rel ? cy : 0;
      if (C === 'Z') { out.push({ t: 'Z', p: [] }); cx = sx; cy = sy; cmd = null; continue; }
      if (i >= toks.length || /[A-Za-z]/.test(toks[i])) { cmd = null; continue; }
      if (C === 'M') { cx = ox + n(); cy = oy + n(); sx = cx; sy = cy; out.push({ t: 'M', p: [[cx, cy]] }); cmd = rel ? 'l' : 'L'; }
      else if (C === 'L') { cx = ox + n(); cy = oy + n(); out.push({ t: 'L', p: [[cx, cy]] }); }
      else if (C === 'H') { cx = (rel ? cx : 0) + n(); out.push({ t: 'L', p: [[cx, cy]] }); }
      else if (C === 'V') { cy = (rel ? cy : 0) + n(); out.push({ t: 'L', p: [[cx, cy]] }); }
      else if (C === 'C') { var a = [ox + n(), oy + n()], b = [ox + n(), oy + n()], c = [ox + n(), oy + n()]; cx = c[0]; cy = c[1]; out.push({ t: 'C', p: [a, b, c] }); }
      else if (C === 'Q') { var q1 = [ox + n(), oy + n()], q2 = [ox + n(), oy + n()]; cx = q2[0]; cy = q2[1]; out.push({ t: 'Q', p: [q1, q2] }); }
      else { i++; }
    }
    return out;
  }
  function pointsToPath(pts, closed) {
    var out = [{ t: 'M', p: [pts[0].slice()] }];
    for (var i = 1; i < pts.length; i++) out.push({ t: 'L', p: [pts[i].slice()] });
    if (closed !== false) out.push({ t: 'Z', p: [] });
    return out;
  }
  function toPath(v) {
    if (isPath(v)) return v;
    if (typeof v === 'string' && PATH_RE.test(v)) return parsePath(v);
    if (isPointList(v)) return pointsToPath(v, true);
    return null;
  }
  function mapPath(path, fn) {
    if (!isPath(path)) return path;
    return path.map(function (s) {
      var o = {}; for (var k in s) o[k] = s[k];
      o.p = s.p.map(function (q) { return fn(q); });
      return o;
    });
  }

  /** Flatten to polylines: [{pts:[[a,b]...], closed:bool}]. */
  function flatten(path, steps) {
    steps = steps || 14;
    var polys = [], cur = null, cp = [0, 0], start = [0, 0];
    if (!isPath(path)) return polys;
    for (var i = 0; i < path.length; i++) {
      var s = path[i], p = s.p || [];
      switch (s.t) {
        case 'M': cur = { pts: [p[0].slice()], closed: false }; polys.push(cur); cp = p[0]; start = p[0]; break;
        case 'L': if (!cur) { cur = { pts: [cp.slice()], closed: false }; polys.push(cur); } cur.pts.push(p[0].slice()); cp = p[0]; break;
        case 'C':
          if (!cur) { cur = { pts: [cp.slice()], closed: false }; polys.push(cur); }
          for (var k = 1; k <= steps; k++) {
            var t = k / steps, u = 1 - t;
            var a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
            cur.pts.push([a * cp[0] + b * p[0][0] + c * p[1][0] + d * p[2][0], a * cp[1] + b * p[0][1] + c * p[1][1] + d * p[2][1]]);
          }
          cp = p[2]; break;
        case 'Q':
          if (!cur) { cur = { pts: [cp.slice()], closed: false }; polys.push(cur); }
          for (var k2 = 1; k2 <= steps; k2++) {
            var t2 = k2 / steps, u2 = 1 - t2;
            cur.pts.push([u2 * u2 * cp[0] + 2 * u2 * t2 * p[0][0] + t2 * t2 * p[1][0], u2 * u2 * cp[1] + 2 * u2 * t2 * p[0][1] + t2 * t2 * p[1][1]]);
          }
          cp = p[1]; break;
        case 'Z': if (cur) { cur.closed = true; cp = start; cur = null; } break;
      }
    }
    return polys;
  }
  /** Bounds of a path (or array of paths), on the flattened curve. */
  function bounds(path) {
    var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    var list = isPath(path) ? [path] : (Array.isArray(path) ? path : []);
    list.forEach(function (pp) {
      var p = toPath(pp && pp.path ? pp.path : pp);
      flatten(p, 10).forEach(function (pl) {
        pl.pts.forEach(function (q) {
          if (q[0] < b.minX) b.minX = q[0]; if (q[0] > b.maxX) b.maxX = q[0];
          if (q[1] < b.minY) b.minY = q[1]; if (q[1] > b.maxY) b.maxY = q[1];
        });
      });
    });
    if (b.minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0, empty: true };
    b.w = b.maxX - b.minX; b.h = b.maxY - b.minY;
    return b;
  }
  /** All b-values where the line a = const crosses the polylines (closed polys treated closed); returns [min,max] or null. */
  function sliceAt(polys, a) {
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < polys.length; i++) {
      var pts = polys[i].pts, n = pts.length;
      var m = n; // always close for slicing (outline shapes)
      for (var j = 0; j < m; j++) {
        var p0 = pts[j], p1 = pts[(j + 1) % n];
        var a0 = p0[0], a1 = p1[0];
        if ((a0 <= a && a1 >= a) || (a1 <= a && a0 >= a)) {
          var b = a1 === a0 ? Math.max(p0[1], p1[1]) : p0[1] + (p1[1] - p0[1]) * (a - a0) / (a1 - a0);
          if (a1 === a0) { lo = Math.min(lo, p0[1], p1[1]); hi = Math.max(hi, p0[1], p1[1]); }
          else { if (b < lo) lo = b; if (b > hi) hi = b; }
        }
      }
    }
    return lo === Infinity ? null : [lo, hi];
  }
  /** Slice along the other axis (b = const) → [minA, maxA]. */
  function sliceAtB(polys, b) {
    var sw = polys.map(function (pl) { return { pts: pl.pts.map(function (q) { return [q[1], q[0]]; }), closed: pl.closed }; });
    return sliceAt(sw, b);
  }

  function fmt(n) { var r = Math.round(n * 100) / 100; return (r === 0 ? 0 : r).toString(); }
  /** Path → SVG 'd' string. X = ox + (flipX ? -a : a)*scale, Y = oy + (flipY ? -b : b)*scale.
      flipX is for the FRONT view (looking at the nose, the car's right (+z) is on the viewer's left). */
  function toSvgPath(path, o) {
    o = o || {};
    var sc = num(o.scale, 1), ox = num(o.ox, 0), oy = num(o.oy, 0), fy = o.flipY ? -1 : 1, fx = o.flipX ? -1 : 1;
    var p = toPath(path);
    if (!p) return '';
    var out = [];
    for (var i = 0; i < p.length; i++) {
      var s = p[i];
      var pts = (s.p || []).map(function (q) { return fmt(ox + fx * q[0] * sc) + ' ' + fmt(oy + fy * q[1] * sc); });
      out.push(s.t === 'Z' ? 'Z' : s.t + ' ' + pts.join(' '));
    }
    return out.join(' ');
  }
  /** Normalise a geometry slot (path | [paths] | {path,...} | [{path,...}]) to [{path, ...props}]. */
  function items(v) {
    if (v == null) return [];
    var p = toPath(v);
    if (p) return [{ path: p }];
    if (Array.isArray(v)) { var out = []; v.forEach(function (e) { out = out.concat(items(e)); }); return out; }
    if (typeof v === 'object' && v.path) {
      var pp = toPath(v.path); if (!pp) return [];
      var o = {}; for (var k in v) o[k] = v[k]; o.path = pp; return [o];
    }
    return [];
  }

  /* ------------------------------------------------------------------ tires */
  /** '245/35R20', 'P275/65R18', 'LT275/70R18', '255/40ZR19 ' → {width_mm, profile, rim_in}. */
  function parseTire(s) {
    var m = String(s || '').match(/(\d{3})\s*\/\s*(\d{2})\s*Z?R?F?\s*(\d{2}(?:\.\d)?)/i);
    if (!m) return null;
    return { width_mm: +m[1], profile: +m[2], rim_in: +m[3] };
  }
  function tireDiameter(t) { return t ? t.rim_in * 0.0254 + 2 * t.width_mm * t.profile / 100 / 1000 : 0; }

  /* ------------------------------------------------------------------ registration */
  var LEN_KEYS = ['length', 'width', 'height', 'wheelbase', 'trackF', 'trackR', 'frontOverhang', 'rearOverhang', 'groundClearance', 'rideHeight'];
  var VIEWS = ['side', 'top', 'front', 'rear'];

  function convertPaths(v) {
    if (typeof v === 'string') return PATH_RE.test(v) ? parsePath(v) : v;
    if (isPath(v)) return v;
    if (isPointList(v)) return pointsToPath(v, true);
    if (Array.isArray(v)) return v.map(convertPaths);
    if (v && typeof v === 'object') { var o = {}; for (var k in v) o[k] = convertPaths(v[k]); return o; }
    return v;
  }

  function normalize(src) {
    var m = clone(src);
    m.style = m.style || 'coupe';
    m.id = m.id || ((m.make || 'model') + '-' + (m.name || order.length)).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    VIEWS.forEach(function (v) { m[v] = convertPaths(m[v] || {}); });
    m.details = (m.details || []).map(function (d) { var o = clone(d); o.path = toPath(o.path) || o.path; return o; });
    if (m.sections) m.sections = m.sections.map(function (s) { return clone(s); });
    var r = (m.ref = m.ref || {});
    LEN_KEYS.forEach(function (k) { if (typeof r[k] === 'number' && r[k] > 20) r[k] = r[k] / 1000; });
    var sb = bounds(m.side.body);
    if (!r.length) r.length = sb.empty ? 4.5 : sb.w;
    if (!r.height) r.height = sb.empty ? 1.4 : sb.maxY;
    if (!r.width) { var tb = bounds(m.top.body); r.width = tb.empty ? 1.85 : tb.h; }
    if (!r.wheelbase) r.wheelbase = r.length * 0.6;
    if (!r.trackF) r.trackF = r.trackR || r.width * 0.85;
    if (!r.trackR) r.trackR = r.trackF;
    if (!r.frontOverhang) r.frontOverhang = sb.empty ? (r.length - r.wheelbase) / 2 : sb.maxX - r.wheelbase / 2;
    if (!r.rearOverhang) r.rearOverhang = sb.empty ? (r.length - r.wheelbase) / 2 : -r.wheelbase / 2 - sb.minX;
    var tf = parseTire(r.tireF), tr = parseTire(r.tireR || r.tireF);
    if (!tf) { var rim = r.wheelDiameter_in || 18; tf = { width_mm: 245, profile: 40, rim_in: rim }; r.tireF = '245/40R' + rim; }
    if (!tr) { tr = tf; r.tireR = r.tireF; }
    if (!r.wheelDiameter_in) r.wheelDiameter_in = tf.rim_in;
    if (!r.groundClearance) r.groundClearance = r.rideHeight || 0.13;
    if (!r.rideHeight) r.rideHeight = r.groundClearance;
    var s = m.side;
    var rF = tireDiameter(tf) / 2, rR = tireDiameter(tr) / 2;
    s.archF = s.archF || {}; s.archR = s.archR || {};
    s.archF.x = num(s.archF.x, r.wheelbase / 2); s.archF.y = num(s.archF.y, rF); s.archF.r = num(s.archF.r, rF * 1.1);
    s.archR.x = num(s.archR.x, -r.wheelbase / 2); s.archR.y = num(s.archR.y, rR); s.archR.r = num(s.archR.r, rR * 1.1);
    s.archF.flare = num(s.archF.flare, 0); s.archR.flare = num(s.archR.flare, 0);
    m.signature = m.signature || {};
    return m;
  }

  function registerModel(model) {
    if (!model || typeof model !== 'object') return null;
    var m = normalize(model);
    if (!models[m.id]) order.push(m.id);
    models[m.id] = m;
    return m;
  }
  function modelsByStyle(style) {
    var out = [];
    for (var i = 0; i < order.length; i++) { var m = models[order[i]]; if (m && m.style === style) out.push(m); }
    return out;
  }
  function defaultModel(style) {
    var list = modelsByStyle(style);
    for (var i = 0; i < list.length; i++) if (list[i].default) return list[i];
    return list[0] || null;
  }
  /** build.body.model if registered (with opts.strict: only when its style matches build.body.style), else the style default. */
  function getModel(build, opts) {
    var b = (build && build.body) || {};
    var m = b.model && models[b.model];
    if (m && !(opts && opts.strict && b.style && m.style !== b.style)) return m;
    return defaultModel(b.style || 'coupe');
  }
  function list() { return order.map(function (id) { return models[id]; }); }

  /** Build-shaped partial that reproduces a model's reference dimensions under fit(). */
  function refBuild(model) {
    var r = model.ref, tf = parseTire(r.tireF), tr = parseTire(r.tireR) || tf;
    return {
      body: { style: model.style, model: model.id, wheelbase_mm: Math.round(r.wheelbase * 1000), trackWidth_mm: Math.round((r.trackF + r.trackR) / 2 * 1000) },
      suspension: { rideHeight_mm: Math.round(r.rideHeight * 1000) },
      wheels: { diameter_in: tf.rim_in },
      tires: { widthFront_mm: tf.width_mm, widthRear_mm: tr.width_mm, profileFront: tf.profile, profileRear: tr.profile },
      _rimRear_in: tr.rim_in
    };
  }

  /* ------------------------------------------------------------------ fit */
  /** Remap a model's geometry to a build's dimensions (see header). Returns a fitted deep copy with .dims, .wheels. */
  function fit(model, build) {
    if (typeof model === 'string') model = models[model];
    if (!model) return null;
    if (!model.ref || !model.side || !model.side.archF) model = normalize(model);
    var r = model.ref;
    var bb = build || {};
    var body = bb.body || {}, susp = bb.suspension || {}, wh = bb.wheels || {}, ti = bb.tires || {};
    var wb0 = r.wheelbase, wb1 = num(body.wheelbase_mm, 0) > 0 ? body.wheelbase_mm / 1000 : wb0;
    wb1 = clamp(wb1, wb0 * 0.7, wb0 * 1.4);
    if (Math.abs(wb1 - wb0) < 0.0006) wb1 = wb0;   // builds are whole mm: treat sub-mm deltas as the reference
    var tr0 = (r.trackF + r.trackR) / 2, tr1 = num(body.trackWidth_mm, 0) > 0 ? body.trackWidth_mm / 1000 : tr0;
    if (Math.abs(tr1 - tr0) < 0.0006) tr1 = tr0;
    var sz = clamp(tr1 / tr0, 0.75, 1.3);
    var t0F = parseTire(r.tireF), t0R = parseTire(r.tireR) || t0F;
    var sameRim = bb._rimRear_in;
    var t1F = {
      width_mm: num(ti.widthFront_mm, t0F.width_mm), profile: num(ti.profileFront, t0F.profile), rim_in: num(wh.diameter_in, t0F.rim_in)
    };
    var t1R = {
      width_mm: num(ti.widthRear_mm, t0R.width_mm), profile: num(ti.profileRear, t0R.profile),
      rim_in: num(sameRim, num(wh.diameter_in, t0R.rim_in))
    };
    var d0F = tireDiameter(t0F), d0R = tireDiameter(t0R);
    var d1F = clamp(tireDiameter(t1F), d0F * 0.72, d0F * 1.4), d1R = clamp(tireDiameter(t1R), d0R * 0.72, d0R * 1.4);
    var rF1 = d1F / 2, rR1 = d1R / 2;
    var rh0 = r.rideHeight, rh1 = num(susp.rideHeight_mm, 0) > 0 ? susp.rideHeight_mm / 1000 : rh0;
    if (Math.abs(rh1 - rh0) < 0.0006) rh1 = rh0;
    var dy = clamp(rh1 - rh0, -0.15, 0.25);
    var dwb = (wb1 - wb0) / 2;

    var aF = model.side.archF, aR = model.side.archR;
    var Z = clamp(Math.max(aF.r, aR.r) * 1.35, 0.2, wb0 * 0.3);
    var m0a = -wb0 / 2 + Z, m0b = wb0 / 2 - Z, m1a = -wb1 / 2 + Z, m1b = wb1 / 2 - Z;
    function mapX(x) {
      if (x >= m0b) return x + dwb;
      if (x <= m0a) return x - dwb;
      return x - dwb + (x - m0a) * ((m1b - m1a) / (m0b - m0a) - 1);
    }
    function archNew(a, r1, isF) {
      var cy = a.y + dy;
      var k = r1 / (isF ? d0F / 2 : d0R / 2);
      var rr = Math.min(a.r * k, a.r * 1.4);
      if (k !== 1 || dy !== 0) rr = Math.max(rr, 2 * r1 + 0.008 - cy);   // the tyre always clears the arch
      return { x: mapX(a.x), y: cy, r: rr, r0: a.r, flare: a.flare * clamp(sz, 0.8, 1.3) + Math.max(0, (rr - a.r) * 0.2) };
    }
    var nF = archNew(aF, rF1, true), nR = archNew(aR, rR1, false);
    function archWarp(q, A) {
      var ddx = q[0] - A.x, ddy = q[1] - A.y, d = Math.sqrt(ddx * ddx + ddy * ddy);
      var k = A.r / A.r0;
      if (k === 1 || d > A.r0 * 1.6) return q;
      var w = d <= A.r0 * 1.12 ? 1 : 1 - smooth((d - A.r0 * 1.12) / (A.r0 * 0.48));
      var s = 1 + (k - 1) * w;
      if (ddy >= 0) return [A.x + ddx * s, A.y + ddy * s];
      return [A.x + ddx * s, q[1]];
    }
    var side = function (q) { var p = [mapX(q[0]), q[1] + dy]; p = archWarp(p, nF); return archWarp(p, nR); };
    var top = function (q) { return [mapX(q[0]), q[1] * sz]; };
    var fr = function (q) { return [q[0] * sz, q[1] + dy]; };
    var mappers = { side: side, top: top, front: fr, rear: fr };

    function mapGeom(v, fn, view) {
      if (isPath(v)) return mapPath(v, fn);
      if (Array.isArray(v)) return v.map(function (e) { return mapGeom(e, fn, view); });
      if (v && typeof v === 'object') {
        var o = {};
        for (var k in v) o[k] = mapGeom(v[k], fn, view);
        if (typeof o.cx === 'number' && typeof o.cy === 'number') {
          var c = fn([o.cx, o.cy]); o.cx = c[0]; o.cy = c[1];
          if (view !== 'side' && typeof o.w === 'number') o.w *= view === 'top' ? 1 : sz;
          if (view === 'top' && typeof o.h === 'number') o.h *= sz;
        }
        return o;
      }
      return v;
    }
    var out = {};
    for (var key in model) {
      if (VIEWS.indexOf(key) >= 0 || key === 'details' || key === 'sections') continue;
      out[key] = clone(model[key]);
    }
    VIEWS.forEach(function (v) {
      var src = model[v] || {}, o = {};
      for (var k in src) {
        if (v === 'side' && (k === 'archF' || k === 'archR')) continue;
        o[k] = mapGeom(src[k], mappers[v], v);
      }
      out[v] = o;
    });
    out.side.archF = { x: nF.x, y: nF.y, r: nF.r, flare: nF.flare };
    out.side.archR = { x: nR.x, y: nR.y, r: nR.r, flare: nR.flare };
    ['archF', 'archR'].forEach(function (k) { if (model.side[k].path) out.side[k].path = mapPath(toPath(model.side[k].path), side); });
    out.details = (model.details || []).map(function (d) {
      var o = clone(d); var fn = mappers[d.view] || side;
      o.path = mapGeom(toPath(d.path) || d.path, fn, d.view);
      if (typeof o.cx === 'number') { var c = fn([o.cx, o.cy]); o.cx = c[0]; o.cy = c[1]; }
      return o;
    });
    if (model.sections) {
      out.sections = model.sections.map(function (s) {
        var o = clone(s); o.x = mapX(s.x);
        var xs = o.x;
        o.ring = (s.ring || []).map(function (q) {
          var p = archWarp(archWarp([xs, q[0] + dy], nF), nR);   // wheel-well openings follow the resized arches (y only)
          return [p[1], q[1] * sz];
        });
        return o;
      });
    }
    var tireWF = t1F.width_mm / 1000, tireWR = t1R.width_mm / 1000;
    out.dims = {
      length: r.length + (wb1 - wb0), width: r.width * sz, height: r.height + dy, wheelbase: wb1, track: tr1,
      wheelRadius: rF1, wheelRadiusR: rR1, tireWidthF: tireWF, tireWidthR: tireWR, rideHeight: rh1,
      axleF: wb1 / 2, axleR: -wb1 / 2, rimRadiusF: t1F.rim_in * 0.0254 / 2, rimRadiusR: t1R.rim_in * 0.0254 / 2,
      trackF: r.trackF * sz, trackR: r.trackR * sz, dy: dy, scaleZ: sz
    };
    var fb2 = bounds(out.side.body);
    var xF = fb2.empty ? wb1 / 2 + r.frontOverhang : fb2.maxX, xR = fb2.empty ? -wb1 / 2 - r.rearOverhang : fb2.minX;
    out.dims.xFront = xF; out.dims.xRear = xR; out.dims.centerX = (xF + xR) / 2;
    out.dims.frontOverhang = xF - wb1 / 2; out.dims.rearOverhang = -wb1 / 2 - xR;
    out.wheels = {
      front: { x: wb1 / 2, y: rF1, r: rF1, rimR: out.dims.rimRadiusF, width: tireWF, track: out.dims.trackF },
      rear: { x: -wb1 / 2, y: rR1, r: rR1, rimR: out.dims.rimRadiusR, width: tireWR, track: out.dims.trackR }
    };
    out.fitted = true;
    Object.defineProperty(out, '_map', { value: { x: mapX, side: side, top: top, front: fr, rear: fr }, enumerable: false });
    return out;
  }

  /* ------------------------------------------------------------------ sections */
  function resampleClosed(pts, n) {
    // resample a closed polyline to n points by arc length, starting at pts[0]
    var L = [0], tot = 0, m = pts.length;
    for (var i = 1; i <= m; i++) { var a = pts[i - 1], b = pts[i % m]; tot += Math.hypot(b[0] - a[0], b[1] - a[1]); L.push(tot); }
    if (tot === 0) return Array.from({ length: n }, function () { return pts[0].slice(); });
    var out = [], j = 0;
    for (var k = 0; k < n; k++) {
      var d = tot * k / n;
      while (j < m - 1 && L[j + 1] < d) j++;
      var p0 = pts[j], p1 = pts[(j + 1) % m], seg = L[j + 1] - L[j] || 1, t = (d - L[j]) / seg;
      out.push([lerp(p0[0], p1[0], t), lerp(p0[1], p1[1], t)]);
    }
    return out;
  }
  function resampleOpen(pts, n) {
    var L = [0], tot = 0;
    for (var i = 1; i < pts.length; i++) { tot += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); L.push(tot); }
    var out = [], j = 0;
    for (var k = 0; k < n; k++) {
      var d = tot * k / (n - 1);
      while (j < pts.length - 2 && L[j + 1] < d) j++;
      var seg = L[j + 1] - L[j] || 1, t = clamp((d - L[j]) / seg, 0, 1);
      out.push([lerp(pts[j][0], pts[j + 1][0], t), lerp(pts[j][1], pts[j + 1][1], t)]);
    }
    return out;
  }
  function pointInPolys(polys, a, b) {
    var inside = false;
    for (var k = 0; k < polys.length; k++) {
      var p = polys[k].pts;
      for (var i = 0, j = p.length - 1; i < p.length; j = i++) {
        if (((p[i][1] > b) !== (p[j][1] > b)) && (a < (p[j][0] - p[i][0]) * (b - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0])) inside = !inside;
      }
    }
    return inside;
  }
  function halfWidth(polys, a) { var s = sliceAt(polys, a); return s ? Math.max(Math.abs(s[0]), Math.abs(s[1])) : null; }
  function seQuad(cy, cz, rz, ry, n, a0, a1, steps, out) {
    // superellipse arc in (y,z): z = cz + rz*sgn(cos)|cos|^(2/n), y = cy + ry*sgn(sin)|sin|^(2/n)
    for (var i = 0; i <= steps; i++) {
      var a = lerp(a0, a1, i / steps), c = Math.cos(a), s = Math.sin(a);
      out.push([cy + ry * Math.sign(s) * Math.pow(Math.abs(s), 2 / n), cz + rz * Math.sign(c) * Math.pow(Math.abs(c), 2 / n)]);
    }
  }


  /** Resample a closed ring by arc length, carrying per-vertex flag arrays (nearest source vertex). */
  function resampleClosedFlags(pts, n, flagLists) {
    var m = pts.length, L = [0], tot = 0, i;
    for (i = 1; i <= m; i++) { var a = pts[i - 1], b = pts[i % m]; tot += Math.hypot(b[0] - a[0], b[1] - a[1]); L.push(tot); }
    var ring = [], fl = flagLists.map(function () { return []; }), j = 0;
    for (var k = 0; k < n; k++) {
      var d = tot * k / n;
      while (j < m - 1 && L[j + 1] < d) j++;
      var seg = L[j + 1] - L[j] || 1, t = tot ? (d - L[j]) / seg : 0, p0 = pts[j], p1 = pts[(j + 1) % m];
      ring.push([lerp(p0[0], p1[0], t), lerp(p0[1], p1[1], t)]);
      var src = t < 0.5 ? j : (j + 1) % m;
      flagLists.forEach(function (f, q) { fl[q].push(f ? f[src] : null); });
    }
    return { ring: ring, flags: fl };
  }
  function mirrorHalf(ring, nFull) {
    var h = resampleOpen(ring, nFull / 2 + 1), full = h.slice();
    for (var i = nFull / 2 - 1; i >= 1; i--) full.push([h[i][0], -h[i][1]]);
    return full;
  }
  /** Explicit model.sections → closed full rings of a common vertex count (native count unless ringVerts given).
      Per-vertex glass / paint flags are kept (remapped by arc length when the ring is resampled). */
  function expandSections(model, ringVerts) {
    var secs = model.sections.slice().sort(function (a, b) { return a.x - b.x; });
    function nativeLen(s) {
      if (s.ringHalf || model.ringHalf) {
        var fl = s.glass || s.paint;
        return fl && fl.length % 2 === 0 ? fl.length : 2 * (s.ring.length - 1);
      }
      return s.ring.length;
    }
    var NV = ringVerts, lens = {}, best = 0;
    if (!NV) {
      secs.forEach(function (s) { var n = nativeLen(s); lens[n] = (lens[n] || 0) + 1; if (!best || lens[n] > lens[best]) best = n; });
      NV = best || 32;
    }
    if (NV % 2) NV++;
    return secs.map(function (s) {
      var ring = s.ring.map(function (q) { return q.slice(); }), n0;
      if (s.ringHalf || model.ringHalf) { n0 = (s.glass || s.paint) ? nativeLen(s) : NV; if (n0 % 2) n0++; ring = mirrorHalf(ring, n0); }
      var glass = s.glass && s.glass.length === ring.length ? s.glass.slice() : null;
      var paint = s.paint && s.paint.length === ring.length ? s.paint.slice() : null;
      if (ring.length !== NV) {
        var r = resampleClosedFlags(ring, NV, [glass, paint]);
        ring = r.ring; glass = glass ? r.flags[0] : null; paint = paint ? r.flags[1] : null;
      }
      var o = { x: s.x, ring: ring, belt: s.belt == null ? null : s.belt, glass: glass };
      if (paint) o.paint = paint;
      return o;
    });
  }

  /** Derive 3D cross-section rings ([y,z], ringVerts each) from the side/top/front views (or expand model.sections). */
  function sectionsFromViews(model, opts) {
    opts = opts || {};
    var NS = opts.stations || 48, NV = opts.ringVerts || 32;
    if (NV % 2) NV++;
    var half = NV / 2;
    if (model.sections && model.sections.length >= 2) {
      var ex = expandSections(model, opts.ringVerts), mx = opts.maxStations | 0;
      if (mx >= 2 && ex.length > mx) {   // LOD: evenly spaced subset, always keeping both end caps
        var sub = [];
        for (var si = 0; si < mx; si++) sub.push(ex[Math.round(si * (ex.length - 1) / (mx - 1))]);
        ex = sub;
      }
      return ex;
    }
    var side = model.side || {}, topv = model.top || {}, frontv = model.front || {};
    var sb = flatten(toPath(side.body), 16);
    if (!sb.length) return [];
    var sg = flatten(toPath(side.greenhouse), 16);
    var tb = flatten(toPath(topv.body), 16), tg = flatten(toPath(topv.greenhouse), 16);
    var fb = flatten(toPath(frontv.body), 16), fg = flatten(toPath(frontv.greenhouse), 16);
    var B = bounds(toPath(side.body));
    var ref = model.ref || {}, W2 = (model.dims ? model.dims.width : ref.width || 1.85) / 2;

    // front-view character
    var waistFrac = 0.55, rocker = 0.9, ghBase = 0.86, ghTop = 0.62, shoulder = 0.965, nLow = 4.2;
    if (fb.length) {
      var FB = bounds(toPath(frontv.body)), maxHW = 0, waistY = FB.minY + FB.h * 0.45;
      for (var i = 0; i <= 40; i++) {
        var y = FB.minY + FB.h * (0.02 + 0.96 * i / 40), hw = sliceAtB(fb, y);
        if (hw) { var w = Math.max(Math.abs(hw[0]), Math.abs(hw[1])); if (w > maxHW + 1e-4) { maxHW = w; waistY = y; } }
      }
      var FG = fg.length ? bounds(toPath(frontv.greenhouse)) : null;
      var beltY = FG ? FG.minY : FB.minY + FB.h * 0.7;
      if (maxHW > 0) {
        // squareness: how much of the front-view bounding box below the belt the body fills → super-ellipse exponent
        var ins = 0, tot = 0;
        for (var fi = 0; fi < 24; fi++) for (var fj = 0; fj < 16; fj++) {
          var fz = FB.minX + FB.w * (fi + 0.5) / 24, fyy = FB.minY + (beltY - FB.minY) * (fj + 0.5) / 16;
          tot++; if (pointInPolys(fb, fz, fyy)) ins++;
        }
        if (tot) nLow = clamp(3 + (ins / tot - 0.9) * 40, 3.5, 7);
        waistFrac = clamp((waistY - FB.minY) / Math.max(0.05, beltY - FB.minY), 0.3, 0.88);
        var rk = sliceAtB(fb, FB.minY + FB.h * 0.04);
        if (rk) rocker = clamp(Math.max(Math.abs(rk[0]), Math.abs(rk[1])) / maxHW, 0.72, 0.99);
        var sh = sliceAtB(fb, beltY - 0.01);
        if (sh) shoulder = clamp(Math.max(Math.abs(sh[0]), Math.abs(sh[1])) / maxHW, 0.8, 1);
        if (FG) {
          var g0 = sliceAtB(fg, FG.minY + FG.h * 0.06), g1 = sliceAtB(fg, FG.minY + FG.h * 0.9);
          if (g0) ghBase = clamp(Math.max(Math.abs(g0[0]), Math.abs(g0[1])) / maxHW, 0.55, 0.98);
          if (g1) ghTop = clamp(Math.max(Math.abs(g1[0]), Math.abs(g1[1])) / maxHW, 0.3, ghBase);
        }
      }
    }
    var roofP = flatten(toPath(topv.roof), 12);
    var ghRange = null;
    if (sg.length) { var SGb = bounds(toPath(side.greenhouse)); ghRange = [SGb.minX, SGb.maxX]; }
    if (tg.length) { var TGb = bounds(toPath(topv.greenhouse)); ghRange = ghRange ? [Math.min(ghRange[0], TGb.minX), Math.max(ghRange[1], TGb.maxX)] : [TGb.minX, TGb.maxX]; }
    function ghBottom(x) {
      if (!sg.length) return null;
      var s = sliceAt(sg, x); if (s) return s[0];
      var SGb = bounds(toPath(side.greenhouse));
      var xe = clamp(x, SGb.minX + 0.01, SGb.maxX - 0.01); s = sliceAt(sg, xe);
      return s ? s[0] : null;
    }
    var arches = [side.archF, side.archR].filter(Boolean);
    function rawBottom(x) { var s = sliceAt(sb, x); return s ? s[0] : null; }
    function bottomAt(x) {
      for (var i = 0; i < arches.length; i++) {
        var a = arches[i], e = a.r * 1.18;
        if (x > a.x - e && x < a.x + e) {
          var l = rawBottom(a.x - e), r = rawBottom(a.x + e);
          if (l == null) l = r; if (r == null) r = l;
          if (l == null) break;
          return lerp(l, r, (x - (a.x - e)) / (2 * e));
        }
      }
      return rawBottom(x);
    }
    // wheel wells: inside the arch circle, the outer skin steps in to just inboard of the tyre
    var wells = [];
    if (opts.wheelWells !== false) {
      var dm = model.dims || {}, tF = parseTire(ref.tireF), tR = parseTire(ref.tireR) || tF;
      var trF = dm.trackF || ref.trackF || W2 * 1.7, trR = dm.trackR || ref.trackR || trF;
      var twF = dm.tireWidthF || (tF ? tF.width_mm / 1000 : 0.245), twR = dm.tireWidthR || (tR ? tR.width_mm / 1000 : twF);
      [[side.archF, trF, twF], [side.archR, trR, twR]].forEach(function (A) {
        var a = A[0]; if (!a || !(a.r > 0)) return;
        wells.push({ x: a.x, y: a.y, r: a.r, zIn: A[1] / 2 - A[2] / 2 - 0.025 });
      });
    }
    function wellAt(x) {
      for (var i = 0; i < wells.length; i++) {
        var wl = wells[i], dx = x - wl.x;
        if (Math.abs(dx) < wl.r * 0.985) return { top: wl.y + Math.sqrt(wl.r * wl.r - dx * dx), zIn: wl.zIn };
      }
      return null;
    }
    function carveWell(pts, x) {
      var wl = wellAt(x); if (!wl) return pts;
      var res = [], prev = null;
      for (var i = 0; i < pts.length; i++) {
        var q = pts[i];
        if (prev && (prev[0] < wl.top) !== (q[0] < wl.top) && q[0] !== prev[0]) {
          var t = (wl.top - prev[0]) / (q[0] - prev[0]), zc = lerp(prev[1], q[1], t);
          if (zc > wl.zIn) {
            var lo = [wl.top, Math.min(zc, wl.zIn)], hi = [wl.top + 1e-4, zc];
            if (prev[0] < wl.top) res.push(lo, hi); else res.push(hi, lo);
          }
        }
        res.push(q[0] < wl.top && q[1] > wl.zIn ? [q[0], wl.zIn] : q);
        prev = q;
      }
      return res;
    }
    var out = [];
    for (var k = 0; k < NS; k++) {
      var t = lerp(0.006, 0.994, k / (NS - 1));
      var x = B.minX + B.w * (1 - Math.cos(Math.PI * t)) / 2;
      var sl = sliceAt(sb, x); if (!sl) continue;
      var yt = sl[1], yb = bottomAt(x); if (yb == null) yb = sl[0];
      yb = Math.min(yb, yt - 0.02);
      var gsl = sg.length ? sliceAt(sg, x) : null;
      var top = Math.max(yt, gsl ? gsl[1] : -Infinity);
      var w = tb.length ? halfWidth(tb, x) : null;
      if (w == null) { var u = (x - B.minX) / B.w; w = W2 * Math.pow(Math.sin(Math.PI * clamp(u, 0, 1)), 0.25); }
      w = Math.max(w, 0.01);
      var belt = null;
      if (ghRange && x > ghRange[0] && x < ghRange[1]) {
        belt = ghBottom(x);
        if (belt != null && (belt >= top - 0.03 || belt <= yb + 0.05)) belt = null;
      }
      var gw = null;
      if (belt != null) {
        gw = tg.length ? halfWidth(tg, x) : null;
        if (gw == null) gw = w * ghBase;
        gw = Math.min(gw, w * shoulder * 0.985);
      }
      var yTopBody = belt != null ? belt : top;
      var ywaist = yb + waistFrac * (yTopBody - yb);
      var pts = [];
      seQuad(ywaist, 0, w, ywaist - yb, nLow, -Math.PI / 2, 0, 10, pts);
      for (var q = 0; q < pts.length; q++) {
        var f = clamp((ywaist - pts[q][0]) / Math.max(1e-6, ywaist - yb), 0, 1);
        pts[q][1] *= 1 - (1 - rocker) * Math.pow(f, 2.5);
      }
      if (belt != null) {
        var wB = w * shoulder;
        for (var m2 = 1; m2 <= 5; m2++) { var uu = m2 / 5; pts.push([lerp(ywaist, belt, uu), w - (w - wB) * uu * uu]); }
        var ghH = top - belt;
        var gwt = gw * (ghTop / ghBase);
        // greenhouse: tumblehome from gw at belt to roof edge, then crown
        // side glass: near-straight tumblehome line up to the roof rail, then a tight-cornered roof crown
        var railY = belt + ghH * 0.8, railZ = Math.max(gwt, 0.05);
        for (var g = 1; g <= 6; g++) { var gu = g / 6; pts.push([lerp(belt, railY, gu), lerp(gw, railZ, gu) - Math.sin(Math.PI * gu) * 0.01]); }
        var gp = [];
        seQuad(railY, 0, railZ, top - railY, 3.2, 0, Math.PI / 2, 12, gp);
        for (var g2 = 1; g2 < gp.length; g2++) pts.push(gp[g2]);
      } else {
        var up = [];
        seQuad(ywaist, 0, w, top - ywaist, Math.max(2.4, nLow * 0.72), 0, Math.PI / 2, 14, up);
        for (var h = 1; h < up.length; h++) pts.push(up[h]);
      }
      pts[0] = [yb, 0]; pts[pts.length - 1] = [top, 0];
      if (wells.length) pts = carveWell(pts, x);
      var hpts = resampleOpen(pts, half + 1);
      var ring = hpts.slice();
      for (var r2 = half - 1; r2 >= 1; r2--) ring.push([hpts[r2][0], -hpts[r2][1]]);
      var glass = null;
      if (belt != null) {
        glass = ring.map(function (q) {
          if (q[0] < belt + 0.012) return 0;
          // roof panel: inside the plan-view roof outline and on the upper crown (side glass stays glass)
          if (roofP.length && q[0] > belt + 0.82 * (top - belt) && pointInPolys(roofP, x, q[1])) return 0;
          return 1;
        });
      }
      out.push({ x: x, ring: ring, belt: belt, top: top, bottom: yb, halfWidth: w, glass: glass });
    }
    return out;
  }

  /* ------------------------------------------------------------------ loft */
  /** Loft rings → watertight mesh with outward normals (+ glass sub-mesh from greenhouse area). */
  function loftToMesh(sections, opts) {
    opts = opts || {};
    if (sections && !Array.isArray(sections) && sections.sections) sections = sections.sections;
    sections = (sections || []).filter(function (s) { return s && s.ring && s.ring.length >= 3; });
    if (sections.length < 2) return { positions: new Float32Array(0), normals: new Float32Array(0), uvs: new Float32Array(0), indices: new Uint32Array(0), glass: { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0) } };
    var N = sections[0].ring.length;
    var rings = sections.map(function (s) { return s.ring.length === N ? s.ring : resampleClosed(s.ring, N); });
    var S2 = sections.length, nv = S2 * N + 2;
    var pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
    for (var i = 0; i < S2; i++) for (var j = 0; j < N; j++) {
      var o = (i * N + j);
      pos[o * 3] = sections[i].x; pos[o * 3 + 1] = rings[i][j][0]; pos[o * 3 + 2] = rings[i][j][1];
      uv[o * 2] = j / N; uv[o * 2 + 1] = i / (S2 - 1);
    }
    function centroid(ri, x, vi) {
      var cy = 0, cz = 0; rings[ri].forEach(function (q) { cy += q[0]; cz += q[1]; });
      pos[vi * 3] = x; pos[vi * 3 + 1] = cy / N; pos[vi * 3 + 2] = cz / N;
      uv[vi * 2] = 0.5; uv[vi * 2 + 1] = ri ? 1 : 0;
    }
    var c0 = S2 * N, c1 = S2 * N + 1;
    centroid(0, sections[0].x, c0); centroid(S2 - 1, sections[S2 - 1].x, c1);
    var idx = [];
    for (var a = 0; a < S2 - 1; a++) for (var b = 0; b < N; b++) {
      var p00 = a * N + b, p01 = a * N + (b + 1) % N, p10 = (a + 1) * N + b, p11 = (a + 1) * N + (b + 1) % N;
      idx.push(p00, p10, p01, p01, p10, p11);
    }
    for (var e = 0; e < N; e++) {
      idx.push(c0, e, (e + 1) % N);
      idx.push(c1, (S2 - 1) * N + (e + 1) % N, (S2 - 1) * N + e);
    }
    // orientation: positive signed volume ⇒ outward
    var vol = 0;
    for (var t = 0; t < idx.length; t += 3) {
      var A = idx[t] * 3, Bq = idx[t + 1] * 3, C = idx[t + 2] * 3;
      vol += pos[A] * (pos[Bq + 1] * pos[C + 2] - pos[Bq + 2] * pos[C + 1]) -
        pos[A + 1] * (pos[Bq] * pos[C + 2] - pos[Bq + 2] * pos[C]) +
        pos[A + 2] * (pos[Bq] * pos[C + 1] - pos[Bq + 1] * pos[C]);
    }
    if (vol < 0) for (var f = 0; f < idx.length; f += 3) { var tmp = idx[f + 1]; idx[f + 1] = idx[f + 2]; idx[f + 2] = tmp; }
    var nrm = computeNormals(pos, idx);
    // glass: greenhouse vertices (above belt) whose surface faces sideways/forward (not the roof)
    var isGlass = new Uint8Array(nv);
    for (var gi = 0; gi < S2; gi++) {
      var belt = sections[gi].belt; if (belt == null) continue;
      for (var gj = 0; gj < N; gj++) {
        var vi = gi * N + gj;
        if (rings[gi][gj][0] > belt + 0.02) isGlass[vi] = 1;
      }
    }
    var gPos = [], gNrm = [], gIdx = [], gmap = {};
    var thr = opts.roofNormalY || 0.93, off = 0.004;
    var flagged = sections.some(function (s) { return s.glass; });
    var quadGlass = null;
    if (flagged) {
      quadGlass = new Uint8Array((S2 - 1) * N);
      for (var qa = 0; qa < S2 - 1; qa++) for (var qb = 0; qb < N; qb++) {
        var g0 = sections[qa].glass, g1 = sections[qa + 1].glass, qn = (qb + 1) % N;
        var cnt = (g0 ? g0[qb] + g0[qn] : 0) + (g1 ? g1[qb] + g1[qn] : 0);
        quadGlass[qa * N + qb] = cnt >= 3 ? 1 : 0;
      }
    }
    for (var gt = 0; gt < idx.length; gt += 3) {
      var i0 = idx[gt], i1 = idx[gt + 1], i2 = idx[gt + 2];
      if (quadGlass) {
        var tq = gt / 3; if (tq >= (S2 - 1) * N * 2) continue;
        if (!quadGlass[tq >> 1]) continue;
      } else {
        if (!(isGlass[i0] && isGlass[i1] && isGlass[i2])) continue;
        if ((nrm[i0 * 3 + 1] + nrm[i1 * 3 + 1] + nrm[i2 * 3 + 1]) / 3 > thr) continue;
      }
      [i0, i1, i2].forEach(function (v) {
        if (gmap[v] == null) {
          gmap[v] = gPos.length / 3;
          gPos.push(pos[v * 3] + nrm[v * 3] * off, pos[v * 3 + 1] + nrm[v * 3 + 1] * off, pos[v * 3 + 2] + nrm[v * 3 + 2] * off);
          gNrm.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
        }
        gIdx.push(gmap[v]);
      });
    }
    // paint groups: per-vertex section.paint ('body' | 'black' | 'grille' ...) → index lists per paint (caps = body)
    var groups = null;
    if (sections.some(function (s) { return s.paint && s.paint.length === N; })) {
      var gm = {}, nq = (S2 - 1) * N;
      for (var pt = 0; pt < idx.length; pt += 3) {
        var tqi = pt / 3, key = 'body';
        if (tqi < nq * 2) {
          var qa2 = (tqi >> 1), ra = Math.floor(qa2 / N), rb = qa2 % N, cnt2 = {};
          [[ra, rb], [ra, (rb + 1) % N], [ra + 1, rb], [ra + 1, (rb + 1) % N]].forEach(function (c) {
            var pp = sections[c[0]].paint, v = pp && pp.length === N ? pp[c[1]] || 'body' : 'body';
            cnt2[v] = (cnt2[v] || 0) + (v === 'body' ? 1 : 1.01);
          });
          var bestN = -1; for (var kk in cnt2) if (cnt2[kk] > bestN) { bestN = cnt2[kk]; key = kk; }
        }
        (gm[key] = gm[key] || []).push(idx[pt], idx[pt + 1], idx[pt + 2]);
      }
      groups = Object.keys(gm).map(function (k) { return { paint: k, indices: new Uint32Array(gm[k]) }; });
    }
    return {
      groups: groups || [{ paint: 'body', indices: new Uint32Array(idx) }],
      positions: pos, normals: nrm, uvs: uv, indices: new Uint32Array(idx), vertexCount: nv, triangleCount: idx.length / 3,
      ringVerts: N, stations: S2,
      glass: { positions: new Float32Array(gPos), normals: new Float32Array(gNrm), indices: new Uint32Array(gIdx) }
    };
  }
  function computeNormals(pos, idx) {
    var n = new Float32Array(pos.length);
    for (var t = 0; t < idx.length; t += 3) {
      var a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      var vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (var k = 0; k < 3; k++) { var v = idx[t + k] * 3; n[v] += nx; n[v + 1] += ny; n[v + 2] += nz; }
    }
    for (var i = 0; i < n.length; i += 3) {
      var l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
    }
    return n;
  }

  /* ------------------------------------------------------------------ exports */
  S.registerModel = registerModel;
  S.modelsByStyle = modelsByStyle;
  S.defaultModel = defaultModel;
  S.getModel = getModel;
  S.list = list;
  S.fit = fit;
  S.refBuild = refBuild;
  S.toSvgPath = toSvgPath;
  S.bounds = bounds;
  S.sectionsFromViews = sectionsFromViews;
  S.loftToMesh = loftToMesh;
  S.parsePath = parsePath;
  S.toPath = toPath;
  S.flatten = flatten;
  S.sliceAt = sliceAt;
  S.mapPath = mapPath;
  S.items = items;
  S.parseTire = parseTire;
  S.tireDiameter = tireDiameter;
  S.isPath = isPath;
  S.STYLES = ['coupe', 'sedan', 'hatchback', 'wagon', 'suv', 'roadster', 'pickup', 'hypercar', 'shooting-brake', 'van'];

  // drain models registered before core loaded
  var pend = S._pending || [];
  S._pending = { push: function () { for (var i = 0; i < arguments.length; i++) registerModel(arguments[i]); return 0; } };
  pend.forEach(registerModel);

  if (typeof module !== 'undefined' && module.exports) module.exports = S;
})();
