<?php
/* ==========================================================================
   FORGE Atelier — api/signal.php
   WebRTC signalling relay for multiplayer and the phone wheel, for plain PHP hosting (GoDaddy / cPanel / any
   Apache + PHP 7.4–8.x). Same JSON protocol as api/signal.js (docs/NET-SPEC.md); no extensions, no database, no Composer.
   Storage: small JSON files guarded by flock() in api/_data/ (created on first use, with its own .htaccess deny +
   index.html, and every file starts with "<?php exit; ?>" so it is never readable over HTTP even if .htaccess is
   ignored). Falls back to sys_get_temp_dir() when api/_data is not writable. Expired rooms / mailboxes / rate
   counters are garbage-collected at most once a minute.

   POST api/signal.php  (JSON body; GET == {action:'status'})
     {action:'status'}                                  -> {ok, backend:'php', version, storage, limits}
     {action:'create', name?}                           -> {ok, room:'ABCDE', peer:'host', token, ttl}
     {action:'join', room}                              -> {ok, room, peer:'p…', host:'host', token, ttl}
     {action:'post', room, token, to, msg | msgs:[…]}   -> {ok, n}      host may post to any peer, peers only to 'host'
     {action:'poll', room, token, wait?, busy?, idle?}  -> {ok, msgs:[{from, msg, ts}]}   waits up to min(wait, 5000) ms
     {action:'close', room, token}                      -> {ok}         host: deletes room (peers get {t:'_closed'});
                                                                        peer: leaves (host gets {t:'_leave'})
     {action:'relay', room, token, posts?:[{to, msgs:[…]}], wait?, nopoll?}
                                                        -> {ok, msgs:[…], dropped?:[to…]}   post + poll in ONE request:
                                                           the server-relay fallback (js/net/relay.js) used when WebRTC
                                                           cannot connect. Delivers posts first, then (unless nopoll)
                                                           drains the caller's mailbox, waiting up to min(wait, 5000) ms
                                                           (mailbox checked every 10 ms). Own rate bucket (relayPerIp).
       + stream:1 -> 200 application/x-ndjson, one JSON object per line, flushed as mail arrives (streamed downlink):
            {"ok":true,"stream":1,"max":ms,"st":ms} {"m":[msg…],"st":ms} {"hb":1,"st":ms} … {"end":1,"st":ms}
          open for at most min(wait, streamMax); st = server clock (the client detects a buffering proxy from it).
          + probe:1 (with nopoll) -> header, two heartbeats 300 ms apart, end; no mailbox is touched.
     {action:'ice', room, token}                        -> {ok, iceServers:[{urls, username?, credential?}], ttl, provider}
                                                           TURN/STUN servers from api/turn-config.php (not in git, not
                                                           in the zip; see api/turn-config.example.php). Short-lived
                                                           credentials are minted here (Cloudflare / Metered); API keys
                                                           never leave the server. No config -> iceServers [].
   Errors: {ok:false, code, error}  codes: no-backend, bad-request, bad-action, too-large, not-found, full, auth,
           forbidden, rate-limited, room-closed, backend-error.
   Limits: room TTL 2 h (sliding on host activity), mailbox TTL 2 min, body ≤ 64 KB, ≤ 32 msgs per post,
           ≤ 256 queued msgs per mailbox, 8 players per room, per-IP rate limits. Same-origin only (no CORS headers).
   Env (optional, for tests): FORGE_SIGNAL_DATA = storage directory, FORGE_TURN_CONFIG = TURN config file path.
   ========================================================================== */

define('FG_VERSION', 'forge-signal/1');
define('FG_ALPHABET', 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'); // no I, L, O, 0, 1
define('FG_GUARD', "<?php exit; ?>\n");

$FG_LIMITS = array(
  'roomTtl' => 7200,      // s
  'mailboxTtl' => 120,    // s
  'bodyBytes' => 65536,
  'msgsPerPost' => 32,
  'mailboxMax' => 256,
  'maxPlayers' => 8,      // including host
  'pollMaxWait' => 5000,  // ms — kept short for shared hosts (each waiting poll holds a PHP worker); the client loops
  'rateWindow' => 60,     // s
  'ratePerIp' => 600,     // requests / window / IP (signalling actions; relay has its own bucket)
  'createPerIp' => 12,
  'joinPerIp' => 40,
  'relayPerIp' => 7200,   // relay requests / window / IP (phone + computer on one NAT at ≤ ~30 req/s each, or an
                          // 8-player room behind one NAT at ~10–14 req/s each)
  'relayPosts' => 8,      // destinations per relay request
  'relayMsgs' => 64,      // messages per relay request (all destinations)
  'relayStep' => 10,      // ms between mailbox checks while a relay request waits (a cheap stat(); the file is read
                          // only once it exists)
  'pollStep' => 25,       // ms between mailbox checks for the signalling 'poll' action (busy: during negotiation)
  'streamMax' => 12000,   // ms a streamed relay downlink stays open (one PHP worker, like a long-poll)
  'streamBeat' => 1000,   // ms between heartbeat lines on a stream (also detects a closed tab: the write fails)
  'icePerIp' => 30,       // 'ice' (TURN credentials) requests / window / IP
  'iceCache' => 3600      // s: minted TURN credentials are reused (at most half their lifetime)
);

/* ------------------------------------------------------------------ output */

function fg_json($v) {
  $flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;
  if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
  if (defined('JSON_PRESERVE_ZERO_FRACTION')) $flags |= JSON_PRESERVE_ZERO_FRACTION;
  $s = json_encode($v, $flags);
  return $s === false ? 'null' : $s;
}
function fg_send_raw($status, $body) {
  if (!headers_sent()) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('X-Robots-Tag: noindex');
  }
  echo $body;
  exit;
}
function fg_send($status, $obj) { fg_send_raw($status, fg_json($obj)); }
function fg_fail($status, $code, $error = null) {
  fg_send($status, array('ok' => false, 'code' => $code, 'error' => $error === null ? $code : $error));
}

