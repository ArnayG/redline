// Garage (CB.physics) vs race model (CB.race.vehicle.simulateLaunch) vs factory 0-100 km/h for every stock spec + presets.
// usage: node tools/launch-report.js [--presets] [--trace] [model ids...]
const fs=require('fs'),path=require('path');const root=path.join(__dirname,'..');
['js/util.js','js/data.js','js/shapes/core.js'].forEach(p=>require(path.join(root,p)));
fs.readdirSync(root+'/js/shapes/models').filter(f=>f.endsWith('.js')).sort().forEach(f=>require(root+'/js/shapes/models/'+f));
['js/shapes/stock-specs.js','js/state.js','js/physics.js','js/rules.js','js/race/vehicle.js'].forEach(p=>require(path.join(root,p)));
const CB=globalThis.CB,K=CB.stock,D=CB.data,V=CB.race.vehicle;
const args=process.argv.slice(2), ids=args.filter(a=>!a.startsWith('--')), trace=args.includes('--trace');
const pad=(s,w)=>String(s).padEnd(w);
let n=0,okG=0,okR=0,okGR=0,sumAbs=0,worst=[];
function row(id,b,real){
  const m=CB.physics.compute(b), p=V.fromBuild(b,m), r=V.simulateLaunch(p,100,{trace:trace});
  const g=m.zeroTo100_s, t=r.t;
  n++; if(real!=null&&Math.abs(g-real)<=0.3)okG++; if(real!=null&&t!=null&&Math.abs(t-real)<=0.3)okR++; if(t!=null&&Math.abs(t-g)<=0.3)okGR++;
  if(t!=null) sumAbs+=Math.abs(t-g)/g;
  console.log(pad(id,34),pad(real==null?'-':real,6),pad(g,6),pad(t==null?'null':t.toFixed(2),6),pad(t==null?'':((t-g>=0?'+':'')+(t-g).toFixed(2)),7),
    b.drivetrain.layout,b.transmission.type+b.transmission.gears,'lc'+(b.transmission.launchControl?1:0),'tc'+b.drivetrain.tractionControl,b.tires.compound,Math.round(m.power_hp)+'hp',m.weight_kg+'kg',m.zeroTo60_note);
  if(trace) console.log('   ',r.trace.filter((x,i)=>i%5==0).map(x=>x.t.toFixed(2)+':'+x.kph.toFixed(0)+'/g'+x.gear+'/'+Math.round(x.rpm)).join(' '));
}
console.log(pad('model',34),pad('real',6),pad('garage',6),pad('race',6),pad('r-g',7));
if(!args.includes('--presets-only')) CB.shapes.list().filter(m=>m.ref&&D.bodyStyles.some(s=>s.id===m.style)&&(!ids.length||ids.includes(m.id))).forEach(m=>{const r=K.build(m.id); if(r) row(m.id,r.build,r.target.zeroTo100_s);});
if(args.includes('--presets')||args.includes('--presets-only')) D.presets.forEach(pr=>{const b=CB.state.normalize(CB.util.deepMerge(D.defaultBuild(),pr.build)); row('preset:'+pr.id,b,null);});
console.log(`n ${n}  garage±0.3 ${okG}  race±0.3 ${okR}  race-vs-garage±0.3 ${okGR}  mean|r-g|/g ${(sumAbs/n*100).toFixed(1)}%`);
