/* ==========================================================================
   FORGE Atelier — api/signal.js
   WebRTC signalling relay for multiplayer (docs/NET-SPEC.md). Vercel Node serverless function, zero npm deps.
   Storage: Upstash Redis REST API via global fetch. Env (either naming works):
     UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   (Upstash integration)
     KV_REST_API_URL        / KV_REST_API_TOKEN          (Vercel KV / Marketplace naming)
   Without them every action answers 200 {ok:false, code:'no-backend'} and the client falls back to Manual mode.

   POST /api/signal  (JSON body; GET /api/signal == {action:'status'})
     {action:'status'}                                  -> {ok, backend:'upstash'|'memory', version}
     {action:'create', name?}                           -> {ok, room:'ABCDE', peer:'host', token, ttl}
     {action:'join', room}                              -> {ok, room, peer:'p…', host:'host', token, ttl}
     {action:'post', room, token, to, msg | msgs:[…]}   -> {ok, n}      host may post to any peer, peers only to 'host'
     {action:'poll', room, token, wait?:0..8000, busy?, idle?} -> {ok, msgs:[{from, msg, ts}]}  waits up to `wait` ms
                                                        (short sleeps: 100 ms when busy, backing off to 1-2 s), drains mailbox
     {action:'close', room, token}                      -> {ok}          host: deletes room (peers get {t:'_closed'});
                                                                         peer: leaves (host gets {t:'_leave'} from it)
     {action:'relay', room, token, posts?:[{to, msgs}], wait?, nopoll?} -> {ok, msgs, dropped?}
                                                        post + poll in ONE request (the server-relay fallback of
                                                        js/net/relay.js when WebRTC cannot connect); own rate bucket
   Errors: {ok:false, code, error}  codes: no-backend, bad-request, bad-action, too-large, not-found, full, auth,
           forbidden, rate-limited, room-closed, backend-error.
   Limits: room TTL 2 h (sliding on host activity), mailbox TTL 2 min, body ≤ 64 KB, ≤ 32 msgs per post,
           ≤ 256 queued msgs per mailbox, 8 players per room, per-IP rate limits (see LIMITS).
   Same-origin only: no CORS allow headers are ever sent, and a request whose Origin doesn't match the Host is rejected.

   Extra exports (for tools/dev-server.js and tests): createHandler(opts), createMemoryRedis(opts), upstashClient(url, token),
   LIMITS, ALPHABET.
   ========================================================================== */
'use strict';

var crypto = require('crypto');

var VERSION = 'forge-signal/1';
var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
var LIMITS = {
  roomTtl: 7200,          // s
  mailboxTtl: 120,        // s
  bodyBytes: 65536,
  msgsPerPost: 32,
  mailboxMax: 256,
  maxPlayers: 8,          // including host
  pollMaxWait: 8000,      // ms (Hobby functions die at 10 s)
  rateWindow: 60,         // s
  ratePerIp: 600,         // requests / window / IP (signalling actions; relay has its own bucket)
  createPerIp: 12,        // creates / window / IP
  joinPerIp: 40,          // joins / window / IP
  relayPerIp: 3000,       // relay requests / window / IP (≈ 8 players behind one NAT at ~6 req/s each)
  relayPosts: 8,          // destinations per relay request
  relayMsgs: 64,          // messages per relay request (all destinations)
  relayStep: 100          // ms between mailbox checks while a relay request waits (each check is one Redis call)
};
var PFX = 'fg:';

/* ------------------------------------------------------------------ redis clients
   A client is { exec(cmds:Array<Array<string|number>>) -> Promise<Array<result>> } (a pipeline), kind. */

function upstashClient(url, token, fetchImpl) {
  url = String(url).replace(/\/+$/, '');
  return {
    kind: 'upstash',
    exec: async function (cmds) {
      var f = fetchImpl || globalThis.fetch;
      var r = await f(url + '/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmds)
      });
      if (!r.ok) throw new Error('upstash http ' + r.status);
      var out = await r.json();
      if (!Array.isArray(out)) throw new Error('upstash bad response');
      return out.map(function (x) {
        if (x && x.error) throw new Error('upstash: ' + x.error);
        return x ? x.result : null;
      });
    }
  };
}

