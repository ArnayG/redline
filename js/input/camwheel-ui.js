/* ==========================================================================
   FORGE — js/input/camwheel-ui.js
   CB.input.camUI : the browser UI for the webcam air wheel (js/input/camwheel.js + js/input/camwheel-hands.js).
     camUI.open()     "Use webcam as wheel" dialog: mirrored live preview with the hand landmarks and a drawn virtual
                      wheel, and ONE primary Start flow (Space): camera (permission) -> 3-2-1 centre ("hold your hands like
                      a wheel") -> "make fists" test (GO) -> "open your hands" test (BRAKE) -> done (webcam on, steering
                      source selected, "Easy driving" applied). Live steering / gas / brake bars and a GO / COAST / BRAKE / R
                      chip with the hand state. Everything else is under Options (collapsed): steering style (Two hands |
                      One hand at the top of the wheel | Auto, Wheel size), gas and brake mode ("Fist = go, open hand =
                      brake" default, Auto-gas, keyboard pedals; older: Grip + pull back, Push / pull), Easy driving (Heavy
                      steering assist for Race and Drift + automatic gearbox, on by default for the webcam), full lock / dead
                      zone / smoothing, camera picker, and Advanced: the opt-in pull-back brake, handbrake / nitro / item
                      gestures, CPU mode, the colour-marker fallback (marker mode) with its calibration boxes and mask view.
                      Every re-centre counts 3-2-1 first (Esc cancels; in-game too).
     Driving HUD      while the webcam drives the pedals: a big GO (green) / COAST / BRAKE (red) / R (reverse) chip with
                      a tiny hand-state icon; the first drives show a 3-step intro ("1 Hold hands like a wheel · 2 Make
                      fists to go · 3 Open hands to brake").
     camUI.close()    camUI.menuItems()  (pause menu)   camUI.detailHTML()  (steering-source picker)
   Steering-source picker: registers itself as the 'webcam' source of CB.input.sources (js/input/sources.js) when that
   module is loaded; otherwise it adds its own entries to CB.input.ui's pause menu / setup row / Settings rows.
   While driving, a small picture-in-picture preview (toggleable) shows what the camera tracks and the wheel angle.
   Frames are processed in this tab only: nothing is uploaded or recorded.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.input = CB.input || {};

(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof window === 'undefined') { CB.input.camUI = CB.input.camUI || {}; return; }

  function CW() { return CB.input.camwheel; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function el(tag, cls, html) { var n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  function toast(t, k) { var u = CB.input.ui; if (u && u.toast) u.toast(t, k); }
  function handsMode() { var cw = CW(); return !cw || cw.prefs.method !== 'marker'; }
  function hstyle() { var cw = CW(); return cw && cw.prefs.handStyle || 'two'; }
  function sideName(s) { return s === 'L' ? 'Left hand' : s === 'R' ? 'Right hand' : 'One hand'; }
  /** what to hold during the 3-2-1 (hands): per steering style */
  function holdText(kind) {
    var hs = hstyle();
    if (hs === 'top') return 'Hold one hand at the top of the wheel (12 o\'clock)' + (kind === 'centre' ? '' : ', open and relaxed');
    if (hs === 'auto') return kind === 'centre' ? 'Hold your hands level (or one hand at 12 o\'clock)' : 'Hold your hands open and level, at 9 and 3 (or one hand at 12 o\'clock)';
    return kind === 'centre' ? 'Hold your hands level' : 'Hold your hands open and level, at 9 and 3';
  }
  var STYLE_OPTS = [['two', 'Two hands'], ['top', 'One hand (top of the wheel)'], ['auto', 'Auto']];

  var ICON = {
    cam: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6.5" width="13" height="11" rx="2"/><path d="M16 10.5l5-3v9l-5-3z"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };
  var CSS = [
    /* the dialog wears the CB.ui modal look (css/styles.css § 13): scrim + blur, radius-xl card, accent hairline, .cb-btn buttons */
    '.cw-ov{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:16px;background:var(--scrim,rgba(4,4,6,.62));backdrop-filter:blur(10px) saturate(130%);-webkit-backdrop-filter:blur(10px) saturate(130%);color:var(--text,#ecebe6)}',
    '.cw-card{position:relative;width:min(980px,100%);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow:auto;overscroll-behavior:contain;background:var(--panel,#141519);border:1px solid var(--line,#2b2c33);border-radius:var(--radius-xl,22px);box-shadow:var(--elev-3);display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr)}',
    '.cw-card::before{content:"";position:absolute;left:24px;right:24px;top:0;height:1px;background:linear-gradient(90deg,transparent,var(--accent),transparent);opacity:.7}',
    '.cw-left{padding:20px;border-right:1px solid var(--line,#2b2c33);background:color-mix(in srgb,var(--bg-2) 60%,transparent);display:flex;flex-direction:column;gap:12px;min-width:0}',
    '.cw-right{padding:22px 22px 20px;display:flex;flex-direction:column;gap:14px;min-width:0}',
    '.cw-view{position:relative;width:100%;aspect-ratio:4/3;border-radius:var(--radius);overflow:hidden;background:var(--hud-panel);display:grid;place-items:center;box-shadow:0 0 0 1px var(--line)}',
    '.cw-view canvas{position:absolute;inset:0;width:100%;height:100%}',
    '.cw-view .cw-msg{position:relative;z-index:2;padding:20px;text-align:center;font-size:var(--fs-md);line-height:1.5;color:var(--hud-ink);max-width:420px}',
    '.cw-count{position:absolute;inset:0;z-index:3;display:grid;place-items:center;font:800 calc(var(--fs-2xl) * 3.43)/1 var(--hud-font);color:var(--hud-ink);text-shadow:0 4px 24px rgba(0,0,0,.6);pointer-events:none}',
    '.cw-count:empty{display:none}',
    '.cw-eyebrow{display:flex;align-items:center;gap:var(--sp-2);margin-bottom:var(--sp-1);font-size:var(--fs-2xs);letter-spacing:var(--tracking-caps);text-transform:uppercase;color:var(--accent,#c9a56b);font-weight:700}.cw-eyebrow::before{content:"";width:18px;height:2px;border-radius:2px;background:currentColor}',
    '.cw-h{margin:0;font-size:var(--fs-xl);line-height:1.2;font-weight:650;letter-spacing:-.02em;color:var(--text-strong)}',
    '.cw-dim{color:var(--text-dim,#9b9890);font-size:var(--fs-sm);line-height:1.5}',
    '.cw-steps{margin:0;padding-left:20px;display:grid;gap:5px;font-size:var(--fs-sm);line-height:1.45}',
    '.cw-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
    /* buttons are .cb-btn (primary / ghost); .cw-btn only keeps the dialog's control height */
    '.cw-btn.cb-btn{min-height:var(--control-h-md,38px)}.cw-btn kbd{margin-left:2px}.cw-btn.primary kbd{color:var(--accent-ink);background:transparent;border-color:currentColor;opacity:.75}',
    '.cw-x{position:absolute;top:12px;right:12px;z-index:4;width:34px;padding:0;border-radius:50%}',
    /* segmented = the shared .cb-tab-list look */
    '.cw-seg{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--line,#2b2c33);border-radius:12px;background:var(--bg-2);flex-wrap:wrap}',
    '.cw-seg button::after{content:"";position:absolute;left:30%;right:30%;bottom:3px;height:2px;border-radius:2px;background:var(--accent-grad);transform:scaleX(0);transition:transform var(--dur-3) var(--ease-out)}',
    '.cw-seg button{position:relative;appearance:none;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--text-dim,#9b9890);min-height:32px;padding:0 12px;font:650 var(--fs-sm) var(--font,system-ui);cursor:pointer}.cw-seg button:hover:not(.is-on){color:var(--text);background:var(--panel-2)}',
    '.cw-seg button.is-on{background:linear-gradient(180deg,var(--panel-3),var(--panel-2));border-color:var(--line);color:var(--text-strong,#fff);box-shadow:var(--elev-1)}.cw-seg button.is-on::after{transform:scaleX(1)}[data-theme="light"] .cw-seg button.is-on{background:var(--panel)}',
    '.cw-status{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius);border:1px solid var(--line,#2b2c33);background:var(--panel-2);font-size:var(--fs-sm);font-variant-numeric:tabular-nums;line-height:1.4}',
    '.cw-dot{width:10px;height:10px;border-radius:50%;background:var(--warn,#e3a33a);box-shadow:0 0 0 4px var(--warn-soft);flex:none}',
    '.cw-dot.ok{background:var(--good,#3fbf7f);box-shadow:0 0 0 4px var(--good-soft)} .cw-dot.bad{background:var(--bad,#e5484d);box-shadow:0 0 0 4px var(--bad-soft)}',
    '.cw-bar{position:relative;height:10px;border-radius:5px;background:var(--panel-3);overflow:hidden}',
    '.cw-bar::before{content:"";position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--line-2)}',
    '.cw-bar i{position:absolute;top:0;bottom:0;left:50%;width:0;background:var(--accent,#c9a56b)}',
    '.cw-range{display:grid;grid-template-columns:110px 1fr 52px;align-items:center;gap:10px;font-size:var(--fs-sm);color:var(--text-dim,#9b9890)} .cw-range b{color:var(--text,#ecebe6);font-variant-numeric:tabular-nums;text-align:right}',
    '.cw-warn{padding:9px 12px;border-radius:var(--radius-sm);border:1px solid color-mix(in srgb,var(--warn) 40%,transparent);background:var(--warn-soft);font-size:var(--fs-sm);line-height:1.45}',
    '.cw-warn:empty{display:none} .cw-warn p{margin:0} .cw-warn p+p{margin-top:6px}',
    '.cw-ok{border-color:color-mix(in srgb,var(--good) 40%,transparent);background:var(--good-soft)}',
    '.cw-priv{font-size:var(--fs-xs);color:var(--text-dim,#9b9890);line-height:1.45;display:flex;gap:8px;align-items:flex-start}',
    '.cw-sel{min-height:var(--control-h-sm,30px);border-radius:var(--radius-xs);border:1px solid var(--line,#2b2c33);background:var(--bg-2,#111114);color:var(--text,#ecebe6);font:var(--fs-sm) var(--font,system-ui);padding:0 8px;max-width:100%}',
    '.cw-check{display:flex;align-items:center;gap:8px;font-size:var(--fs-sm);color:var(--text,#ecebe6)}',
    '.cw-adv{border:1px solid var(--line,#2b2c33);border-radius:var(--radius-sm);padding:8px 12px} .cw-adv summary{cursor:pointer;font-size:var(--fs-sm);color:var(--text-dim,#9b9890);font-weight:600}',
    '.cw-advb{display:grid;gap:8px;padding-top:10px}',
    '@media (max-width:820px){.cw-card{grid-template-columns:1fr}.cw-left{border-right:0;border-bottom:1px solid var(--line,#2b2c33)}}',
    /* picture-in-picture while driving */
    '.cw-pip{position:fixed;left:16px;bottom:calc(30% + 8px);z-index:2147481000;width:176px;border-radius:10px;overflow:hidden;background:var(--hud-panel);border:1px solid var(--hud-line);box-shadow:0 6px 20px rgba(0,0,0,.4);pointer-events:none;font:700 var(--fs-2xs) var(--hud-font);color:var(--hud-ink)}',
    '.cw-pip canvas{display:block;width:100%;aspect-ratio:4/3}',
    '.cw-pip .cw-pl{display:flex;justify-content:space-between;align-items:center;gap:6px;padding:4px 7px;letter-spacing:.06em;font-variant-numeric:tabular-nums}',
    '.cw-pip.lost{border-color:var(--bad,#e5484d)} .cw-pip.lost .cw-pl{background:rgba(229,72,77,.35)}',
    '.cw-pip button{pointer-events:auto;appearance:none;border:0;background:transparent;color:rgba(255,255,255,.7);cursor:pointer;padding:0 2px;font:700 var(--fs-xs) var(--hud-font)}',
    '.cw-pip .cw-chip{border:1px solid rgba(255,255,255,.35);border-radius:var(--pill);padding:1px 7px;font:700 var(--fs-2xs) var(--hud-font);letter-spacing:.06em;color:var(--hud-ink)}',
    '.cw-pip .cw-chip:hover{border-color:var(--accent,#c9a56b)}',
    /* gas / brake meters */
    '.cw-ped{display:grid;grid-template-columns:110px 1fr 52px;align-items:center;gap:10px;font-size:var(--fs-sm);color:var(--text-dim,#9b9890)} .cw-ped b{color:var(--text,#ecebe6);font-variant-numeric:tabular-nums;text-align:right}',
    '.cw-pbar{position:relative;height:10px;border-radius:5px;background:var(--panel-3);overflow:hidden}',
    '.cw-pbar i{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:5px;background:var(--good,var(--hud-good));transition:width .05s linear}',
    '.cw-pbar.brk i{background:var(--bad,#e5484d)}',
    '.cw-radios{display:grid;gap:6px;border:1px solid var(--line,#2b2c33);border-radius:var(--radius-sm);padding:10px 12px} .cw-radios legend{font-size:var(--fs-xs);color:var(--text-dim,#9b9890);font-weight:700;padding:0 4px}',
    '.cw-radios label{display:flex;gap:8px;align-items:flex-start;font-size:var(--fs-sm);line-height:1.4;cursor:pointer} .cw-radios input{margin-top:2px}',
    '.cw-radios small{color:var(--text-dim,#9b9890)}',
    /* the 3-2-1 re-centre countdown, while driving */
    '.cw-cd{position:fixed;left:50%;top:22%;transform:translateX(-50%);z-index:2147482000;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:8px;font-family:var(--hud-font);color:var(--hud-ink);text-shadow:0 4px 24px rgba(0,0,0,.7)}',
    '.cw-cd b{font:800 calc(var(--fs-2xl) * 4.29)/1 var(--hud-font)} .cw-cd span{font:700 var(--fs-xl)/1.3 var(--hud-font);padding:6px 14px;border-radius:var(--pill);background:var(--hud-panel);border:1px solid var(--hud-line);text-align:center}',
    '.cw-cd small{font:600 var(--fs-xs) var(--hud-font);opacity:.75}',
    '.cw-count small{display:block;font:700 var(--fs-lg)/1.3 var(--hud-font);margin-top:10px;text-align:center}',
    /* the Start flow, the pedal chip, the driving HUD and the first-drive intro */
    '.cw-btn.big{min-height:46px;padding:0 20px;font-size:var(--fs-lg)}',
    '.cw-flow{margin:0;padding:0;list-style:none;display:grid;gap:6px;counter-reset:cwf}',
    '.cw-flow li{display:flex;align-items:center;gap:10px;font-size:var(--fs-md);color:var(--text-dim,#9b9890);counter-increment:cwf}',
    '.cw-flow li i{flex:none;width:22px;height:22px;border-radius:50%;border:1.5px solid var(--line,#2b2c33);display:grid;place-items:center;font:700 var(--fs-xs) var(--hud-font);font-style:normal}',
    '.cw-flow li i::before{content:counter(cwf)} .cw-flow li.is-now{color:var(--text-strong,#fff);font-weight:700} .cw-flow li.is-now i{border-color:var(--accent,#c9a56b);color:var(--accent,#c9a56b)}',
    '.cw-flow li.is-done{color:var(--text,#ecebe6)} .cw-flow li.is-done i{background:var(--good,var(--hud-good));border-color:transparent;color:var(--accent-ink)} .cw-flow li.is-done i::before{content:"\\2713"}',
    '.cw-flow small{font-weight:600;color:var(--accent,#c9a56b);margin-left:4px}',
    '.cw-more summary{cursor:pointer;font-size:var(--fs-xs);color:var(--text-dim,#9b9890);margin-top:4px} .cw-more label{margin-top:6px}',
    '.cw-pchip{display:flex;align-items:center;gap:10px;margin-top:10px;padding:8px 12px;border-radius:var(--radius);border:1px solid var(--line,#2b2c33);background:var(--panel-2);min-height:44px}',
    '.cw-pchip b{font:800 var(--fs-xl)/1 var(--hud-font);letter-spacing:.04em;min-width:96px} .cw-pchip small{color:var(--text-dim,#9b9890);font-size:var(--fs-xs);margin-left:auto}',
    '.cw-pchip .cw-hand{display:inline-grid;place-items:center} .cw-pchip.is-go b,.cw-hud.is-go b{color:var(--hud-good)} .cw-pchip.is-brake b,.cw-hud.is-brake b{color:var(--hud-bad)} .cw-pchip.is-rev b,.cw-hud.is-rev b{color:var(--hud-warn)} .cw-pchip.is-lost b,.cw-hud.is-lost b{color:var(--hud-dim)}',
    '.cw-hud{position:fixed;right:16px;top:50%;transform:translateY(-50%);z-index:2147481200;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:112px;padding:10px 14px;border-radius:16px;background:var(--hud-panel);border:2px solid var(--hud-line);color:var(--hud-ink);font-family:var(--hud-font);box-shadow:0 8px 26px rgba(0,0,0,.45)}',
    '.cw-hud b{font:900 calc(var(--fs-2xl) * 1.21)/1 var(--hud-font);letter-spacing:.04em} .cw-hud small{font:600 var(--fs-2xs)/1.2 var(--hud-font);opacity:.75;text-align:center} .cw-hud .cw-hand{opacity:.9}',
    '.cw-hud.is-go{border-color:rgba(63,191,127,.75);background:rgba(10,40,24,.78)} .cw-hud.is-brake{border-color:rgba(255,90,95,.85);background:rgba(60,10,12,.8)} .cw-hud.is-rev{border-color:rgba(242,193,78,.85);background:rgba(55,40,6,.8)}',
    '.cw-hud b.is-rev{font-size:calc(var(--fs-2xl) * 1.57)}',
    '.cw-intro{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147482500;display:grid;gap:12px;padding:22px 26px;border-radius:18px;background:var(--hud-panel);border:1px solid var(--hud-line);color:var(--hud-ink);font-family:var(--hud-font);box-shadow:0 20px 60px rgba(0,0,0,.55);max-width:min(560px,92vw);cursor:pointer}',
    '.cw-intro h3{margin:0;font:800 var(--fs-xl)/1.2 var(--hud-font)} .cw-intro ol{margin:0;padding:0;list-style:none;display:grid;gap:10px}',
    '.cw-intro li{display:flex;align-items:center;gap:12px;font:600 var(--fs-lg)/1.3 var(--hud-font)} .cw-intro li b{flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--accent,#c9a56b);color:var(--accent-ink);font-size:var(--fs-lg)}',
    '.cw-intro small{opacity:.7;font-size:var(--fs-xs)}',
    '.cw-tipx{position:fixed;left:50%;bottom:calc(30% + 8px);transform:translateX(-50%);z-index:2147481500;pointer-events:none;padding:9px 16px;border-radius:var(--pill);background:var(--hud-panel);border:1px solid var(--hud-line);color:var(--hud-ink);font:600 var(--fs-md) var(--hud-font);text-align:center;max-width:min(560px,90vw);box-shadow:0 6px 20px rgba(0,0,0,.4)}'
  ].join('\n');
  function ensureCss() {
    if (document.getElementById('cw-css')) return;
    var s = document.createElement('style'); s.id = 'cw-css'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  var REASONS = {
    insecure: 'The camera only works on secure pages. Open the game from its <b>https://</b> address (or <code>http://localhost</code> with <code>node tools/dev-server.js</code>). Plain http on the network cannot use the webcam.',
    file: 'The webcam wheel cannot run from a file opened on disk (browsers block the camera and the hand-tracking model there). Open the game from its <b>https://</b> address, or run <code>node tools/dev-server.js</code> and open <code>http://localhost:8080</code>.',
    unsupported: 'This browser has no camera API (getUserMedia). Try a current Chrome, Edge, Firefox or Safari.',
    denied: 'Camera access was blocked. Allow the camera for this site (the camera icon in the address bar) and press <b>Start camera</b> again.',
    notfound: 'No camera found. Plug in a webcam or pick another camera.',
    busy: 'The camera is in use by another app (video call?) or could not start. Close that app and press <b>Start camera</b>.',
    ended: 'The camera stopped (unplugged or taken by another app). Press <b>Start camera</b> to try again.',
    error: 'The camera could not start. Press <b>Start camera</b> to try again.'
  };
  var MODEL_FAIL = {
    file: REASONS.file,
    nowasm: 'This browser cannot run WebAssembly, which hand tracking needs. Try a current Chrome, Edge, Firefox or Safari.',
    load: 'Hand tracking could not load (vendor/mediapipe/ missing or blocked?). Reload the page to try again.',
    missing: 'Hand tracking is not part of this build.'
  };
  var WARN = {
    skin: 'This colour is close to skin, so hands, arms or your face can confuse the tracker. A blue, green or magenta object works better.',
    dull: 'The colour is quite pale. A brighter, more colourful object tracks better.',
    clutter: 'Something else of the same colour is in view (switch on <b>Show mask</b> to see it). Move it out of the picture or use another colour.',
    round: 'This object looks round. For <b>One bar</b> hold something long and thin, or switch to <b>Two markers</b>.',
    small: 'The markers look small. Move a little closer or use bigger markers.'
  };
  var FAIL = {
    nohands: 'No hands in view. Hold both hands up in front of the camera, as if gripping a steering wheel, and try again.',
    skin: 'Marker mode needs a coloured object: that looks like bare skin. (For bare hands, switch marker mode off.)',
    dull: 'The colour in the box is too grey or pale to track. Hold a brightly coloured object inside the dashed box(es).',
    nothing: 'No colourful object found in the box. Hold it inside the dashed box (or boxes), level, and try again.',
    merged: 'The two markers touch. Hold them apart, like your hands on a wheel.',
    noframe: 'No camera picture yet. Wait for the preview, then calibrate.'
  };

  // [id, name, description, older (listed under "Older pedal modes")]
  var PEDAL_OPTS = [
    ['fist', 'Fist = go, open hand = brake (recommended)', 'Make fists (grip the wheel) to drive, open your hands (fingers straight) to brake, in between = coast. Keep them open at a stop to reverse.'],
    ['auto', 'Auto-gas', 'The car drives itself; open your hands to brake.'],
    ['off', 'Keyboard / gamepad pedals', 'Hands steer; W / S, the arrows, triggers or touch pedals drive.'],
    ['grip', 'Grip + pull back', 'Close your hands = gas (the tighter, the more), pull both hands back towards you = brake.', true],
    ['push', 'Push / pull', 'Push your hands towards the screen = gas, pull them back = brake.', true]
  ];
  function pedalHelp(one) {
    var cw = CW(), p = cw ? cw.prefs.pedals : 'fist';
    if (p === 'fist') return one ? '<b>Make a fist</b> to drive (GO), <b>open your hand</b> to brake, in between = coast. Keep it open at a stop to reverse.' :
      '<b>Make fists</b> to drive (GO), <b>open both hands</b> (fingers straight) to brake, in between = coast. Keep them open at a stop to reverse.';
    if (p === 'auto') return 'The car accelerates on its own: <b>open your hand' + (one ? '' : 's') + '</b> to brake.';
    if (p === 'push') return '<b>Push your hands towards the screen</b> for gas, <b>pull them back</b> to brake; hold the brake when stopped to reverse.';
    if (p === 'grip') return '<b>Close your hands</b> to drive (the tighter, the more gas), <b>relax</b> them to coast, <b>pull both hands back</b> towards you to brake.';
    return 'Throttle and brake stay on the keyboard or gamepad.';
  }
  /* hand-state icons (fist / half / open) for the pedal chip and the HUD */
  var HAND_SVG = {
    closed: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><rect x="5" y="7" width="14" height="10" rx="3.5"/><rect x="7" y="16" width="9" height="6" rx="2"/><path d="M8.5 7v4M12 7v4M15.5 7v4" stroke="rgba(0,0,0,.35)" stroke-width="1.2"/></svg>',
    mid: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><rect x="6" y="11" width="12" height="8" rx="3"/><rect x="6.2" y="5.5" width="2.6" height="7" rx="1.3"/><rect x="9.6" y="4.5" width="2.6" height="8" rx="1.3"/><rect x="13" y="5" width="2.6" height="7.5" rx="1.3"/><rect x="2.8" y="11" width="4.5" height="2.6" rx="1.3"/><rect x="8" y="18" width="8" height="4" rx="1.5"/></svg>',
    open: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><rect x="6" y="11" width="12" height="8" rx="3"/><rect x="6" y="2" width="2.6" height="11" rx="1.3"/><rect x="9.4" y="1" width="2.6" height="12" rx="1.3"/><rect x="12.8" y="1.5" width="2.6" height="11.5" rx="1.3"/><rect x="16" y="3.5" width="2.4" height="9.5" rx="1.2"/><rect x="1.5" y="9" width="6" height="2.6" rx="1.3" transform="rotate(25 4.5 10.3)"/><rect x="8" y="18" width="8" height="4" rx="1.5"/></svg>'
  };
  /** the big pedal state: GO / COAST / BRAKE / R (+ the hand icon) from a pedals output */
  function pedalLabel(pd) {
    if (!pd || pd.state === 'off') return { k: 'off', t: '—' };
    if (pd.reverse) return { k: 'rev', t: 'R' };
    if (pd.state === 'lost') return { k: 'lost', t: pd.brake ? 'NO HANDS' : 'COAST' };
    if (pd.state === 'gas') return { k: 'go', t: 'GO' };
    if (pd.state === 'brake' || pd.state === 'reverse') return { k: 'brake', t: 'BRAKE' };
    return { k: 'coast', t: 'COAST' };
  }
  function paintChip(node, pd, mode) {
    if (!node) return;
    var L = pedalLabel(pd), hand = pd && pd.hand, key = L.k + '|' + L.t + '|' + hand;
    if (node._k === key) return;
    node._k = key;
    node.className = 'cw-pchip is-' + L.k;
    node.innerHTML = '<b>' + L.t + '</b>' + (hand && HAND_SVG[hand] ? '<span class="cw-hand" title="' + (hand === 'closed' ? 'hands closed' : hand === 'open' ? 'hands open' : 'hands half open') + '">' + HAND_SVG[hand] + '</span>' : '') +
      '<small>' + (mode === 'auto' ? 'open hands = brake' : mode === 'fist' ? 'fists = go · open = brake' : '') + '</small>';
  }
  /* "Easy driving" for the webcam (prefs.easyAssist, on by default): Heavy steering assist for Race and Drift and the
     automatic gearbox, applied the first time the webcam wheel is switched on (and whenever the toggle is turned on);
     turning it off restores the levels the player had before. force: apply / restore now (the toggle). */
  var EASY_KEY = 'forge.camWheel.easy.v1';
  function applyEasy(force) {
    var cw = CW(), R = CB.race && CB.race.ui;
    if (!cw || !R || typeof R.patchSettings !== 'function') return false;
    var st = null; try { st = JSON.parse(localStorage.getItem(EASY_KEY) || 'null'); } catch (e) { st = null; }
    if (cw.prefs.easyAssist) {
      if (st && st.applied && !force) return false;
      var prev = null;
      R.patchSettings(function (s) {
        prev = { race: s.raceSteerAssist, drift: s.driftSteerAssist, autoShift: !!(s.assists && s.assists.autoShift) };
        s.raceSteerAssist = 'heavy'; s.driftSteerAssist = 'heavy';
        if (s.assists) s.assists.autoShift = true;
      });
      try { localStorage.setItem(EASY_KEY, JSON.stringify({ applied: true, prev: st && st.prev && st.applied ? st.prev : prev })); } catch (e) { /* ignore */ }
      return true;
    }
    if (force && st && st.applied && st.prev) {
      R.patchSettings(function (s) {
        if (s.raceSteerAssist === 'heavy') s.raceSteerAssist = st.prev.race || s.raceSteerAssist;
        if (s.driftSteerAssist === 'heavy') s.driftSteerAssist = st.prev.drift || s.driftSteerAssist;
        if (s.assists && typeof st.prev.autoShift === 'boolean') s.assists.autoShift = st.prev.autoShift;
      });
      try { localStorage.setItem(EASY_KEY, JSON.stringify({ applied: false, prev: null, off: true })); } catch (e) { /* ignore */ }
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- overlay drawing */
  var BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
  /** hands: landmark skeletons + a virtual steering wheel through the two palm centres, turned by the steering angle */
  function drawHands(g, W, H, cw, opts) {
    var B = cw._b, m = B.lastHands, st = B.steer;
    var lost = !st || st.read(performance.now()).lost;
    g.save();
    var lw = Math.max(1.5, W / 320);
    if (m && m.hands) {
      m.hands.forEach(function (c) {
        var lm = c.h.lm;
        g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = lw;
        g.beginPath();
        BONES.forEach(function (b) { g.moveTo((1 - lm[b[0]].x) * W, lm[b[0]].y * H); g.lineTo((1 - lm[b[1]].x) * W, lm[b[1]].y * H); });
        g.stroke();
        g.fillStyle = '#c9a56b';
        for (var i = 0; i < 21; i++) { g.beginPath(); g.arc((1 - lm[i].x) * W, lm[i].y * H, lw * 1.6, 0, Math.PI * 2); g.fill(); }
      });
    }
    var vw = B.camW || W, sx = W / vw, sy = H / (B.camH || H);
    if (m && m.ok && st) {
      var col = lost ? '#e5484d' : m.mode === 'two' ? '#3fbf7f' : '#e3a33a';
      var a = st.angle * Math.PI / 180, cx, cy, r;
      if (m.mode === 'top' && m.rim) {
        // one hand on the rim: the virtual wheel around its fixed centre, the grip point where the hand holds it
        cx = m.rim.cx * sx; cy = m.rim.cy * sy; r = m.rim.r * sx;
        col = lost ? '#e5484d' : '#4fb3ff';
      } else if (m.mode === 'two' && m.pts.length === 2) {
        cx = (m.pts[0].x + m.pts[1].x) / 2 * sx; cy = (m.pts[0].y + m.pts[1].y) / 2 * sy;
        r = Math.hypot((m.pts[1].x - m.pts[0].x) * sx, (m.pts[1].y - m.pts[0].y) * sy) / 2;
      } else {
        var p = m.pts[0]; r = m.wheelR > 0 ? m.wheelR * sx : Math.max(W * 0.12, p.size * sx * 1.6);   // (the two-hand wheel's size)
        // one hand on the rim at 9 or 3 o'clock: the hub is beside it
        var side = B.solver && B.solver.tracks && B.solver.tracks.a ? 1 : -1;
        cx = p.x * sx + side * Math.cos(a) * r; cy = p.y * sy + side * Math.sin(a) * r;
      }
      g.strokeStyle = col; g.lineWidth = Math.max(3, W / 110); g.globalAlpha = 0.9;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
      // spokes: 9-3 bar + the bottom spoke, turned with the wheel; a marker at the top
      g.lineWidth = Math.max(2, W / 200);
      g.beginPath(); g.moveTo(cx - Math.cos(a) * r, cy - Math.sin(a) * r); g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      g.moveTo(cx, cy); g.lineTo(cx - Math.sin(a) * r, cy + Math.cos(a) * r); g.stroke();
      g.fillStyle = col; g.beginPath(); g.arc(cx + Math.sin(a) * r, cy - Math.cos(a) * r, Math.max(4, W / 90), 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(cx, cy, Math.max(4, W / 80), 0, Math.PI * 2); g.fill();
      if (m.mode === 'top' && m.rim) {
        var gx = m.rim.gx * sx, gy = m.rim.gy * sy;
        g.setLineDash([5, 5]); g.lineWidth = Math.max(1.5, W / 260); g.strokeStyle = '#fff';
        g.beginPath(); g.moveTo(cx, cy); g.lineTo(gx, gy); g.stroke(); g.setLineDash([]);
        g.fillStyle = '#fff'; g.beginPath(); g.arc(gx, gy, Math.max(5, W / 70), 0, Math.PI * 2); g.fill();
        g.strokeStyle = col; g.lineWidth = Math.max(2, W / 220); g.stroke();
        if (opts.label !== false && !opts.small) {
          g.font = '600 ' + Math.round(H * 0.04) + 'px system-ui,sans-serif'; g.textAlign = 'center'; g.fillStyle = '#fff';
          g.shadowColor = 'rgba(0,0,0,.8)'; g.shadowBlur = 4;
          g.fillText(sideName(m.side), gx, gy - Math.max(14, H * 0.05)); g.shadowBlur = 0;
        }
      }
      g.globalAlpha = 1;
      if (opts.label !== false) {
        g.font = '700 ' + Math.round(H * (opts.small ? 0.11 : 0.055)) + 'px system-ui,sans-serif'; g.textAlign = 'center'; g.fillStyle = '#fff';
        g.shadowColor = 'rgba(0,0,0,.8)'; g.shadowBlur = 4;
        g.fillText((st.angle >= 0 ? '+' : '') + Math.round(st.angle) + '°', cx, cy - Math.max(16, r * 0.25));
      }
      // re-centre countdown: a dashed ghost of the new neutral (the hands as they are now = straight ahead)
      if (cw.countdown && cw.countdown() && m.mode === 'two' && m.pts.length === 2) {
        g.setLineDash([7, 6]); g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = Math.max(2, W / 220);
        g.beginPath(); g.moveTo(m.pts[0].x * sx, m.pts[0].y * sy); g.lineTo(m.pts[1].x * sx, m.pts[1].y * sy); g.stroke();
        g.setLineDash([]);
      }
    }
    if (opts.pedals !== false) drawPedals(g, W, H, cw);
    g.restore();
  }
  /** gas / brake bars on the right edge of the preview */
  function drawPedals(g, W, H, cw) {
    var p = cw.prefs.pedals;
    if (!p || p === 'off' || cw.prefs.method === 'marker') return;
    var pd = cw.stats().pedals || { throttle: 0, brake: 0 };
    var bw = Math.max(5, W / 48), gap = bw * 0.6, h = H * 0.42, y0 = H * 0.5 - h / 2, x0 = W - gap - bw * 2 - gap;
    [['G', pd.throttle, '#3fbf7f'], ['B', pd.brake, '#e5484d']].forEach(function (b, i) {
      var x = x0 + i * (bw + gap);
      g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(x, y0, bw, h);
      g.fillStyle = b[2]; g.fillRect(x, y0 + h * (1 - clamp(b[1] || 0, 0, 1)), bw, h * clamp(b[1] || 0, 0, 1));
      g.fillStyle = '#fff'; g.font = '700 ' + Math.round(Math.max(8, bw * 1.3)) + 'px system-ui,sans-serif'; g.textAlign = 'center';
      g.fillText(b[0], x + bw / 2, y0 + h + bw * 1.6);
    });
  }
  /** marker mode: mask, calibration boxes, tracked blobs */
  function drawMarkers(g, W, H, cw, opts) {
    var B = cw._b, T = B.tracker, sx = W / (B.w || 1), sy = H / (B.h || 1);
    if (opts.mask && T && T.clusters && T.clusters.work) {
      var cls = T.clusters.work.cls, n = B.w * B.h;
      if (!opts._mimg || opts._mimg.width !== B.w || opts._mimg.height !== B.h) { opts._mc = document.createElement('canvas'); opts._mc.width = B.w; opts._mc.height = B.h; opts._mimg = opts._mc.getContext('2d').createImageData(B.w, B.h); }
      var d = opts._mimg.data;
      for (var i = 0; i < n; i++) { var c = cls[i], j = i * 4; d[j] = c & 2 ? 60 : c ? 255 : 0; d[j + 1] = c & 2 ? 200 : c ? 40 : 0; d[j + 2] = c & 2 ? 255 : c ? 230 : 0; d[j + 3] = c ? 200 : 110; }
      opts._mc.getContext('2d').putImageData(opts._mimg, 0, 0);
      g.imageSmoothingEnabled = false; g.drawImage(opts._mc, 0, 0, W, H); g.imageSmoothingEnabled = true;
    }
    if (opts.boxes) {
      g.save(); g.setLineDash([8, 6]); g.lineWidth = 2.5; g.strokeStyle = 'rgba(255,255,255,.9)';
      opts.boxes.forEach(function (b) { g.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H); });
      g.setLineDash([]); g.fillStyle = 'rgba(255,255,255,.92)'; g.font = '600 ' + Math.round(H * 0.04) + 'px system-ui,sans-serif'; g.textAlign = 'center';
      if (opts.boxes.length === 2) { g.fillText('left marker', (opts.boxes[0].x + opts.boxes[0].w / 2) * W, opts.boxes[0].y * H - 8); g.fillText('right marker', (opts.boxes[1].x + opts.boxes[1].w / 2) * W, opts.boxes[1].y * H - 8); }
      else g.fillText('hold the bar level in the box', 0.5 * W, opts.boxes[0].y * H - 8);
      g.restore();
    }
    var m = T && T.last;
    if (m && m.pts && m.pts.length) {
      g.save(); g.lineWidth = Math.max(2, W / 160);
      var col = m.ok ? (m.partial ? '#e3a33a' : '#3fbf7f') : '#e5484d';
      g.strokeStyle = col; g.fillStyle = col;
      m.pts.forEach(function (p) { var r = Math.max(6, Math.sqrt(p.n / Math.PI) * sx); g.beginPath(); g.arc(p.x * sx, p.y * sy, r, 0, Math.PI * 2); g.stroke(); });
      if (m.ok) {
        var c2 = m.centre || m.pts[0], a = (B.steer ? B.steer.unwrapped : m.angle) * Math.PI / 180, L = (m.pts.length > 1 ? Math.hypot(m.pts[1].x - m.pts[0].x, m.pts[1].y - m.pts[0].y) / 2 : (m.len || 30) / 2) * sx;
        if (m.pts.length === 2) { g.beginPath(); g.moveTo(m.pts[0].x * sx, m.pts[0].y * sy); g.lineTo(m.pts[1].x * sx, m.pts[1].y * sy); g.stroke(); }
        else { g.beginPath(); g.moveTo(c2.x * sx - Math.cos(a) * L, c2.y * sy - Math.sin(a) * L); g.lineTo(c2.x * sx + Math.cos(a) * L, c2.y * sy + Math.sin(a) * L); g.stroke(); }
        g.beginPath(); g.arc(c2.x * sx, c2.y * sy, Math.max(3, W / 120), 0, Math.PI * 2); g.fill();
        if (opts.label !== false && B.steer) {
          g.font = '700 ' + Math.round(H * (opts.small ? 0.11 : 0.05)) + 'px system-ui,sans-serif'; g.textAlign = 'center'; g.fillStyle = '#fff';
          g.shadowColor = 'rgba(0,0,0,.8)'; g.shadowBlur = 4;
          g.fillText((B.steer.angle >= 0 ? '+' : '') + Math.round(B.steer.angle) + '°', c2.x * sx, c2.y * sy - Math.max(14, H * 0.06));
        }
      }
      g.restore();
    }
  }
  function drawOverlay(g, W, H, cw, opts) { if (cw.prefs.method === 'marker') drawMarkers(g, W, H, cw, opts); else drawHands(g, W, H, cw, opts); }
  /** the camera picture, mirrored (the player's view) */
  function drawVideo(g, W, H, vid) { g.save(); g.setTransform(-1, 0, 0, 1, W, 0); g.drawImage(vid, 0, 0, W, H); g.restore(); }

  /* ---------------------------------------------------------------- dialog */
  var dlg = null;
  function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'), function (n) {
      return !n.disabled && n.getClientRects().length > 0;
    });
  }
  /** keep Tab / Shift+Tab inside the dialog */
  function trapTab(e, root) {
    var f = focusables(root);
    if (!f.length) { e.preventDefault(); return; }
    var a = document.activeElement, i = f.indexOf(a);
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i < 0 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
  }
  function close() {
    if (!dlg) return;
    var d = dlg; dlg = null;
    if (d.offs) d.offs.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } });
    if (d.raf) cancelAnimationFrame(d.raf);
    if (d.countT) clearInterval(d.countT);
    window.removeEventListener('keydown', d.key, true);
    if (d.ov.parentNode) d.ov.parentNode.removeChild(d.ov);
    if (d.opener && d.opener.focus && document.contains(d.opener)) { try { d.opener.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    var cw = CW();
    if (cw && !cw.enabled()) cw.stop();                  // never switched on: camera off again
    refreshPicker();
    pipSync(); hudSync();
  }
  function modeName(st) { return st.handMode === 'two' ? 'Two hands' : st.handMode === 'top' ? sideName(st.handSide) + ' at the top' : 'One hand'; }
  function delayText(st) { return st.latency != null ? ' · delay ~' + Math.round(st.latency) + ' ms' : st.pageLatency != null ? ' · delay ~' + Math.round(st.pageLatency) + ' ms' : ''; }
  function statusLine(cw) {
    var st = cw.stats(), s = st.state, hm = st.method === 'hands';
    if (s === 'off') return { cls: '', text: 'Camera off' };
    if (s === 'starting') return { cls: '', text: 'Starting the camera… allow camera access if your browser asks.' };
    if (s === 'error') return { cls: 'bad', text: 'Camera not available' };
    if (hm) {
      var M = cw.model();
      if (M.state === 'loading' || M.state === 'idle') return { cls: '', text: 'Loading hand tracking (about 19 MB, only the first time)…' };
      if (M.state === 'error') return { cls: 'bad', text: 'Hand tracking could not load' };
      var info = (st.fps || 0) + ' fps · ' + (st.inferMs != null ? st.inferMs.toFixed(1) : '—') + ' ms (' + (st.delegate === 'GPU' ? 'GPU' : 'CPU') + ')' + delayText(st);
      if (st.lost) return { cls: 'bad', text: (st.handStyle === 'top' ? 'No hand in view: hold one hand up at the top of the wheel' : st.hands ? 'Hold both hands up like a wheel' : 'No hands in view: hold them up in front of the camera') + ' · ' + info };
      return { cls: 'ok', text: modeName(st) + ' · ' + Math.round(st.conf * 100) + '% · ' + info };
    }
    var inf = (st.fps || 0) + ' fps · ' + (st.procMs != null ? st.procMs.toFixed(1) : '—') + ' ms/frame' + delayText(st);
    if (!st.calibrated || s === 'calibrate') return { cls: '', text: 'Marker mode: not calibrated yet · ' + inf };
    if (st.lost) return { cls: 'bad', text: 'Lost: show the marker(s) to the camera · ' + inf };
    return { cls: 'ok', text: 'Tracking markers · ' + Math.round(st.conf * 100) + '% · ' + inf };
  }
  /* the Start flow (hands): camera -> 3-2-1 centre -> "make fists" test -> "open your hands" test -> done */
  var FLOW = [['camera', 'Camera on'], ['centre', 'Hold your hands like a wheel (3-2-1)'], ['fist', 'Make fists: that is GO'], ['open', 'Open your hands: that is BRAKE'], ['done', 'Drive!']];
  function needHands() { return hstyle() === 'two' ? 2 : 1; }
  function testsWanted() { var p = CW().prefs.pedals; return p === 'fist' || p === 'auto'; }
  function open() {
    var cw = CW();
    if (!cw) return null;
    ensureCss();
    if (dlg) close();
    var P = cw.prefs;
    var opener = document.activeElement;
    var ov = el('div', 'cw-ov'); ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Use webcam as wheel');
    var card = el('div', 'cw-card'), left = el('div', 'cw-left'), right = el('div', 'cw-right');
    var view = el('div', 'cw-view'), cv = el('canvas'), msg = el('div', 'cw-msg', 'Starting the camera…'), count = el('div', 'cw-count', '');
    cv.width = 640; cv.height = 480;
    view.appendChild(cv); view.appendChild(msg); view.appendChild(count);
    left.appendChild(view);
    var meter = el('div', '', '<div class="cw-range"><span>Steering</span><div class="cw-bar"><i></i></div><b data-k="ang">—</b></div>' +
      '<div class="cw-ped" data-ped style="margin-top:6px"><span>Gas</span><div class="cw-pbar"><i data-k="gas"></i></div><b data-k="gasv">—</b></div>' +
      '<div class="cw-ped" data-ped style="margin-top:6px"><span>Brake</span><div class="cw-pbar brk"><i data-k="brk"></i></div><b data-k="brkv">—</b></div>' +
      '<div class="cw-pchip" data-ped data-k="chip"></div>');
    meter.style.cssText = 'display:grid;gap:0';
    left.appendChild(meter);
    var tools = el('div', 'cw-row');
    tools.innerHTML = '<button class="cw-btn cb-btn" type="button" data-k="ctr">Centre <kbd>C</kbd></button>' +
      '<button class="cw-btn cb-btn" type="button" data-k="cal" data-marker>Calibrate markers</button>' +
      '<label class="cw-check" data-marker><input type="checkbox" data-k="mask"> Show mask</label>';
    left.appendChild(tools);
    left.appendChild(el('div', 'cw-priv', ICON.cam + '<span>Your video stays on this computer: frames are analysed in this tab and are never uploaded, saved or shared. The camera turns off when you switch the webcam wheel off or leave the page.</span>'));
    var head = el('div', '');
    var flowEl = el('ol', 'cw-flow'); flowEl.setAttribute('data-hands', '');
    var steps = el('div', '');
    var go = el('div', 'cw-row');
    go.innerHTML = '<button class="cw-btn cb-btn primary large big" type="button" data-k="go">' + ICON.cam + ' <span>Start</span> <kbd>Space</kbd></button>' +
      '<button class="cw-btn cb-btn ghost" type="button" data-k="skip" style="display:none">Skip this test</button>';
    var hseg = el('div', 'cw-seg'); hseg.setAttribute('data-hands', ''); hseg.setAttribute('aria-label', 'Steering style');
    STYLE_OPTS.forEach(function (o) { var b = el('button', '', esc(o[1])); b.type = 'button'; b.setAttribute('data-hs', o[0]); hseg.appendChild(b); });
    var wsize = el('label', 'cw-range', '<span>Wheel size</span><input type="range" min="0.5" max="2" step="0.05" value="' + cw.prefs.wheelSize + '" data-p="wheelSize"><b>' + Math.round(cw.prefs.wheelSize * 100) + '%</b>');
    function renderText() {
      var hm = handsMode();
      head.innerHTML = '<div class="cw-eyebrow">Webcam air wheel</div><h2 class="cw-h">' + (hm ? 'Drive with your hands' : 'Marker mode') + '</h2>';
      var hs = hstyle();
      Array.prototype.forEach.call(hseg.children, function (c) { c.classList.toggle('is-on', c.getAttribute('data-hs') === hs); });
      wsize.style.display = hm && hs !== 'two' ? '' : 'none';
      steps.innerHTML = hm ?
        '<div class="cw-dim">' + (hs === 'top' ? 'Hold <b>one hand</b> at the <b>top of an imaginary wheel</b> and move it along the rim to steer. ' : 'Hold your hands up at <b>9 and 3</b> of an imaginary wheel and turn it to steer. ') +
        pedalHelp(hs === 'top') + ' Sit back so the camera sees both hands; light from the front helps. Keyboard and gamepad pedals always work too.</div>' :
        '<ol class="cw-steps"><li>Hold a brightly coloured marker in each hand (or one coloured bar).</li>' +
        '<li>Hold them level inside the dashed box(es) and press <b>Start</b> (3-2-1).</li>' +
        '<li>Turn them like a steering wheel. <b>Centre</b> sets straight ahead.</li></ol>';
      Array.prototype.forEach.call(card.querySelectorAll('[data-marker]'), function (n) { n.style.display = hm ? 'none' : ''; });
      Array.prototype.forEach.call(card.querySelectorAll('[data-hands]'), function (n) { n.style.display = hm ? '' : 'none'; });
      Array.prototype.forEach.call(card.querySelectorAll('[data-ped]'), function (n) { n.style.display = hm && cw.prefs.pedals !== 'off' ? '' : 'none'; });
      renderFlow();
    }
    var seg = el('div', 'cw-seg'); seg.setAttribute('data-marker', '');
    [['pair', 'Two markers'], ['bar', 'One bar']].forEach(function (s) {
      var b = el('button', P.style === s[0] ? 'is-on' : '', esc(s[1])); b.type = 'button'; b.setAttribute('data-style', s[0]);
      seg.appendChild(b);
    });
    var camRow = el('div', 'cw-row'); camRow.style.display = 'none';
    camRow.innerHTML = '<span class="cw-dim">Camera</span><select class="cw-sel" data-k="dev"></select>';
    var warn = el('div', 'cw-warn');
    var status = el('div', 'cw-status', '<span class="cw-dot"></span><span>Starting…</span>');
    var tune = el('div', '');
    tune.style.cssText = 'display:grid;gap:8px';
    tune.innerHTML = '<label class="cw-range"><span>Full lock at</span><input type="range" min="20" max="180" step="5" value="' + P.maxAngle + '" data-p="maxAngle"><b>' + P.maxAngle + '°</b></label>' +
      '<label class="cw-range"><span>Dead zone</span><input type="range" min="0" max="10" step="0.5" value="' + P.deadzone + '" data-p="deadzone"><b>' + P.deadzone + '°</b></label>' +
      '<label class="cw-range"><span>Smoothing</span><input type="range" min="0" max="1" step="0.05" value="' + P.smoothing + '" data-p="smoothing"><b>' + Math.round(P.smoothing * 100) + '%</b></label>' +
      '<label class="cw-check"><input type="checkbox" data-k="pip"' + (P.pip ? ' checked' : '') + '> Show the camera preview while driving</label>';
    tune.insertBefore(wsize, tune.firstChild);
    var peds = el('fieldset', 'cw-radios'); peds.setAttribute('data-hands', '');
    function radio(o) { return '<label><input type="radio" name="cw-ped" value="' + o[0] + '"' + (cw.prefs.pedals === o[0] ? ' checked' : '') + '><span><b>' + esc(o[1]) + '</b><br><small>' + esc(o[2]) + '</small></span></label>'; }
    peds.innerHTML = '<legend>Gas and brake</legend>' + PEDAL_OPTS.filter(function (o) { return !o[3]; }).map(radio).join('') +
      '<details class="cw-more"><summary>Older pedal modes</summary>' + PEDAL_OPTS.filter(function (o) { return o[3]; }).map(radio).join('') + '</details>';
    var easy = el('label', 'cw-check'); easy.setAttribute('data-hands', '');
    easy.innerHTML = '<input type="checkbox" data-k="easy"' + (P.easyAssist ? ' checked' : '') + '> <span><b>Easy driving</b> (recommended for the webcam): Heavy steering assist for Race and Drift, and an automatic gearbox</span>';
    var opts = el('details', 'cw-adv'); opts.setAttribute('data-k', 'opts');
    opts.innerHTML = '<summary>Options</summary><div class="cw-advb"></div>';
    var ob = opts.querySelector('.cw-advb');
    var advB = el('div', 'cw-advb');
    advB.innerHTML =
      '<div class="cw-dim" style="font-weight:700">Advanced</div>' +
      '<label class="cw-check" data-hands><input type="checkbox" data-g="pullBrake"' + (P.pullBrake ? ' checked' : '') + '> Also brake by pulling both hands back towards you (off by default: a turned or rolled hand can look smaller; ignored while the wheel is turned or a hand is rolled)</label>' +
      '<label class="cw-check"><input type="checkbox" data-g="gestureHandbrake"' + (P.gestureHandbrake ? ' checked' : '') + '> Handbrake gesture (Drift): a quick downward yank of both hands</label>' +
      '<label class="cw-check"><input type="checkbox" data-g="gestureNitro"' + (P.gestureNitro ? ' checked' : '') + '> Nitro gesture (Arcade): push your hands quickly towards the camera (not with push / pull pedals)</label>' +
      '<label class="cw-check"><input type="checkbox" data-g="gestureItem"' + (P.gestureItem ? ' checked' : '') + '> Item gesture (Arcade): a quick upward flick of both hands</label>' +
      '<label class="cw-check"><input type="checkbox" data-g="lookahead"' + (P.lookahead ? ' checked' : '') + '> Lookahead (cancels the smoothing delay while turning)</label>' +
      '<label class="cw-check"><input type="checkbox" data-g="cpu"' + (P.cpu ? ' checked' : '') + '> Run hand tracking on the CPU (if the GPU misbehaves; slower)</label>' +
      '<label class="cw-check"><input type="checkbox" data-k="marker"' + (P.method === 'marker' ? ' checked' : '') + '> Marker mode: track coloured objects instead of hands (for very dim rooms or old computers)</label>';
    [el('div', 'cw-dim', '<b>Steering style</b>'), hseg, seg, peds, easy, tune, camRow, advB].forEach(function (n) { ob.appendChild(n); });
    var btns = el('div', 'cw-row');
    btns.innerHTML = '<button class="cw-btn cb-btn" type="button" data-k="done">Close</button><button class="cw-btn cb-btn ghost" type="button" data-k="off">Turn webcam wheel off</button>';
    var x = el('button', 'cw-btn cb-btn ghost cw-x', ICON.close); x.type = 'button'; x.setAttribute('aria-label', 'Close');
    [head, flowEl, steps, go, status, warn, opts, btns].forEach(function (n) { right.appendChild(n); });
    card.appendChild(left); card.appendChild(right); card.appendChild(x); ov.appendChild(card);
    document.body.appendChild(ov);
    var D = dlg = { ov: ov, offs: [], raf: 0, mask: false, counting: false, result: null, key: null, flow: null, opener: opener };
    hudSync();
    peds.addEventListener('change', function (e) {
      if (e.target.name !== 'cw-ped') return;
      cw.setPrefs({ pedals: e.target.value }); renderText();
    });
    var g = cv.getContext('2d');

    /* ---- the Start flow */
    function flowIdx(s) { for (var i = 0; i < FLOW.length; i++) if (FLOW[i][0] === s) return i; return -1; }
    function renderFlow() {
      var cur = D.flow ? flowIdx(D.flow.step) : D.flowDone ? FLOW.length : -1, tests = testsWanted();
      flowEl.innerHTML = FLOW.filter(function (f) { return tests || (f[0] !== 'fist' && f[0] !== 'open'); }).map(function (f) {
        var i = flowIdx(f[0]), cls = i < cur ? 'is-done' : i === cur ? 'is-now' : '';
        var txt = f[0] === 'centre' && hstyle() === 'top' ? 'Hold one hand at the top of the wheel (3-2-1)' : f[0] === 'fist' && hstyle() === 'top' ? 'Make a fist: that is GO' : f[0] === 'open' && hstyle() === 'top' ? 'Open your hand: that is BRAKE' : f[1];
        return '<li class="' + cls + '"><i></i><span>' + esc(txt) + (i === cur && D.flow && D.flow.note ? ' <small>' + esc(D.flow.note) + '</small>' : '') + '</span></li>';
      }).join('');
      var b = go.querySelector('[data-k="go"] span');
      b.textContent = D.flow ? 'Cancel' : D.flowDone ? 'Done: drive!' : handsMode() ? 'Start' : 'Start: calibrate';
      go.querySelector('[data-k="skip"]').style.display = D.flow && (D.flow.step === 'fist' || D.flow.step === 'open') && performance.now() - D.flow.t0 > 6000 ? '' : 'none';
    }
    function setStep(step, note) {
      if (dlg !== D) return;
      if (!step) { D.flow = null; renderFlow(); return; }
      D.flow = { step: step, t0: performance.now(), okT: 0, note: note || '' };
      if (step === 'centre') { cw.cancelCentre(); cw.startCentre(cw.prefs.pedals === 'grip' ? 'calibrate' : 'setup'); }
      if (step === 'fist') showWarn('<p><b>Make fists</b>, as if you grip the wheel tightly. The bar turns green: <b>GO</b>.</p>');
      if (step === 'open') showWarn('<p><b>Open your hands</b>: fingers straight, palms to the camera. That is <b>BRAKE</b> (and, held at a stop, <b>reverse</b>).</p>');
      if (step === 'done') finishFlow();
      renderFlow();
    }
    function startFlow() {
      if (D.flow) { cw.cancelCentre(); setStep(null); showWarn('Start cancelled.'); return; }
      if (D.flowDone) { doneClose(); return; }
      if (!handsMode()) { if (!cw.running()) start(); else cw.startCentre('calibrate'); return; }
      setStep('camera');
      if (!cw.running() && !D.starting) start();
    }
    function finishFlow() {
      D.flow = null; D.flowDone = true;
      cw.enable(); selectSource(); applyEasy(false);
      var p = cw.prefs.pedals;
      showWarn('<p><b>All set.</b> ' + (p === 'fist' ? '<b>Fists = go</b>, in between = coast, <b>open hands = brake</b> (held at a stop: reverse). ' : p === 'auto' ? 'The car drives itself: <b>open your hands to brake</b>. ' : '') +
        'Turn the wheel to steer. Press <b>Done</b> and drive.</p>', true);
      refreshPicker();
    }
    function flowTick() {
      var F = D.flow; if (!F) return;
      var now = performance.now(), hs = cw.handState(), need = needHands(), M = cw.model();
      if (F.step === 'camera') {
        if (!cw.running() || M.state !== 'ready') { F.note = ''; return; }
        if (hs.n >= need) { if (!F.okT) F.okT = now; if (now - F.okT > 400) setStep('centre'); }
        else { F.okT = 0; if (F.note !== 'show your hands') { F.note = 'show your hands'; renderFlow(); } }
        return;
      }
      if (F.step === 'fist' || F.step === 'open') {
        var good = hs.n >= need && (F.step === 'fist' ? hs.closed : hs.opened);
        if (good) { if (!F.okT) F.okT = now; } else F.okT = 0;
        var note = hs.n < need ? (need === 2 ? 'show both hands' : 'show your hand') : good ? 'hold it…' : F.step === 'fist' ? 'close them tighter' : 'straighten your fingers';
        if (note !== F.note) { F.note = note; renderFlow(); }
        if (F.okT && now - F.okT > 600) {
          var r = F.step === 'fist' ? cw.captureFist() : cw.captureOpen();
          if (r.ok || now - F.t0 > 15000) setStep(F.step === 'fist' ? 'open' : 'done');
        }
        if (now - F.t0 > 6000 && go.querySelector('[data-k="skip"]').style.display === 'none') renderFlow();
      }
    }
    renderText();

    function boxesNow() { return cw.defaultBoxes(cw.prefs.style); }
    function showWarn(html, ok) { warn.className = 'cw-warn' + (ok ? ' cw-ok' : ''); warn.innerHTML = html || ''; }
    function intro() {
      if (handsMode()) { if (!D.flow && !D.flowDone) showWarn(cw.prefs.handCal ? 'Press <b>Start</b> to set up again, or just <b>Close</b> and drive.' : 'Press <b>Start</b>: about 10 seconds, then drive.'); }
      else if (!cw.prefs.cal || cw.prefs.cal.style !== cw.prefs.style) showWarn('Hold your marker' + (cw.prefs.style === 'bar' ? '' : 's') + ' in the dashed box' + (cw.prefs.style === 'bar' ? '' : 'es') + ' and press <b>Start</b>.');
    }
    function start(devId) {
      msg.style.display = ''; msg.innerHTML = 'Starting the camera…';
      D.starting = true;
      return cw.start(devId ? { deviceId: devId } : {}).then(function (r) {
        D.starting = false;
        if (dlg !== D || r.reason === 'cancelled') return r;
        if (!r.ok) {
          msg.innerHTML = REASONS[r.reason] || REASONS.error;
          if (D.flow) setStep(null);
          return r;
        }
        msg.style.display = 'none';
        if (cw.ready()) cw.enable();
        intro();
        fillCams();
        return r;
      });
    }
    function fillCams() {
      cw.listCameras().then(function (list) {
        if (dlg !== D) return;
        var sel = camRow.querySelector('select');
        camRow.style.display = list.length > 1 ? '' : 'none';
        var cur = cw._b.devId || cw.prefs.deviceId;
        sel.innerHTML = list.map(function (c) { return '<option value="' + esc(c.deviceId) + '"' + (c.deviceId === cur ? ' selected' : '') + '>' + esc(c.label) + '</option>'; }).join('');
      });
    }
    function calibrate(kind) {
      if (!cw.running()) { start(); return; }
      cw.startCentre(kind || 'calibrate');
    }
    // the 3-2-1 countdown (any re-centre: buttons, keys, auto-centre): big numbers on the preview, the result below
    D.offs.push(cw.on('countdown', function (e) {
      if (dlg !== D) return;
      var hm = handsMode();
      D.counting = e.state === 'count';
      if (e.state === 'count') {
        var what = e.phase === 'grip' ? (hstyle() === 'top' ? 'Now <b>close your hand</b>: a firm grip' : 'Now <b>close your hands</b>: a firm grip') : hm ? holdText(e.kind) : (cw.prefs.style === 'bar' ? 'Hold the bar level' + (e.kind === 'centre' ? '' : ' inside the box') : 'Hold the markers level' + (e.kind === 'centre' ? '' : ', one in each box'));
        count.innerHTML = e.left + '<small>' + what + '</small>';
        if (e.left === 3 || e.phase === 'grip') showWarn((e.kind === 'auto' ? 'Centring automatically… ' : '') + what + '. Press <b>Esc</b> to cancel.');
        return;
      }
      count.innerHTML = '';
      if (e.state === 'cancel') { if (!D.flow) showWarn('Re-centre cancelled: the previous centre is kept.'); return; }
      if (e.state === 'fail') {
        var r = e.result || {};
        if (D.flow && D.flow.step === 'centre') { showWarn('<p>' + (FAIL[r.reason] || FAIL.nothing) + '</p>'); setStep('camera'); return; }
        if (e.phase === 'grip') showWarn('<p><b>Centred</b>, but the grip did not look closed enough to learn it' + (r.reason === 'nohands' ? ' (hands not in view)' : '') + '. The default grip is used; press <b>Start</b> to try again.</p>');
        else showWarn('<p>' + (FAIL[r.reason] || FAIL.nothing) + '</p>');
        return;
      }
      var r2 = e.result || {};
      if (e.state === 'captured') return;
      if (e.state !== 'done') return;
      D.result = r2;
      cw.enable();
      if (hm) {
        if (D.flow && D.flow.step === 'centre') { setStep(testsWanted() ? 'fist' : 'done'); return; }
        var txt = e.kind === 'calibrate' ? '<b>Calibrated:</b> centre and full grip learnt. ' : e.kind === 'auto' ? '<b>Centred automatically.</b> ' : '<b>Centred.</b> ';
        var how = r2.mode === 'top' ? '<b>' + sideName(r2.side) + '</b> at the top of the wheel: move it along the rim to steer. ' : r2.mode === 'hands1' ? 'One hand: tilt it like a wheel. Two hands track better. ' : 'Turn your hands like a wheel to steer. ';
        showWarn('<p>' + txt + how + (cw.prefs.pedals !== 'off' && r2.mode !== 'hands1' ? pedalHelp(r2.mode === 'top') : '') + '</p>', true);
        refreshPicker(); return;
      }
      var ws = (r2.warnings || []).map(function (k) { return WARN[k] ? '<p>' + WARN[k] + '</p>' : ''; }).join('');
      if (!r2.mode) { showWarn('<p><b>Centred.</b></p>', true); return; }
      var how2 = r2.mode === 'two' ? 'two colours (full 360° turns)' : r2.mode === 'same' ? 'two markers of the same colour' : 'one bar';
      showWarn('<p><b>Calibrated:</b> ' + how2 + '.</p>' + ws, !ws);
      refreshPicker();
    }));
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('[data-style]'); if (!b) return;
      cw.setPrefs({ style: b.getAttribute('data-style') });
      Array.prototype.forEach.call(seg.children, function (c) { c.classList.toggle('is-on', c === b); });
      intro();
    });
    go.querySelector('[data-k="go"]').addEventListener('click', startFlow);
    go.querySelector('[data-k="skip"]').addEventListener('click', function () { if (D.flow) setStep(D.flow.step === 'fist' ? 'open' : 'done'); });
    tools.querySelector('[data-k="cal"]').addEventListener('click', function () { calibrate('calibrate'); });
    tools.querySelector('[data-k="ctr"]').addEventListener('click', function () { calibrate('centre'); });
    tools.querySelector('[data-k="mask"]').addEventListener('change', function (e) { D.mask = !!e.target.checked; });
    camRow.querySelector('select').addEventListener('change', function (e) { var id = e.target.value; cw.setPrefs({ deviceId: id }); cw.stop(true); start(id); });
    tune.addEventListener('input', function (e) {
      var k = e.target.getAttribute('data-p'); if (!k) return;
      var v = +e.target.value, o = {}; o[k] = v; cw.setPrefs(o);
      e.target.nextSibling.textContent = k === 'smoothing' || k === 'wheelSize' ? Math.round(v * 100) + '%' : v + '°';
    });
    hseg.addEventListener('click', function (e) {
      var b = e.target.closest('[data-hs]'); if (!b) return;
      var hs = b.getAttribute('data-hs');
      cw.setPrefs({ handStyle: hs });
      renderText();
      var P2 = cw.prefs;
      if (hs === 'top' && !(P2.handCal && P2.handCal.top)) showWarn('Hold one hand at the top of the wheel and press <b>Start</b>.');
      else showWarn('');
    });
    tune.querySelector('[data-k="pip"]').addEventListener('change', function (e) { cw.setPrefs({ pip: !!e.target.checked }); });
    easy.querySelector('input').addEventListener('change', function (e) { cw.setPrefs({ easyAssist: !!e.target.checked }); applyEasy(true); toast(e.target.checked ? 'Easy driving on: Heavy steering assist + automatic gearbox' : 'Easy driving off: your previous assists are back', 'ok'); });
    advB.addEventListener('change', function (e) {
      var k = e.target.getAttribute('data-g');
      if (k) {
        var o = {}; o[k] = !!e.target.checked; cw.setPrefs(o);
        if (k === 'cpu') toast('Takes effect after a page reload');
        return;
      }
      if (e.target.getAttribute('data-k') === 'marker') {
        cw.setPrefs({ method: e.target.checked ? 'marker' : 'hands' });
        renderText(); intro();
        if (cw.running() && cw.ready()) cw.enable();
      }
    });
    function doneClose() {
      if (cw.ready() && cw.running()) { cw.enable(); selectSource(); applyEasy(false); toast(handsMode() ? 'Webcam wheel on: turn your hands like a steering wheel' + (cw.prefs.pedals === 'fist' ? '; fists = go, open hands = brake' : '') : 'Webcam wheel on (marker mode)', 'ok'); }
      close();
    }
    btns.querySelector('[data-k="done"]').addEventListener('click', doneClose);
    btns.querySelector('[data-k="off"]').addEventListener('click', function () { cw.disable(); deselectSource(); close(); toast('Webcam wheel off (camera stopped)'); });
    x.addEventListener('click', close);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    D.key = function (e) {
      var tag = e.target && e.target.tagName;
      if (e.key === 'Escape') { e.preventDefault(); if (cw.countdown()) { cw.cancelCentre(); if (D.flow) setStep(null); } else if (D.flow) { setStep(null); showWarn('Start cancelled.'); } else close(); }
      else if ((e.code === 'Space' || e.key === ' ') && tag !== 'BUTTON' && tag !== 'SELECT' && tag !== 'SUMMARY' && tag !== 'INPUT') { e.preventDefault(); startFlow(); }
      else if ((e.key === 'c' || e.key === 'C') && tag !== 'INPUT') { calibrate('centre'); }
      else if (e.key === 'Tab') trapTab(e, ov);
      e.stopPropagation();
    };
    window.addEventListener('keydown', D.key, true);
    // modal: focus starts on Start (or the first control) and Tab stays inside; close() hands focus back to the opener
    var first = ov.querySelector('[data-k="go"]') || focusables(ov)[0];
    if (first) { try { first.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }

    // live preview: the camera picture (mirrored) + landmarks / virtual wheel (or marker boxes), once per camera frame
    D.offs.push(cw.on('frame', function () {
      if (dlg !== D) return;
      var vid = cw.video;
      if (vid && vid.videoWidth) {
        var vw = vid.videoWidth, vh = vid.videoHeight, W = cv.width, H = Math.round(W * vh / vw);
        if (cv.height !== H) cv.height = H;
        view.style.aspectRatio = vw + '/' + vh;
        drawVideo(g, W, H, vid);
        var cdn = cw.countdown(), showBoxes = !handsMode() && (!cw.prefs.cal || (cdn && cdn.kind === 'calibrate') || cw.prefs.cal.style !== cw.prefs.style);
        drawOverlay(g, W, H, cw, { boxes: showBoxes ? boxesNow() : null, mask: D.mask });
      }
    }));
    function tick() {
      if (dlg !== D) return;
      var st = statusLine(cw);
      status.innerHTML = '<span class="cw-dot ' + st.cls + '"></span><span>' + esc(st.text) + '</span>';
      var M = cw.model();
      if (handsMode() && M.state === 'error' && msg.getAttribute('data-m') !== 'err') { msg.style.display = ''; msg.innerHTML = MODEL_FAIL[M.reason] || MODEL_FAIL.load; msg.setAttribute('data-m', 'err'); if (D.flow) setStep(null); }
      if (handsMode() && M.state === 'ready' && M.delegate === 'CPU' && !D.cpuNote) { D.cpuNote = true; if (!D.flow) showWarn('Hand tracking runs on the CPU here (no usable GPU): expect about 10–20 fps, a little more delay. Closing other heavy tabs helps; marker mode (Advanced) is lighter.'); }
      flowTick();
      // read the hub source like the game does (also measures the delay to "applied")
      var H = CB.input.hub, s = cw.stats();
      if (H && cw.enabled()) { try { H.read(); } catch (e) { /* ignore */ } }
      var bar = meter.querySelector('i'), v = clamp(s.steer || 0, -1, 1);
      bar.style.left = (v < 0 ? 50 + 50 * v : 50) + '%'; bar.style.width = (50 * Math.abs(v)) + '%';
      meter.querySelector('[data-k="ang"]').textContent = s.calibrated && cw.running() && !s.lost ? (s.angle >= 0 ? '+' : '') + Math.round(s.angle) + '°' : '—';
      var pd = s.pedals || { throttle: 0, brake: 0, state: 'off' };
      meter.querySelector('[data-k="gas"]').style.width = Math.round(clamp(pd.throttle, 0, 1) * 100) + '%';
      meter.querySelector('[data-k="brk"]').style.width = Math.round(clamp(pd.brake, 0, 1) * 100) + '%';
      meter.querySelector('[data-k="gasv"]').textContent = pd.state === 'off' ? '—' : Math.round(pd.throttle * 100) + '%';
      meter.querySelector('[data-k="brkv"]').textContent = pd.state === 'off' ? '—' : pd.state === 'lost' && pd.brake ? 'lost' : Math.round(pd.brake * 100) + '%';
      paintChip(meter.querySelector('[data-k="chip"]'), pd, cw.prefs.pedals);
      D.raf = requestAnimationFrame(tick);
    }
    D.raf = requestAnimationFrame(tick);
    intro();
    if (!cw.secure()) { msg.innerHTML = location.protocol === 'file:' ? REASONS.file : REASONS.insecure; }
    else if (!cw.supported()) { msg.innerHTML = REASONS.unsupported; }
    else start();
    D.startFlow = startFlow;
    return ov;
  }

  /* ---------------------------------------------------------------- steering-source picker integration */
  function SRC() { return CB.input.sources; }
  function selectSource() { var S = SRC(); if (S && S.selected && S.selected() !== 'webcam' && S.setPrefs) { S.setPrefs({ source: 'webcam' }); refreshPicker(); } }
  function deselectSource() { var S = SRC(); if (S && S.selected && S.selected() === 'webcam' && S.setPrefs) { S.setPrefs({ source: 'default' }); refreshPicker(); } }
  function refreshPicker() { var S = SRC(); if (S && S.refresh) { try { S.refresh(); } catch (e) { /* ignore */ } } }
  function srcStatus() {
    var cw = CW(); if (!cw) return null;
    if (!cw.running()) return { cls: '', text: 'Camera off. Press Start webcam.' };
    var st = statusLine(cw), s = cw.stats();
    if (st.cls === 'ok') st.text = (s.method === 'hands' ? modeName(s) : 'Markers') + ' · ' + (s.angle >= 0 ? '+' : '') + Math.round(s.angle) + '° · ' + s.fps + ' fps';
    return st;
  }
  function detailHTML() {
    var cw = CW(); if (!cw) return '';
    var on = cw.running() && cw.enabled();
    return '<div class="ss-row"><button class="gh-btn small" type="button" data-cw-act="open">Webcam setup</button>' +
      '<button class="gh-btn small" type="button" data-cw-act="' + (on ? 'stop' : 'start') + '">' + (on ? 'Stop camera' : 'Start webcam') + '</button>' +
      (on ? '<button class="gh-btn small" type="button" data-cw-act="centre">Centre</button>' : '') + '</div>' +
      '<div class="ss-row"><span>Steering style</span><select class="cw-sel" data-cw-style>' + STYLE_OPTS.map(function (o) { return '<option value="' + o[0] + '"' + (hstyle() === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></div>' +
      '<div class="ss-row"><span>Full lock at</span><input type="range" min="20" max="180" step="5" value="' + cw.prefs.maxAngle + '" data-cw-pref="maxAngle"><b>' + cw.prefs.maxAngle + '°</b></div>' +
      '<div class="ss-row"><span>Smoothing</span><input type="range" min="0" max="1" step="0.05" value="' + cw.prefs.smoothing + '" data-cw-pref="smoothing"><b>' + Math.round(cw.prefs.smoothing * 100) + '%</b></div>' +
      '<div class="ss-row"><span>Gas and brake</span><select class="cw-sel" data-cw-ped>' + PEDAL_OPTS.map(function (o) { return '<option value="' + o[0] + '"' + (cw.prefs.pedals === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></div>' +
      '<div class="ss-row"><small>' + (hstyle() === 'top' ? 'Hold one hand at the top of an imaginary wheel and move it along the rim to steer. ' : 'Hold your hands up as if gripping a steering wheel and turn it. ') + esc((PEDAL_OPTS.filter(function (o) { return o[0] === cw.prefs.pedals; })[0] || PEDAL_OPTS[0])[2]) + ' Needs HTTPS. Video never leaves this computer.</small></div>';
  }
  function startQuick() {
    var cw = CW(); if (!cw) return Promise.resolve({ ok: false });
    if (!cw.ready()) { open(); return Promise.resolve({ ok: true }); }
    return cw.start().then(function (r) {
      if (r.ok) { cw.enable(); selectSource(); applyEasy(false); toast('Webcam wheel on: hold your hands up like a steering wheel' + (cw.prefs.pedals === 'fist' ? '; fists = go, open hands = brake' : ''), 'ok'); }
      else open();
      refreshPicker();
      return r;
    });
  }
  function menuItems() {
    var cw = CW(); if (!cw) return [];
    var on = cw.running() && cw.enabled(), items = [{ label: on ? 'Webcam wheel · on' : 'Use webcam as wheel', icon: 'steer', fn: open }];
    if (on) items.push({ label: 'Re-centre webcam wheel (3-2-1)', icon: 'steer', fn: function () { cw.startCentre('centre'); } });
    return items;
  }
  function defineSource() {
    var S = SRC();
    if (!S || !S.define || defineSource.done === S) return;
    defineSource.done = S;
    S.define('webcam', {
      name: 'Webcam air wheel', short: 'Webcam',
      hint: 'Hold your hands up in front of the webcam as if gripping a steering wheel, and turn it. Fists = go, open hands = brake, in between = coast; keep them open at a stop to reverse (other pedal modes in Webcam setup). Keyboard and gamepad pedals still work.',
      available: function () {
        var cw = CW();
        if (!cw) return { ok: false, reason: 'Not loaded' };
        if (!cw.secure()) return { ok: false, reason: location.protocol === 'file:' ? 'Needs the https:// site (not a file)' : 'Needs HTTPS (or localhost)' };
        if (!cw.supported()) return { ok: false, reason: 'No camera API in this browser' };
        return { ok: true };
      },
      enable: function () { return CW().running() ? (CW().enable(), { ok: true }) : (open(), { ok: true }); },
      disable: function () { var cw = CW(); if (cw) cw.disable(); },
      isOn: function () { var cw = CW(); return !!(cw && cw.running()); },
      detailHTML: detailHTML,
      menuItems: menuItems,
      status: srcStatus
    });
  }
  /* fallback when the shared picker is not loaded: add our entries to CB.input.ui's pause menu / setup row / Settings */
  function patchUi() {
    var u = CB.input.ui;
    if (!u || u._cwPatched || SRC()) return;
    u._cwPatched = true;
    var mi = u.menuItems, sr = u.setupRow, sh = u.settingsHTML;
    if (typeof mi === 'function') u.menuItems = function () { return (mi.apply(u, arguments) || []).concat(menuItems()); };
    if (typeof sr === 'function') u.setupRow = function () {
      var box = sr.apply(u, arguments);
      try {
        ensureCss();
        var b = el('button', 'pw-btn', ICON.cam + '<span>Use webcam as wheel</span>'); b.type = 'button';
        b.addEventListener('click', open);
        var row = box && box.querySelector('.pw-row'); if (row) row.appendChild(b);
      } catch (e) { /* ignore */ }
      return box;
    };
    if (typeof sh === 'function') u.settingsHTML = function () {
      return (sh.apply(u, arguments) || '') + '<h2 class="gh-h2">Webcam air wheel</h2><div class="gh-row"><div class="lbl"><b>Use webcam as wheel</b><small>Hold your hands up like a steering wheel in front of the webcam (needs HTTPS; video stays on this computer)</small></div><button class="gh-btn" type="button" data-cw-act="open">' + ICON.cam + ' Set up webcam</button></div>';
    };
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('[data-cw-act]');
    if (!a) return;
    e.preventDefault();
    var act = a.getAttribute('data-cw-act'), cw = CW();
    if (!cw) return;
    if (act === 'open') open();
    else if (act === 'start') startQuick();
    else if (act === 'stop') { cw.disable(); refreshPicker(); }
    else if (act === 'centre') cw.startCentre('centre');
  });
  document.addEventListener('change', function (e) {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-cw-style') && CW()) { CW().setPrefs({ handStyle: e.target.value }); refreshPicker(); return; }
    if (!e.target || !e.target.hasAttribute || !e.target.hasAttribute('data-cw-ped') || !CW()) return;
    CW().setPrefs({ pedals: e.target.value }); refreshPicker();
  });
  document.addEventListener('input', function (e) {
    var k = e.target && e.target.getAttribute && e.target.getAttribute('data-cw-pref');
    if (!k || !CW()) return;
    var v = +e.target.value, o = {}; o[k] = v; CW().setPrefs(o);
    var b = e.target.nextSibling; if (b) b.textContent = k === 'smoothing' ? Math.round(v * 100) + '%' : v + '°';
  });

  /* ---------------------------------------------------------------- picture-in-picture while driving */
  var pip = null, driving = false, lostSince = 0, lostToast = false;
  function pipWanted() { var cw = CW(); return !!(cw && driving && cw.enabled() && cw.running() && cw.prefs.pip && !dlg); }
  function pipSync() {
    if (!pipWanted()) { if (pip) pip.style.display = 'none'; return; }
    ensureCss();
    if (!pip) {
      pip = el('div', 'cw-pip', '<canvas width="192" height="144"></canvas><div class="cw-pl"><span data-k="t">WEBCAM</span><button type="button" class="cw-chip" data-k="ctr" title="Re-centre the webcam wheel (3-2-1, hold your hands level)">CENTRE</button><button type="button" data-k="x" title="Hide the camera preview (webcam setup turns it back on)" aria-label="Hide camera preview">×</button></div>');
      pip.querySelector('[data-k="ctr"]').addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); CW().startCentre('centre'); });
      pip.querySelector('[data-k="x"]').addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); CW().setPrefs({ pip: false }); pipSync(); toast('Camera preview hidden (turn it back on in the webcam setup)'); });
      document.body.appendChild(pip);
      pip._g = pip.querySelector('canvas').getContext('2d');
    }
    pip.style.display = '';
  }
  function pipFrame(f) {
    if (!pip || pip.style.display === 'none') return;
    var c = pip._g.canvas, cw = CW(), vid = cw.video;
    if (!vid || !vid.videoWidth) return;
    var W = 192, H = Math.round(W * vid.videoHeight / vid.videoWidth);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; c.style.aspectRatio = W + '/' + H; }
    drawVideo(pip._g, W, H, vid);
    drawOverlay(pip._g, W, H, cw, { small: true });
    var r = cw._b.steer ? cw._b.steer.read(performance.now()) : { lost: true };
    pip.classList.toggle('lost', !!r.lost);
    var t = pip.querySelector('[data-k="t"]'), txt = r.lost ? (cw.prefs.method === 'marker' ? 'LOST · SHOW MARKERS' : 'LOST · SHOW HANDS') : 'CAM ' + (cw._b.steer.angle >= 0 ? '+' : '') + Math.round(cw._b.steer.angle) + '°';
    if (t.textContent !== txt) t.textContent = txt;
  }
  function onFrame(f) {
    var cw = CW();
    if (pip && pip.style.display !== 'none') pipFrame(f);
    // lost while driving for > 1 s: one toast per episode
    if (driving && cw.enabled()) {
      var lost = cw._b.steer && cw._b.steer.read(performance.now()).lost;
      if (lost) { if (!lostSince) lostSince = performance.now(); if (!lostToast && performance.now() - lostSince > 1000) { lostToast = true; toast(cw.prefs.method === 'marker' ? 'Webcam wheel lost your markers: steering centred.' : 'Webcam wheel cannot see your hands: steering centred. Hold them up in view of the camera.', 'bad'); } }
      else { if (lostToast) toast('Webcam wheel tracking again', 'ok'); lostSince = 0; lostToast = false; }
    }
  }
  /* ---- the countdown while driving (the dialog shows its own): big 3-2-1 + "Hold your hands level" */
  var cdEl = null;
  function onCountdown(e) {
    var cw = CW();
    if (dlg || !e) { if (cdEl) cdEl.style.display = 'none'; return; }
    if (e.state === 'count') {
      ensureCss();
      if (!cdEl) { cdEl = el('div', 'cw-cd'); cdEl.setAttribute('aria-live', 'polite'); document.body.appendChild(cdEl); }
      var what = e.phase === 'grip' ? (hstyle() === 'top' ? 'Now close your hand: a firm grip' : 'Now close your hands: a firm grip') : cw.prefs.method === 'marker' ? 'Hold the markers level' : holdText('centre');
      cdEl.innerHTML = '<b>' + e.left + '</b><span>' + esc(what) + '</span><small>Press again or Esc to cancel</small>';
      cdEl.style.display = '';
      return;
    }
    if (cdEl) cdEl.style.display = 'none';
    if (e.state === 'done') toast(e.kind === 'auto' ? 'Webcam wheel centred automatically' : 'Webcam wheel centred', 'ok');
    else if (e.state === 'fail') toast(e.result && e.result.reason === 'nohands' ? 'Not centred: no hands in view. The previous centre is kept.' : 'Not centred: the previous centre is kept.', 'bad');
    else if (e.state === 'cancel') toast('Re-centre cancelled');
  }
  // Esc cancels a running countdown (before the pause menu sees it)
  window.addEventListener('keydown', function (e) {
    var cw = CW();
    if (dlg || !cw || e.key !== 'Escape' || !cw.countdown || !cw.countdown()) return;
    e.preventDefault(); e.stopPropagation(); cw.cancelCentre();
  }, true);
  /* ---- the driving HUD: a big GO / COAST / BRAKE / R chip (+ the hand state) while the webcam drives the pedals */
  var hud = null, hudRaf = 0;
  function hudWanted() { var cw = CW(); return !!(cw && driving && cw.enabled() && cw.running() && cw.prefs.method !== 'marker' && cw.prefs.pedals !== 'off' && !dlg); }
  function hudSync() {
    if (!hudWanted()) { if (hud) hud.style.display = 'none'; if (hudRaf) { cancelAnimationFrame(hudRaf); hudRaf = 0; } return; }
    ensureCss();
    if (!hud) { hud = el('div', 'cw-hud'); hud.setAttribute('aria-live', 'polite'); hud.setAttribute('data-cw-hud', ''); document.body.appendChild(hud); }
    hud.style.display = '';
    if (!hudRaf) hudRaf = requestAnimationFrame(hudTick);
  }
  function hudTick() {
    hudRaf = 0;
    if (!hudWanted()) { hudSync(); return; }
    var cw = CW(), pd = cw.stats().pedals, L = pedalLabel(pd), hand = pd && pd.hand, mode = cw.prefs.pedals;
    var key = L.k + '|' + L.t + '|' + hand + '|' + mode;
    if (hud._k !== key) {
      hud._k = key; hud.className = 'cw-hud is-' + L.k; hud.setAttribute('data-state', L.k);
      hud.innerHTML = '<b class="is-' + L.k + '">' + L.t + '</b>' + (hand && HAND_SVG[hand] ? '<span class="cw-hand">' + HAND_SVG[hand] + '</span>' : '') +
        '<small>' + (L.k === 'rev' ? 'fists = forward' : L.k === 'lost' ? 'show your hands' : mode === 'auto' ? 'open = brake' : mode === 'fist' ? 'fist = go<br>open = brake' : '') + '</small>';
    }
    hudRaf = requestAnimationFrame(hudTick);
  }
  /* ---- first drive with the webcam: a 3-step intro ("1 Hold hands like a wheel · 2 Make fists to go · 3 Open hands to
     brake"), twice at most, ~8 s or until clicked / a key; other pedal modes: the one-line tip */
  var HINT_KEY = 'forge.camWheel.hint.v1', INTRO_KEY = 'forge.camWheel.intro.v2', tipEl = null, tipT = 0, introEl = null;
  function pedalTip() {
    var p = CW().prefs.pedals;
    return p === 'auto' ? 'The car accelerates on its own: open your hands to brake' :
      p === 'push' ? 'Push your hands towards the screen for gas, pull them back to brake' :
        p === 'grip' ? 'Close your hands to drive, relax to coast, pull back to brake' : 'Fists = go, open hands = brake';
  }
  function showIntro(force) {
    var cw = CW();
    if (!cw) return false;
    var n = 0; try { n = +(localStorage.getItem(INTRO_KEY) || 0) || 0; } catch (e) { n = 0; }
    if (n >= 2 && !force) return false;
    try { localStorage.setItem(INTRO_KEY, String(n + 1)); } catch (e) { /* ignore */ }
    ensureCss();
    if (!introEl) {
      introEl = el('div', 'cw-intro'); introEl.setAttribute('role', 'note'); introEl.setAttribute('data-cw-intro', '');
      introEl.addEventListener('click', hideIntro);
      document.body.appendChild(introEl);
    }
    var one = hstyle() === 'top';
    introEl.innerHTML = '<h3>Drive with your hands</h3><ol>' +
      '<li><b>1</b><span>' + (one ? 'Hold one hand at the top of a wheel' : 'Hold hands like a wheel') + '</span></li>' +
      '<li><b>2</b><span>' + (cw.prefs.pedals === 'auto' ? 'The car drives itself' : one ? 'Make a fist to go' : 'Make fists to go') + '</span>' + HAND_SVG.closed + '</li>' +
      '<li><b>3</b><span>' + (one ? 'Open your hand to brake' : 'Open hands to brake') + '</span>' + HAND_SVG.open + '</li></ol>' +
      '<small>Keep them open at a stop to reverse. Click or press any key to hide.</small>';
    introEl.style.display = '';
    clearTimeout(showIntro.t); showIntro.t = setTimeout(hideIntro, 8000);
    window.addEventListener('keydown', hideIntro, true);
    return true;
  }
  function hideIntro() { if (introEl) introEl.style.display = 'none'; window.removeEventListener('keydown', hideIntro, true); }
  function maybeHint() {
    var cw = CW();
    if (!cw || !driving || !cw.enabled() || cw.prefs.method === 'marker' || cw.prefs.pedals === 'off') return;
    if (cw.prefs.pedals === 'fist' || cw.prefs.pedals === 'auto') { showIntro(maybeHint.force); return; }
    var n = 0; try { n = +(localStorage.getItem(HINT_KEY) || 0) || 0; } catch (e) { n = 0; }
    var key = cw.prefs.pedals;
    var seen = {}; try { seen = JSON.parse(localStorage.getItem(HINT_KEY + '.modes') || '{}') || {}; } catch (e) { seen = {}; }
    if (seen[key] >= 2 && !maybeHint.force) return;
    seen[key] = (seen[key] || 0) + 1; try { localStorage.setItem(HINT_KEY + '.modes', JSON.stringify(seen)); localStorage.setItem(HINT_KEY, String(n + 1)); } catch (e) { /* ignore */ }
    ensureCss();
    if (!tipEl) { tipEl = el('div', 'cw-tipx'); document.body.appendChild(tipEl); }
    tipEl.textContent = pedalTip(); tipEl.style.display = '';
    clearTimeout(tipT); tipT = setTimeout(function () { if (tipEl) tipEl.style.display = 'none'; }, 10000);
  }
  document.addEventListener('cb:driving', function (e) {
    var was = driving;
    driving = !!(e && e.detail && e.detail.driving); lostSince = 0; lostToast = false; pipSync(); hudSync();
    if (driving && !was) { clearTimeout(maybeHint.t); maybeHint.t = setTimeout(maybeHint, 1500); }   // after the loading screen
    if (!driving) { clearTimeout(maybeHint.t); if (tipEl) tipEl.style.display = 'none'; hideIntro(); }
  });

  function boot(late) {
    var cw = CW(); if (!cw) return;
    if (!boot.done) { boot.done = true; cw.on('frame', onFrame); cw.on('prefs', function () { pipSync(); hudSync(); }); cw.on('state', function () { pipSync(); hudSync(); }); cw.on('countdown', onCountdown); }
    defineSource();
    if (CB.input.ui && !CB.input.ui.openCamWheel) CB.input.ui.openCamWheel = open;
    if (late) patchUi();                 // only once every script has loaded: the shared picker may come after us
  }
  boot(document.readyState !== 'loading');
  document.addEventListener('DOMContentLoaded', function () { boot(true); });
  window.addEventListener('load', function () { boot(true); });

  CB.input.camUI = { open: open, close: close, menuItems: menuItems, detailHTML: detailHTML, start: startQuick, _drawOverlay: drawOverlay, isOpen: function () { return !!dlg; },
    startFlow: function () { if (!dlg) open(); if (dlg && dlg.startFlow) dlg.startFlow(); }, flow: function () { return dlg && dlg.flow ? dlg.flow.step : dlg && dlg.flowDone ? 'done' : null; },
    showIntro: showIntro, applyEasy: applyEasy, hudSync: hudSync, pedalLabel: pedalLabel };
})();
