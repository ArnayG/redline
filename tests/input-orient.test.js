/* Node tests for sideways steering past 90 deg: js/input/orient.js (device-frame roll, orientation state machine,
   counter-rotation geometry) and js/input/tilt.js createSteer with a frozen reference (continuous through OS
   auto-rotations, +-90 and +-180 deg, flat phone, noise).  Run: node tests/run.js input-orient */
'use strict';
var path = require('path');
var root = path.join(__dirname, '..');
var AN = require(path.join(root, 'js/input/analog.js'));
var TL = require(path.join(root, 'js/input/tilt.js'));
var OR = require(path.join(root, 'js/input/orient.js'));
var DEG = Math.PI / 180;

/** beta / gamma a browser reports for a phone whose device-frame roll is r (0 = top up, -90 = top left), pitched back psi. */
function pose(r, psi) {
  var c = Math.cos((psi || 0) * DEG), ux = -Math.sin(r * DEG) * c, uy = Math.cos(r * DEG) * c, uz = Math.sin((psi || 0) * DEG);
  return { beta: Math.asin(uy) / DEG, gamma: Math.atan2(-ux, uz) / DEG, g: [ux * 9.81, uy * 9.81, uz * 9.81] };
}
function wrap(a) { return ((a + 180) % 360 + 360) % 360 - 180; }
/** what an auto-rotating OS shows for a device roll (nearest of portrait / both landscapes; no upside-down portrait) */
function osAngle(r, prev) {
  r = wrap(r);
  var cands = [[0, 0], [90, -90], [270, 90]], best = prev, bd = 1e9;
  cands.forEach(function (c) { var d = Math.abs(wrap(r - c[1])); if (d < bd) { bd = d; best = c[0]; } });
  return bd < 50 ? best : prev;       // hysteresis: keep the old orientation near the 45 deg boundaries / upside down
}
/** player holds the phone in landscape `side` (90 | 270) and turns it like a wheel by phi (deg, + = clockwise) */
function rollFor(side, phi) { return phi - side; }

test('orient: device-frame roll from beta/gamma and from the gravity vector agree; side from roll', function () {
  [-170, -120, -90, -45, 0, 30, 90, 135, 179].forEach(function (r) {
    [0, 25, 55].forEach(function (psi) {
      var p = pose(r, psi), a = OR.deviceRoll(p.beta, p.gamma), b = OR.rollFromGravity(p.g[0], p.g[1], p.g[2]);
      assert.ok(Math.abs(wrap(a.angle - r)) < 1e-6, 'roll ' + r + ' psi ' + psi + ' -> ' + a.angle);
      assert.ok(Math.abs(wrap(b.angle - r)) < 1e-6);
      assert.ok(a.conf > 0.9);
    });
  });
  assert.equal(OR.deviceRoll(0, 0).conf, 0, 'flat on a table');
  assert.equal(OR.deviceRoll(NaN, 0), null);
  assert.equal(OR.sideFromRoll(-90), 90, 'top to the left = landscape 90');
  assert.equal(OR.sideFromRoll(90), 270);
  assert.equal(OR.sideFromRoll(-450), 90);
  // device roll + screen angle = the old screen-relative wheel angle
  var p = pose(-80, 30);
  assert.ok(Math.abs(TL.wheelAngle(p.beta, p.gamma, 90).angle - 10) < 1e-6);
});