/** In-memory Redis subset with Upstash-like results (strings, integers, arrays, null). Lazy TTL expiry. */
function createMemoryRedis(opts) {
  opts = opts || {};
  var now = opts.now || Date.now;
  var data = new Map(); // key -> {type:'str'|'hash'|'list', v, exp}
  function get(k) {
    var e = data.get(k);
    if (e && e.exp && e.exp <= now()) { data.delete(k); return null; }
    return e || null;
  }
  function need(k, type) {
    var e = get(k);
    if (!e) { e = { type: type, v: type === 'hash' ? new Map() : type === 'list' ? [] : '', exp: 0 }; data.set(k, e); }
    if (e.type !== type) throw new Error('WRONGTYPE');
    return e;
  }
  function cleanup(k) {
    var e = data.get(k);
    if (e && ((e.type === 'hash' && e.v.size === 0) || (e.type === 'list' && e.v.length === 0))) data.delete(k);
  }
  var cmds = {
    GET: function (k) { var e = get(k); return e ? e.v : null; },
    SET: function (k, v) {
      var rest = Array.prototype.slice.call(arguments, 2).map(String), ex = 0, nx = false;
      for (var i = 0; i < rest.length; i++) {
        var o = rest[i].toUpperCase();
        if (o === 'EX') ex = Number(rest[++i]); else if (o === 'PX') ex = Number(rest[++i]) / 1000; else if (o === 'NX') nx = true;
      }
      if (nx && get(k)) return null;
      data.set(k, { type: 'str', v: String(v), exp: ex ? now() + ex * 1000 : 0 });
      return 'OK';
    },
    DEL: function () { var n = 0; for (var i = 0; i < arguments.length; i++) if (get(arguments[i])) { data.delete(arguments[i]); n++; } return n; },
    EXISTS: function () { var n = 0; for (var i = 0; i < arguments.length; i++) if (get(arguments[i])) n++; return n; },
    EXPIRE: function (k, s) { var e = get(k); if (!e) return 0; e.exp = now() + Number(s) * 1000; return 1; },
    TTL: function (k) { var e = get(k); if (!e) return -2; if (!e.exp) return -1; return Math.ceil((e.exp - now()) / 1000); },
    INCR: function (k) {
      var e = get(k);
      if (!e) { e = { type: 'str', v: '0', exp: 0 }; data.set(k, e); }
      e.v = String((parseInt(e.v, 10) || 0) + 1); return Number(e.v);
    },
    HSET: function (k) {
      var e = need(k, 'hash'), n = 0;
      for (var i = 1; i + 1 < arguments.length; i += 2) { if (!e.v.has(String(arguments[i]))) n++; e.v.set(String(arguments[i]), String(arguments[i + 1])); }
      return n;
    },
    HSETNX: function (k, f, v) { var e = need(k, 'hash'); if (e.v.has(String(f))) return 0; e.v.set(String(f), String(v)); return 1; },
    HGET: function (k, f) { var e = get(k); if (!e) return null; if (e.type !== 'hash') throw new Error('WRONGTYPE'); var v = e.v.get(String(f)); return v === undefined ? null : v; },
    HDEL: function (k) { var e = get(k); if (!e) return 0; var n = 0; for (var i = 1; i < arguments.length; i++) if (e.v.delete(String(arguments[i]))) n++; cleanup(k); return n; },
    HLEN: function (k) { var e = get(k); return e ? e.v.size : 0; },
    HGETALL: function (k) { var e = get(k); if (!e) return []; var out = []; e.v.forEach(function (v, f) { out.push(f, v); }); return out; },
    RPUSH: function (k) { var e = need(k, 'list'); for (var i = 1; i < arguments.length; i++) e.v.push(String(arguments[i])); return e.v.length; },
    LPOP: function (k, count) {
      var e = get(k); if (!e) return null;
      if (count === undefined) { var x = e.v.shift(); cleanup(k); return x === undefined ? null : x; }
      var out = e.v.splice(0, Math.max(0, Number(count))); cleanup(k); return out.length ? out : null;
    },
    LLEN: function (k) { var e = get(k); return e ? e.v.length : 0; },
    LRANGE: function (k, a, b) {
      var e = get(k); if (!e) return []; var l = e.v.length; a = Number(a); b = Number(b);
      if (a < 0) a += l; if (b < 0) b += l; return e.v.slice(Math.max(0, a), b + 1);
    },
    LTRIM: function (k, a, b) {
      var e = get(k); if (!e) return 'OK'; var l = e.v.length; a = Number(a); b = Number(b);
      if (a < 0) a += l; if (b < 0) b += l; e.v = e.v.slice(Math.max(0, a), b + 1); cleanup(k); return 'OK';
    },
    FLUSHALL: function () { data.clear(); return 'OK'; }
  };
  var client = {
    kind: 'memory',
    calls: 0,
    exec: async function (list) {
      return list.map(function (c) {
        client.calls++;
        var fn = cmds[String(c[0]).toUpperCase()];
        if (!fn) throw new Error('unknown command ' + c[0]);
        return fn.apply(null, c.slice(1));
      });
    },
    /** Synchronous single command (tests / Upstash fetch mock). */
    command: function (c) { client.calls++; var fn = cmds[String(c[0]).toUpperCase()]; if (!fn) throw new Error('ERR unknown command ' + c[0]); return fn.apply(null, c.slice(1)); },
    _data: data
  };
  return client;
}

