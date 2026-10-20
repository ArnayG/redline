/* ==========================================================================
   Redline — js/f1/f1-teams.js
   CB.f1.teams : the Formula 1 mode grid (docs/F1-SPEC.md §1). Pure data + helpers, no DOM, Node-loadable.

   The current-era grid of 11 teams (22 cars). Team names appear as TEXT BADGES only (no logo artwork); the
   liveries are the teams' real colour schemes as flat colours. Every driver is FICTIONAL (no real people) and
   every car number is chosen so it does not belong to a current driver.

     CB.f1.teams.list                    [team]  team = { id, name, short (3 letters), full, country, power (text),
                                          livery: { primary, secondary, accent, number (roundel ink), halo, wheel },
                                          drivers: [{ id, name, short, number, nation, helmet }, ...2], pace (0..1 flavour) }
     CB.f1.teams.get(id)                 team | null
     CB.f1.teams.ids                     ['mclaren', ...]
     CB.f1.teams.driver(driverId)        { driver, team } | null
     CB.f1.teams.buildFor(teamId, opts)  -> a Redline build object for that team's car
                                          opts { seat 0|1, number, driverName, isPlayer }
                                          build.body.model = 'f1-2026' (the renderer's F1 car), build.f1 = { teamId, seat,
                                          number, driver, livery } and exterior.paint / stripeColor = livery colours.
     CB.f1.teams.MODEL_ID                'f1-2026'
     CB.f1.teams.isF1Build(build)        true for builds made here (renderers use this to pick the F1 car mesh)
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.f1 = CB.f1 || {};

(function () {
  'use strict';

  var MODEL_ID = 'f1-2026';

  function D(id, name, short, number, nation, helmet) { return { id: id, name: name, short: short, number: String(number), nation: nation, helmet: helmet }; }

  var TEAMS = [
    { id: 'mclaren', chassis: 'MCL40', name: 'McLaren', short: 'MCL', full: 'McLaren F1 Team', country: 'United Kingdom', power: 'Mercedes', pace: 0.97,
      livery: { primary: '#ff8000', secondary: '#1d1f24', accent: '#47c7fc', number: '#1d1f24', halo: '#1d1f24', wheel: '#1d1f24' },
      drivers: [D('hale', 'Oliver Hale', 'HAL', 7, 'GBR', '#ffd200'), D('ruiz', 'Mateo Ruiz', 'RUI', 9, 'ESP', '#ff8000')] },
    { id: 'ferrari', chassis: 'SF-26', name: 'Ferrari', short: 'FER', full: 'Scuderia Ferrari', country: 'Italy', power: 'Ferrari', pace: 0.95,
      livery: { primary: '#dc0000', secondary: '#ffffff', accent: '#111111', number: '#ffffff', halo: '#111111', wheel: '#d8d8d8' },
      drivers: [D('marchetti', 'Theo Marchetti', 'MAR', 8, 'ITA', '#ffe000'), D('lefevre', 'Hugo Lefèvre', 'LEF', 13, 'FRA', '#2f6bd8')] },
    { id: 'redbull', chassis: 'RB22', name: 'Red Bull Racing', short: 'RBR', full: 'Red Bull Racing', country: 'Austria', power: 'Red Bull Ford', pace: 0.96,
      livery: { primary: '#1b2a59', secondary: '#e3002b', accent: '#ffcc00', number: '#ffffff', halo: '#1b2a59', wheel: '#1b2a59' },
      drivers: [D('brandt', 'Felix Brandt', 'BRA', 15, 'AUT', '#e3002b'), D('arata', 'Kenji Arata', 'ARA', 17, 'JPN', '#ffffff')] },
    { id: 'mercedes', chassis: 'W17', name: 'Mercedes', short: 'MER', full: 'Mercedes-AMG F1 Team', country: 'Germany', power: 'Mercedes', pace: 0.96,
      livery: { primary: '#b9bfc4', secondary: '#121417', accent: '#00d2be', number: '#121417', halo: '#121417', wheel: '#121417' },
      drivers: [D('brenner', 'Lukas Brenner', 'BRE', 19, 'GER', '#c0c0c0'), D('calloway', 'Ethan Calloway', 'CAL', 20, 'USA', '#00d2be')] },
    { id: 'astonmartin', chassis: 'AMR26', name: 'Aston Martin', short: 'AMR', full: 'Aston Martin F1 Team', country: 'United Kingdom', power: 'Honda', pace: 0.9,
      livery: { primary: '#00594f', secondary: '#0b2420', accent: '#cedc00', number: '#ffffff', halo: '#0b2420', wheel: '#cedc00' },
      drivers: [D('whitlock', 'Sam Whitlock', 'WHI', 21, 'AUS', '#00594f'), D('costa', 'Rafael Costa', 'COS', 24, 'BRA', '#ffdf00')] },
    { id: 'alpine', chassis: 'A526', name: 'Alpine', short: 'ALP', full: 'Alpine F1 Team', country: 'France', power: 'Mercedes', pace: 0.86,
      livery: { primary: '#1663c7', secondary: '#0b1a33', accent: '#ff6fb5', number: '#ffffff', halo: '#0b1a33', wheel: '#ff6fb5' },
      drivers: [D('dumont', 'Pierre Dumont', 'DUM', 25, 'FRA', '#1663c7'), D('ferraz', 'Diego Ferraz', 'FRZ', 26, 'ARG', '#75aadb')] },
    { id: 'williams', chassis: 'FW48', name: 'Williams', short: 'WIL', full: 'Williams Racing', country: 'United Kingdom', power: 'Mercedes', pace: 0.9,
      livery: { primary: '#1868db', secondary: '#0a1e3c', accent: '#00a3e0', number: '#ffffff', halo: '#0a1e3c', wheel: '#0a1e3c' },
      drivers: [D('mercer', 'Aiden Mercer', 'MRC', 28, 'CAN', '#d52b1e'), D('halvorsen', 'Nils Halvorsen', 'HAV', 29, 'NOR', '#ffffff')] },
    { id: 'racingbulls', chassis: 'VCARB 03', name: 'Racing Bulls', short: 'RCB', full: 'Racing Bulls', country: 'Italy', power: 'Red Bull Ford', pace: 0.89,
      livery: { primary: '#f4f6fa', secondary: '#1634cb', accent: '#e4002b', number: '#1634cb', halo: '#1634cb', wheel: '#1634cb' },
      drivers: [D('vos', 'Ruben Vos', 'VOS', 32, 'NED', '#ff6a00'), D('laine', 'Mika Laine', 'LAI', 33, 'FIN', '#ffffff')] },
    { id: 'audi', chassis: 'R26', name: 'Audi', short: 'AUD', full: 'Audi F1 Team', country: 'Germany', power: 'Audi', pace: 0.86,
      livery: { primary: '#8e959a', secondary: '#141414', accent: '#f50537', number: '#ffffff', halo: '#141414', wheel: '#141414' },
      drivers: [D('varga', 'Jonas Varga', 'VAR', 34, 'HUN', '#f50537'), D('sorensen', 'Viktor Sørensen', 'SOR', 35, 'DEN', '#c8102e')] },
    { id: 'haas', chassis: 'VF-26', name: 'Haas', short: 'HAA', full: 'Haas F1 Team', country: 'United States', power: 'Ferrari', pace: 0.86,
      livery: { primary: '#f0f0f0', secondary: '#1a1a1a', accent: '#e6002b', number: '#1a1a1a', halo: '#1a1a1a', wheel: '#1a1a1a' },
      drivers: [D('navarro', 'Tomás Navarro', 'NAV', 36, 'ESP', '#ffc400'), D('mehta', 'Arjun Mehta', 'MEH', 37, 'IND', '#ff9933')] },
    { id: 'cadillac', chassis: 'MAC-26', name: 'Cadillac', short: 'CAD', full: 'Cadillac F1 Team', country: 'United States', power: 'Ferrari', pace: 0.82,
      livery: { primary: '#0c0c0d', secondary: '#f2f2f2', accent: '#b0b5ba', number: '#f2f2f2', halo: '#0c0c0d', wheel: '#0c0c0d' },
      drivers: [D('kowalski', 'Leo Kowalski', 'KOW', 38, 'POL', '#dc143c'), D('park', 'Jae-won Park', 'PAR', 39, 'KOR', '#0047a0')] }
  ];

  var byId = {}, byDriver = {};
  TEAMS.forEach(function (t) {
    byId[t.id] = t;
    t.drivers.forEach(function (d) { byDriver[d.id] = { driver: d, team: t }; });
  });

  function get(id) { return byId[id] || null; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** A Redline build for the team's car. Starts from CB.data.defaultBuild() when available so every consumer
      (physics metrics, normalize, renderers) sees a complete build; the F1 hooks replace its vehicle params. */
  function buildFor(teamId, opts) {
    opts = opts || {};
    var t = get(teamId) || TEAMS[0];
    var seat = opts.seat === 1 ? 1 : 0;
    var drv = t.drivers[seat];
    var b = null;
    try { if (CB.data && typeof CB.data.defaultBuild === 'function') b = clone(CB.data.defaultBuild()); } catch (e) { b = null; }
    b = b || { body: {}, engine: {}, exterior: {}, meta: {} };
    b.meta = Object.assign({}, b.meta || {}, { name: t.name + ' F1' });
    b.body = Object.assign({}, b.body || {}, { style: 'hypercar', model: MODEL_ID, wheelbase_mm: 3600, trackWidth_mm: 1600 });
    var number = String(opts.number != null ? opts.number : drv.number);
    b.exterior = Object.assign({}, b.exterior || {}, { paint: t.livery.primary, stripeColor: t.livery.secondary, livery_number: number });
    b.f1 = {
      teamId: t.id, seat: seat, number: number, isPlayer: !!opts.isPlayer,
      driver: opts.driverName || drv.name, driverShort: drv.short,
      teamName: t.name, chassis: t.chassis, carName: t.name + ' ' + t.chassis, livery: clone(t.livery)
    };
    return b;
  }
  function isF1Build(b) { return !!(b && (b.f1 || (b.body && b.body.model === MODEL_ID))); }

  CB.f1.teams = {
    list: TEAMS, ids: TEAMS.map(function (t) { return t.id; }), byId: byId, get: get,
    driver: function (id) { return byDriver[id] || null; },
    buildFor: buildFor, isF1Build: isF1Build, MODEL_ID: MODEL_ID
  };
})();

if (typeof module !== 'undefined') module.exports = CB.f1.teams;