test('orient: counter-rotation, safe-area mapping and pointer mapping geometry', function () {
  assert.equal(OR.rotationFor(90, 90), 0);
  assert.equal(OR.rotationFor(90, 0), 90, 'held top-left, OS went portrait: rotate content 90 cw');
  assert.equal(OR.rotationFor(90, 270), 180);
  assert.equal(OR.rotationFor(270, 0), 270);
  assert.equal(OR.rotationFor(270, 90), 180);
  assert.equal(OR.rotationFor(90, -270), 0);
  assert.deepEqual(OR.insetMap(0), { top: 'env(safe-area-inset-top)', right: 'env(safe-area-inset-right)', bottom: 'env(safe-area-inset-bottom)', left: 'env(safe-area-inset-left)' });
  var m = OR.insetMap(90);
  assert.equal(m.left, 'env(safe-area-inset-top)', 'rotated 90 cw: the content left edge is the screen top (notch)');
  assert.equal(m.top, 'env(safe-area-inset-right)');
  assert.equal(OR.insetMap(270).left, 'env(safe-area-inset-bottom)');
  assert.equal(OR.insetMap(180).left, 'env(safe-area-inset-right)');
  // portrait viewport 400 x 800, container laid out 800 x 400, centred, rotated 90 cw: its top-left corner is at the
  // viewport's top-right corner, its bottom-right at the bottom-left
  var box = { cx: 200, cy: 400, w: 800, h: 400 };
  var a = OR.toLocal(400, 0, box, 90), b = OR.toLocal(0, 800, box, 90), c = OR.toLocal(200, 400, box, 90);
  assert.ok(Math.abs(a.x) < 1e-9 && Math.abs(a.y) < 1e-9, JSON.stringify(a));
  assert.ok(Math.abs(b.x - 800) < 1e-9 && Math.abs(b.y - 400) < 1e-9, JSON.stringify(b));
  assert.ok(Math.abs(c.x - 400) < 1e-9 && Math.abs(c.y - 200) < 1e-9);
  // a finger moving "down" the rotated content (towards the content bottom) moves LEFT on the portrait screen
  var d1 = OR.toLocal(300, 400, box, 90), d2 = OR.toLocal(100, 400, box, 90);
  assert.ok(d2.y > d1.y && Math.abs(d2.x - d1.x) < 1e-9);
  // 270 and 180 round-trip
  [180, 270].forEach(function (rot) {
    var bx = rot === 180 ? { cx: 400, cy: 200, w: 800, h: 400 } : box, t = rot * DEG;
    var lx = 123, ly = 77, dx = lx - bx.w / 2, dy = ly - bx.h / 2;
    var px = bx.cx + dx * Math.cos(t) - dy * Math.sin(t), py = bx.cy + dx * Math.sin(t) + dy * Math.cos(t);
    var q = OR.toLocal(px, py, bx, rot);
    assert.ok(Math.abs(q.x - lx) < 1e-9 && Math.abs(q.y - ly) < 1e-9, rot + ' ' + JSON.stringify(q));
  });
});

test('orient state machine: the frozen side never follows OS rotations; only the counter-rotation changes', function () {
  var S = OR.createState();
  assert.equal(S.snapshot().active, false);
  var s = S.begin({ screenAngle: 90 });
  assert.equal(s.side, 90); assert.equal(s.rot, 0); assert.equal(s.swap, false);
  s = S.update(0); assert.equal(s.side, 90); assert.equal(s.rot, 90); assert.equal(s.swap, true);
  s = S.update(270); assert.equal(s.side, 90); assert.equal(s.rot, 180); assert.equal(s.swap, false);
  s = S.update(90); assert.equal(s.rot, 0);
  s = S.begin({ screenAngle: 270 }); assert.equal(s.side, 90, 're-begin while active keeps the frozen side (no flicker)'); assert.equal(s.rot, 180);
  // CENTRE while the OS shows the other landscape side: that is how the phone is held now
  s = S.recentre({}); assert.equal(s.side, 270); assert.equal(s.rot, 0);
  // CENTRE mid-turn (OS portrait, phone not clearly sideways): keep the side
  S.update(0); s = S.recentre({ roll: 10, conf: 1 }); assert.equal(s.side, 270); assert.equal(s.rot, 270);
  s = S.end(); assert.equal(s.active, false); assert.equal(s.rot, 0); assert.equal(s.swap, false);
  assert.equal(S.update(0).rot, 0, 'no session: never rotates');
  // started while the OS is portrait (iOS with rotation lock, or not rotated yet): the side comes from gravity
  S = OR.createState();
  assert.equal(S.begin({ screenAngle: 0, roll: -88, conf: 1 }).side, 90);
  assert.equal(S.snapshot().rot, 90);
  S.end(); assert.equal(S.begin({ screenAngle: 0, roll: 92, conf: 1 }).side, 270);
  S.end(); assert.equal(S.begin({ screenAngle: 0, roll: 5, conf: 1 }).side, 90, 'held upright: default side');
  S.end(); assert.equal(S.begin({ screenAngle: 0, roll: -90, conf: 0 }).side, 90, 'flat: default side');
  // a real lock (Android fullscreen) makes the OS side authoritative
  S.end(); S.begin({ screenAngle: 0, roll: 90, conf: 1 });
  s = S.locked(90); assert.equal(s.side, 90); assert.equal(s.rot, 0); assert.equal(s.lockedOS, true);
  s = S.recentre({ roll: 90, conf: 1 }); assert.equal(s.side, 90, 'locked: CENTRE does not change side');
});

function sweep(side, from, to, step, opt) {
  opt = opt || {};
  var s = TL.createSteer({ maxAngle: opt.maxAngle || 180, deadzone: 0, smoothing: 0 }), t = 0, os = side, out = [], flips = 0;
  // calibrate level in the starting landscape side, then freeze the reference (session start)
  for (var i = 0; i < 10; i++) { t += 16; var p0 = pose(rollFor(side, 0), 30); s.update(p0.beta, p0.gamma, side, t); }
  s.lockRef(side); s.recalibrate();
  for (var phi = from; step > 0 ? phi <= to : phi >= to; phi += step) {
    var r = rollFor(side, phi), nos = osAngle(r, os);
    if (nos !== os) flips++;
    os = nos;
    var noise = opt.noise ? opt.noise() : 0, p = pose(r + noise, 30);
    t += 16;
    s.update(p.beta, p.gamma, os, t);                     // the OS screen angle changes underneath
    out.push({ phi: phi, raw: s.raw, steer: s.steer, os: os });
  }
  return { s: s, out: out, flips: flips };
}

