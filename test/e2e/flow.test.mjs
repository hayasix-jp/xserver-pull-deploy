// End to end: the CLI from a "PC" project → (stand-in ssh) → server scripts → fake docroot, then the GitHub path:
// bundle-only → fake GitHub deploy branch → pull.sh → wait / verify / kick against a local web server.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startFakeGitHub } from '../helpers/fake-github.mjs';
import {
  existsSync, fakeServer, FAKES, git, HAS_CURL, read, readJson, ROOT, run, runServer, SH, serverPath, startSite, tmp, write,
} from '../helpers/env.mjs';

const REPO = 'your-org/your-site';
const TOKEN = 'github_pat_TEST0000000000000000000000';
const XPD = join(ROOT, 'bin', 'xpd.mjs');

let gh;
let site;
let s; // fake server account
let proj; // the "PC" project
let sshLog;

const xpd = (args, env = {}) =>
  run(process.execPath, [XPD, ...args], {
    cwd: proj,
    env: {
      PATH: serverPath(), GITHUB_ACTIONS: '', XPD_TRIGGER: '', FAKE_SSH_HOME: s.shHome, FAKE_SSH_LOG: sshLog,
      XPD_TEST_RETRY_DELAY_MS: '10', XPD_LOCK_WAIT: '5', XPD_GH_RETRY: '0', ...env,
    },
  });
const ci = (args, env = {}) => xpd(args, { GITHUB_ACTIONS: 'true', XPD_TRIGGER: 'push', ...env });
const live = () => readJson(join(s.docroot, '_deploy/live.json'));
const sshCalls = () => (existsSync(sshLog) ? read(sshLog).trim().split('\n').filter(Boolean).length : 0);
const head = () => git(proj, 'rev-parse', 'HEAD');
const commitAll = (msg) => {
  git(proj, 'add', '-A');
  git(proj, 'commit', '-qm', msg);
  return head();
};
const writeSite = (title, extra = {}) => {
  const files = {
    'dist/index.html': `<!doctype html><h1>${title}</h1>\n`,
    'dist/about/index.html': `<p>about ${title}</p>\n`,
    'dist/404.html': '<p>404</p>\n',
    ...extra,
  };
  for (const [p, b] of Object.entries(files)) write(join(proj, p), b);
};

before(async () => {
  if (!SH) return;
  s = fakeServer('example-site');
  site = await startSite(s.docroot);
  if (HAS_CURL) gh = await startFakeGitHub({ repo: REPO, token: TOKEN });
  proj = tmp('xpd-pc-');
  sshLog = join(proj, '..', `${proj.split(/[\\/]/).pop()}-ssh.log`);
  const key = join(proj, 'id_test');
  writeFileSync(key, 'not a real key');
  writeFileSync(join(proj, 'xpd.config.json'), JSON.stringify({
    name: 'example-site', build: '', outDir: 'dist', siteUrl: site.url, keep: 3, protect: ['/uploads/'], githubRepo: REPO,
  }, null, 2));
  writeFileSync(join(proj, '.env.deploy'), [
    'XPD_HOST=sv12345.xserver.jp', 'XPD_USER=xs123456', `XPD_DOCROOT=${s.shDocroot}`, `XPD_SSH_KEY=${key.replace(/\\/g, '/')}`,
    `XPD_SSH_BIN=${join(FAKES, 'ssh.mjs').replace(/\\/g, '/')}`, ...(gh ? [`XPD_GH_API=${gh.url}`] : []),
  ].join('\n'));
  writeFileSync(join(proj, '.gitignore'), '.env.deploy\n.xpd-bundle/\nid_test\n');
  git(proj, 'init', '-q', '-b', 'main');
  // .htaccess with CRLF on the PC: the pin must equal what CI (LF) produces
  writeSite('v1', { 'dist/.htaccess': 'Options -Indexes\r\nErrorDocument 404 /404.html\r\n' });
  commitAll('v1');
});

after(async () => {
  await site?.close();
  await gh?.close();
});

