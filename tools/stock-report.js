// Real-vs-computed table for every stock spec (CB.stock): power, kerb weight, 0-100 km/h, top speed.
// usage: node tools/stock-report.js [--bd] [model ids...]
const fs=require('fs'),path=require('path');const root=path.join(__dirname,'..');
['js/util.js','js/data.js','js/shapes/core.js'].forEach(p=>require(path.join(root,p)));
fs.readdirSync(root+'/js/shapes/models').filter(f=>f.endsWith('.js')).sort().forEach(f=>require(root+'/js/shapes/models/'+f));
['js/shapes/stock-specs.js','js/state.js','js/physics.js','js/rules.js'].forEach(p=>require(path.join(root,p)));
const CB=globalThis.CB,K=CB.stock,D=CB.data;
const args=process.argv.slice(2), bd=args.includes('--bd'), ids=args.filter(a=>!a.startsWith('--'));
const models=CB.shapes.list().filter(m=>m.ref&&D.bodyStyles.some(s=>s.id===m.style)&&(!ids.length||ids.includes(m.id)));
let n=0,ok={hp:0,kg:0,s:0,v:0},rows=[];
const pad=(s,w)=>String(s).padEnd(w);
models.forEach(m=>{const t0=Date.now();const r=K.build(m.id);const x=r.metrics,t=r.target,b=r.build;
 const dh=(x.hp-t.hp)/t.hp*100,dk=(x.kg-t.kg)/t.kg*100,ds=x.zeroTo100_s-t.zeroTo100_s,dv=(x.topSpeed_kph-t.topSpeed_kph)/t.topSpeed_kph*100;
 n++; if(Math.abs(dh)<=3)ok.hp++; if(Math.abs(dk)<=3)ok.kg++; if(Math.abs(ds)<=0.3)ok.s++; if(Math.abs(dv)<=5)ok.v++;
 const full=CB.physics.compute(b);
 const errs=(CB.rules.validate(b).issues||CB.rules.validate(b)).filter(i=>i.severity==='error').map(i=>i.id);
 console.log(pad(m.id,34),pad(t.hp+'/'+Math.round(x.hp),10),pad((dh>=0?'+':'')+dh.toFixed(0)+'%',5),pad(t.kg+'/'+x.kg,10),pad((dk>=0?'+':'')+dk.toFixed(0)+'%',5),pad(t.zeroTo100_s+'/'+x.zeroTo100_s,10),pad(t.topSpeed_kph+'/'+Math.round(x.topSpeed_kph)+' '+full.topSpeedLimitedBy,16),
  'fd'+b.transmission.finalDrive,'bal'+b.weight.ballast_kg, b.body.chassisMaterial, (b.body.construction||''), (b.engine.speedLimiter_kph!=null?'lim'+b.engine.speedLimiter_kph:''),(b.tires.speedRating||''), full.zeroTo60_note, errs.join(','), (Date.now()-t0)+'ms');
 if(bd) console.log('   ',JSON.stringify(full.weightBreakdown), 'cda',full.cda,'mu',full.gripRear);
});
console.log(`within: hp±3% ${ok.hp}/${n}  kg±3% ${ok.kg}/${n}  0-100±0.3 ${ok.s}/${n}  vmax±5% ${ok.v}/${n}`);