test('tilt (frozen reference): continuous through OS auto-rotation from 0 to +-200 deg, both landscape sides', function () {
  [90, 270].forEach(function (side) {
    [[0, 200, 2], [0, -200, -2]].forEach(function (rg) {
      var r = sweep(side, rg[0], rg[1], rg[2]);
      assert.ok(r.flips >= 1, 'the simulated OS really rotated (side ' + side + ', to ' + rg[1] + ')');
      var prev = null;
      r.out.forEach(function (o) {
        assert.ok(Math.abs(o.raw - o.phi) < 1e-6, 'side ' + side + ' phi ' + o.phi + ' os ' + o.os + ' -> ' + o.raw);
        if (prev) assert.ok(rg[2] > 0 ? o.steer >= prev.steer - 1e-9 : o.steer <= prev.steer + 1e-9, 'monotonic at ' + o.phi);
        prev = o;
      });
      var last = r.out[r.out.length - 1];
      assert.equal(Math.abs(last.steer), 1, 'full lock at 180 deg and beyond');
      assert.equal(Math.abs(r.out[45].phi), 90);
      assert.ok(Math.abs(Math.abs(TL.mapAngle(r.out[45].raw, { deadzone: 0, maxAngle: 180 })) - 0.5) < 1e-6, 'linear: 90 deg turn = half lock at maxAngle 180');
    });
  });
});

test('tilt: without a frozen reference the old screen-relative angle jumps on the OS rotation (the bug this fixes)', function () {
  var s = TL.createSteer({ maxAngle: 180, deadzone: 0, smoothing: 0 }), t = 0, os = 90, maxJump = 0, prev = null;
  for (var phi = 0; phi <= 120; phi += 2) {
    var r = rollFor(90, phi); os = osAngle(r, os);
    var p = pose(r, 30); t += 16; s.update(p.beta, p.gamma, os, t);
    if (prev !== null) maxJump = Math.max(maxJump, Math.abs(s.raw - prev));
    prev = s.raw;
  }
  assert.ok(maxJump > 60, 'follow mode jumps by ~90 deg at the rotation: ' + maxJump);
});

test('tilt (frozen reference): flat phone holds the last angle; noise is filtered; re-basing to the other side', function () {
  var s = TL.createSteer({ maxAngle: 90, deadzone: 0, smoothing: 0.5 }), t = 0;
  function feed(r, psi, n, os) { for (var i = 0; i < (n || 1); i++) { t += 16; var p = pose(r, psi); s.update(p.beta, p.gamma, os == null ? 90 : os, t); } }
  feed(-90, 30, 20); s.lockRef(90); s.recalibrate();
  feed(-90 + 120, 30, 120, 0);
  assert.ok(Math.abs(s.angle - 120) < 1, 'turned 120 deg: ' + s.angle);
  var held = s.steer;
  // laid flat on the table (gravity on z): hold; spun around while flat: still hold; picked up again at the same pose
  for (var k = 0; k < 60; k++) { t += 16; s.update(0.5 * Math.sin(k), 0.5 * Math.cos(k * 1.7), 0, t); }
  assert.equal(s.flat, true); assert.equal(s.steer, held, 'flat: last value held');
  feed(-90 + 120, 30, 120, 0);
  assert.ok(Math.abs(s.angle - 120) < 1, 'back from flat without a jump or an extra turn: ' + s.angle);
  // nearly flat (low confidence) eases instead of snapping
  var before = s.raw; t += 16; var pn = pose(-90 + 60, 80); s.update(pn.beta, pn.gamma, 0, t);
  assert.ok(s.raw < before && s.raw > 60, 'low-confidence reading is only partly trusted: ' + s.raw);
  // noise: +-3 deg jitter around a 150 deg hold
  var seed = 3; function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; }
  var outs = [];
  for (var j = 0; j < 300; j++) { t += 16; var pj = pose(-90 + 150 + rnd() * 6, 30); s.update(pj.beta, pj.gamma, j % 50 < 25 ? 270 : 0, t); if (j > 150) outs.push(s.angle); }
  var mean = outs.reduce(function (a, b) { return a + b; }, 0) / outs.length;
  var sd = Math.sqrt(outs.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / outs.length);
  assert.ok(Math.abs(mean - 150) < 1, 'mean ' + mean);
  assert.ok(sd < 0.6, 'jitter ' + sd);
  // next session: the player now holds the phone level in the OTHER landscape side -> re-based, reads ~0
  var s2 = TL.createSteer({ maxAngle: 35, deadzone: 0, smoothing: 0 });
  t = 0;
  for (var q = 0; q < 10; q++) { t += 16; var a0 = pose(-90, 30); s2.update(a0.beta, a0.gamma, 90, t); }
  s2.lockRef(90); s2.recalibrate();
  for (q = 0; q < 10; q++) { t += 16; var a1 = pose(90, 30); s2.update(a1.beta, a1.gamma, 270, t); }
  assert.ok(Math.abs(Math.abs(s2.raw) - 180) < 1e-6, 'frozen: the other side is a half turn');
  s2.lockRef(270);
  for (q = 0; q < 10; q++) { t += 16; var a2 = pose(90, 30); s2.update(a2.beta, a2.gamma, 270, t); }
  assert.ok(Math.abs(s2.raw) < 1e-6, 're-based to side 270: level = 0 (' + s2.raw + ')');
  assert.equal(s2.state().refLocked, true);
});

