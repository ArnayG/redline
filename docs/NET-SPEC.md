# FORGE — Multiplayer with friends (Vercel free plan)

Constraints: deployed as a static site on **Vercel Hobby (free)**. No persistent server, no WebSocket server, serverless
functions are short-lived (≤10 s), so all realtime traffic is **peer-to-peer WebRTC data channels**. Vercel only does
**signalling** (exchanging offers/answers/ICE) through one tiny function backed by **Upstash Redis free tier** (REST API,
env `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`; added via Vercel Marketplace → Upstash). Client stays zero-dependency
classic scripts; the function uses only built-in `fetch` (no npm packages). Everything must degrade gracefully:
- no API / no env vars → **Manual mode** (copy/paste invite + answer codes, works even from file://),
- same machine → **Local mode** via `BroadcastChannel` (two tabs) for testing,
- STUN: `stun:stun.l.google.com:19302`, `stun:stun.cloudflare.com:3478`. TURN: from the signalling server's `ice` action
  (`api/turn-config.php` on PHP, env vars on Vercel / dev server; short-lived Cloudflare / Metered credentials minted
  server-side, API keys never sent) plus optional `window.REDLINE_TURN` / `window.FORGE_TURN`. Paths: direct → TURN → server
  relay (`js/net/relay.js`: pipelined posts + held long-polls or one streamed response; see README *Server relay fallback*).

## Topology
Star: the **host** (room creator) is authoritative for room/race state; up to 8 players. Each client has one RTCPeerConnection
to the host with two data channels: `rel` (ordered, reliable: lobby, chat, race control, results) and `fast` (unordered,
maxRetransmits 0: car state 20–30 Hz). Host relays other players' car states to everyone.
Over the server relay (newest 'fast' packet per type wins, ~6–7 posts/s) the host sends each relayed guest ONE merged
packet with every car (forwarding per-car packets made them overwrite each other: ~3–4 Hz per car, 0.5 s gaps), guests
receive through one streamed response when the server streams (`relay.js` `streamDown`), relayed guests fan their own
car out to each other (`client.sendTo`, server `fanout:true`; fast-only frames `{t:'_r', x:1, f}`), and every remote car
plays from a jitter buffer sized from the measured arrival gaps (0.1 s direct … ≤1.2 s relay). `tests/net-lag.test.js`
runs all of it on `loopback({relay})` (the real relay scheduler on a virtual server); `tests/net-arcade-stunt-lag.test.js`
does the same for arcade stunt races (exact input replay, track-space / phase-aware corrections, puppets in track space,
warps as teleports — ARCADE-SPEC §6 Reconciliation).

## Files
| File | Namespace | Purpose |
|---|---|---|
| `api/signal.js` | Vercel Node function | `POST /api/signal` actions: `create` (→ 5-char room code, host token), `join`, `post` (append message to a peer's mailbox), `poll` (long-ish poll ≤ 8 s, returns & deletes messages), `close`. Room TTL 2 h, mailbox TTL 2 min, per-IP rate limit, payload cap 64 KB, CORS same-origin. Returns `{ok:false, code:'no-backend'}` when env vars missing. |
| `js/net/signal.js` | `CB.net.signal` | Client signalling backends with one interface: `create()`, `join(code)`, `send(toPeer, msg)`, `onMessage(fn)`, `close()`. Backends: `vercel` (fetch /api/signal + poll loop), `local` (BroadcastChannel), `manual` (encodes SDP+ICE into compact copyable codes; base64url + deflate-free compaction). Auto-detect: try vercel → else manual. |
| `js/net/transport.js` | `CB.net.transport` | WebRTC wrapper: `host(signal)` / `connect(signal)` → peer objects with `send(channel, obj)`, `on(type, fn)`, RTT/clock-offset estimation (ping), connection state, reconnect attempts, clean close. Binary packing helpers for car state (Float32/Int16 quantised). In-memory loopback transport for Node tests. |
| `js/net/netrace.js` | `CB.net.race` | Multiplayer race/drift sessions over the transport, wrapping `CB.race.engine` / `CB.race.drift.createSession`: host runs race control (grid, countdown, lights, laps, positions, penalties, finish, results) and optional AI fill cars; each client simulates its own car locally (using the same vehicle physics + its own build) and streams state; remote cars are rendered from interpolated snapshots (~100 ms buffer, extrapolation cap) and act as kinematic obstacles for collisions (soft push). Modes: Race; Drift battle (tandem lead/chase scoring, swap roles); Free roam. Exposes the same `update(dt, input)` / `snapshot()` / `results()` surface as engine sessions so race-ui/renderer3d/hud work unchanged. |
| `js/net/netarcade.js` | `CB.net.arcade` | Arcade multiplayer (lobby mode `arcade`): the host simulates every car (remote players from their replayed input stream, delayed by an adaptive D), owns items / hits / pickups / laps / results; clients predict their own car and reconcile against the host, other cars interpolated. See ARCADE-SPEC.md §6. |
| `js/net/lobby.js` | `CB.net.lobby` | Route `#/multiplayer` (and `#/multiplayer/<code>` deep link to join): create/join room, connection method (Online / Invite code / Same device), player list with car cards (each player's current Atelier build, real model name, hp/weight), ready toggles, host settings (mode race/drift, track, laps, AI fill count, weather/time, assists allowed), text chat, kick, start → hands a netrace session to `CB.race.ui` (via a documented hook) ; results return to lobby for a rematch. Same design tokens as the rest of the game (css/styles.css). |

## Messages (rel channel, JSON) — `{t, ...}`
`hello{name, build, version}` · `roster{players:[{id,name,build,ready,ping}]}` · `ready{v}` · `chat{text}` · `settings{...}` ·
`start{cfg, seed, t0}` (host clock) · `lights{n}` · `go{t}` · `lap{id,lap,time}` · `finish{id,time}` · `results{...}` ·
`kick{}` · `bye{}`. Fast channel: packed car state `{id, t, x, y, heading, vx, vy, yawRate, steer, throttle, brake, gear, rpm, flags}`.
Protocol version string in `hello`; mismatches are rejected with a friendly message.

## Vercel deploy
`vercel.json` (clean URLs off, cache headers for /js /css, `api/` functions node runtime), `.vercelignore` (tests/, scratch,
specs optional). README "Deploy to Vercel" + "Enable online multiplayer (Upstash)" sections. A local dev helper
`tools/dev-server.js` (zero-dep Node) serves the static site AND implements `/api/signal` with an in-memory store so online
mode can be tested locally without Vercel.
