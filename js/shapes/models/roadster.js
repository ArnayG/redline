/* FORGE Atelier — real-car shape models for body style 'roadster'.
   Models: Mazda MX-5 Miata (ND), BMW Z4 M40i (G29), Porsche 718 Boxster (982).
   Geometry in metres at each car's real published dimensions.
   Car-local axes: x forward (front bumper at +x), y up (ground y = 0), z right.
   Origin = midpoint between the axles on the ground centre line.
   Views: side (x,y) · top (x,z) · front/rear (z,y).
   Paths are arrays of segments {t:'M'|'L'|'C'|'Q'|'Z', p:[[a,b],...]} built from
   chord-length tangent splines (G1-continuous cubic Béziers) so surfaces stay smooth.
   Roadsters are modelled top-down (windows up): `greenhouse` is the windscreen frame
   and side glass; the closed hood is supplied separately as `softTop` in every view
   and defines the published overall height. Brand names are text only — no logos. */
(function () {
  'use strict';
  var CB = (globalThis.CB = globalThis.CB || {});
  CB.shapes = CB.shapes || {};

  /* ------------------------------------------------------------------ helpers */
  function f4(v) { return Math.round(v * 10000) / 10000; }
  function P(p) { return [f4(p[0]), f4(p[1])]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function len(v) { return Math.sqrt(v[0] * v[0] + v[1] * v[1]); }
  function nrm(v) { var l = len(v) || 1; return [v[0] / l, v[1] / l]; }

  // Spline through pts (each [a,b] or [a,b,1] where 1 = corner / tangent break).
  // Returns segments WITHOUT the leading M. Tangent at smooth points = bisector of the
  // unit chords (robust with uneven spacing); handle length = chord / 3.
  function splineSegs(pts, closed, t0, t1) {
    var n = pts.length, segs = [];
    function at(i) { return closed ? pts[(i + n) % n] : pts[i]; }
    function tan(i, out) {
      if (!closed && i === 0 && t0) return nrm(t0);
      if (!closed && i === n - 1 && t1) return nrm(t1);
      var p = at(i), pr = at(i - 1), nx = at(i + 1);
      if (!pr) return nrm(sub(nx, p));
      if (!nx) return nrm(sub(p, pr));
      if (p[2]) return out ? nrm(sub(nx, p)) : nrm(sub(p, pr));
      var a = nrm(sub(p, pr)), b = nrm(sub(nx, p));
      return nrm([a[0] + b[0], a[1] + b[1]]);
    }
    var m = closed ? n : n - 1;
    for (var i = 0; i < m; i++) {
      var a = at(i), b = at(i + 1), L = len(sub(b, a));
      if (a[2] && b[2] && !(closed && false)) { segs.push({ t: 'L', p: [P(b)] }); continue; }
      var ta = tan(i, true), tb = tan(i + 1, false);
      segs.push({ t: 'C', p: [P([a[0] + ta[0] * L / 3, a[1] + ta[1] * L / 3]), P([b[0] - tb[0] * L / 3, b[1] - tb[1] * L / 3]), P(b)] });
    }
    return segs;
  }

  function Path() { this.s = []; this.cur = null; }
  Path.prototype.M = function (p) { this.s.push({ t: 'M', p: [P(p)] }); this.cur = p; return this; };
  Path.prototype.L = function (p) { this.s.push({ t: 'L', p: [P(p)] }); this.cur = p; return this; };
  Path.prototype.through = function (pts, t0, t1) {
    var arr = [this.cur].concat(pts);
    this.s = this.s.concat(splineSegs(arr, false, t0, t1));
    this.cur = pts[pts.length - 1];
    return this;
  };
  // Elliptical arc, angles in degrees (y-up maths convention); draws a line to the start if needed.
  Path.prototype.arc = function (cx, cy, rx, ry, a0, a1) {
    var d2r = Math.PI / 180, sx = cx + rx * Math.cos(a0 * d2r), sy = cy + ry * Math.sin(a0 * d2r);
    if (!this.cur) this.M([sx, sy]);
    else if (Math.abs(this.cur[0] - sx) + Math.abs(this.cur[1] - sy) > 1e-4) this.L([sx, sy]);
    var sweep = a1 - a0, n = Math.max(1, Math.ceil(Math.abs(sweep) / 90 - 1e-9)), da = sweep / n;
    var k = 4 / 3 * Math.tan(da * d2r / 4);
    for (var i = 0; i < n; i++) {
      var t0 = (a0 + da * i) * d2r, t1 = (a0 + da * (i + 1)) * d2r;
      var p0 = [cx + rx * Math.cos(t0), cy + ry * Math.sin(t0)], p1 = [cx + rx * Math.cos(t1), cy + ry * Math.sin(t1)];
      this.s.push({ t: 'C', p: [
        P([p0[0] - k * rx * Math.sin(t0), p0[1] + k * ry * Math.cos(t0)]),
        P([p1[0] + k * rx * Math.sin(t1), p1[1] - k * ry * Math.cos(t1)]),
        P(p1)] });
      this.cur = p1;
    }
    return this;
  };
  Path.prototype.Z = function () { this.s.push({ t: 'Z', p: [] }); return this.s; };
  Path.prototype.done = function () { return this.s; };

  function blob(pts) { return [{ t: 'M', p: [P(pts[0])] }].concat(splineSegs(pts, true), [{ t: 'Z', p: [] }]); }
  function open(pts, t0, t1) { return [{ t: 'M', p: [P(pts[0])] }].concat(splineSegs(pts, false, t0, t1)); }
  function poly(pts) {
    var s = [{ t: 'M', p: [P(pts[0])] }];
    for (var i = 1; i < pts.length; i++) s.push({ t: 'L', p: [P(pts[i])] });
    s.push({ t: 'Z', p: [] });
    return s;
  }
  function ellipse(cx, cy, rx, ry) { var p = new Path(); p.arc(cx, cy, rx, ry, 0, 360); return p.Z(); }
  function rrect(a0, b0, a1, b1, r) {
    var p = new Path();
    p.M([a0 + r, b0]).L([a1 - r, b0]).arc(a1 - r, b0 + r, r, r, -90, 0).L([a1, b1 - r]).arc(a1 - r, b1 - r, r, r, 0, 90)
      .L([a0 + r, b1]).arc(a0 + r, b1 - r, r, r, 90, 180).L([a0, b0 + r]).arc(a0 + r, b0 + r, r, r, 180, 270);
    return p.Z();
  }
  // Mirror a path across axis coordinate `ax` (0 → negate first coord, 1 → second).
  function mirror(path, ax) {
    return path.map(function (sg) {
      return { t: sg.t, p: sg.p.map(function (q) { return ax === 1 ? [q[0], f4(-q[1] || 0)] : [f4(-q[0] || 0), q[1]]; }) };
    });
  }
  function pair(path, ax) { return [path, mirror(path, ax || 0)]; }
  // Mirrored pair of painted items {path, paint, role}.
  function pairItem(it, ax) {
    var m = {}; for (var k in it) m[k] = it[k]; m.path = mirror(it.path, ax || 0); return [it, m];
  }
  // Full symmetric outline for front/rear views from the right half (z>=0), top centre → bottom centre.
  function symFR(half) {
    var mid = half.slice(1, -1).reverse().map(function (q) { return [-q[0], q[1], q[2]]; });
    return blob(half.concat(mid));
  }
  // Full symmetric plan outline from the right half (z>=0), nose centre → tail centre.
  function symPlan(half) {
    var mid = half.slice(1, -1).reverse().map(function (q) { return [q[0], -q[1], q[2]]; });
    return blob(half.concat(mid));
  }
  function tireDia(spec) { // '205/45R17' → overall diameter (m)
    var m = /(\d+)\/(\d+)\D*R?\s*(\d+)/.exec(spec);
    return (2 * (+m[1]) * (+m[2]) / 100 + (+m[3]) * 25.4) / 1000;
  }
  // Front/rear-view door mirror: housing tapering inboard to a stalk that meets the door top at z = zi.
  function frMirror(zi, zo, yb, yt) {
    return blob([[zi, yb + 0.004, 1], [zi, yb + 0.026, 1], [zo - 0.17, yt - 0.012], [zo - 0.06, yt], [zo, yt - 0.024],
      [zo - 0.004, yb + 0.012], [zo - 0.05, yb], [zo - 0.17, yb + 0.004]]);
  }
  // Front/rear-view windscreen: glass pulled in 0.04 per side at the top, framed by a ~0.03 m header + A-pillars.
  // zt / yt = outer top corner, zb / yb = outer base corner (right half). Returns { glass, frame }.
  function screenFR(zt, yt, zb, yb) {
    var w = 0.03, gt = zt - 0.04, gb = zb - 0.03;
    return {
      glass: [[0, yt - w], [gt, yt - w - 0.004, 1], [gb, yb, 1], [0, yb]],
      frame: poly([[-zb, yb], [-zt, yt - 0.004], [-zt + 0.06, yt], [0, yt + 0.002], [zt - 0.06, yt], [zt, yt - 0.004], [zb, yb],
        [gb, yb], [gt, yt - w - 0.004], [0, yt - w], [-gt, yt - w - 0.004], [-gb, yb]])
    };
  }
  function D(view, role, path, paint) { return { view: view, role: role, path: path, paint: paint }; }
  // Closed ribbon of width w along a smooth centre line (used for LED strokes / thin trims).
  function ribbon(pts, w) {
    var h = w / 2, L = [], R = [];
    for (var i = 0; i < pts.length; i++) {
      var a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], t = nrm(sub(b, a)), n = [-t[1], t[0]];
      L.push([pts[i][0] + n[0] * h, pts[i][1] + n[1] * h]); R.push([pts[i][0] - n[0] * h, pts[i][1] - n[1] * h]);
    }
    L[0][2] = 1; L[L.length - 1][2] = 1; R[0][2] = 1; R[R.length - 1][2] = 1;
    return blob(L.concat(R.reverse()));
  }
  // Path with a hole: outer outline + reversed inner outline (non-zero fill leaves the inside open).
  function holed(outer, inner) { return blob(outer).concat(blob(inner.slice().reverse())); }
  function annulus(cx, cy, r, w) {
    var p = new Path(); p.arc(cx, cy, r + w / 2, r + w / 2, 0, 360); var o = p.Z();
    var q = new Path(); q.arc(cx, cy, r - w / 2, r - w / 2, 360, 0); return o.concat(q.Z());
  }
  // Rotate a path about (cx, cy) by deg degrees.
  function rot(path, cx, cy, deg) {
    var c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
    return path.map(function (sg) {
      return { t: sg.t, p: sg.p.map(function (q) { var a = q[0] - cx, b = q[1] - cy; return [f4(cx + a * c - b * s), f4(cy + a * s + b * c)]; }) };
    });
  }

  // Polygon with filleted corners: pts [[a, b, r], ...] (r = fillet radius, 0 = sharp). Each fillet is a
  // single cubic (tangent-continuous with both edges), so DLOs, kidneys and lamps get crisp, even radii.
  function rpoly(pts) {
    var n = pts.length, cs = [];
    for (var i = 0; i < n; i++) {
      var p0 = pts[(i + n - 1) % n], p1 = pts[i], p2 = pts[(i + 1) % n], r = p1[2] || 0;
      var d1 = nrm(sub(p0, p1)), d2 = nrm(sub(p2, p1)), cosA = Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1]));
      var th = Math.acos(cosA), cut = r > 0 && th < Math.PI - 1e-3 ? r / Math.tan(th / 2) : 0;
      cut = Math.min(cut, 0.45 * len(sub(p0, p1)), 0.45 * len(sub(p2, p1)));
      var k = cut > 0 ? 4 / 3 * Math.tan((Math.PI - th) / 4) * Math.tan(th / 2) : 0;   // handle / cut (true circular fillet)
      var A = [p1[0] + d1[0] * cut, p1[1] + d1[1] * cut], B = [p1[0] + d2[0] * cut, p1[1] + d2[1] * cut];
      cs.push({ A: A, B: B, cA: [A[0] - d1[0] * cut * k, A[1] - d1[1] * cut * k], cB: [B[0] - d2[0] * cut * k, B[1] - d2[1] * cut * k], cut: cut });
    }
    var segs = [{ t: 'M', p: [P(cs[0].B)] }];
    for (var j = 1; j <= n; j++) {
      var c = cs[j % n];
      segs.push({ t: 'L', p: [P(c.A)] });
      if (c.cut > 0) segs.push({ t: 'C', p: [P(c.cA), P(c.cB), P(c.B)] });
    }
    segs.push({ t: 'Z', p: [] });
    return segs;
  }
  // Rotated oval: ellipse (rx, ry) about (cx, cy) turned by deg (+ = counter-clockwise).
  function oval(cx, cy, rx, ry, deg) { return rot(ellipse(cx, cy, rx, ry), cx, cy, deg || 0); }

  /* ---------------------------------------------- 3D: explicit open-top sections
     Polyline sampling of our own paths, then fixed-topology rings of 32 vertices (17 per
     half, the contract ringVerts) so every index keeps its meaning along the car:
       0 underbody centre · 1 underbody · 2–8 side levels (rocker → fender crest)
       9–16 top band, which is one of
         bonnet / deck : 8 points dipping between the fender crests (deck carries roll hoops 11–13)
         windscreen    : 9 glass top at the A-pillar · 10 glass top centre · 11 underside centre ·
                         12 underside at the pillar (a 0.03 m shell following the rake) ·
                         13–16 dark void under it (dash, tub floor)
         cockpit       : 9–12 collapsed into one point that runs from the A-pillar top down
                         to the tub lip (closes the glass edge) · 13–16 tub wall / floor.
     Stations are evenly pitched (0.045 m; 0.035 m over the arches; 0.025 m over the last
     0.15 m of nose and tail, where the section rounds toward an ellipse). Wheel wells use
     vertices 2–4 (liner) and 5 (arch lip); the level layout blends back to the plain body
     over 0.18 m beyond each arch. Glass flags mark the windscreen and the dark cockpit
     interior; `belt` lets loftToMesh fall back to the windscreen. */
  function flat(path) {
    var pts = [], cur = null, st = null;
    path.forEach(function (sg) {
      if (sg.t === 'M') { cur = sg.p[0]; st = cur; pts.push(cur); }
      else if (sg.t === 'L') { cur = sg.p[0]; pts.push(cur); }
      else if (sg.t === 'C') {
        var c = [cur].concat(sg.p);
        for (var i = 1; i <= 12; i++) {
          var t = i / 12, u = 1 - t;
          pts.push([u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0],
            u * u * u * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t * t * t * c[3][1]]);
        }
        cur = sg.p[2];
      } else if (sg.t === 'Z' && st) { pts.push(st); cur = st; }
    });
    return pts;
  }
  function slice(pts, x) {
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i + 1 < pts.length; i++) {
      var a = pts[i], b = pts[i + 1];
      if ((a[0] - x) * (b[0] - x) > 0 || a[0] === b[0]) continue;
      var y = a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
      lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
    return lo === Infinity ? null : [lo, hi];
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }
  // bonnet / deck dip profile: [fraction of dip depth above the centre, z / crest-z * 0.84]
  var DIP = [[0.96, 0.86], [0.80, 0.74], [0.56, 0.61], [0.32, 0.47], [0.13, 0.32], [0.03, 0.18], [0, 0.07], [0, 0]];
  function dipAt(zr) {
    for (var i = 0; i + 1 < DIP.length; i++) {
      var a = DIP[i], b = DIP[i + 1];
      if (zr <= a[1] && zr >= b[1]) return lerp(b[0], a[0], (zr - b[1]) / ((a[1] - b[1]) || 1));
    }
    return zr > DIP[0][1] ? DIP[0][0] : 0;
  }
  function buildSections(m, o) {
    var side = m.side, sb = flat(side.body), tb = flat(m.top.body), tc = flat(m.top.cockpit), tg = flat(m.top.greenhouse);
    var ws = flat(side.windshield), wsB = [Infinity, -Infinity, 0];
    ws.forEach(function (q) { if (q[0] < wsB[0]) { wsB[0] = q[0]; wsB[2] = q[1]; } wsB[1] = Math.max(wsB[1], q[0]); });
    var xh = wsB[0], yh = wsB[2], x0 = o.screenBase[0], yb0 = o.screenBase[1];   // header / cowl
    var slope = (yh - yb0) / (x0 - xh), dGl = 0.03 * Math.sqrt(1 + slope * slope);   // vertical thickness of a 0.03 m shell
    var xDash = o.dash != null ? o.dash : xh + 0.30 * (x0 - xh);
    var tgB = tg.reduce(function (b, q) { return [Math.min(b[0], q[0]), Math.max(b[1], q[0])]; }, [Infinity, -Infinity]);
    var ckB = tc.reduce(function (b, q) { return [Math.min(b[0], q[0]), Math.max(b[1], q[0])]; }, [Infinity, -Infinity]);
    var minX = Infinity, maxX = -Infinity; sb.forEach(function (q) { minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]); });
    var r = m.ref, arches = [side.archF, side.archR];
    var wells = [[side.archF, r.trackF, tireW(r.tireF)], [side.archR, r.trackR, tireW(r.tireR)]].map(function (A) {
      return { x: A[0].x, y: A[0].y, r: A[0].r, zIn: A[1] / 2 - A[2] / 2 - 0.03, zLip: A[1] / 2 + A[2] / 2 + 0.006 };
    });
    function raw(x) { return slice(sb, x); }
    function bottom(x) {
      for (var i = 0; i < arches.length; i++) {
        var a = arches[i], e = a.r * 1.12;
        if (Math.abs(x - a.x) < e) { var l = raw(a.x - e), q = raw(a.x + e); return l[0] + (q[0] - l[0]) * (x - a.x + e) / (2 * e); }
      }
      return raw(x)[0];
    }
    function half(pts, x) { var s = slice(pts, x); return s ? Math.max(Math.abs(s[0]), Math.abs(s[1])) : 0; }
    var gH = half(tg, tgB[0] + 0.01);
    // roll hoops: sit on the deck just behind the cockpit opening (x-range from the side view, z from the plan trim)
    var hp = o.hoop, hx0 = hp ? Math.min(hp.x0, ckB[0] - 0.004) : 0;
    var END = 0.15, nose0 = maxX - END, tail0 = minX + END, fall = o.noseFall || 0.22;
    // stations: even 0.045 m pitch, 0.035 m over each wheel arch, 0.025 m over the last 0.15 m of nose and
    // tail, plus feature edges (windscreen header / cowl, cockpit lip, hoops, carves)
    var xs = [], spans = wells.map(function (wl) { return [wl.x - wl.r - 0.02, wl.x + wl.r + 0.02]; });
    function inSpan(x) { return spans.some(function (s) { return x > s[0] - 0.012 && x < s[1] + 0.012; }); }
    var NB = Math.ceil((nose0 - tail0) / 0.045);
    for (var k = 0; k <= NB; k++) { var xk = tail0 + (nose0 - tail0) * k / NB; if (!inSpan(xk)) xs.push(xk); }
    for (var e6 = 0; e6 < 6; e6++) { xs.push(minX + 0.004 + (END - 0.004) * e6 / 6); xs.push(maxX - 0.004 - (END - 0.004) * e6 / 6); }
    spans.forEach(function (s) { var n = Math.round((s[1] - s[0]) / 0.035); for (var i = 0; i <= n; i++) xs.push(s[0] + (s[1] - s[0]) * i / n); });
    var feat = [xh + 0.006, xh - 0.006, xh - 0.03, xh - 0.06, ckB[0] + 0.008, ckB[0] + 0.03, x0 + 0.01, x0 - 0.01, xDash + 0.03, xDash - 0.03];
    if (hp) feat = feat.concat([hx0, hx0 - 0.012, hx0 - 0.03, (hx0 + hp.x1) / 2, hp.x1 + 0.03, hp.x1 + 0.012, hp.x1]);
    (o.carves || []).forEach(function (c) { feat = feat.concat([c.x0, c.x0 - 0.03, (c.x0 + c.x1) / 2, c.x1 + 0.03, c.x1]); });
    // a feature edge replaces the nearest even station instead of crowding in beside it
    feat.forEach(function (x) {
      if (inSpan(x)) return;
      var j = -1, best = 0.016;
      xs.forEach(function (q, i) { if (Math.abs(q - x) < best && !inSpan(q) && q > tail0 && q < nose0) { best = Math.abs(q - x); j = i; } });
      if (j >= 0) xs[j] = x; else xs.push(x);
    });
    xs.sort(function (a, b) { return a - b; });
    xs = xs.filter(function (x, i) { return x > minX && x < maxX && (i === 0 || x - xs[i - 1] > 0.006); });
    for (var g = xs.length - 1; g > 0; g--) {
      var gap = xs[g] - xs[g - 1], nIns = Math.ceil(gap / 0.045) - 1;
      for (var gi = nIns; gi >= 1; gi--) xs.splice(g, 0, xs[g - 1] + gap * gi / (nIns + 1));
    }
    var LV = o.levels || [0, 0.10, 0.27, 0.46, 0.65, 0.84, 1];
    return xs.map(function (x) {
      var s = raw(x), yt = s[1], yb = Math.min(bottom(x), yt - 0.05), w = Math.max(half(tb, x), 0.02);
      // nose / tail: the section rounds off toward an ellipse over the last 0.15 m (no blunt slab)
      var et = Math.max(smooth((x - nose0) / END), smooth((tail0 - x) / END));
      var yw = yb + o.waist * (yt - yb), cf = lerp(o.crest, 0.5, et), rk = lerp(0.88, 0.6, et);
      function zOut(y) {
        if (y <= yw) { var tt = (yw - y) / Math.max(1e-6, yw - yb); return w * (rk + (1 - rk) * Math.pow(1 - Math.pow(tt, 3.2), 1 / 3.2)); }
        var u = Math.min(1, (y - yw) / Math.max(1e-6, yt - yw));
        return w * (cf + (1 - cf) * Math.pow(1 - Math.pow(u, 2.6), 1 / 2.6));
      }
      var h = [[yb, 0], [yb, 0.5 * w]];
      LV.forEach(function (f) { var y = yb + f * (yt - yb); h.push([y, zOut(y)]); });
      // wheel wells: under the arch vertices 2–4 run down the liner just inboard of the tyre (4 = well top),
      // 5 is the arch lip, 6–7 share the fender above. The level layout blends back to the plain body over
      // 0.18 m either side of the arch so the shoulder carries no creases at the arch ends.
      wells.forEach(function (wl) {
        var dx = x - wl.x, adx = Math.abs(dx), BL = 0.18;
        if (adx >= wl.r + BL) return;
        var inA = adx < wl.r * 0.999;
        var topE = inA ? Math.min(wl.y + Math.sqrt(wl.r * wl.r - dx * dx), yt - 0.03) : wl.y;
        var a = inA ? 1 : 1 - smooth((adx - wl.r) / BL);
        var tgt = [yb, lerp(yb, topE, 0.5), topE, topE + 0.004, lerp(topE, yt, 0.38), lerp(topE, yt, 0.72)];
        for (var j = 2; j <= 7; j++) { var y = lerp(h[j][0], tgt[j - 2], a); h[j] = [y, zOut(y)]; }
        h[5][1] = Math.max(h[5][1], lerp(h[5][1], wl.zLip, a));
        if (inA) {
          var zi = Math.min(wl.zIn, w * rk);
          h[2] = [yb, zi]; h[3] = [tgt[1], zi]; h[4] = [topE, zi];
          h[1] = [yb, Math.min(h[1][1], zi * 0.9)];
        }
      });
      // carved side features (Air Breather, side intake): recess the side vertices inside the opening
      (o.carves || []).forEach(function (c) {
        if (x >= c.x0 || x <= c.x1) return;
        var e = smooth(Math.min(c.x0 - x, x - c.x1) / 0.045);
        for (var j = 2; j <= 7; j++) if (h[j][0] >= c.y0 - 0.02 && h[j][0] <= c.y1 + 0.02) h[j] = [h[j][0], h[j][1] - c.d * e];
      });
      var zc = h[8][1], top = [], dark = false, belt = null;
      var cw = Math.min(half(tc, x), zc - 0.04), gw = Math.min(half(tg, Math.max(x, tgB[0] + 0.01)), zc - 0.02);
      var yf = yt - o.tubDepth;
      if (x <= xh && cw > 0.1) {                                  // open cockpit: 9–12 collapse at the A-pillar top, 13–16 tub
        dark = true;
        var q = smooth((xh - 0.006 - x) / 0.07);
        var Q = [lerp(yh - dGl * 0.5, yt - 0.035, q), lerp(Math.min(gH, zc - 0.02) - 0.015, cw, q)];
        top.push(Q, Q, Q, Q);
        top.push([yf + 0.04, Math.max(cw - 0.04, 0.10)], [yf, Math.max(cw - 0.12, 0.09)], [yf + 0.05, 0.08], [yf + 0.06, 0]);
      } else if (x > xh && x < x0 + 0.01 && gw > 0.1) {           // windscreen: 9–10 glass top, 11–12 underside (0.03 m shell), 13–16 void
        var yW = yb0 + (yh - yb0) * Math.min(1, Math.max(0, (x0 - x) / (x0 - xh)));
        yW = Math.max(yW, yt - 0.005);
        dark = true; belt = yt;
        var dk = smooth((x - xDash) / 0.06), yv = lerp(yf, Math.min(yt - 0.03, yW - dGl - 0.012), dk), tn = 0.05 * (1 - dk);
        var yu = yW - dGl, zw = gw - 0.03;
        top.push([yW, gw], [yW + 0.022, 0], [yW + 0.022 - dGl, 0], [yu, zw]);
        top.push([Math.min(yv + 0.04, yu - 0.002), zw - 0.04], [yv, Math.max(0.1, zw - 0.12)], [yv + tn, 0.08], [yv + tn + 0.01, 0]);
      } else {                                                    // bonnet / deck dipping between the fender crests
        var front = x > 0, d;
        if (front) d = o.dipF * (0.35 + 0.65 * smooth((x - x0) / 0.35)) * smooth((maxX - 0.02 - x) / fall);
        else d = o.dipR * smooth((ckB[0] - x) / 0.25) * smooth((x - minX - 0.02) / 0.22);
        var yc = yt - d;
        if (front || !hp) DIP.forEach(function (q2) { top.push([yc + d * q2[0], zc * q2[1] / 0.84]); });
        else {
          // rear deck: fixed z layout so the hoop crowns (vertices 11–13) rise in place; an optional
          // fairing (hp.tail) ramps them back down into the deck behind the hoop
          var e = 0;
          if (x < hx0 && x > hp.x1) e = smooth(Math.min(hx0 - x, x - hp.x1) / 0.025);
          if (hp.tail != null && x <= hp.x1 + 0.025 && x > hp.tail) e = Math.max(e, smooth((x - hp.tail) / (hp.x1 + 0.025 - hp.tail)));
          var zs = [zc * 0.86 / 0.84, hp.z1 + 0.04, hp.z1 - 0.025, (hp.z0 + hp.z1) / 2, hp.z0 + 0.025, hp.z0 - 0.035, 0.05, 0];
          zs.forEach(function (z, i) {
            var yd = yc + d * dipAt(z * 0.84 / zc);
            top.push([(i >= 2 && i <= 4) ? lerp(yd, Math.max(hp.y, yt + 0.06), e) : (i === 1 || i === 5) ? lerp(yd, yd + 0.02, e) : yd, z]);
          });
        }
      }
      h = h.concat(top);
      var ring = h.map(function (q3) { return [f4(q3[0]), f4(q3[1])]; });
      for (var i = h.length - 2; i >= 1; i--) ring.push([f4(h[i][0]), f4(-h[i][1] || 0)]);
      var flags = h.map(function (q4, i2) { return dark && i2 >= 9 ? 1 : 0; });
      var sec = { x: f4(x), ring: ring, glass: flags.concat(flags.slice(1, -1).reverse()) };
      if (belt != null) sec.belt = f4(belt);
      return sec;
    });
  }
  function tireW(spec) { return +(/(\d+)\//.exec(spec)[1]) / 1000; }

  /* Side-body builder: `top` runs from the front chin up over the nose, along the
     silhouette top and down the tail to the rear lower bumper; `front` closes from the
     front arch's leading edge back to the chin. Arches are true circular cut-outs. */
  function sideBody(o) {
    var p = new Path(), d2r = Math.PI / 180;
    function edge(a, yE) { return Math.asin((yE - a.y) / a.r) / d2r; }
    var R = o.archR, F = o.archF;
    var aR = edge(R, o.edgeR), aF = edge(F, o.edgeF);
    p.M(o.top[0]).through(o.top.slice(1));
    p.arc(R.x, R.y, R.r, R.r, 180 - aR, aR);                 // over the rear wheel
    var rFront = R.x + R.r * Math.cos(aR * d2r), fRear = F.x - F.r * Math.cos(aF * d2r);
    p.L([rFront + 0.035, o.sillY]).L([fRear - 0.035, o.sillY]);
    p.arc(F.x, F.y, F.r, F.r, 180 - aF, aF);                 // over the front wheel
    p.through(o.front.concat([o.top[0]]));
    return p.Z();
  }

  /* --------------------------------------------------------------- model maker */
  function asPath(q) { return q && q[0] && typeof q[0].t === 'string' ? q : blob(q); }
  function makeModel(c) {
    var r = c.ref, hw = r.wheelbase / 2;
    var dF = tireDia(r.tireF), dR = tireDia(r.tireR);
    var archF = { x: hw, y: f4(dF / 2), r: f4(dF / 2 + c.archGap), flare: c.flare };
    var archR = { x: -hw, y: f4(dR / 2), r: f4(dR / 2 + c.archGap), flare: c.flare };
    var S = c.side;
    var side = {
      body: sideBody({ top: S.top, front: S.front, archF: archF, archR: archR, edgeF: S.edgeF, edgeR: S.edgeR, sillY: S.sillY }),
      greenhouse: asPath(S.greenhouse),
      windows: S.windows.map(asPath),
      windshield: blob(S.windshield),
      pillars: S.pillars.map(blob),
      rollHoops: S.rollHoops.map(blob),
      softTop: blob(S.softTop),
      doorCuts: S.doorCuts.map(function (q) { return open(q); }),
      panelLines: S.panelLines.map(function (q) { return open(q); }),
      characterLines: S.characterLines.map(function (q) { return open(q); }),
      sill: blob(S.sill),
      archF: archF, archR: archR,
      lowerTrim: S.lowerTrim.map(blob)
    };
    var T = c.top;
    var top = {
      body: symPlan(T.body),
      greenhouse: asPath(T.greenhouse),
      cockpit: asPath(T.cockpit),
      hood: blob(T.hood),
      softTop: blob(T.roof),          // closed hood planform (roof omitted: car is shown top-down)
      deck: blob(T.deck),
      mirrors: pair(blob(T.mirror), 1),
      panelLines: T.panelLines || [],
      characterLines: T.characterLines || []
    };
    var Fr = c.front, Rr = c.rear, frames = [];
    [['front', Fr], ['rear', Rr]].forEach(function (v) {
      var g = v[1].greenhouse;
      if (g && g.frame) { frames.push(D(v[0], 'trim', g.frame, c.screenFramePaint || 'body')); v[1].greenhouse = g.glass; }
    });
    var front = {
      body: symFR(Fr.body),
      greenhouse: symFR(Fr.greenhouse),
      softTop: symFR(Fr.softTop),
      bumper: symFR(Fr.bumper),
      grille: Fr.grille,
      intakes: Fr.intakes,
      headlights: pair(asPath(Fr.headlight)),
      drl: Fr.drl,
      splitter: Fr.splitter ? symFR(Fr.splitter) : undefined,
      panelLines: Fr.panelLines || [],
      characterLines: Fr.characterLines || [],
      plateArea: Fr.plateArea,
      badgeArea: Fr.badgeArea,
      badgeText: Fr.badgeText
    };
    var rear = {
      body: symFR(Rr.body),
      greenhouse: symFR(Rr.greenhouse),
      softTop: symFR(Rr.softTop),
      bumper: symFR(Rr.bumper),
      taillights: pair(asPath(Rr.taillight)),
      lightBar: Rr.lightBar,
      diffuser: symFR(Rr.diffuser),
      exhaust: Rr.exhaust,
      plateArea: Rr.plateArea,
      badgeArea: Rr.badgeArea,
      badgeText: Rr.badgeText,
      spoiler: Rr.spoiler,
      rollHoops: Rr.rollHoops
    };
    var model = {
      id: c.id, make: c.make, look: c.look, name: c.name, gen: c.gen, years: c.years, style: 'roadster',
      enginePosition: c.enginePosition, drivetrain: c.drivetrain, powertrain: c.powertrain, openTop: true,
      ref: r, side: side, top: top, front: front, rear: rear,
      details: [D('top', 'interior', top.cockpit, 'black')]
        .concat(side.rollHoops.map(function (p) { return D('side', 'rollHoop', p, 'black'); }))
        .concat(frames)
        .concat(c.details(side, top, front, rear))
        .concat(rear.rollHoops.map(function (p) { return D('rear', 'rollHoop', p, 'black'); })),
      signature: c.signature, sources: c.sources
    };
    // explicit open-top cross-sections (windscreen + black cockpit tub + roll hoops, fender crests)
    model.sections = buildSections(model, c.loft);
    return model;
  }

  /* ================================================================ MAZDA MX-5 ND
     3915 × 1735 × 1235 mm, wheelbase 2310, track 1495/1505, 205/45R17 (Club).
     Overhangs 765 / 840 (ND cut 45/40 mm vs NC). Kodo design: front fenders crest
     above the low bonnet, slim "eye" headlamps, wide low grille mouth, rear lamps with
     twin LED rings, fender line sweeping down through the door into the sill. */
  var mx5 = makeModel({
    id: 'mazda-mx5-nd', make: 'Mazda', name: 'MX-5 Miata', gen: 'ND', years: '2015–',
    look: { head: 'slim-led', tail: 'round-ring', grille: 'mesh' },   // renderer lamp / grille signature
    enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice',
    ref: { length: 3.915, width: 1.735, height: 1.235, wheelbase: 2.310, trackF: 1.495, trackR: 1.505,
      frontOverhang: 0.765, rearOverhang: 0.840, wheelDiameter_in: 17, tireF: '205/45R17', tireR: '205/45R17',
      groundClearance: 0.135, rideHeight: 0.140, cd: 0.33, curbWeight_kg: 1058 },
    archGap: 0.034, flare: 0.012,
    loft: { screenBase: [0.50, 0.815], waist: 0.50, crest: 0.78, tubDepth: 0.32, dipF: 0.05, dipR: 0.03,
      hoop: { x0: -1.00, x1: -1.20, y: 1.06, z0: 0.12, z1: 0.36 } },
    side: {
      top: [[1.83, 0.205], [1.886, 0.228], [1.909, 0.29], [1.917, 0.37], [1.92, 0.44], [1.905, 0.56], [1.86, 0.63], [1.72, 0.70], [1.45, 0.745],
        [1.22, 0.785], [1.02, 0.80], [0.78, 0.80], [0.48, 0.815], [0.05, 0.835], [-0.55, 0.85], [-1.05, 0.872],
        [-1.50, 0.882], [-1.82, 0.874], [-1.955, 0.856, 1], [-1.986, 0.78], [-1.978, 0.62], [-1.984, 0.47],
        [-1.966, 0.38], [-1.928, 0.316], [-1.87, 0.28], [-1.80, 0.258], [-1.72, 0.248]],   // undercut lower rear face
      front: [[1.62, 0.215], [1.74, 0.205]],
      edgeF: 0.235, edgeR: 0.24, sillY: 0.150,
      // greenhouse = A-pillar + frameless door glass (top down): the DLO top edge falls toward the rear
      greenhouse: rpoly([[0.50, 0.815, 0], [-0.105, 1.185, 0.008], [-0.17, 1.19, 0.008], [-0.122, 1.151, 0], [-0.045, 1.104, 0.01], [-0.64, 1.049, 0.10], [-0.70, 0.866, 0], [-0.2, 0.846, 0]]),
      windshield: [[0.50, 0.815, 1], [-0.105, 1.185, 1], [-0.165, 1.185, 1], [0.40, 0.825, 1]],
      // frameless door glass: top edge falls 0.055 m rearward, rear edge raked 15°, 0.10 m top-rear radius
      windows: [rpoly([[0.36, 0.848, 0], [-0.04, 1.100, 0.012], [-0.64, 1.045, 0.10], [-0.70, 0.866, 0], [-0.2, 0.852, 0]])],
      pillars: [[[0.50, 0.815, 1], [-0.105, 1.185, 1], [-0.17, 1.19, 1], [-0.12, 1.15, 1], [0.36, 0.848, 1]]],
      rollHoops: [[[-1.00, 0.866, 1], [-1.02, 1.025], [-1.10, 1.06], [-1.18, 1.025], [-1.20, 0.874, 1]]],   // hoop + headrest fairing
      softTop: [[-0.105, 1.185, 1], [-0.30, 1.228], [-0.55, 1.235], [-0.82, 1.205], [-1.06, 1.10], [-1.22, 0.95], [-1.30, 0.878, 1], [-0.88, 0.858, 1]],
      doorCuts: [[[0.47, 0.818], [0.475, 0.60], [0.50, 0.36], [0.53, 0.17]], [[-0.72, 0.856], [-0.73, 0.55], [-0.745, 0.30], [-0.76, 0.155]]],
      panelLines: [
        [[1.86, 0.596], [1.62, 0.672], [1.30, 0.758], [1.00, 0.792], [0.56, 0.808]],      // bonnet shut line (just inside fender crest)
        [[1.66, 0.664], [1.60, 0.58], [1.54, 0.50], [1.49, 0.44]],                         // bumper / fender seam
        [[-1.18, 0.874], [-1.55, 0.878], [-1.84, 0.866], [-1.95, 0.84]],                   // boot lid
        [[-1.80, 0.86], [-1.70, 0.70], [-1.58, 0.56], [-1.50, 0.48]]],                     // rear bumper seam
      characterLines: [
        [[0.80, 0.745], [0.48, 0.66], [0.08, 0.53], [-0.38, 0.452], [-0.72, 0.44]],       // Kodo sweep: fender → door → sill
        [[-0.76, 0.45], [-0.90, 0.585], [-1.10, 0.70], [-1.40, 0.765], [-1.80, 0.79]]],   // rear haunch rising from the door's lower rear corner
      sill: [[0.78, 0.215, 1], [0.78, 0.15, 1], [-0.78, 0.15, 1], [-0.78, 0.215, 1]],
      lowerTrim: [[[1.62, 0.215, 1], [1.80, 0.216], [1.84, 0.205], [1.80, 0.20, 1], [1.62, 0.20, 1]], [[-1.78, 0.235, 1], [-1.90, 0.236], [-1.86, 0.215, 1], [-1.62, 0.22, 1]]]
    },
    top: {
      // soft-pointed nose, fender crests bulging at the axles (±1.155), waist pinched at the door
      body: [[1.92, 0], [1.912, 0.22], [1.89, 0.40], [1.85, 0.55], [1.78, 0.672], [1.69, 0.762], [1.53, 0.826], [1.36, 0.853], [1.155, 0.8675], [0.92, 0.851],
        [0.55, 0.834], [0.15, 0.823], [-0.20, 0.818], [-0.55, 0.828], [-0.88, 0.850], [-1.155, 0.8675], [-1.45, 0.854], [-1.66, 0.842], [-1.745, 0.828],
        [-1.835, 0.76], [-1.915, 0.62], [-1.962, 0.42], [-1.988, 0.20], [-1.995, 0]],     // rear corner rolled over 0.25 m
      greenhouse: [[0.50, 0.65], [0.20, 0.632], [-0.11, 0.58, 1], [-0.11, -0.58, 1], [0.20, -0.632], [0.50, -0.65], [0.53, 0]],
      cockpit: rpoly([[-0.11, 0.58, 0], [-0.55, 0.625, 0.6], [-0.93, 0.60, 0.12], [-0.98, 0.0, 0.25], [-0.93, -0.60, 0.12], [-0.55, -0.625, 0.6], [-0.11, -0.58, 0]]),
      hood: [[1.86, 0.30], [1.62, 0.52], [1.10, 0.58], [0.52, 0.62, 1], [0.52, -0.62, 1], [1.10, -0.58], [1.62, -0.52], [1.86, -0.30], [1.89, 0]],
      roof: [[-0.105, 0.61, 1], [-0.70, 0.645], [-1.22, 0.66, 1], [-1.22, -0.66, 1], [-0.70, -0.645], [-0.105, -0.61, 1]],
      deck: [[-1.20, 0.72, 1], [-1.60, 0.72], [-1.93, 0.56], [-1.96, 0], [-1.93, -0.56], [-1.60, -0.72], [-1.20, -0.72, 1]],
      mirror: [[0.42, 0.86, 1], [0.40, 0.99], [0.32, 1.00], [0.29, 0.93], [0.31, 0.85, 1]]
    },
    front: {
      // twin fender humps (crest 0.845) either side of the low bonnet; upper body tucked in for tumblehome,
      // lower corners pulled in so the tyre shoulders show outboard
      body: [[0, 0.828], [0.40, 0.832], [0.60, 0.845], [0.68, 0.84], [0.765, 0.80], [0.83, 0.72], [0.8675, 0.60], [0.866, 0.46], [0.845, 0.33], [0.80, 0.25], [0.74, 0.20], [0.64, 0.158], [0.40, 0.142], [0, 0.140]],
      greenhouse: screenFR(0.54, 1.185, 0.64, 0.82),
      softTop: [[0, 1.235], [0.38, 1.226], [0.56, 1.20, 1], [0.56, 1.17, 1], [0, 1.175]],
      bumper: [[0, 0.598], [0.34, 0.615], [0.62, 0.635], [0.80, 0.62], [0.855, 0.50], [0.84, 0.34], [0.795, 0.255], [0.735, 0.198], [0.62, 0.163], [0, 0.152]],
      // five-sided mouth: wide flat top (y 0.50, z ±0.41), chamfered upper corners, sides converging to a
      // ±0.30 bottom at y 0.20
      grille: [rpoly([[0, 0.46, 0], [0.41, 0.46, 0.025], [0.45, 0.415, 0.03], [0.33, 0.20, 0.05], [-0.33, 0.20, 0.05], [-0.45, 0.415, 0.03], [-0.41, 0.46, 0.025]])],
      grilleStyle: { mesh: 'fine-honeycomb', tone: 'dark' },
      // no round lower openings on the ND: body-coloured lower bumper with a thin black slot rising 8° outboard
      intakes: pair(blob([[0.54, 0.212, 1], [0.712, 0.236, 1], [0.716, 0.262, 1], [0.54, 0.238, 1]])),
      // narrow "eye": pointed inner tip at z 0.50, upper lid arching up then curving down to the outer corner
      headlight: [[0.50, 0.640, 1], [0.58, 0.690], [0.68, 0.727], [0.77, 0.737], [0.832, 0.722], [0.853, 0.692, 1], [0.842, 0.656], [0.76, 0.632], [0.62, 0.626], [0.545, 0.630]],
      drl: pair(ribbon([[0.525, 0.652], [0.60, 0.692], [0.69, 0.720], [0.77, 0.727], [0.825, 0.713]], 0.008))   // continuous upper-lid LED stroke
        .concat(pair(annulus(0.70, 0.676, 0.036, 0.008))),                                     // LED projector ring
      splitter: [[0, 0.165], [0.40, 0.165], [0.60, 0.170, 1], [0.60, 0.152, 1], [0, 0.150]],
      plateArea: rrect(-0.24, 0.225, 0.24, 0.330, 0.01),
      badgeArea: ellipse(0, 0.515, 0.045, 0.028),
      badgeText: 'MAZDA',
      // bonnet leading edge dips to 0.70 between the raised fender crests (the ND's head-on signature)
      panelLines: [open([[-0.70, 0.83], [-0.58, 0.772], [-0.36, 0.718], [0, 0.70], [0.36, 0.718], [0.58, 0.772], [0.70, 0.83]])],
      characterLines: pair(open([[0.46, 0.742], [0.58, 0.772], [0.64, 0.815], [0.66, 0.843]]))
    },
    rear: {
      body: [[0, 0.882], [0.48, 0.876], [0.72, 0.85], [0.815, 0.80], [0.855, 0.72], [0.8675, 0.58], [0.862, 0.42], [0.835, 0.31], [0.79, 0.24], [0.74, 0.20], [0.64, 0.166], [0, 0.152]],
      greenhouse: screenFR(0.54, 1.185, 0.64, 0.82),
      softTop: [[0, 1.235], [0.40, 1.222], [0.60, 1.15], [0.66, 0.92, 1], [0.66, 0.88, 1], [0, 0.88]],
      bumper: [[0, 0.580], [0.50, 0.580], [0.74, 0.570], [0.835, 0.52], [0.858, 0.44], [0.838, 0.32], [0.79, 0.245], [0.735, 0.198], [0.62, 0.166], [0, 0.158]],
      taillight: [[0.375, 0.765, 1], [0.455, 0.805], [0.615, 0.822], [0.765, 0.816], [0.823, 0.785], [0.81, 0.735], [0.675, 0.71], [0.495, 0.718], [0.395, 0.738]],
      lightBar: undefined,
      diffuser: [[0, 0.300], [0.40, 0.300], [0.60, 0.285], [0.665, 0.215], [0.60, 0.165], [0, 0.160]],
      exhaust: [{ shape: 'round', cx: 0.47, cy: 0.225, w: 0.085, h: 0.085 }, { shape: 'round', cx: -0.47, cy: 0.225, w: 0.085, h: 0.085 }],
      plateArea: rrect(-0.26, 0.40, 0.26, 0.53, 0.012),                    // in the bumper recess
      panelLines: [open([[-0.80, 0.64], [-0.40, 0.648], [0, 0.65], [0.40, 0.648], [0.80, 0.64]])],   // boot lid lower edge on the flat face
      badgeArea: ellipse(0, 0.755, 0.05, 0.03),
      badgeText: 'MAZDA',
      spoiler: undefined,
      rollHoops: pair(open([[0.14, 0.88], [0.16, 1.02], [0.25, 1.06], [0.34, 1.02], [0.37, 0.88]]))
    },
    details: function (side, top, front, rear) {
      return [
        D('side', 'mirror', blob([[0.43, 0.835, 1], [0.40, 0.905], [0.31, 0.92], [0.26, 0.885], [0.30, 0.845, 1]]), 'body'),
        D('side', 'handle', rrect(-0.50, 0.745, -0.39, 0.765, 0.008), 'body'),
        D('side', 'fuelCap', ellipse(-1.30, 0.735, 0.055, 0.055), 'body'),
        D('side', 'light', blob([[1.903, 0.52, 1], [1.872, 0.608], [1.79, 0.664], [1.66, 0.699], [1.615, 0.70, 1], [1.66, 0.655], [1.76, 0.61], [1.85, 0.56]]), 'light'),
        D('side', 'sideMarker', rrect(1.74, 0.42, 1.83, 0.445, 0.01), 'light-amber'),
        D('side', 'taillight', blob([[-1.952, 0.852, 1], [-1.80, 0.846], [-1.73, 0.822], [-1.80, 0.806], [-1.976, 0.812, 1]]), 'light-red'),   // tip kicks up at the tail
        D('side', 'reflector', rrect(-1.97, 0.40, -1.90, 0.43, 0.008), 'light-red'),
        D('side', 'exhaust', rrect(-1.98, 0.20, -1.90, 0.25, 0.02), 'chrome'),
        D('side', 'trim', ribbon([[0.48, 0.817], [-0.2, 0.842], [-0.69, 0.857]], 0.012), 'black'),
        D('top', 'wiper', ribbon([[0.40, 0.42], [0.32, 0.05]], 0.012), 'black'),
        D('top', 'wiper', ribbon([[0.40, -0.05], [0.32, -0.42]], 0.012), 'black'),
        D('top', 'rollHoop', rrect(-1.20, 0.12, -1.00, 0.36, 0.035), 'black'),
        D('top', 'rollHoop', rrect(-1.20, -0.36, -1.00, -0.12, 0.035), 'black'),
        D('front', 'mirror', frMirror(0.70, 0.96, 0.85, 0.93), 'body'),
        D('front', 'mirror', mirror(frMirror(0.70, 0.96, 0.85, 0.93), 0), 'body'),
        D('rear', 'mirror', frMirror(0.70, 0.96, 0.85, 0.93), 'body'),
        D('rear', 'mirror', mirror(frMirror(0.70, 0.96, 0.85, 0.93), 0), 'body'),
        // twin LED rings: dark lamp interior + thin glowing ring (r 0.05, 0.006 stroke)
        D('rear', 'lampInterior', ellipse(0.555, 0.767, 0.047, 0.047), 'gloss-black'),
        D('rear', 'lampInterior', ellipse(0.705, 0.769, 0.047, 0.047), 'gloss-black'),
        D('rear', 'lampInterior', ellipse(-0.555, 0.767, 0.047, 0.047), 'gloss-black'),
        D('rear', 'lampInterior', ellipse(-0.705, 0.769, 0.047, 0.047), 'gloss-black'),
        D('rear', 'light', annulus(0.555, 0.767, 0.05, 0.006), 'light-red'),
        D('rear', 'light', annulus(0.705, 0.769, 0.05, 0.006), 'light-red'),
        D('rear', 'light', annulus(-0.555, 0.767, 0.05, 0.006), 'light-red'),
        D('rear', 'light', annulus(-0.705, 0.769, 0.05, 0.006), 'light-red'),
        D('rear', 'reflector', rrect(0.70, 0.36, 0.80, 0.385, 0.01), 'light-red'),
        D('rear', 'reflector', rrect(-0.80, 0.36, -0.70, 0.385, 0.01), 'light-red'),
        D('rear', 'trim', rrect(-0.12, 0.882, 0.12, 0.895, 0.006), 'light-red')         // high-mount stop lamp on deck
      ];
    },
    signature: {
      headlights: 'Slim, sharply drawn LED "eyes" set into the fender crests, pointed inner corner, LED projector ring and upper DRL strip',
      taillights: 'Horizontal teardrop lamps at the tail corners with twin circular LED rings',
      grille: 'Wide, low trapezoidal grille mouth with a thin brightwork lip — the Kodo "smile"',
      notes: 'Fenders crest above a low bonnet; strong sweep from the front fender down through the door into the sill; short overhangs; twin round tailpipes at the corners'
    },
    sources: ['Mazda USA 2016 MX-5 spec sheet', 'roadster.blog ND Skyactiv body (overhang reductions vs NC)']
  });

  /* ================================================================== BMW Z4 G29
     M40i: 4324 × 1864 × 1304 mm, wheelbase 2470, track 1594/1589, overhangs 907/947,
     255/35R19 + 275/35R19 staggered. Wide mesh kidney grille, vertically stacked LED
     headlamps, "Air Breather" behind the front wheel feeding a rising character line,
     long bonnet with power dome, integrated ducktail, slim wrap-around L-shaped lamps. */
  // G29 kidneys: flat top edge (r 0.02), near-square lower outer corner (r 0.06), wider than tall
  var Z4_KIDNEY_PTS = [[0.025, 0.64, 0.02], [0.292, 0.64, 0.02], [0.312, 0.57, 0.03], [0.306, 0.44, 0.06], [0.065, 0.44, 0.03], [0.025, 0.468, 0.02]];
  var Z4_KIDNEY = rpoly(Z4_KIDNEY_PTS);
  var Z4_SURROUND = rpoly([[0.010, 0.656, 0.03], [0.302, 0.656, 0.03], [0.328, 0.572, 0.04], [0.321, 0.424, 0.07], [0.058, 0.424, 0.04], [0.010, 0.458, 0.03]])
    .concat(rpoly(Z4_KIDNEY_PTS.slice().reverse()));                       // ring: outer minus kidney
  var Z4_TAIL_IN = blob([[0.37, 0.874, 1], [0.48, 0.898], [0.66, 0.909], [0.84, 0.908], [0.895, 0.892], [0.903, 0.86], [0.901, 0.826, 1], [0.887, 0.822], [0.876, 0.846], [0.84, 0.856], [0.72, 0.862], [0.50, 0.865], [0.38, 0.870]]);
  var z4 = makeModel({
    id: 'bmw-z4-g29', make: 'BMW', name: 'Z4 M40i', gen: 'G29', years: '2019–',
    look: { head: 'slim-led', tail: 'slim', grille: 'kidney' },   // renderer lamp / grille signature
    enginePosition: 'front', drivetrain: 'rwd', powertrain: 'ice',
    ref: { length: 4.324, width: 1.864, height: 1.304, wheelbase: 2.470, trackF: 1.594, trackR: 1.589,
      frontOverhang: 0.907, rearOverhang: 0.947, wheelDiameter_in: 19, tireF: '255/35R19', tireR: '275/35R19',
      groundClearance: 0.114, rideHeight: 0.125, cd: 0.31, curbWeight_kg: 1535 },
    archGap: 0.036, flare: 0.016, screenFramePaint: 'gloss-black',
    loft: { screenBase: [0.20, 0.917], waist: 0.50, crest: 0.80, tubDepth: 0.34, dipF: 0.045, dipR: 0.03,
      hoop: { x0: -1.24, x1: -1.40, y: 1.085, z0: 0.14, z1: 0.40 },
      carves: [{ x0: 0.85, x1: 0.60, y0: 0.575, y1: 0.665, d: 0.015 }] },   // Air Breather
    side: {
      top: [[2.04, 0.172], [2.10, 0.212], [2.13, 0.30], [2.141, 0.40], [2.142, 0.48], [2.138, 0.57], [2.128, 0.625], [2.10, 0.663],
        [2.03, 0.705], [1.90, 0.748], [1.65, 0.795], [1.28, 0.835], [0.90, 0.865], [0.50, 0.895], [0.18, 0.918], [-0.40, 0.935], [-1.00, 0.950], [-1.45, 0.962],
        [-1.85, 0.968], [-1.95, 0.970], [-2.06, 0.980], [-2.14, 0.992], [-2.18, 1.000, 1], [-2.177, 0.966, 1], [-2.152, 0.950],   // ducktail kick-up + lip
        [-2.168, 0.88], [-2.180, 0.70], [-2.182, 0.56], [-2.172, 0.43], [-2.142, 0.33], [-2.10, 0.275], [-2.06, 0.25],
        [-1.98, 0.226], [-1.90, 0.212]],
      front: [[1.78, 0.18], [1.95, 0.172]],
      edgeF: 0.20, edgeR: 0.205, sillY: 0.128,
      greenhouse: rpoly([[0.20, 0.917, 0], [-0.405, 1.262, 0.008], [-0.47, 1.262, 0.008], [-0.427, 1.229, 0], [-0.33, 1.176, 0.01], [-0.79, 1.119, 0.10], [-0.85, 0.955, 0], [-0.45, 0.940, 0]]),
      windshield: [[0.20, 0.917, 1], [-0.405, 1.262, 1], [-0.465, 1.262, 1], [0.10, 0.925, 1]],
      // frameless door glass: top edge falls 0.055 m rearward, rear edge raked 15 deg, 0.10 m top-rear radius
      windows: [rpoly([[0.07, 0.945, 0], [-0.32, 1.170, 0.012], [-0.79, 1.115, 0.10], [-0.85, 0.955, 0], [-0.45, 0.948, 0]])],
      pillars: [[[0.20, 0.917, 1], [-0.405, 1.262, 1], [-0.47, 1.262, 1], [-0.42, 1.228, 1], [0.07, 0.945, 1]]],
      rollHoops: [[[-1.24, 0.955, 1], [-1.26, 1.06], [-1.32, 1.085], [-1.38, 1.06], [-1.40, 0.958, 1]]],
      softTop: [[-0.405, 1.262, 1], [-0.58, 1.296], [-0.80, 1.304], [-1.08, 1.278], [-1.34, 1.18], [-1.55, 1.05], [-1.66, 0.972, 1], [-1.12, 0.95, 1]],
      doorCuts: [[[0.46, 0.900], [0.47, 0.62], [0.50, 0.36], [0.54, 0.15]], [[-0.88, 0.948], [-0.89, 0.62], [-0.90, 0.35], [-0.91, 0.135]]],
      panelLines: [
        [[2.10, 0.655], [1.95, 0.712], [1.60, 0.775], [1.20, 0.818], [0.80, 0.858], [0.32, 0.900]],  // clamshell bonnet edge
        [[2.02, 0.63], [1.98, 0.52], [1.94, 0.44], [1.88, 0.40]],                         // bumper / fender seam
        [[-1.68, 0.972], [-1.95, 0.985], [-2.12, 0.99]],                                   // boot lid
        [[-2.06, 0.94], [-1.98, 0.75], [-1.88, 0.58], [-1.62, 0.53]]],                     // rear bumper seam
      characterLines: [
        [[0.62, 0.635], [0.10, 0.665], [-0.60, 0.715], [-1.20, 0.775], [-1.70, 0.815], [-2.05, 0.835]], // rises from the Air Breather to the tail lamp
        [[0.80, 0.44], [0.30, 0.37], [-0.25, 0.345], [-0.70, 0.40], [-0.86, 0.47]]],     // concave lower door sweep
      sill: [[0.83, 0.20, 1], [0.83, 0.128, 1], [-0.83, 0.128, 1], [-0.83, 0.20, 1]],
      lowerTrim: [[[0.84, 0.20, 1], [0.82, 0.128, 1], [-0.83, 0.128, 1], [-0.85, 0.20, 1], [-0.20, 0.19]],
        [[1.78, 0.18, 1], [2.00, 0.176], [2.05, 0.17], [2.02, 0.16, 1], [1.78, 0.165, 1]]]
    },
    top: {
      body: [[2.142, 0], [2.13, 0.22], [2.09, 0.42], [2.00, 0.60], [1.82, 0.79], [1.52, 0.902], [1.235, 0.932], [0.90, 0.922],
        [0.30, 0.900], [-0.30, 0.897], [-0.90, 0.922], [-1.235, 0.940], [-1.60, 0.929], [-1.80, 0.912], [-1.932, 0.891],
        [-2.022, 0.816], [-2.102, 0.666], [-2.150, 0.45], [-2.176, 0.22], [-2.182, 0]],   // rear corner rolled over 0.25 m
      greenhouse: [[0.20, 0.71], [-0.10, 0.68], [-0.41, 0.60, 1], [-0.41, -0.60, 1], [-0.10, -0.68], [0.20, -0.71], [0.23, 0]],
      cockpit: rpoly([[-0.41, 0.60, 0], [-0.80, 0.675, 0.6], [-1.13, 0.65, 0.12], [-1.24, 0.0, 0.25], [-1.13, -0.65, 0.12], [-0.80, -0.675, 0.6], [-0.41, -0.60, 0]]),
      hood: [[2.06, 0.34], [1.82, 0.62], [1.10, 0.70], [0.22, 0.70, 1], [0.22, -0.70, 1], [1.10, -0.70], [1.82, -0.62], [2.06, -0.34], [2.10, 0]],
      roof: [[-0.405, 0.65, 1], [-1.00, 0.69], [-1.60, 0.70, 1], [-1.60, -0.70, 1], [-1.00, -0.69], [-0.405, -0.65, 1]],
      deck: [[-1.62, 0.76, 1], [-1.90, 0.76], [-2.14, 0.58], [-2.16, 0], [-2.14, -0.58], [-1.90, -0.76], [-1.62, -0.76, 1]],
      mirror: [[0.16, 0.90, 1], [0.13, 1.045], [0.03, 1.06], [0.00, 0.98], [0.03, 0.89, 1]],
      // two bonnet creases converging toward the kidneys
      characterLines: pair(open([[0.30, 0.36], [0.90, 0.32], [1.50, 0.26], [1.95, 0.20]]), 1)
    },
    front: {
      body: [[0, 0.975], [0.50, 0.97], [0.74, 0.942], [0.855, 0.875], [0.91, 0.77], [0.932, 0.63], [0.930, 0.48], [0.905, 0.33], [0.86, 0.25], [0.80, 0.20], [0.70, 0.152], [0.50, 0.13], [0, 0.128]],
      greenhouse: screenFR(0.58, 1.262, 0.71, 0.92),
      softTop: [[0, 1.304], [0.40, 1.296], [0.60, 1.27, 1], [0.60, 1.24, 1], [0, 1.245]],
      bumper: [[0, 0.590], [0.36, 0.585], [0.56, 0.590], [0.86, 0.60], [0.912, 0.50], [0.897, 0.33], [0.855, 0.25], [0.80, 0.20], [0.70, 0.156], [0, 0.140]],
      grille: pair(Z4_KIDNEY),                                       // mesh fill (surround drawn as a ring detail)
      // outer intakes: trapezoids leaning up toward the outside, one horizontal blade; central lower intake; air curtains
      intakes: pair(blob([[0.42, 0.22, 1], [0.79, 0.232, 1], [0.85, 0.30, 1], [0.868, 0.45, 1], [0.50, 0.42, 1]]))
        .concat([symFR([[0, 0.365], [0.24, 0.362], [0.335, 0.335], [0.35, 0.26], [0.30, 0.200], [0, 0.192]])])
        .concat(pair(blob([[0.874, 0.34, 1], [0.889, 0.345, 1], [0.893, 0.46, 1], [0.878, 0.465, 1]]))),   // air-curtain slots
      // upright stacked lamp 0.25 × 0.22 m: inner edge leaning ~20° (z 0.60 at the bottom → 0.68 at the top),
      // top edge rising 15° toward the vertical outer edge at z 0.85
      // inner corner reaches in to z 0.47 at kidney-top height (y 0.645): the G29 "look" toward the grille
      headlight: rpoly([[0.47, 0.648, 0.015], [0.60, 0.712, 0.04], [0.68, 0.775, 0.03], [0.85, 0.82, 0.035], [0.853, 0.64, 0.04], [0.72, 0.606, 0.2], [0.50, 0.618, 0.015]]),
      drl: pairItem({ path: rpoly([[0.492, 0.646, 0.012], [0.612, 0.706, 0.035], [0.69, 0.765, 0.025], [0.836, 0.803, 0.03], [0.839, 0.651, 0.035], [0.72, 0.62, 0.18], [0.51, 0.628, 0.012]]),
        paint: 'gloss-black', role: 'lampInterior' })                                                 // dark lamp interior
        .concat(pair(ribbon([[0.70, 0.752], [0.77, 0.770], [0.832, 0.788]], 0.010)))                 // upper LED stroke, follows the top edge
        .concat(pair(ribbon([[0.52, 0.634], [0.64, 0.636], [0.73, 0.659], [0.825, 0.690]], 0.010))),                // lower LED stroke rising 16° outboard
      splitter: [[0, 0.150], [0.50, 0.150], [0.68, 0.158, 1], [0.68, 0.142, 1], [0, 0.135]],
      plateArea: rrect(-0.26, 0.245, 0.26, 0.345, 0.01),
      badgeArea: ellipse(0, 0.700, 0.035, 0.035),
      badgeText: 'BMW',
      panelLines: [open([[-0.885, 0.845], [-0.70, 0.80], [-0.50, 0.722], [-0.25, 0.675], [0, 0.664], [0.25, 0.675], [0.50, 0.722], [0.70, 0.80], [0.885, 0.845]])]
    },
    rear: {
      body: [[0, 1.000], [0.54, 0.995], [0.78, 0.97], [0.88, 0.93], [0.922, 0.86], [0.932, 0.70], [0.926, 0.48], [0.90, 0.33], [0.855, 0.245], [0.80, 0.20], [0.70, 0.163], [0, 0.150]],
      greenhouse: screenFR(0.58, 1.262, 0.71, 0.92),
      softTop: [[0, 1.304], [0.42, 1.29], [0.64, 1.20], [0.72, 1.00, 1], [0.72, 0.97, 1], [0, 0.97]],
      // straight horizontal bumper crease at 0.62 running out to the corners (no bulge)
      bumper: [[0, 0.620], [0.45, 0.620, 1], [0.80, 0.620, 1], [0.872, 0.610], [0.912, 0.56], [0.91, 0.42], [0.888, 0.31], [0.855, 0.252], [0.80, 0.205], [0.70, 0.17], [0, 0.160]],
      taillight: [[0.345, 0.878, 1], [0.48, 0.906], [0.66, 0.918], [0.84, 0.917], [0.905, 0.900], [0.916, 0.862], [0.914, 0.812, 1], [0.884, 0.806], [0.872, 0.836], [0.84, 0.848], [0.72, 0.854], [0.50, 0.857], [0.36, 0.866]],
      lightBar: undefined,
      diffuser: [[0, 0.300], [0.44, 0.300, 1], [0.70, 0.300, 1], [0.745, 0.19], [0.66, 0.152], [0, 0.150]],   // separate lower diffuser 0.15–0.30
      exhaust: [{ shape: 'round', cx: 0.53, cy: 0.235, w: 0.10, h: 0.10 }, { shape: 'round', cx: -0.53, cy: 0.235, w: 0.10, h: 0.10 }],
      plateArea: rrect(-0.26, 0.44, 0.26, 0.57, 0.012),
      badgeArea: ellipse(0, 0.815, 0.04, 0.04),
      badgeText: 'BMW',
      spoiler: symFR([[0, 1.000], [0.60, 0.996], [0.76, 0.975, 1], [0.70, 0.962], [0, 0.966]]),
      rollHoops: pair(open([[0.16, 0.97], [0.18, 1.06], [0.28, 1.085], [0.38, 1.06], [0.40, 0.97]]))
    },
    details: function () {
      return [
        D('side', 'mirror', blob([[0.17, 0.93, 1], [0.13, 1.005], [0.02, 1.02], [-0.03, 0.98], [0.02, 0.935, 1]]), 'body'),
        D('side', 'handle', rrect(-0.64, 0.835, -0.52, 0.85, 0.007), 'body'),
        D('side', 'vent', blob([[0.87, 0.592, 1], [0.76, 0.660], [0.57, 0.665, 1], [0.66, 0.625], [0.78, 0.578]]), 'gloss-black'),  // Air Breather 0.30 x 0.09
        D('side', 'fuelCap', rrect(-1.52, 0.70, -1.40, 0.79, 0.02), 'body'),
        D('side', 'light', blob([[2.132, 0.598, 1], [2.105, 0.640], [2.03, 0.674], [1.92, 0.706], [1.76, 0.742], [1.60, 0.766, 1], [1.70, 0.733], [1.86, 0.690], [1.98, 0.648], [2.07, 0.612], [2.12, 0.578]]), 'light'),   // long lamp under the bonnet edge
        D('side', 'taillight', blob([[-2.15, 0.955, 1], [-2.00, 0.948], [-1.88, 0.93], [-1.95, 0.905], [-2.165, 0.90, 1]]), 'light-red'),
        D('side', 'reflector', rrect(-2.180, 0.36, -2.160, 0.46, 0.008), 'light-red'),
        D('side', 'exhaust', rrect(-2.19, 0.19, -2.10, 0.26, 0.03), 'chrome'),
        D('side', 'trim', ribbon([[0.20, 0.919], [-0.45, 0.938], [-0.885, 0.946]], 0.012), 'black'),
        D('top', 'wiper', ribbon([[0.12, 0.46], [0.02, 0.06]], 0.012), 'black'),
        D('top', 'wiper', ribbon([[0.12, -0.06], [0.02, -0.46]], 0.012), 'black'),
        D('top', 'rollHoop', rrect(-1.39, 0.14, -1.25, 0.40, 0.035), 'black'),
        D('top', 'rollHoop', rrect(-1.39, -0.40, -1.25, -0.14, 0.035), 'black'),
        D('front', 'mirror', frMirror(0.78, 1.01, 0.935, 1.015), 'body'),
        D('front', 'mirror', mirror(frMirror(0.78, 1.01, 0.935, 1.015), 0), 'body'),
        // chrome kidney surrounds as rings (outer outline minus the kidney) so the mesh stays visible
        D('front', 'trim', Z4_SURROUND, 'chrome'),
        D('front', 'trim', mirror(Z4_SURROUND, 0), 'chrome'),
        D('front', 'trim', ribbon([[0.47, 0.33], [0.68, 0.338], [0.87, 0.345]], 0.016), 'gloss-black'),   // intake blade
        D('front', 'trim', ribbon([[-0.47, 0.33], [-0.68, 0.338], [-0.87, 0.345]], 0.016), 'gloss-black'),
        D('rear', 'mirror', frMirror(0.78, 1.01, 0.935, 1.015), 'body'),
        D('rear', 'mirror', mirror(frMirror(0.78, 1.01, 0.935, 1.015), 0), 'body'),
        D('rear', 'lampInterior', Z4_TAIL_IN, 'gloss-black'),                                           // smoked lens interior
        D('rear', 'lampInterior', mirror(Z4_TAIL_IN, 0), 'gloss-black'),
        D('rear', 'light', ribbon([[0.42, 0.876], [0.60, 0.893], [0.80, 0.896], [0.872, 0.890], [0.897, 0.874], [0.904, 0.85], [0.903, 0.826]], 0.013), 'light-red'),   // L-graphic, outer leg wraps down
        D('rear', 'light', ribbon([[-0.42, 0.876], [-0.60, 0.893], [-0.80, 0.896], [-0.872, 0.890], [-0.897, 0.874], [-0.904, 0.85], [-0.903, 0.826]], 0.013), 'light-red'),
        D('rear', 'trim', ribbon([[-0.74, 0.951], [-0.40, 0.957], [0, 0.958], [0.40, 0.957], [0.74, 0.951]], 0.02), 'gloss-black'),   // shadow line under the ducktail
        D('rear', 'reflector', rrect(0.85, 0.34, 0.878, 0.52, 0.012), 'light-red'),
        D('rear', 'reflector', rrect(-0.878, 0.34, -0.85, 0.52, 0.012), 'light-red')
      ];
    },
    signature: {
      headlights: 'Vertically stacked LED headlamps (two light elements one above the other) sweeping back over the fenders',
      taillights: 'Slim wrap-around tail lamps with an L-shaped light graphic tucked under the integrated ducktail',
      grille: 'Wide kidney grille with mesh inserts and chrome surrounds, kidneys wider than tall; large outer intakes with air-curtain slots',
      notes: 'Very long bonnet with power dome, cockpit set far back; Air Breather vent behind the front wheel launching a rising character line; vertical rear reflectors; twin round tailpipes'
    },
    sources: ['auto-data.net BMW Z4 (G29) M40i technical data', 'BMW UK M40i technical data']
  });

  /* ======================================================== PORSCHE 718 BOXSTER 982
     4379 × 1801 × 1281 mm, wheelbase 2475, track 1515/1532, 235/45R18 + 265/45R18.
     Mid-engine: low front lid between raised headlamp fenders, upright headlamps with
     four-point LED DRL, three-intake front apron with slim position-light blades, big
     side intakes ahead of the rear wheels fed by a rising door crease, deck with
     pop-up spoiler, slim tail lamps joined by a black bar carrying the lettering. */
  var boxster = makeModel({
    id: 'porsche-718-boxster-982', make: 'Porsche', name: '718 Boxster', gen: '982', years: '2016–',
    look: { head: 'oval-4pt', tail: 'light-bar', grille: 'slats' },   // renderer lamp / grille signature
    enginePosition: 'mid', drivetrain: 'rwd', powertrain: 'ice',
    ref: { length: 4.379, width: 1.801, height: 1.281, wheelbase: 2.475, trackF: 1.515, trackR: 1.532,
      frontOverhang: 0.957, rearOverhang: 0.947, wheelDiameter_in: 18, tireF: '235/45R18', tireR: '265/45R18',
      groundClearance: 0.110, rideHeight: 0.120, cd: 0.31, curbWeight_kg: 1335 },
    archGap: 0.034, flare: 0.014,
    loft: { screenBase: [0.37, 0.855], waist: 0.50, crest: 0.80, tubDepth: 0.34, dipF: 0.065, dipR: 0.03,
      hoop: { x0: -1.16, x1: -1.36, y: 1.08, z0: 0.16, z1: 0.40, tail: -1.55 },
      carves: [{ x0: -0.58, x1: -0.85, y0: 0.45, y1: 0.70, d: 0.03 }] },   // side air intake
    side: {
      top: [[2.13, 0.170], [2.17, 0.20], [2.187, 0.28], [2.1945, 0.37], [2.19, 0.47], [2.176, 0.53], [2.148, 0.585], [2.08, 0.672],
        [1.96, 0.738], [1.84, 0.772], [1.70, 0.797], [1.50, 0.811], [1.24, 0.814], [1.00, 0.806], [0.80, 0.808], [0.62, 0.82],   // fender crest over the axle
        [0.40, 0.835], [0.20, 0.868], [-0.30, 0.888], [-0.85, 0.928],
        [-1.30, 0.972], [-1.75, 0.976], [-2.08, 0.966], [-2.168, 0.960, 1], [-2.163, 0.915], [-2.178, 0.76],
        [-2.1845, 0.58], [-2.176, 0.44], [-2.145, 0.34], [-2.11, 0.285], [-2.07, 0.25], [-1.99, 0.222], [-1.90, 0.205]],   // undercut
      front: [[1.80, 0.175], [1.98, 0.168]],
      edgeF: 0.20, edgeR: 0.205, sillY: 0.122,
      greenhouse: rpoly([[0.37, 0.855, 0], [-0.50, 1.242, 0.008], [-0.58, 1.242, 0.008], [-0.527, 1.206, 0], [-0.38, 1.156, 0.01], [-0.79, 1.099, 0.10], [-0.85, 0.922, 0], [-0.40, 0.893, 0]]),
      windshield: [[0.37, 0.855, 1], [-0.50, 1.242, 1], [-0.565, 1.242, 1], [0.27, 0.862, 1]],
      // frameless door glass: top edge falls 0.055 m rearward, rear edge raked 15 deg, 0.10 m top-rear radius
      windows: [rpoly([[0.24, 0.885, 0], [-0.373, 1.150, 0.012], [-0.79, 1.095, 0.10], [-0.85, 0.922, 0], [-0.40, 0.902, 0]])],
      pillars: [[[0.37, 0.855, 1], [-0.50, 1.242, 1], [-0.58, 1.242, 1], [-0.52, 1.205, 1], [0.24, 0.885, 1]]],
      rollHoops: [[[-1.16, 0.95, 1], [-1.18, 1.055], [-1.26, 1.08], [-1.34, 1.055], [-1.36, 0.965, 1]]],
      softTop: [[-0.50, 1.242, 1], [-0.68, 1.275], [-0.90, 1.281], [-1.15, 1.255], [-1.40, 1.17], [-1.66, 1.05], [-1.86, 0.976, 1], [-1.12, 0.93, 1]],
      doorCuts: [[[0.52, 0.818], [0.535, 0.60], [0.56, 0.36], [0.60, 0.13]], [[-0.55, 0.902], [-0.555, 0.70], [-0.55, 0.40], [-0.56, 0.13]]],
      panelLines: [
        [[2.06, 0.572], [1.95, 0.625], [1.62, 0.695], [1.00, 0.75], [0.52, 0.80]],         // front lid edge (between fenders)
        [[2.06, 0.58], [2.02, 0.48], [1.97, 0.40], [1.90, 0.36]],                           // bumper / fender seam
        [[-1.86, 0.976], [-2.05, 0.968], [-2.16, 0.960]],                                     // rear lid / spoiler
        [[-2.08, 0.93], [-2.00, 0.76], [-1.90, 0.60], [-1.66, 0.54]]],                       // rear bumper seam
      characterLines: [
        [[0.50, 0.40], [0.15, 0.43], [-0.20, 0.53], [-0.55, 0.66]],                          // door crease rising into intake
        [[-0.70, 0.78], [-1.10, 0.87], [-1.55, 0.925], [-2.05, 0.94]]],                      // rear shoulder
      sill: [[0.84, 0.195, 1], [0.84, 0.122, 1], [-0.84, 0.122, 1], [-0.84, 0.195, 1]],
      lowerTrim: [[[1.80, 0.175, 1], [2.13, 0.170], [2.10, 0.155, 1], [1.80, 0.158, 1]], [[-1.90, 0.185, 1], [-2.03, 0.195], [-1.99, 0.17, 1], [-1.70, 0.18, 1]]]
    },
    top: {
      body: [[2.1945, 0], [2.18, 0.25], [2.13, 0.46], [2.03, 0.635], [1.82, 0.795], [1.52, 0.882], [1.2375, 0.896], [0.90, 0.882],
        [0.40, 0.868], [-0.30, 0.864], [-0.80, 0.884], [-1.2375, 0.906], [-1.70, 0.894], [-1.85, 0.88], [-1.9345, 0.862],
        [-2.0245, 0.789], [-2.1045, 0.644], [-2.155, 0.44], [-2.178, 0.22], [-2.1845, 0]],   // rear corner rolled over 0.25 m
      greenhouse: [[0.37, 0.67], [0.00, 0.64], [-0.50, 0.58, 1], [-0.50, -0.58, 1], [0.00, -0.64], [0.37, -0.67], [0.40, 0]],
      cockpit: rpoly([[-0.50, 0.58, 0], [-0.82, 0.645, 0.6], [-1.08, 0.62, 0.12], [-1.18, 0.0, 0.25], [-1.08, -0.62, 0.12], [-0.82, -0.645, 0.6], [-0.50, -0.58, 0]]),
      hood: [[2.12, 0.32], [1.90, 0.52], [1.20, 0.56], [0.40, 0.64, 1], [0.40, -0.64, 1], [1.20, -0.56], [1.90, -0.52], [2.12, -0.32], [2.15, 0]],
      roof: [[-0.50, 0.61, 1], [-1.10, 0.65], [-1.86, 0.66, 1], [-1.86, -0.66, 1], [-1.10, -0.65], [-0.50, -0.61, 1]],
      deck: [[-1.30, 0.74, 1], [-1.80, 0.76], [-2.13, 0.60], [-2.16, 0], [-2.13, -0.60], [-1.80, -0.76], [-1.30, -0.74, 1]],
      mirror: [[0.27, 0.86, 1], [0.24, 1.00], [0.14, 1.02], [0.11, 0.94], [0.14, 0.855, 1]]
    },
    front: {
      // low front lid between the Porsche fender peaks; upper body tucked in, lower corners pulled in
      body: [[0, 0.86], [0.42, 0.866], [0.60, 0.90], [0.70, 0.96], [0.76, 0.977], [0.815, 0.955], [0.85, 0.885], [0.882, 0.78], [0.9005, 0.64], [0.896, 0.45], [0.875, 0.32], [0.835, 0.245], [0.78, 0.20], [0.68, 0.153], [0.50, 0.13], [0, 0.128]],
      greenhouse: screenFR(0.56, 1.242, 0.67, 0.855),
      softTop: [[0, 1.281], [0.38, 1.273], [0.57, 1.25, 1], [0.57, 1.22, 1], [0, 1.225]],
      bumper: [[0, 0.555], [0.30, 0.565], [0.44, 0.585], [0.55, 0.598], [0.80, 0.598], [0.868, 0.53], [0.884, 0.40], [0.872, 0.31], [0.835, 0.25], [0.78, 0.20], [0.68, 0.158], [0, 0.140]],
      grille: [symFR([[0, 0.335], [0.27, 0.332], [0.335, 0.30], [0.335, 0.225], [0.29, 0.19], [0, 0.182]])],
      intakes: pair(blob([[0.455, 0.44], [0.66, 0.458], [0.828, 0.448], [0.862, 0.37], [0.848, 0.285], [0.785, 0.228], [0.56, 0.215], [0.445, 0.29]])),
      // near-upright oval 0.24 × 0.215 m (y 0.613–0.828), turned 12° with the top leaning outboard
      headlight: oval(0.675, 0.7205, 0.118, 0.1055, -12),
      drl: pairItem({ path: oval(0.675, 0.7205, 0.104, 0.092, -12), paint: 'gloss-black', role: 'lampInterior' })   // dark lamp interior
        .concat([-1, 1].reduce(function (acc, sz) {                           // floating four-point DRL, 2x2, follows the lamp tilt
          [-1, 1].forEach(function (sy) {
            var zc = 0.675 + sz * 0.042, yc = 0.7205 + sy * 0.034;
            acc = acc.concat(pair(rot(rot(rrect(zc - 0.026, yc - 0.010, zc + 0.026, yc + 0.010, 0.008), zc, yc, 8), 0.675, 0.7205, -12)));
          });
          return acc;
        }, []))
        .concat(pair(rrect(0.55, 0.474, 0.825, 0.490, 0.008))),               // apron position-light blades
      splitter: [[0, 0.150], [0.45, 0.150], [0.64, 0.158, 1], [0.64, 0.142, 1], [0, 0.135]],
      plateArea: rrect(-0.26, 0.355, 0.26, 0.465, 0.01),
      badgeArea: ellipse(0, 0.635, 0.04, 0.03),
      badgeText: 'PORSCHE',
      // front-lid shut line dipping to 0.80 between the fenders; fender inner edges rising to the peaks
      panelLines: [open([[-0.66, 0.905], [-0.52, 0.85], [-0.28, 0.81], [0, 0.80], [0.28, 0.81], [0.52, 0.85], [0.66, 0.905]])],
      characterLines: pair(open([[0.52, 0.85], [0.62, 0.885], [0.70, 0.94], [0.745, 0.972]]))
    },
    rear: {
      body: [[0, 0.976], [0.48, 0.972], [0.74, 0.952], [0.85, 0.905], [0.89, 0.82], [0.9005, 0.68], [0.896, 0.50], [0.875, 0.34], [0.835, 0.255], [0.78, 0.205], [0.68, 0.172], [0, 0.158]],
      greenhouse: screenFR(0.56, 1.242, 0.67, 0.855),
      softTop: [[0, 1.281], [0.40, 1.27], [0.60, 1.19], [0.68, 0.99, 1], [0.68, 0.966, 1], [0, 0.966]],
      // bumper top edge runs dead straight at 0.60 between the reflectors, then rolls round the corners
      bumper: [[0, 0.600], [0.40, 0.600, 1], [0.78, 0.600, 1], [0.85, 0.586], [0.876, 0.555], [0.884, 0.52], [0.882, 0.42], [0.872, 0.34], [0.835, 0.26], [0.78, 0.208], [0.68, 0.176], [0, 0.165]],
      taillight: [[0.38, 0.866, 1], [0.55, 0.882], [0.74, 0.898], [0.84, 0.902], [0.874, 0.882, 1], [0.873, 0.815], [0.835, 0.794], [0.70, 0.812], [0.52, 0.828], [0.38, 0.836, 1]],
      lightBar: undefined,
      diffuser: [[0, 0.315], [0.40, 0.315], [0.62, 0.300], [0.69, 0.205], [0.60, 0.172], [0, 0.168]],
      exhaust: [{ shape: 'oval', cx: 0, cy: 0.265, w: 0.17, h: 0.075 }],
      plateArea: rrect(-0.26, 0.42, 0.26, 0.55, 0.012),
      badgeArea: rrect(-0.20, 0.838, 0.20, 0.862, 0.004),
      badgeText: 'PORSCHE',
      spoiler: symFR([[0, 0.962], [0.55, 0.960], [0.66, 0.948, 1], [0.60, 0.938], [0, 0.940]]),
      rollHoops: pair(open([[0.16, 0.97], [0.18, 1.06], [0.28, 1.08], [0.38, 1.06], [0.40, 0.97]]))
    },
    details: function () {
      return [
        D('side', 'mirror', blob([[0.36, 0.865, 1], [0.33, 0.94], [0.22, 0.955], [0.17, 0.92], [0.22, 0.87, 1]]), 'body'),
        D('side', 'handle', rrect(-0.30, 0.80, -0.18, 0.815, 0.007), 'black'),
        D('side', 'intake', blob([[-0.58, 0.70, 1], [-0.70, 0.703], [-0.80, 0.70], [-0.835, 0.67], [-0.845, 0.56], [-0.84, 0.45, 1], [-0.77, 0.462], [-0.66, 0.53], [-0.59, 0.64]]), 'black'),
        D('side', 'trim', ribbon([[-0.645, 0.56], [-0.75, 0.562], [-0.84, 0.56]], 0.014), 'gloss-black'),   // intake blade
        D('side', 'fuelCap', rrect(0.70, 0.745, 0.84, 0.79, 0.015), 'body'),
        D('side', 'light', blob([[2.14, 0.555, 1], [2.10, 0.625], [2.02, 0.688], [1.90, 0.740], [1.76, 0.778], [1.62, 0.800, 1], [1.72, 0.748], [1.86, 0.695], [1.98, 0.635], [2.08, 0.580]]), 'light'),   // long lamp riding on the fender top
        D('side', 'sideMarker', rrect(1.98, 0.43, 2.08, 0.45, 0.01), 'light-amber'),
        D('side', 'taillight', blob([[-2.165, 0.905, 1], [-2.00, 0.905], [-1.86, 0.89], [-1.95, 0.862], [-2.177, 0.855, 1]]), 'light-red'),
        D('side', 'exhaust', rrect(-2.18, 0.235, -2.12, 0.295, 0.02), 'chrome'),
        D('side', 'trim', ribbon([[0.37, 0.857], [-0.40, 0.890], [-0.885, 0.914]], 0.012), 'black'),
        D('top', 'wiper', ribbon([[0.30, 0.46], [0.20, 0.06]], 0.012), 'black'),
        D('top', 'wiper', ribbon([[0.30, -0.06], [0.20, -0.46]], 0.012), 'black'),
        // body-colour roll-hoop fairings: 0.18 m wide headrest heads tapering back into the rear deck at x -1.55
        D('top', 'fairing', blob([[-1.16, 0.28], [-1.175, 0.355], [-1.24, 0.37], [-1.36, 0.355], [-1.48, 0.315], [-1.55, 0.28, 1], [-1.48, 0.245], [-1.36, 0.205], [-1.24, 0.19], [-1.175, 0.205]]), 'body'),
        D('top', 'fairing', blob([[-1.16, -0.28], [-1.175, -0.205], [-1.24, -0.19], [-1.36, -0.205], [-1.48, -0.245], [-1.55, -0.28, 1], [-1.48, -0.315], [-1.36, -0.355], [-1.24, -0.37], [-1.175, -0.355]]), 'body'),
        D('top', 'rollHoop', rrect(-1.26, 0.20, -1.16, 0.36, 0.035), 'black'),       // headrest / hoop crown face
        D('top', 'rollHoop', rrect(-1.26, -0.36, -1.16, -0.20, 0.035), 'black'),
        D('top', 'light', ribbon([[-2.152, 0.25], [-2.162, 0], [-2.152, -0.25]], 0.014), 'light-red'),       // third brake light on spoiler edge
        D('top', 'light', blob([[2.11, 0.40], [2.02, 0.60], [1.90, 0.72], [1.82, 0.70], [1.92, 0.56], [2.05, 0.42]]), 'light'),
        D('top', 'light', blob([[2.11, -0.40], [2.05, -0.42], [1.92, -0.56], [1.82, -0.70], [1.90, -0.72], [2.02, -0.60]]), 'light'),
        D('front', 'mirror', frMirror(0.80, 0.995, 0.885, 0.962), 'body'),
        D('front', 'mirror', mirror(frMirror(0.80, 0.995, 0.885, 0.962), 0), 'body'),
        D('rear', 'mirror', frMirror(0.80, 0.995, 0.885, 0.962), 'body'),
        D('rear', 'mirror', mirror(frMirror(0.80, 0.995, 0.885, 0.962), 0), 'body'),
        D('rear', 'light', ribbon([[0.40, 0.851], [0.58, 0.861], [0.755, 0.871]], 0.010), 'light-red'),
        D('rear', 'light', ribbon([[-0.40, 0.851], [-0.58, 0.861], [-0.755, 0.871]], 0.010), 'light-red')
      ].concat([1, -1].reduce(function (acc, sz) {                             // four-point brake lights, 2x2 per lamp
        acc.push(D('rear', 'lampInterior', rrect(Math.min(sz * 0.775, sz * 0.865), 0.846, Math.max(sz * 0.775, sz * 0.865), 0.882, 0.008), 'gloss-black'));
        [0.80, 0.84].forEach(function (z) { [0.857, 0.871].forEach(function (y) {
          acc.push(D('rear', 'brakeLight', rrect(sz * z - 0.01, y - 0.006, sz * z + 0.01, y + 0.006, 0.004), 'light-red'));
        }); });
        return acc;
      }, []), [
        D('rear', 'vent', rrect(0.72, 0.25, 0.82, 0.40, 0.015), 'black'),
        D('rear', 'vent', rrect(-0.82, 0.25, -0.72, 0.40, 0.015), 'black'),
        D('rear', 'trim', rrect(-0.38, 0.835, 0.38, 0.865, 0.006), 'gloss-black'),         // black accent bar carrying the lettering, lamp to lamp
        D('rear', 'reflector', rrect(0.70, 0.566, 0.83, 0.584, 0.008), 'light-red'),       // reflectors at the ends of the straight bumper edge
        D('rear', 'reflector', rrect(-0.83, 0.566, -0.70, 0.584, 0.008), 'light-red'),
        D('rear', 'trim', rrect(-0.30, 0.946, 0.30, 0.956, 0.005), 'light-red')         // third brake light in the spoiler
      ]);
    },
    signature: {
      headlights: 'Upright oval LED headlamps set high in the front fenders with a floating four-point DRL',
      taillights: 'Slim tapered tail lamps linked by a black accent bar carrying the lettering and a three-dimensional light graphic',
      grille: 'No upper grille: three-intake front apron with slim position-light blades above the outer intakes',
      notes: 'Mid-engine proportions; front lid dips between raised fenders; door crease leads into large side air intake ahead of the rear wheel; pop-up rear spoiler; single central tailpipe'
    },
    sources: ['Porsche configurator 718 Boxster technical data', 'auto-data.net Porsche 718 Boxster (982)']
  });

  var MODELS = [mx5, z4, boxster];
  var api = CB.shapes;
  MODELS.forEach(function (m) {
    if (typeof api.registerModel === 'function') api.registerModel(m);
    else (api._pending = api._pending || []).push(m);
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = { models: MODELS, _helpers: { tireDia: tireDia } };
})();
