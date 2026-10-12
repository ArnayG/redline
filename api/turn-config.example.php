<?php
/* ==========================================================================
   Redline — api/turn-config.example.php   (template; safe to publish, holds no secrets)

   TURN lets the phone wheel and online rooms connect browser-to-browser on networks that block direct links
   (campus / hotel Wi-Fi, strict NATs): ~20–60 ms instead of the ~200 ms server relay.

   1. Rename (or copy) this file to   api/turn-config.php   (same folder, next to signal.php). On cPanel: File
      Manager -> public_html/RacingGame/api/ -> right-click turn-config.example.php -> Rename -> turn-config.php ->
      right-click it -> Edit, and paste your key(s) below. (A later zip brings the example back; harmless.)
   2. Pick ONE provider and fill in its keys. Free options:
        Cloudflare Realtime TURN (first 1,000 GB/month free; the wheel uses well under 1 GB/hour):
          dash.cloudflare.com -> Realtime -> TURN Server -> Create -> copy the "Turn Token ID" (keyId) and the
          "API Token" (apiToken).
        Metered.ca (free plan, see metered.ca/pricing): sign up at dashboard.metered.ca, create an app; the app name
          is the part before .metered.live; Developers / TURN credentials -> copy the API key (apiKey).
        Your own coturn server, or any provider's fixed username / password: use 'static'.
   3. Check it: the game shows "Connected (via TURN)" when it is used.

   turn-config.php is NOT in git and NOT in the release zip, so uploading and extracting a new zip over the folder
   keeps it. signal.php mints short-lived credentials from these keys and only ever sends {urls, username,
   credential} to browsers; the API token / key never leaves the server. The file is also denied by .htaccess.
   ========================================================================== */
return array(
  // 'cloudflare' | 'metered' | 'static' | 'none'   <- change this to the provider you filled in
  'provider' => 'none',

  'cloudflare' => array(
    'keyId' => '',       // Turn Token ID
    'apiToken' => '',    // API Token (secret)
    'ttl' => 86400       // seconds each minted credential stays valid
  ),

  'metered' => array(
    'app' => '',         // e.g. 'redline' for https://redline.metered.live
    'apiKey' => ''       // secret
  ),

  // 'static' (or a fallback when the provider is down): fixed credentials, sent to the browser as they are
  'static' => array(
    // array(
    //   'urls' => array('turn:turn.example.com:3478?transport=udp', 'turn:turn.example.com:3478?transport=tcp',
    //                   'turns:turn.example.com:443?transport=tcp'),
    //   'username' => 'user',
    //   'credential' => 'password'
    // )
  )
);
