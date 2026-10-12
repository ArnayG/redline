/* FORGE Atelier — tests for js/race/gl/gl-core.js (CB.gl): math against known values, geometry builders
   (counts, index ranges, unit normals, CCW winding vs normals, outward orientation), merge, preprocessor,
   material resolution, sorting, shadow fitting and a mock-WebGL drawList ordering test. */
'use strict';
const path = require('path');
const assert = require('node:assert/strict');
const G = require(path.join(__dirname, '..', 'js', 'race', 'gl', 'gl-core.js'));
const { mat4, mat3, vec3, quat, frustum, geometry: geo } = G;

// standalone mode (node tests/race3d-math.test.js) as well as under tests/run.js
const test = (typeof globalThis.test === 'function' && require.main !== module)
  ? globalThis.test
  : function (name, fn) {
    try { fn(assert); console.log('  ok   ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n    ' + ((e && e.stack) || e)); process.exitCode = 1; }
  };

function near(a, b, eps, msg) {
  eps = eps == null ? 1e-5 : eps;
  if (typeof a === 'number') { assert.ok(Math.abs(a - b) <= eps, (msg || '') + ' expected ' + b + ' got ' + a); return; }
  assert.equal(a.length, b.length, (msg || '') + ' length');
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= eps, (msg || '') + ' [' + i + '] expected ' + b[i] + ' got ' + a[i] + ' in ' + Array.from(a).map((v) => +v.toFixed(5)).join(','));
}

/** Validates a geometry: index range, unit normals, triangle winding agrees with vertex normals,
    and (optionally) faces point away from `centre`. Returns stats. */
function validate(name, g, centre) {
  const P = g.positions, N = g.normals, I = g.indices, nv = P.length / 3;
  assert.ok(P instanceof Float32Array, name + ' positions Float32Array');
  assert.ok(N instanceof Float32Array && N.length === P.length, name + ' normals');
  assert.ok(g.uvs instanceof Float32Array && g.uvs.length === nv * 2, name + ' uvs');
  assert.ok(I instanceof Uint16Array || I instanceof Uint32Array, name + ' typed indices');
  assert.equal(I.length % 3, 0, name + ' triangle list');
  for (let i = 0; i < I.length; i++) assert.ok(I[i] < nv, name + ' index in range');
  for (let i = 0; i < N.length; i += 3) near(Math.hypot(N[i], N[i + 1], N[i + 2]), 1, 1e-3, name + ' unit normal');
  for (let i = 0; i < P.length; i++) assert.ok(Number.isFinite(P[i]), name + ' finite positions');
  let agree = 0, disagree = 0, out = 0, inward = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (Math.hypot(n[0], n[1], n[2]) < 1e-12) continue; // degenerate (poles / apex)
    const vn = [N[a] + N[b] + N[c], N[a + 1] + N[b + 1] + N[c + 1], N[a + 2] + N[b + 2] + N[c + 2]];
    if (n[0] * vn[0] + n[1] * vn[1] + n[2] * vn[2] > 0) agree++; else disagree++;
    if (centre) {
      const m = [(P[a] + P[b] + P[c]) / 3 - centre[0], (P[a + 1] + P[b + 1] + P[c + 1]) / 3 - centre[1], (P[a + 2] + P[b + 2] + P[c + 2]) / 3 - centre[2]];
      if (m[0] * n[0] + m[1] * n[1] + m[2] * n[2] > 0) out++; else inward++;
    }
  }
  assert.ok(agree > 0, name + ' has triangles');
  assert.equal(disagree, 0, name + ': ' + disagree + ' triangles wound against their normals');
  if (centre) assert.equal(inward, 0, name + ': ' + inward + ' triangles face inward');
  return { nv, nt: I.length / 3 };
}

/* ------------------------------------------------------------------ mat4 */
test('mat4.create / identity', () => {
  near(mat4.create(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const m = mat4.fromValues(2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4, 5, 6, 7, 8);
  near(mat4.identity(m), mat4.create());
});

test('mat4.multiply (gl-matrix reference values)', () => {
  const A = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
  const B = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1]);
  near(mat4.multiply(mat4.create(), A, B), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 7, 9, 1]);
  // general product, checked by hand: column-major a * b
  const a = mat4.fromValues(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16);
  const b = mat4.fromValues(17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32);
  near(mat4.multiply(mat4.create(), a, b), [538, 612, 686, 760, 650, 740, 830, 920, 762, 868, 974, 1080, 874, 996, 1118, 1240]);
  // aliasing out === a
  const c = mat4.clone(a); mat4.multiply(c, c, b);
  near(c, [538, 612, 686, 760, 650, 740, 830, 920, 762, 868, 974, 1080, 874, 996, 1118, 1240]);
});