/* ------------------------------------------------------------------ helpers */

function randCode(n) {
  var b = crypto.randomBytes(n), s = '';
  for (var i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length]; // 256 % 31 bias is negligible here
  return s;
}
function randToken() { return crypto.randomBytes(18).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function randPeer() { return 'p' + randCode(6).toLowerCase(); }
function safeEq(a, b) {
  a = Buffer.from(String(a || '')); b = Buffer.from(String(b || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
function normRoom(r) {
  if (typeof r !== 'string') return null;
  r = r.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/.test(r) ? r : null;
}
function validPeer(p) { return typeof p === 'string' && (p === 'host' || /^p[a-z0-9]{6}$/.test(p)); }

function clientIp(req) {
  var h = req.headers || {};
  var xf = h['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  if (h['x-real-ip']) return String(h['x-real-ip']);
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function send(res, status, obj) {
  var body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(body);
}
function fail(res, status, code, error, extra) {
  var o = { ok: false, code: code, error: error || code };
  if (extra) for (var k in extra) o[k] = extra[k];
  send(res, status, o);
}

function sameOrigin(req) {
  var h = req.headers || {};
  var origin = h.origin;
  if (!origin || origin === 'null') return !origin; // 'null' origin (sandboxed/file://) is not us
  var host = h['x-forwarded-host'] || h.host;
  try { return new URL(origin).host === String(host).split(',')[0].trim(); } catch (e) { return false; }
}

async function readBody(req, cap) {
  if (req.body !== undefined && req.body !== null) {
    // Vercel pre-parses JSON / text bodies (getter may throw on bad JSON)
    var b = req.body;
    if (typeof b === 'string' || Buffer.isBuffer(b)) {
      if (b.length > cap) { var e0 = new Error('too-large'); e0.code = 'too-large'; throw e0; }
      return JSON.parse(String(b));
    }
    if (JSON.stringify(b).length > cap) { var e1 = new Error('too-large'); e1.code = 'too-large'; throw e1; }
    return b;
  }
  var len = Number((req.headers || {})['content-length'] || 0);
  if (len > cap) { var e2 = new Error('too-large'); e2.code = 'too-large'; throw e2; }
  return await new Promise(function (resolve, reject) {
    var chunks = [], size = 0, done = false;
    req.on('data', function (c) {
      if (done) return;
      size += c.length;
      if (size > cap) { done = true; var e = new Error('too-large'); e.code = 'too-large'; reject(e); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (done) return; done = true;
      var s = Buffer.concat(chunks).toString('utf8');
      try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); }
    });
    req.on('error', function (e) { if (!done) { done = true; reject(e); } });
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ------------------------------------------------------------------ handler */

/**
 * createHandler({ redis?, env?, now?, sleep?, limits? }) -> async (req, res)
 *  redis: a client {exec(cmds)}; if omitted, built per request from env (Upstash REST) or 'no-backend'.
 */
function createHandler(opts) {
  opts = opts || {};
  var L = Object.assign({}, LIMITS, opts.limits || {});
  var now = opts.now || Date.now;
  var doSleep = opts.sleep || sleep;

  function getRedis() {
    if (opts.redis) return opts.redis;
    var env = opts.env || process.env;
    var url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
    var token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
    if (!url || !token) return null;
    return upstashClient(url, token, opts.fetch);
  }

  var K = {
    room: function (r) { return PFX + 'room:' + r; },
    box: function (r, p) { return PFX + 'mb:' + r + ':' + p; },
    rl: function (ip, kind) { return PFX + 'rl:' + kind + ':' + ip + ':' + Math.floor(now() / 1000 / L.rateWindow); }
  };

  async function rateLimit(db, ip, kind, limit) {
    var key = K.rl(ip, kind);
    var r = await db.exec([['INCR', key], ['EXPIRE', key, L.rateWindow + 5]]);
    return Number(r[0]) <= limit;
  }

  async function auth(db, room, token) {
    // returns {peer, isHost, fields} or null (room missing) / false (bad token)
    var all = await db.exec([['HGETALL', K.room(room)]]);
    var flat = all[0] || [];
    if (!Array.isArray(flat) || !flat.length) return null;
    var fields = {};
    for (var i = 0; i + 1 < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
    if (!fields.host) return null;
    for (var f in fields) {
      if (f === 'host' && safeEq(fields.host, token)) return { peer: 'host', isHost: true, fields: fields };
      if (f.indexOf('p:') === 0 && safeEq(fields[f], token)) return { peer: f.slice(2), isHost: false, fields: fields };
    }
    return false;
  }
  function peersOf(fields) { return Object.keys(fields).filter(function (f) { return f.indexOf('p:') === 0; }).map(function (f) { return f.slice(2); }); }

  function encMsg(from, msg) { return JSON.stringify({ from: from, msg: msg, ts: now() }); }

  async function push(db, room, to, items) {
    var key = K.box(room, to);
    var cmd = ['RPUSH', key].concat(items);
    await db.exec([cmd, ['LTRIM', key, -L.mailboxMax, -1], ['EXPIRE', key, L.mailboxTtl]]);
  }

  var actions = {
    status: async function (db) {
      return { ok: true, backend: db.kind || 'upstash', version: VERSION, relay: true, limits: { maxPlayers: L.maxPlayers, pollMaxWait: L.pollMaxWait } };
    },

    create: async function (db, body, ctx) {
      if (!(await rateLimit(db, ctx.ip, 'create', L.createPerIp))) return [429, 'rate-limited'];
      for (var tries = 0; tries < 6; tries++) {
        var code = randCode(5), token = randToken();
        var r = await db.exec([['HSETNX', K.room(code), 'host', token]]);
        if (Number(r[0]) === 1) {
          await db.exec([['HSET', K.room(code), 'created', String(now())], ['EXPIRE', K.room(code), L.roomTtl]]);
          return { ok: true, room: code, peer: 'host', token: token, ttl: L.roomTtl };
        }
      }
      return [503, 'backend-error', 'could not allocate a room code'];
    },

    join: async function (db, body, ctx) {
      if (!(await rateLimit(db, ctx.ip, 'join', L.joinPerIp))) return [429, 'rate-limited'];
      var room = normRoom(body.room);
      if (!room) return [400, 'bad-request', 'room code must be 5 characters'];
      var r = await db.exec([['HLEN', K.room(room)], ['HGET', K.room(room), 'host']]);
      if (!r[1]) return [404, 'not-found', 'no such room (it may have expired)'];
      var players = Number(r[0]) - 1; // minus 'host' + 'created' fields, plus the host player
      if (players >= L.maxPlayers) return [409, 'full', 'room is full'];
      var peer = randPeer(), token = randToken();
      await db.exec([['HSET', K.room(room), 'p:' + peer, token]]);
      return { ok: true, room: room, peer: peer, host: 'host', token: token, ttl: L.roomTtl };
    },

    post: async function (db, body) {
      var room = normRoom(body.room);
      if (!room || typeof body.token !== 'string') return [400, 'bad-request'];
      var list = Array.isArray(body.msgs) ? body.msgs : body.msg !== undefined ? [body.msg] : null;
      if (!list || !list.length) return [400, 'bad-request', 'msg or msgs required'];
      if (list.length > L.msgsPerPost) return [413, 'too-large', 'too many messages'];
      var to = body.to;
      if (!validPeer(to)) return [400, 'bad-request', 'bad recipient'];
      var a = await auth(db, room, body.token);
      if (a === null) return [410, 'room-closed', 'room closed'];
      if (a === false) return [403, 'auth', 'bad token'];
      if (to === a.peer) return [400, 'bad-request', 'cannot post to yourself'];
      if (!a.isHost && to !== 'host') return [403, 'forbidden', 'peers may only message the host'];
      if (to !== 'host' && !a.fields['p:' + to]) return [404, 'not-found', 'no such peer'];
      await push(db, room, to, list.map(function (m) { return encMsg(a.peer, m); }));
      return { ok: true, n: list.length };
    },

    poll: async function (db, body) {
      var room = normRoom(body.room);
      if (!room || typeof body.token !== 'string') return [400, 'bad-request'];
      var wait = Math.max(0, Math.min(L.pollMaxWait, Number(body.wait) || 0));
      var a = await auth(db, room, body.token);
      if (a === null) return [410, 'room-closed', 'room closed'];
      if (a === false) return [403, 'auth', 'bad token'];
      var key = K.box(room, a.peer);
      var t0 = now();
      // 'busy' = client is mid-negotiation (offer/answer/ICE in flight): tight 100 ms steps for a few seconds.
      var steps = body.busy ? [100] : body.idle ? [1000, 2000] : [120, 200, 300, 500, 800, 1000];
      var first = [['LPOP', key, 64]];
      if (a.isHost) first.push(['EXPIRE', K.room(room), L.roomTtl]);
      var r = (await db.exec(first))[0];
      for (var i = 0; !(r && r.length); i++) {
        var step = steps[Math.min(i, steps.length - 1)];
        if (now() - t0 + step > wait) break;
        await doSleep(step);
        r = (await db.exec([['LPOP', key, 64]]))[0];
      }
      var msgs = [];
      (Array.isArray(r) ? r : r ? [r] : []).forEach(function (s) { try { msgs.push(JSON.parse(s)); } catch (e) { /* drop */ } });
      return { ok: true, msgs: msgs };
    },

    relay: async function (db, body) {
      var room = normRoom(body.room);
      if (!room || typeof body.token !== 'string') return [400, 'bad-request'];
      var wait = Math.max(0, Math.min(L.pollMaxWait, Number(body.wait) || 0));
      var posts = body.posts == null ? [] : body.posts;
      if (!Array.isArray(posts)) return [400, 'bad-request', 'posts must be an array'];
      if (posts.length > L.relayPosts) return [413, 'too-large', 'too many destinations'];
      var total = 0;
      for (var i = 0; i < posts.length; i++) {
        var p = posts[i];
        if (!p || !validPeer(p.to) || !Array.isArray(p.msgs)) return [400, 'bad-request', 'bad post'];
        total += p.msgs.length;
      }
      if (total > L.relayMsgs) return [413, 'too-large', 'too many messages'];
      var a = await auth(db, room, body.token);
      if (a === null) return [410, 'room-closed', 'room closed'];
      if (a === false) return [403, 'auth', 'bad token'];
      var dropped = [];
      for (var j = 0; j < posts.length; j++) {
        var to = posts[j].to, list = posts[j].msgs;
        if (!list.length) continue;
        if (to === a.peer || (!a.isHost && to !== 'host') || (to !== 'host' && !a.fields['p:' + to])) { dropped.push(to); continue; }
        await push(db, room, to, list.map(function (m) { return encMsg(a.peer, m); }));
      }
      var msgs = [];
      if (!body.nopoll) {
        var key = K.box(room, a.peer), t0 = now();
        var first = [['LPOP', key, 64]];
        if (a.isHost) first.push(['EXPIRE', K.room(room), L.roomTtl]);
        var r = (await db.exec(first))[0];
        while (!(r && r.length) && now() - t0 + L.relayStep <= wait) {
          await doSleep(L.relayStep);
          r = (await db.exec([['LPOP', key, 64]]))[0];
        }
        (Array.isArray(r) ? r : r ? [r] : []).forEach(function (s) { try { msgs.push(JSON.parse(s)); } catch (e) { /* drop */ } });
      }
      var out = { ok: true, msgs: msgs };
      if (dropped.length) out.dropped = dropped;
      return out;
    },

    close: async function (db, body) {
      var room = normRoom(body.room);
      if (!room || typeof body.token !== 'string') return [400, 'bad-request'];
      var a = await auth(db, room, body.token);
      if (a === null) return { ok: true, already: true };
      if (a === false) return [403, 'auth', 'bad token'];
      if (a.isHost) {
        var peers = peersOf(a.fields);
        var cmds = [['DEL', K.room(room), K.box(room, 'host')]];
        await db.exec(cmds);
        for (var i = 0; i < peers.length; i++) await push(db, room, peers[i], [encMsg('host', { t: '_closed' })]);
      } else {
        await db.exec([['HDEL', K.room(room), 'p:' + a.peer], ['DEL', K.box(room, a.peer)]]);
        await push(db, room, 'host', [encMsg(a.peer, { t: '_leave' })]);
      }
      return { ok: true };
    }
  };

  return async function handler(req, res) {
    try {
      var method = String(req.method || 'GET').toUpperCase();
      if (method === 'OPTIONS') { res.statusCode = 204; res.setHeader('Allow', 'GET, POST'); res.end(); return; }
      if (!sameOrigin(req)) return fail(res, 403, 'forbidden', 'cross-origin requests are not allowed');
      var body;
      if (method === 'GET') body = { action: 'status' };
      else if (method === 'POST') {
        try { body = await readBody(req, L.bodyBytes); }
        catch (e) { return e && e.code === 'too-large' ? fail(res, 413, 'too-large', 'payload over 64 KB') : fail(res, 400, 'bad-request', 'invalid JSON'); }
      } else return fail(res, 405, 'bad-request', 'method not allowed');
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'bad-request', 'JSON object expected');
      var fn = Object.prototype.hasOwnProperty.call(actions, body.action) ? actions[body.action] : null;
      if (!fn) return fail(res, 400, 'bad-action', 'unknown action');
      var db = getRedis();
      if (!db) return send(res, 200, { ok: false, code: 'no-backend', error: 'online signalling is not configured (set UPSTASH_REDIS_REST_URL / _TOKEN)' });
      var ctx = { ip: clientIp(req) };
      if (body.action === 'relay') { if (!(await rateLimit(db, ctx.ip, 'relay', L.relayPerIp))) return fail(res, 429, 'rate-limited', 'slow down'); }
      else if (body.action !== 'status' && !(await rateLimit(db, ctx.ip, 'all', L.ratePerIp))) return fail(res, 429, 'rate-limited', 'slow down');
      var out = await fn(db, body, ctx);
      if (Array.isArray(out)) return fail(res, out[0], out[1], out[2]);
      return send(res, 200, out);
    } catch (err) {
      try { console.error('[signal]', err && err.message); } catch (e) { /* ignore */ }
      if (!res.headersSent) return fail(res, 502, 'backend-error', 'signalling backend error');
    }
  };
}

var defaultHandler = createHandler();
module.exports = function (req, res) { return defaultHandler(req, res); };
module.exports.createHandler = createHandler;
module.exports.createMemoryRedis = createMemoryRedis;
module.exports.upstashClient = upstashClient;
module.exports.LIMITS = LIMITS;
module.exports.ALPHABET = ALPHABET;
module.exports.VERSION = VERSION;
