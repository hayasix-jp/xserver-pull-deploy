// server/remote-deploy.sh against a fake docroot (real rsync when available, else test/fakes/rsync.mjs).
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { makeUpload, meta, siteFiles } from '../helpers/bundles.mjs';
import { randomSha } from '../helpers/fake-github.mjs';
import {
  existsSync, fakeServer, HAS_FLOCK, installServerScripts, read, readJson, ROOT, run, runServer, SH, serverPath, shPath, write,
} from '../helpers/env.mjs';

const deploy = (s, up, keep = '3', ...flags) => runServer(s, 'remote-deploy.sh', ['deploy', shPath(up), s.shDocroot, keep, ...flags]);
const releases = (s) => readdirSync(join(s.base, 'releases')).sort();
const current = (s) => read(join(s.base, 'current')).trim();
const setup = () => {
  const s = fakeServer();
  installServerScripts(s);
  return s;
};

describe('remote-deploy.sh', { skip: !SH && 'no sh' }, () => {
  test('first deploy: publishes, deletes nothing, backs up the original docroot, writes live.json/meta.json, logs', async () => {
    const s = setup();
    write(join(s.docroot, 'index.html'), 'placeholder from the panel');
    write(join(s.docroot, 'default_page.png'), 'png');
    write(join(s.docroot, 'blog/wp-config.php'), 'a subdomain site living inside public_html');
    write(join(s.docroot, '.well-known/acme-challenge/token'), 'acme');
    const commit = randomSha();
    const r = await deploy(s, makeUpload(s.base, siteFiles(), meta(commit, { dirty: true })));
    assert.equal(r.code, 0, r.out);
    assert.match(read(join(s.docroot, 'index.html')), /<h1>v1<\/h1>/, 'same-named files are overwritten');
    assert.equal(read(join(s.docroot, 'default_page.png')), 'png', 'the first deploy never deletes what was there');
    assert.equal(read(join(s.docroot, 'blog/wp-config.php')), 'a subdomain site living inside public_html');
    assert.match(r.out, /保護（初回のデプロイなので、元からあるファイルは消しません）: blog\//);
    assert.equal(read(join(s.docroot, '.well-known/acme-challenge/token')), 'acme', '.well-known is never touched');
    assert.equal(read(join(s.base, 'original/default_page.png')), 'png', 'original files backed up');
    const live = readJson(join(s.docroot, '_deploy/live.json'));
    assert.equal(live.commit, commit);
    assert.equal(live.source, 'local');
    assert.equal(live.dirty, true);
    assert.equal(live.release, current(s));
    assert.match(live.published_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    assert.equal(readJson(join(s.docroot, '_deploy/meta.json')).commit, commit);
    assert.deepEqual(readdirSync(join(s.docroot, '_deploy')).sort(), ['live.json', 'meta.json'], 'no tmp files left (tmp → mv)');
    assert.match(read(join(s.base, 'deploy.log')), new RegExp(`\\t${current(s)}\\tlocal\\t${commit}`));
    assert.deepEqual(readdirSync(join(s.base, 'incoming')), [], 'the upload was moved into releases/');
  });

  test('second deploy: swaps changed files, deletes removed ones, keeps foreign files and protect paths', async () => {
    const s = setup();
    writeFileSync(join(s.base, 'protect.list'), '/.well-known/\n/_deploy/\n/uploads/\n../evil\n');
    const v1 = { ...siteFiles(), 'old.html': 'old', 'uploads/from-v1.jpg': 'in bundle but protected' };
    assert.equal((await deploy(s, makeUpload(s.base, v1))).code, 0);
    assert.ok(!existsSync(join(s.docroot, 'uploads/from-v1.jpg')), 'protected paths are never written by a deploy');
    // things put on the server by hand / by the site itself
    write(join(s.docroot, 'google1234.html'), 'verification');
    write(join(s.docroot, 'sub/index.html'), 'subdomain folder');
    write(join(s.docroot, 'uploads/user.jpg'), 'user upload');
    write(join(s.docroot, '_deploy/kick.php'), '<?php');
    const r = await deploy(s, makeUpload(s.base, siteFiles({ title: 'v2' })));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /警告: protect\.list の行を無視します: \.\.\/evil/);
    assert.match(r.out, /保護（デプロイ以外で置かれたファイルなので残します）: google1234\.html/);
    assert.match(read(join(s.docroot, 'index.html')), /v2/);
    assert.ok(!existsSync(join(s.docroot, 'old.html')), 'a file removed from the site is deleted');
    assert.equal(read(join(s.docroot, 'google1234.html')), 'verification');
    assert.equal(read(join(s.docroot, 'sub/index.html')), 'subdomain folder');
    assert.equal(read(join(s.docroot, 'uploads/user.jpg')), 'user upload');
    assert.equal(read(join(s.docroot, '_deploy/kick.php')), '<?php');
  });

  test('keeps N releases; rollback to previous and to an id; list marks the live one', async () => {
    const s = setup();
    const commits = [];
    for (let i = 1; i <= 4; i++) {
      const c = randomSha();
      commits.push(c);
      const r = await deploy(s, makeUpload(s.base, siteFiles({ title: `v${i}` }), meta(c)), '2');
      assert.equal(r.code, 0, r.out);
    }
    const rel = releases(s);
    assert.equal(rel.length, 2, 'keep=2');
    assert.equal(current(s), rel[1]);
    for (let i = 1; i < rel.length; i++) assert.ok(rel[i - 1] < rel[i], 'release ids sort in publish order');

    let r = await runServer(s, 'remote-deploy.sh', ['rollback', s.shDocroot], { DEPLOY_SOURCE: 'local' });
    assert.equal(r.code, 0, r.out);
    assert.match(read(join(s.docroot, 'index.html')), /v3/);
    assert.equal(current(s), rel[0]);
    const live = readJson(join(s.docroot, '_deploy/live.json'));
    assert.equal(live.source, 'rollback');
    assert.equal(live.commit, commits[2]);

    r = await runServer(s, 'remote-deploy.sh', ['rollback', s.shDocroot]);
    assert.equal(r.code, 67, 'nothing older to go back to');
    r = await runServer(s, 'remote-deploy.sh', ['rollback', s.shDocroot, rel[1]]);
    assert.equal(r.code, 0, r.out);
    assert.match(read(join(s.docroot, 'index.html')), /v4/);
    r = await runServer(s, 'remote-deploy.sh', ['rollback', s.shDocroot, '19990101-000000']);
    assert.equal(r.code, 67);
    r = await runServer(s, 'remote-deploy.sh', ['rollback', s.shDocroot, '1;rm']);
    assert.equal(r.code, 64);
    r = await runServer(s, 'remote-deploy.sh', ['list']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, new RegExp(`^\\* ${rel[1]} `, 'm'));
    assert.match(r.stdout, new RegExp(`^  ${rel[0]} `, 'm'));
  });

  test('release ids sort after the newest one even when the clock is behind it (no reuse of a pruned id)', async () => {
    const s = setup();
    mkdirSync(join(s.base, 'releases', '29991231-235959-08'), { recursive: true });
    for (const want of ['29991231-235959-09', '29991231-235959-10', '29991231-235959-11']) {
      const r = await deploy(s, makeUpload(s.base, siteFiles({ title: want }), meta(randomSha())), '2');
      assert.equal(r.code, 0, r.out);
      assert.equal(current(s), want);
    }
    assert.deepEqual(releases(s), ['29991231-235959-10', '29991231-235959-11']);
  });

  test('page-count guard (exit 71) and force', async () => {
    const s = setup();
    assert.equal((await deploy(s, makeUpload(s.base, siteFiles({ pages: 8 })))).code, 0);
    const up = makeUpload(s.base, siteFiles({ title: 'broken', pages: 0 }));
    let r = await deploy(s, up);
    assert.equal(r.code, 71, r.out);
    assert.ok(!existsSync(up), 'the refused upload is removed');
    assert.match(read(join(s.docroot, 'index.html')), /v1/, 'the live site is unchanged');
    r = await deploy(s, makeUpload(s.base, siteFiles({ title: 'small', pages: 0 })), '3', 'force');
    assert.equal(r.code, 0, r.out);
    assert.match(read(join(s.docroot, 'index.html')), /small/);
  });

  test('refuses a wrong docroot, a foreign upload dir and bad arguments', async () => {
    const s = setup();
    const up = makeUpload(s.base, siteFiles());
    const other = join(s.home, 'example.com', 'www');
    mkdirSync(other, { recursive: true });
    let r = await runServer(s, 'remote-deploy.sh', ['deploy', shPath(up), shPath(other), '3']);
    assert.equal(r.code, 64, 'docroot must end with /public_html');
    r = await runServer(s, 'remote-deploy.sh', ['deploy', shPath(up), shPath(other), '3'], { XPD_DOCROOT_SUFFIX: '/www' });
    assert.equal(r.code, 0, `suffix is configurable: ${r.out}`);
    r = await runServer(s, 'remote-deploy.sh', ['deploy', shPath(makeUpload(s.base, siteFiles())), `${s.shHome}/missing.example.com/public_html`, '3']);
    assert.equal(r.code, 65);
    r = await runServer(s, 'remote-deploy.sh', ['deploy', shPath(makeUpload(s.base, siteFiles())), `${s.shHome}/x/../example.com/public_html`, '3']);
    assert.equal(r.code, 64, '.. is refused');
    const outside = join(s.t, 'elsewhere');
    write(join(outside, 'site/index.html'), 'x');
    r = await runServer(s, 'remote-deploy.sh', ['deploy', shPath(outside), s.shDocroot, '3']);
    assert.equal(r.code, 64, 'only uploads under incoming/ are accepted');
    r = await deploy(s, makeUpload(s.base, siteFiles()), '1');
    assert.equal(r.code, 64, 'keep >= 2');
    r = await deploy(s, makeUpload(s.base, siteFiles()), '3', 'bogus');
    assert.equal(r.code, 64);
    const empty = join(s.base, 'incoming', 'u.empty');
    mkdirSync(join(empty, 'site'), { recursive: true });
    r = await deploy(s, empty);
    assert.equal(r.code, 66, 'no index.html');
  });

  test('rsync failure: exit 70, live site and current unchanged', { skip: !serverPath().includes('fakes') && 'needs the rsync stand-in' }, async () => {
    const s = setup();
    assert.equal((await deploy(s, makeUpload(s.base, siteFiles()))).code, 0);
    const before = current(s);
    const r = await runServer(s, 'remote-deploy.sh', ['deploy', shPath(makeUpload(s.base, siteFiles({ title: 'v2' }))), s.shDocroot, '3'],
      { FAKE_RSYNC_FAIL: '1' });
    assert.equal(r.code, 70, r.out);
    assert.match(read(join(s.docroot, 'index.html')), /v1/);
    assert.equal(current(s), before);
    assert.deepEqual(releases(s), [before], 'the release that was never published is removed (rollback "previous" must not pick it)');
    assert.match(read(join(s.base, 'deploy.log')), /FAILED\(70\)/);
  });

  test('a missing live release stops the deploy (exit 68) instead of guessing what to delete', async () => {
    const s = setup();
    assert.equal((await deploy(s, makeUpload(s.base, siteFiles()))).code, 0);
    writeFileSync(join(s.base, 'current'), '20000101-000000\n');
    const r = await deploy(s, makeUpload(s.base, siteFiles({ title: 'v2' })));
    assert.equal(r.code, 68, r.out);
  });

  test('install (PC deploys): pull.sh, kick.php with the base path, _deploy/.htaccess, protect.list, pin after success', async () => {
    const s = setup();
    const up = makeUpload(s.base, siteFiles());
    for (const f of ['pull.sh', 'kick.php', 'deploy.htaccess']) write(join(up, 'server', f), read(join(ROOT, 'server', f)));
    write(join(up, 'server/protect.list'), '/.well-known/\n/_deploy/\n/uploads/\n');
    write(join(up, 'server/htaccess.pin'), 'site/.htaccess 0000\n');
    const r = await deploy(s, up, '3', 'install');
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(join(s.base, 'pull.sh')));
    assert.equal(read(join(s.base, 'protect.list')), '/.well-known/\n/_deploy/\n/uploads/\n');
    assert.equal(read(join(s.base, 'htaccess.pin')), 'site/.htaccess 0000\n');
    const kick = read(join(s.docroot, '_deploy/kick.php'));
    assert.ok(kick.includes(`$base = '${s.shBase}';`) || kick.includes("$base = '/"), 'base path substituted');
    assert.ok(!kick.includes("'__BASE__'"));
    assert.match(read(join(s.docroot, '_deploy/.htaccess')), /RewriteRule/);
    assert.ok(!existsSync(join(s.base, 'releases', current(s), 'server')), 'server/ is not kept in the release');
  });

  test('install refuses a server folder whose path cannot be written into kick.php safely', async () => {
    const s = fakeServer('site#1'); // a "#" (or a quote) would break the sed / PHP substitution
    installServerScripts(s);
    const up = makeUpload(s.base, siteFiles());
    for (const f of ['pull.sh', 'kick.php', 'deploy.htaccess']) write(join(up, 'server', f), read(join(ROOT, 'server', f)));
    write(join(up, 'server/protect.list'), '/.well-known/\n/_deploy/\n');
    write(join(up, 'server/htaccess.pin'), '');
    const r = await deploy(s, up, '3', 'install');
    assert.equal(r.code, 64, r.out);
    assert.match(r.out, /使えない文字/);
    assert.ok(!existsSync(join(s.docroot, '_deploy/kick.php')));
  });

  test('lock: a second deploy waits, then gives up with exit 75', async () => {
    const s = setup();
    let holder;
    if (HAS_FLOCK) {
      holder = run('sh', ['-c', `exec 9>"${s.shBase}/.lock"; flock 9; sleep 6`]);
      await new Promise((r) => setTimeout(r, 500));
    } else {
      mkdirSync(join(s.base, '.lock.d'));
    }
    const r = await runServer(s, 'remote-deploy.sh', ['deploy', shPath(makeUpload(s.base, siteFiles())), s.shDocroot, '3'], { XPD_LOCK_WAIT: '1' });
    assert.equal(r.code, 75, r.out);
    assert.match(r.out, /別のデプロイが実行中です/);
    await holder;
  });

});
