// server/pull.sh against a fake GitHub API (127.0.0.1) and a fake docroot.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { deployFiles, HTACCESS, pinFor, pullBundle, siteFiles } from '../helpers/bundles.mjs';
import { randomSha, startFakeGitHub } from '../helpers/fake-github.mjs';
import { existsSync, fakeServer, HAS_CURL, HAS_FLOCK, installServerScripts, read, readJson, run, runServer, serverPath, SH, write } from '../helpers/env.mjs';

const REPO = 'your-org/your-site';
const TOKEN = 'github_pat_TEST0000000000000000000000';

let gh;
before(async () => {
  if (SH && HAS_CURL) gh = await startFakeGitHub({ repo: REPO, token: TOKEN });
});
after(async () => gh?.close());

/** A server with pull.env, the installed scripts and a pin for `files` (as after one PC deploy). */
const setup = (files = siteFiles(), env = {}) => {
  const s = fakeServer();
  installServerScripts(s);
  const lines = {
    GH_REPO: REPO, GH_TOKEN: TOKEN, DOCROOT: s.shDocroot, KEEP: '3', GH_API: gh.url, SITE_NAME: 'example-site', ...env,
  };
  writeFileSync(join(s.base, 'pull.env'), `${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
  writeFileSync(join(s.base, 'htaccess.pin'), `${pinFor(files)}\n`);
  gh.state.branches = {};
  gh.state.override = null;
  gh.state.missingStatus = 422;
  gh.state.requests = [];
  gh.setBranch('main');
  return s;
};
const pull = (s, mode = 'cron') => runServer(s, 'pull.sh', [mode]);
const pullJson = (s) => readJson(join(s.docroot, '_deploy/pull.json'));
const lastLog = (s) => read(join(s.base, 'pull.log')).trim().split('\n').pop();
const publish = (b) => gh.setBranch('deploy', deployFiles(b));

describe('pull.sh', { skip: (!SH && 'no sh') || (!HAS_CURL && 'no curl') }, () => {
  test('normal pull: verifies, publishes with DEPLOY_SOURCE=pull, records state; then 304 = nothing to do', async () => {
    const files = siteFiles();
    const s = setup(files);
    const b = pullBundle(files);
    const ref = publish(b);
    gh.setBranch('main', {}, b.commit);
    let r = await pull(s);
    assert.equal(r.code, 0, r.out + lastLog(s));
    assert.match(read(join(s.docroot, 'index.html')), /v1/);
    const live = readJson(join(s.docroot, '_deploy/live.json'));
    assert.equal(live.commit, b.commit);
    assert.equal(live.source, 'pull');
    const p = pullJson(s);
    assert.equal(p.state, 'idle');
    assert.equal(p.deploy_ref, ref);
    assert.equal(p.deploy_commit, b.commit);
    assert.equal(p.main_commit, b.commit);
    assert.match(p.token_expires_at, /^2030-01-01T/);
    assert.match(lastLog(s), /\tcron\tpublished /);
    assert.equal(read(join(s.base, 'pull.state/done')).trim(), ref);

    const downloads = gh.count(/bundle\.tar\.gz$/);
    r = await pull(s);
    assert.equal(r.code, 0);
    assert.match(lastLog(s), /up to date/);
    assert.equal(gh.count(/bundle\.tar\.gz$/), downloads, 'no second download');
    const conditional = gh.state.requests.filter((q) => q.path.endsWith('/commits/deploy') && q.inm === `"${ref}"`);
    assert.ok(conditional.length >= 1, 'the branch check is conditional (If-None-Match → 304)');
    assert.ok(!r.out.includes(TOKEN), 'the token is never printed');
  });

  test('missing deploy branch: 422 (GitHub) and 404 both mean "nothing yet"', async () => {
    for (const status of [422, 404]) {
      const s = setup();
      gh.state.missingStatus = status;
      gh.setBranch('main');
      const r = await pull(s);
      assert.equal(r.code, 0, `${status}: ${r.out}`);
      assert.equal(pullJson(s).state, 'idle');
      assert.match(pullJson(s).message, /まだありません/);
      assert.match(lastLog(s), /no deploy branch/);
    }
  });

  test('missing source branch / repository → configuration error; 401 → token message', async () => {
    let s = setup();
    gh.deleteBranch('main');
    let r = await pull(s);
    assert.equal(r.code, 1);
    assert.equal(pullJson(s).state, 'error');
    assert.match(pullJson(s).message, /リポジトリが見つからない/);

    s = setup({}, {});
    writeFileSync(join(s.base, 'pull.env'), read(join(s.base, 'pull.env')).replace(TOKEN, 'github_pat_WRONG000000000000000000000'));
    r = await pull(s);
    assert.equal(r.code, 1);
    assert.match(pullJson(s).message, /トークンが無効か期限切れ/);
  });

  test('rate limited (403 + remaining 0, or 429) → exit 3, retried next run, no error state', async () => {
    const s = setup();
    gh.state.override = (req, url) => (url.pathname.endsWith('/commits/main') ? { status: 403, headers: { 'x-ratelimit-remaining': '0' } } : undefined);
    let r = await pull(s);
    assert.equal(r.code, 3, r.out);
    assert.match(lastLog(s), /rate-limited/);
    gh.state.override = (req, url) => (url.pathname.endsWith('/commits/main') ? { status: 429 } : undefined);
    r = await pull(s);
    assert.equal(r.code, 3);
    gh.state.override = null;
  });

  test('sha256 mismatch: refused, counted, mailed once; stops after 3 failures; a new deploy commit resets', async () => {
    const files = siteFiles();
    const s = setup(files);
    const bin = join(s.t, 'bin');
    mkdirSync(bin);
    const mail = join(s.t, 'mail.txt');
    write(join(bin, 'sendmail'), `#!/bin/sh\ncat >> "${mail.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)}"\n`);
    writeFileSync(join(s.base, 'pull.env'), `${read(join(s.base, 'pull.env'))}NOTIFY_EMAIL=you@example.com\n`);
    const b = pullBundle(files);
    gh.setBranch('deploy', deployFiles(b, { sha: '0'.repeat(64) }));
    const pullWithMail = () => runServer(s, 'pull.sh', ['cron'], { PATH: `${bin}${delimiter}${serverPath()}` });
    for (let i = 1; i <= 3; i++) {
      const r = await pullWithMail();
      assert.equal(r.code, 1, `attempt ${i}: ${r.out}`);
      assert.match(pullJson(s).message, /sha256 が一致しません/);
    }
    assert.match(pullJson(s).message, /3 回失敗したので、次の公開まで止めています/);
    assert.ok(!existsSync(join(s.docroot, 'index.html')), 'nothing published');
    if (existsSync(mail)) {
      const m = read(mail);
      assert.equal(m.match(/^To: /gm).length, 1, 'one mail for the first failure only');
      assert.match(m, /To: you@example\.com/);
    }
    const downloads = gh.count(/bundle\.tar\.gz$/);
    let r = await pullWithMail();
    assert.equal(r.code, 0, 'stopped = exit 0');
    assert.match(lastLog(s), /stopped .* \(failed 3 times\)/);
    assert.equal(gh.count(/bundle\.tar\.gz$/), downloads, 'no download while stopped');
    assert.equal(pullJson(s).state, 'error');

    publish(pullBundle(files));
    r = await pullWithMail();
    assert.equal(r.code, 0, r.out + lastLog(s));
    assert.equal(pullJson(s).state, 'idle');
    assert.match(read(join(s.docroot, 'index.html')), /v1/);
  });

  // payloads stay harmless: some antivirus products reset local connections that carry web-shell-looking content
  const refused = [
    ['a .php file', { extra: [['site/x.php', Buffer.from('<?php echo 1;')]] }, /実行できる種類のファイル/],
    ['a .phtml in a subfolder', { extra: [['site/a/b.PHTML', Buffer.from('x')]] }, /実行できる種類のファイル/],
    ['.user.ini', { extra: [['site/.user.ini', Buffer.from('auto_prepend_file=x')]] }, /設定ファイル/],
    ['.htpasswd', { extra: [['site/.htpasswd', Buffer.from('u:x')]] }, /設定ファイル/],
    ['a symlink', { extra: [['site/link', null, 'symlink', '/etc/passwd']] }, /リンクや特殊なファイル/],
    ['a hard link', { extra: [['site/hard', null, 'hardlink', 'site/index.html']] }, /リンクや特殊なファイル/],
    ['a .. path', { extra: [['site/../../evil.html', Buffer.from('x')]] }, /想定外の場所/],
    ['a file outside site/', { extra: [['remote-deploy.sh', Buffer.from('rm -rf ~')]] }, /想定外の場所/],
    ['server/ files', { extra: [['server/pull.sh', Buffer.from('x')]] }, /想定外の場所/],
    ['site/_deploy/', { extra: [['site/_deploy/live.json', Buffer.from('{}')]] }, /想定外の場所/],
    // Apache's AddHandler matches every extension of a name, so x.php.jpg can run as PHP
    ['a double extension .php.jpg', { extra: [['site/x.php.jpg', Buffer.from('x')]] }, /実行できる種類のファイル/],
    ['a double extension .phar.txt', { extra: [['site/x.PHAR.txt', Buffer.from('x')]] }, /実行できる種類のファイル/],
  ];
  for (const [name, opts, why] of refused) {
    test(`refuses a bundle with ${name}`, async () => {
      const files = siteFiles();
      const s = setup(files);
      publish(pullBundle(files, opts));
      const r = await pull(s);
      assert.equal(r.code, 1, r.out + lastLog(s));
      assert.match(pullJson(s).message, why);
      assert.ok(!existsSync(join(s.docroot, 'index.html')), 'nothing published');
      assert.ok(!existsSync(join(s.t, 'evil.html')) && !existsSync(join(s.home, 'evil.html')));
    });
  }

  test('names that only look like script extensions are published (php.svg, index.pl.html, phpinfo.html)', async () => {
    const files = { ...siteFiles(), 'assets/php.svg': '<svg/>', 'about-1/index.pl.html': '<p>pl</p>', 'phpinfo.html': '<p>x</p>' };
    const s = setup(files);
    publish(pullBundle(files));
    const r = await pull(s);
    assert.equal(r.code, 0, r.out + lastLog(s));
    assert.ok(existsSync(join(s.docroot, 'about-1/index.pl.html')));
  });

  test('size limits: a decompression bomb is cut off, an oversized download is stopped by curl', async () => {
    const limits = { MAX_MB: '1', MAX_FILES: '50' }; // largest allowed tar stream ≈ 2.1 MB
    // 3 MB of zeros: a tiny download that unpacks past the limit → refused before tar ever lists it
    let files = siteFiles();
    let s = setup(files, limits);
    publish(pullBundle(files, { extra: [['site/zeros.bin', Buffer.alloc(3 * 1048576)]] }));
    let r = await pull(s);
    assert.equal(r.code, 1, r.out + lastLog(s));
    assert.match(pullJson(s).message, /大きすぎます/);
    assert.match(lastLog(s), /stream over/);
    // 2.5 MB of random bytes: the compressed bundle itself is over the cap → curl stops (exit 63) → refused
    files = siteFiles();
    s = setup(files, limits);
    publish(pullBundle(files, { extra: [['site/noise.bin', randomBytes(2.5 * 1048576)]] }));
    r = await pull(s);
    assert.equal(r.code, 1, r.out + lastLog(s));
    assert.match(pullJson(s).message, /大きすぎます/);
    assert.match(lastLog(s), /too large \(bundle\.tar\.gz\)/);
    assert.ok(!existsSync(join(s.docroot, 'index.html')), 'nothing published');
  });

  test('an owner name with spaces cannot hide a file size from the size check', async () => {
    // "x 0" as the owner shifts the columns of `tar -tv` unless the listing uses --numeric-owner
    const files = siteFiles();
    const s = setup(files, { MAX_MB: '1', MAX_FILES: '50' });
    publish(pullBundle(files, { extra: [['site/big.bin', Buffer.alloc(1.5 * 1048576), 'file', '', 'x 0']] }));
    const r = await pull(s);
    assert.equal(r.code, 1, r.out + lastLog(s));
    assert.match(pullJson(s).message, /大きすぎます/);
    assert.match(lastLog(s), /unpacked \d+ bytes/);
  });

  test('.htaccess changes are refused unless pinned by a PC deploy; no pin at all is refused', async () => {
    const files = siteFiles();
    let s = setup(files);
    publish(pullBundle(siteFiles({ htaccess: `${HTACCESS}Header set X-Evil 1\n` })));
    let r = await pull(s);
    assert.equal(r.code, 1);
    assert.match(pullJson(s).message, /\.htaccess が変わっています/);
    s = setup(files);
    publish(pullBundle({ ...files, 'blog/.htaccess': 'Options +ExecCGI\n' }));
    r = await pull(s);
    assert.equal(r.code, 1, 'a new .htaccess in a subfolder is a change too');
    s = setup(files);
    publish(pullBundle(siteFiles({ htaccess: null })));
    r = await pull(s);
    assert.equal(r.code, 1, 'removing .htaccess is a change too');
    s = setup(files);
    write(join(s.base, 'htaccess.pin'), '');
    const { rmSync } = await import('node:fs');
    rmSync(join(s.base, 'htaccess.pin'));
    publish(pullBundle(files));
    r = await pull(s);
    assert.equal(r.code, 1);
    assert.match(pullJson(s).message, /PC からの公開がまだ一度もありません/);
  });

  test('a site without any .htaccess works with an empty pin', async () => {
    const files = siteFiles({ htaccess: null });
    const s = setup(files);
    publish(pullBundle(files));
    const r = await pull(s);
    assert.equal(r.code, 0, r.out + lastLog(s));
  });

  test('META.json problems: missing, commit mismatch with the bundle, missing bundle', async () => {
    const files = siteFiles();
    let s = setup(files);
    const b = pullBundle(files);
    gh.setBranch('deploy', { 'bundle.tar.gz': b.tar, 'bundle.sha256': Buffer.from(b.sha) });
    let r = await pull(s);
    assert.equal(r.code, 1);
    assert.match(pullJson(s).message, /META\.json）がありません/);

    s = setup(files);
    gh.setBranch('deploy', { ...deployFiles(b), 'META.json': Buffer.from(JSON.stringify({ commit: randomSha() })) });
    r = await pull(s);
    assert.equal(r.code, 1);
    assert.match(pullJson(s).message, /一致しません/);

    s = setup(files);
    gh.setBranch('deploy', { 'META.json': b.metaJson, 'bundle.sha256': Buffer.from(b.sha) });
    r = await pull(s);
    assert.equal(r.code, 1);
    assert.match(pullJson(s).message, /まとめファイルがありません/);
  });

  test('rollback request (META action=rollback) re-publishes the previous release', async () => {
    const files = siteFiles();
    const s = setup(files);
    publish(pullBundle(files));
    assert.equal((await pull(s)).code, 0);
    publish(pullBundle(siteFiles({ title: 'v2' })));
    assert.equal((await pull(s)).code, 0);
    assert.match(read(join(s.docroot, 'index.html')), /v2/);
    gh.setBranch('deploy', { 'META.json': Buffer.from('{"action":"rollback","release":"previous","source":"github-actions"}') });
    const r = await pull(s);
    assert.equal(r.code, 0, r.out + lastLog(s));
    assert.match(read(join(s.docroot, 'index.html')), /v1/);
    assert.equal(readJson(join(s.docroot, '_deploy/live.json')).source, 'rollback');
    gh.setBranch('deploy', { 'META.json': Buffer.from('{"action":"rollback","release":"1;rm -rf ~"}') });
    assert.equal((await pull(s)).code, 1);
    assert.match(pullJson(s).message, /切り戻し先の指定が不正です/);
  });

  test('page-count guard from the pull path; META force:true overrides it', async () => {
    const files = siteFiles({ pages: 6 });
    const s = setup(files);
    publish(pullBundle(files));
    assert.equal((await pull(s)).code, 0);
    const small = siteFiles({ title: 'small', pages: 0 });
    publish(pullBundle(small));
    let r = await pull(s);
    assert.equal(r.code, 1);
    assert.match(pullJson(s).message, /ページ数が公開中の半分未満/);
    publish(pullBundle(small, { metaExtra: { force: true } }));
    r = await pull(s);
    assert.equal(r.code, 0, r.out + lastLog(s));
    assert.match(read(join(s.docroot, 'index.html')), /small/);
  });

  test('build status from the status branch is copied field by field and sanitised', async () => {
    const files = siteFiles();
    const s = setup(files);
    const c = randomSha();
    gh.setBranch('deploy-status', {
      'status.json': Buffer.from(JSON.stringify({
        state: 'failed', commit: c, run_url: 'javascript:alert(1)', message: 'Error: <img src=x onerror=alert(1)> broke', at: '2026-10-01T03:00:00Z', extra: 'x',
      })),
    });
    const r = await pull(s);
    assert.equal(r.code, 0, r.out);
    const b = pullJson(s).build;
    assert.deepEqual(Object.keys(b), ['state', 'commit', 'run_url', 'message', 'at']);
    assert.equal(b.state, 'failed');
    assert.equal(b.commit, c);
    assert.equal(b.run_url, '', 'only github.com action run URLs survive');
    assert.equal(b.message, 'Error: img src=x onerror=alert(1) broke');
  });

  test('configuration errors exit 2 and name the setting', async () => {
    const cases = [
      [{ GH_REPO: 'not a repo' }, /GH_REPO/],
      [{ GH_TOKEN: 'short' }, /GH_TOKEN/],
      [{ DOCROOT: '/home/xs123456/example.com/www' }, /DOCROOT/],
      [{ KEEP: '1' }, /KEEP/],
      [{ GH_API: 'http://evil.example' }, /GH_API/],
      [{ BRANCH: '../x' }, /BRANCH/],
    ];
    for (const [env, why] of cases) {
      const s = setup(siteFiles(), env);
      const r = await pull(s);
      assert.equal(r.code, 2, `${JSON.stringify(env)}: ${r.out}`);
      assert.match(r.out, why);
    }
  });

  test('lock: a second pull while one runs exits 75 (busy)', async () => {
    const s = setup();
    let holder;
    if (HAS_FLOCK) {
      holder = run('sh', ['-c', `exec 8>>"${s.shBase}/.pull.lock"; flock 8; sleep 5`]);
      await new Promise((r) => setTimeout(r, 500));
    } else {
      // mkdir lock owned by a live process (this test's own sh)
      holder = run('sh', ['-c', `mkdir "${s.shBase}/.pull.lock.d" && echo $$ > "${s.shBase}/.pull.lock.d/pid" && sleep 5`]);
      await new Promise((r) => setTimeout(r, 1500));
    }
    const r = await pull(s);
    assert.equal(r.code, 75, r.out);
    assert.match(lastLog(s), /busy/);
    await holder;
    if (!HAS_FLOCK) {
      // a stale lock (owner gone) is taken over
      const r2 = await pull(s);
      assert.notEqual(r2.code, 75, r2.out);
    }
  });

  test('check mode prints what it sees and publishes nothing', async () => {
    const s = setup();
    const r = await pull(s, 'check');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /main: [0-9a-f]{12}/);
    assert.match(r.out, /deploy: まだありません/);
    assert.match(r.out, /htaccess\.pin: ok/);
    assert.ok(!existsSync(join(s.docroot, '_deploy/pull.json')));
  });
});
