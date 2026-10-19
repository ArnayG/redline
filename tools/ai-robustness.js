// AI robustness sweep: the race AI drives the player's car (autopilot, solo practice) for one flying lap per circuit and
// reports off-track time / wall hits / resets for a sample of stock specs and presets, optionally with mass / grip / drag
// variation applied to the vehicle (the AI is NOT told: it must adapt).
// usage: node tools/ai-robustness.js [--all] [--mass=-20,0,20 (%)] [--grip=0.9] [--drag=1.2] [--ballast=20 (kg)]
//        [--tracks=a,b] [--cars=a,b] [--laps=2] [--model-physics]
const fs = require('fs'), path = require('path'); const root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/shapes/core.js'].forEach(p => require(path.join(root, p)));
fs.readdirSync(root + '/js/shapes/models').filter(f => f.endsWith('.js')).sort().forEach(f => require(root + '/js/shapes/models/' + f));
['js/shapes/stock-specs.js', 'js/state.js', 'js/physics.js', 'js/race/tracks.js', 'js/race/tracks-extra.js', 'js/race/vehicle.js',
  'js/race/ai.js', 'js/race/engine.js'].forEach(p => require(path.join(root, p)));
const CB = globalThis.CB, E = CB.race.engine, T = CB.race.tracks, D = CB.data;
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const all = process.argv.includes('--all');
const SAMPLE = ['range-rover-sport-l461', 'mercedes-sprinter-vs30', 'ford-f150-raptor-gen3', 'tesla-cybertruck', 'bugatti-chiron',
  'mazda-mx5-nd', 'porsche-911-992', 'koenigsegg-jesko', 'vw-golf-gti-mk8'];
const stockIds = all ? CB.shapes.list().filter(m => m.ref && CB.stock.has(m.id)).map(m => m.id) : SAMPLE;
const cars = (arg('cars') ? arg('cars').split(',') : stockIds.concat(all ? D.presets.map(p => 'preset:' + p.id) : []));
const masses = arg('mass', '0').split(',').map(Number), grip = +arg('grip', 1), drag = +arg('drag', 1), ballast = +arg('ballast', 0);
const tracks = arg('tracks') ? arg('tracks').split(',') : T.list.map(d => d.id);
const laps = +arg('laps', 1);
function buildOf(id, dm) {
  let b = id.startsWith('preset:') ? D.presetBuild(id.slice(7)) : CB.stock.build(id).build;
  b = CB.util.deepClone(b);
  if (ballast) { b.weight.ballast_kg = Math.max(0, Math.min(100, (b.weight.ballast_kg || 0) + ballast)); }
  if (process.argv.includes('--model-physics')) b.body.modelPhysics = true;
  return CB.state.normalize(b);
}
function run(id, tid, dm) {
  const b = buildOf(id, dm);
  const k = 1 + dm / 100, cache = {};
  const hook = (dm || grip !== 1 || drag !== 1) ? {
    vehicleParams: function (car, p) {
      if (cache.src !== p) { const q = Object.assign({}, p); q.mass = p.mass * k; q.Iz = p.Iz * k; q.cdA = p.cdA * drag; q.muF = p.muF * grip; q.muR = p.muR * grip; cache.src = p; cache.q = q; }
      return cache.q;
    }
  } : null;
  const s = E.createSession({ trackId: tid, mode: 'practice', laps: 0, opponents: 0, playerBuild: b, playerAutopilot: true, seed: 7, stuckDnf_s: 0, hooks: hook ? [hook] : undefined });
  const geom = s.geom, L = geom.length || geom.total || 3000;
  let off = 0, maxOff = 0, walls = 0, resets = 0, t = 0, lapTimes = [];
  const tMax = Math.max(120, L / 12) * (laps + 0.6);
  while (t < tMax) {
    s.update(0.05, {}); t += 0.05;
    const sn = s.snapshot(), me = sn.cars.find(c => c.isPlayer);
    (sn.events || []).forEach(e => { if (e.carId === me.id && e.type === 'wall') walls++; if (e.carId === me.id && /reset/.test(e.type)) resets++; });
    if (me.offTrack) off += 0.05;
    if (me.lap >= laps + 1) break;
  }
  const r = s.results(), me = r.classification.find(c => c.isPlayer);
  return { laps: me.laps, lapTimes: me.lapTimes, off: off, walls: walls, resets: resets, tl: me.trackLimits };
}
let bad = 0, n = 0; const t0 = Date.now();
cars.forEach(id => masses.forEach(dm => {
  const row = [];
  tracks.forEach(tid => {
    const x = run(id, tid, dm); n++;
    const ok = x.laps >= laps && x.off < 1.0 && x.walls === 0 && x.resets === 0;
    if (!ok) bad++;
    row.push(tid.slice(0, 10) + (ok ? ' ok ' : ' !! ') + (x.lapTimes.length ? x.lapTimes[x.lapTimes.length - 1].toFixed(1) : '-') + (x.off ? ' off' + x.off.toFixed(1) : '') + (x.walls ? ' w' + x.walls : '') + (x.resets ? ' r' + x.resets : ''));
  });
  console.log((id + (dm ? (dm > 0 ? ' +' : ' ') + dm + '%' : '')).padEnd(34), row.join(' | '));
}));
console.log('runs', n, 'failing', bad, ((Date.now() - t0) / 1000).toFixed(0) + 's');