test('mat4.invert / transpose / determinant', () => {
  const A = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
  near(mat4.invert(mat4.create(), A), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, -2, -3, 1]);
  const M = mat4.create();
  mat4.translate(M, M, [3, -2, 7]); mat4.rotateY(M, M, 0.7); mat4.rotateX(M, M, -0.3); mat4.scale(M, M, [2, 0.5, 1.5]);
  const inv = mat4.invert(mat4.create(), M);
  near(mat4.multiply(mat4.create(), M, inv), mat4.create(), 1e-5);
  near(mat4.determinant(M), 2 * 0.5 * 1.5, 1e-5);
  assert.equal(mat4.invert(mat4.create(), new Float32Array(16)), null, 'singular -> null');
  const T = mat4.fromValues(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16);
  near(mat4.transpose(mat4.create(), T), [1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15, 4, 8, 12, 16]);
  const T2 = mat4.clone(T); mat4.transpose(T2, T2);
  near(T2, [1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15, 4, 8, 12, 16], 0, 'in-place transpose');
});

test('mat4.perspective / ortho (gl-matrix reference values)', () => {
  near(mat4.perspective(mat4.create(), Math.PI / 2, 1, 0, 1), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, 0, 0]);
  const p = mat4.perspective(mat4.create(), Math.PI * 0.5, 2, 0.1, 100);
  near(p[0], 0.5); near(p[5], 1); near(p[10], -100.1 / 99.9, 1e-5); near(p[14], -20 / 99.9, 1e-5); near(p[11], -1);
  // near plane maps to -1, far plane to +1 in NDC
  const ndcNear = vec3.transformMat4([0, 0, 0], [0, 0, -0.1], p), ndcFar = vec3.transformMat4([0, 0, 0], [0, 0, -100], p);
  near(ndcNear[2], -1, 1e-4); near(ndcFar[2], 1, 1e-4);
  const inf = mat4.perspective(mat4.create(), 1, 1, 0.5, Infinity);
  near(inf[10], -1); near(inf[14], -1);
  near(mat4.ortho(mat4.create(), -1, 1, -1, 1, -1, 1), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);
});

test('mat4.lookAt', () => {
  near(mat4.lookAt(mat4.create(), [0, 0, 1], [0, 0, -1], [0, 1, 0]), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1, 1]);
  // looking down -Y with up = -Z: the view direction maps to -Z, up to +Y, right to +X
  const v = mat4.lookAt(mat4.create(), [0, 0, 0], [0, -1, 0], [0, 0, -1]);
  near(vec3.transformDirection([0, 0, 0], [0, -1, 0], v), [0, 0, -1]);
  near(vec3.transformDirection([0, 0, 0], [0, 0, -1], v), [0, 1, 0]);
  near(vec3.transformDirection([0, 0, 0], [1, 0, 0], v), [1, 0, 0]);
  // general: eye maps to the origin, target on the -Z axis
  const eye = [10, 5, -3], target = [2, 1, 4];
  const w = mat4.lookAt(mat4.create(), eye, target, [0, 1, 0]);
  near(vec3.transformMat4([0, 0, 0], eye, w), [0, 0, 0], 1e-4);
  const t = vec3.transformMat4([0, 0, 0], target, w);
  near(t[0], 0, 1e-4); near(t[1], 0, 1e-4); near(t[2], -vec3.distance(eye, target), 1e-4);
  // degenerate up (parallel to view dir) still produces an orthonormal basis
  const d = mat4.lookAt(mat4.create(), [0, 10, 0], [0, 0, 0], [0, 1, 0]);
  near(mat4.determinant(d), 1, 1e-5);
});

