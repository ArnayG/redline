/* ==========================================================================
   Redline — js/input/wheel-page.js
   CB.input.wheelPage : the phone's steering-wheel controller page, opened from the pairing QR code:
       index.html#/wheel/<CODE>            online pairing (CB.net.signal vercel /api/signal)
       index.html#/wheel/<CODE>?via=local  same browser, another tab (BroadcastChannel; for testing)
       index.html#/wheel/~<invite>         manual invite code (no server; the page shows an answer code to paste back)
   Loaded before js/router.js: when the URL is a wheel link the page claims the document (the router does not boot) and
   shows a full-screen landscape controller: a big steering wheel that turns with the phone (tilt = rotation about the
   screen normal, js/input/tilt.js), gas (right) / brake (left) pedal zones, handbrake, gear up / down, pause, re-centre,
   sensitivity, haptics (navigator.vibrate) from the game, latency + connection status, automatic reconnect.
   Without a usable tilt sensor (insecure http page, desktop browser) the wheel can be dragged with a finger.
   Start freezes the landscape side (CB.input.orient): turning the phone past 90 deg never flips the page (Android: real
   orientation lock in fullscreen; iOS: CSS counter-rotation) and the steering angle stays continuous.
     CB.input.wheelPage.claimsPage() -> bool    CB.input.wheelPage.state()  (debug / tests)
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;
CB.input = CB.input || {};

(function () {
  'use strict';
  var hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined';
  var route = hasDOM && CB.input.wheel ? CB.input.wheel.parseRoute(window.location.hash) : null;
  var claimed = !!route;
  var api = { claimsPage: function () { return claimed; }, route: route };
  CB.input.wheelPage = api;
  if (!claimed) return;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(sel) { return document.querySelector(sel); }
  document.documentElement.classList.add('pw-wheel-page');
  // the controller is a dark, sideways driving surface on every theme: it uses the game's dark tokens (css/styles.css § 01)
  document.documentElement.setAttribute('data-theme', 'dark');

  var CSS = [
    'html.pw-wheel-page,html.pw-wheel-page body{margin:0;height:100%;overflow:hidden;background:var(--bg-3);overscroll-behavior:none;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}',
    'html.pw-wheel-page body>*:not(#pw-wheel){display:none!important}',
    '#pw-wheel{position:fixed;inset:0;color:var(--text);background:radial-gradient(120% 90% at 50% 40%,var(--studio-top) 0%,var(--bg-3) 70%);touch-action:none}',
    '#pw-wheel *{box-sizing:border-box}',
    '.pwp-top{position:absolute;left:0;right:0;top:0;display:flex;align-items:center;gap:10px;padding:max(8px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) 8px max(12px,env(safe-area-inset-left));z-index:3}',
    '.pwp-stat{display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);font-size:var(--fs-sm);font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw}',
    '.pwp-dot{width:9px;height:9px;border-radius:50%;background:var(--warn);flex:none}.pwp-dot.ok{background:var(--good)}.pwp-dot.bad{background:var(--bad)}',
    '.pwp-game{flex:1;text-align:center;font-size:var(--fs-xs);letter-spacing:.14em;text-transform:uppercase;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pwp-game b{color:var(--accent-hi);letter-spacing:.2em}',
    '.pwp-tbtn{appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:var(--text);border-radius:12px;height:40px;min-width:44px;padding:0 12px;font:700 var(--fs-xs) var(--font);letter-spacing:.06em}',
    '.pwp-tbtn:active,.pwp-tbtn.is-down{border-color:var(--accent);background:rgba(201,165,107,.18)}',
    '.pwp-wheelbox{position:absolute;left:24%;right:24%;top:calc(56px + env(safe-area-inset-top));bottom:max(12px,env(safe-area-inset-bottom));display:grid;place-items:center;z-index:1}',
    '.pwp-wheel{width:min(100%,calc(100vh - 90px));width:min(100%,calc(100dvh - 90px - env(safe-area-inset-top) - env(safe-area-inset-bottom)));aspect-ratio:1;max-width:420px;will-change:transform;filter:drop-shadow(0 18px 30px rgba(0,0,0,.6))}',
    '.pwp-dash{position:absolute;left:50%;bottom:max(10px,env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;gap:14px;align-items:baseline;font-variant-numeric:tabular-nums;color:var(--text-dim);font-size:var(--fs-xs);z-index:2;pointer-events:none}',
    '.pwp-dash b{font-size:var(--fs-xl);color:var(--text-strong);font-weight:700}',
    '.pwp-zone{position:absolute;bottom:0;top:calc(56px + env(safe-area-inset-top));width:24%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding-bottom:max(18px,env(safe-area-inset-bottom));font-size:var(--fs-sm);font-weight:800;letter-spacing:.2em;color:rgba(255,255,255,.6);border-radius:22px 22px 0 0;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.07);overflow:hidden;z-index:2}',
    '.pwp-zone.brake{left:max(6px,env(safe-area-inset-left))}.pwp-zone.gas{right:max(6px,env(safe-area-inset-right))}',
    '.pwp-zone i{position:absolute;left:0;right:0;bottom:0;height:0;opacity:.45}',
    '.pwp-zone.gas i{background:linear-gradient(0deg,var(--good),transparent)}.pwp-zone.brake i{background:linear-gradient(0deg,var(--bad),transparent)}',
    '.pwp-zone span{position:relative}.pwp-zone.is-down{border-color:var(--accent);color:var(--text-strong)}',
    '.pwp-side{position:absolute;bottom:max(16px,env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:8px;z-index:3}',
    '.pwp-side.l{left:calc(24% + 14px)}.pwp-side.r{right:calc(24% + 14px)}',
    '.pwp-side .pwp-tbtn{height:52px;min-width:58px;font-size:var(--fs-md)}',
    '.pwp-side .hb{height:72px}',
    /* arcade gameplay buttons (shown only while the computer runs an arcade session: {t:'arcade', on:true}) */
    '.pwp-arc{position:absolute;top:calc(62px + env(safe-area-inset-top));left:calc(24% + 14px);right:calc(24% + 14px);display:none;justify-content:space-between;align-items:flex-start;z-index:3;pointer-events:none}',
    '.pwp-arc.on{display:flex}.pwp-arc>button{pointer-events:auto;touch-action:none}',
    '.pwp-arc .pwp-item{width:84px;height:64px;border-radius:16px;font-size:var(--fs-xs);line-height:1.1}',
    '.pwp-arc .pwp-nitro{width:96px;height:96px;border-radius:50%;font-size:var(--fs-lg);font-weight:900;border-color:rgba(127,227,255,.7);background:rgba(20,70,200,.25);color:var(--text-strong)}',
    '.pwp-arc .pwp-nitro.full{box-shadow:0 0 22px rgba(80,180,255,.8)}',
    '.pwp-ov{position:absolute;inset:0;z-index:10;display:grid;place-items:center;padding:max(20px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));background:rgba(5,5,7,.92);text-align:center;overflow:auto}',
    '.pwp-card{max-width:520px;display:flex;flex-direction:column;gap:14px;align-items:center}',
    '.pwp-card h1{margin:0;font:var(--fw-title) var(--fs-title)/1.15 var(--serif);letter-spacing:var(--tracking-title);color:var(--text-strong)}.pwp-card p{margin:0;color:var(--text-dim);font-size:var(--fs-md);line-height:1.5}',
    /* Start = the game's gold primary CTA (.cb-btn.primary) */
    '.pwp-go{appearance:none;border:0;border-radius:var(--radius);background:var(--accent-grad);background-size:160% 160%;color:var(--accent-ink);font:700 var(--fs-lg) var(--font);padding:16px 34px;letter-spacing:.01em;box-shadow:0 1px 0 rgba(255,255,255,.35) inset,0 8px 22px -10px var(--accent-ring)}',
    '.pwp-warn{padding:10px 14px;border-radius:12px;border:1px solid rgba(227,163,58,.4);background:rgba(227,163,58,.1);font-size:var(--fs-sm);line-height:1.45;color:var(--text);text-align:left}',
    '.pwp-code{font:700 calc(var(--fs-2xl) * 1.07)/1 var(--mono);letter-spacing:.3em;color:var(--accent-hi)}',
    '.pwp-in{font:700 var(--fs-2xl) var(--mono);letter-spacing:.3em;text-transform:uppercase;width:220px;text-align:center;padding:10px;border-radius:12px;border:1px solid var(--line-2);background:var(--bg-2);color:var(--text-strong)}',
    '.pwp-ta{width:min(480px,86vw);min-height:70px;border-radius:10px;border:1px solid var(--line-2);background:var(--bg-2);color:var(--text);font:var(--fs-xs) var(--mono);padding:8px;-webkit-user-select:text;user-select:text}',
    '.pwp-sheet{position:absolute;right:max(10px,env(safe-area-inset-right));top:calc(56px + env(safe-area-inset-top));z-index:9;width:min(340px,70vw);max-height:calc(100vh - 70px);max-height:calc(100dvh - 70px - env(safe-area-inset-top) - env(safe-area-inset-bottom));overflow:auto;overscroll-behavior:contain;padding:16px;border-radius:16px;background:var(--panel);border:1px solid var(--line);box-shadow:0 20px 50px rgba(0,0,0,.6);display:flex;flex-direction:column;gap:12px;font-size:var(--fs-sm)}',
    '.pwp-sheet label{display:flex;flex-direction:column;gap:6px;color:var(--text-dim)}.pwp-sheet label b{color:var(--text-strong)}',
    '.pwp-seg{display:flex;gap:6px}.pwp-seg .pwp-tbtn{height:34px;min-width:52px}',
    '.pwp-sheet input[type=range]{width:100%;min-height:40px}.pwp-sheet .row{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--text)}',
    '.pwp-rot{position:absolute;inset:0;z-index:8;display:none;place-items:center;padding:24px;text-align:center;background:rgba(5,5,7,.86);font-weight:700;font-size:var(--fs-lg);pointer-events:none}',
    '@media (orientation:portrait){.pwp-rot{display:grid}}',
    '.pwp-state{position:absolute;left:50%;top:60px;transform:translateX(-50%);z-index:4;padding:6px 14px;border-radius:999px;background:rgba(8,8,10,.9);border:1px solid rgba(255,255,255,.12);font-size:var(--fs-xs);font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent-hi);pointer-events:none;max-width:min(560px,52vw);text-align:center}'
  ].join('\n')
    // safe-area insets through CSS variables: CB.input.orient re-maps them when it counter-rotates the page
    .replace(/env\(safe-area-inset-(top|right|bottom|left)\)/g, 'var(--pw-sa-$1,env(safe-area-inset-$1))');

  var WHEEL_SVG = '<svg class="pwp-wheel" viewBox="-100 -100 200 200" aria-label="Steering wheel">' +
    '<defs><radialGradient id="pwg" cx="40%" cy="30%" r="80%"><stop offset="0" stop-color="#3a3b42"/><stop offset="1" stop-color="#121317"/></radialGradient></defs>' +
    '<circle r="92" fill="none" stroke="#1d1e23" stroke-width="18"/><circle r="92" fill="none" stroke="url(#pwg)" stroke-width="14"/>' +
    '<path d="M-10 -99 h20 v15 h-20z" fill="#c9a56b"/>' +
    '<path d="M-86 -6 C-50 -14 -30 -18 -20 -10 L-16 10 C-40 16 -64 22 -84 30Z" fill="#202127" stroke="#2c2d34"/>' +
    '<path d="M86 -6 C50 -14 30 -18 20 -10 L16 10 C40 16 64 22 84 30Z" fill="#202127" stroke="#2c2d34"/>' +
    '<path d="M-14 16 L14 16 L10 84 L-10 84Z" fill="#202127" stroke="#2c2d34"/>' +
    '<circle r="28" fill="#17181d" stroke="#2c2d34" stroke-width="2"/>' +
    '<path fill-rule="evenodd" d="M-9 13V-13H2A7 7 0 0 1 4.2 0.6L9.5 13H3.3L-1.6 1.5H-3.5V13ZM-3.5 -8.5V-3H1.6A2.75 2.75 0 0 0 1.6 -8.5Z" fill="#e0352b"/></svg>';

  var st = {
    via: route.via, code: route.code, invite: route.invite, phase: 'start', conn: 'idle', rtt: null, game: null, status: null, tel: null,
    angle: 0, steer: 0, throttle: 0, brake: 0, handbrake: false, sensor: 'none', drag: 0, vib: true, sent: 0, error: null, answer: null
  };
  api.state = function () { return st; };

  var hub = CB.input.hub, T = CB.input.tilt, Wh = CB.input.wheel, O = CB.input.orient;
  var prefs = hub ? hub.prefs : { maxAngle: 35, deadzone: 2, smoothing: 0.5, invert: false };
  try { var v0 = localStorage.getItem('forge.wheelVib'); if (v0 === '0') st.vib = false; } catch (e) { /* ignore */ }
  var steerer = T.createSteer(prefs);
  // the steering reference follows the frozen landscape side of the orientation session (never the OS auto-rotation)
  if (O && O.onSide) O.onSide(function (s) { steerer.lockRef(s.side); st.side = s.side; });
  /** pointer position inside el in its own (unrotated) frame: correct while the page is counter-rotated */
  function pt(el, e) { if (O && O.point) return O.point(el, e); var r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; }
  var tx = null, client = null, sig = null, retryT = 0, closedByUser = false;

  function boot() {
    var s = document.createElement('style'); s.id = 'pwp-css'; s.textContent = CSS; document.head.appendChild(s);
    var vp = document.querySelector('meta[name="viewport"]');
    if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
    document.title = 'Redline Wheel';
    var root = document.createElement('div'); root.id = 'pw-wheel';
    root.innerHTML =
      '<div class="pwp-top"><div class="pwp-stat"><span class="pwp-dot"></span><span data-k="conn">Not connected</span></div>' +
      '<div class="pwp-game"><b>REDLINE</b> wheel <span data-k="game"></span></div>' +
      '<button class="pwp-tbtn" data-k="cal" type="button">CENTRE</button><button class="pwp-tbtn" data-k="pause" type="button">❚❚</button><button class="pwp-tbtn" data-k="set" type="button" aria-label="Settings">⚙</button></div>' +
      '<div class="pwp-zone brake" data-k="brake"><i></i><span>BRAKE</span></div>' +
      '<div class="pwp-zone gas" data-k="gas"><i></i><span>GAS</span></div>' +
      '<div class="pwp-wheelbox" data-k="wbox">' + WHEEL_SVG + '</div>' +
      '<div class="pwp-side l"><button class="pwp-tbtn hb" data-k="hb" type="button">HB</button></div>' +
      '<div class="pwp-side r"><button class="pwp-tbtn" data-k="up" type="button">+</button><button class="pwp-tbtn" data-k="dn" type="button">−</button></div>' +
      '<div class="pwp-arc" data-k="arc"><button class="pwp-tbtn pwp-item" data-k="item" type="button">ITEM</button><button class="pwp-tbtn pwp-nitro" data-k="nitro" type="button">NITRO</button></div>' +
      '<div class="pwp-dash"><span><b data-k="spd">—</b> km/h</span><span>gear <b data-k="gear">—</b></span></div>' +
      '<div class="pwp-state" data-k="gstate" style="display:none"></div>' +
      '<div class="pwp-rot">Turn your phone sideways (landscape) and hold it like a steering wheel.</div>';
    document.body.appendChild(root);
    wire(root);
    showStart();
    requestAnimationFrame(loop);
  }

  /* ---------------------------------------------------------------- overlays */
  function overlay(html) {
    var o = $('#pw-wheel .pwp-ov');
    if (!o) { o = document.createElement('div'); o.className = 'pwp-ov'; $('#pw-wheel').appendChild(o); }
    o.innerHTML = '<div class="pwp-card">' + html + '</div>';
    return o;
  }
  function closeOverlay() { var o = $('#pw-wheel .pwp-ov'); if (o) o.parentNode.removeChild(o); }
  function showStart() {
    st.phase = 'start';
    if (!st.code && !st.invite) {
      var o0 = overlay('<h1>Phone steering wheel</h1><p>Type the 5-letter code shown on the computer.</p><input class="pwp-in" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE"><button class="pwp-go" type="button">Connect</button>');
      var inp = o0.querySelector('input');
      o0.querySelector('button').addEventListener('click', function () {
        var c = (inp.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/.test(c)) { inp.style.borderColor = '#e5484d'; return; }
        st.code = c; try { history.replaceState(null, '', '#/wheel/' + c + (st.via === 'local' ? '?via=local' : '')); } catch (e) { /* ignore */ }
        showStart();
      });
      return;
    }
    var secure = T.sensor.secure(), html = '<h1>Phone steering wheel</h1>' +
      '<p>Hold your phone in <b>landscape</b> like a steering wheel and tilt it to steer. Gas on the right, brake on the left.</p>' +
      (st.code ? '<div class="pwp-code">' + esc(st.code) + '</div>' : '<p>Invite code pairing (no server)</p>');
    if (!secure) html += '<div class="pwp-warn"><b>Tilt sensors are blocked on this page.</b> Phones only allow motion sensors on secure (https://) pages. Open the game from its https address (the Vercel site, or an HTTPS tunnel such as <code>npx localtunnel --port 8080</code> / <code>cloudflared tunnel --url http://localhost:8080</code>). You can still connect and steer by dragging the wheel.</div>';
    else if (!T.sensor.available()) html += '<div class="pwp-warn">This browser reports no motion sensor. You can steer by dragging the wheel.</div>';
    html += '<button class="pwp-go" type="button">Start</button>';
    var o = overlay(html);
    o.querySelector('.pwp-go').addEventListener('click', onStart);
  }
  function onStart() {
    // all of these need the user gesture. Freeze the landscape side first (the page stays sideways from now on, even
    // when the player turns the phone past 90 deg and the OS rotates), then fullscreen + a real lock where allowed.
    if (O && O.begin) {
      O.begin($('#pw-wheel'), 'wheel', { lock: false });
      O.requestFullscreenAndLock();
    } else {
      try { var d = document.documentElement, fs = d.requestFullscreen || d.webkitRequestFullscreen; if (fs) { var p = fs.call(d, { navigationUI: 'hide' }); if (p && p.catch) p.catch(function () {}); } } catch (e) { /* iOS */ }
      try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {}); } catch (e2) { /* ignore */ }
    }
    wakeLock();
    if (st.vib && navigator.vibrate) { try { navigator.vibrate(15); } catch (e3) { /* ignore */ } }
    T.sensor.start().then(function (r) {
      st.sensor = r.ok ? 'tilt-wait' : 'drag';
      if (!r.ok && r.reason === 'denied') st.error = 'Motion access denied: drag the wheel, or allow Motion & Orientation for this site and reload.';
      if (r.ok) setTimeout(function () { if (st.sensor === 'tilt-wait') { st.sensor = 'drag'; st.error = 'No tilt readings from this device: drag the wheel to steer.'; } }, 1800);
      closeOverlay();
      st.phase = 'drive';
      connect();
    });
  }
  var wl = null;
  function wakeLock() {
    try { if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').then(function (l) { wl = l; }, function () {}); } catch (e) { /* ignore */ }
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && st.phase === 'drive') wakeLock(); });

  /* ---------------------------------------------------------------- sensor -> steer */
  T.sensor.onReading(function (b, g, a, t) {
    if (st.sensor === 'tilt-wait') { st.sensor = 'tilt'; st.error = null; if (O && O.recentre) O.recentre({ beta: b, gamma: g }); steerer.recalibrate(); }
    if (st.sensor !== 'tilt') return;
    st.steer = steerer.update(b, g, a, t);
    st.angle = steerer.angle;
  });

  /* ---------------------------------------------------------------- connection */
  function setConn(c, txt) { st.conn = c; st.connText = txt; }
  function connect() {
    clearTimeout(retryT);
    if (closedByUser) return;
    var S = CB.net && CB.net.signal, NT = CB.net && CB.net.transport;
    if (!S || !NT) { setConn('bad', 'Network modules missing'); return; }
    try { if (tx) tx.close(); } catch (e) { /* ignore */ }
    try { if (client) client.close(); } catch (e1) { /* ignore */ }
    try { if (sig) sig.close(); } catch (e2) { /* ignore */ }
    tx = null; client = null;
    setConn('wait', st.via === 'manual' ? 'Preparing answer code…' : 'Reaching server…');
    sig = st.via === 'local' ? S.local({ channel: Wh.LOCAL_CHANNEL }) : st.via === 'manual' ? S.manual() : S.vercel();
    var joinArg = st.via === 'manual' ? st.invite : st.code;
    var mySig = sig;
    sig.join(joinArg).then(function () {
      if (sig !== mySig) return;
      // relay fallback: input posted ~8 times/s, pipelined; each post also collects our mail (js/net/relay.js)
      client = NT.connect(sig, { reconnectAttempts: 6, pingInterval: 500, relay: { after: 4500, upGap: 125, downlinks: 0 } });
      var STAGE = { waiting: 'Waiting for computer…', connecting: 'Connecting…', relay: 'Connecting via server…' };
      if (st.via !== 'manual') setConn('wait', STAGE.waiting);
      client.on('stage', function (sg) { if (STAGE[sg] && st.via !== 'manual' && st.conn !== 'ok') setConn('wait', STAGE[sg]); });
      tx = Wh.createSender(client, { name: deviceName(), sensor: st.sensor === 'drag' ? 'touch' : 'tilt' });
      tx.on('state', function (s, reason) {
        if (s === 'open') { setConn('ok', 'Connected'); closeOverlay(); }
        else if (s === 'reconnecting') setConn('bad', 'Reconnecting…');
        else if (s === 'closed') {
          if (reason === 'replaced') { setConn('bad', 'Another phone took over the wheel'); closedByUser = true; return; }
          var why = reason === 'timeout' ? 'The computer did not answer (is its pairing screen still open?)' :
            reason === 'host-closed' ? 'The computer closed the pairing' : reason === 'full' ? 'Another phone is already paired' : 'Disconnected';
          setConn('bad', why + ' · retrying…'); retryT = setTimeout(connect, reason === 'timeout' || reason === 'host-closed' ? 3000 : 1500);
        }
      });
      tx.on('welcome', function (m) { st.game = m.game || 'Redline'; });
      tx.on('status', function (m) { st.status = m; });
      tx.on('tel', function (m) { st.tel = m; });
      tx.on('arcade', function (m) { st.arcade = m; st.arcadeT = Date.now(); });
      tx.on('hap', haptic);
      tx.on('bye', function (r) { if (r === 'closed') setConn('bad', 'The computer closed the pairing'); });
      if (st.via === 'manual' && sig.answer) {
        sig.answer().then(function (ans) {
          st.answer = ans;
          var o = overlay('<h1>Answer code</h1><p>Copy this code and paste it on the computer\'s pairing screen.</p><textarea class="pwp-ta" readonly>' + esc(ans) + '</textarea><button class="pwp-go" type="button">Copy</button>');
          o.querySelector('button').addEventListener('click', function () { try { navigator.clipboard.writeText(ans); } catch (e) { /* ignore */ } o.querySelector('textarea').select(); });
        }, function () { setConn('bad', 'This invite code is not valid'); });
      }
    }, function (e) {
      if (sig !== mySig) return;
      setConn('bad', joinError(e));
      if (st.via !== 'manual') retryT = setTimeout(connect, e && (e.code === 'blocked' || e.code === 'no-backend') ? 8000 : 3000);
    });
  }
  /** a join failure -> a specific, visible reason (never a silent hang) */
  function joinError(e) {
    var c = e && e.code, m = (e && e.message) || '';
    if (c === 'not-found' || /not.?found|no room/i.test(m)) return 'Computer not found: code ' + st.code + ' has expired or is mistyped. Open a new pairing on the computer · retrying';
    if (c === 'room-closed') return 'Code ' + st.code + ' has expired. Open a new pairing on the computer · retrying';
    if (c === 'full') return 'Another phone is already paired with this code';
    if (c === 'blocked') return 'Blocked by the web host\'s security (HTTP ' + (e.status || 403) + '): see Troubleshoot in DEPLOY-CPANEL.txt · retrying';
    if (c === 'rate-limited') return 'Server busy (rate limited) · retrying';
    if (c === 'no-backend') return 'No pairing server on this site (api/signal.php missing?) · use the same-device or invite option';
    if (c === 'unreachable' || c === 'network') return 'Server unreachable: check this phone\'s internet connection · retrying';
    return 'Cannot reach the computer (' + (c || m || 'error') + ') · retrying';
  }
  function deviceName() {
    var ua = navigator.userAgent || '';
    if (/iPhone/.test(ua)) return 'iPhone'; if (/iPad/.test(ua)) return 'iPad'; if (/Android/.test(ua)) return 'Android phone';
    return 'Phone';
  }
  var hapT = 0;
  function haptic(h) {
    if (!st.vib || !navigator.vibrate) return;
    var now = performance.now(), i = clamp(+h.intensity || 0.5, 0, 1);
    if (now - hapT < (h.kind === 'kerb' ? 90 : 60)) return;
    hapT = now;
    var ms = h.kind === 'kerb' ? 12 : h.kind === 'offroad' ? 8 : h.kind === 'wall' ? Math.round(40 + 80 * i) : Math.round(20 + 60 * i);
    try { navigator.vibrate(ms); } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- controls */
  function wire(root) {
    function k(n) { return root.querySelector('[data-k="' + n + '"]'); }
    function pedal(z, key) {
      var fill = z.querySelector('i'), ids = {};
      function at(e) { var p = pt(z, e); var v = clamp(0.6 + 0.4 * (1 - p.y / (p.h || 1)) * 1.25, 0.5, 1); st[key] = v; fill.style.height = Math.round(v * 100) + '%'; }
      z.addEventListener('pointerdown', function (e) { ids[e.pointerId] = 1; try { z.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } z.classList.add('is-down'); at(e); e.preventDefault(); });
      z.addEventListener('pointermove', function (e) { if (ids[e.pointerId]) at(e); });
      function end(e) { if (!ids[e.pointerId]) return; delete ids[e.pointerId]; if (!Object.keys(ids).length) { st[key] = 0; fill.style.height = '0'; z.classList.remove('is-down'); } }
      z.addEventListener('pointerup', end); z.addEventListener('pointercancel', end); z.addEventListener('lostpointercapture', end);
    }
    pedal(k('gas'), 'throttle'); pedal(k('brake'), 'brake');
    function hold(b, down, up) {
      b.addEventListener('pointerdown', function (e) { b.classList.add('is-down'); try { b.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } down(); e.preventDefault(); });
      function end() { b.classList.remove('is-down'); if (up) up(); }
      b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end);
    }
    function press(name) { return function () { if (tx) tx.press(name); if (st.vib && navigator.vibrate) { try { navigator.vibrate(8); } catch (e) { /* ignore */ } } }; }
    hold(k('hb'), function () { st.handbrake = true; }, function () { st.handbrake = false; });
    hold(k('up'), press('shiftUp')); hold(k('dn'), press('shiftDown'));
    hold(k('pause'), press('pause'));
    // arcade: NITRO is held (nitroOn / nitroOff), ITEM fires on release (swipe down = fire backwards)
    hold(k('nitro'), press('nitroOn'), press('nitroOff'));
    (function (b) {
      var y0 = 0, id = null;
      b.addEventListener('pointerdown', function (e) { id = e.pointerId; y0 = pt(b, e).y; b.classList.add('is-down'); try { b.setPointerCapture(id); } catch (x) { /* ignore */ } e.preventDefault(); });
      b.addEventListener('pointerup', function (e) { if (e.pointerId !== id) return; id = null; b.classList.remove('is-down'); press(pt(b, e).y - y0 > 30 ? 'itemBack' : 'item')(); });
      b.addEventListener('pointercancel', function () { id = null; b.classList.remove('is-down'); });
    })(k('item'));
    hold(k('cal'), function () { if (O && O.recentre && st.phase === 'drive') O.recentre(); steerer.recalibrate(); st.drag = 0; st.angle = 0; st.steer = 0; });
    k('set').addEventListener('click', toggleSheet);
    // drag the wheel (no tilt sensor / insecure page): horizontal drag turns it
    var box = k('wbox'), dragId = null, x0 = 0, a0 = 0;
    box.addEventListener('pointerdown', function (e) { if (st.sensor === 'tilt') return; dragId = e.pointerId; x0 = pt(box, e).x; a0 = st.drag; try { box.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } e.preventDefault(); });
    box.addEventListener('pointermove', function (e) { if (e.pointerId !== dragId) return; var p = pt(box, e); st.drag = clamp(a0 + (p.x - x0) / ((p.w || 1) * 0.5) * prefs.maxAngle, -prefs.maxAngle * 1.2, prefs.maxAngle * 1.2); });
    function dEnd(e) { if (e.pointerId !== dragId) return; dragId = null; st.drag = 0; }
    box.addEventListener('pointerup', dEnd); box.addEventListener('pointercancel', dEnd);
    root.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
    document.addEventListener('touchmove', function (e) { if (!(e.target && e.target.closest && e.target.closest('input,textarea,.pwp-sheet,.pwp-ov'))) e.preventDefault(); }, { passive: false });
  }
  function toggleSheet() {
    var root = $('#pw-wheel'), sh = root.querySelector('.pwp-sheet');
    if (sh) { sh.parentNode.removeChild(sh); return; }
    sh = document.createElement('div'); sh.className = 'pwp-sheet';
    sh.innerHTML = '<label>Full lock at <b data-v="max">' + prefs.maxAngle + '°</b> of turn<input type="range" min="15" max="180" step="1" value="' + prefs.maxAngle + '" data-p="maxAngle"></label>' +
      '<div class="row"><span>Wheel rotation</span><span class="pwp-seg">' + [35, 90, 180].map(function (a) { return '<button class="pwp-tbtn" type="button" data-rot="' + a + '">' + a + '°</button>'; }).join('') + '</span></div>' +
      '<label>Smoothing <b data-v="sm">' + Math.round(prefs.smoothing * 100) + '%</b><input type="range" min="0" max="1" step="0.05" value="' + prefs.smoothing + '" data-p="smoothing"></label>' +
      '<label>Dead zone <b data-v="dz">' + prefs.deadzone + '°</b><input type="range" min="0" max="6" step="0.5" value="' + prefs.deadzone + '" data-p="deadzone"></label>' +
      '<div class="row"><span>Invert steering</span><input type="checkbox" data-p="invert"' + (prefs.invert ? ' checked' : '') + '></div>' +
      '<div class="row"><span>Vibration</span><input type="checkbox" data-p="vib"' + (st.vib ? ' checked' : '') + '></div>' +
      '<div class="row" style="color:var(--text-dim)"><span>' + (st.via === 'manual' ? 'Invite pairing' : 'Code ' + esc(st.code || '') + (st.via === 'local' ? ' · same device' : '')) + '</span><span data-v="src"></span></div>' +
      '<button class="pwp-tbtn" type="button" data-p="close">Close</button>';
    sh.addEventListener('input', function (e) {
      var p = e.target.getAttribute('data-p'); if (!p) return;
      if (p === 'vib') { st.vib = e.target.checked; try { localStorage.setItem('forge.wheelVib', st.vib ? '1' : '0'); } catch (x) { /* ignore */ } return; }
      var o = {}; o[p] = p === 'invert' ? e.target.checked : +e.target.value;
      prefs = hub ? hub.setPrefs(o) : Object.assign(prefs, o);
      steerer.setPrefs(prefs);
      sh.querySelector('[data-v="max"]').textContent = prefs.maxAngle + '°';
      sh.querySelector('[data-v="sm"]').textContent = Math.round(prefs.smoothing * 100) + '%';
      sh.querySelector('[data-v="dz"]').textContent = prefs.deadzone + '°';
    });
    sh.querySelector('[data-p="close"]').addEventListener('click', toggleSheet);
    Array.prototype.forEach.call(sh.querySelectorAll('[data-rot]'), function (b) {
      b.addEventListener('click', function () {
        var r = sh.querySelector('[data-p="maxAngle"]'); r.value = b.getAttribute('data-rot');
        r.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
    root.appendChild(sh);
  }

  /* ---------------------------------------------------------------- frame loop */
  var lastUi = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    if (st.phase !== 'drive') return;
    var angle, steer;
    if (st.sensor === 'tilt') {
      if (now - (steerer.lastT || 0) > 40) { st.steer = steerer.refresh(now); st.angle = steerer.angle; }
      angle = st.angle; steer = st.steer;
    }
    else { angle = st.drag; steer = T.mapAngle(st.drag, prefs); }
    if (prefs.invert) steer = -steer;
    if (tx) { tx.set({ steer: steer, throttle: st.throttle, brake: st.brake, handbrake: st.handbrake, angle: angle }); if (tx.tick(now)) st.sent++; }
    var w = document.querySelector('#pw-wheel .pwp-wheel');
    if (w) w.style.transform = 'rotate(' + clamp(angle, -300, 300).toFixed(1) + 'deg)';
    if (now - lastUi > 200) { lastUi = now; ui(); }
  }
  function ui() {
    var root = $('#pw-wheel'); if (!root) return;
    function k(n) { return root.querySelector('[data-k="' + n + '"]'); }
    var rtt = tx && st.conn === 'ok' ? tx.rtt() : null;
    var mode = tx && st.conn === 'ok' && tx.mode ? tx.mode() : null;
    var txt = st.conn === 'ok' ? 'Connected (' + Wh.modeText(mode) + ') · ' + tx.delayText() : (st.connText || '…');
    if (st.error && st.conn === 'ok') txt += ' · drag to steer';
    k('conn').textContent = txt;
    root.querySelector('.pwp-dot').className = 'pwp-dot ' + (st.conn === 'ok' ? 'ok' : st.conn === 'bad' ? 'bad' : '');
    var s = st.status;
    k('game').textContent = s ? (s.driving ? (s.paused ? '· paused' : '· driving') : '· in menus') : '';
    var gs = k('gstate');
    var msg = st.conn === 'bad' ? (st.connText || '') : st.conn !== 'ok' ? '' : !s || !s.driving ? 'Start a race or drift on the computer' : s.paused ? 'Paused · ❚❚ to resume' : '';
    if (!msg && st.error) msg = st.error;
    gs.style.display = msg ? '' : 'none'; gs.textContent = msg;
    var ar = st.arcade, arcOn = !!(ar && ar.on && Date.now() - (st.arcadeT || 0) < 3000 && st.conn === 'ok');
    k('arc').className = 'pwp-arc' + (arcOn ? ' on' : '');
    if (arcOn) {
      var nb = k('nitro');
      nb.style.display = ar.nitroEnabled === false ? 'none' : '';
      nb.className = 'pwp-tbtn pwp-nitro' + (ar.nitro >= 0.99 ? ' full' : '') + (nb.classList.contains('is-down') ? ' is-down' : '');
      nb.style.background = 'linear-gradient(0deg,rgba(47,139,255,.6) ' + Math.round((ar.nitro || 0) * 100) + '%,rgba(20,70,200,.18) ' + Math.round((ar.nitro || 0) * 100) + '%)';
      k('item').textContent = ar.item === '?' ? '? ? ?' : ar.item ? ar.item.toUpperCase() + (ar.uses > 1 ? ' ×' + ar.uses : '') : 'ITEM';
    }
    if (st.tel) { k('spd').textContent = st.tel.spd; k('gear').textContent = st.tel.gear === 0 ? 'N' : st.tel.gear < 0 ? 'R' : st.tel.gear; }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