test('tilt: a whole extra turn folds back past full lock; prefs allow full lock up to 180 deg', function () {
  assert.equal(TL.foldLimit(35), 200);
  assert.equal(TL.foldLimit(180), 270);
  var r = sweep(90, 0, 300, 3, { maxAngle: 180 });
  var last = r.out[r.out.length - 1];
  assert.ok(Math.abs(last.raw - (300 - 360)) < 1e-6, 'past 270 deg it folds to -60: ' + last.raw);
  assert.equal(AN.normPrefs({ maxAngle: 180 }).maxAngle, 180);
  assert.equal(AN.normPrefs({ maxAngle: 400 }).maxAngle, 180);
  assert.equal(AN.normPrefs({ maxAngle: 1 }).maxAngle, 10);
  assert.ok(Math.abs(TL.mapAngle(90, { deadzone: 0, maxAngle: 180 }) - 0.5) < 1e-9);
});

test('orient wiring: script order, landscape web-app manifest (relative paths), served + packaged for cPanel', function () {
  var fs = require('fs');
  var html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  var iT = html.indexOf('js/input/tilt.js'), iO = html.indexOf('js/input/orient.js'), iU = html.indexOf('js/input/input-ui.js'), iW = html.indexOf('js/input/wheel-page.js');
  assert.ok(iT > 0 && iO > iT && iU > iO && iW > iO, 'orient.js loads after tilt.js, before input-ui / wheel-page');
  assert.ok(/<link rel="manifest" href="manifest\.webmanifest">/.test(html), 'relative manifest link (works in /RacingGame/)');
  var man = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(man.orientation, 'landscape');
  assert.ok(!/^\//.test(man.start_url) && !/^\//.test(man.scope), 'no domain-root paths');
  man.icons.forEach(function (ic) { assert.ok(fs.existsSync(path.join(root, ic.src)), ic.src); });
  assert.ok(/AddType\s+application\/manifest\+json\s+\.webmanifest/.test(fs.readFileSync(path.join(root, '.htaccess'), 'utf8')));
  var BZ = require(path.join(root, 'tools/build-zip.js'));
  var os = require('os'), out = path.join(os.tmpdir(), 'orient-zip-' + process.pid + '.zip');
  try {
    var r = BZ.build({ folder: 'RacingGame', out: out });
    var names = r.files.map(function (f) { return f.name; });
    ['RacingGame/manifest.webmanifest', 'RacingGame/icon.svg', 'RacingGame/js/input/orient.js'].forEach(function (n) { assert.ok(names.indexOf(n) >= 0, n); });
  } finally { try { fs.unlinkSync(out); } catch (e) { /* ignore */ } }
});

test('orient: wheel page + tilt layer route pointer maths and safe areas through CB.input.orient', function () {
  var fs = require('fs');
  var wp = fs.readFileSync(path.join(root, 'js/input/wheel-page.js'), 'utf8'), iu = fs.readFileSync(path.join(root, 'js/input/input-ui.js'), 'utf8');
  assert.ok(/O\.begin\(\$\('#pw-wheel'\), 'wheel'/.test(wp), 'wheel Start begins an orientation session');
  assert.ok(/steerer\.lockRef\(s\.side\)/.test(wp) && /lockRef\(s\.side\)/.test(iu), 'steering reference follows the frozen side');
  assert.ok(/var\(--pw-sa-\$1,env\(safe-area-inset-\$1\)\)/.test(wp) && /var\(--pw-sa-\$1,env\(safe-area-inset-\$1\)\)/.test(iu), 'safe areas via variables');
  assert.ok(!/getBoundingClientRect\(\); var v = clamp/.test(wp), 'pedals no longer read the rotated bounding box');
  assert.ok(/o\.begin\(rr, 'tilt'\)/.test(iu) && /o\.end\('tilt'\)/.test(iu), 'in-game tilt session begins / ends with driving');
});
