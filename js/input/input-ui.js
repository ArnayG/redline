/* ==========================================================================
   FORGE — js/input/input-ui.js
   CB.input.ui : the browser UI for phone steering (everything optional; race-ui / hub feature-detect it).
     ui.openPairing(opts?)   desktop "Use phone as wheel" screen: QR code + 5-letter code + link, connection method
                             (Online / Same device / Invite code), live status, latency, input rate and a live wheel meter
     ui.closePairing()
     ui.menuItems()          pause-menu entries for race-ui ([{label, icon, fn}])
     ui.setupRow()           race / drift setup "Controls & input" row (Element)
     ui.settingsHTML()       Settings → Driving rows (HTML; clicks are delegated on [data-pw-act]); the shared "Steering
                             source" picker (CB.input.sources, js/input/sources.js) is rendered first, and also heads
                             setupRow() and adds the picked source's entries to menuItems()
     ui.mountTouch(layer, R, refresh)   tilt-steering touch layout while driving on a phone: gas (right), brake (left),
                             handbrake, re-centre, gears (pause = race-ui's own pause button); plus the "Enable tilt steering" button on touch devices
     ui.enableTilt() -> Promise   (call from a user gesture)   ui.toast(text, kind?)
   A status chip (bottom centre) shows the paired phone, its latency and connection state on every screen.
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.input = CB.input || {};

(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof window === 'undefined') { CB.input.ui = CB.input.ui || {}; return; }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function el(tag, cls, html) { var n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  function W() { return CB.input.wheel; }
  function H() { return CB.input.hub; }
  function TL() { return CB.input.tilt; }
  function O() { return CB.input.orient; }
  /** pointer position inside el in its own (unrotated) frame: correct while CB.input.orient counter-rotates #race-root */
  function pt(node, e) { var o = O(); if (o && o.point) return o.point(node, e); var r = node.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; }
  function coarse() { try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; } }
  function canTilt() { var t = TL(); return !!(t && t.sensor && t.sensor.available()) && coarse(); }

  var ICON = {
    phone: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/></svg>',
    wheel: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M3.5 10.5h6.5M14 10.5h6.5M12 14v7"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  /* ---------------------------------------------------------------- CSS */
  var CSS = [
    '.pw-overlay{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:16px;background:rgba(5,5,7,.78);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font-family:var(--font,system-ui,sans-serif);color:var(--text,#ecebe6)}',
    '.pw-card{width:min(860px,100%);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow:auto;overscroll-behavior:contain;background:var(--panel,#141519);border:1px solid var(--line,#2b2c33);border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.6);display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr)}',
    '.pw-left{padding:24px;border-right:1px solid var(--line,#2b2c33);display:flex;flex-direction:column;align-items:center;gap:14px;background:rgba(0,0,0,.18)}',
    '.pw-right{padding:24px;display:flex;flex-direction:column;gap:16px;min-width:0}',
    '.pw-qr{width:100%;max-width:252px;aspect-ratio:1;border-radius:12px;overflow:hidden;background:#fff;display:grid;place-items:center;color:#111;font-size:12px;text-align:center}',
    '.pw-qr svg{display:block;width:100%;height:100%}',
    '.pw-code{font:700 34px/1 var(--mono,ui-monospace,monospace);letter-spacing:.28em;padding-left:.28em;color:var(--accent-hi,#e7cd9a)}',
    '.pw-url{font:12px var(--mono,ui-monospace,monospace);color:var(--text-dim,#9b9890);word-break:break-all;text-align:center}',
    '.pw-eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent,#c9a56b);font-weight:700}',
    '.pw-h{margin:2px 0 0;font-size:24px;line-height:1.15;font-weight:700}',
    '.pw-dim{color:var(--text-dim,#9b9890);font-size:13px;line-height:1.5}',
    '.pw-steps{margin:0;padding-left:20px;display:grid;gap:6px;font-size:13.5px;line-height:1.45}',
    '.pw-seg{display:inline-flex;border:1px solid var(--line,#2b2c33);border-radius:10px;overflow:hidden;flex-wrap:wrap}',
    '.pw-seg button{appearance:none;border:0;background:transparent;color:var(--text-dim,#9b9890);padding:8px 12px;font:600 12.5px var(--font,system-ui);cursor:pointer}',
    '.pw-seg button.is-on{background:var(--accent-softer,rgba(201,165,107,.14));color:var(--text-strong,#fff)}',
    '.pw-status{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;border:1px solid var(--line,#2b2c33);background:rgba(255,255,255,.025);font-size:13.5px;font-variant-numeric:tabular-nums}',
    '.pw-dot{width:10px;height:10px;border-radius:50%;background:var(--warn,#e3a33a);box-shadow:0 0 0 4px rgba(227,163,58,.15);flex:none}',
    '.pw-dot.ok{background:var(--good,#3fbf7f);box-shadow:0 0 0 4px rgba(63,191,127,.15)}',
    '.pw-dot.bad{background:var(--bad,#e5484d);box-shadow:0 0 0 4px rgba(229,72,77,.15)}',
    '.pw-meter{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;font-size:11px;color:var(--text-dim,#9b9890);letter-spacing:.08em;text-transform:uppercase}',
    '.pw-bar{position:relative;height:8px;border-radius:4px;background:rgba(255,255,255,.07);overflow:hidden}',
    '.pw-bar i{position:absolute;top:0;bottom:0;left:0;width:0;background:var(--accent,#c9a56b);border-radius:4px}',
    '.pw-bar.steer i{left:50%;width:3px;margin-left:-1.5px;background:var(--text-strong,#fff)}',
    '.pw-bar.steer::before{content:"";position:absolute;left:50%;top:0;bottom:0;width:1px;background:rgba(255,255,255,.25)}',
    '.pw-bar.gas i{background:var(--good,#3fbf7f)} .pw-bar.brk i{background:var(--bad,#e5484d)}',
    '.pw-warn{padding:10px 12px;border-radius:10px;border:1px solid rgba(227,163,58,.35);background:rgba(227,163,58,.08);font-size:12.5px;line-height:1.45;color:var(--text,#ecebe6)}',
    '.pw-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
    '.pw-btn{appearance:none;display:inline-flex;align-items:center;gap:8px;min-height:38px;padding:0 14px;border-radius:10px;border:1px solid var(--line,#2b2c33);background:var(--panel-2,#1b1c21);color:var(--text,#ecebe6);font:600 13px var(--font,system-ui);cursor:pointer}',
    '.pw-btn:hover{border-color:var(--accent,#c9a56b)} .pw-btn.primary{background:var(--accent,#c9a56b);color:var(--accent-ink,#17130b);border-color:transparent}',
    '.pw-btn.ghost{background:transparent}',
    '.pw-x{position:absolute;top:12px;right:12px}',
    '.pw-ta{width:100%;min-height:62px;resize:vertical;border-radius:10px;border:1px solid var(--line,#2b2c33);background:var(--bg-2,#111114);color:var(--text,#ecebe6);font:12px var(--mono,ui-monospace,monospace);padding:8px}',
    '@media (max-width:720px){.pw-card{grid-template-columns:1fr}.pw-left{border-right:0;border-bottom:1px solid var(--line,#2b2c33)}}',
    /* status chip + toast */
    '.pw-chip{position:fixed;left:50%;transform:translateX(-50%);bottom:12px;z-index:2147482000;display:flex;align-items:center;gap:8px;padding:6px 12px 6px 10px;border-radius:999px;background:rgba(8,9,11,.78);border:1px solid var(--line-2,#3a3b44);color:var(--text,#ecebe6);font:600 11.5px var(--font,system-ui);font-variant-numeric:tabular-nums;cursor:pointer;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}',
    '.pw-chip .pw-dot{width:8px;height:8px;box-shadow:none}',
    '.pw-toast{position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:2147483001;padding:10px 16px;border-radius:10px;background:rgba(8,9,11,.92);border:1px solid var(--line-2,#3a3b44);color:var(--text,#ecebe6);font:600 13px var(--font,system-ui);max-width:min(92vw,560px);text-align:center;pointer-events:none;transition:opacity .4s}',
    '.pw-toast.bad{border-color:var(--bad,#e5484d)} .pw-toast.ok{border-color:var(--good,#3fbf7f)}',
    /* setup row */
    '.pw-setup{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;border:1px solid var(--line,#2b2c33);background:rgba(255,255,255,.02)}',
    '.pw-setup b{font-size:13px} .pw-setup small{color:var(--text-dim,#9b9890);font-size:12px;line-height:1.4}',
    '.pw-range{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--text-dim,#9b9890)} .pw-range input{flex:1}',
    /* tilt touch layout (driving on the phone itself) */
    '#race-root .pw-tpad{position:absolute;inset:0;pointer-events:none;z-index:3;font-family:var(--font,system-ui)}',
    '#race-root .pw-tpad>*{pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}',
    '#race-root .pw-zone{position:absolute;bottom:0;top:46%;width:26%;display:flex;align-items:flex-end;justify-content:center;padding-bottom:max(18px,env(safe-area-inset-bottom));font-size:11px;font-weight:800;letter-spacing:.16em;color:rgba(255,255,255,.55);background:linear-gradient(0deg,rgba(0,0,0,.32),transparent)}',
    '#race-root .pw-zone.brake{left:0;padding-left:env(safe-area-inset-left)} #race-root .pw-zone.gas{right:0;padding-right:env(safe-area-inset-right)}',
    '#race-root .pw-zone .pw-fill{position:absolute;left:0;right:0;bottom:0;height:0;opacity:.35;transition:height .05s}',
    '#race-root .pw-zone.gas .pw-fill{background:linear-gradient(0deg,var(--good,#3fbf7f),transparent)} #race-root .pw-zone.brake .pw-fill{background:linear-gradient(0deg,var(--bad,#e5484d),transparent)}',
    '#race-root .pw-zone span{position:relative}',
    '#race-root .pw-tb{position:absolute;min-width:52px;height:44px;padding:0 10px;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.42);color:rgba(255,255,255,.85);font:800 11px var(--font,system-ui);letter-spacing:.08em;display:grid;place-items:center}',
    '#race-root .pw-tb.is-down,#race-root .pw-zone.is-down{border-color:var(--accent,#c9a56b);color:#fff}',
    '#race-root .pw-tb.hb{left:calc(26% + 10px);bottom:max(18px,env(safe-area-inset-bottom));height:64px;min-width:64px}',
    '#race-root .pw-tb.cal{right:calc(26% + 10px);bottom:max(18px,env(safe-area-inset-bottom));height:40px;font-size:10px}',
    '#race-root .pw-tb.up{right:calc(26% + 10px);bottom:calc(max(18px,env(safe-area-inset-bottom)) + 104px)} #race-root .pw-tb.dn{right:calc(26% + 10px);bottom:calc(max(18px,env(safe-area-inset-bottom)) + 54px)}',
    '#race-root .pw-steerind{position:absolute;left:50%;bottom:max(14px,env(safe-area-inset-bottom));width:120px;height:6px;margin-left:-60px;border-radius:3px;background:rgba(255,255,255,.12);pointer-events:none}',
    '#race-root .pw-steerind i{position:absolute;top:-3px;left:50%;width:4px;height:12px;margin-left:-2px;border-radius:2px;background:#fff}',
    '#race-root .pw-enable{position:absolute;left:50%;top:max(52px,calc(env(safe-area-inset-top) + 44px));transform:translateX(-50%);z-index:4;padding:9px 16px;border-radius:999px;border:1px solid var(--accent,#c9a56b);background:rgba(8,9,11,.82);color:var(--text-strong,#fff);font:700 12.5px var(--font,system-ui);display:flex;align-items:center;gap:8px;pointer-events:auto}',
    '#race-root .pw-rotate{position:absolute;inset:0;z-index:6;display:none;place-items:center;text-align:center;padding:24px;background:rgba(5,5,7,.88);color:#fff;font:700 16px var(--font,system-ui);pointer-events:auto}',
    '@media (orientation:portrait){html.pw-tilt-on #race-root .pw-rotate{display:grid}}',
    /* phone-friendly driving: no scroll / zoom / overscroll / selection */
    'html.pw-touch-driving,html.pw-touch-driving body{overflow:hidden;overscroll-behavior:none;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-text-size-adjust:100%}',
    'html.pw-touch-driving #race-root{touch-action:none}',
    /* touch screens: 40px+ tap targets, safe areas (desktop unchanged) */
    '@media (pointer:coarse){',
    '.pw-overlay{padding:max(12px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left))}',
    '.pw-card{max-height:calc(100vh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom));max-height:calc(100dvh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom))}',
    '.pw-btn{min-height:44px}.pw-seg button{min-height:44px;padding:8px 14px}.pw-range input{min-height:40px}',
    '.pw-x{width:44px;justify-content:center;padding:0}',
    '.pw-chip{min-height:40px;bottom:max(12px,env(safe-area-inset-bottom))}',
    '#race-root .pw-enable{min-height:44px;animation:pw-en-fade .5s ease 12s forwards}',
    '@keyframes pw-en-fade{to{opacity:0;visibility:hidden}}',
    '#race-root .pw-tb.cal{height:44px}',
    '#race-root .pw-tb.hb{left:calc(26% + 10px + env(safe-area-inset-left))} #race-root .pw-tb.cal,#race-root .pw-tb.up,#race-root .pw-tb.dn{right:calc(26% + 10px + env(safe-area-inset-right))}',
    '#race-root .pw-zone{width:calc(26% + env(safe-area-inset-left))} #race-root .pw-zone.gas{width:calc(26% + env(safe-area-inset-right))}}',
    '@media (pointer:coarse) and (max-width:720px){.pw-left,.pw-right{padding:18px}.pw-qr{max-width:200px}}'
  ].join('\n');
  // driving-layer safe areas through CSS variables: CB.input.orient re-maps them when it counter-rotates #race-root
  CSS = CSS.split('\n').map(function (l) { return l.indexOf('#race-root') >= 0 ? l.replace(/env\(safe-area-inset-(top|right|bottom|left)\)/g, 'var(--pw-sa-$1,env(safe-area-inset-$1))') : l; }).join('\n');
  function ensureCss() {
    if (document.getElementById('pw-css')) return;
    var s = document.createElement('style'); s.id = 'pw-css'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ---------------------------------------------------------------- toast */
  var toastEl = null, toastTimer = null;
  function toast(text, kind) {
    ensureCss();
    if (!document.body) return;
    if (!toastEl) { toastEl = el('div', 'pw-toast'); toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.className = 'pw-toast' + (kind ? ' ' + kind : '');
    toastEl.textContent = text; toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (toastEl) toastEl.style.opacity = '0'; }, 3200);
  }

  /* ---------------------------------------------------------------- pairing modal */
  var modal = null, modalRaf = 0, chip = null, chipTimer = 0;
  var VIA = [{ id: 'online', name: 'Online' }, { id: 'local', name: 'Same device (test)' }, { id: 'manual', name: 'Invite code' }];
  function originWarning(via) {
    var L = window.location, host = L.hostname;
    if (via === 'local') return 'Same device: open the link in another tab of this browser (for testing). For a real phone use Online.';
    if (L.protocol === 'file:') return 'Opened from a file: a phone cannot open this page. Use the deployed site (Vercel) or <code>node tools/dev-server.js</code> + an HTTPS tunnel.';
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return 'This page runs on <b>localhost</b>, which your phone cannot reach. Use the deployed HTTPS site, or an HTTPS tunnel (see README → Phone steering wheel).';
    if (L.protocol !== 'https:') return 'Phones only allow tilt sensors on <b>HTTPS</b> pages. On plain http the phone can still pair but must steer by dragging the wheel. Use the Vercel site or an HTTPS tunnel.';
    return '';
  }
  function statusText(S) {
    if (!S) return { cls: 'bad', text: 'Not paired' };
    var rx = S.rx, t = performance.now();
    if (S.error === 'signal-closed' && rx.state !== 'connected') return { cls: 'bad', text: 'Pairing room closed. Start again.' };
    var md = rx.mode ? rx.mode() : null, how = md === 'relay' ? ' (via server)' : md === 'turn' ? ' (via TURN)' : md ? ' (direct)' : '';
    var delay = rx.delayText ? rx.delayText() : (rx.rtt() != null ? rx.rtt() + ' ms' : '— ms');
    if (rx.state === 'connected' && rx.isFresh(t)) return { cls: 'ok', text: 'Connected' + how + (rx.phone && rx.phone.name ? ' · ' + rx.phone.name : '') + ' · ' + delay + ' · ' + (rx.rate || 0) + ' Hz' };
    if (rx.state === 'connected' || rx.state === 'stale') return { cls: 'bad', text: 'Phone signal lost: steering centred, throttle lifted. Reconnecting…' };
    return { cls: '', text: 'Waiting for your phone…' };
  }
  function closePairing() {
    if (modalRaf) cancelAnimationFrame(modalRaf); modalRaf = 0;
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    if (modal && modal._key) window.removeEventListener('keydown', modal._key, true);
    modal = null;
  }
  function openPairing(opts) {
    opts = opts || {};
    ensureCss();
    closePairing();
    var ov = el('div', 'pw-overlay'); ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Use phone as wheel');
    var card = el('div', 'pw-card'); card.style.position = 'relative';
    var left = el('div', 'pw-left'), right = el('div', 'pw-right');
    var qr = el('div', 'pw-qr', '<span>Creating a pairing code…</span>'), code = el('div', 'pw-code', '·····'), url = el('div', 'pw-url', '');
    var copy = el('button', 'pw-btn ghost', 'Copy link'); copy.type = 'button';
    left.appendChild(qr); left.appendChild(code); left.appendChild(url); left.appendChild(copy);
    var x = el('button', 'pw-btn ghost pw-x', ICON.close); x.type = 'button'; x.setAttribute('aria-label', 'Close');
    right.innerHTML = '<div><div class="pw-eyebrow">Phone as wheel</div><h2 class="pw-h">Steer with your phone</h2></div>' +
      '<ol class="pw-steps"><li>Scan the QR code with your phone camera, or open the link / type the code at <b>#/wheel/CODE</b>.</li>' +
      '<li>Tap <b>Start</b> on the phone and allow motion access. Hold it in landscape like a steering wheel.</li>' +
      '<li>Gas is on the right of the screen, brake on the left. Tilt to steer. <b>Centre</b> resets straight-ahead.</li></ol>';
    var seg = el('div', 'pw-seg');
    var warn = el('div', 'pw-warn'); warn.style.display = 'none';
    var status = el('div', 'pw-status', '<span class="pw-dot"></span><span>Starting…</span>');
    var meter = el('div', 'pw-meter', '<span>Steer</span><div class="pw-bar steer"><i></i></div><span>Gas</span><div class="pw-bar gas"><i></i></div><span>Brake</span><div class="pw-bar brk"><i></i></div>');
    var manual = el('div', 'pw-setup'); manual.style.display = 'none';
    manual.innerHTML = '<b>Invite code (no server)</b><small>1. The phone opens the link above (or paste this invite on the phone\'s wheel page). 2. Paste the phone\'s answer code here.</small>' +
      '<textarea class="pw-ta" data-k="inv" readonly></textarea><textarea class="pw-ta" data-k="ans" placeholder="Paste the answer code from your phone"></textarea>' +
      '<div class="pw-row"><button class="pw-btn primary" type="button" data-k="acc">Connect</button><button class="pw-btn ghost" type="button" data-k="new">New invite</button></div>';
    var btns = el('div', 'pw-row');
    var done = el('button', 'pw-btn primary', 'Done'); done.type = 'button';
    var stop = el('button', 'pw-btn ghost', 'Disconnect phone'); stop.type = 'button';
    btns.appendChild(done); btns.appendChild(stop);
    right.appendChild(el('div', 'pw-dim', 'Connection')); right.appendChild(seg); right.appendChild(warn);
    right.appendChild(status); right.appendChild(meter); right.appendChild(manual); right.appendChild(btns);
    card.appendChild(left); card.appendChild(right); card.appendChild(x); ov.appendChild(card);
    document.body.appendChild(ov);
    modal = ov;
    var cur = null, viaNow = opts.via || 'auto';
    function renderSeg(active) {
      seg.innerHTML = '';
      VIA.forEach(function (v) {
        var b = el('button', v.id === active ? 'is-on' : '', esc(v.name)); b.type = 'button';
        b.addEventListener('click', function () { start(v.id); });
        seg.appendChild(b);
      });
    }
    function showSession(S) {
      cur = S;
      renderSeg(S.via);
      code.textContent = S.via === 'manual' ? 'INVITE' : S.code;
      url.textContent = S.url;
      var q = CB.input.qr, txt = S.url;
      try { qr.innerHTML = q ? q.toSvg(txt, { quiet: 3 }) : '<span>QR unavailable</span>'; }
      catch (e) { qr.innerHTML = '<span style="padding:16px">This invite is too long for a QR code. Copy the link to your phone (chat / AirDrop) or paste the invite on its wheel page.</span>'; }
      var w = originWarning(S.via);
      warn.style.display = w ? '' : 'none'; warn.innerHTML = w;
      manual.style.display = S.via === 'manual' ? '' : 'none';
      if (S.via === 'manual') manual.querySelector('[data-k="inv"]').value = S.invite || '';
      ensureChip();
    }
    function start(via) {
      viaNow = via;
      qr.innerHTML = '<span>Creating a pairing code…</span>'; code.textContent = '·····'; url.textContent = '';
      status.innerHTML = '<span class="pw-dot"></span><span>Starting…</span>';
      W().pair({ via: via }).then(function (S) { if (modal === ov) showSession(S); }, function (e) {
        var msg = e && e.code === 'no-backend' ? 'The online pairing service is not set up on this site (no /api/signal). Use Same device or Invite code, or see README.' :
          e && e.code === 'blocked' ? 'The web host\'s security blocked the pairing server (HTTP ' + (e.status || 403) + '). Open api/signal.php in a browser and see Troubleshoot in DEPLOY-CPANEL.txt (ModSecurity / firewall allow-list).' :
          e && e.code === 'unreachable' ? 'Cannot reach the pairing server (api/signal.php). Check the internet connection and try again.' :
          'Could not start pairing: ' + esc(e && e.message || e);
        status.innerHTML = '<span class="pw-dot bad"></span><span>' + msg + '</span>';
        renderSeg(via);
      });
    }
    function tick() {
      if (modal !== ov) return;
      var S = W().session();
      if (S && S !== cur) showSession(S);
      var st = statusText(S);
      status.innerHTML = '<span class="pw-dot ' + st.cls + '"></span><span>' + esc(st.text) + '</span>';
      var rx = S && S.rx, i = rx && rx.lastIn, fresh = rx && rx.isFresh(performance.now());
      var bars = meter.querySelectorAll('i');
      bars[0].style.left = (50 + 50 * (fresh && i ? i.steer : 0)) + '%';
      bars[1].style.width = ((fresh && i ? i.throttle : 0) * 100) + '%';
      bars[2].style.width = ((fresh && i ? i.brake : 0) * 100) + '%';
      modalRaf = requestAnimationFrame(tick);
    }
    copy.addEventListener('click', function () {
      var S = W().session(); if (!S) return;
      try { navigator.clipboard.writeText(S.url).then(function () { toast('Link copied', 'ok'); }, function () { toast(S.url); }); } catch (e) { toast(S.url); }
    });
    manual.querySelector('[data-k="acc"]').addEventListener('click', function () {
      var S = W().session(), v = manual.querySelector('[data-k="ans"]').value;
      if (!S || !v.trim()) return;
      S.accept(v).then(function () { toast('Answer accepted, connecting…', 'ok'); }, function (e) { toast('That answer code did not work: ' + (e && e.message || e), 'bad'); });
    });
    manual.querySelector('[data-k="new"]').addEventListener('click', function () { var S = W().session(); if (S && S.newInvite) S.newInvite().then(function () { showSession(S); }); });
    done.addEventListener('click', closePairing);
    x.addEventListener('click', closePairing);
    stop.addEventListener('click', function () { var S = W().session(); if (S) S.close(); closePairing(); toast('Phone wheel disconnected'); });
    ov.addEventListener('click', function (e) { if (e.target === ov) closePairing(); });
    ov._key = function (e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closePairing(); } else e.stopPropagation(); };
    window.addEventListener('keydown', ov._key, true);
    renderSeg(viaNow === 'auto' ? 'online' : viaNow);
    var existing = W().session();
    if (existing && (viaNow === 'auto' || viaNow === existing.via)) showSession(existing); else start(viaNow);
    modalRaf = requestAnimationFrame(tick);
    return ov;
  }

  /* ---------------------------------------------------------------- status chip + transition toasts */
  var lastState = null;
  function ensureChip() {
    ensureCss();
    if (!chip && document.body) {
      chip = el('button', 'pw-chip'); chip.type = 'button'; chip.title = 'Phone wheel';
      chip.addEventListener('click', function () { openPairing(); });
      document.body.appendChild(chip);
    }
    if (!chipTimer) chipTimer = setInterval(updateChip, 250);
    updateChip();
  }
  function updateChip() {
    var S = W() && W().session();
    if (!S) {
      if (chip) chip.style.display = 'none';
      if (lastState && lastState !== 'closed') lastState = null;
      return;
    }
    var rx = S.rx, t = performance.now(), fresh = rx.isFresh(t);
    var key = fresh ? 'live' : rx.state === 'waiting' ? 'waiting' : 'lost';
    var hub = H(), driving = hub && hub.status().driving;
    if (lastState && key !== lastState) {
      if (key === 'live') toast('Phone wheel connected', 'ok');
      else if (key === 'lost' && lastState === 'live' && driving) toast('Phone wheel signal lost: steering centred, throttle lifted', 'bad');
      else if (key === 'waiting' && lastState !== 'waiting') toast('Phone wheel disconnected. Waiting for it to reconnect…', 'bad');
    }
    lastState = key;
    chip.style.display = '';
    chip.innerHTML = '<span class="pw-dot ' + (key === 'live' ? 'ok' : key === 'lost' ? 'bad' : '') + '"></span>' + ICON.phone +
      '<span>' + (key === 'live' ? 'Wheel' + (rx.mode && rx.mode() === 'relay' ? ' (via server)' : rx.mode && rx.mode() === 'turn' ? ' (via TURN)' : '') + ' · ' + (rx.delayText ? rx.delayText() : (rx.rtt() != null ? rx.rtt() : '—') + ' ms') : key === 'lost' ? 'Wheel · signal lost' : 'Wheel · waiting (' + esc(S.via === 'manual' ? 'invite' : S.code) + ')') + '</span>';
    // telemetry for the phone's dash (~10 Hz)
    if (hub && fresh) rx.telemetry(hub.status(), t);
  }
  if (W() && W().on) W().on('session', function () { ensureChip(); });

  /* ---------------------------------------------------------------- tilt on this phone */
  var touchRefresh = null;
  function enableTilt() {
    var t = TL();
    if (!t) return Promise.resolve({ ok: false, reason: 'unsupported' });
    var o = O();
    if (o && o.requestFullscreenAndLock) o.requestFullscreenAndLock(); else requestFullscreen();
    return t.local.enable().then(function (r) {
      if (!r.ok) {
        toast(r.reason === 'insecure' ? 'Tilt steering needs HTTPS (open the game from its https:// address).' :
          r.reason === 'denied' ? 'Motion access was denied. Allow Motion & Orientation for this site and try again.' :
            'This device has no tilt sensor.', 'bad');
      } else { toast('Tilt steering on: hold the phone like a wheel. Gas right, brake left.', 'ok'); lockLandscape(); }
      refreshTouch(); orientSync();
      return r;
    });
  }
  function disableTilt() { var t = TL(); if (t) t.local.disable(); refreshTouch(); orientSync(); toast('Tilt steering off'); }
  function refreshTouch() { if (typeof touchRefresh === 'function') { try { touchRefresh(); } catch (e) { /* ignore */ } } updateTouchLayer(); }
  function requestFullscreen() {
    var d = document.documentElement;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) return;
      var fn = d.requestFullscreen || d.webkitRequestFullscreen;
      if (fn) { var p = fn.call(d, { navigationUI: 'hide' }); if (p && p.catch) p.catch(function () {}); }
    } catch (e) { /* ignore: iOS Safari has no element fullscreen */ }
  }
  function lockLandscape() {
    var o = O(); if (o && o.lock) { o.lock(); return; }
    try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {}); } catch (e) { /* ignore */ }
  }
  /* Orientation session while tilt-steering a race / drift on this phone: the landscape side is frozen when driving starts,
     an OS auto-rotation (turning the phone past 90 deg) only counter-rotates #race-root, and the steering angle keeps its
     frozen reference, so it stays continuous. Ends (rotation undone, lock released) when driving stops or tilt is off. */
  var drivingNow = false;
  function orientSync() {
    var o = O(), t = TL();
    if (!o || !o.begin) return;
    var on = drivingNow && !!(t && t.local && t.local.enabled) && coarse();
    var rr = on ? document.getElementById('race-root') : null;
    if (on && rr) { if (!o.active() || o.target() !== rr) o.begin(rr, 'tilt'); }
    else if (o.active() && o.snapshot && o.target() && o.target().id === 'race-root') {
      o.end('tilt');
      if (t && t.local && t.local.steerer) t.local.steerer.unlockRef();
    }
  }
  if (O() && O().onSide) O().onSide(function (s) { var t = TL(); if (t && t.local && t.local.steerer && t.local.enabled) t.local.steerer.lockRef(s.side); });
  function recentreTilt() { var o = O(), t = TL(); if (o && o.active && o.active()) o.recentre(); if (t) t.local.recalibrate(); }

  var tlayer = null;
  function mountTouch(layer, R, refresh) {
    ensureCss();
    touchRefresh = refresh || null;
    if (tlayer && tlayer.parentNode) tlayer.parentNode.removeChild(tlayer);
    var t = TL(), P = t ? t.local.pedals : { throttle: 0, brake: 0, handbrake: false };
    var pad = el('div', 'pw-tpad');
    function zone(cls, label, key) {
      var z = el('div', 'pw-zone ' + cls, '<div class="pw-fill"></div><span>' + label + '</span>'), fill = z.firstChild, ids = {};
      function at(e) {
        var p = pt(z, e), v = clamp(0.6 + 0.4 * (1 - p.y / (p.h || 1)) * 1.25, 0.5, 1);
        P[key] = v; fill.style.height = Math.round(v * 100) + '%';
      }
      z.addEventListener('pointerdown', function (e) { ids[e.pointerId] = 1; try { z.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } z.classList.add('is-down'); at(e); e.preventDefault(); });
      z.addEventListener('pointermove', function (e) { if (ids[e.pointerId]) at(e); });
      function end(e) { if (!ids[e.pointerId]) return; delete ids[e.pointerId]; if (!Object.keys(ids).length) { P[key] = 0; fill.style.height = '0'; z.classList.remove('is-down'); } }
      z.addEventListener('pointerup', end); z.addEventListener('pointercancel', end); z.addEventListener('lostpointercapture', end);
      return z;
    }
    function tb(cls, label, down, up) {
      var b = el('div', 'pw-tb ' + cls, label); b.setAttribute('role', 'button');
      b.addEventListener('pointerdown', function (e) { b.classList.add('is-down'); try { b.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } down(); e.preventDefault(); e.stopPropagation(); });
      function end() { b.classList.remove('is-down'); if (up) up(); }
      b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end);
      return b;
    }
    function ev(type) { var hb = H(); if (hb) hb.pushEvent(type, 'tilt'); }
    pad.appendChild(zone('brake', 'BRAKE', 'brake'));
    pad.appendChild(zone('gas', 'GAS', 'throttle'));
    pad.appendChild(tb('hb', 'HB', function () { P.handbrake = true; }, function () { P.handbrake = false; }));
    pad.appendChild(tb('cal', 'CENTRE', function () { recentreTilt(); toast('Steering centred'); }));
    var up = tb('up', '+', function () { ev('shiftUp'); }), dn = tb('dn', '−', function () { ev('shiftDown'); });
    pad.appendChild(up); pad.appendChild(dn);
    var ind = el('div', 'pw-steerind', '<i></i>'); pad.appendChild(ind);
    pad.appendChild(el('div', 'pw-rotate', '<div>' + ICON.phone.replace('width="16" height="16"', 'width="40" height="40"') + '<p>Turn your phone sideways (landscape) and hold it like a steering wheel.</p></div>'));
    var en = el('button', 'pw-enable', ICON.wheel + '<span>Enable tilt steering</span>'); en.type = 'button';
    en.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); enableTilt(); });
    layer.appendChild(pad); layer.appendChild(en);
    tlayer = pad; tlayer._en = en; tlayer._gears = [up, dn]; tlayer._ind = ind.firstChild; tlayer._R = R;
    updateTouchLayer();
    if (!tlayer._loop) {
      var loop = function () {
        if (!tlayer || !tlayer.isConnected) return;
        var on = !!(t && t.local.enabled);
        if (on && tlayer._ind) tlayer._ind.style.left = (50 + 50 * clamp(t.local.steer, -1, 1)) + '%';
        requestAnimationFrame(loop);
      };
      tlayer._loop = true; requestAnimationFrame(loop);
    }
  }
  function updateTouchLayer() {
    if (!tlayer) return;
    var t = TL(), on = !!(t && t.local.enabled);
    tlayer.style.display = on ? '' : 'none';
    document.documentElement.classList.toggle('pw-tilt-on', on);
    if (tlayer._en) tlayer._en.style.display = !on && canTilt() ? '' : 'none';
    var R = tlayer._R, auto = !R || !R.settings || !R.settings.assists || R.settings.assists.autoShift !== false;
    tlayer._gears.forEach(function (g) { g.style.display = auto ? 'none' : ''; });
  }

  /* ---------------------------------------------------------------- phone-friendly driving (no zoom / scroll) */
  var vpSaved = null;
  function setTouchDriving(on) {
    var root = document.documentElement;
    on = !!on && coarse();
    root.classList.toggle('pw-touch-driving', on);
    var vp = document.querySelector('meta[name="viewport"]');
    if (vp) {
      if (on && vpSaved == null) { vpSaved = vp.getAttribute('content') || ''; vp.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'); }
      else if (!on && vpSaved != null) { vp.setAttribute('content', vpSaved); vpSaved = null; }
    }
  }
  document.addEventListener('cb:driving', function (e) {
    var on = !!(e && e.detail && e.detail.driving);
    drivingNow = on;
    setTouchDriving(on);
    orientSync();
    if (!on) { var hb = H(); if (hb) hb.frame({ driving: false }); }
    updateTouchLayer();
  });
  function blockGesture(e) { if (document.documentElement.classList.contains('pw-touch-driving')) e.preventDefault(); }
  document.addEventListener('gesturestart', blockGesture, { passive: false });
  document.addEventListener('dblclick', blockGesture, { passive: false });
  document.addEventListener('touchmove', function (e) { if (document.documentElement.classList.contains('pw-touch-driving') && e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
  // first tap on the driving screen of a phone: go fullscreen (needs a gesture)
  document.addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'touch' || !document.documentElement.classList.contains('pw-touch-driving')) return;
    if (!document.documentElement._pwFs) {
      document.documentElement._pwFs = true;
      var o = O();
      if (o && o.requestFullscreenAndLock) o.requestFullscreenAndLock(); else { requestFullscreen(); lockLandscape(); }
    }
  }, true);

  /* ---------------------------------------------------------------- menu / setup / settings entries */
  function menuItems() {
    var S = W() && W().session(), items = [];
    items.push({ label: S ? (S.rx.isFresh(performance.now()) ? 'Phone wheel · connected' : 'Phone wheel · pairing') : 'Use phone as wheel', icon: 'steer', fn: function () { openPairing(); } });
    var t = TL();
    if (canTilt()) {
      if (t.local.enabled) {
        items.push({ label: 'Re-centre tilt steering', icon: 'steer', fn: function () { recentreTilt(); toast('Steering centred'); } });
        items.push({ label: 'Tilt steering: off', icon: 'steer', fn: disableTilt });
      } else items.push({ label: 'Enable tilt steering', icon: 'steer', fn: function () { enableTilt(); } });
    }
    var SS = CB.input.sources;   // the picked steering source's own entries (mouse, controller tilt, webcam)
    if (SS && typeof SS.menuItems === 'function') items = items.concat(SS.menuItems());
    return items;
  }
  function sensRow() {
    var hub = H(), p = hub ? hub.prefs : { maxAngle: 35, smoothing: 0.5 };
    var w = el('div', '');
    w.innerHTML = '<label class="pw-range"><span>Full lock at</span><input type="range" min="15" max="180" step="1" value="' + p.maxAngle + '" data-k="max"><b>' + p.maxAngle + '°</b></label>' +
      '<label class="pw-range"><span>Smoothing</span><input type="range" min="0" max="1" step="0.05" value="' + p.smoothing + '" data-k="sm"><b>' + Math.round(p.smoothing * 100) + '%</b></label>';
    w.querySelector('[data-k="max"]').addEventListener('input', function (e) { var v = +e.target.value; e.target.nextSibling.textContent = v + '°'; if (hub) hub.setPrefs({ maxAngle: v }); });
    w.querySelector('[data-k="sm"]').addEventListener('input', function (e) { var v = +e.target.value; e.target.nextSibling.textContent = Math.round(v * 100) + '%'; if (hub) hub.setPrefs({ smoothing: v }); });
    return w;
  }
  function setupRow() {
    ensureCss();
    var box = el('div', 'pw-setup');
    box.innerHTML = '<b>Phone steering</b><small>Use your phone as a steering wheel for this computer (scan a QR code), or tilt-steer when playing on the phone itself. Keyboard and gamepad still work and take over while used.</small>';
    var row = el('div', 'pw-row');
    var b1 = el('button', 'pw-btn', ICON.phone + '<span>Use phone as wheel</span>'); b1.type = 'button';
    b1.addEventListener('click', function () { openPairing(); });
    row.appendChild(b1);
    if (canTilt()) {
      var t = TL();
      var b2 = el('button', 'pw-btn', ICON.wheel + '<span>' + (t.local.enabled ? 'Tilt steering: on' : 'Enable tilt steering') + '</span>'); b2.type = 'button';
      b2.addEventListener('click', function () {
        if (t.local.enabled) { disableTilt(); b2.lastChild.textContent = 'Enable tilt steering'; }
        else enableTilt().then(function (r) { if (r.ok) b2.lastChild.textContent = 'Tilt steering: on'; });
      });
      row.appendChild(b2);
    }
    box.appendChild(row);
    box.appendChild(sensRow());
    var SS = CB.input.sources;   // shared "Steering source" picker (js/input/sources.js) above the phone row
    if (SS && typeof SS.setupEl === 'function') {
      var wrap = el('div', ''); wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px';
      wrap.appendChild(SS.setupEl()); wrap.appendChild(box);
      return wrap;
    }
    return box;
  }
  function settingsHTML() {
    ensureCss();
    var p = H() ? H().prefs : { maxAngle: 35, smoothing: 0.5, invert: false };
    function row(label, hint, ctl) { return '<div class="gh-row"><div class="lbl"><b>' + esc(label) + '</b>' + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</div>' + ctl + '</div>'; }
    var SS = CB.input.sources;   // shared "Steering source" picker (js/input/sources.js)
    return (SS && typeof SS.settingsHTML === 'function' ? SS.settingsHTML() : '') + '<h2 class="gh-h2">Phone steering</h2>' +
      row('Use phone as wheel', 'Pair your phone (QR code) and steer by tilting it like a wheel', '<button class="gh-btn" type="button" data-pw-act="pair">' + ICON.phone + ' Pair phone</button>') +
      (canTilt() ? row('Tilt steering on this device', 'Steer by tilting this phone; gas / brake on screen', '<button class="gh-btn" type="button" data-pw-act="tilt">' + (TL().local.enabled ? 'Turn off' : 'Enable tilt steering') + '</button>') : '') +
      row('Full lock angle', 'How far to turn the phone for full steering', '<label class="pw-range" style="min-width:220px"><input type="range" min="15" max="180" step="1" value="' + p.maxAngle + '" data-pw-pref="maxAngle"><b>' + p.maxAngle + '°</b></label>') +
      row('Tilt smoothing', 'Higher = steadier, lower = quicker', '<label class="pw-range" style="min-width:220px"><input type="range" min="0" max="1" step="0.05" value="' + p.smoothing + '" data-pw-pref="smoothing"><b>' + Math.round(p.smoothing * 100) + '%</b></label>');
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('[data-pw-act]');
    if (!a) return;
    e.preventDefault();
    var act = a.getAttribute('data-pw-act');
    if (act === 'pair') openPairing();
    else if (act === 'tilt') { var t = TL(); if (t.local.enabled) { disableTilt(); a.textContent = 'Enable tilt steering'; } else enableTilt().then(function (r) { if (r.ok) a.textContent = 'Turn off'; }); }
  });
  document.addEventListener('input', function (e) {
    var k = e.target && e.target.getAttribute && e.target.getAttribute('data-pw-pref');
    if (!k || !H()) return;
    var v = +e.target.value, o = {}; o[k] = v; H().setPrefs(o);
    var b = e.target.nextSibling; if (b) b.textContent = k === 'maxAngle' ? v + '°' : Math.round(v * 100) + '%';
  });

  CB.input.ui = {
    openPairing: openPairing, closePairing: closePairing, menuItems: menuItems, setupRow: setupRow, settingsHTML: settingsHTML,
    mountTouch: mountTouch, enableTilt: enableTilt, disableTilt: disableTilt, toast: toast, _statusText: statusText
  };
})();
