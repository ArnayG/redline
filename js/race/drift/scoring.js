/* ==========================================================================
   FORGE Atelier — js/race/drift/scoring.js
   CB.race.drift.scoring : drift scorer for Drift mode (DRIFT-SPEC.md §3). Pure, no DOM.

   API
     createScorer(geom, trackDef, opts) -> scorer
       opts: { zones?: [...]   explicit zone list (replaces auto-generation)
               difficulty?: 'easy'|'normal'|'hard'|'pro' | 1..5 (default 'normal')
               duration_s?: run length used for medal targets (default 120), laps?: alternative
               targets?: { bronze, silver, gold, platinum }  (else trackDef.driftTargets / medals, else auto)
               playerId?: id of the scored car (events of other cars are ignored)
               lead?: car | function () -> car   tandem lead car (see setLead)
               carLength_m?, carWidth_m?, …any key of DEFAULTS to override tuning }
     scorer.update(car, dt, events) -> state()
       car: player vehicle state. Accepted shapes (any mix):
         assist/playerState  { speed, vxLocal, vyLocal, yawRate, heading, x?, y? }
         engine snapshot car { id, x, y, heading, vx, vy (WORLD m/s), speed, s, lateral, surface, offTrack, onTrack, wrongWay, length_m, width_m }
         optional car.proj   tracks.project result (s, lateral, heading, wallDist, onTrack, surface)
       events: any of
         - array of engine events ({type:'wall'|'collision'|'reset'|…, carId, intensity, value})
         - a full engine snapshot ({ cars, events }) — events are taken from it, the tandem lead is the
           nearest non-player car
         - a context object { events?, lead?, proj?, wallDist_m?, offTrack?, crash?: reason, backwards? }
     scorer.state()   -> { total, current, combo, multiplier, angle_deg, speed, grade, zones:[{id,s,side,kind,hit,…}],
                           lastEvent:{text, points, kind, color, t, seq}, …extra HUD fields }
     scorer.results() -> { total, bestDrift, longestDrift_s, maxAngle_deg, maxCombo, zonesHitPct, medal, targets, … }
                         (banks the open drift first; idempotent)
     scorer.reset(), scorer.finish(), scorer.setLead(carOrFn), scorer.setAssistLevel(level), scorer.zones, scorer.targets
       opts.assistLevel ('off'|'light'|'medium'|'heavy', default 'heavy') picks the forgiveness preset AND the medal scale
       (targets are heavy-scale; lower assist levels scale them down). Without it, ctx.assistLevel / car.assistLevel /
       snapshot.drift.assistLevel passed to update() are adopted.

   Helpers: generateZones(geom, trackDef, opts), medalTargets(geom, trackDef, opts), medalFor(total, targets),
            gradeFor(points, difficulty), angleFactor(deg), speedFactor(v), smoothnessFactor(dev_deg), driftAngle(car),
            DEFAULTS, GRADES, MEDALS

   Rules (all tunable through opts):
     points/s = basePoints × angleFactor(β: 15-70°, sweet spot 30-50°) × speedFactor(v) × smoothness × bonuses × multiplier
     a drift starts at |β| ≥ 15° above 30 km/h and ends after 0.6 s below 10°; ending normally BANKS it into the total
     combo multiplier: +0.1 per 2 s of drifting (plus +0.1 per swing / clipping zone), max ×5; after 1.5 s without a
       drift it decays back to ×1 (and the chain count resets)
     bonuses: clipping zones (inner apex / outer exit, auto-generated from curvature, quality = proximity),
       close-to-wall rate bonus, swing/manji transitions, long drift (4/8/12 s), entry speed, tandem proximity
     penalties: spin (|β| > 110° → drift lost, multiplier halved), wall hit (drift + combo lost),
       off-track (drift banked at half), going backwards (drift + combo lost)
     grades per drift: C / B / A / S / SS ; medals per track: bronze / silver / gold / platinum
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
CB.race = CB.race || {};
CB.race.drift = CB.race.drift || {};

CB.race.drift.scoring = (function () {
  'use strict';

  var PI = Math.PI, TAU = PI * 2, DEG = PI / 180, KPH = 3.6;

  /* ------------------------------------------------------------------ utils */
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return clamp(v, 0, 1); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function mod(a, n) { return ((a % n) + n) % n; }
  function wrapAngle(a) { a = a % TAU; if (a > PI) a -= TAU; else if (a < -PI) a += TAU; return a; }
  function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
  function assign(t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined) t[k] = s[k];
    }
    return t;
  }
  function fmt(n) {
    var s = String(Math.round(Math.abs(n))), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '-' : '') + s + out;
  }
  function round(v, d) { var m = Math.pow(10, d || 0); return Math.round(v * m) / m; }

  /* --------------------------------------------------------------- tuning */
  var DEFAULTS = {
    basePoints: 100,            // points/s at angleFactor 1, speedFactor 1, smoothness 1, ×1
    refSpeed: 20,               // m/s (72 km/h) where speedFactor = 1
    speedExponent: 1.1,
    maxSpeedFactor: 3,
    minSpeed_kph: 30,           // below this nothing scores and drifts cannot start
    startAngle_deg: 15,         // drift starts / scores from here
    endAngle_deg: 10,           // hysteresis: below this the grace timer runs
    maxScoreAngle_deg: 70,      // no points above (but the drift stays alive until spin)
    spinAngle_deg: 110,
    recoverAngle_deg: 60,       // after a spin a new drift needs |β| below this first
    grace_s: 0.6,
    holdSpeedFactor: 1,         // an ESTABLISHED drift stays alive (and keeps scoring) down to minSpeed_kph × this
    spinConfirm_s: 0,           // |β| must stay above spinAngle_deg this long before it counts as a spin (filters 1-frame spikes)
    // feel-good feedback (no effect on the spec rules; set false / 0 to disable)
    saveMin_s: 0.35,            // a drift that was this deep into its grace timer and recovers = "SAVED!"
    saveBonus: 150,
    sweetHold_s: 3,             // every this many seconds held continuously in the 30-50° sweet spot = "PERFECT ANGLE"
    sweetBonus: 200,
    milestones: [2000, 5000, 10000, 20000, 40000, 80000],   // current-drift point milestones announced live
    comboEvents: true,          // "×2 COMBO!" popups when the multiplier crosses a whole number
    // combo
    multiplierStep: 0.1,
    multiplierStepTime_s: 2,
    multiplierMax: 5,
    comboDecayDelay_s: 1.5,
    comboDecayRate: 1.0,        // multiplier lost per second once decaying
    swingMultiplierSteps: 1,
    zoneMultiplierSteps: 1,
    spinMultiplierKeep: 0.5,
    // bonuses
    transitionWindow_s: 1.0,    // a drift in the other direction started within this after the last one = swing
    transitionBonus: 250,
    manjiWindow_s: 4,           // 3+ swings inside this window = MANJI
    manjiBonus: 400,
    manjiRepeatFactor: 0.5,     // every further MANJI in the same chain pays this × the previous one (diminishing returns)
    swingMinAngle_deg: 25,      // a swing only pays when the old side reached this angle AND the new side reaches it too
    swingConfirm_s: 1.0,        // …within this long after the flip (else the flick fizzles: no bonus)
    swingMultMax: 1.0,          // most multiplier one drift can gain from swings (10 swing steps)
    swingRoadGate: false,       // (heavy/auto) a swing only pays when the ROAD changed direction since the last paid swing
                                // and the new slide matches the corner, or inside a swing zone
    swingRoadWindow_s: 3,       // the road flip must have happened within this long before the swing
    roadCurvature: 1 / 130,     // |mean curvature| (1/m) of the road around the car above which it counts as a corner
    counterCurvature: 1 / 220,  // |mean curvature| (1/m) from which sliding the wrong way round counts
    counterDirFactor: 0.4,      // points/s (and zone points) × this while sliding the wrong way round a corner (needs track geometry)
    counterDirDelay_s: 0.5,     // …after this long (a late flick into the next corner is not punished)
    timeMultiplierCap: 0,       // >0: time held alone only grows the combo to this; zones / paid swings raise the ceiling
    earnedCeilingStep: 0.2,     // ceiling added per zone hit (×2 per paid swing) in the current combo chain
    longDrift: [[4, 300, 'LONG DRIFT!'], [8, 800, 'MARATHON DRIFT!'], [12, 1500, 'ENDLESS DRIFT!']],
    entrySpeedMin_kph: 60,
    entrySpeedPts_per_kph: 8,
    entryConfirm_s: 0.6,        // the entry bonus is paid once the drift has been held this long
    wallProximity_m: 1.5,       // gap between the car body and the wall
    wallProximityMult: 0.6,     // rate × (1 + this × closeness)
    tandemRange_m: 14,
    tandemClose_m: 3,
    tandemMult: 0.8,
    zoneTolerance_m: 3.2,
    zoneBasePoints: 400,
    perfectClip: 0.8,
    // penalties
    wallHitSpeed: 2.5,          // m/s normal impact speed (engine "wall" event value) that counts as a hit; lighter = scrape (forgiven)
    wallScrapeSpeed: 1.2,       // lighter wall contact than wallHitSpeed: a SCRAPE — the drift survives, multiplier −wallScrapeLoss
    wallScrapeLoss: 0.2,
    wallScrapeCooldown_s: 0.6,
    collisionIntensity: 0.25,   // engine 'collision' intensity that counts as contact (combo lost)
    offTrackBankFactor: 0.5,
    offTrackMargin_m: 2.5,      // metres beyond the asphalt edge (kerbs + tarmac) still treated as on track
    backwardsSpeed: 1.5,        // m/s against the race direction
    backwards_s: 0.6,
    // smoothness
    smoothDevRef_deg: 12,
    smoothMin: 0.7,
    smoothMax: 1.1,
    // car
    carLength_m: 4.4,
    carWidth_m: 1.85,
    // coaching hints in state().coach (short arrow-key tips for the HUD); false disables
    coach: true
  };

  /* Forgiveness presets keyed by the steering-assist level (the game default is 'heavy' → the most forgiving).
     They only loosen timing / tolerance knobs so assisted arrow-key drivers are not punished for the small
     wobbles the assist produces; the spec scoring rules (angle window, ×0.1 per 2 s, ×5 cap, 1.5 s decay,
     110° spin, half bank off-track) are identical at every level. Explicit opts always win. */
  /* "Keeping" a drift on arrows: the assist's angle hold wobbles a few degrees and dips through ~10° when it
     straightens for a correction, so on medium/heavy an established drift survives a longer, shallower dip
     (lower end angle, longer grace, lower hold speed), assist wobble costs less smoothness, and a single-frame
     β spike past 110° is not a spin unless it is sustained. Grace always stays below the 1.5 s combo decay.
     swingMinAngle_deg is relative to the assist: heavy/auto hold the slide near their target angle (~23-25° on the
     default build), so a 25° gate would almost never pay a transition; heavy keeps the road gate as the anti-farm
     guard instead (a flick only pays when the road itself changed direction). */
  var FORGIVENESS = {
    off: {},
    light: { swingMinAngle_deg: 25, grace_s: 0.7, wallHitSpeed: 3, offTrackMargin_m: 2.75, transitionWindow_s: 1.1, spinConfirm_s: 0.05 },
    medium: { swingMinAngle_deg: 20, grace_s: 0.95, endAngle_deg: 8, holdSpeedFactor: 0.8, wallHitSpeed: 3.75, offTrackMargin_m: 3, transitionWindow_s: 1.25,
      minSpeed_kph: 27, zoneTolerance_m: 3.6, backwards_s: 0.75, smoothMin: 0.78, smoothDevRef_deg: 15, spinConfirm_s: 0.1 },
    heavy: { swingMinAngle_deg: 15, grace_s: 1.2, endAngle_deg: 6, holdSpeedFactor: 0.65, wallHitSpeed: 5, offTrackMargin_m: 3.5, transitionWindow_s: 1.4,
      minSpeed_kph: 25, zoneTolerance_m: 4.0, backwards_s: 0.9, recoverAngle_deg: 75, smoothMin: 0.85, smoothDevRef_deg: 18,
      spinConfirm_s: 0.18, swingRoadGate: true, timeMultiplierCap: 2.5, collisionIntensity: 0.4 }
  };
  // 'auto' (Up alone drifts, the arcade helper picks the direction) forgives like heavy
  FORGIVENESS.auto = assign({}, FORGIVENESS.heavy);
  function assistLevelOf(opts) {
    var a = opts && (opts.assistLevel != null ? opts.assistLevel : opts.assist != null ? opts.assist : opts.forgiveness);
    if (a && typeof a === 'object') a = a.level;
    if (a === false || a === 0) return 'off';
    a = String(a == null ? 'heavy' : a).toLowerCase();
    return FORGIVENESS[a] ? a : 'heavy';
  }
  function resolveOptions(opts) {
    opts = opts || {};
    var lvl = assistLevelOf(opts);
    var o = assign({}, DEFAULTS, FORGIVENESS[lvl], opts);
    o.assistLevel = lvl;
    // a drift in its grace period must never outlive the combo (decay starts at comboDecayDelay_s of no drift)
    if (o.grace_s > o.comboDecayDelay_s - 0.1) o.grace_s = Math.max(0.05, o.comboDecayDelay_s - 0.1);
    if (o.endAngle_deg > o.startAngle_deg) o.endAngle_deg = o.startAngle_deg;
    o.holdSpeedFactor = clamp(num(o.holdSpeedFactor, 1), 0.3, 1);
    return o;
  }

  var GRADES = [
    { id: 'C', min: 0, label: 'NICE', color: '#c8d0da' },
    { id: 'B', min: 1000, label: 'GOOD', color: '#7dd3ff' },
    { id: 'A', min: 3000, label: 'GREAT', color: '#7dffb0' },
    { id: 'S', min: 7000, label: 'AWESOME', color: '#ffd84d' },
    { id: 'SS', min: 15000, label: 'INSANE', color: '#ff6bd6' }
  ];
  var MEDALS = ['bronze', 'silver', 'gold', 'platinum'];
  var MEDAL_FRACTIONS = { bronze: 0.2, silver: 0.5, gold: 1, platinum: 1.75 };
  /* Medal targets are on the HEAVY-assist scale (the game default: arcade drift helper + angle hold). Measured with
     Node bots over full timed runs on the drift tracks (novice "arrow into each corner" bot / random arrow masher):
       heavy  ≈ 47k-113k novice, 106k-237k masher   (authored track medals 15k…200k sit right on this scale)
       medium ≈ 0.5k-7k   light/off ≈ 0-0.4k (bots; humans do better, but the gap is an order of magnitude)
     so lower assist levels scale every target down — the medal still means the same thing at every level. */
  var ASSIST_TARGET_SCALE = { auto: 1, heavy: 1, medium: 0.12, light: 0.07, off: 0.05 };
  /** potential estimate (pre-medal-fraction) × this = heavy-scale potential (see the calibration note above) */
  var HEAVY_POT_SCALE = 8.8;

  function difficultyScale(d) {
    if (isNum(d)) return clamp(0.7 + (d - 1) * 0.175, 0.6, 1.5);   // 1 → 0.7 … 3 → 1.05 … 5 → 1.4
    switch (String(d || 'normal').toLowerCase()) {
      case 'easy': case 'beginner': return 0.75;
      case 'hard': return 1.25;
      case 'pro': case 'expert': case 'competition': return 1.5;
      default: return 1;
    }
  }

  /* ------------------------------------------------------- scoring curves */
  /** angle factor: 0 below 15°, ramps to 1 at 30°, sweet spot 30-50° (peak 1.15 at 40°), fades to 0.4 at 70°, 0 above. */
  function angleFactor(deg, o) {
    o = o || DEFAULTS;
    var b = Math.abs(num(deg, 0));
    var a0 = o.startAngle_deg, a1 = o.maxScoreAngle_deg;
    if (b < a0 || b > a1) return 0;
    if (b < 30) return lerp(0.3, 1, smoothstep((b - a0) / Math.max(1e-6, 30 - a0)));
    if (b <= 40) return lerp(1, 1.15, (b - 30) / 10);
    if (b <= 50) return lerp(1.15, 1, (b - 40) / 10);
    return lerp(1, 0.4, (b - 50) / Math.max(1e-6, a1 - 50));
  }
  function speedFactor(v, o) {
    o = o || DEFAULTS;
    return clamp(Math.pow(Math.max(0, num(v, 0)) / o.refSpeed, o.speedExponent), 0, o.maxSpeedFactor);
  }
  /** dev_deg = running mean absolute deviation of β from its smoothed value (deg). */
  function smoothnessFactor(dev, o) {
    o = o || DEFAULTS;
    return lerp(o.smoothMax, o.smoothMin, clamp01(num(dev, 0) / o.smoothDevRef_deg));
  }
  function gradeFor(points, difficulty) {
    var k = difficultyScale(difficulty), g = GRADES[0];
    for (var i = 0; i < GRADES.length; i++) if (points >= GRADES[i].min * k) g = GRADES[i];
    return g;
  }

  /** Signed drift angle β (rad): angle of the velocity vector relative to the nose, + = velocity left of the nose. */
  function driftAngle(car) {
    if (!car) return 0;
    var spd = num(car.speed, null);
    if (isNum(car.vxLocal) && isNum(car.vyLocal)) {
      if (Math.hypot(car.vxLocal, car.vyLocal) < 0.5) return 0;
      return Math.atan2(car.vyLocal, car.vxLocal);
    }
    if (isNum(car.vx) && isNum(car.vy) && isNum(car.heading)) {
      if (Math.hypot(car.vx, car.vy) < 0.5) return 0;
      return wrapAngle(Math.atan2(car.vy, car.vx) - car.heading);
    }
    if (isNum(car.beta)) return car.beta;
    if (isNum(car.slipR) && (spd === null || spd > 0.5)) return -car.slipR;
    if (isNum(car.slipAngleR) && (spd === null || spd > 0.5)) return -car.slipAngleR;
    return 0;
  }
  function worldVel(car) {
    if (!car) return null;
    if (isNum(car.vx) && isNum(car.vy) && !isNum(car.vxLocal)) return [car.vx, car.vy];
    if (isNum(car.vxLocal) && isNum(car.vyLocal) && isNum(car.heading)) {
      var c = Math.cos(car.heading), s = Math.sin(car.heading);
      return [c * car.vxLocal - s * car.vyLocal, s * car.vxLocal + c * car.vyLocal];
    }
    if (isNum(car.vx) && isNum(car.vy)) return [car.vx, car.vy];
    return null;
  }
  function speedOf(car) {
    if (!car) return 0;
    if (isNum(car.speed)) return Math.abs(car.speed);
    var w = worldVel(car);
    return w ? Math.hypot(w[0], w[1]) : 0;
  }

  /* ================================================================ ZONES
     Corners are detected from the sampled centerline curvature (signed 1/m, + = left turn). Long corners
     (skidpads, hairpin chains) are split into ~90° chunks. Each chunk gets an INNER clipping zone at its
     apex on the inside edge; chunks turning ≥ 45° also get an OUTER zone on the exit, outside edge.
     trackDef.driftZones hints (if any) are added and suppress auto zones of the same kind nearby.
  ======================================================================== */
  function samplesOf(geom) {
    return geom && Array.isArray(geom.samples) && geom.samples.length > 3 && isNum(geom.samples[0].curvature) ? geom.samples : null;
  }
  function lengthOf(geom) {
    if (!geom) return 0;
    if (isNum(geom.length)) return geom.length;
    if (isNum(geom.length_m)) return geom.length_m;
    var S = samplesOf(geom);
    return S ? S[S.length - 1].s + num(geom.ds, 2) : 0;
  }
  function dsOf(geom) {
    var S = samplesOf(geom);
    if (isNum(geom.ds)) return geom.ds;
    return S ? lengthOf(geom) / S.length : 2;
  }
  function sampleAtS(geom, s) {
    var S = samplesOf(geom);
    if (!S) return null;
    return S[mod(Math.round(s / dsOf(geom)), S.length)];
  }
  function halfWidthAt(geom, s) {
    var sm = sampleAtS(geom, s);
    return sm ? num(sm.hw, num(sm.width, 14) / 2) : num(geom && geom.width_m, 14) / 2;
  }
  function pointAt(geom, s, lat) {
    if (geom && typeof geom.pointAt === 'function') {
      try { var p = geom.pointAt(s, lat); if (p && isNum(p.x)) return p; } catch (e) { /* fall through */ }
    }
    var sm = sampleAtS(geom, s);
    if (sm) {
      var h = num(sm.heading, 0);
      return { x: sm.x - Math.sin(h) * lat, y: sm.y + Math.cos(h) * lat, heading: h };
    }
    return { x: s, y: lat, heading: 0 };
  }

  /** Corner regions straight from the curvature samples: [{start, end, dir, turn_deg, len, chunks:[{i0, i1, apex, turn_deg}]}] */
  function detectCurves(geom, o) {
    var S = samplesOf(geom);
    if (!S) return [];
    var N = S.length, ds = dsOf(geom);
    var kTh = 1 / num(o.zoneMaxRadius_m, 160);
    var flags = new Array(N), i;
    for (i = 0; i < N; i++) { var k = S[i].curvature; flags[i] = Math.abs(k) > kTh ? sign(k) : 0; }
    var st = -1;
    for (i = 0; i < N; i++) if (!flags[i]) { st = i; break; }
    var regions = [], cur = null;
    if (st < 0) {
      // the whole loop is one curve (skidpad): one region spanning everything, same direction assumed
      regions.push({ dir: sign(S[0].curvature) || 1, start: 0, end: N - 1, len: N, loop: true });
    } else {
      for (var j = 1; j <= N; j++) {
        var idx = (st + j) % N, f = flags[idx];
        if (f && cur && cur.dir === f) { cur.end = idx; cur.len++; }
        else { if (cur) regions.push(cur); cur = f ? { dir: f, start: idx, end: idx, len: 1 } : null; }
      }
      if (cur) regions.push(cur);
      // merge same-direction regions separated by small gaps (compound corners)
      var gap = Math.max(1, Math.round(10 / ds)), merged = [];
      regions.forEach(function (r) {
        var p = merged[merged.length - 1];
        if (p && p.dir === r.dir && mod(r.start - p.end, N) <= gap) { p.end = r.end; p.len = mod(p.end - p.start, N) + 1; }
        else merged.push(r);
      });
      if (merged.length > 1) {
        var a = merged[0], z = merged[merged.length - 1];
        if (a.dir === z.dir && mod(a.start - z.end, N) <= gap) { z.end = a.end; z.len = mod(z.end - z.start, N) + 1; merged.shift(); }
      }
      regions = merged;
    }
    var chunkDeg = num(o.zoneChunk_deg, 90), out = [];
    regions.forEach(function (r) {
      var turn = 0, n = r.len;
      for (var q = 0; q < n; q++) turn += S[(r.start + q) % N].curvature * ds;
      var td = Math.abs(turn) / DEG;
      if (td < num(o.zoneMinTurn_deg, 20)) return;
      var nChunks = td > 150 ? Math.max(2, Math.round(td / chunkDeg)) : 1;
      var per = td / nChunks, chunks = [], acc = 0, c0 = 0;
      for (q = 0; q < n; q++) {
        acc += Math.abs(S[(r.start + q) % N].curvature) * ds / DEG;
        if ((acc >= per * (chunks.length + 1) - 1e-9 && chunks.length < nChunks - 1) || q === n - 1) {
          chunks.push({ q0: c0, q1: q }); c0 = q + 1;
        }
      }
      chunks = chunks.filter(function (c) { return c.q1 >= c.q0; }).map(function (c) {
        var kmax = 0, kmin = Infinity, apexQ = c.q0, t = 0;
        for (var u = c.q0; u <= c.q1; u++) {
          var kk = Math.abs(S[(r.start + u) % N].curvature);
          t += kk * ds;
          if (kk > kmax) { kmax = kk; apexQ = u; }
          if (kk < kmin) kmin = kk;
        }
        if (kmax > 0 && (kmax - kmin) / kmax < 0.15) apexQ = Math.round((c.q0 + c.q1) / 2);   // constant radius → middle
        return {
          i0: (r.start + c.q0) % N, i1: (r.start + c.q1) % N, apex: (r.start + apexQ) % N,
          len: (c.q1 - c.q0 + 1) * ds, turn_deg: t / DEG, minRadius: 1 / Math.max(kmax, 1e-6)
        };
      });
      out.push({ start: r.start, end: r.end, dir: r.dir, turn_deg: td, len: n * ds, chunks: chunks });
    });
    return out;
  }

  function normSide(side, dirNear, kind) {
    if (kind === 'swing') return 0;
    if (side === 'left' || side === 'L' || side === '+' || (isNum(side) && side > 0)) return 1;
    if (side === 'right' || side === 'R' || side === '-' || (isNum(side) && side < 0)) return -1;
    if (side === 'inner' || side === 'inside') return dirNear || 1;
    if (side === 'outer' || side === 'outside') return -(dirNear || 1);
    if (kind === 'outer') return -(dirNear || 1);
    return dirNear || 1;
  }
  function makeZone(geom, z, o) {
    var L = lengthOf(geom) || 1;
    var s = mod(z.s, L), len = Math.max(4, num(z.length, 16));
    var hw = halfWidthAt(geom, s), swingZ = z.kind === 'swing';
    var lateral = swingZ ? 0 : isNum(z.lateral) ? clamp(z.lateral, -(hw + 0.5), hw + 0.5) : z.sideSign * Math.max(0.5, hw - 0.8);
    var tol = Math.max(0.8, num(z.tolerance, swingZ ? hw : o.zoneTolerance_m / difficultyScale(o.difficulty)));
    var c = pointAt(geom, s, lateral);
    var lat0, lat1;
    if (swingZ) { lat0 = -hw; lat1 = hw; }
    else if (z.kind === 'point') { lat0 = lateral - tol; lat1 = lateral + tol; }
    else { lat0 = lateral - z.sideSign * Math.min(tol, Math.max(1, hw)); lat1 = lateral; }
    return {
      id: String(z.id), kind: z.kind, s: s, s0: mod(s - len / 2, L), s1: mod(s + len / 2, L), length: len,
      side: swingZ ? 'both' : z.sideSign > 0 ? 'left' : 'right', sideSign: z.sideSign, lateral: lateral, tolerance: tol,
      lat0: Math.min(lat0, lat1), lat1: Math.max(lat0, lat1),
      points: Math.round(num(z.points, o.zoneBasePoints)), corner: z.corner == null ? -1 : z.corner, label: z.label || null,
      x: c.x, y: c.y, heading: num(c.heading, 0), hint: !!z.hint,
      hit: false, quality: 0, hits: 0, passes: 0
    };
  }
  /**
   * One authored / supplied zone -> internal zone spec. Accepts the CB.race.drift.tracks shape
   * ({kind:'clip'|'zone'|'swing', clip:'inner'|'outer', side ±1, u, u0, u1 (lap fractions), lateral, radius, points, name})
   * as well as plain {kind:'inner'|'outer'|'point', s|u, s0/s1|length, side:'left'|'right'|±1, lateral, tolerance}.
   * Lap fractions win over metres (authored metres are layout metres, not built-geometry metres).
   */
  function normHint(geom, h, i, o) {
    var L = lengthOf(geom) || 1;
    var s0 = null, len = null, s = null;
    if (isNum(h.u0) && isNum(h.u1)) { s0 = h.u0 * L; len = mod(h.u1 - h.u0, 1) * L; }
    else if (isNum(h.s0) && isNum(h.s1) && !isNum(h.u)) { s0 = h.s0; len = mod(h.s1 - h.s0, L); }
    if (isNum(h.u)) s = h.u * L; else if (isNum(h.s)) s = h.s;
    if (s0 !== null && len > 0) s = s0 + len / 2;
    if (s === null) return null;
    if (!(len > 0)) len = num(h.length, num(h.len, null));
    var kind = h.kind;
    if (kind === 'clip' || kind === 'zone') kind = h.clip === 'outer' ? 'outer' : h.clip === 'inner' ? 'inner' : kind === 'zone' ? 'outer' : 'inner';
    if (kind !== 'inner' && kind !== 'outer' && kind !== 'point' && kind !== 'swing') kind = h.side === 'outer' || h.side === 'outside' ? 'outer' : 'inner';
    if (!(len > 0)) len = kind === 'point' ? 6 : kind === 'swing' ? 30 : 16;
    var sm = sampleAtS(geom, s), dirNear = isNum(h.dir) ? sign(h.dir) : sm ? sign(sm.curvature) : 0;
    var sideSign = isNum(h.sideSign) ? sign(h.sideSign) : normSide(h.side, dirNear, kind);
    if (!sideSign && kind !== 'swing') sideSign = kind === 'outer' ? -(dirNear || 1) : dirNear || 1;
    var tol = isNum(h.tolerance) ? h.tolerance : isNum(h.radius) ? h.radius : isNum(h.width) ? h.width / 2 : (kind === 'point' ? 2.2 : undefined);
    return { id: h.id || ('h' + (i + 1) + '-' + kind), kind: kind, s: s, sideSign: sideSign, length: len, lateral: h.lateral,
      points: isNum(h.points) ? h.points : o.zoneBasePoints * (kind === 'outer' ? 1.25 : kind === 'swing' ? 0.9 : 1), tolerance: tol,
      corner: h.corner, label: h.label || h.name || null, hint: true };
  }

  function generateZones(geom, trackDef, opts) {
    var o = resolveOptions(opts);
    var L = lengthOf(geom);
    if (!L) return [];
    var curves = detectCurves(geom, o);
    // fast sweepers only (ovals): relax the radius threshold until something qualifies
    for (var rr = 2; !curves.length && rr <= 4; rr *= 2) curves = detectCurves(geom, assign({}, o, { zoneMaxRadius_m: num(o.zoneMaxRadius_m, 160) * rr }));
    var raw = [], n = 0;
    curves.forEach(function (cv, ci) {
      cv.chunks.forEach(function (ch) {
        var S = geom.samples, sApex = S[ch.apex].s, sEnd = S[ch.i1].s, sStart = S[ch.i0].s;
        var span = mod(sEnd - sStart, L) || ch.len;
        // value: sharper / tighter chunks are worth more (×0.8 … ×1.6)
        var worth = clamp(0.8 + 0.4 * Math.min(ch.turn_deg, 180) / 180 + 0.4 * clamp(40 / Math.max(ch.minRadius, 15) - 0.3, 0, 1), 0.8, 1.6);
        n++;
        raw.push({ id: 'z' + n + '-in', kind: 'inner', s: sApex, length: clamp(0.35 * span, 8, 28), sideSign: cv.dir,
          points: o.zoneBasePoints * worth, corner: ci, label: 'CLIP ' + n });
        if (ch.turn_deg >= 45) {
          var sOut = sApex + 0.55 * mod(sEnd - sApex, L);
          raw.push({ id: 'z' + n + '-out', kind: 'outer', s: sOut, length: clamp(0.3 * span, 8, 24), sideSign: -cv.dir,
            points: o.zoneBasePoints * 1.25 * worth, corner: ci, label: 'OUTER ' + n });
        }
      });
    });
    // hints from the track definition (authored zones always stay; auto zones near them are dropped)
    var def = trackDef || (geom && geom.def) || {};
    var hints = o.autoZones === false ? [] : Array.isArray(def.driftZones) ? def.driftZones : [];
    var hz = [];
    hints.forEach(function (h, i) { var z = h ? normHint(geom, h, i, o) : null; if (z) hz.push(z); });
    if (hz.length && o.autoWithHints === false) raw = [];
    var all = hz.slice();
    raw.forEach(function (z) {
      for (var i = 0; i < hz.length; i++) {
        var d = Math.abs(mod(z.s - hz[i].s + L / 2, L) - L / 2);
        if (d < 30) return;
      }
      all.push(z);
    });
    // declutter: auto zones closer than zoneMinSpacing_m to an already kept zone on the same side are dropped
    var minSp = num(o.zoneMinSpacing_m, 16), kept = [];
    all.sort(function (a, b) { return mod(a.s, L) - mod(b.s, L); });
    all.filter(function (z) { return z.hint; }).concat(all.filter(function (z) { return !z.hint; })).forEach(function (z) {
      for (var i = 0; i < kept.length; i++) {
        if (!z.hint && kept[i].sideSign === z.sideSign && Math.abs(mod(z.s - kept[i].s + L / 2, L) - L / 2) < minSp) return;
      }
      kept.push(z);
    });
    all = kept.sort(function (a, b) { return mod(a.s, L) - mod(b.s, L); });
    return all.map(function (z) { return makeZone(geom, z, o); });
  }
  function normalizeZones(geom, zones, o) {
    var out = [];
    zones.forEach(function (z, i) {
      var h = z ? normHint(geom, z, i, o) : null;
      if (h) { h.id = z.id || ('z' + (i + 1)); h.hint = !!z.hint; out.push(makeZone(geom, h, o)); }
    });
    return out;
  }

  /* ================================================================ MEDALS */
  function niceRound(v) {
    var step = v < 2000 ? 100 : v < 20000 ? 500 : 1000;
    return Math.max(step, Math.round(v / step) * step);
  }
  /** Per-track medal targets. Explicit opts.targets / trackDef.driftTargets / trackDef.medals win (scaled by difficulty only
   *  when opts.scaleTargets is set); otherwise estimated from the corner content of the track and the run length. */
  function medalTargets(geom, trackDef, opts) {
    var o = resolveOptions(opts);
    var k = difficultyScale(o.difficulty);
    var def = trackDef || (geom && geom.def) || {};
    var ak = num(o.targetAssistScale, ASSIST_TARGET_SCALE[o.assistLevel] || 1);
    var given = o._estimateOnly ? null : o.targets || def.driftTargets || def.driftMedals || (def.drift && def.drift.medals && isNum(def.drift.medals.gold) ? def.drift.medals : null) ||
      (def.medals && isNum(def.medals.gold) ? def.medals : null);
    var out = {};
    if (given && !isNum(given.gold)) given = null;
    // authored track medals are written for the track's own run length (def.drift.duration_s); a run of another
    // length (trial 90 s, tandem 120 s …) scales them linearly so gold means the same pace at every length
    var dk = 1;
    if (given && !o.targets) {
      var authoredDur = num(def.drift && def.drift.duration_s, null), runDur = num(o.duration_s, null);
      if (isNum(o.laps) && !isNum(runDur)) runDur = o.laps * (lengthOf(geom) || 1000) / 19;
      if (authoredDur > 0 && runDur > 0) dk = clamp(runDur / authoredDur, 0.1, 10);
    }
    if (given && !o.targets && o.calibrateTargets !== false) {
      // authored track medals are only trusted when they are on this scorer's scale (gold within ×0.4 … ×2.5 of the
      // estimate for the ACTUAL run length); otherwise the estimate is used so medals stay reachable
      var est = medalTargets(geom, null, assign({}, o, { targets: null, _estimateOnly: true, duration_s: runDuration(def, o) }));
      if (given.gold * ak * dk > est.gold * 2.5 || given.gold * ak * dk < est.gold * 0.4) { est.source = 'estimate'; est.authored = { bronze: given.bronze, silver: given.silver, gold: given.gold, platinum: given.platinum }; return est; }
    }
    if (given) {
      // explicit opts.targets are used verbatim; authored track medals are heavy-scale and follow the assist level and run length
      var gk = (o.scaleTargets ? k : 1) * (o.targets ? 1 : ak * dk);
      MEDALS.forEach(function (m) { out[m] = Math.round(num(given[m], 0) * gk); });
      if (gk !== 1) MEDALS.forEach(function (m) { out[m] = niceRound(out[m]); });
    } else {
      var L = lengthOf(geom) || 1000;
      var curves = detectCurves(geom, o), curveLen = 0;
      curves.forEach(function (c) { curveLen += c.len; });
      var zones = Array.isArray(o.zoneList) ? o.zoneList : [];
      var zonePts = 0;
      zones.forEach(function (z) { zonePts += z.points; });
      var dur = isNum(o.laps) ? o.laps * L / 19 : runDuration(def, o);
      var laps = dur * 19 / L;                                            // ~68 km/h average
      var driftFrac = clamp(0.15 + 0.4 * curveLen / L, 0.2, 0.55);         // share of the run spent scoring sideways
      // potential: ~110 pts/s base × ~×1.4 average combo while sideways, ~35 % of the zone value collected, small pot
      // of entry / long-drift bonuses; × HEAVY_POT_SCALE (combo chains run far longer with the heavy assist) × assist scale
      var pot = dur * driftFrac * 110 * 1.4 + laps * zonePts * 0.35 * 1.4 + dur * 5;
      MEDALS.forEach(function (m) { out[m] = pot * HEAVY_POT_SCALE * ak * MEDAL_FRACTIONS[m] * k; });
    }
    // monotonic + nicely rounded
    out.source = given ? 'track' : 'estimate';
    var prev = 0;
    MEDALS.forEach(function (m) {
      var v = given ? out[m] : niceRound(out[m]);
      if (!(v > prev)) v = prev + (given ? 1 : 100);
      out[m] = v; prev = v;
    });
    return out;
  }
  function runDuration(def, o) {
    return num(o && o.duration_s, num(def && def.drift && def.drift.duration_s, 120));
  }
  function medalFor(total, targets) {
    var best = null;
    MEDALS.forEach(function (m) { if (targets && total >= targets[m]) best = m; });
    return best;
  }

  /* ================================================================ SCORER */
  function createScorer(geom, trackDef, opts) {
    opts = opts || {};
    var o = resolveOptions(opts);
    var L = lengthOf(geom);
    var dk = difficultyScale(o.difficulty);
    var zones = Array.isArray(opts.zones) ? normalizeZones(geom, opts.zones, o) : generateZones(geom, trackDef, o);
    var targets = medalTargets(geom, trackDef, assign({}, o, { zoneList: zones }));
    targets.assistLevel = o.assistLevel;
    var leadSrc = opts.lead || null;
    var S, seq = 0;
    // assist level whose medal scale this run is judged on: the MOST assisted level used since the run started scoring
    // (switching down mid-run must not shrink the targets under points earned with more help)
    var medalLevel = o.assistLevel;

    function reset() {
      zones.forEach(function (z) { z.hit = false; z.quality = 0; z.hits = 0; z.passes = 0; z._in = false; z._q = 0; z._paid = false; });
      S = {
        t: 0, total: 0, current: 0, raw: 0, multiplier: 1, comboCount: 0, comboHold: 0, idle: 99, comboAlive: false,
        drifting: false, dir: 0, driftTime: 0, below: 0, angle_deg: 0, beta_deg: 0, speed: 0, rate: 0,
        angleFactor: 0, speedFactor: 0, smoothness: 1, betaEma: 0, devEma: 0,
        driftMaxAngle: 0, driftAngleSum: 0, driftAngleN: 0, entrySpeed: 0, entryPaid: false, flags: {},
        spun: false, backT: 0, lastDriftEndT: -99, lastDir: 0, swings: [], wallGap: null, wallClose: 0, tandemDist: null, tandemOn: false,
        lastProjIndex: null, s: null, lateral: null, offTrack: false,
        lastEvent: null, popups: [], lastDrift: null, scrapeCool: 0, spinT: -99, coachT: 0, coach: null,
        overT: 0, sweetT: 0, mileIdx: 0, saves: 0,
        sideMax: 0, pendingSwing: null, swingMultGain: 0, earned: 0, manjiPay: 1, fizzT: -99, fizzWhy: null,
        hasRoad: false, roadK: 0, roadDir: 0, roadFlips: 0, roadFlipT: -99, paidFlips: 0, wrongT: 0, counterDir: false,
        stats: { drifts: 0, bestDrift: null, longestDrift_s: 0, maxAngle_deg: 0, maxMultiplier: 1, maxChain: 0, transitions: 0, manjis: 0,
          spins: 0, wallHits: 0, wallScrapes: 0, contacts: 0, offTracks: 0, backwards: 0, zonesHit: 0, zonesPassed: 0, perfectClips: 0,
          driftTime_s: 0, wallTime_s: 0, tandemTime_s: 0, entryBonus: 0, angleSum: 0, angleN: 0, lost: 0, saves: 0, perfectAngles: 0,
          flicks: 0, counterTime_s: 0 },
        finished: false
      };
      medalLevel = o.assistLevel;
      retarget();
      return api;
    }

    function event(kind, text, points, color) {
      seq++;
      var e = { text: text, points: points == null ? null : Math.round(points), kind: kind, color: color || '#ffffff', t: round(S.t, 3), seq: seq };
      S.lastEvent = e;
      S.popups.push(e);
      if (S.popups.length > 12) S.popups.shift();
      return e;
    }
    function bumpMultiplier(steps) {
      var before = S.multiplier;
      S.multiplier = Math.min(o.multiplierMax, round(S.multiplier + o.multiplierStep * steps, 2));
      if (o.comboEvents && Math.floor(S.multiplier + 1e-6) > Math.floor(before + 1e-6) && S.multiplier >= 2) {
        var whole = Math.floor(S.multiplier + 1e-6);
        event('combo', whole >= o.multiplierMax ? 'MAX COMBO ×' + whole + '!' : '×' + whole + ' COMBO!', null, whole >= 4 ? '#ff6bd6' : '#ffd84d');
      }
      if (S.multiplier > S.stats.maxMultiplier) S.stats.maxMultiplier = S.multiplier;
    }
    /** add points to the current drift (multiplier applied now) */
    function add(rawPts) {
      var p = rawPts * S.multiplier;
      S.raw += rawPts; S.current += p;
      return p;
    }
    function endDriftState() {
      S.drifting = false; S.driftTime = 0; S.below = 0; S.flags = {}; S.sweetT = 0; S.mileIdx = 0; S.pendingSwing = null; S.wrongT = 0; S.counterDir = false;
      S.lastDriftEndT = S.t; S.lastDir = S.dir || S.lastDir;
      S.current = 0; S.raw = 0;
      zones.forEach(function (z) { if (z._in && !z._paid) { z._q = 0; } });
    }
    function payPendingZones() {
      zones.forEach(function (z) {
        if (z._in && z._q > 0 && !z._paid) payZone(z);
      });
    }
    function payZone(z) {
      z._paid = true;
      var q = z._q;
      var pts = z.points * (0.5 + 0.5 * q) * Math.max(0.6, S.speedFactor);
      // clipped while sliding the wrong way round the corner: reduced points, no combo credit
      var wrong = S.counterDir && z.kind !== 'swing';
      var got = add(pts * (wrong ? o.counterDirFactor : 1));
      if (!wrong) { bumpMultiplier(o.zoneMultiplierSteps); S.earned++; }
      if (q >= o.perfectClip && z.kind !== 'swing') { S.stats.perfectClips++; event('zone', 'PERFECT CLIP! ' + (z.kind === 'outer' ? 'OUTER ZONE' : 'CLIPPING ZONE'), got, '#38ffb4'); }
      else if (z.kind === 'swing') event('zone', 'SWING ZONE!', got, '#8fd3ff');
      else event('zone', z.kind === 'outer' ? 'OUTER ZONE!' : z.kind === 'point' ? 'CLIPPING POINT!' : 'CLIPPING ZONE!', got, '#38e08c');
    }
    function bank(factor, reason) {
      factor = num(factor, 1);
      if (S.drifting) payPendingZones();
      var pts = Math.round(S.current * factor);
      var dur = S.driftTime;
      if (S.current > 0 || dur > 0) {
        var g = gradeFor(pts, o.difficulty);
        var drift = { points: pts, grade: g.id, label: g.label, duration_s: round(dur, 2), maxAngle_deg: round(S.driftMaxAngle, 1),
          avgAngle_deg: round(S.driftAngleN ? S.driftAngleSum / S.driftAngleN : 0, 1), multiplier: S.multiplier, reason: reason || 'banked', t: round(S.t, 2) };
        S.total += pts;
        S.stats.drifts++;
        S.lastDrift = drift;
        if (!S.stats.bestDrift || pts > S.stats.bestDrift.points) S.stats.bestDrift = drift;
        if (dur > S.stats.longestDrift_s) S.stats.longestDrift_s = dur;
        if (pts > 0) {
          if (reason === 'offtrack') event('offtrack', 'OFF TRACK — HALF BANKED +' + fmt(pts), pts, '#ffb86b');
          else event('bank', '+' + fmt(pts) + ' ' + g.label + ' DRIFT ×' + S.multiplier.toFixed(1), pts, g.color);
        }
      }
      endDriftState();
      return pts;
    }
    function lose(kind, text, multMode) {
      var lost = Math.round(S.current);
      S.stats.lost += lost;
      if (multMode === 'reset') { S.multiplier = 1; S.comboCount = 0; S.comboHold = 0; S.comboAlive = false; S.earned = 0; S.swingMultGain = 0; }
      else if (multMode === 'half') { S.multiplier = Math.max(1, round(1 + (S.multiplier - 1) * o.spinMultiplierKeep, 2)); S.comboHold = 0; }
      endDriftState();
      event(kind, text + (lost > 0 ? ' −' + fmt(lost) : ''), lost > 0 ? -lost : null, '#ff5a5a');
      return lost;
    }

    /* ------------------------------------------------ input normalisation */
    function resolveLead(ctx, snapshot, car) {
      var lead = ctx.lead || (car && (car.lead || car.tandem)) || null;
      if (lead && typeof lead !== 'object') lead = null;
      if (!lead && leadSrc) lead = typeof leadSrc === 'function' ? leadSrc() : leadSrc;
      if (!lead && snapshot && Array.isArray(snapshot.cars)) {
        var best = null, bd = Infinity;
        snapshot.cars.forEach(function (c) {
          if (!c || c.isPlayer || (car && car.id != null && c.id === car.id) || (o.playerId != null && c.id === o.playerId)) return;
          if (!isNum(c.x) || !isNum(car && car.x)) return;
          var d = Math.hypot(c.x - car.x, c.y - car.y);
          if (d < bd) { bd = d; best = c; }
        });
        lead = best;
      }
      return lead;
    }
    function projFor(car, ctx) {
      var p = ctx.proj || (car && car.proj) || null;
      if (!p && geom && isNum(car && car.x) && isNum(car.y)) {
        try {
          if (typeof geom.project === 'function') p = geom.project(car.x, car.y, S.lastProjIndex);
          else if (CB.race.tracks && typeof CB.race.tracks.project === 'function' && samplesOf(geom)) p = CB.race.tracks.project(geom, car.x, car.y, S.lastProjIndex);
        } catch (e) { p = null; }
      }
      if (!p && car && isNum(car.s)) p = { s: car.s, lateral: num(car.lateral, 0) };
      if (p && isNum(p.index)) S.lastProjIndex = p.index;
      return p;
    }
    function isPlayerEvent(e, car) {
      if (!e) return false;
      if (e.carId == null) return true;
      if (o.playerId != null) return e.carId === o.playerId || e.otherId === o.playerId;
      if (car && car.id != null) return e.carId === car.id || e.otherId === car.id;
      return true;
    }

    /* ------------------------------------------------- assist level (targets + forgiveness) */
    var explicitAssist = opts.assistLevel != null || opts.assist != null || opts.forgiveness != null;
    /** Switch the forgiveness preset + medal scale to another assist level (in place: api.options / api.targets keep
        their identity). Zones keep their geometry. Returns the level now in use. */
    function targetScaleOf(lvl) { return num(ASSIST_TARGET_SCALE[lvl], 1); }
    /** recompute the medal targets in place (api.targets keeps its identity) for medalLevel */
    function retarget() {
      var extra = { zoneList: zones };
      if (!isNum(opts.targetAssistScale)) extra.targetAssistScale = targetScaleOf(medalLevel);
      var nt = medalTargets(geom, trackDef, assign({}, o, extra));
      for (var m in nt) if (Object.prototype.hasOwnProperty.call(nt, m)) targets[m] = nt[m];
      if (!nt.authored) delete targets.authored;
      targets.assistLevel = medalLevel;
    }
    function runStarted() { return !!(S && (S.total > 0 || S.current > 0 || S.drifting || S.stats.drifts > 0)); }
    function setAssistLevel(level) {
      var lvl = assistLevelOf({ assistLevel: level });
      if (lvl === o.assistLevel) return lvl;
      var no = resolveOptions(assign({}, opts, { assistLevel: lvl, assist: null, forgiveness: null }));
      for (var k in no) if (Object.prototype.hasOwnProperty.call(no, k)) o[k] = no[k];
      // before anything has scored the new level simply applies; afterwards the targets can only go UP
      if (!runStarted() || targetScaleOf(lvl) > targetScaleOf(medalLevel)) medalLevel = lvl;
      retarget();
      return lvl;
    }

    /* ------------------------------------------------------------ update */
    function update(car, dt, evArg) {
      if (!S) reset();
      dt = clamp(num(dt, 0), 0, 0.25);
      S.t += dt;
      car = car || {};
      // ---- normalise the third argument
      var ctx = {}, events = [], snapshot = null;
      if (Array.isArray(evArg)) events = evArg;
      else if (evArg && typeof evArg === 'object') {
        if (Array.isArray(evArg.cars)) { snapshot = evArg; events = Array.isArray(evArg.events) ? evArg.events : []; }
        else { ctx = evArg; events = Array.isArray(evArg.events) ? evArg.events : []; if (evArg.snapshot) snapshot = evArg.snapshot; }
      }
      // the assist level may arrive with the data (ctx / car / snapshot.drift) when it was not given to createScorer
      if (!explicitAssist) {
        var lvlHint = ctx.assistLevel || car.assistLevel || (snapshot && snapshot.drift && snapshot.drift.assistLevel);
        if (lvlHint && typeof lvlHint === 'string') setAssistLevel(lvlHint);
      }
      var v = speedOf(car);
      var beta = driftAngle(car), bd = Math.abs(beta) / DEG;
      S.speed = v; S.beta_deg = beta / DEG; S.angle_deg = bd;
      var proj = projFor(car, ctx);
      if (proj) { S.s = num(proj.s, S.s); S.lateral = num(proj.lateral, S.lateral); }
      trackRoad(proj);

      // ---- events: wall hits / contact / resets
      var hitWall = !!(ctx.crash && /wall/i.test(String(ctx.crash))), contact = !!(ctx.crash && !hitWall), resetEv = false, scrape = false;
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        if (!e || !isPlayerEvent(e, car)) continue;
        if (e.type === 'wall') {
          var wv0 = isNum(e.value) ? e.value : num(e.intensity, 1) * 18;
          if (wv0 >= o.wallHitSpeed) hitWall = true;
          else if (wv0 >= o.wallScrapeSpeed) scrape = true;
        }
        else if (e.type === 'collision' && num(e.intensity, 1) >= o.collisionIntensity) contact = true;
        else if (e.type === 'reset') resetEv = true;
      }
      if (hitWall) {
        S.stats.wallHits++;
        if (S.drifting || S.multiplier > 1 || S.current > 0) lose('wall', 'WALL HIT — COMBO LOST', 'reset');
        S.rate = 0; return state();
      }
      if (scrape && S.t >= S.scrapeCool) {
        S.scrapeCool = S.t + o.wallScrapeCooldown_s;
        S.stats.wallScrapes++;
        if (S.drifting || S.multiplier > 1) {
          S.multiplier = Math.max(1, round(S.multiplier - o.wallScrapeLoss, 2));
          event('scrape', 'WALL SCRAPE', null, '#ffb86b');
        }
      }
      if (contact) {
        S.stats.contacts++;
        if (S.drifting || S.multiplier > 1) lose('contact', 'CONTACT — COMBO LOST', 'reset');
        S.rate = 0; return state();
      }
      if (resetEv) { if (S.drifting) lose('reset', 'RESET — DRIFT LOST', 'reset'); S.rate = 0; return state(); }

      var fast = v * KPH >= o.minSpeed_kph;
      var holdFast = v * KPH >= o.minSpeed_kph * o.holdSpeedFactor;   // an established drift survives a slower dip

      // ---- spin
      if (bd > o.spinAngle_deg && v > 3) S.overT += dt; else S.overT = 0;
      if (S.overT > 0 && (S.overT >= o.spinConfirm_s - 1e-9 || S.spun)) {
        if (!S.spun) {
          S.spun = true; S.stats.spins++; S.spinT = S.t;
          lose('spin', 'SPIN! DRIFT LOST', 'half');
        }
        S.rate = 0; tickCombo(dt, false); return state();
      }
      if (S.spun && bd < o.recoverAngle_deg) S.spun = false;

      // ---- going backwards along the track
      var along = null;
      var wv = worldVel(car);
      if (proj && isNum(proj.heading) && wv) along = wv[0] * Math.cos(proj.heading) + wv[1] * Math.sin(proj.heading);
      var backwards = typeof ctx.backwards === 'boolean' ? ctx.backwards : along !== null ? along < -o.backwardsSpeed : car.wrongWay === true;
      if (backwards) S.backT += dt; else S.backT = 0;
      if (S.backT >= o.backwards_s) {
        if (S.backT - dt < o.backwards_s) {
          S.stats.backwards++;
          if (S.drifting || S.multiplier > 1) lose('backwards', 'WRONG WAY — COMBO LOST', 'reset');
          else event('backwards', 'WRONG WAY', null, '#ff5a5a');
        }
        S.rate = 0; tickCombo(dt, false); return state();
      }

      // ---- off track
      // lenient on purpose: tarmac run-off within offTrackMargin_m of the kerb still counts as track (drift parks)
      var offTrack;
      if (typeof ctx.offTrack === 'boolean') offTrack = ctx.offTrack;
      else if (proj && (isNum(proj.halfWidth) || proj.surface)) {
        offTrack = proj.surface === 'grass' || proj.surface === 'sand' || proj.surface === 'gravel' ||
          (isNum(proj.halfWidth) && isNum(proj.lateral) && Math.abs(proj.lateral) > proj.halfWidth + o.offTrackMargin_m);
      } else offTrack = car.offTrack === true || car.onTrack === false;
      if (offTrack && !S.offTrack) {
        S.stats.offTracks++;
        if (S.drifting) bank(o.offTrackBankFactor, 'offtrack');
      }
      S.offTrack = offTrack;
      if (offTrack) { S.rate = 0; tickCombo(dt, false); updateZones(car, proj, false); return state(); }

      // ---- angle / speed / smoothness
      var af = (fast || (S.drifting && holdFast)) && !S.spun && S.overT === 0 ? angleFactor(bd, o) : 0;
      var sf = speedFactor(v, o);
      S.angleFactor = af; S.speedFactor = sf;
      var bdeg = beta / DEG;
      if (S.drifting) {
        S.betaEma = lerp(S.betaEma, bdeg, clamp01(dt * 4));
        S.devEma = lerp(S.devEma, Math.abs(bdeg - S.betaEma), clamp01(dt * 2));
      } else { S.betaEma = bdeg; S.devEma = 0; }
      S.smoothness = smoothnessFactor(S.devEma, o);

      var dir = sign(beta);
      var canDrift = fast && !S.spun && bd >= o.startAngle_deg;
      var holding = S.drifting && holdFast && bd >= o.endAngle_deg;

      if (canDrift && !S.drifting) startDrift(dir, v);
      else if (S.drifting && canDrift && dir !== 0 && dir !== S.dir) swing(dir, sf);

      if (S.drifting) {
        if (holding || canDrift) {
          if (S.below >= o.saveMin_s && o.saveMin_s > 0 && S.driftTime > 0.5) saved();
          S.below = 0;
          driftTick(car, proj, ctx, snapshot, dt, af, sf, bd);
        } else {
          S.below += dt; S.rate = 0;
          if (S.below >= o.grace_s) bank(1, 'end');
        }
      } else S.rate = 0;
      tickCombo(dt, S.drifting && S.below === 0);
      updateZones(car, proj, S.drifting && af > 0);
      return state();
    }

    function startDrift(dir, v) {
      var chained = S.comboAlive;
      // swing: the previous drift went the other way and ended moments ago
      if (S.lastDir && dir !== S.lastDir && S.t - S.lastDriftEndT <= o.transitionWindow_s && S.stats.drifts > 0) {
        S.drifting = true; S.dir = dir; S.driftTime = 0;
        initDrift(v, chained);
        swing(dir, speedFactor(v, o), true);
        return;
      }
      S.drifting = true; S.dir = dir; S.sideMax = 0;
      initDrift(v, chained);
    }
    function initDrift(v, chained) {
      S.driftTime = 0; S.below = 0; S.flags = {}; S.raw = 0; S.current = 0; S.sweetT = 0; S.mileIdx = 0;
      S.driftMaxAngle = 0; S.driftAngleSum = 0; S.driftAngleN = 0;
      S.entrySpeed = v; S.entryPaid = false;
      if (chained) { S.comboCount++; if (S.comboCount > S.stats.maxChain) S.stats.maxChain = S.comboCount; }
      else { S.comboCount = 1; if (S.stats.maxChain < 1) S.stats.maxChain = 1; }
      S.comboAlive = true;
      zones.forEach(function (z) { if (z._in) { z._q = 0; } });
    }
    function keepLongFlags() {
      // (longDrift may have more than three tiers) re-mark every tier already reached by this drift
      for (var i = 0; i < o.longDrift.length; i++) if (S.driftTime >= o.longDrift[i][0]) S.flags['long' + i] = true;
    }
    /** The slide flipped sides. The flick itself is free; the SWING bonus (transition points, +multiplier, MANJI) is
        only paid once it is a real transition: the old side reached swingMinAngle_deg, the new side reaches it within
        swingConfirm_s and — on heavy/auto, where the drift lock lets the car flick anywhere — the road itself changed
        direction since the last paid swing and the new slide matches the corner (or the flip happened in a swing zone). */
    function swing(dir, sf, viaStart) {
      var prevMax = S.sideMax;
      S.dir = dir; S.sideMax = 0;
      S.stats.flicks++;
      var zoneSwing = false;
      zones.forEach(function (z) {
        if (z.kind === 'swing' && z._in && !z._paid) { z._q = 1; z.hit = true; z.quality = 1; zoneSwing = true; payZone(z); }
      });
      // a mid-drift flip re-arms the per-direction popups (wall / tandem) only: the long-drift bonuses belong to the
      // whole drift (driftTime keeps running), so they must not be paid again on every swing
      if (!viaStart) { S.flags = {}; keepLongFlags(); }
      if (prevMax < o.swingMinAngle_deg) { S.pendingSwing = null; fizzle('angle'); return; }
      S.pendingSwing = { t: S.t, dir: dir, sf: sf, zone: zoneSwing };
    }
    function fizzle(why) { S.fizzT = S.t; S.fizzWhy = why; }
    function roadAllowsSwing(ps) {
      if (!o.swingRoadGate || !S.hasRoad || ps.zone) return true;
      var flipped = S.roadFlips > S.paidFlips && S.t - S.roadFlipT <= o.swingRoadWindow_s;
      return flipped && (!S.roadDir || ps.dir === -S.roadDir);
    }
    function resolveSwing(bd) {
      var ps = S.pendingSwing;
      if (!ps) return;
      if (ps.dir !== S.dir) { S.pendingSwing = null; return; }
      var ok = bd >= o.swingMinAngle_deg && sign(S.beta_deg) === ps.dir;
      var road = roadAllowsSwing(ps);
      if (ok && road) { payTransition(ps); return; }
      if (S.t - ps.t > o.swingConfirm_s) { S.pendingSwing = null; fizzle(road ? 'angle' : 'road'); }
    }
    function payTransition(ps) {
      S.pendingSwing = null;
      S.paidFlips = S.roadFlips;
      S.stats.transitions++;
      var got = add(o.transitionBonus * Math.max(0.6, ps.sf));
      var room = Math.max(0, o.swingMultMax - S.swingMultGain);
      var steps = Math.min(o.swingMultiplierSteps, room / Math.max(1e-6, o.multiplierStep));
      if (steps > 1e-6) { bumpMultiplier(steps); S.swingMultGain += steps * o.multiplierStep; }
      S.earned += 2;
      while (S.swings.length && S.t - S.swings[0] > o.manjiWindow_s) S.swings.shift();
      if (S.swings.length < 2) S.manjiPay = 1;          // a fresh chain: the next MANJI pays in full again
      S.swings.push(S.t);
      if (S.swings.length >= 3) {
        S.stats.manjis++;
        var g2 = add(o.manjiBonus * Math.max(0.6, ps.sf) * S.manjiPay);
        S.manjiPay *= o.manjiRepeatFactor;
        event('manji', 'MANJI ×' + S.swings.length + '!', got + g2, '#8fd3ff');
      } else event('swing', 'SWING!', got, '#8fd3ff');
    }
    /** mean signed centerline curvature between s+a and s+b (null without sampled geometry) */
    function roadCurv(s, a, b) {
      var SS = samplesOf(geom);
      if (!SS || !L) return null;
      var ds = dsOf(geom), n = 0, k = 0;
      for (var d = a; d <= b; d += ds) { var sm = sampleAtS(geom, s + d); if (sm) { k += sm.curvature; n++; } }
      return n ? k / n : null;
    }
    function trackRoad(proj) {
      S.hasRoad = false;
      if (!proj || !isNum(proj.s)) return;
      var kAhead = roadCurv(proj.s, -5, 35);
      if (kAhead === null) return;
      S.hasRoad = true;
      S.roadK = num(roadCurv(proj.s, -5, 15), 0);
      var rd = Math.abs(kAhead) > o.roadCurvature ? sign(kAhead) : 0;
      if (rd) {
        if (S.roadDir && rd !== S.roadDir) { S.roadFlips++; S.roadFlipT = S.t; }
        S.roadDir = rd;
      }
    }

    /** the drift was about to die (deep in its grace timer) and the player caught it again */
    function saved() {
      S.stats.saves++;
      var got = o.saveBonus > 0 ? add(o.saveBonus * Math.max(0.6, S.speedFactor)) : 0;
      event('bonus', 'SAVED!', got || null, '#7dffb0');
    }
    function driftTick(car, proj, ctx, snapshot, dt, af, sf, bd) {
      S.driftTime += dt; S.stats.driftTime_s += dt;
      if (bd > S.driftMaxAngle) S.driftMaxAngle = bd;
      if (bd > S.stats.maxAngle_deg) S.stats.maxAngle_deg = bd;
      S.driftAngleSum += bd; S.driftAngleN++;
      S.stats.angleSum += bd; S.stats.angleN++;

      var mult = 1;
      // ---- swing bookkeeping: deepest angle on the current side, pending transition confirmation
      if (sign(S.beta_deg) === S.dir && bd > S.sideMax) S.sideMax = bd;
      resolveSwing(bd);
      // ---- sliding the wrong way round a corner (β on the corner's side: the tail hangs INTO the corner)
      if (S.hasRoad && Math.abs(S.roadK) > o.counterCurvature && S.dir === sign(S.roadK)) S.wrongT += dt;
      else S.wrongT = Math.max(0, S.wrongT - dt * 2);
      S.counterDir = o.counterDirFactor < 1 && S.wrongT > o.counterDirDelay_s;
      if (S.counterDir) {
        mult *= o.counterDirFactor; S.stats.counterTime_s += dt;
        if (!S.flags.counter) { S.flags.counter = true; event('counter', 'WRONG WAY ROUND — HALF POINTS', null, '#ffb86b'); }
      }
      // ---- wall proximity
      var wallDist = isNum(ctx.wallDist_m) ? ctx.wallDist_m : proj && isNum(proj.wallDist) ? proj.wallDist : null;
      S.wallGap = null;
      if (wallDist !== null) {
        var psi = proj && isNum(proj.heading) && isNum(car.heading) ? wrapAngle(car.heading - proj.heading) : 0;
        var Lc = num(car.length_m, o.carLength_m), Wc = num(car.width_m, o.carWidth_m);
        var ext = 0.5 * (Lc * Math.abs(Math.sin(psi)) + Wc * Math.abs(Math.cos(psi)));
        var gap = wallDist - ext;
        S.wallGap = gap;
        if (gap < o.wallProximity_m && gap > -0.3) {
          var close = clamp01(1 - gap / o.wallProximity_m);
          mult *= 1 + o.wallProximityMult * close;
          S.wallClose = close; S.stats.wallTime_s += dt;
          if (!S.flags.wall) { S.flags.wall = true; event('wall-close', 'CLOSE TO WALL!', null, '#ff9df0'); }
        } else S.wallClose = 0;
      }
      // ---- tandem proximity
      var lead = resolveLead(ctx, snapshot, car);
      S.tandemDist = null; S.tandemOn = false;
      if (lead && isNum(lead.x) && isNum(car.x)) {
        var d = Math.hypot(lead.x - car.x, lead.y - car.y);
        S.tandemDist = d;
        // lead without velocity info (position-only tandem feed): assume it is drifting
        var leadHasVel = (isNum(lead.vx) && isNum(lead.vy)) || (isNum(lead.vxLocal) && isNum(lead.vyLocal)) || isNum(lead.beta);
        var leadDrifting = lead.drifting === true || (lead.drifting !== false && (!leadHasVel || Math.abs(driftAngle(lead)) / DEG >= o.endAngle_deg));
        if (d < o.tandemRange_m && leadDrifting) {
          var tq = clamp01(1 - (d - o.tandemClose_m) / (o.tandemRange_m - o.tandemClose_m));
          mult *= 1 + o.tandemMult * tq;
          S.tandemOn = true; S.stats.tandemTime_s += dt;
          if (!S.flags.tandem) { S.flags.tandem = true; event('tandem', d < 6 ? 'DOOR TO DOOR!' : 'TANDEM!', null, '#ffb86b'); }
        }
      }
      // ---- base rate
      var rate = o.basePoints * af * sf * S.smoothness * mult;
      S.rate = rate * S.multiplier;
      add(rate * dt);
      // ---- entry speed bonus (paid once the drift is established)
      if (!S.entryPaid && S.driftTime >= o.entryConfirm_s) {
        S.entryPaid = true;
        var kph = S.entrySpeed * KPH;
        if (kph > o.entrySpeedMin_kph) {
          var eb = (kph - o.entrySpeedMin_kph) * o.entrySpeedPts_per_kph;
          var got = add(eb);
          S.stats.entryBonus += got;
          event('entry', 'FAST ENTRY ' + Math.round(kph) + ' KM/H', got, '#ffd84d');
        }
      }
      // ---- long drift
      for (var i = 0; i < o.longDrift.length; i++) {
        var ld = o.longDrift[i], fk = 'long' + i;
        if (S.driftTime >= ld[0] && !S.flags[fk]) { S.flags[fk] = true; event('long', ld[2], add(ld[1]), '#c9a7ff'); }
      }
      // ---- perfect angle: held in the 30-50° sweet spot
      if (o.sweetHold_s > 0 && bd >= 30 && bd <= 50 && af > 0) {
        S.sweetT += dt;
        if (S.sweetT >= o.sweetHold_s) {
          S.sweetT -= o.sweetHold_s;
          S.stats.perfectAngles++;
          event('bonus', 'PERFECT ANGLE ' + Math.round(bd) + '°', add(o.sweetBonus * Math.max(0.6, sf)), '#7dffb0');
        }
      } else S.sweetT = Math.max(0, S.sweetT - dt * 2);
      // ---- live point milestones for the open drift
      var ms = Array.isArray(o.milestones) ? o.milestones : [];
      while (S.mileIdx < ms.length && S.current >= ms[S.mileIdx] * dk) {
        event('bonus', fmt(ms[S.mileIdx] * dk) + ' PTS — KEEP IT LIT!', null, '#ffd84d');
        S.mileIdx++;
      }
    }

    function timeCeiling() {
      return Math.min(o.multiplierMax, o.timeMultiplierCap + o.earnedCeilingStep * S.earned);
    }
    function tickCombo(dt, drifting) {
      if (drifting) {
        S.idle = 0;
        S.comboHold += dt;
        while (S.comboHold >= o.multiplierStepTime_s) {
          // heavy/auto: time alone only grows the combo to timeMultiplierCap; zones hit and paid swings raise the ceiling
          if (o.timeMultiplierCap > 0 && S.multiplier >= timeCeiling() - 1e-9) { S.comboHold = o.multiplierStepTime_s; break; }
          S.comboHold -= o.multiplierStepTime_s; bumpMultiplier(1);
        }
      } else {
        S.idle += dt;
        if (S.idle >= o.comboDecayDelay_s) {
          if (S.comboAlive) { S.comboAlive = false; S.comboCount = 0; S.comboHold = 0; S.earned = 0; S.swingMultGain = 0; }
          if (S.multiplier > 1) {
            S.multiplier = Math.max(1, S.multiplier - o.comboDecayRate * dt);
            if (S.multiplier - 1 < 1e-6) S.multiplier = 1;
          }
        }
      }
    }

    function updateZones(car, proj, scoring) {
      if (!zones.length || !proj || !isNum(proj.s) || !L) return;
      var s = proj.s, lat = num(proj.lateral, 0);
      var psi = isNum(proj.heading) && isNum(car.heading) ? wrapAngle(car.heading - proj.heading) : 0;
      var Lc = num(car.length_m, o.carLength_m), Wc = num(car.width_m, o.carWidth_m);
      var ext = 0.5 * (Lc * Math.abs(Math.sin(psi)) + Wc * Math.abs(Math.cos(psi)));
      for (var i = 0; i < zones.length; i++) {
        var z = zones[i];
        var d = mod(s - z.s0, L), inside = d <= z.length;
        if (inside && !z._in) { z._in = true; z._q = 0; z._paid = false; z.hit = false; z.quality = 0; }
        else if (!inside && z._in) {
          z._in = false;
          // left through the far end → a pass (exits backwards / teleports don't count)
          var exitedForward = d > z.length && d < z.length + 40;
          if (exitedForward) {
            z.passes++; S.stats.zonesPassed++;
            if (z._q > 0) {
              z.hits++; S.stats.zonesHit++;
              if (!z._paid && S.drifting) payZone(z);
            }
          }
        }
        if (z._in && scoring && z.kind !== 'swing') {
          var edge = lat + z.sideSign * ext;               // the car's extreme point toward the zone side
          var err = z.sideSign * (z.lateral - edge);      // >0: still short of the target line
          if (z.kind === 'point') err = Math.abs(lat - z.lateral);
          var q = err <= 0 ? 1 : clamp01(1 - err / z.tolerance);
          if (q > 0) {
            if (!z.hit) z.hit = true;
            if (q > z._q) z._q = q;
            z.quality = Math.max(z.quality, round(q, 2));
          }
        }
      }
    }

    /* --------------------------------------------------------- reporting */
    function state() {
      if (!S) reset();
      var cg = S.drifting ? gradeFor(S.current, o.difficulty) : (S.lastDrift ? gradeFor(S.lastDrift.points, o.difficulty) : null);
      return {
        total: Math.round(S.total), current: Math.round(S.current), combo: S.comboCount, multiplier: round(S.multiplier, 2),
        multiplierProgress: round(S.multiplier >= o.multiplierMax ? 1 : S.comboHold / o.multiplierStepTime_s, 3),
        comboAlive: S.comboAlive, comboTimeLeft_s: S.drifting ? o.comboDecayDelay_s : Math.max(0, round(o.comboDecayDelay_s - S.idle, 2)),
        angle_deg: round(S.angle_deg, 1), beta_deg: round(S.beta_deg, 1), speed: round(S.speed, 2), speed_kph: Math.round(S.speed * KPH),
        grade: cg ? cg.id : null, gradeLabel: cg ? cg.label : null, gradeColor: cg ? cg.color : null,
        drifting: S.drifting, direction: S.drifting ? S.dir : 0, driftTime_s: round(S.driftTime, 2), rate: Math.round(S.rate),
        angleFactor: round(S.angleFactor, 3), speedFactor: round(S.speedFactor, 3), smoothness: round(S.smoothness, 3),
        sweetSpot: S.angle_deg >= 30 && S.angle_deg <= 50,
        wallGap_m: S.wallGap === null ? null : round(S.wallGap, 2), wallClose: round(S.wallClose || 0, 2),
        tandemDist_m: S.tandemDist === null ? null : round(S.tandemDist, 1), tandem: S.tandemOn,
        spun: S.spun, offTrack: S.offTrack, backwards: S.backT > 0,
        s: S.s, lateral: S.lateral,
        zones: zones.map(function (z) {
          return { id: z.id, s: z.s, s0: z.s0, s1: z.s1, length: z.length, side: z.side, sideSign: z.sideSign, kind: z.kind, hit: z.hit,
            quality: z.quality, lateral: z.lateral, lat0: z.lat0, lat1: z.lat1, x: z.x, y: z.y, heading: z.heading,
            points: z.points, active: !!z._in, label: z.label };
        }),
        nextZone: nextZone(),
        lastEvent: S.lastEvent, popups: S.popups.filter(function (p) { return S.t - p.t <= 2.5; }),
        lastDrift: S.lastDrift, targets: targets, medal: medalFor(Math.round(S.total + S.current), targets), t: round(S.t, 3),
        coach: o.coach === false ? null : coachHint(), assistLevel: o.assistLevel,
        // drift "fuse" for the HUD: 1 = solid, falls to 0 as the grace timer runs out (drift about to bank)
        driftHealth: S.drifting ? round(clamp01(1 - S.below / Math.max(1e-6, o.grace_s)), 3) : 0,
        graceLeft_s: S.drifting ? round(Math.max(0, o.grace_s - S.below), 2) : 0,
        sweetProgress: S.drifting && o.sweetHold_s > 0 ? round(clamp01(S.sweetT / o.sweetHold_s), 3) : 0
      };
    }
    /** One short, arrow-key oriented tip for what to do right now (null when nothing useful to say). */
    function coachHint() {
      var deg = S.angle_deg, kph = S.speed * KPH, nz;
      if (S.backT > 0.3) return { id: 'backwards', text: 'WRONG WAY — TURN AROUND', tone: 'bad' };
      if (S.spun || S.t - S.spinT < 1.5) {
        var catches = o.assistLevel === 'heavy' || o.assistLevel === 'auto' || o.assistLevel === 'medium';
        return { id: 'spin', text: catches ? 'LET GO OF THE ARROWS — THE ASSIST WILL CATCH IT' : 'COUNTER-STEER — OPPOSITE ARROW', tone: 'bad' };
      }
      if (S.offTrack) return { id: 'offtrack', text: 'BACK ON THE TARMAC', tone: 'bad' };
      if (S.drifting) {
        nz = nextZone();
        if (nz && nz.dist_m < 45 && nz.kind !== 'swing') {
          var sideArrow = nz.side === 'left' ? '←' : nz.side === 'right' ? '→' : '';
          return { id: 'zone', text: (nz.kind === 'outer' ? 'OUTER ZONE ' : 'CLIP ZONE ') + sideArrow + ' — SWING THE ' + (nz.kind === 'outer' ? 'REAR' : 'NOSE') + ' CLOSE', tone: 'info' };
        }
        if (S.counterDir) return { id: 'counter', text: 'WRONG WAY ROUND — FLICK ' + (S.roadK > 0 ? '←' : '→') + ' INTO THE CORNER', tone: 'warn' };
        if (S.t - S.fizzT < 1.5 && S.fizzWhy === 'road') return { id: 'swing-road', text: 'SWING WHERE THE ROAD CHANGES DIRECTION', tone: 'info' };
        if (S.t - S.fizzT < 1.5 && S.fizzWhy === 'angle') return { id: 'swing-angle', text: 'COMMIT TO THE SWING — FULL ANGLE BOTH WAYS', tone: 'info' };
        if (deg > 58) return { id: 'too-much', text: 'TOO MUCH ANGLE — EASE OFF ↓', tone: 'warn' };
        if (deg < 25) return { id: 'more-angle', text: 'MORE ANGLE — HOLD THE ARROW + ↑', tone: 'info' };
        if (deg >= 30 && deg <= 50) return { id: 'sweet', text: 'SWEET SPOT — HOLD IT!', tone: 'good' };
        return null;   // 25-30 / 50-58 deg: the drift HUD fills these from the needle it shows (hud.js reconcileAngleHint)
      }
      if (S.t < 1) return null;
      if (kph < o.minSpeed_kph) return { id: 'speed', text: 'HOLD ↑ — ' + Math.round(o.minSpeed_kph) + '+ KM/H TO DRIFT', tone: 'info' };
      if (S.idle > 2.5) return { id: 'start', text: 'TAP ← OR → WITH ↑ TO KICK IT SIDEWAYS', tone: 'info' };
      if (S.comboAlive && S.idle > 0.2) return { id: 'chain', text: 'CHAIN IT — FLICK THE OTHER WAY!', tone: 'warn' };
      return null;
    }
    function nextZone() {
      if (!zones.length || !isNum(S.s) || !L) return null;
      var best = null, bd = Infinity;
      zones.forEach(function (z) {
        var d = mod(z.s0 - S.s, L);
        if (z._in) d = 0;
        if (d < bd) { bd = d; best = z; }
      });
      return best ? { id: best.id, dist_m: round(bd, 1), side: best.side, kind: best.kind } : null;
    }
    function finish() {
      if (S.drifting || S.current > 0) bank(1, 'finish');
      return Math.round(S.total);
    }
    function results() {
      finish();
      var st = S.stats, total = Math.round(S.total);
      var medal = medalFor(total, targets);
      var nextM = null;
      for (var i = 0; i < MEDALS.length; i++) if (total < targets[MEDALS[i]]) { nextM = { medal: MEDALS[i], target: targets[MEDALS[i]], missing: targets[MEDALS[i]] - total }; break; }
      return {
        total: total, score: total,
        bestDrift: st.bestDrift, bestDriftPoints: st.bestDrift ? st.bestDrift.points : 0,
        longestDrift_s: round(st.longestDrift_s, 2), maxAngle_deg: round(st.maxAngle_deg, 1),
        avgAngle_deg: round(st.angleN ? st.angleSum / st.angleN : 0, 1),
        maxCombo: round(st.maxMultiplier, 2), maxMultiplier: round(st.maxMultiplier, 2), maxChain: st.maxChain,
        zonesHit: st.zonesHit, zonesPassed: st.zonesPassed, zonesHitPct: st.zonesPassed ? Math.round(st.zonesHit / st.zonesPassed * 100) : 0,
        perfectClips: st.perfectClips, zoneCount: zones.length,
        drifts: st.drifts, transitions: st.transitions, flicks: st.flicks, manjis: st.manjis, counterTime_s: round(st.counterTime_s, 2), spins: st.spins, wallHits: st.wallHits, wallScrapes: st.wallScrapes, contacts: st.contacts,
        offTracks: st.offTracks, backwards: st.backwards, pointsLost: st.lost, entryBonus: Math.round(st.entryBonus),
        saves: st.saves, perfectAngles: st.perfectAngles,
        driftTime_s: round(st.driftTime_s, 2), wallTime_s: round(st.wallTime_s, 2), tandemTime_s: round(st.tandemTime_s, 2), time_s: round(S.t, 2),
        medal: medal, targets: targets, next: nextM,
        grade: medal === 'platinum' ? 'SS' : medal === 'gold' ? 'S' : medal === 'silver' ? 'A' : medal === 'bronze' ? 'B' : 'C',
        difficulty: o.difficulty || 'normal', assistLevel: o.assistLevel, medalAssistLevel: medalLevel, trackId: (trackDef && trackDef.id) || (geom && geom.id) || null
      };
    }

    var api = {
      update: update, state: state, results: results, reset: reset, finish: finish,
      setLead: function (l) { leadSrc = l || null; },
      setAssistLevel: function (l) { explicitAssist = true; return setAssistLevel(l); },
      bank: function () { return bank(1, 'manual'); },
      zones: zones, targets: targets, options: o, difficultyScale: dk
    };
    reset();
    return api;
  }

  var mod_ = {
    createScorer: createScorer, generateZones: generateZones, medalTargets: medalTargets, medalFor: medalFor,
    gradeFor: gradeFor, angleFactor: angleFactor, speedFactor: speedFactor, smoothnessFactor: smoothnessFactor,
    driftAngle: driftAngle, difficultyScale: difficultyScale, detectCurves: function (g, o) { return detectCurves(g, assign({}, DEFAULTS, o || {})); },
    resolveOptions: resolveOptions, assistLevelOf: assistLevelOf,
    DEFAULTS: DEFAULTS, FORGIVENESS: FORGIVENESS, GRADES: GRADES, MEDALS: MEDALS
  };
  return mod_;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CB.race.drift.scoring;
