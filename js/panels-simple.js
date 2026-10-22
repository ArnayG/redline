/* ==========================================================================
   REDLINE Garage — js/panels-simple.js
   CB.simpleGarage : the default "Simple" Garage. Six categories (Car, Engine & Power, Gearbox & Drive, Handling,
   Aero & Weight, Style), each with 1–4 friendly choices built on CB.tune levels. Every choice shows its effect
   (power, 0–100, top speed, grip, price) before it is applied and applies as ONE undo step; a build tuned in
   Advanced shows "Custom" (with the nearest level outlined). The full detail panels (CB.panels) stay untouched and
   are one click away (CB.app.setMode('advanced')).

   Panel defs follow the CB.panels contract used by js/app.js: { id, title, subtitle, icon, group, order,
   render(body, build, metrics), update(build, metrics, change) }. They are NOT registered in CB.panels (so the
   Advanced navigation, tests and tools that enumerate CB.panelList() see exactly the 12 detail sections).
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  var U = CB.util;
  var el = U && U.el;
  var T = function () { return CB.tune; };
  function ui() { return CB.ui || {}; }
  function icon(name) { return (ui().icons && ui().icons[name]) || ''; }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : (d === undefined ? 0 : d); }
  function fmt(v, d) { return v == null || !isFinite(v) ? '—' : U.fmtNum(v, d || 0); }

  /* ---------------------------------------------------------------- formatting deltas */
  var METRICS = {
    power: { label: 'Power', key: 'power_hp', unit: 'hp', d: 0, better: 1 },
    accel: { label: '0–100', key: 'zeroTo100_s', unit: 's', d: 1, better: -1 },
    top: { label: 'Top speed', key: 'topSpeed_kph', unit: 'km/h', d: 0, better: 1 },
    grip: { label: 'Grip', key: 'lateralG', unit: 'g', d: 2, better: 1 },
    handling: { label: 'Handling', key: 'handling', unit: 'handling', d: 0, better: 1 },
    weight: { label: 'Weight', key: 'weight_kg', unit: 'kg', d: 0, better: -1 },
    braking: { label: 'Braking 100–0', key: 'braking_m', unit: 'm', d: 1, better: -1 }
  };
  /** Key figure shown on each choice button, per system. */
  var KEY = { engine: ['power', 'accel'], gearbox: ['accel'], gearing: ['accel', 'top'], drive: ['accel', 'grip'], suspension: ['handling'],
    tyres: ['grip'], brakes: ['braking'], aero: ['grip', 'top'], weight: ['weight', 'accel'], finish: [], wheelStyle: [], cabin: ['weight'] };

  /** Fourth figure of the preview strip (the first three are power, 0–100 and top speed). */
  var COSMETIC = { finish: true, wheelStyle: true };   // looks only: no performance preview strip
  var FOURTH = { brakes: 'braking', weight: 'weight', cabin: 'weight', engine: 'weight' };
  function deltaText(m, v) {
    if (v == null || !isFinite(v)) return null;
    var eps = Math.pow(10, -m.d) / 2;
    if (Math.abs(v) < eps) return null;
    return (v > 0 ? '+' : '−') + U.fmtNum(Math.abs(v), m.d) + (m.unit ? ' ' + m.unit : '');
  }
  function deltaKind(m, v) { return v == null || Math.abs(v) < Math.pow(10, -m.d) / 2 ? 'same' : (v * m.better > 0 ? 'good' : 'bad'); }
  function priceNode(v) {
    var n = Math.round(num(v, 0) / 10) * 10;
    if (ui().price) { var c = ui().price(n, { zeroText: 'No cost' }); c.classList.add('st-price'); return c; }
    return el('span', { class: 'st-price' }, n ? (n > 0 ? '+' : '−') + U.fmtMoney(Math.abs(n)) : 'No cost');
  }

  /* ---------------------------------------------------------------- the preview strip */
  function previewStrip() {
    var root = el('div', { class: 'st-preview', 'aria-live': 'polite' });
    root.show = function (row, sysId) {
      U.clear(root);
      if (!row || !row.preview) return;
      var pv = row.preview, after = pv.after || {};
      root.appendChild(el('div', { class: 'st-preview-head' },
        el('span', { class: 'st-preview-title' }, row.selected ? 'Now: ' + row.name : 'With ' + row.name),
        row.selected ? null : priceNode(pv.price)));
      var grid = el('div', { class: 'st-preview-grid' });
      ['power', 'accel', 'top', FOURTH[sysId] || 'grip'].forEach(function (k) {
        var m = METRICS[k], v = pv[m.key], a = after[m.key];
        var dt = row.selected ? null : deltaText(m, v);
        grid.appendChild(el('div', { class: 'st-pv' },
          el('span', { class: 'st-pv-label' }, m.label),
          el('span', { class: 'st-pv-value' }, fmt(a, m.d), el('small', null, m.unit ? ' ' + m.unit : '')),
          dt ? el('span', { class: 'st-pv-delta is-' + deltaKind(m, v) }, dt) : null));
      });
      root.appendChild(grid);
      var h = num(after.handling, 0);
      root.appendChild(el('div', { class: 'st-bar', title: 'Handling rating ' + fmt(h) + ' / 100' },
        el('span', { class: 'st-bar-label' }, 'Handling'),
        el('span', { class: 'st-bar-track' }, el('span', { class: 'st-bar-fill', style: { width: Math.max(2, Math.min(100, h)) + '%' } })),
        el('span', { class: 'st-bar-num' }, fmt(h))));
      var notes = [];
      if (after.streetLegal === false) notes.push('Track only (not street legal)');
      if (row.fixes && row.fixes.length && !row.selected) notes.push('Also changes: ' + row.fixes.join(', '));
      if (row.reason && !row.selected) notes.push(row.reason);
      if (notes.length) root.appendChild(el('p', { class: 'st-preview-note' }, notes.join(' · ')));
    };
    return root;
  }

  /* ---------------------------------------------------------------- one system card */
  function systemCard(sysId) {
    var sys = T().system(sysId);
    var status = el('span', { class: 'st-status' });
    var levelsEl = el('div', { class: 'st-levels', role: 'radiogroup', 'aria-label': sys.title });
    var slider = null, sliderLabels = null;
    var pv = previewStrip();
    var avail = el('p', { class: 'st-unavailable', hidden: true });
    var root = el('section', { class: 'st-sys st-kind-' + (sys.kind || 'levels'), dataset: { tuneSys: sysId } },
      el('header', { class: 'st-sys-head' },
        el('div', { class: 'st-sys-titles' }, el('h3', { class: 'st-sys-title' }, sys.title), el('p', { class: 'st-sys-desc' }, sys.desc)),
        status),
      avail, levelsEl, pv);
    var rows = [], hoverId = null, btns = {};

    if (sys.kind === 'slider') {
      slider = el('input', { type: 'range', class: 'st-range', min: 0, max: sys.levels.length - 1, step: 1, 'aria-label': sys.title,
        'aria-valuetext': '' });
      sliderLabels = el('div', { class: 'st-range-ends', 'aria-hidden': 'true' }, el('span', null, '◀ Acceleration'), el('span', null, 'Top speed ▶'));
      var notches = el('div', { class: 'st-range-notches', 'aria-hidden': 'true' });
      sys.levels.forEach(function (l, i) {
        var n = el('button', { type: 'button', class: 'st-notch', tabindex: '-1', dataset: { level: l.id }, title: l.desc }, l.short || l.name);
        n.addEventListener('click', function () { pick(l.id); });
        n.addEventListener('mouseenter', function () { hover(l.id); });
        n.addEventListener('mouseleave', function () { hover(null); });
        btns[l.id] = n;
        notches.appendChild(n);
      });
      slider.addEventListener('input', function () { var l = sys.levels[Number(slider.value)]; if (l) { hover(l.id); pick(l.id, true); } });
      slider.addEventListener('change', function () { hover(null); });
      levelsEl.appendChild(el('div', { class: 'st-range-wrap' }, sliderLabels, slider, notches));
    }

    function hover(id) { hoverId = id; showPreview(); }
    function showPreview() {
      var r = null;
      rows.forEach(function (x) { if (x.id === hoverId) r = x; });
      if (!r) rows.forEach(function (x) { if (x.primary) r = x; });
      if (!r) rows.forEach(function (x) { if (x.nearest) r = x; });
      pv.show(r, sysId);
    }
    function pick(id, fromSlider) {
      var row = null;
      rows.forEach(function (x) { if (x.id === id) row = x; });
      if (!row || row.primary) return;
      if (row.lock) { if (ui().toast) ui().toast(row.lock.reason, 'warning'); return; }
      if (row.disabled) { if (ui().toast) ui().toast(row.reason || 'Not possible on this car', 'warning'); return; }
      var res = T().choose(sysId, id, { coalesce: !!fromSlider });
      if (res && res.fixes && res.fixes.length && ui().toast) {
        ui().toast(res.label + ' · also changed: ' + res.fixes.join(', '), 'info', { duration: 5000, action: { label: 'Undo', onClick: function () { CB.state.undo(); } } });
      }
    }

    function render(build) {
      var ok = T().available(sysId, build);
      avail.hidden = ok === true;
      avail.textContent = ok === true ? '' : ok;
      levelsEl.hidden = ok !== true;
      pv.hidden = ok !== true || COSMETIC[sysId];
      if (ok !== true) { status.textContent = ''; return; }
      rows = T().options(sysId, build);
      var det = T().detect(sysId, build);
      rows.forEach(function (r) {
        r.disabled = !r.selected && (!r.result || (r.result && U.equal(stripMeta(r.result.build), stripMeta(build))) || (!r.achieved && !r.fixes.length));
      });
      var cur = rows.filter(function (r) { return r.primary; })[0];
      status.textContent = cur ? cur.name : 'Custom';
      status.className = 'st-status' + (cur ? '' : ' is-custom');
      status.title = cur ? '' : 'Tuned in Advanced: matches no level' + (det.nearest ? ' (closest: ' + nameOf(det.nearest) + ')' : '');
      if (slider) {
        var idx = -1;
        sys.levels.forEach(function (l, i) { if (l.id === (cur ? cur.id : det.nearest)) idx = i; });
        if (document.activeElement !== slider && idx >= 0) slider.value = String(idx);
        slider.setAttribute('aria-valuetext', cur ? cur.name : 'Custom');
        slider.classList.toggle('is-custom', !cur);
        rows.forEach(function (r) {
          var n = btns[r.id]; if (!n) return;
          n.classList.toggle('is-active', !!r.primary);
          n.classList.toggle('is-nearest', !!r.nearest);
          n.classList.toggle('is-disabled', !!r.disabled || !!r.lock);
        });
      } else {
        U.clear(levelsEl);
        rows.forEach(function (r) { levelsEl.appendChild(levelButton(r)); });
        levelsEl.style.setProperty('--n', String(rows.length));
      }
      showPreview();
    }
    function nameOf(id) { var n = id; rows.forEach(function (r) { if (r.id === id) n = r.name; }); return n; }

    function levelButton(r) {
      var keys = KEY[sysId] || [];
      var bits = [];
      if (!r.selected && r.preview) keys.forEach(function (k) {
        var m = METRICS[k], t = deltaText(m, r.preview[m.key]);
        if (t) bits.push(el('span', { class: 'st-lv-delta is-' + deltaKind(m, r.preview[m.key]) }, t));
      });
      var tags = [];
      if (r.factory && r.id !== 'factory' && r.id !== 'stock' && r.id !== 'standard') tags.push(el('span', { class: 'st-tag' }, 'Factory'));
      if (r.streetLegal === false) tags.push(el('span', { class: 'st-tag is-track' }, 'Track'));
      var b = el('button', {
        type: 'button', class: 'st-lv' + (r.primary ? ' is-active' : '') + (r.selected && !r.primary ? ' is-also' : '') + (r.nearest ? ' is-nearest' : '') +
          (r.disabled ? ' is-disabled' : '') + (r.lock ? ' is-locked' : ''),
        role: 'radio', 'aria-checked': r.primary ? 'true' : 'false', 'aria-disabled': r.disabled || r.lock ? 'true' : 'false',
        title: r.lock ? r.lock.reason : (r.disabled && r.reason ? r.reason : r.desc), dataset: { level: r.id }
      },
        el('span', { class: 'st-lv-top' }, el('span', { class: 'st-lv-name' }, r.name), tags),
        el('span', { class: 'st-lv-desc' }, r.desc),
        el('span', { class: 'st-lv-foot' },
          bits.length ? el('span', { class: 'st-lv-deltas' }, bits) : el('span', { class: 'st-lv-deltas is-empty' }, r.primary ? 'Selected' : ''),
          r.lock ? el('span', { class: 'st-lock', html: icon('lock') + '<span>' + (r.lock.level ? 'Level ' + r.lock.level : 'Locked') + '</span>' })
            : (!r.selected && r.preview ? priceNode(r.preview.price) : null)));
      b.addEventListener('click', function () { pick(r.id); });
      b.addEventListener('mouseenter', function () { hover(r.id); });
      b.addEventListener('mouseleave', function () { hover(null); });
      b.addEventListener('focus', function () { hover(r.id); });
      b.addEventListener('blur', function () { hover(null); });
      b.addEventListener('keydown', function (ev) {
        var dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
        if (!dir) return;
        ev.preventDefault();
        var all = Array.prototype.slice.call(levelsEl.querySelectorAll('.st-lv')), i = all.indexOf(b);
        var nx = all[(i + dir + all.length) % all.length];
        if (nx) nx.focus();
      });
      return b;
    }
    root.render = render;
    return root;
  }
  function stripMeta(b) { var c = Object.assign({}, b); delete c.meta; return c; }

  /* ---------------------------------------------------------------- Car category: model picker + factory spec */
  function carSection() {
    var S = CB.shapes, St = CB.state;
    var titleEl = el('div', { class: 'st-car-title' });
    var figs = el('div', { class: 'st-car-figs' });
    var stockBadge = el('span', { class: 'st-status' });
    var sel = el('select', { class: 'cb-input st-select', 'aria-label': 'Choose a car' });
    var styles = (CB.data && CB.data.bodyStyles) || [];
    var models = S && S.models ? Object.keys(S.models).map(function (k) { return S.models[k]; }) : [];
    styles.forEach(function (st) {
      var list = models.filter(function (m) { return m.style === st.id; })
        .sort(function (a, b) { return ((a.make || '') + a.name).localeCompare((b.make || '') + b.name); });
      if (!list.length) return;
      var g = el('optgroup', { label: st.name });
      list.forEach(function (m) { g.appendChild(el('option', { value: m.id }, (m.make ? m.make + ' ' : '') + m.name)); });
      sel.appendChild(g);
    });
    sel.addEventListener('change', function () {
      var id = sel.value;
      if (CB.stock && CB.stock.has && CB.stock.has(id)) { CB.stock.run({ model: id }); }
      else if (St.applyModel) St.applyModel(id);
    });
    var resetBtn = el('button', { type: 'button', class: 'cb-btn st-btn', title: 'Put every part back to how the factory built this car (one undo step)' }, 'Back to factory spec');
    resetBtn.addEventListener('click', function () { if (CB.stock && CB.stock.run) CB.stock.run(); });
    var root = el('section', { class: 'st-sys st-car', dataset: { tuneSys: 'car' } },
      el('header', { class: 'st-sys-head' },
        el('div', { class: 'st-sys-titles' }, el('h3', { class: 'st-sys-title' }, 'Your car'), el('p', { class: 'st-sys-desc' }, 'Pick a real car. It starts exactly as the factory built it; then tune it in the next steps.')),
        stockBadge),
      el('label', { class: 'st-field' }, el('span', { class: 'st-field-label' }, 'Car'), sel),
      titleEl, figs,
      el('div', { class: 'st-actions' }, resetBtn));
    root.render = function (build) {
      var m = St.modelOf ? St.modelOf(build) : null;
      if (m && document.activeElement !== sel) sel.value = m.id;
      var has = !!(m && CB.stock && CB.stock.has && CB.stock.has(m.id));
      var stock = has && CB.stock.isStock(build);
      titleEl.textContent = has ? CB.stock.title(m.id) : m ? ((m.make ? m.make + ' ' : '') + m.name) : '';
      stockBadge.textContent = stock ? 'Factory spec' : 'Modified';
      stockBadge.className = 'st-status' + (stock ? '' : ' is-custom');
      resetBtn.disabled = !has || stock;
      U.clear(figs);
      var sp = has && CB.stock.spec(m.id);
      if (sp) {
        [['Factory power', fmt(sp.hp) + ' hp'], ['0–100 km/h', fmt(sp.s, 1) + ' s'], ['Top speed', fmt(sp.v) + ' km/h'], ['Weight', fmt(sp.kg) + ' kg']].forEach(function (kv) {
          figs.appendChild(el('div', { class: 'st-pv' }, el('span', { class: 'st-pv-label' }, kv[0]), el('span', { class: 'st-pv-value' }, kv[1])));
        });
      }
    };
    return root;
  }

  /* ---------------------------------------------------------------- Style: paint colour */
  var PAINT = ['#d40000', '#c8102e', '#ff6a13', '#f2c200', '#2e7d32', '#1f5aa6', '#0b2a5b', '#6a1b9a', '#ffffff', '#c0c4c8', '#55595e', '#0d0d0f'];
  function paintSection() {
    var sw = ((CB.data && CB.data.paintSwatches) || []).slice();
    var pick = [];
    PAINT.forEach(function (hex) {
      var s = sw.filter(function (x) { return x.hex.toLowerCase() === hex; })[0];
      pick.push(s || { name: (CB.data && CB.data.swatchName && CB.data.swatchName(hex)) || hex, hex: hex });
    });
    var c = ui().color ? ui().color({ path: 'exterior.paint', label: 'Colour', swatches: pick, allowCustom: true }) : el('div');
    var root = el('section', { class: 'st-sys st-paint', dataset: { tuneSys: 'paint' } },
      el('header', { class: 'st-sys-head' }, el('div', { class: 'st-sys-titles' }, el('h3', { class: 'st-sys-title' }, 'Paint colour'), el('p', { class: 'st-sys-desc' }, 'Tap a colour, or choose any custom shade.'))),
      c);
    root.render = function () { /* ui.color syncs itself (CB.ui auto-sync) */ };
    return root;
  }

  /* ---------------------------------------------------------------- category panels */
  function advancedLink(cat) {
    var names = cat.sections.map(function (id) { return CB.panels && CB.panels[id] ? CB.panels[id].title : id; });
    var b = el('button', { type: 'button', class: 'cb-btn ghost st-adv-link', title: 'Every detailed setting of ' + names.join(', ') },
      el('span', null, 'More detail: ' + names.join(', ')), el('span', { 'aria-hidden': 'true' }, ' →'));
    b.addEventListener('click', function () { if (CB.app && CB.app.setMode) CB.app.setMode('advanced', { panel: cat.sections[0] }); });
    return el('div', { class: 'st-foot' }, b);
  }

  function makePanel(cat, order) {
    return {
      id: cat.id, title: cat.title, short: cat.short, subtitle: cat.desc, icon: icon(cat.icon) || null, group: 'Tune', order: order, simple: true,
      sections: cat.sections.slice(),
      render: function (body, build) {
        var parts = [];
        if (cat.id === 'car') parts.push(carSection());
        if (cat.id === 'style') parts.push(paintSection());
        cat.systems.forEach(function (id) { parts.push(systemCard(id)); });
        this._parts = parts;
        var wrap = el('div', { class: 'st-cat st-cat-' + cat.id });
        parts.forEach(function (p) { wrap.appendChild(p); });
        body.appendChild(wrap);
        body.appendChild(advancedLink(cat));
        parts.forEach(function (p) { if (p.render) p.render(build); });
      },
      update: function (build) {
        (this._parts || []).forEach(function (p) { if (p.render) p.render(build); });
      },
      destroy: function () { this._parts = null; }
    };
  }

  var defs = null;
  function panels() {
    if (!T()) return [];
    if (!defs) defs = T().CATEGORIES.map(function (c, i) { return makePanel(c, (i + 1) * 10); });
    return defs;
  }
  function panel(id) { var p = null; panels().forEach(function (d) { if (d.id === id) p = d; }); return p; }

  CB.simpleGarage = { panels: panels, panel: panel, categoryOf: function (id) { return T() ? T().categoryOf(id) : null; } };
})();

if (typeof module !== 'undefined') module.exports = CB.simpleGarage;
