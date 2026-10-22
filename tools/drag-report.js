// 1/4-mile ET / trap of stock-spec cars in the drag sim vs real-world magazine figures (docs/DRAG-SPEC.md §7).
// usage: node tools/drag-report.js [--prepped] [model ids...]
const fs = require('fs'), path = require('path'); const root = path.join(__dirname, '..');
['js/util.js', 'js/data.js', 'js/shapes/core.js'].forEach(p => require(path.join(root, p)));
fs.readdirSync(root + '/js/shapes/models').filter(f => f.endsWith('.js')).sort().forEach(f => require(root + '/js/shapes/models/' + f));
['js/shapes/stock-specs.js', 'js/state.js', 'js/physics.js', 'js/rules.js', 'js/race/vehicle.js', 'js/drag/drag-strip.js', 'js/drag/drag-tree.js',
  'js/drag/drag-timing.js', 'js/drag/drag-launch.js', 'js/drag/drag-ai.js', 'js/drag/drag-session.js'].forEach(p => require(path.join(root, p)));
const CB = globalThis.CB, args = process.argv.slice(2), prepped = args.includes('--prepped'), ids = args.filter(a => !a.startsWith('--'));
// real 1/4 mile ET (s) @ trap (mph): published instrumented tests (Car and Driver / MotorTrend), rounded
const REAL = {
  'tesla-model-s-2021': [11.2, 119, 'Tesla Model S Long Range (2021)'], 'bugatti-chiron': [9.4, 156, 'Bugatti Chiron'],
  'porsche-911-992': [11.3, 124, 'Porsche 911 Carrera S (992)'], 'bmw-m4-g82': [11.7, 122, 'BMW M4 Competition (G82)'],
  'honda-civic-type-r-fl5': [13.4, 108, 'Honda Civic Type R (FL5)'], 'dodge-challenger-srt-hellcat': [11.8, 125, 'Dodge Challenger SRT Hellcat'],
  'chevrolet-camaro-zl1-2019': [11.4, 127, 'Chevrolet Camaro ZL1 (10AT)'], 'ford-f150-raptor-gen3': [14.3, 97, 'Ford F-150 Raptor (gen 3)'],
  'mercedes-sprinter-vs30': [18.3, 77, 'Mercedes Sprinter 2.0 diesel'], 'nissan-gtr-r35': [11.1, 124, 'Nissan GT-R (R35)'],
  'chevrolet-corvette-c8': [11.2, 123, 'Chevrolet Corvette C8 Z51'], 'ford-mustang-gt-s650': [12.4, 116, 'Ford Mustang GT (S650, manual)'],
  'vw-golf-gti-mk8': [14.0, 101, 'VW Golf GTI (Mk8)']
};
const pad = (s, w) => String(s).padEnd(w);
console.log('| Car | Real ET @ mph | Game ET @ mph | ET Δ | trap Δ | RT / 60 ft |'); console.log('|---|---|---|---|---|---|');
let sum = 0, n = 0;
(ids.length ? ids : Object.keys(REAL)).forEach(id => {
  const r = CB.drag.session.simulate({ seed: 2, surface: prepped ? 'prepped' : 'street', skipBurnout: !prepped, distanceId: 'quarter',
    lanes: [{ kind: 'ai', build: CB.stock.build(id).build, difficulty: 'alien' }, { kind: 'none' }] }).lanes[0];
  const real = REAL[id] || [NaN, NaN, id], mph = r.trap * 2.2369363, dE = (r.et - real[0]) / real[0] * 100, dT = (mph - real[1]) / real[1] * 100;
  if (isFinite(dE)) { sum += Math.abs(dE); n++; }
  console.log(`| ${real[2]} | ${real[0]} @ ${real[1]} | ${r.et.toFixed(2)} @ ${mph.toFixed(1)} | ${dE >= 0 ? '+' : ''}${dE.toFixed(1)} % | ${dT >= 0 ? '+' : ''}${dT.toFixed(1)} % | ${r.rt.toFixed(3)} / ${r.splits[0].t.toFixed(2)} |`);
});
console.log(`mean |ET Δ| ${(sum / n).toFixed(1)} % (${prepped ? 'prepped strip + burnout' : 'street surface, no burnout'}, alien AI driver, manual shifts at the optimal point)`);
