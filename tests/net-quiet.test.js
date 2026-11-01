/* REDLINE — online QA: quiet endpoint probing, lobby car names (js/net/signal.js, js/net/lobby.js). */
'use strict';
var path = require('path');
var root = path.join(__dirname, '..');
var S = require(path.join(root, 'js', 'net', 'signal.js'));

test('net: the endpoint that answered is remembered, so the next page load does not probe (and 404) the other one', async function () {
  var store = {}, calls = [];
  var prevLS = globalThis.localStorage, prevFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: function (k) { return k in store ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); } };
  globalThis.fetch = function (url) {
    calls.push(url);
    if (/\.php$/.test(url)) return Promise.resolve({ status: 404, json: function () { return Promise.reject(new Error('html')); } });
    return Promise.resolve({ status: 200, json: function () { return Promise.resolve({ ok: true, backend: 'memory' }); } });
  };
  try {
    S._resetEndpoint();
    assert.equal(await S.endpoint(), 'api/signal');
    assert.deepEqual(calls, ['api/signal.php', 'api/signal']);
    S._resetEndpoint(); calls = [];
    assert.equal(await S.endpoint(), 'api/signal');
    assert.deepEqual(calls, ['api/signal'], 'remembered endpoint probed first, no PHP 404');
  } finally {
    S._resetEndpoint();
    if (prevLS === undefined) delete globalThis.localStorage; else globalThis.localStorage = prevLS;
    if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
  }
});

test('lobby: a car card is headed by the Garage build name, with the model as small print', function () {
  var L;
  try { L = require(path.join(root, 'js', 'net', 'lobby.js')); } catch (e) { L = globalThis.CB && globalThis.CB.net && globalThis.CB.net.lobby; }
  var T = (L && L._ ? L._ : globalThis.CB.net.lobby._).cardTitle;
  assert.deepEqual(T({ make: 'Porsche', name: '911 Carrera', gen: '992', buildName: 'Porsche 911 Carrera S' }), { title: 'Porsche 911 Carrera S', sub: '992' });
  assert.deepEqual(T({ make: 'Porsche', name: '911 Carrera', gen: '992', buildName: 'Weekend car' }), { title: 'Weekend car', sub: 'Porsche 911 Carrera' });
  assert.deepEqual(T({ make: 'Porsche', name: '911 Carrera', gen: '992', buildName: 'Untitled Build' }), { title: 'Porsche 911 Carrera', sub: '992' });
});
