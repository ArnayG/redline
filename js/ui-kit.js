/* ==========================================================================
   FORGE Atelier — js/ui-kit.js
   CB.ui : form-control factories, issues list, toasts, modals, tabs + the panel registry.

   ─────────────────────────────── SYNC STRATEGY (read me, panel authors) ───────────────────────────────
   1. Every bound control is a DOM element carrying:
        el.dataset.cbPath = '<build path>'   (attribute data-cb-path; '*' for whole-build widgets like issues())
        el.sync(build)                       idempotent: updates the existing DOM in place, never rebuilds it
   2. CB.ui.syncAll(rootEl, build) calls .sync(build) on every bound control inside rootEl
      (including rootEl itself). It does NOT recreate DOM, so a slider being dragged keeps its pointer capture
      and focus; text inputs that currently have focus are not overwritten mid-typing.
   3. AUTO-SYNC: ui-kit subscribes once to CB.state and runs syncAll(document.body, build) on every change.
      Controls therefore stay in sync automatically even when a panel does nothing.
   4. Panels SHOULD implement update(build, metrics, change) instead of relying on a full re-render (app.js
      re-renders panels that lack update(), which would destroy a slider mid-drag). A typical update():
          update: function (build, metrics) { CB.ui.syncAll(this._root, build); statEl.set(metrics.power_hp); }
      Only rebuild DOM yourself for structural changes (e.g. gear-count change adds/removes ratio sliders);
      use change.path to decide: if (change.path === 'transmission.gears' || change.path === '*') rebuild part.
   5. Controls never mutate the build: they call CB.state.set(path, value). Any control option may supply
        get(build) -> value         custom reader (default CB.util.get(build, path))
        set(value)                  custom writer (default CB.state.set(path, value, {label}))
        disabled: bool | fn(build) -> bool|string   (string = reason shown as tooltip)
        visible:  fn(build) -> bool (hidden via [hidden] when false)
        onChange(value)             side-effect hook after writing
   6. Custom widgets can join the system with CB.ui.bind(el, path, function sync(build){...}).
   ─────────────────────────────────────────────────────────────────────────────────────────────────────

   Factories: section, group, grid, slider, select, cards, segmented, toggle, color, number, text, stat, kv,
              issues, price, badge, button, chart, tabs, toast, modal, confirm, icon, bind, syncAll
   Registry:  CB.registerPanel(def), CB.panels (by id), CB.panelList() (sorted), CB.ui.panelGroups
   ========================================================================== */
var CB = (globalThis.CB = globalThis.CB || {});
if (typeof window !== 'undefined') window.CB = CB;