/* ------------------------------------------------------------------ helpers */

function fg_now_ms() { return (int) floor(microtime(true) * 1000); }
function fg_rand_code($n) {
  $b = random_bytes($n); $s = '';
  for ($i = 0; $i < $n; $i++) $s .= FG_ALPHABET[ord($b[$i]) % strlen(FG_ALPHABET)];
  return $s;
}
function fg_rand_token() { return rtrim(strtr(base64_encode(random_bytes(18)), '+/', '-_'), '='); }
function fg_rand_peer() { return 'p' . strtolower(fg_rand_code(6)); }
function fg_safe_eq($a, $b) { $a = (string) $a; $b = (string) $b; return $a !== '' && strlen($a) === strlen($b) && hash_equals($a, $b); }
function fg_norm_room($r) {
  if (!is_string($r)) return null;
  $r = preg_replace('/[^A-Z0-9]/', '', strtoupper(trim($r)));
  return preg_match('/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/', $r) ? $r : null;
}
function fg_valid_peer($p) { return is_string($p) && ($p === 'host' || preg_match('/^p[a-z0-9]{6}$/', $p)); }

function fg_is_public_ip($ip) {
  return (bool) filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
}
/** REMOTE_ADDR, unless it is a private/loopback proxy address — then the first X-Forwarded-For hop. */
function fg_client_ip() {
  $ra = isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : 'unknown';
  if (!fg_is_public_ip($ra)) {
    $xf = isset($_SERVER['HTTP_X_FORWARDED_FOR']) ? trim(explode(',', (string) $_SERVER['HTTP_X_FORWARDED_FOR'])[0]) : '';
    if ($xf !== '' && filter_var($xf, FILTER_VALIDATE_IP)) return $xf;
    if (!empty($_SERVER['HTTP_X_REAL_IP']) && filter_var($_SERVER['HTTP_X_REAL_IP'], FILTER_VALIDATE_IP)) return (string) $_SERVER['HTTP_X_REAL_IP'];
  }
  return $ra;
}

