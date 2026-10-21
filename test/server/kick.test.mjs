// server/kick.php — runs only where PHP is installed (php -l; php-cgi for the HTTP behaviour). Skipped otherwise.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ROOT, tmp, write } from '../helpers/env.mjs';

const has = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).status === 0;
const PHP = has('php', ['-v']);
const CGI = has('php-cgi', ['-v']);

describe('kick.php', { skip: !PHP && 'php is not installed' }, () => {
  test('lints', () => {
    const r = spawnSync('php', ['-l', join(ROOT, 'server', 'kick.php')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  const cgi = (dir, method) => {
    const r = spawnSync('php-cgi', ['-f', join(dir, 'kick.php')], {
      encoding: 'utf8', env: { ...process.env, REQUEST_METHOD: method, REDIRECT_STATUS: '200', SCRIPT_FILENAME: join(dir, 'kick.php') },
    });
    return { status: Number((r.stdout.match(/^Status: (\d+)/m) || [])[1] || 200), body: r.stdout.split(/\r?\n\r?\n/).slice(1).join('\n').trim() };
  };

  test('GET → 405; POST → 202 queued, then 429 within 10 s; 503 without pull.sh', { skip: !CGI && 'php-cgi is not installed' }, () => {
    const base = tmp('xpd-kick-');
    const dir = tmp('xpd-kickdoc-');
    write(join(base, 'pull.sh'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(dir, 'kick.php'), readFileSync(join(ROOT, 'server', 'kick.php'), 'utf8').replaceAll('__BASE__', base.replace(/\\/g, '/')));
    assert.equal(cgi(dir, 'GET').status, 405);
    const first = cgi(dir, 'POST');
    assert.equal(first.status, 202);
    assert.match(first.body, /"state":"(queued|busy)"/);
    assert.equal(cgi(dir, 'POST').status, 429);
    const empty = tmp('xpd-kickempty-');
    writeFileSync(join(empty, 'kick.php'), readFileSync(join(ROOT, 'server', 'kick.php'), 'utf8').replaceAll('__BASE__', '/nonexistent'));
    assert.equal(cgi(empty, 'POST').status, 503);
  });
});