(function () {
  'use strict';

  var U = CB.util;
  var hasDOM = typeof document !== 'undefined';
  var el = U.el;

  /* ---------------------------------------------------------------- icons (svg strings) */
  function svgIcon(body, vb) {
    return '<svg viewBox="' + (vb || '0 0 24 24') + '" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }
  var icons = {
    body: svgIcon('<path d="M3 15l2-5c.4-1 1.3-1.6 2.4-1.6h7.4c1 0 1.9.5 2.4 1.3L20 13l1.2.6c.5.3.8.8.8 1.4V17h-2"/><path d="M3 17H2v-2l1-0.5"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M9 17h6"/>'),
    engine: svgIcon('<path d="M4 10h2V8h4V6h4v2h3l2 2h2v6h-2l-2 2h-6l-2-2H6v-2H4z"/><path d="M10 6V4h4v2"/><path d="M1 11v4"/>'),
    transmission: svgIcon('<circle cx="5" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><path d="M5 7v12M12 7v12M19 7v5H5"/>'),
    drivetrain: svgIcon('<rect x="2" y="4" width="4" height="6" rx="1"/><rect x="18" y="4" width="4" height="6" rx="1"/><rect x="2" y="14" width="4" height="6" rx="1"/><rect x="18" y="14" width="4" height="6" rx="1"/><path d="M6 7h12M6 17h12M12 7v10"/><circle cx="12" cy="17" r="2"/>'),
    suspension: svgIcon('<path d="M12 2v3"/><path d="M8 5h8"/><path d="M9 7l6 2-6 2 6 2-6 2 6 2"/><path d="M8 19h8"/><path d="M12 19v3"/>'),
    brakes: svgIcon('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M16 4.5a9 9 0 0 1 3.5 5" stroke-width="3"/>'),
    wheels: svgIcon('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/><path d="M12 3v6.8M12 14.2V21M3 12h6.8M14.2 12H21M5.6 5.6l4.8 4.8M13.6 13.6l4.8 4.8M18.4 5.6l-4.8 4.8M10.4 13.6l-4.8 4.8"/>'),
    aero: svgIcon('<path d="M2 15h14l5-5"/><path d="M16 15l3 3"/><path d="M3 9c3-1 6-1 9 0s6 1 9 0"/><path d="M3 5c3-1 6-1 9 0"/>'),
    weight: svgIcon('<path d="M6 8h12l2 12H4z"/><circle cx="12" cy="5" r="2"/><path d="M10 14h4"/>'),
    exterior: svgIcon('<path d="M12 3c-4.5 0-8 3.2-8 7.4 0 2.6 2 4.1 4 4.1h1.3c.9 0 1.5.7 1.5 1.5 0 1.9 1 3 2.5 3C17.5 19 20 15 20 10.6 20 6.3 16.5 3 12 3z"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="10" r="1"/>'),
    interior: svgIcon('<path d="M7 3h4l1 8H8z"/><path d="M8 11h6l2 6H6z"/><path d="M7 17l-1 4M15 17l1 4"/>'),
    tech: svgIcon('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M7 12l3-3 2 2 4-4"/>'),
    check: svgIcon('<path d="M5 12l5 5L20 7"/>'),
    warn: svgIcon('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>'),
    error: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'),
    info: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
    close: svgIcon('<path d="M6 6l12 12M18 6L6 18"/>'),
    minus: svgIcon('<path d="M5 12h14"/>'),
    plus: svgIcon('<path d="M12 5v14M5 12h14"/>'),
    undo: svgIcon('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
    redo: svgIcon('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>'),
    reset: svgIcon('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
    spark: svgIcon('<path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z"/>'),
    lock: svgIcon('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>')
  };

  /* ---------------------------------------------------------------- binding registry */
  function evalMaybe(v, build) { return typeof v === 'function' ? v(build) : v; }

  /**
   * bind(el, path, syncFn, opts) — register a custom element in the sync system.
   * Applies common opts (disabled/visible) before calling syncFn(build).
   */
  function bind(node, path, syncFn, opts) {
    opts = opts || {};
    node.dataset.cbPath = path || '*';
    node.classList.add('cb-bound');
    node.sync = function (build) {
      build = build || (CB.state && CB.state.get());
      if (!build) return;
      if (opts.visible) node.hidden = !opts.visible(build);
      var dis = evalMaybe(opts.disabled, build);
      if (opts.disabled !== undefined) {
        node.classList.toggle('is-disabled', !!dis);
        node.setAttribute('aria-disabled', dis ? 'true' : 'false');
        if (typeof dis === 'string') node.title = dis; else if (node.dataset.cbReason) node.removeAttribute('title');
        if (typeof dis === 'string') node.dataset.cbReason = '1'; else delete node.dataset.cbReason;
        var inputs = node.querySelectorAll('input,select,button,textarea');
        for (var i = 0; i < inputs.length; i++) inputs[i].disabled = !!dis;
      }
      try { syncFn(build); } catch (err) { if (typeof console !== 'undefined') console.error('[CB.ui] sync failed for', path, err); }
    };
    node.sync(CB.state && CB.state.get());
    ensureAutoSync();
    return node;
  }

  function syncAll(root, build) {
    if (!hasDOM) return;
    root = root || document.body;
    build = build || (CB.state && CB.state.get());
    if (!root || !build) return;
    if (root.sync && root.dataset && root.dataset.cbPath) root.sync(build);
    var nodes = root.querySelectorAll('[data-cb-path]');
    for (var i = 0; i < nodes.length; i++) if (typeof nodes[i].sync === 'function') nodes[i].sync(build);
  }

  var autoSyncOn = false;
  function ensureAutoSync() {
    if (autoSyncOn || !CB.state || !CB.state.subscribe || !hasDOM) return;
    autoSyncOn = true;
    CB.state.subscribe(function (build) {
      if (CB.ui.autoSync === false) return;
      issueCache = { build: null, list: [] };
      syncAll(document.body, build);
    });
  }

  function readVal(opts, build) {
    return opts.get ? opts.get(build) : U.get(build, opts.path);
  }
  function writeVal(opts, value, label) {
    if (opts.set) opts.set(value);
    else if (CB.state) CB.state.set(opts.path, value, { label: label });
    if (opts.onChange) opts.onChange(value);
  }
  function labelText(opts) { return opts.label || ''; }

  function hintNode(hint) { return hint ? el('div', { class: 'cb-hint' }, hint) : null; }

  function decimalsOf(step) { var s = String(step || 1); return s.indexOf('.') >= 0 ? s.split('.')[1].length : 0; }

  /* ---------------------------------------------------------------- price chip */
  function price(amount, opts) {
    opts = opts || {};
    var n = Number(amount) || 0;
    var chip = el('span', { class: 'cb-price' });
    setPrice(chip, n, opts);
    chip.set = function (v) { setPrice(chip, Number(v) || 0, opts); };
    return chip;
  }
  function priceText(n, opts) {
    opts = opts || {};
    if (n === 0) return opts.zeroText || 'Included';
    var cur = currencyHook();
    if (cur) {
      var t = null;
      try { t = cur.format(n, opts); } catch (e) { t = null; }
      if (typeof t === 'string') return t;
    }
    var abs = U.fmtMoney(Math.abs(n));
    return (n > 0 ? '+' : '–') + abs;
  }

  /* ---------------------------------------------------------------- career hooks
     Set by CB.app.openAtelier in career modes (cleared again afterwards):
       CB.ui.currency   = { format(amountUSD, opts) -> string }   catalog prices shown as career credits
       CB.ui.lockOption = function (path, id, build) -> false | { level, reason, name? }
     Locked options are greyed with a lock badge; the currently selected value stays selectable so the
     player can see what to swap (the atelier banner lists violations and gates Confirm). */
  function currencyHook() {
    var c = CB.ui && CB.ui.currency;
    return c && typeof c.format === 'function' ? c : null;
  }
  function lockFor(path, id, build) {
    var f = CB.ui && CB.ui.lockOption;
    if (typeof f !== 'function' || !path || path === '*') return null;
    var r = null;
    try { r = f(path, id, build); } catch (e) { r = null; }
    if (!r) return null;
    if (typeof r === 'string') r = { reason: r };
    if (!r.reason) r.reason = 'Locked' + (r.level ? ' · unlocks at level ' + r.level : '');
    return r;
  }
  function lockBadge(lock) {
    return el('span', { class: 'cb-lock-badge', title: lock.reason, html: icons.lock + '<span>' + (lock.level ? 'L' + lock.level : 'Locked') + '</span>' });
  }
  /** Adds / removes the lock decoration on an option element. */
  function decorateLock(node, lock, anchor) {
    var has = node._lockBadge;
    node.classList.toggle('is-locked', !!lock);
    if (lock) {
      if (!has) { node._lockBadge = lockBadge(lock); (anchor || node).appendChild(node._lockBadge); }
      else { has.title = lock.reason; has.lastChild.textContent = lock.level ? 'L' + lock.level : 'Locked'; }
    } else if (has) {
      if (has.parentNode) has.parentNode.removeChild(has);
      node._lockBadge = null;
    }
  }
  function setPrice(chip, n, opts) {
    chip.textContent = priceText(n, opts);
    chip.classList.toggle('is-included', n === 0);
    chip.classList.toggle('is-credit', n < 0);
    chip.classList.toggle('is-cost', n > 0);
  }

  /* ---------------------------------------------------------------- layout */
  function section(title, subtitle) {
    var children = Array.prototype.slice.call(arguments, 2);
    if (subtitle && typeof subtitle === 'object') { children.unshift(subtitle); subtitle = null; }
    var head = el('header', { class: 'cb-section-head' },
      el('h3', { class: 'cb-section-title' }, title),
      subtitle ? el('p', { class: 'cb-hint' }, subtitle) : null);
    return el('section', { class: 'cb-section' }, head, el('div', { class: 'cb-section-body' }, children));
  }

  function group(label) {
    var children = Array.prototype.slice.call(arguments, 1);
    return el('div', { class: 'cb-group' }, label ? el('div', { class: 'cb-label cb-group-label' }, label) : null, children);
  }

  function grid(cols) {
    var children = Array.prototype.slice.call(arguments, 1);
    return el('div', { class: 'cb-grid-' + (cols === 3 ? 3 : 2) }, children);
  }

  function badge(text, kind) { return el('span', { class: 'cb-badge' + (kind ? ' is-' + kind : '') }, text); }

  function button(label, opts) {
    opts = opts || {};
    var b = el('button', {
      type: 'button', class: 'cb-btn' + (opts.kind ? ' ' + opts.kind : ''), title: opts.title,
      'aria-label': opts.ariaLabel, disabled: opts.disabled
    }, opts.icon ? U.htmlToNode(opts.icon) : null, label ? el('span', null, label) : null);
    if (opts.onClick) b.addEventListener('click', opts.onClick);
    return b;
  }

  function icon(name) { return U.htmlToNode(icons[name] || name); }

  /* ---------------------------------------------------------------- slider */
  /**
   * slider({path, label, min, max, step, unit, format?(v), hint?, ticks?:number[]|[{value,label}], decimals?,
   *         defaultValue?, get?, set?, disabled?, visible?, onChange?, marks?:[{value,label,kind}] })
   * Keyboard: arrows = step, Shift+arrows / PageUp/PageDown = 10 steps, Home/End = min/max.
   * Double-click the track (or click the reset icon) to restore the factory default for this path.
   * Click the value readout to type an exact number.
   */
  function slider(opts) {
    var min = Number(opts.min), max = Number(opts.max), step = Number(opts.step) || 1;
    var dec = opts.decimals != null ? opts.decimals : decimalsOf(step);
    var fmt = opts.format || function (v) { return U.fmtNum(v, dec) + (opts.unit ? ' ' + opts.unit : ''); };
    var id = U.uid('sl');
    var input = el('input', { type: 'range', id: id, min: min, max: max, step: step, class: 'cb-range', 'aria-label': labelText(opts) });
    var valueBtn = el('button', { type: 'button', class: 'cb-slider-value', title: 'Click to type a value' });
    var valueEdit = el('input', { type: 'number', class: 'cb-slider-edit', min: min, max: max, step: step, hidden: true, 'aria-label': labelText(opts) + ' exact value' });
    var ticksEl = el('div', { class: 'cb-slider-ticks', 'aria-hidden': 'true' });
    var tickList = opts.ticks === false ? [] : (opts.ticks || [min, max]).map(function (t) { return typeof t === 'object' ? t : { value: t, label: fmtTick(t) }; });
    function fmtTick(v) { return opts.formatTick ? opts.formatTick(v) : U.fmtNum(v, dec); }
    tickList.forEach(function (t) {
      var pct = max === min ? 0 : ((t.value - min) / (max - min)) * 100;
      ticksEl.appendChild(el('span', { class: 'cb-tick', style: { left: pct + '%' } }, t.label));
    });
    var marksEl = null;
    if (opts.marks && opts.marks.length) {
      marksEl = el('div', { class: 'cb-slider-marks', 'aria-hidden': 'true' });
      opts.marks.forEach(function (mk) {
        var pct = ((mk.value - min) / (max - min)) * 100;
        marksEl.appendChild(el('span', { class: 'cb-mark' + (mk.kind ? ' is-' + mk.kind : ''), style: { left: pct + '%' }, title: mk.label || '' }));
      });
    }
    var resetBtn = el('button', { type: 'button', class: 'cb-slider-reset cb-btn ghost', title: 'Reset to default', 'aria-label': 'Reset ' + labelText(opts) + ' to default', html: icons.reset });

    var root = el('div', { class: 'cb-slider' },
      el('div', { class: 'cb-slider-head' },
        el('label', { class: 'cb-label', for: id }, opts.label),
        el('div', { class: 'cb-slider-readout' }, valueBtn, valueEdit, opts.resettable === false ? null : resetBtn)),
      el('div', { class: 'cb-slider-track' }, input, marksEl),
      ticksEl,
      hintNode(opts.hint));

    function clampV(v) { return U.clamp(U.snap(Number(v), step, min % step === 0 ? 0 : min), min, max); }
    function paint(v) {
      var pct = max === min ? 0 : ((v - min) / (max - min)) * 100;
      root.style.setProperty('--pct', pct + '%');
      valueBtn.textContent = fmt(v);
      input.setAttribute('aria-valuetext', fmt(v));
    }
    var dragging = false;
    input.addEventListener('pointerdown', function () { dragging = true; root.classList.add('is-dragging'); });
    function endDrag() { dragging = false; root.classList.remove('is-dragging'); }
    input.addEventListener('pointerup', endDrag);
    input.addEventListener('pointercancel', endDrag);
    input.addEventListener('blur', endDrag);
    input.addEventListener('input', function () {
      var v = clampV(input.value);
      paint(v);
      writeVal(opts, v);
    });
    input.addEventListener('keydown', function (ev) {
      var cur = Number(input.value), big = step * 10, nv = null;
      if ((ev.key === 'ArrowUp' || ev.key === 'ArrowRight') && ev.shiftKey) nv = cur + big;
      else if ((ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') && ev.shiftKey) nv = cur - big;
      else if (ev.key === 'PageUp') nv = cur + big;
      else if (ev.key === 'PageDown') nv = cur - big;
      if (nv !== null) {
        ev.preventDefault();
        nv = clampV(nv); input.value = nv; paint(nv); writeVal(opts, nv);
      }
    });
    function defaultValue() {
      if (opts.defaultValue != null) return opts.defaultValue;
      try { return U.get(CB.data.defaultBuild(), opts.path); } catch (e) { return undefined; }
    }
    function resetToDefault() {
      var dv = defaultValue();
      if (typeof dv !== 'number') return;
      dv = clampV(dv); input.value = dv; paint(dv); writeVal(opts, dv);
    }
    input.addEventListener('dblclick', resetToDefault);
    resetBtn.addEventListener('click', resetToDefault);

    valueBtn.addEventListener('click', function () {
      valueEdit.hidden = false; valueBtn.hidden = true;
      valueEdit.value = input.value; valueEdit.focus(); valueEdit.select();
    });
    function commitEdit(apply) {
      if (valueEdit.hidden) return;
      if (apply && valueEdit.value !== '' && isFinite(Number(valueEdit.value))) {
        var v = clampV(valueEdit.value); input.value = v; paint(v); writeVal(opts, v);
      }
      valueEdit.hidden = true; valueBtn.hidden = false;
    }
    valueEdit.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commitEdit(true); input.focus(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); commitEdit(false); }
    });
    valueEdit.addEventListener('blur', function () { commitEdit(true); });

    root.input = input;
    root.setRange = function (nmin, nmax) {
      min = nmin; max = nmax; input.min = nmin; input.max = nmax; valueEdit.min = nmin; valueEdit.max = nmax;
      var t = ticksEl.querySelectorAll('.cb-tick');
      if (t.length === 2 && !opts.ticks) { t[0].textContent = fmtTick(nmin); t[1].textContent = fmtTick(nmax); }
    };
    return bind(root, opts.path, function (build) {
      if (opts.range) { var r = opts.range(build); if (r && (r[0] !== min || r[1] !== max)) root.setRange(r[0], r[1]); }
      var v = Number(readVal(opts, build));
      if (!isFinite(v)) v = min;
      if (!dragging || Math.abs(Number(input.value) - v) > step / 2) input.value = v;
      paint(v);
      var dv = defaultValue();
      resetBtn.hidden = typeof dv !== 'number' || Math.abs(dv - v) < step / 2;
    }, opts);
  }

  /* ---------------------------------------------------------------- select */
  function select(opts) {
    var id = U.uid('sel');
    var sel = el('select', { id: id, class: 'cb-select-input' });
    function optLabel(o, lock) {
      var p = o.price != null && o.price !== 0 ? '  (' + priceText(o.price) + ')' : '';
      return o.name + p + (lock ? '  · locked' + (lock.level ? ' L' + lock.level : '') : '');
    }
    var lastSig = '';
    function lockSig(list, build) {
      if (typeof (CB.ui && CB.ui.lockOption) !== 'function' && !currencyHook()) return '';
      return (currencyHook() ? 'c' : '') + list.map(function (o) { var l = lockFor(opts.path, o.id, build); return l ? (l.level || 1) : 0; }).join(',');
    }
    function fill(list, build) {
      U.clear(sel);
      var v = build ? String(readVal(opts, build)) : null;
      list.forEach(function (o) {
        var lock = build ? lockFor(opts.path, o.id, build) : null;
        var node = el('option', { value: String(o.id), disabled: !!o.disabled || (!!lock && String(o.id) !== v) }, optLabel(o, lock));
        if (lock) { node.title = lock.reason; node.className = 'is-locked'; }
        sel.appendChild(node);
      });
      lastSig = build ? lockSig(list, build) : '';
    }
    var current = typeof opts.options === 'function' ? null : opts.options;
    if (current) fill(current);
    var root = el('div', { class: 'cb-select' },
      opts.label ? el('label', { class: 'cb-label', for: id }, opts.label) : null,
      el('div', { class: 'cb-select-wrap' }, sel),
      hintNode(opts.hint));
    sel.addEventListener('change', function () {
      var list = current || [];
      var match = null;
      for (var i = 0; i < list.length; i++) if (String(list[i].id) === sel.value) match = list[i];
      writeVal(opts, match ? match.id : sel.value, (opts.label ? opts.label + ': ' : '') + (match ? match.name : sel.value));
    });
    root.select = sel;
    return bind(root, opts.path, function (build) {
      if (typeof opts.options === 'function') {
        var list = opts.options(build);
        if (!current || JSON.stringify(list.map(function (o) { return [o.id, o.name, o.price, o.disabled]; })) !==
          JSON.stringify(current.map(function (o) { return [o.id, o.name, o.price, o.disabled]; }))) { current = list; fill(list, build); }
      }
      if (current && lockSig(current, build) !== lastSig) fill(current, build);
      var lockedNow = current ? lockFor(opts.path, readVal(opts, build), build) : null;
      root.classList.toggle('is-locked', !!lockedNow);
      var v = readVal(opts, build);
      if (document.activeElement !== sel || sel.value !== String(v)) sel.value = String(v);
    }, opts);
  }

  /* ---------------------------------------------------------------- cards */
  /**
   * cards({path, label, options:[{id,name,desc,price,badge?,icon?,specs?:[[k,v]],swatch?:hex,disabled?}], columns?,
   *        priceMode?: 'absolute'|'relative', optionDisabled?(option, build) -> false|string, compact?})
   * Rendered as an ARIA radiogroup; arrow keys move the selection.
   */
  function cards(opts) {
    var list = el('div', { class: 'cb-cards-list', role: 'radiogroup', 'aria-label': labelText(opts) });
    var root = el('div', { class: 'cb-cards' + (opts.compact ? ' is-compact' : ''), style: { '--cols': opts.columns || 3 } },
      opts.label ? el('div', { class: 'cb-label' }, opts.label) : null, list, hintNode(opts.hint));
    var cardEls = [];
    var options = opts.options || [];

    options.forEach(function (o, idx) {
      var chip = price(o.price || 0);
      chip.classList.add('cb-card-price');
      var specs = null;
      if (o.specs && o.specs.length) {
        specs = el('dl', { class: 'cb-card-specs' });
        o.specs.forEach(function (kv) { specs.appendChild(el('div', null, el('dt', null, kv[0]), el('dd', null, kv[1]))); });
      }
      var card = el('button', { type: 'button', class: 'cb-card', role: 'radio', 'aria-checked': 'false', tabindex: '-1', dataset: { id: String(o.id) } },
        o.icon ? el('span', { class: 'cb-card-icon', html: o.icon }) : null,
        o.swatch ? el('span', { class: 'cb-card-swatch', style: { background: o.swatch } }) : null,
        el('span', { class: 'cb-card-body' },
          el('span', { class: 'cb-card-top' },
            el('span', { class: 'cb-card-name' }, o.name),
            o.badge ? el('span', { class: 'cb-card-badge' }, o.badge) : null),
          o.desc ? el('span', { class: 'cb-card-desc' }, o.desc) : null,
          specs),
        el('span', { class: 'cb-card-foot' }, chip, el('span', { class: 'cb-card-check', html: icons.check })));
      card._chip = chip;
      card._option = o;
      card.addEventListener('click', function () {
        if (card.classList.contains('is-disabled')) {
          if (card.title && CB.ui.toast) CB.ui.toast(card.title, 'warning');
          return;
        }
        writeVal(opts, o.id, (opts.label ? opts.label + ': ' : '') + o.name);
      });
      card.addEventListener('keydown', function (ev) {
        var dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
        if (!dir) return;
        ev.preventDefault();
        var n = cardEls.length, j = idx;
        for (var k = 0; k < n; k++) {
          j = (j + dir + n) % n;
          if (!cardEls[j].classList.contains('is-disabled')) break;
        }
        cardEls[j].focus();
        cardEls[j].click();
      });
      cardEls.push(card);
      list.appendChild(card);
    });

    return bind(root, opts.path, function (build) {
      var v = readVal(opts, build);
      var selected = null;
      cardEls.forEach(function (c) { if (String(c._option.id) === String(v)) selected = c._option; });
      cardEls.forEach(function (c) {
        var o = c._option;
        var on = String(o.id) === String(v);
        c.classList.toggle('is-selected', on);
        c.setAttribute('aria-checked', on ? 'true' : 'false');
        c.tabIndex = on ? 0 : -1;
        var lock = lockFor(opts.path, o.id, build);
        var reason = o.disabled || (opts.optionDisabled ? opts.optionDisabled(o, build) : false) || (lock ? lock.reason : false);
        c.classList.toggle('is-disabled', !!reason && !on);
        c.setAttribute('aria-disabled', reason && !on ? 'true' : 'false');
        c.title = typeof reason === 'string' ? reason : '';
        decorateLock(c, lock, c.querySelector('.cb-card-top'));
        var p = o.price || 0;
        if (opts.priceMode === 'relative' && selected) p = (o.price || 0) - (selected.price || 0);
        c._chip.set(on && opts.priceMode === 'relative' ? 0 : p);
        if (on && opts.priceMode === 'relative') c._chip.textContent = 'Selected';
      });
      if (!selected && cardEls[0]) cardEls[0].tabIndex = 0;
    }, opts);
  }

  /* ---------------------------------------------------------------- segmented */
  function segmented(opts) {
    var wrap = el('div', { class: 'cb-seg-btns', role: 'radiogroup', 'aria-label': labelText(opts) });
    var root = el('div', { class: 'cb-seg' }, opts.label ? el('div', { class: 'cb-label' }, opts.label) : null, wrap, hintNode(opts.hint));
    var btns = (opts.options || []).map(function (o) {
      var b = el('button', { type: 'button', class: 'cb-seg-btn', role: 'radio', 'aria-checked': 'false', title: o.desc || (o.price ? priceText(o.price) : '') },
        o.icon ? el('span', { class: 'cb-seg-icon', html: o.icon }) : null, el('span', null, o.name));
      b._option = o;
      b.addEventListener('click', function () {
        if (b.classList.contains('is-disabled')) return;
        writeVal(opts, o.id, (opts.label ? opts.label + ': ' : '') + o.name);
      });
      wrap.appendChild(b);
      return b;
    });
    return bind(root, opts.path, function (build) {
      var v = readVal(opts, build);
      btns.forEach(function (b) {
        var on = String(b._option.id) === String(v);
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        var lock = lockFor(opts.path, b._option.id, build);
        var reason = b._option.disabled || (opts.optionDisabled ? opts.optionDisabled(b._option, build) : false) || (lock ? lock.reason : false);
        b.classList.toggle('is-disabled', !!reason && !on);
        if (typeof reason === 'string') b.title = reason;
        else b.title = b._option.desc || (b._option.price ? priceText(b._option.price) : '');
        decorateLock(b, lock);
      });
    }, opts);
  }

  /* ---------------------------------------------------------------- toggle */
  function toggle(opts) {
    var sw = el('button', { type: 'button', class: 'cb-switch', role: 'switch', 'aria-checked': 'false', 'aria-label': labelText(opts) },
      el('span', { class: 'cb-switch-knob' }));
    var chip = opts.price != null ? price(opts.price) : null;
    var root = el('div', { class: 'cb-toggle' },
      el('div', { class: 'cb-toggle-text' },
        el('span', { class: 'cb-label' }, opts.label),
        hintNode(opts.hint)),
      chip, sw);
    function flip() {
      var cur = !!readVal(opts, CB.state.get());
      var lock = !cur ? lockFor(opts.path, true, CB.state.get()) : null;
      if (lock) { if (CB.ui.toast) CB.ui.toast(lock.reason, 'warning'); return; }
      writeVal(opts, !cur, (opts.label || opts.path) + (cur ? ' off' : ' on'));
    }
    sw.addEventListener('click', flip);
    root.querySelector('.cb-label').addEventListener('click', function () { if (!sw.disabled) flip(); });
    return bind(root, opts.path, function (build) {
      var on = !!readVal(opts, build);
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
      sw.classList.toggle('is-on', on);
      root.classList.toggle('is-on', on);
      if (chip) chip.set(typeof opts.price === 'function' ? opts.price(build) : opts.price);
      var lock = lockFor(opts.path, true, build);
      decorateLock(root, lock, root.querySelector('.cb-toggle-text .cb-label'));
      if (lock) root.title = lock.reason; else if (root.classList.contains('was-locked')) root.removeAttribute('title');
      root.classList.toggle('was-locked', !!lock);
    }, opts);
  }

  /* ---------------------------------------------------------------- color */
  /**
   * color({path, label, swatches?:[{name,hex}], allowCustom=true, hint?, columns?})
   * Swatch grid + native colour picker + hex text field. Shows the swatch name when the value matches one.
   */
  function color(opts) {
    var swatches = opts.swatches || (CB.data && CB.data.paintSwatches) || [];
    var allowCustom = opts.allowCustom !== false;
    var nameEl = el('span', { class: 'cb-color-name' });
    var dot = el('span', { class: 'cb-color-dot' });
    var grid_ = el('div', { class: 'cb-swatches', role: 'listbox', 'aria-label': labelText(opts) });
    var swEls = swatches.map(function (s) {
      var b = el('button', { type: 'button', class: 'cb-swatch', role: 'option', title: s.name + ' ' + s.hex, 'aria-label': s.name, style: { '--swatch': s.hex, background: s.hex } });
      b._hex = s.hex.toLowerCase();
      b.addEventListener('click', function () { writeVal(opts, s.hex.toLowerCase(), (opts.label ? opts.label + ': ' : '') + s.name); });
      grid_.appendChild(b);
      return b;
    });
    var picker = allowCustom ? el('input', { type: 'color', class: 'cb-color-picker', 'aria-label': labelText(opts) + ' custom colour' }) : null;
    var hexIn = allowCustom ? el('input', { type: 'text', class: 'cb-hex', maxlength: 7, spellcheck: 'false', autocomplete: 'off', 'aria-label': labelText(opts) + ' hex value', placeholder: '#rrggbb' }) : null;
    var pickTimer = null;
    if (picker) {
      picker.addEventListener('input', function () {
        dot.style.background = picker.value;
        if (hexIn) hexIn.value = picker.value;
        clearTimeout(pickTimer);
        pickTimer = setTimeout(function () { writeVal(opts, picker.value.toLowerCase(), (opts.label || 'Colour') + ': custom'); }, 30);
      });
    }
    if (hexIn) {
      function commitHex() {
        var v = hexIn.value.trim();
        if (v && v.charAt(0) !== '#') v = '#' + v;
        if (U.isHex(v)) { writeVal(opts, U.normHex(v), (opts.label || 'Colour') + ': ' + U.normHex(v)); hexIn.classList.remove('is-invalid'); }
        else hexIn.classList.add('is-invalid');
      }
      hexIn.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); commitHex(); } });
      hexIn.addEventListener('change', commitHex);
      hexIn.addEventListener('input', function () {
        var v = hexIn.value.trim(); if (v && v.charAt(0) !== '#') v = '#' + v;
        hexIn.classList.toggle('is-invalid', !!v && !/^#[0-9a-fA-F]{0,6}$/.test(v));
      });
    }
    var root = el('div', { class: 'cb-color', style: opts.columns ? { '--cols': opts.columns } : null },
      el('div', { class: 'cb-color-head' }, el('span', { class: 'cb-label' }, opts.label), el('span', { class: 'cb-color-current' }, dot, nameEl)),
      grid_,
      allowCustom ? el('div', { class: 'cb-color-custom' }, el('label', { class: 'cb-color-picker-wrap', title: 'Custom colour' }, picker, el('span', null, 'Custom')), hexIn) : null,
      hintNode(opts.hint));
    return bind(root, opts.path, function (build) {
      var v = String(readVal(opts, build) || '#000000').toLowerCase();
      var match = null;
      swEls.forEach(function (b) {
        var on = b._hex === v;
        b.classList.toggle('is-selected', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) match = b.getAttribute('aria-label');
      });
      dot.style.background = v;
      nameEl.textContent = match || (CB.data && CB.data.swatchName && CB.data.swatchName(v)) || ('Custom ' + v.toUpperCase());
      if (picker && document.activeElement !== picker) picker.value = U.normHex(v, '#000000');
      if (hexIn && document.activeElement !== hexIn) { hexIn.value = v; hexIn.classList.remove('is-invalid'); }
    }, opts);
  }

  /* ---------------------------------------------------------------- number */
  function number(opts) {
    var step = Number(opts.step) || 1, dec = opts.decimals != null ? opts.decimals : decimalsOf(step);
    var min = opts.min != null ? Number(opts.min) : -Infinity, max = opts.max != null ? Number(opts.max) : Infinity;
    var id = U.uid('num');
    var input = el('input', { type: 'number', id: id, class: 'cb-number-input', min: opts.min, max: opts.max, step: step, inputmode: 'decimal' });
    var dec_ = el('button', { type: 'button', class: 'cb-step', 'aria-label': 'Decrease', html: icons.minus });
    var inc = el('button', { type: 'button', class: 'cb-step', 'aria-label': 'Increase', html: icons.plus });
    var root = el('div', { class: 'cb-number' },
      opts.label ? el('label', { class: 'cb-label', for: id }, opts.label) : null,
      el('div', { class: 'cb-number-row' }, dec_, input, opts.unit ? el('span', { class: 'cb-unit' }, opts.unit) : null, inc),
      hintNode(opts.hint));
    function clampV(v) { return U.round(U.clamp(U.snap(Number(v), step, 0), min, max), dec); }
    function commit(v) {
      if (!isFinite(Number(v)) || v === '') { root.sync(CB.state.get()); return; }
      v = clampV(v); input.value = v.toFixed(dec); writeVal(opts, v);
    }
    input.addEventListener('change', function () { commit(input.value); });
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); commit(input.value); input.blur(); } });
    dec_.addEventListener('click', function () { commit(Number(input.value) - step); });
    inc.addEventListener('click', function () { commit(Number(input.value) + step); });
    root.input = input;
    return bind(root, opts.path, function (build) {
      var v = Number(readVal(opts, build));
      if (document.activeElement !== input) input.value = isFinite(v) ? v.toFixed(dec) : '';
      dec_.disabled = input.disabled || v <= min;
      inc.disabled = input.disabled || v >= max;
    }, opts);
  }

  /* ---------------------------------------------------------------- text */
  function text(opts) {
    var id = U.uid('txt');
    var input = el('input', { type: 'text', id: id, class: 'cb-text-input', maxlength: opts.maxLength || 60, placeholder: opts.placeholder || '', spellcheck: 'false' });
    var root = el('div', { class: 'cb-text' }, opts.label ? el('label', { class: 'cb-label', for: id }, opts.label) : null, input, hintNode(opts.hint));
    function commit() { var v = opts.transform ? opts.transform(input.value) : input.value; writeVal(opts, v, (opts.label || 'Text') + ' → ' + v); }
    input.addEventListener('change', commit);
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); commit(); input.blur(); } });
    return bind(root, opts.path, function (build) {
      if (document.activeElement !== input) input.value = String(readVal(opts, build) == null ? '' : readVal(opts, build));
    }, opts);
  }

  /* ---------------------------------------------------------------- stat / kv */
  function stat(label, value, unit, opts) {
    opts = opts || {};
    var v = el('span', { class: 'cb-stat-value' });
    var u = el('span', { class: 'cb-stat-unit' });
    var delta = el('span', { class: 'cb-stat-delta' });
    var root = el('div', { class: 'cb-stat' + (opts.kind ? ' is-' + opts.kind : '') },
      el('span', { class: 'cb-stat-label' }, label), el('span', { class: 'cb-stat-line' }, v, u, delta));
    var last = null;
    root.set = function (val, un, d) {
      var txt = val == null ? '—' : (typeof val === 'number' ? U.fmtNum(val, opts.decimals != null ? opts.decimals : (Math.abs(val) < 10 ? 1 : 0)) : String(val));
      if (txt !== v.textContent) {
        v.textContent = txt;
        if (last !== null) { root.classList.remove('is-flash'); void root.offsetWidth; root.classList.add('is-flash'); }
        last = txt;
      }
      if (un !== undefined) u.textContent = un ? ' ' + un : '';
      if (d !== undefined) {
        delta.textContent = d ? (d > 0 ? '▲ ' : '▼ ') + U.fmtNum(Math.abs(d), 1) : '';
        delta.className = 'cb-stat-delta' + (d > 0 ? ' is-up' : d < 0 ? ' is-down' : '');
      }
      return root;
    };
    root.set(value, unit || '');
    return root;
  }

  /** kv(rows:[[key, value]] | {key:value}) → .cb-kv definition table; returned el has .set(rows). */
  function kv(rows) {
    var root = el('dl', { class: 'cb-kv' });
    root.set = function (r) {
      U.clear(root);
      var arr = Array.isArray(r) ? r : Object.keys(r || {}).map(function (k) { return [k, r[k]]; });
      arr.forEach(function (row) {
        root.appendChild(el('div', { class: 'cb-kv-row' }, el('dt', null, row[0]), el('dd', null, row[1] == null ? '—' : row[1])));
      });
      return root;
    };
    return root.set(rows || []);
  }

  /* ---------------------------------------------------------------- chart wrapper */
  function chart(opts) {
    opts = opts || {};
    var canvas = el('canvas', { 'aria-label': opts.label || 'chart', role: 'img' });
    var root = el('div', { class: 'cb-chart', style: { height: (opts.height || 220) + 'px' } },
      opts.title ? el('div', { class: 'cb-chart-title cb-label' }, opts.title) : null, canvas);
    root.canvas = canvas;
    return root;
  }

  /* ---------------------------------------------------------------- issues */
  var issueCache = { build: null, list: [] };
  function allIssues(build) {
    if (issueCache.build === build) return issueCache.list;
    var list = [];
    if (CB.rules && typeof CB.rules.validate === 'function') {
      var metrics = null;
      try { if (CB.physics && CB.physics.compute) metrics = CB.physics.compute(build); } catch (e) { metrics = null; }
      try { list = CB.rules.validate(build, metrics) || []; } catch (e) { if (typeof console !== 'undefined') console.error('[CB.ui] rules.validate failed', e); list = []; }
    }
    issueCache = { build: build, list: list };
    return list;
  }
  var SEV_ORDER = { error: 0, warning: 1, info: 2 };

  /**
   * issues(sectionId, opts?) — lists CB.rules issues for one panel section (or all when sectionId is '*'/null).
   * opts: { emptyText, compact, limit }
   */
  function issues(sectionId, opts) {
    opts = opts || {};
    var root = el('div', { class: 'cb-issues', role: 'status', 'aria-live': 'polite' });
    var lastKey = null;
    return bind(root, '*', function (build) {
      var list = allIssues(build).filter(function (i) { return !sectionId || sectionId === '*' || i.section === sectionId; })
        .slice().sort(function (a, b) { return (SEV_ORDER[a.severity] || 9) - (SEV_ORDER[b.severity] || 9); });
      var key = JSON.stringify(list.map(function (i) { return [i.id, i.severity, i.message, i.fix && i.fix.label]; }));
      if (key === lastKey) return;
      lastKey = key;
      U.clear(root);
      root.classList.toggle('is-empty', !list.length);
      if (!CB.rules) { root.appendChild(el('div', { class: 'cb-issues-empty cb-hint' }, 'Validation engine unavailable.')); return; }
      if (!list.length) {
        root.appendChild(el('div', { class: 'cb-issues-empty' }, el('span', { class: 'cb-issue-icon', html: icons.check }), opts.emptyText || 'No conflicts — this configuration is buildable.'));
        return;
      }
      var shown = opts.limit ? list.slice(0, opts.limit) : list;
      shown.forEach(function (iss) {
        var sev = iss.severity === 'error' || iss.severity === 'warning' ? iss.severity : 'info';
        var fixBtn = null;
        if (iss.fix && iss.fix.patch) {
          fixBtn = el('button', { type: 'button', class: 'cb-fix-btn cb-btn' }, iss.fix.label || 'Fix');
          fixBtn.addEventListener('click', function () {
            CB.state.patch(iss.fix.patch, { label: 'Fix: ' + (iss.fix.label || iss.message) });
            if (CB.ui.toast) CB.ui.toast('Applied: ' + (iss.fix.label || 'fix'), 'success');
          });
        }
        var item = el('div', { class: 'cb-issue is-' + sev, dataset: { issue: iss.id || '' } },
          el('span', { class: 'cb-issue-icon', html: icons[sev === 'warning' ? 'warn' : sev] }),
          el('div', { class: 'cb-issue-body' },
            el('div', { class: 'cb-issue-msg' }, iss.message),
            !opts.compact && iss.path ? el('div', { class: 'cb-issue-path cb-hint' }, iss.section ? iss.section + ' · ' + iss.path : iss.path) : null),
          fixBtn);
        root.appendChild(item);
      });
      if (opts.limit && list.length > opts.limit) root.appendChild(el('div', { class: 'cb-hint cb-issues-more' }, '+' + (list.length - opts.limit) + ' more'));
    });
  }

  /* ---------------------------------------------------------------- tabs */
  /**
   * tabs(tabs:[{id,label,render(panelEl), badge?}], opts?:{active, onChange(id), rerender:false})
   * Panels render lazily on first activation (and on every activation when rerender:true).
   * Returned element exposes .select(id), .active(), .panel(id), .setBadge(id, text).
   */
  function tabs(list, opts) {
    opts = opts || {};
    var bar = el('div', { class: 'cb-tab-list', role: 'tablist' });
    var body = el('div', { class: 'cb-tab-panels' });
    var root = el('div', { class: 'cb-tabs' }, bar, body);
    var items = {};
    var active = null;
    list.forEach(function (t, i) {
      var tid = U.uid('tab'), pid = U.uid('tabp');
      var badgeEl = el('span', { class: 'cb-tab-badge' }, t.badge || '');
      var btn = el('button', { type: 'button', class: 'cb-tab', role: 'tab', id: tid, 'aria-controls': pid, 'aria-selected': 'false', tabindex: '-1', dataset: { tab: t.id } },
        el('span', null, t.label), badgeEl);
      var panel = el('div', { class: 'cb-tab-panel', role: 'tabpanel', id: pid, 'aria-labelledby': tid, hidden: true });
      btn.addEventListener('click', function () { select(t.id); });
      btn.addEventListener('keydown', function (ev) {
        var d = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        ev.preventDefault();
        var next = list[(i + d + list.length) % list.length];
        select(next.id); items[next.id].btn.focus();
      });
      bar.appendChild(btn); body.appendChild(panel);
      items[t.id] = { def: t, btn: btn, panel: panel, rendered: false, badge: badgeEl };
    });
    function select(id) {
      var it = items[id];
      if (!it) return;
      Object.keys(items).forEach(function (k) {
        var on = k === id;
        items[k].btn.classList.toggle('is-active', on);
        items[k].btn.setAttribute('aria-selected', on ? 'true' : 'false');
        items[k].btn.tabIndex = on ? 0 : -1;
        items[k].panel.hidden = !on;
      });
      if (!it.rendered || opts.rerender) {
        U.clear(it.panel);
        try { if (it.def.render) it.def.render(it.panel); } catch (e) { if (typeof console !== 'undefined') console.error('[CB.ui] tab render failed', e); }
        it.rendered = true;
      }
      var changedTab = active !== id;
      active = id;
      if (changedTab && opts.onChange) opts.onChange(id);
    }
    root.select = select;
    root.active = function () { return active; };
    root.panel = function (id) { return items[id] && items[id].panel; };
    root.setBadge = function (id, txt) { if (items[id]) items[id].badge.textContent = txt == null ? '' : String(txt); };
    select(opts.active && items[opts.active] ? opts.active : list[0] && list[0].id);
    return root;
  }

  /* ---------------------------------------------------------------- toast */
  function hostFor(id, cls) {
    var h = document.getElementById(id);
    if (!h) { h = el('div', { id: id, class: cls }); document.body.appendChild(h); }
    return h;
  }

  /** toast(msg, kind='info'|'success'|'warning'|'error', opts?:{duration=3200, action:{label, onClick}}) → {close} */
  function toast(msg, kind, opts) {
    if (!hasDOM) return { close: function () {} };
    opts = opts || {};
    kind = kind || 'info';
    var host = hostFor('toast-root');
    host.setAttribute('aria-live', 'polite');
    var iconName = kind === 'success' ? 'check' : kind === 'warning' ? 'warn' : kind === 'error' ? 'error' : 'info';
    var actionBtn = opts.action ? el('button', { type: 'button', class: 'cb-btn ghost cb-toast-action' }, opts.action.label) : null;
    var t = el('div', { class: 'cb-toast is-' + kind, role: kind === 'error' ? 'alert' : 'status' },
      el('span', { class: 'cb-toast-icon', html: icons[iconName] }),
      el('span', { class: 'cb-toast-msg' }, msg),
      actionBtn,
      el('button', { type: 'button', class: 'cb-toast-close', 'aria-label': 'Dismiss', html: icons.close }));
    var closed = false, timer = null;
    function close() {
      if (closed) return; closed = true; clearTimeout(timer);
      t.classList.add('is-leaving');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
    }
    t.querySelector('.cb-toast-close').addEventListener('click', close);
    if (actionBtn) actionBtn.addEventListener('click', function () { opts.action.onClick(); close(); });
    t.addEventListener('mouseenter', function () { clearTimeout(timer); });
    t.addEventListener('mouseleave', function () { timer = setTimeout(close, 1500); });
    host.appendChild(t);
    while (host.children.length > 5) host.removeChild(host.firstChild);
    requestAnimationFrame(function () { t.classList.add('is-visible'); });
    timer = setTimeout(close, opts.duration || (kind === 'error' ? 6000 : 3200));
    return { close: close, el: t };
  }

  /* ---------------------------------------------------------------- modal */
  var openModals = [];
  /**
   * modal({title, subtitle?, content: Node|string(html)|fn(bodyEl, api), actions:[{label, kind:'primary'|'ghost', onClick(api)->false keeps open}],
   *        size:'sm'|'md'|'lg'|'xl', onClose, dismissible=true}) → {close(), el, body}
   */
  function modal(opts) {
    if (!hasDOM) return { close: function () {} };
    opts = opts || {};
    var host = hostFor('modal-root');
    var prevFocus = document.activeElement;
    var titleId = U.uid('mt');
    var bodyEl = el('div', { class: 'cb-modal-body' });
    var foot = el('footer', { class: 'cb-modal-foot' });
    var closeBtn = el('button', { type: 'button', class: 'cb-modal-close cb-btn ghost', 'aria-label': 'Close', html: icons.close });
    var card = el('div', { class: 'cb-modal-card is-' + (opts.size || 'md'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      el('header', { class: 'cb-modal-head' },
        el('div', null, el('h2', { id: titleId, class: 'cb-modal-title' }, opts.title || ''), opts.subtitle ? el('p', { class: 'cb-hint' }, opts.subtitle) : null),
        opts.dismissible === false ? null : closeBtn),
      bodyEl, foot);
    var overlay = el('div', { class: 'cb-modal' }, card);
    var closed = false;
    var api = {
      el: overlay, body: bodyEl, card: card,
      close: function (result) {
        if (closed) return; closed = true;
        overlay.classList.remove('is-open'); overlay.classList.add('is-leaving');
        document.removeEventListener('keydown', onKey, true);
        var i = openModals.indexOf(api); if (i >= 0) openModals.splice(i, 1);
        setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 220);
        if (!openModals.length) document.documentElement.classList.remove('cb-modal-open');
        if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) { /* ignore */ }
        if (opts.onClose) opts.onClose(result);
      }
    };
    if (typeof opts.content === 'function') opts.content(bodyEl, api);
    else if (opts.content && opts.content.nodeType) bodyEl.appendChild(opts.content);
    else if (opts.content != null) bodyEl.innerHTML = String(opts.content);
    (opts.actions || []).forEach(function (a) {
      var b = button(a.label, { kind: a.kind || '', icon: a.icon });
      b.addEventListener('click', function () {
        var r = a.onClick ? a.onClick(api) : undefined;
        if (r !== false && a.close !== false) api.close(a.label);
      });
      foot.appendChild(b);
    });
    if (!foot.children.length) foot.hidden = true;
    closeBtn.addEventListener('click', function () { api.close(); });
    overlay.addEventListener('mousedown', function (ev) { if (ev.target === overlay && opts.dismissible !== false) api.close(); });
    function onKey(ev) {
      if (openModals[openModals.length - 1] !== api) return;
      if (ev.key === 'Escape' && opts.dismissible !== false) { ev.stopPropagation(); api.close(); }
      else if (ev.key === 'Tab') {
        var f = Array.prototype.filter.call(card.querySelectorAll('button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'),
          function (n) { return !n.getClientRects || n.getClientRects().length > 0; });
        if (!f.length) { ev.preventDefault(); return; }
        var first = f[0], last = f[f.length - 1], act = document.activeElement;
        // Focus on the card itself (dialogs without a primary button) or outside it: wrap instead of escaping
        if (act === card || !card.contains(act)) { ev.preventDefault(); (ev.shiftKey ? last : first).focus(); }
        else if (ev.shiftKey && act === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    host.appendChild(overlay);
    openModals.push(api);
    document.documentElement.classList.add('cb-modal-open');
    requestAnimationFrame(function () {
      overlay.classList.add('is-open');
      var auto = card.querySelector('[autofocus]') || foot.querySelector('.cb-btn.primary') || card;
      try { auto.focus(); } catch (e) { /* ignore */ }
    });
    return api;
  }

  /** confirm({title, message, okLabel, cancelLabel, danger}) → Promise<boolean> */
  function confirm_(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      modal({
        title: opts.title || 'Are you sure?', size: 'sm', content: el('p', null, opts.message || ''),
        onClose: function () { if (!done) resolve(false); },
        actions: [
          { label: opts.cancelLabel || 'Cancel', kind: 'ghost', onClick: function () { done = true; resolve(false); } },
          { label: opts.okLabel || 'Confirm', kind: opts.danger ? 'primary danger' : 'primary', onClick: function () { done = true; resolve(true); } }
        ]
      });
    });
  }

  /* ---------------------------------------------------------------- panel registry */
  CB.panels = CB.panels || {};
  var panelGroups = ['Engineering', 'Chassis', 'Design'];

  /**
   * registerPanel({ id, title, icon (svg string), group: 'Engineering'|'Chassis'|'Design', order,
   *                 render(container, build, metrics), update?(build, metrics, change), subtitle? })
   */
  function registerPanel(def) {
    if (!def || !def.id || typeof def.render !== 'function') {
      if (typeof console !== 'undefined') console.error('[CB.registerPanel] invalid panel definition', def);
      return null;
    }
    var p = Object.assign({ title: def.id, group: 'Engineering', order: 100, icon: icons[def.id] || icons.spark }, def);
    if (panelGroups.indexOf(p.group) < 0) panelGroups.push(p.group);
    CB.panels[p.id] = p;
    if (hasDOM) {
      try { document.dispatchEvent(new CustomEvent('cb:panel-registered', { detail: { id: p.id } })); } catch (e) { /* old browsers */ }
    }
    return p;
  }

  function panelList() {
    return Object.keys(CB.panels).map(function (k) { return CB.panels[k]; }).sort(function (a, b) {
      var ga = panelGroups.indexOf(a.group), gb = panelGroups.indexOf(b.group);
      return ga !== gb ? ga - gb : (a.order || 0) - (b.order || 0);
    });
  }

  CB.registerPanel = registerPanel;
  CB.panelList = panelList;

  CB.ui = {
    section: section, group: group, grid: grid, slider: slider, select: select, cards: cards, segmented: segmented,
    toggle: toggle, color: color, number: number, text: text, stat: stat, kv: kv, issues: issues, price: price,
    priceText: priceText, badge: badge, button: button, chart: chart, tabs: tabs, toast: toast, modal: modal,
    confirm: confirm_, icon: icon, icons: icons, bind: bind, syncAll: syncAll, allIssues: allIssues,
    panelGroups: panelGroups, autoSync: true,
    lockFor: lockFor, currency: null, lockOption: null
  };

  ensureAutoSync();
})();

if (typeof module !== 'undefined') module.exports = CB.ui;