function fg_same_origin() {
  if (!isset($_SERVER['HTTP_ORIGIN']) || $_SERVER['HTTP_ORIGIN'] === '') return true; // same-origin GETs / old browsers
  $origin = (string) $_SERVER['HTTP_ORIGIN'];
  if ($origin === 'null') return false; // sandboxed / file:// pages are not us
  $u = parse_url($origin);
  if (!$u || empty($u['host'])) return false;
  $oh = strtolower($u['host']);
  if (isset($u['port'])) {
    $default = (isset($u['scheme']) && strtolower($u['scheme']) === 'https') ? 443 : 80;
    if ((int) $u['port'] !== $default) $oh .= ':' . $u['port'];
  }
  $hosts = array();
  if (!empty($_SERVER['HTTP_X_FORWARDED_HOST'])) $hosts[] = trim(explode(',', (string) $_SERVER['HTTP_X_FORWARDED_HOST'])[0]);
  if (!empty($_SERVER['HTTP_HOST'])) $hosts[] = (string) $_SERVER['HTTP_HOST'];
  // Lenient fallback for proxies / CDNs that rewrite Host: same host name ignoring the port and a leading "www."
  // (example.com vs www.example.com, example.com:8443 behind a TLS proxy). Still rejects every other site.
  $bare = preg_replace('/^www\./', '', strtolower($u['host']));
  foreach ($hosts as $h) {
    $h = strtolower(trim($h));
    $h = preg_replace('/:(80|443)$/', '', $h);
    if ($h === $oh) return true;
    if (preg_replace('/^www\./', '', preg_replace('/:\d+$/', '', $h)) === $bare) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ storage (flock'd JSON files) */

function fg_protect_dir($d) {
  $ht = $d . '/.htaccess';
  if (!is_file($ht)) {
    @file_put_contents($ht, "# FORGE signalling data — never served over HTTP\n" .
      "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n" .
      "<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n" .
      "Options -Indexes\n");
  }
  if (!is_file($d . '/index.html')) @file_put_contents($d . '/index.html', '');
}

/** -> [dir, kind] or null. */
function fg_data_dir() {
  static $cached = false;
  if ($cached !== false) return $cached;
  $cands = array();
  $env = getenv('FORGE_SIGNAL_DATA');
  if ($env) $cands[] = array(rtrim($env, '/\\'), 'env');
  $cands[] = array(__DIR__ . '/_data', 'files');
  $tmp = @sys_get_temp_dir();
  if ($tmp) $cands[] = array(rtrim($tmp, '/\\') . '/forge-signal-' . substr(sha1(__DIR__), 0, 12), 'tmp');
  foreach ($cands as $c) {
    $d = $c[0];
    if (!@is_dir($d)) @mkdir($d, 0755, true);
    if (@is_dir($d) && @is_writable($d)) {
      fg_protect_dir($d);
      return $cached = $c;
    }
  }
  return $cached = null;
}

function fg_decode($raw) {
  if ($raw === false || $raw === '') return null;
  if (strncmp($raw, FG_GUARD, strlen(FG_GUARD)) === 0) $raw = substr($raw, strlen(FG_GUARD));
  $d = json_decode($raw, true);
  return is_array($d) ? $d : null;
}
function fg_encode_file($data) { return FG_GUARD . fg_json($data); }

/** Read without an exclusive lock (shared lock). -> array|null */
function fg_read($path) {
  $fh = @fopen($path, 'r');
  if (!$fh) return null;
  @flock($fh, LOCK_SH);
  $raw = stream_get_contents($fh);
  @flock($fh, LOCK_UN);
  fclose($fh);
  return fg_decode($raw);
}

define('FG_KEEP', '__keep__');
define('FG_DELETE', '__delete__');
/**
 * Read-modify-write under LOCK_EX. $fn(array|null $data) returns [newData | FG_KEEP | FG_DELETE, result].
 * $create: create the file if missing. Returns [true, result] or [false, null] if the file could not be opened.
 */
function fg_update($path, $create, $fn) {
  $fh = @fopen($path, $create ? 'c+' : 'r+');
  if (!$fh) return array(false, null);
  if (!@flock($fh, LOCK_EX)) { fclose($fh); return array(false, null); }
  $raw = stream_get_contents($fh);
  $out = $fn(fg_decode($raw));
  $nd = $out[0];
  if ($nd === FG_DELETE) {
    ftruncate($fh, 0); // anyone queued on the old inode now reads "empty" == missing
    @unlink($path);
  } elseif ($nd !== FG_KEEP) {
    rewind($fh);
    ftruncate($fh, 0);
    fwrite($fh, fg_encode_file($nd));
    fflush($fh);
  }
  @flock($fh, LOCK_UN);
  fclose($fh);
  return array(true, $out[1]);
}

/* ------------------------------------------------------------------ app */

function fg_paths($dir) {
  return array(
    'room' => function ($r) use ($dir) { return $dir . '/room-' . $r . '.php'; },
    'box' => function ($r, $p) use ($dir) { return $dir . '/mb-' . $r . '-' . $p . '.php'; },
    'rl' => function ($ip) use ($dir) { return $dir . '/rl-' . substr(sha1($ip), 0, 20) . '.php'; }
  );
}

function fg_gc($dir, $force) {
  $stamp = $dir . '/gc.stamp';
  $last = @filemtime($stamp);
  if (!$force && $last && time() - $last < 60) return;
  @touch($stamp);
  $now = time();
  $list = @scandir($dir);
  if (!$list) return;
  $n = 0;
  foreach ($list as $f) {
    if (++$n > 5000) break;
    $p = $dir . '/' . $f;
    if (strncmp($f, 'rl-', 3) === 0) { if (@filemtime($p) < $now - 130) @unlink($p); continue; }
    if (strncmp($f, 'room-', 5) === 0 || strncmp($f, 'mb-', 3) === 0) {
      $mt = @filemtime($p);
      if ($mt && $mt > $now - 100) continue; // touched recently: can't be expired (mailbox TTL 120 s, room 2 h)
      fg_update($p, false, function ($d) use ($now) {
        if (!$d || !isset($d['exp']) || $d['exp'] < $now) return array(FG_DELETE, null);
        return array(FG_KEEP, null);
      });
    }
  }
}

function fg_rate_ok($P, $ip, $kind, $limit, $L) {
  $w = (int) floor(time() / $L['rateWindow']);
  $r = fg_update($P['rl']($ip), true, function ($d) use ($w, $kind) {
    if (!$d || !isset($d['w']) || $d['w'] !== $w) $d = array('w' => $w);
    $d[$kind] = (isset($d[$kind]) ? (int) $d[$kind] : 0) + 1;
    return array($d, $d[$kind]);
  });
  if (!$r[0]) return true; // storage hiccup: don't lock people out
  return $r[1] <= $limit;
}

/** -> array{peer,isHost,room:array} | null (room missing/expired) | false (bad token) */
function fg_auth($P, $room, $token) {
  $d = fg_read($P['room']($room));
  if (!$d || empty($d['host']) || !isset($d['exp']) || $d['exp'] < time()) return null;
  if (fg_safe_eq($d['host'], $token)) return array('peer' => 'host', 'isHost' => true, 'room' => $d);
  $peers = isset($d['peers']) && is_array($d['peers']) ? $d['peers'] : array();
  foreach ($peers as $pid => $tok) if (fg_safe_eq($tok, $token)) return array('peer' => (string) $pid, 'isHost' => false, 'room' => $d);
  return false;
}

/** $items: array of already-encoded JSON strings */
function fg_push($P, $room, $to, $items, $L) {
  $exp = time() + $L['mailboxTtl'];
  $max = $L['mailboxMax'];
  return fg_update($P['box']($room, $to), true, function ($d) use ($items, $exp, $max) {
    if (!$d || !isset($d['exp']) || $d['exp'] < time() || !isset($d['msgs']) || !is_array($d['msgs'])) $d = array('msgs' => array());
    foreach ($items as $it) $d['msgs'][] = $it;
    if (count($d['msgs']) > $max) $d['msgs'] = array_slice($d['msgs'], -$max);
    $d['exp'] = $exp;
    return array($d, count($d['msgs']));
  });
}
function fg_enc_msg($from, $msg) { return fg_json(array('from' => $from, 'msg' => $msg, 'ts' => fg_now_ms())); }

/** Drain up to $n messages (encoded strings) from a mailbox. */
function fg_pop($P, $room, $peer, $n) {
  $path = $P['box']($room, $peer);
  clearstatcache(true, $path);
  if (!@is_file($path)) return array();
  $r = fg_update($path, false, function ($d) use ($n) {
    if (!$d || !isset($d['msgs']) || !is_array($d['msgs']) || (isset($d['exp']) && $d['exp'] < time())) return array(FG_DELETE, array());
    if (!count($d['msgs'])) return array(FG_DELETE, array());
    $take = array_slice($d['msgs'], 0, $n);
    $rest = array_slice($d['msgs'], $n);
    if (!count($rest)) return array(FG_DELETE, $take);
    $d['msgs'] = $rest;
    return array($d, $take);
  });
  return $r[0] && is_array($r[1]) ? $r[1] : array();
}

/** Wait until the mailbox has mail (cheap stat() every $step ms; read only once the file exists) or the deadline. */
function fg_wait_pop($P, $room, $peer, $deadline, $step) {
  $path = $P['box']($room, $peer);
  $got = fg_pop($P, $room, $peer, 64);
  while (!count($got)) {
    $left = $deadline - fg_now_ms();
    if ($left <= 0) break;
    usleep((int) min($step, $left) * 1000);
    if (connection_aborted()) exit;
    clearstatcache(true, $path);
    if (@is_file($path)) $got = fg_pop($P, $room, $peer, 64);
  }
  return $got;
}

/* ------------------------------------------------------------------ streamed relay downlink (NDJSON) */
function fg_stream_begin($max) {
  @ini_set('zlib.output_compression', '0');
  @ini_set('output_buffering', '0');
  @ini_set('implicit_flush', '1');
  if (function_exists('apache_setenv')) { @apache_setenv('no-gzip', '1'); @apache_setenv('dont-vary', '1'); }
  while (ob_get_level() > 0) { if (!@ob_end_flush()) break; }
  if (!headers_sent()) {
    http_response_code(200);
    header('Content-Type: application/x-ndjson; charset=utf-8');
    header('Cache-Control: no-store, no-transform');
    header('X-Accel-Buffering: no');   // nginx-style proxies: do not buffer this response
    header('X-Content-Type-Options: nosniff');
    header('X-Robots-Tag: noindex');
  }
  // the padding helps proxies / FastCGI layers that hold back the first few KB
  fg_stream_line('{"ok":true,"stream":1,"max":' . (int) $max . ',"st":' . fg_now_ms() . '}' . str_repeat(' ', 2048));
}
function fg_stream_line($s) {
  echo $s, "\n";
  @flush();
  if (connection_aborted()) exit;
}
function fg_stream_probe() {
  fg_stream_begin(600);
  usleep(300000); fg_stream_line('{"hb":1,"st":' . fg_now_ms() . '}');
  usleep(300000); fg_stream_line('{"end":1,"st":' . fg_now_ms() . '}');
  exit;
}
function fg_stream($P, $room, $peer, $max, $L) {
  @set_time_limit((int) ceil($max / 1000) + 15);
  fg_stream_begin($max);
  $t0 = fg_now_ms(); $beat = $t0;
  while (true) {
    $now = fg_now_ms();
    if ($now - $t0 >= $max) break;
    $got = fg_wait_pop($P, $room, $peer, min($t0 + $max, $beat + $L['streamBeat']), $L['relayStep']);
    $ok = array();
    foreach ($got as $s) if (is_string($s) && $s !== '' && ($s[0] === '{')) $ok[] = $s;
    if (count($ok)) fg_stream_line('{"m":[' . implode(',', $ok) . '],"st":' . fg_now_ms() . '}');
    if (fg_now_ms() - $beat >= $L['streamBeat']) { $beat = fg_now_ms(); fg_stream_line('{"hb":1,"st":' . $beat . '}'); }
  }
  fg_stream_line('{"end":1,"st":' . fg_now_ms() . '}');
  exit;
}

/* ------------------------------------------------------------------ TURN / ICE servers (api/turn-config.php) */
function fg_turn_config() {
  $f = getenv('FORGE_TURN_CONFIG');
  if (!$f) $f = __DIR__ . '/turn-config.php';
  if (!@is_file($f)) return null;
  $c = @include $f;
  return is_array($c) ? $c : null;
}
/** HTTP for the provider APIs: curl when available, else a stream context. -> [status, body] */
function fg_http($method, $url, $headers, $body) {
  if (function_exists('curl_init')) {
    $ch = curl_init($url);
    curl_setopt_array($ch, array(CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $headers,
      CURLOPT_CONNECTTIMEOUT => 4, CURLOPT_TIMEOUT => 6, CURLOPT_FOLLOWLOCATION => false));
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $out = curl_exec($ch);
    $st = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    if (PHP_VERSION_ID < 80000) curl_close($ch);   // a no-op (deprecated) since PHP 8
    return array($st, $out === false ? '' : (string) $out);
  }
  $ctx = stream_context_create(array('http' => array('method' => $method, 'header' => implode("\r\n", $headers), 'content' => $body === null ? '' : $body,
    'timeout' => 6, 'ignore_errors' => true, 'follow_location' => 0)));
  $out = @file_get_contents($url, false, $ctx);
  // (no curl: PHP < 8.4 cannot read the status here without a deprecated variable; the JSON shape is checked anyway)
  $st = $out === false ? 0 : 200;
  $hdrs = function_exists('http_get_last_response_headers') ? http_get_last_response_headers() : null;
  if (is_array($hdrs) && count($hdrs) && preg_match('#^HTTP/\S+\s+(\d{3})#', (string) $hdrs[0], $mm)) $st = (int) $mm[1];
  return array($st, $out === false ? '' : (string) $out);
}
/** Keep only {urls, username?, credential?}; drop port 53 (browsers block it); make sure TURN over TLS on 443 is offered. */
function fg_ice_clean($list) {
  $out = array(); $hasTls443 = false; $turnHost = null; $cred = null;
  if (isset($list['urls'])) $list = array($list);
  if (!is_array($list)) return $out;
  foreach ($list as $s) {
    if (!is_array($s) || !isset($s['urls'])) continue;
    $urls = is_array($s['urls']) ? $s['urls'] : array($s['urls']);
    $keep = array();
    foreach ($urls as $u) {
      if (!is_string($u) || !preg_match('#^(stun|stuns|turn|turns):#i', $u)) continue;
      if (preg_match('#:53(\?|$)#', $u)) continue;
      if (preg_match('#^turns:[^?]*:443#i', $u)) $hasTls443 = true;
      if (preg_match('#^turn:([^:?]+)#i', $u, $mm)) $turnHost = $mm[1];
      $keep[] = $u;
    }
    if (!count($keep)) continue;
    $e = array('urls' => count($keep) === 1 ? $keep[0] : $keep);
    if (isset($s['username']) && is_string($s['username'])) $e['username'] = $s['username'];
    if (isset($s['credential']) && is_string($s['credential'])) $e['credential'] = $s['credential'];
    if (isset($e['username']) && $cred === null) $cred = $e;
    $out[] = $e;
  }
  // campus firewalls often allow only TCP 443 with TLS: add turns:<host>:443 when the provider listed plain TURN only
  if (!$hasTls443 && $turnHost && $cred) $out[] = array('urls' => 'turns:' . $turnHost . ':443?transport=tcp', 'username' => $cred['username'], 'credential' => $cred['credential']);
  return $out;
}
/** -> [iceServers, ttl, provider]. Never throws; provider errors are logged without secrets. */
function fg_ice_servers($dir, $L) {
  $c = fg_turn_config();
  if (!$c) return array(array(), 3600, 'none');
  $prov = isset($c['provider']) ? strtolower((string) $c['provider']) : 'none';
  $static = isset($c['static']) && is_array($c['static']) ? fg_ice_clean($c['static']) : array();
  if ($prov === 'static') return array($static, 86400, 'static');
  if ($prov !== 'cloudflare' && $prov !== 'metered') return array($static, 86400, count($static) ? 'static' : 'none');
  $cache = $dir . '/ice-cache.php';
  $sig = substr(sha1($prov . '|' . fg_json(isset($c[$prov]) ? $c[$prov] : null)), 0, 16);   // config changed -> new credentials
  $d = fg_read($cache);
  if ($d && isset($d['sig'], $d['exp'], $d['list']) && $d['sig'] === $sig && $d['exp'] > time()) return array($d['list'], max(60, $d['exp'] - time()), $prov);
  $list = array(); $ttl = 0;
  if ($prov === 'cloudflare') {
    $cf = isset($c['cloudflare']) && is_array($c['cloudflare']) ? $c['cloudflare'] : array();
    $id = isset($cf['keyId']) ? preg_replace('/[^A-Za-z0-9_-]/', '', (string) $cf['keyId']) : '';
    $tok = isset($cf['apiToken']) ? (string) $cf['apiToken'] : '';
    $ttl = isset($cf['ttl']) ? max(600, min(172800, (int) $cf['ttl'])) : 86400;
    $base = isset($cf['baseUrl']) ? rtrim((string) $cf['baseUrl'], '/') : 'https://rtc.live.cloudflare.com/v1';
    if ($id !== '' && $tok !== '') {
      $hd = array('Authorization: Bearer ' . $tok, 'Content-Type: application/json');
      // generate-ice-servers lists every port (incl. turns:…:443); the older /generate is the fallback
      $r = fg_http('POST', $base . '/turn/keys/' . $id . '/credentials/generate-ice-servers', $hd, fg_json(array('ttl' => $ttl)));
      if ($r[0] === 404) $r = fg_http('POST', $base . '/turn/keys/' . $id . '/credentials/generate', $hd, fg_json(array('ttl' => $ttl)));
      $j = json_decode($r[1], true);
      if ($r[0] >= 200 && $r[0] < 300 && is_array($j) && isset($j['iceServers'])) $list = fg_ice_clean($j['iceServers']);
      else @error_log('[redline signal] Cloudflare TURN credentials: HTTP ' . $r[0]);
    }
  } else {
    $m = isset($c['metered']) && is_array($c['metered']) ? $c['metered'] : array();
    $app = isset($m['app']) ? preg_replace('/[^A-Za-z0-9-]/', '', (string) $m['app']) : '';
    $key = isset($m['apiKey']) ? (string) $m['apiKey'] : '';
    $ttl = 86400;
    $base = isset($m['baseUrl']) ? rtrim((string) $m['baseUrl'], '/') : ('https://' . $app . '.metered.live');
    if ($app !== '' && $key !== '') {
      $r = fg_http('GET', $base . '/api/v1/turn/credentials?apiKey=' . rawurlencode($key), array('Accept: application/json'), null);
      $j = json_decode($r[1], true);
      if ($r[0] >= 200 && $r[0] < 300 && is_array($j)) $list = fg_ice_clean($j);
      else @error_log('[redline signal] Metered TURN credentials: HTTP ' . $r[0]);
    }
  }
  if (!count($list)) {   // provider down / misconfigured: static fallback (if any); retry the provider in a minute
    fg_update($cache, true, function ($x) use ($sig, $static) { return array(array('sig' => $sig, 'exp' => time() + 60, 'list' => $static), null); });
    return array($static, 60, count($static) ? 'static' : 'none');
  }
  $life = min($L['iceCache'], (int) floor($ttl / 2));
  fg_update($cache, true, function ($x) use ($sig, $life, $list) { return array(array('sig' => $sig, 'exp' => time() + $life, 'list' => $list), null); });
  return array($list, $life, $prov);
}

function fg_prop($b, $k) { return is_object($b) && property_exists($b, $k) ? $b->$k : null; }

function fg_main() {
  global $FG_LIMITS;
  $L = $FG_LIMITS;
  if (function_exists('session_status') && session_status() === PHP_SESSION_ACTIVE) session_write_close();
  @ini_set('display_errors', '0');   // a PHP notice must never corrupt a JSON / NDJSON body
  @ignore_user_abort(true);  // finish writes even if the tab closes mid-request (close beacons, posts)
  @set_time_limit(25);

  $method = isset($_SERVER['REQUEST_METHOD']) ? strtoupper($_SERVER['REQUEST_METHOD']) : 'GET';
  if ($method === 'OPTIONS') { http_response_code(204); header('Allow: GET, POST'); exit; }
  if (!fg_same_origin()) fg_fail(403, 'forbidden', 'cross-origin requests are not allowed');

  if ($method === 'GET' || $method === 'HEAD') {
    $body = (object) array('action' => 'status');
  } elseif ($method === 'POST') {
    $len = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : 0;
    if ($len > $L['bodyBytes']) fg_fail(413, 'too-large', 'payload over 64 KB');
    $raw = @file_get_contents('php://input', false, null, 0, $L['bodyBytes'] + 1);
    if ($raw !== false && strlen($raw) > $L['bodyBytes']) fg_fail(413, 'too-large', 'payload over 64 KB');
    if ($raw === false || trim($raw) === '') $body = new stdClass();
    else {
      $body = json_decode($raw);
      if (json_last_error() !== JSON_ERROR_NONE) fg_fail(400, 'bad-request', 'invalid JSON');
    }
  } else {
    fg_fail(405, 'bad-request', 'method not allowed');
  }
  if (!is_object($body)) fg_fail(400, 'bad-request', 'JSON object expected');
  $action = fg_prop($body, 'action');
  $known = array('status', 'create', 'join', 'post', 'poll', 'close', 'relay', 'ice');
  if (!is_string($action) || !in_array($action, $known, true)) fg_fail(400, 'bad-action', 'unknown action');

  $dd = fg_data_dir();
  if (!$dd) fg_send(200, array('ok' => false, 'code' => 'no-backend', 'error' => 'online signalling storage is not writable (check api/_data permissions)'));
  $dir = $dd[0];
  $P = fg_paths($dir);

  if ($action === 'status') {
    fg_send(200, array('ok' => true, 'backend' => 'php', 'version' => FG_VERSION, 'storage' => $dd[1], 'php' => PHP_VERSION,
      'relay' => true, 'stream' => true, 'ice' => true, 'limits' => array('maxPlayers' => $L['maxPlayers'], 'pollMaxWait' => $L['pollMaxWait'])));
  }

  $ip = fg_client_ip();
  if ($action === 'relay') { if (!fg_rate_ok($P, $ip, 'relay', $L['relayPerIp'], $L)) fg_fail(429, 'rate-limited', 'slow down'); }
  elseif ($action === 'ice') { if (!fg_rate_ok($P, $ip, 'ice', $L['icePerIp'], $L)) fg_fail(429, 'rate-limited', 'slow down'); }
  elseif (!fg_rate_ok($P, $ip, 'all', $L['ratePerIp'], $L)) fg_fail(429, 'rate-limited', 'slow down');
  fg_gc($dir, false);

  /* ---------------- create */
  if ($action === 'create') {
    if (!fg_rate_ok($P, $ip, 'create', $L['createPerIp'], $L)) fg_fail(429, 'rate-limited');
    for ($tries = 0; $tries < 6; $tries++) {
      $code = fg_rand_code(5); $token = fg_rand_token();
      $path = $P['room']($code);
      if (@is_file($path)) {
        $old = fg_read($path);
        if ($old && isset($old['exp']) && $old['exp'] >= time()) continue;
        @unlink($path);
      }
      $fh = @fopen($path, 'x');
      if (!$fh) continue;
      @flock($fh, LOCK_EX);
      fwrite($fh, fg_encode_file(array('host' => $token, 'created' => fg_now_ms(), 'exp' => time() + $L['roomTtl'], 'peers' => new stdClass())));
      fflush($fh);
      @flock($fh, LOCK_UN);
      fclose($fh);
      @unlink($P['box']($code, 'host'));
      fg_send(200, array('ok' => true, 'room' => $code, 'peer' => 'host', 'token' => $token, 'ttl' => $L['roomTtl']));
    }
    fg_fail(503, 'backend-error', 'could not allocate a room code');
  }

  /* ---------------- join */
  if ($action === 'join') {
    if (!fg_rate_ok($P, $ip, 'join', $L['joinPerIp'], $L)) fg_fail(429, 'rate-limited');
    $room = fg_norm_room(fg_prop($body, 'room'));
    if (!$room) fg_fail(400, 'bad-request', 'room code must be 5 characters');
    $peer = fg_rand_peer(); $token = fg_rand_token();
    $max = $L['maxPlayers'];
    $r = fg_update($P['room']($room), false, function ($d) use ($peer, $token, $max) {
      if (!$d || empty($d['host']) || !isset($d['exp']) || $d['exp'] < time()) return array(FG_KEEP, 'not-found');
      $peers = isset($d['peers']) && is_array($d['peers']) ? $d['peers'] : array();
      if (count($peers) + 1 >= $max) return array(FG_KEEP, 'full');
      $peers[$peer] = $token;
      $d['peers'] = $peers;
      return array($d, 'ok');
    });
    if (!$r[0] || $r[1] === 'not-found') fg_fail(404, 'not-found', 'no such room (it may have expired)');
    if ($r[1] === 'full') fg_fail(409, 'full', 'room is full');
    fg_send(200, array('ok' => true, 'room' => $room, 'peer' => $peer, 'host' => 'host', 'token' => $token, 'ttl' => $L['roomTtl']));
  }

  $room = fg_norm_room(fg_prop($body, 'room'));
  $token = fg_prop($body, 'token');
  if (!$room || !is_string($token)) fg_fail(400, 'bad-request');

  /* ---------------- post */
  if ($action === 'post') {
    $msgs = fg_prop($body, 'msgs');
    if (is_array($msgs)) $list = $msgs;
    elseif (is_object($body) && property_exists($body, 'msg')) $list = array($body->msg);
    else $list = null;
    if (!$list) fg_fail(400, 'bad-request', 'msg or msgs required');
    if (count($list) > $L['msgsPerPost']) fg_fail(413, 'too-large', 'too many messages');
    $to = fg_prop($body, 'to');
    if (!fg_valid_peer($to)) fg_fail(400, 'bad-request', 'bad recipient');
    $a = fg_auth($P, $room, $token);
    if ($a === null) fg_fail(410, 'room-closed', 'room closed');
    if ($a === false) fg_fail(403, 'auth', 'bad token');
    if ($to === $a['peer']) fg_fail(400, 'bad-request', 'cannot post to yourself');
    if (!$a['isHost'] && $to !== 'host') fg_fail(403, 'forbidden', 'peers may only message the host');
    if ($to !== 'host' && !isset($a['room']['peers'][$to])) fg_fail(404, 'not-found', 'no such peer');
    $items = array();
    foreach ($list as $m) $items[] = fg_enc_msg($a['peer'], $m);
    $r = fg_push($P, $room, $to, $items, $L);
    if (!$r[0]) fg_fail(502, 'backend-error', 'signalling storage error');
    fg_send(200, array('ok' => true, 'n' => count($list)));
  }

  /* ---------------- poll */
  if ($action === 'poll') {
    $wait = (int) max(0, min($L['pollMaxWait'], (float) fg_prop($body, 'wait')));
    $a = fg_auth($P, $room, $token);
    if ($a === null) fg_fail(410, 'room-closed', 'room closed');
    if ($a === false) fg_fail(403, 'auth', 'bad token');
    if ($a['isHost'] && $a['room']['exp'] - time() < $L['roomTtl'] - 30) {
      $ttl = $L['roomTtl'];
      fg_update($P['room']($room), false, function ($d) use ($ttl) {
        if (!$d || empty($d['host'])) return array(FG_KEEP, null);
        $d['exp'] = time() + $ttl;
        return array($d, null);
      });
    }
    $step = fg_prop($body, 'idle') && !fg_prop($body, 'busy') ? 200 : $L['pollStep'];
    $got = fg_wait_pop($P, $room, $a['peer'], fg_now_ms() + $wait, $step);
    // messages are stored pre-encoded: splice them in verbatim so {} / [] / numbers survive exactly
    $ok = array();
    foreach ($got as $s) if (is_string($s) && $s !== '' && ($s[0] === '{')) $ok[] = $s;
    fg_send_raw(200, '{"ok":true,"msgs":[' . implode(',', $ok) . ']}');
  }

  /* ---------------- relay (post + poll in one request; WebRTC fallback) */
  if ($action === 'relay') {
    $wait = (int) max(0, min($L['pollMaxWait'], (float) fg_prop($body, 'wait')));
    $posts = fg_prop($body, 'posts');
    if ($posts !== null && !is_array($posts)) fg_fail(400, 'bad-request', 'posts must be an array');
    $posts = $posts ? $posts : array();
    if (count($posts) > $L['relayPosts']) fg_fail(413, 'too-large', 'too many destinations');
    $total = 0;
    foreach ($posts as $p) {
      $pm = fg_prop($p, 'msgs');
      if (!fg_valid_peer(fg_prop($p, 'to')) || !is_array($pm)) fg_fail(400, 'bad-request', 'bad post');
      $total += count($pm);
    }
    if ($total > $L['relayMsgs']) fg_fail(413, 'too-large', 'too many messages');
    $a = fg_auth($P, $room, $token);
    if ($a === null) fg_fail(410, 'room-closed', 'room closed');
    if ($a === false) fg_fail(403, 'auth', 'bad token');
    $dropped = array();
    foreach ($posts as $p) {
      $to = fg_prop($p, 'to'); $pm = fg_prop($p, 'msgs');
      if (!count($pm)) continue;
      // a peer that left (or a host-only rule) drops just that destination, never the whole request
      if ($to === $a['peer'] || (!$a['isHost'] && $to !== 'host') || ($to !== 'host' && !isset($a['room']['peers'][$to]))) { $dropped[] = $to; continue; }
      $items = array();
      foreach ($pm as $m) $items[] = fg_enc_msg($a['peer'], $m);
      $r = fg_push($P, $room, $to, $items, $L);
      if (!$r[0]) fg_fail(502, 'backend-error', 'signalling storage error');
    }
    if ($a['isHost'] && $a['room']['exp'] - time() < $L['roomTtl'] - 60) {
      $ttl = $L['roomTtl'];
      fg_update($P['room']($room), false, function ($d) use ($ttl) {
        if (!$d || empty($d['host'])) return array(FG_KEEP, null);
        $d['exp'] = time() + $ttl;
        return array($d, null);
      });
    }
    if (fg_prop($body, 'stream')) {
      if (fg_prop($body, 'probe')) fg_stream_probe();
      if (!fg_prop($body, 'nopoll')) fg_stream($P, $room, $a['peer'], min($L['streamMax'], max(1000, (int) fg_prop($body, 'wait'))), $L);
    }
    $got = array();
    if (!fg_prop($body, 'nopoll')) $got = fg_wait_pop($P, $room, $a['peer'], fg_now_ms() + $wait, $L['relayStep']);
    $ok = array();
    foreach ($got as $s) if (is_string($s) && $s !== '' && ($s[0] === '{')) $ok[] = $s;
    fg_send_raw(200, '{"ok":true,"msgs":[' . implode(',', $ok) . ']' . (count($dropped) ? ',"dropped":' . fg_json($dropped) : '') . '}');
  }

  /* ---------------- ice (TURN servers for WebRTC; credentials minted here, API keys never sent) */
  if ($action === 'ice') {
    $a = fg_auth($P, $room, $token);
    if ($a === null) fg_fail(410, 'room-closed', 'room closed');
    if ($a === false) fg_fail(403, 'auth', 'bad token');
    $r = fg_ice_servers($dir, $L);
    fg_send(200, array('ok' => true, 'iceServers' => $r[0], 'ttl' => $r[1], 'provider' => $r[2]));
  }

  /* ---------------- close */
  if ($action === 'close') {
    $a = fg_auth($P, $room, $token);
    if ($a === null) fg_send(200, array('ok' => true, 'already' => true));
    if ($a === false) fg_fail(403, 'auth', 'bad token');
    if ($a['isHost']) {
      $peers = array();
      fg_update($P['room']($room), false, function ($d) use (&$peers) {
        if ($d && isset($d['peers']) && is_array($d['peers'])) $peers = array_keys($d['peers']);
        return array(FG_DELETE, null);
      });
      @unlink($P['box']($room, 'host'));
      foreach ($peers as $p) fg_push($P, $room, (string) $p, array(fg_enc_msg('host', array('t' => '_closed'))), $L);
    } else {
      $me = $a['peer'];
      fg_update($P['room']($room), false, function ($d) use ($me) {
        if (!$d || !isset($d['peers']) || !is_array($d['peers'])) return array(FG_KEEP, null);
        unset($d['peers'][$me]);
        if (!count($d['peers'])) $d['peers'] = new stdClass();
        return array($d, null);
      });
      @unlink($P['box']($room, $me));
      fg_push($P, $room, 'host', array(fg_enc_msg($me, array('t' => '_leave'))), $L);
    }
    fg_send(200, array('ok' => true));
  }

  fg_fail(400, 'bad-action', 'unknown action');
}

try {
  fg_main();
} catch (Throwable $e) {
  @error_log('[forge signal] ' . $e->getMessage());
  fg_fail(502, 'backend-error', 'signalling backend error');
}
