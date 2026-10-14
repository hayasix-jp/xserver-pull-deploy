<?php
// server/kick.php → <docroot>/_deploy/kick.php. Part of xserver-pull-deploy (MIT).
// Installed only by a PC deploy (`xpd deploy`; __BASE__ is replaced with the absolute ~/.deploy/<name>). The deploy
// rsync never touches /_deploy/.
//
// GitHub Actions POSTs here right after it pushed a new bundle, so the server looks at GitHub now instead of at the
// next cron minute. It reads NO input and needs no secret: all it can do is make pull.sh check GitHub sooner, and
// pull.sh trusts nothing it downloads. At most one start per 10 seconds.
//   POST → 202 {"state":"queued"} | 202 {"state":"busy"} (a pull is running) | 429 {"state":"rate_limited"}
//   other methods → 405. When PHP may not start processes (exec disabled, WAF), it still answers "queued": the
//   cron run picks the bundle up within a minute.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');

function kick_reply($code, $state)
{
    http_response_code($code);
    echo '{"state":"' . $state . '"}', "\n";
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    kick_reply(405, 'method_not_allowed');
}

$base = '__BASE__';
if (strpos($base, '__') === 0 || !is_file($base . '/pull.sh')) {
    kick_reply(503, 'unavailable');
}

// 10-second rate limit: one stamp file, updated under an exclusive lock
$stamp = @fopen($base . '/.kick', 'c');
if ($stamp === false || !flock($stamp, LOCK_EX | LOCK_NB)) {
    kick_reply(429, 'rate_limited');
}
clearstatcache(true, $base . '/.kick');
$last = (int) @filemtime($base . '/.kick');
if ($last > 0 && time() - $last < 10 && filesize($base . '/.kick') > 0) {
    kick_reply(429, 'rate_limited');
}
ftruncate($stamp, 0);
fwrite($stamp, (string) time());
fflush($stamp);
touch($base . '/.kick');

// a pull already running (pull.sh holds .pull.lock with flock, or .pull.lock.d without it) will be followed by cron
$lock = @fopen($base . '/.pull.lock', 'c');
$busy = is_dir($base . '/.pull.lock.d');
if ($lock !== false) {
    if (flock($lock, LOCK_EX | LOCK_NB)) {
        flock($lock, LOCK_UN);
    } else {
        $busy = true;
    }
    fclose($lock);
}
if ($busy) {
    kick_reply(202, 'busy');
}

$disabled = array_map('trim', explode(',', strtolower((string) ini_get('disable_functions'))));
if (function_exists('exec') && !in_array('exec', $disabled, true)) {
    $out = array();
    $rc = 0;
    @exec('nohup /bin/sh ' . escapeshellarg($base . '/pull.sh') . ' kick >/dev/null 2>&1 &', $out, $rc);
}
kick_reply(202, 'queued');