test('mat4 rotations / translate / scale / fromRotationTranslation', () => {
  const h = Math.PI / 2;
  near(mat4.rotateX(mat4.create(), mat4.create(), h), [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
  near(mat4.rotateY(mat4.create(), mat4.create(), h), [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
  near(mat4.rotateZ(mat4.create(), mat4.create(), h), [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  near(mat4.rotate(mat4.create(), mat4.create(), h, [0, 2, 0]), mat4.rotateY(mat4.create(), mat4.create(), h));
  // Ry(heading) maps car-local +X (forward) to (cos h, 0, -sin h): sim (x, y) -> GL (x, -y) convention
  const Ry = mat4.fromYRotation(mat4.create(), 0.6);
  near(vec3.transformDirection([0, 0, 0], [1, 0, 0], Ry), [Math.cos(0.6), 0, -Math.sin(0.6)]);
  const T = mat4.translate(mat4.create(), mat4.create(), [1, 2, 3]);
  near(T, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
  const S = mat4.scale(mat4.create(), T, [2, 3, 4]);
  near(S, [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 1, 2, 3, 1]);
  const q = quat.setAxisAngle(quat.create(), [0, 1, 0], h);
  const RT = mat4.fromRotationTranslation(mat4.create(), q, [5, 6, 7]);
  const ref = mat4.rotateY(mat4.create(), mat4.fromTranslation(mat4.create(), [5, 6, 7]), h);
  near(RT, ref, 1e-6);
  near(mat4.getMaxScale(S), 4);
  const qe = quat.fromEuler(quat.create(), 0, h, 0);
  near(mat4.fromQuat(mat4.create(), qe), mat4.rotateY(mat4.create(), mat4.create(), h), 1e-6);
});

test('mat3.normalFromMat4 = inverse transpose', () => {
  const m = mat4.fromScaling(mat4.create(), [2, 1, 4]);
  near(mat3.normalFromMat4(new Float32Array(9), m), [0.5, 0, 0, 0, 1, 0, 0, 0, 0.25]);
  const r = mat4.fromYRotation(mat4.create(), 0.4);
  near(mat3.normalFromMat4(new Float32Array(9), r), mat3.fromMat4(new Float32Array(9), r), 1e-6);
});

/* ------------------------------------------------------------------ vec3 */
test('vec3 ops', () => {
  const o = vec3.create();
  near(vec3.add(o, [1, 2, 3], [4, 5, 6]), [5, 7, 9]);
  near(vec3.sub(o, [1, 2, 3], [4, 5, 6]), [-3, -3, -3]);
  near(vec3.scale(o, [1, 2, 3], 2), [2, 4, 6]);
  near(vec3.cross(o, [1, 2, 3], [4, 5, 6]), [-3, 6, -3]);
  near(vec3.cross(o, [1, 0, 0], [0, 1, 0]), [0, 0, 1], 0, 'x cross y = z');
  near(vec3.dot([1, 2, 3], [4, 5, 6]), 32);
  near(vec3.length([1, 2, 3]), Math.sqrt(14));
  near(vec3.normalize(o, [5, 0, 0]), [1, 0, 0]);
  near(vec3.normalize(o, [0, 0, 0]), [0, 0, 0], 0, 'zero vector stays zero');
  near(vec3.lerp(o, [1, 2, 3], [4, 5, 6], 0.5), [2.5, 3.5, 4.5]);
  near(vec3.distance([1, 2, 3], [4, 6, 3]), 5);
  const p = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 10);
  near(vec3.transformMat4(o, [0, 0, -1], p), [0, 0, -1], 1e-5, 'perspective divide');
  assert.ok(vec3.equals([1, 2, 3], [1, 2, 3.0000001]));
});

test('frustum planes and sphere test', () => {
  const p = mat4.perspective(mat4.create(), Math.PI / 3, 1.5, 0.1, 500);
  const v = mat4.lookAt(mat4.create(), [0, 2, 0], [0, 2, -10], [0, 1, 0]);
  const pl = frustum.fromMatrix(mat4.multiply(mat4.create(), p, v));
  assert.ok(frustum.sphereVisible(pl, 0, 2, -50, 1), 'ahead');
  assert.ok(!frustum.sphereVisible(pl, 0, 2, 50, 1), 'behind');
  assert.ok(!frustum.sphereVisible(pl, 0, 2, -800, 10), 'beyond far');
  assert.ok(frustum.sphereVisible(pl, 0, 2, 3, 4), 'behind but large radius overlaps');
});

/* ------------------------------------------------------------------ geometry */
test('geometry.box: 24 verts, 12 tris, outward CCW, bounds', () => {
  const g = geo.box(2, 4, 6);
  const s = validate('box', g, [0, 0, 0]);
  assert.equal(s.nv, 24); assert.equal(s.nt, 12);
  const b = geo.computeBounds(g.positions);
  near(b.min, [-1, -2, -3]); near(b.max, [1, 2, 3]); near(b.radius, Math.sqrt(14));
  const c = geo.box({ width: 1, height: 1, depth: 1, center: [0, 0.5, 0] });
  near(geo.computeBounds(c.positions).min, [-0.5, 0, -0.5]);
});

test('geometry.roundedBox', () => {
  const g = geo.roundedBox(2, 1, 3, 0.2, 3);
  validate('roundedBox', g, [0, 0, 0]);
  const b = geo.computeBounds(g.positions);
  near(b.min, [-1, -0.5, -1.5], 1e-5); near(b.max, [1, 0.5, 1.5], 1e-5);
});

test('geometry.cylinder / cone (caps, axis option)', () => {
  const g = geo.cylinder(0.5, 0.7, 2, 16);
  const s = validate('cylinder', g, [0, 0, 0]);
  assert.equal(s.nt, 16 * 2 + 16 * 2);
  near(geo.computeBounds(g.positions).max[1], 1); near(geo.computeBounds(g.positions).min[1], -1);
  const open = geo.cylinder(0.5, 0.5, 1, 8, { caps: false });
  assert.equal(open.indices.length / 3, 16);
  const x = geo.cylinder(0.3, 0.3, 0.25, 12, { axis: 'z' });   // wheel axis
  validate('cylinder z', x, [0, 0, 0]);
  const bz = geo.computeBounds(x.positions);
  near(bz.max[2], 0.125, 1e-5); near(bz.max[0], 0.3, 1e-3);
  validate('cylinder x', geo.cylinder(0.3, 0.3, 2, 12, { axis: 'x' }), [0, 0, 0]);
  validate('cone', geo.cone(1, 2, 12), [0, 0, 0]);
});

test('geometry.torus / sphere / plane / disc', () => {
  const t = geo.torus(1, 0.25, 8, 24);
  validate('torus', t);
  // every vertex is exactly tube-radius from the ring
  for (let i = 0; i < t.positions.length; i += 3) {
    const x = t.positions[i], y = t.positions[i + 1], z = t.positions[i + 2];
    near(Math.hypot(Math.hypot(x, y) - 1, z), 0.25, 1e-5);
  }
  const s = geo.sphere(2, 16, 12);
  validate('sphere', s, [0, 0, 0]);
  for (let i = 0; i < s.positions.length; i += 3) near(Math.hypot(s.positions[i], s.positions[i + 1], s.positions[i + 2]), 2, 1e-5);
  const p = geo.plane(10, 4, 5, 2);
  validate('plane', p);
  assert.equal(p.positions.length / 3, 6 * 3);
  for (let i = 1; i < p.normals.length; i += 3) near(p.normals[i], 1);
  const d = geo.disc(1, 16, { innerRadius: 0.4 });
  validate('disc', d);
});

test('geometry.lathe: outward regardless of profile direction', () => {
  const prof = [[0, 0], [1, 0.2], [1, 1], [0.6, 1.6], [0, 1.7]];
  validate('lathe up', geo.lathe(prof, 16), [0, 0.85, 0]);
  validate('lathe down', geo.lathe(prof.slice().reverse(), 16), [0, 0.85, 0]);
  const half = geo.lathe([[1, 0], [1, 1]], 8, { phiLength: Math.PI });
  validate('lathe half', half);
});

test('geometry.extrudeProfile: hard edges, caps, outward along a curved path', () => {
  const prof = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];   // 1 m wide, 1 m tall barrier section
  const pathPts = [[0, 0, 0], [10, 0, 0], [20, 0, 5], [25, 0, 15]];
  for (const pr of [prof, prof.slice().reverse()]) {
    const g = geo.extrudeProfile(pr, pathPts, { caps: true });
    validate('extrude', g);
    // side faces point away from the path centreline (sample normals at the first ring)
    const P = g.positions, N = g.normals;
    for (let v = 0; v < P.length / 3; v++) {
      const k = v * 3;
      // nearest path point
      let best = null, bd = Infinity;
      for (const q of pathPts) { const d = Math.hypot(P[k] - q[0], P[k + 2] - q[2]); if (d < bd) { bd = d; best = q; } }
      const toV = [P[k] - best[0], P[k + 1] - 0.5, P[k + 2] - best[2]];
      assert.ok(toV[0] * N[k] + toV[1] * N[k + 1] + toV[2] * N[k + 2] > -1e-6, 'outward normal');
    }
  }
  // frames keep the profile upright (no roll): every vertex of y=1 profile points stays at y=1
  const g = geo.extrudeProfile(prof, pathPts, {});
  for (let i = 1; i < g.positions.length; i += 3) assert.ok(Math.abs(g.positions[i]) < 1e-5 || Math.abs(g.positions[i] - 1) < 1e-5);
  const tube = geo.tube([[0, 0, 0], [0, 1, 0], [1, 2, 0]], 0.1, 8);
  validate('tube', tube);
  const closed = geo.extrudeProfile(prof, [[0, 0, 0], [10, 0, 0], [10, 0, -10], [0, 0, -10]], { closedPath: true });
  validate('extrude closed path', closed);
});

test('geometry.loft: smooth, auto-oriented, closed ends, seam UVs, count check', () => {
  const rings = [];
  for (let i = 0; i < 6; i++) {
    const s = i === 0 || i === 5 ? 0.3 : 1, r = [];
    for (let j = 0; j < 12; j++) { const a = (j / 12) * Math.PI * 2; r.push([i, Math.sin(a) * s, Math.cos(a) * s]); }
    rings.push(r);
  }
  const g = geo.loft(rings, { closeEnds: true });
  validate('loft', g, [2.5, 0, 0]);
  validate('loft reversed rings', geo.loft(rings.map((r) => r.slice().reverse()), { closeEnds: true }), [2.5, 0, 0]);
  // seam column duplicated: (12 + 1) * 6 body verts + 2 caps * (1 + 12)
  assert.equal(g.positions.length / 3, 13 * 6 + 2 * 13);
  // smooth: the two seam copies share the normal
  for (let i = 0; i < 6; i++) near(Array.from(g.normals.slice(i * 13 * 3, i * 13 * 3 + 3)), Array.from(g.normals.slice((i * 13 + 12) * 3, (i * 13 + 12) * 3 + 3)), 1e-6);
  assert.throws(() => geo.loft([rings[0], rings[1].slice(0, 10)]), /same vertex count/);
  const flat = geo.loft(rings, { smooth: false });
  validate('loft flat', flat);
});

test('geometry.merge: transforms, colors, mirrored winding, 32-bit indices', () => {
  const mirror = mat4.fromScaling(mat4.create(), [-1, 1, 1]);
  const moved = mat4.fromTranslation(mat4.create(), [5, 0, 0]);
  const m = geo.merge([
    { geometry: geo.box(1, 1, 1), transform: mirror, color: [1, 0, 0, 1] },
    { geometry: geo.box(1, 1, 1), transform: moved, color: [0, 1, 0] },
    geo.sphere(0.5, 8, 6)
  ]);
  assert.equal(m.colorSize, 4);
  assert.equal(m.positions.length / 3, 24 + 24 + geo.sphere(0.5, 8, 6).positions.length / 3);
  near(Array.from(m.colors.slice(0, 4)), [1, 0, 0, 1]);
  near(Array.from(m.colors.slice(24 * 4, 24 * 4 + 4)), [0, 1, 0, 1]);
  near(Array.from(m.colors.slice(48 * 4, 48 * 4 + 4)), [1, 1, 1, 1]);
  validate('merged', m);
  near(geo.computeBounds(m.positions).max[0], 5.5);
  const big = geo.merge([geo.plane(10, 10, 300, 300)]);
  assert.ok(big.indices instanceof Uint32Array, 'over 65535 vertices -> Uint32');
  assert.ok(geo.merge([geo.box(1, 1, 1)]).indices instanceof Uint16Array);
});

test('geometry.computeNormals / toNonIndexed / transform / triangulate2D', () => {
  const quad = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1]), indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
  geo.computeNormals(quad);
  for (let i = 0; i < 4; i++) near(Array.from(quad.normals.slice(i * 3, i * 3 + 3)), [0, 1, 0]);
  const flat = geo.computeNormals(geo.sphere(1, 6, 4), { flat: true });
  assert.equal(flat.positions.length / 3, flat.indices.length);
  validate('flat sphere', flat, [0, 0, 0]);
  const b = geo.transform(geo.box(1, 1, 1), mat4.fromScaling(mat4.create(), [1, 1, -2]));
  validate('mirrored box', b, [0, 0, 0]);
  // concave L-shape: triangulated area equals polygon area
  const L = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
  const tri = geo.triangulate2D(L);
  assert.equal(tri.length, (L.length - 2) * 3);
  let area = 0;
  for (let t = 0; t < tri.length; t += 3) {
    const a = L[tri[t]], c = L[tri[t + 1]], d = L[tri[t + 2]];
    const ar = ((c[0] - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (c[1] - a[1])) / 2;
    assert.ok(ar > 0, 'CCW triangles');
    area += ar;
  }
  near(area, 3);
  near(geo.signedArea2D(L), 3);
});

/* ------------------------------------------------------------------ shaders / preprocessor */
test('preprocess: GLSL ES 3.00 rewrite and ES 1.0 passthrough', () => {
  const src = 'attribute vec3 aPos; varying vec2 vUv;\nvoid main(){ gl_FragColor = texture2D(uMap, vUv); }';
  const v2 = G.preprocess(src, 'vertex', { isWebGL2: true, defines: { INSTANCED: true, N: 4, OFF: false } });
  assert.ok(v2.startsWith('#version 300 es\n'));
  assert.ok(/\bin vec3 aPos/.test(v2) && /\bout vec2 vUv/.test(v2));
  assert.ok(v2.includes('#define INSTANCED\n') && v2.includes('#define N 4\n') && !v2.includes('OFF'));
  const f2 = G.preprocess(src, 'fragment', { isWebGL2: true });
  assert.ok(/\bin vec2 vUv/.test(f2) && f2.includes('out vec4 forge_FragColor;') && f2.includes('forge_FragColor = texture(uMap'));
  assert.ok(!/\btexture2D\b|\battribute\b|\bvarying\b|\bgl_FragColor\b/.test(f2.replace('#define', '')));
  assert.ok(f2.includes('precision mediump sampler2DShadow;'));
  const f1 = G.preprocess(src, 'fragment', { isWebGL2: false, derivatives: true });
  assert.ok(f1.startsWith('#extension GL_OES_standard_derivatives : enable\n'));
  assert.ok(f1.includes('#define HAS_DERIVATIVES') && f1.includes('texture2D(') && f1.includes('GL_FRAGMENT_PRECISION_HIGH'));
  // built-in sources pass both dialects without leftover 1.0 keywords on WebGL2
  for (const k of Object.keys(G.SOURCES)) {
    const stage = /_VS$/.test(k) ? 'vertex' : 'fragment';
    const out = G.preprocess(G.SOURCES[k], stage, { isWebGL2: true, defines: { SHADOW_HW: true } });
    assert.ok(!/\battribute\b|\bvarying\b|\btexture2D\b|\bgl_FragColor\b/.test(out), k);
    assert.ok(/void main\s*\(\s*\)/.test(out), k + ' has main');
    // balanced braces / parens
    const count = (s, c) => s.split(c).length - 1;
    assert.equal(count(out, '{'), count(out, '}'), k + ' braces');
    assert.equal(count(out, '('), count(out, ')'), k + ' parens');
    const ifs = (out.match(/#if(n?def)?\b/g) || []).length, ends = (out.match(/#endif\b/g) || []).length;
    assert.equal(ifs, ends, k + ' #if/#endif balance');
  }
  // the standard shader exposes every contract uniform
  const fs = G.SOURCES.STANDARD_FS + G.SOURCES.STANDARD_VS;
  ['uModel', 'uView', 'uProj', 'uNormalMat', 'uBaseColor', 'uMap', 'uUseMap', 'uMetallic', 'uRoughness', 'uClearcoat', 'uFlake',
    'uEmissive', 'uSunDir', 'uSunColor', 'uAmbientSky', 'uAmbientGround', 'uFogColor', 'uFogDensity', 'uCamPos', 'uEnvTop',
    'uEnvHorizon', 'uEnvBottom', 'uShadowMap', 'uShadowMatrix', 'uUseShadow', 'uLightPos', 'uLightDir', 'uLightColor',
    'uLightParams', 'uWetness', 'uHueShift', 'aColor'].forEach((n) => assert.ok(new RegExp('\\b' + n + '\\b').test(fs), n));
});

test('formatShaderError: numbered context around the failing line', () => {
  const src = 'a\nb\nc\nd\ne\nf';
  const msg = G.formatShaderError('demo', 'fragment', src, "ERROR: 0:4: 'x' : undeclared identifier");
  assert.ok(msg.includes('"demo"') && msg.includes('undeclared'));
  assert.ok(/>\s+4 \| d/.test(msg));
  assert.ok(/\s+2 \| b/.test(msg) && /\s+6 \| f/.test(msg));
});

/* ------------------------------------------------------------------ materials / sorting / shadows */
test('resolveMaterial: uniform-style and plain keys, blend + depth rules', () => {
  const a = G.resolveMaterial({ uBaseColor: [0.5, 0.4, 0.3, 0.8], uMetallic: 1, uRoughness: 0.2, uClearcoat: 1, uFlake: 0.5, uEmissive: [1, 0, 0], transparent: true });
  near([a.r, a.g, a.b, a.a], [0.5, 0.4, 0.3, 0.8]);
  assert.equal(a.metallic, 1); assert.equal(a.clearcoat, 1); assert.equal(a.flake, 0.5);
  assert.equal(a.blendMode, 1); assert.equal(a.depthWrite, false);
  const b = G.resolveMaterial({ color: [1, 1, 1], opacity: 0.5, roughness: 0.9, additive: true, decal: true, hueShift: 0.3, emissive: [0.5, 0.5, 0.5], emissiveIntensity: 2 });
  near(b.a, 0.5); assert.equal(b.blendMode, 2); near(b.polygonOffset, [-1, -2]); near(b.hueShift, 0.3); near(b.er, 1);
  const c = G.resolveMaterial({});
  assert.equal(c.blendMode, 0); assert.equal(c.depthWrite, true); assert.equal(c.cull, 0); near(c.roughness, 0.7);
  assert.equal(G.resolveMaterial({ cull: true }).cull, 1);
  assert.equal(G.resolveMaterial({ cull: true, doubleSided: true }).cull, 0);
  const u = G.resolveMaterial({ uvScale: [2, 3], uvOffset: [0.5, 0] });
  near([u.uv0, u.uv1, u.uv2, u.uv3], [2, 3, 0.5, 0]);
});

test('sortItems: opaque front-to-back, transparent back-to-front; itemDepth uses bounds centre', () => {
  const recs = [
    { id: 'o30', depth: 30 }, { id: 't5', depth: 5, transparent: true }, { id: 'o10', depth: 10 },
    { id: 't50', depth: 50, transparent: true }, { id: 'o20', depth: 20 }
  ];
  const s = G.sortItems(recs);
  assert.deepEqual(s.opaque.map((r) => r.id), ['o10', 'o20', 'o30']);
  assert.deepEqual(s.transparent.map((r) => r.id), ['t50', 't5']);
  const mesh = { bounds: { center: [0, 0, -10], radius: 1 } };
  near(G.itemDepth({ model: mat4.fromTranslation(mat4.create(), [0, 0, -5]) }, mesh, [0, 0, 0]), 15);
  near(G.itemDepth({ sortDepth: -7 }, mesh, [0, 0, 0]), -7);
});

test('fitShadow: radius around the centre maps inside the shadow map, texel snapping is stable', () => {
  const c = [120, 0, -340], sun = [0.4, 0.75, 0.3], r = 95;
  const f = G.fitShadow({}, c, sun, r, 2048);
  const uv = vec3.transformMat4([0, 0, 0], c, f.matrix);
  near(uv[0], 0.5, 2 / 2048); near(uv[1], 0.5, 2 / 2048);
  assert.ok(uv[2] > 0 && uv[2] < 1);
  for (const d of [[r * 0.7, 0, 0], [0, 0, r * 0.7], [-r * 0.7, 30, 0], [0, -5, -r * 0.7]]) {
    const p = vec3.transformMat4([0, 0, 0], [c[0] + d[0], c[1] + d[1], c[2] + d[2]], f.matrix);
    for (let k = 0; k < 3; k++) assert.ok(p[k] > 0 && p[k] < 1, 'inside ' + d + ' -> ' + Array.from(p));
  }
  // closer to the sun = smaller depth
  const hi = vec3.transformMat4([0, 0, 0], [c[0] + sun[0] * 10, c[1] + sun[1] * 10, c[2] + sun[2] * 10], f.matrix);
  assert.ok(hi[2] < uv[2]);
  // moving the centre by a sub-texel amount keeps world -> texel mapping on the same grid
  const f2 = G.fitShadow({}, [c[0] + 0.01, c[1], c[2]], sun, r, 2048);
  const a = vec3.transformMat4([0, 0, 0], [0, 0, 0], f.matrix), b = vec3.transformMat4([0, 0, 0], [0, 0, 0], f2.matrix);
  const texel = 1 / 2048, fa = (a[0] / texel) % 1, fb = (b[0] / texel) % 1;
  near(Math.abs(fa - fb) % 1 < 1e-3 || Math.abs(Math.abs(fa - fb) - 1) < 1e-3 ? 0 : 1, 0, 0, 'snapped');
});

/* ------------------------------------------------------------------ mock WebGL: context, meshes, drawList order */
function mockCanvas() {
  const log = [];
  let id = 1;
  const consts = {};
  let constNext = 0x9000;
  const table = {
    getExtension: () => ({}),
    getParameter: () => 4096,
    isContextLost: () => false,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    checkFramebufferStatus: () => gl.FRAMEBUFFER_COMPLETE,
    getActiveUniform: () => null,
    getActiveAttrib: () => null,
    getUniformLocation: () => null,
    getAttribLocation: () => 0,
    bindVertexArray: (v) => { if (v) log.push('vao:' + v.tag); },
    drawElements: () => log.push('drawElements'),
    drawArrays: () => log.push('drawArrays'),
    drawElementsInstanced: (m, c, t, o, n) => log.push('instanced:' + n),
    createVertexArray: () => ({ tag: 'v' + (id++) }),
    drawingBufferWidth: 800, drawingBufferHeight: 450
  };
  const gl = new Proxy(table, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'string' && /^[A-Z0-9_]+$/.test(k)) { if (!(k in consts)) consts[k] = constNext++; return consts[k]; }
      if (typeof k === 'string') return function () { return { tag: 'o' + (id++), name: k }; };
      return undefined;
    }
  });
  return { log, gl, canvas: { width: 300, height: 150, getContext: (t) => (t === 'webgl2' ? gl : null), addEventListener() {}, removeEventListener() {} } };
}

test('createContext / createMesh / createInstanced with a mock WebGL2 context', () => {
  const { canvas } = mockCanvas();
  const ctx = G.createContext(canvas, { antialias: true });
  assert.ok(ctx && ctx.gl && ctx.isWebGL2);
  assert.ok(ctx.ext.instancing && ctx.ext.vao && ctx.ext.uint);
  assert.equal(ctx.resize(400, 200, 2), true);
  assert.equal(canvas.width, 800); assert.equal(canvas.height, 400);
  assert.equal(ctx.resize(400, 200, 2), false);
  const mesh = G.createMesh(ctx, geo.box(1, 2, 3));
  assert.equal(mesh.count, 36); assert.equal(mesh.triangles, 12);
  near(mesh.bounds.max, [0.5, 1, 1.5]);
  const nonormals = G.createMesh(ctx, { positions: [0, 0, 0, 1, 0, 0, 0, 0, -1] });
  assert.ok(nonormals.hasNormals, 'normals computed when missing');
  const data = G.packInstances([{ matrix: mat4.fromTranslation(mat4.create(), [10, 0, 0]) }, { matrix: mat4.fromTranslation(mat4.create(), [-10, 0, 0]), color: [1, 0, 0, 1] }]);
  assert.equal(data.length, 40);
  const inst = G.createInstanced(ctx, mesh, data);
  assert.equal(inst.count, 2); assert.ok(inst.instanced);
  near(inst.bounds.min[0], -10 - mesh.bounds.radius, 1e-4); near(inst.bounds.max[0], 10 + mesh.bounds.radius, 1e-4);
  const lib = G.shaders(ctx);
  assert.ok(lib.standard && lib.unlit && lib.sky && lib.particles && lib.shadow && lib.post && lib.standardInstanced);
  assert.equal(G.shaders(ctx), lib, 'cached per context');
});

test('drawList: opaque front-to-back, custom pre/post by order, transparent back-to-front', () => {
  const { canvas, log } = mockCanvas();
  const ctx = G.createContext(canvas);
  const mk = () => G.createMesh(ctx, geo.box(1, 1, 1));
  const at = (z) => mat4.fromTranslation(mat4.create(), [0, 0, -z]);
  const meshes = {};
  const items = [];
  [['o30', 30], ['o10', 10], ['o20', 20]].forEach(([n, z]) => { meshes[n] = mk(); items.push({ mesh: meshes[n], model: at(z), material: { color: [1, 1, 1, 1] } }); });
  [['t5', 5], ['t50', 50]].forEach(([n, z]) => { meshes[n] = mk(); items.push({ mesh: meshes[n], model: at(z), material: { color: [1, 1, 1, 0.5], transparent: true } }); });
  items.push({ kind: 'post', order: 30, draw: () => log.push('custom:post') });
  items.push({ kind: 'pre', order: 10, draw: () => log.push('custom:pre') });
  items.push(null, { mesh: mk(), visible: false });
  const cam = { view: mat4.create(), proj: mat4.perspective(mat4.create(), 1, 1, 0.1, 100), position: [0, 0, 0] };
  // first call creates the VAOs lazily; record the second
  G.drawList(ctx, items, cam, { sunDir: [0, 1, 0] });
  log.length = 0;
  const n = G.drawList(ctx, items, cam, { sunDir: [0, 1, 0] });
  assert.equal(n, 7);
  const vaoTag = {};
  for (const k in meshes) vaoTag[meshes[k].vao.tag] = k;
  const order = log.filter((e) => e.startsWith('vao:') || e.startsWith('custom:')).map((e) => (e.startsWith('vao:') ? vaoTag[e.slice(4)] : e)).filter(Boolean);
  assert.deepEqual(order, ['o10', 'o20', 'o30', 'custom:pre', 't50', 't5', 'custom:post']);
  // depth-only pass skips transparent items and custom draws
  log.length = 0;
  const sm = G.createShadowMap(ctx, 1024);
  assert.ok(sm.render(items, { center: [0, 0, -20], sunDir: [0.3, 1, 0.2], radius: 60 }));
  assert.ok(sm.valid);
  assert.equal(log.filter((e) => e === 'drawElements').length, 3);
  assert.ok(!log.includes('custom:pre'));
});
