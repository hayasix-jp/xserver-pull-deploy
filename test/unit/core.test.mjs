// Unit tests: patterns, tar, bundle, config, CLI argument parsing, init.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { parseArgs } from '../../bin/xpd.mjs';
import { makeBundle, rollbackMeta, sha256 } from '../../lib/bundle.mjs';
import { loadConfig, parseEnvFile, problemsFor } from '../../lib/config.mjs';
import { detect, init } from '../../lib/init.mjs';
import { matches, matchesSelfOrParent, validProtect } from '../../lib/pattern.mjs';
import { deployCmd, rollbackCmd } from '../../lib/remote.mjs';
import { tarball } from '../../lib/tar.mjs';
import { tmp, write } from '../helpers/env.mjs';

/** tar member names and types from a gzip'd ustar buffer */
const listTar = (gz) => {
  const b = gunzipSync(gz);
  const out = [];
  for (let off = 0; off + 512 <= b.length;) {
    const h = b.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(h.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(h[156]);
    out.push({ name: prefix ? `${prefix}/${name}` : name, size, type, body: b.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
};

const project = (cfg = {}, files = { 'index.html': '<h1>hi</h1>\n' }) => {
  const root = tmp('xpd-proj-');
  writeFileSync(join(root, 'xpd.config.json'), JSON.stringify({ name: 'example-site', outDir: 'dist', siteUrl: 'https://example.com', ...cfg }));
  for (const [p, b] of Object.entries(files)) write(join(root, 'dist', p), b);
  return root;
};

test('pattern: rsync-style matching', () => {
  assert.ok(matches('/uploads/', 'uploads', true));
  assert.ok(!matches('/uploads/', 'uploads', false), 'trailing slash = directories only');
  assert.ok(!matches('/uploads/', 'a/uploads', true), 'leading slash = anchored');
  assert.ok(matches('/google*.html', 'google123.html', false));
  assert.ok(!matches('/google*.html', 'x/google1.html', false));
  assert.ok(matches('*.bak', 'a/b/c.bak', false), 'unanchored = basename at any depth');
  assert.ok(matchesSelfOrParent('/uploads/', 'uploads/2026/a.jpg', false));
  assert.ok(matchesSelfOrParent('/.well-known/', '.well-known/acme-challenge/x', false));
  assert.ok(matches('/a\\*b', 'a*b', false) && !matches('/a\\*b', 'axb', false), 'escaped wildcard is literal');
  for (const ok of ['/uploads/', '/google*.html', '*.bak', '/a/b/']) assert.ok(validProtect(ok), ok);
  for (const bad of ['/', '../x', '/a/../b', '/a b', '/a;rm', '//x', '/x$']) assert.ok(!validProtect(bad), bad);
});

test('tar: ustar members, long names, readable by the system tar', () => {
  const long = `site/${'a'.repeat(60)}/${'b'.repeat(60)}/index.html`;
  const gz = tarball([['site/', null, 'dir'], ['site/index.html', Buffer.from('x')], [long, Buffer.from('long')]]);
  const m = listTar(gz);
  assert.deepEqual(m.map((e) => [e.name, e.type]), [['site/', '5'], ['site/index.html', '0'], [long, '0']]);
  const dir = tmp('xpd-tar-');
  writeFileSync(join(dir, 'b.tar.gz'), gz);
  const names = execFileSync('tar', ['-tzf', 'b.tar.gz'], { cwd: dir, encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.deepEqual(names, ['site/', 'site/index.html', long]);
});

test('bundle: site/ + META + REVISION; protected paths left out; .htaccess pinned with LF; server files only for PC', async () => {
  const root = project({ protect: ['/uploads/'] }, {
    'index.html': '<h1>hi</h1>\n',
    '.htaccess': 'Options -Indexes\r\nRewriteEngine On\r\n',
    'sub/.htaccess': 'Require all denied\n',
    '.well-known/acme-challenge/t': 'x',
    '_deploy/live.json': '{}',
    'uploads/a.jpg': 'jpg',
    'assets/app.js': 'console.log(1)\n',
  });
  const c = await loadConfig({ cwd: root, env: {} });
  const b = makeBundle(c, { commit: 'a'.repeat(40), subject: 's', dirty: true, force: true, trigger: 'push', withServer: false });
  const names = listTar(b.buffer).map((e) => e.name);
  assert.deepEqual(names.filter((n) => !n.endsWith('/')).sort(), [
    'META.json', 'REVISION', 'site/.htaccess', 'site/assets/app.js', 'site/index.html', 'site/sub/.htaccess',
  ]);
  assert.ok(!names.some((n) => n.startsWith('server/')));
  const ht = listTar(b.buffer).find((e) => e.name === 'site/.htaccess').body;
  assert.equal(ht.toString(), 'Options -Indexes\nRewriteEngine On\n', 'CRLF → LF');
  assert.deepEqual(b.pin, [`site/.htaccess ${sha256(ht)}`, `site/sub/.htaccess ${sha256(Buffer.from('Require all denied\n'))}`]);
  assert.equal(b.meta.commit, 'a'.repeat(40));
  assert.equal(b.meta.dirty, true);
  assert.equal(b.meta.force, true);
  assert.match(b.revision, /^a{40} dirty /);

  const pc = makeBundle(c, { commit: 'b'.repeat(40), withServer: true });
  const pcNames = listTar(pc.buffer).map((e) => e.name);
  for (const f of ['server/remote-deploy.sh', 'server/pull.sh', 'server/kick.php', 'server/deploy.htaccess', 'server/protect.list', 'server/htaccess.pin']) {
    assert.ok(pcNames.includes(f), f);
  }
  const protect = listTar(pc.buffer).find((e) => e.name === 'server/protect.list').body.toString();
  assert.equal(protect, '/.well-known/\n/_deploy/\n/uploads/\n');
});

test('bundle: refuses a build without index.html', async () => {
  const root = project({}, { 'about.html': 'x' });
  const c = await loadConfig({ cwd: root, env: {} });
  assert.throws(() => makeBundle(c, { commit: 'no-git' }), /index\.html がありません/);
});

test('rollback request META', async () => {
  const c = await loadConfig({ cwd: project(), env: {} });
  const m = JSON.parse(rollbackMeta(c, { release: '20260101-120000' }).toString());
  assert.equal(m.action, 'rollback');
  assert.equal(m.release, '20260101-120000');
});

test('config: env > .env.deploy > xpd.config.json; validation per mode', async () => {
  const root = project({ keep: 4, siteUrl: 'https://example.com/' });
  writeFileSync(join(root, '.env.deploy'), [
    '# comment', 'XPD_HOST=sv12345.xserver.jp', 'XPD_USER="xs123456"', 'XPD_DOCROOT=/home/xs123456/example.com/public_html/',
    'XPD_KEEP=6', 'XPD_SSH_KEY=~/.ssh/none',
  ].join('\n'));
  const c = await loadConfig({ cwd: root, env: { XPD_KEEP: '7' } });
  assert.equal(c.host, 'sv12345.xserver.jp');
  assert.equal(c.user, 'xs123456');
  assert.equal(c.docroot, '/home/xs123456/example.com/public_html', 'trailing slash removed');
  assert.equal(c.keep, 7, 'environment wins');
  assert.equal(c.siteUrl, 'https://example.com');
  assert.equal(c.port, '10022');
  assert.equal(c.remoteBase, '$HOME/.deploy/example-site');
  assert.deepEqual(problemsFor(c, 'ssh', { dry: true }), []);
  assert.ok(problemsFor(c, 'ssh').some((p) => p.includes('XPD_SSH_KEY')), 'missing key reported when not dry');

  const bad = await loadConfig({ cwd: root, env: { XPD_DOCROOT: '/home/xs123456/example.com/www', XPD_HOST: 'a b' } });
  const p = problemsFor(bad, 'ssh', { dry: true });
  assert.ok(p.some((x) => x.startsWith('XPD_DOCROOT')));
  assert.ok(p.some((x) => x.startsWith('XPD_HOST')));

  const win = await loadConfig({ cwd: root, env: { XPD_DOCROOT: 'C:/Program Files/Git/home/x/public_html' } });
  assert.ok(problemsFor(win, 'ssh', { dry: true }).some((x) => x.includes('C:/')));

  const dotdot = await loadConfig({ cwd: root, env: { XPD_DOCROOT: '/home/x/../y/public_html' } });
  assert.ok(problemsFor(dotdot, 'ssh', { dry: true }).some((x) => x.startsWith('XPD_DOCROOT')));
});

test('config: docrootSuffix override, protect validation, branch names', async () => {
  const root = project({ docrootSuffix: '/htdocs', protect: ['/uploads/', '../etc'], branch: 'main', deployBranch: 'main' });
  const c = await loadConfig({ cwd: root, env: { XPD_DOCROOT: '/home/u/example.com/htdocs', XPD_HOST: 'h', XPD_USER: 'u' } });
  const p = problemsFor(c, 'ssh', { dry: true });
  assert.ok(!p.some((x) => x.startsWith('XPD_DOCROOT')), 'suffix override accepted');
  assert.ok(p.some((x) => x.includes('"../etc"')));
  assert.ok(p.some((x) => x.includes('別の名前')));
  const c2 = await loadConfig({ cwd: root, env: { XPD_DOCROOT: '/home/u/example.com/public_html' } });
  assert.ok(problemsFor(c2, 'ssh', { dry: true }).some((x) => x.startsWith('XPD_DOCROOT')));
});

test('config: nothing that ssh or git could read as an option (leading "-")', async () => {
  const root = project({ branch: '-upload-pack', deployBranch: 'deploy', statusBranch: 'deploy-status' });
  const c = await loadConfig({
    cwd: root, env: { XPD_DOCROOT: '/home/u/example.com/public_html', XPD_HOST: '-oProxyCommand', XPD_USER: '-x' },
  });
  const p = problemsFor(c, 'ssh', { dry: true });
  assert.ok(p.some((x) => x.startsWith('branch')));
  assert.ok(p.some((x) => x.startsWith('XPD_HOST')));
  assert.ok(p.some((x) => x.startsWith('XPD_USER')));
  assert.throws(() => init(tmp('xpd-init-'), { branch: 'main\n  evil: 1' }), /--branch/);
});

test('workflow template: write token never persisted for the build, never on a command line; inputs only via env', () => {
  const wf = readFileSync(new URL('../../templates/github-workflow.yml', import.meta.url), 'utf8');
  assert.match(wf, /persist-credentials: false/);
  assert.ok(!/-c http\.extraheader/.test(wf), 'no token in git -c arguments');
  // ${{ inputs.* }} / event data must never be expanded inside a run: script (script injection)
  const runLines = wf.split('\n').filter((l) => !/^\s*(#|[A-Z_][A-Z0-9_]*:\s|- uses:|- name:|ref:|node-version:|description:|default:|type:|required:|if:|continue-on-error:)/.test(l));
  for (const l of runLines) assert.ok(!/\$\{\{\s*(inputs|github\.event)\./.test(l), `expression inside a script: ${l.trim()}`);
  assert.ok(!wf.includes('docs/ja/github-actions.md'), 'doc link points to an existing page');
});

test('config: xpd.config.mjs (default export, function allowed)', async () => {
  const root = tmp('xpd-mjs-');
  writeFileSync(join(root, 'xpd.config.mjs'), "export default () => ({ name: 'mjs-site', outDir: 'build', build: 'echo hi' });\n");
  const c = await loadConfig({ cwd: root, env: {} });
  assert.equal(c.name, 'mjs-site');
  assert.equal(c.outDir, 'build');
  assert.equal(c.build, 'echo hi');
});

test('parseEnvFile', () => {
  assert.deepEqual(parseEnvFile('A=1\n# B=2\nexport C="x y"\nD=\'q\'\n  E = 5  \nbad line'), { A: '1', C: 'x y', D: 'q', E: '5' });
});

test('remote commands only interpolate validated values', async () => {
  const root = project();
  const c = await loadConfig({ cwd: root, env: { XPD_DOCROOT: '/home/xs123456/example.com/public_html' } });
  const cmd = deployCmd(c, { force: true });
  assert.match(cmd, /deploy "\$U" \/home\/xs123456\/example\.com\/public_html 5 install force$/);
  assert.match(cmd, /XPD_DOCROOT_SUFFIX=\/public_html/);
  assert.throws(() => rollbackCmd(c, '1;rm -rf ~'), /リリース ID/);
  assert.match(rollbackCmd(c, '20260101-120000'), /rollback \/home\/xs123456\/example\.com\/public_html 20260101-120000$/);
});

test('cli: argument parsing', () => {
  assert.deepEqual(parseArgs(['deploy', '--dry-run', '--force']), { cmd: 'deploy', args: [], flags: { 'dry-run': true, force: true } });
  assert.deepEqual(parseArgs(['rollback', '20260101-120000']).args, ['20260101-120000']);
  assert.equal(parseArgs(['bundle-only', '--rollback']).flags.rollback, '');
  assert.equal(parseArgs(['bundle-only', '--rollback', 'previous', '--out', 'x']).flags.rollback, 'previous');
  assert.equal(parseArgs(['wait', '--commit=HEAD']).flags.commit, 'HEAD');
  assert.throws(() => parseArgs(['wait', '--commit']), /値が必要/);
});

test('init: detects the generator and scaffolds config, env example, workflow, .gitignore', () => {
  const root = tmp('xpd-init-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@your-org/your-site', scripts: { build: 'astro build' }, devDependencies: { astro: '5' } }));
  assert.equal(detect(root).outDir, 'dist');
  const written = init(root, { siteUrl: 'https://example.com' });
  assert.deepEqual(written.sort(), ['.env.deploy.example', '.github/workflows/xserver-pull-deploy.yml', '.gitignore', 'xpd.config.json']);
  const cfg = JSON.parse(readFileSync(join(root, 'xpd.config.json'), 'utf8'));
  assert.deepEqual([cfg.name, cfg.build, cfg.outDir], ['your-site', 'npm run build', 'dist']);
  const wf = readFileSync(join(root, '.github/workflows/xserver-pull-deploy.yml'), 'utf8');
  assert.ok(!wf.includes('__'), 'all placeholders replaced');
  assert.match(wf, /XPD: npx --no-install xpd/);
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\.env\.deploy$/m);
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^node_modules\/$/m, 'an npm project never commits node_modules');
  assert.deepEqual(init(root, {}), [], 'never overwrites without --force');

  const hugo = tmp('xpd-hugo-');
  writeFileSync(join(hugo, 'hugo.toml'), 'title = "x"\n');
  assert.deepEqual(detect(hugo), { build: 'hugo --minify', outDir: 'public', kind: 'Hugo' });
  const plain = tmp('xpd-plain-');
  mkdirSync(join(plain, 'public'));
  assert.equal(detect(plain).build, '');
  assert.ok(existsSync(join(plain, 'public')));
  init(plain, {});
  assert.ok(!/node_modules/.test(readFileSync(join(plain, '.gitignore'), 'utf8')), 'no package.json: no node_modules line');
});