describe('PC deploy + GitHub pull, end to end', { skip: !SH && 'no sh' }, () => {
  test('deploy --dry-run connects to nothing (works without .env.deploy)', async () => {
    const dry = tmp('xpd-dry-');
    writeFileSync(join(dry, 'xpd.config.json'), JSON.stringify({ name: 'dry-site', outDir: 'public', siteUrl: site.url }));
    write(join(dry, 'public/index.html'), '<h1>dry</h1>\n');
    const r = await run(process.execPath, [XPD, 'deploy', '--dry-run'], {
      cwd: dry, env: { GITHUB_ACTIONS: '', FAKE_SSH_LOG: sshLog, XPD_SSH_BIN: join(FAKES, 'ssh.mjs') },
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\[dry-run\] 何も送信していません/);
    assert.match(r.out, /XPD_HOST/, 'the missing setting is reported');
    assert.equal(sshCalls(), 0);
  });

  test('missing settings stop a real deploy with exit 2', async () => {
    const r = await xpd(['deploy'], { XPD_DOCROOT: '/home/xs123456/example.com/www' });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /XPD_DOCROOT/);
  });

  test('first deploy from the PC: publishes, installs the server side, records the pin, checks freshness', async () => {
    write(join(s.docroot, 'index.html'), 'panel placeholder');
    const r = await xpd(['deploy'], { FAKE_SSH_FAIL_TIMES: '2' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /SSH 接続に失敗（exit 255）。.*再試行します（1\/3）/, 'connection failures are retried');
    assert.match(r.out, /OK .*最新/, 'the live top page equals dist/index.html');
    assert.match(read(join(s.docroot, 'index.html')), /v1/);
    assert.equal(live().commit, head());
    assert.equal(live().source, 'local');
    for (const f of ['remote-deploy.sh', 'pull.sh', 'protect.list', 'htaccess.pin']) assert.ok(existsSync(join(s.base, f)), f);
    assert.match(read(join(s.base, 'protect.list')), /^\/uploads\/$/m);
    assert.match(read(join(s.base, 'htaccess.pin')), /^site\/\.htaccess [0-9a-f]{64}$/m);
    assert.ok(!read(join(s.docroot, '_deploy/kick.php')).includes('__BASE__'));
    assert.ok(existsSync(join(s.docroot, '_deploy/.htaccess')));
    assert.equal(read(join(s.docroot, '.htaccess')), 'Options -Indexes\nErrorDocument 404 /404.html\n', 'LF on the server');
    const args = JSON.parse(read(sshLog).trim().split('\n').pop());
    assert.ok(args.includes('BatchMode=yes') && args.includes('10022') && args.includes('xs123456@sv12345.xserver.jp'));
  });

  test('lineage guard: uncommitted changes, a live commit not in this history; --allow-dirty / --overwrite', async () => {
    const v1 = head();
    writeSite('v2');
    let r = await xpd(['deploy']);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /未コミットの変更があります/);
    const v2 = commitAll('v2');
    r = await xpd(['deploy']);
    assert.equal(r.code, 0, r.out);
    assert.equal(live().commit, v2);
    git(proj, 'reset', '-q', '--hard', v1);
    r = await xpd(['deploy']);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /このPCの履歴にない更新/);
    assert.match(read(join(s.docroot, 'index.html')), /v2/, 'nothing published');
    r = await xpd(['deploy', '--overwrite']);
    assert.equal(r.code, 0, r.out);
    assert.equal(live().commit, v1);
    git(proj, 'reset', '-q', '--hard', v2);
    writeSite('v2-dirty');
    r = await xpd(['deploy', '--allow-dirty']);
    assert.equal(r.code, 0, r.out);
    assert.equal(live().dirty, true);
    git(proj, 'checkout', '-q', '--', '.');
    r = await xpd(['deploy']);
    assert.equal(r.code, 0, r.out);
  });

  test('lineage guard: GitHub (origin) has commits this PC does not', async () => {
    const origin = tmp('xpd-origin-');
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(proj, 'remote', 'add', 'origin', origin);
    git(proj, 'push', '-q', 'origin', 'main');
    const other = tmp('xpd-other-');
    git(other, 'clone', '-q', origin, '.');
    write(join(other, 'dist/new.html'), 'from elsewhere');
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'elsewhere');
    git(other, 'push', '-q', 'origin', 'main');
    let r = await xpd(['deploy']);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /このPCにない更新が 1 件あります/);
    git(proj, 'pull', '-q', 'origin', 'main');
    r = await xpd(['deploy']);
    assert.equal(r.code, 0, r.out);
    assert.match(read(join(s.docroot, 'new.html')), /from elsewhere/);
  });

  test('list and rollback from the PC', async () => {
    let r = await xpd(['list']);
    assert.equal(r.code, 0, r.out);
    const ids = [...r.out.matchAll(/^([* ]) (\d{8}-\d{6}(?:-\d+)?)/gm)].map((m) => [m[1], m[2]]);
    assert.equal(ids.length, 3, `keep=3: ${r.out}`);
    assert.equal(ids[0][0], '*');
    r = await xpd(['rollback']);
    assert.equal(r.code, 0, r.out);
    assert.equal(live().source, 'rollback');
    assert.equal(live().release, ids[1][1]);
    r = await xpd(['rollback', ids[0][1]]);
    assert.equal(r.code, 0, r.out);
    assert.equal(live().release, ids[0][1]);
    r = await xpd(['rollback', 'nope;rm']);
    assert.equal(r.code, 64, r.out);
  });

  test('check prints the server side', async () => {
    const r = await xpd(['check']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /connected: /);
    assert.match(r.out, /current release: \d{8}-\d{6}/);
  });

  describe('GitHub path', { skip: !HAS_CURL && 'no curl' }, () => {
    test('setup-pull writes pull.env (600) and runs pull.sh check', async () => {
      gh.setBranch('main', {}, head());
      const r = await xpd(['setup-pull'], { XPD_PULL_TOKEN: TOKEN, XPD_NOTIFY_EMAIL: 'you@example.com' });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /pull\.sh check — your-org\/your-site/);
      assert.match(r.out, /htaccess\.pin: ok/);
      assert.match(r.out, /\* \* \* \* \* \/bin\/sh .*\/\.deploy\/example-site\/pull\.sh cron >\/dev\/null 2>&1/);
      const env = read(join(s.base, 'pull.env'));
      assert.match(env, new RegExp(`^GH_TOKEN=${TOKEN}$`, 'm'));
      assert.match(env, /^NOTIFY_EMAIL=you@example\.com$/m);
      assert.match(env, /^DEPLOY_BRANCH=deploy$/m);
      assert.ok(!r.out.includes(TOKEN), 'the token is never printed');
      assert.ok(!read(sshLog).includes(TOKEN), 'the token is not on the ssh command line');
    });

    test('CI bundle → deploy branch → pull.sh publishes; wait / verify / kick agree', async () => {
      // CI checks out the same commit; the .htaccess comes with LF there
      writeSite('v3', { 'dist/.htaccess': 'Options -Indexes\nErrorDocument 404 /404.html\n' });
      const v3 = commitAll('v3');
      gh.setBranch('main', {}, v3);
      let r = await ci(['lineage', '--ci']);
      assert.equal(r.code, 0, r.out);
      r = await ci(['bundle-only', '--out', '.xpd-bundle']);
      assert.equal(r.code, 0, r.out);
      const out = join(proj, '.xpd-bundle');
      const metaCi = JSON.parse(readFileSync(join(out, 'META.json'), 'utf8'));
      assert.equal(metaCi.commit, v3);
      assert.equal(metaCi.source, 'github-actions');
      assert.equal(metaCi.trigger, 'push');
      const ref = gh.setBranch('deploy', {
        'bundle.tar.gz': readFileSync(join(out, 'bundle.tar.gz')),
        'bundle.sha256': readFileSync(join(out, 'bundle.sha256')),
        'META.json': readFileSync(join(out, 'META.json')),
      });
      r = await ci(['kick']);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /HTTP 202/);
      const waiting = ci(['wait', '--commit', 'HEAD', '--deploy-ref', ref, '--interval', '0.3', '--timeout', '240']);
      const p = await runServer(s, 'pull.sh', ['cron']);
      assert.equal(p.code, 0, p.out + read(join(s.base, 'pull.log')));
      r = await waiting;
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /公開完了/);
      assert.equal(live().source, 'pull');
      assert.equal(live().commit, v3);
      r = await ci(['verify', '--commit', 'HEAD', '--fresh']);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /すべて OK/);
    });

    test('wait fails fast when the server refused the bundle (.htaccess changed on the pull path)', async () => {
      writeSite('v4', { 'dist/.htaccess': 'Options -Indexes\nHeader set X-Changed 1\n' });
      commitAll('v4');
      let r = await ci(['bundle-only']);
      assert.equal(r.code, 0, r.out);
      const out = join(proj, '.xpd-bundle');
      const ref = gh.setBranch('deploy', {
        'bundle.tar.gz': readFileSync(join(out, 'bundle.tar.gz')),
        'bundle.sha256': readFileSync(join(out, 'bundle.sha256')),
        'META.json': readFileSync(join(out, 'META.json')),
      });
      const p = await runServer(s, 'pull.sh', ['cron']);
      assert.equal(p.code, 1);
      r = await ci(['wait', '--commit', 'HEAD', '--deploy-ref', ref, '--interval', '0.2', '--timeout', '30']);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /サーバーが公開を止めました: .*\.htaccess が変わっています/);
      // the PC deploy records the new pin; the next pull of the same content passes
      r = await xpd(['deploy']);
      assert.equal(r.code, 0, r.out);
      writeSite('v5', { 'dist/.htaccess': 'Options -Indexes\nHeader set X-Changed 1\n' });
      commitAll('v5');
      r = await ci(['bundle-only']);
      gh.setBranch('deploy', {
        'bundle.tar.gz': readFileSync(join(out, 'bundle.tar.gz')),
        'bundle.sha256': readFileSync(join(out, 'bundle.sha256')),
        'META.json': readFileSync(join(out, 'META.json')),
      });
      const p2 = await runServer(s, 'pull.sh', ['cron']);
      assert.equal(p2.code, 0, p2.out + read(join(s.base, 'pull.log')));
      assert.match(read(join(s.docroot, 'index.html')), /v5/);
    });

    test('rollback request from CI (bundle-only --rollback) → pull.sh → wait --rollback-since', async () => {
      const started = Math.floor(Date.now() / 1000) - 1;
      let r = await ci(['bundle-only', '--rollback', 'previous']);
      assert.equal(r.code, 0, r.out);
      const out = join(proj, '.xpd-bundle');
      assert.ok(!existsSync(join(out, 'bundle.tar.gz')), 'only META.json for a rollback');
      const ref = gh.setBranch('deploy', { 'META.json': readFileSync(join(out, 'META.json')) });
      const p = await runServer(s, 'pull.sh', ['cron']);
      assert.equal(p.code, 0, p.out + read(join(s.base, 'pull.log')));
      r = await ci(['wait', '--rollback-since', String(started), '--deploy-ref', ref, '--interval', '0.2', '--timeout', '30']);
      assert.equal(r.code, 0, r.out);
      assert.equal(live().source, 'rollback');
      assert.doesNotMatch(read(join(s.docroot, 'index.html')), /v5/);
    });

    test('CI lineage: a PC publish that was not pushed stops the CI run', async () => {
      writeSite('pc-only');
      commitAll('pc-only');
      let r = await xpd(['deploy', '--overwrite']);
      assert.equal(r.code, 0, r.out);
      git(proj, 'reset', '-q', '--hard', 'HEAD~1');
      r = await ci(['lineage', '--ci']);
      assert.equal(r.code, 3, r.out);
      assert.match(r.out, /GitHub にまだ無い内容が公開されています/);
    });
  });

  test('bundle-only refuses a non-empty foreign output folder', async () => {
    write(join(proj, 'outdir/keep.txt'), 'x');
    const r = await ci(['bundle-only', '--out', 'outdir']);
    assert.equal(r.code, 2, r.out);
  });
});
