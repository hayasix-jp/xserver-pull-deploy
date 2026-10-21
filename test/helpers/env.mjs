// test/helpers/env.mjs — shared helpers: temp dirs, the local sh, path conversion for Git for Windows, a fake server
// home with a docroot, running the server scripts, and a static file server over a docroot.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FAKES = join(ROOT, 'test', 'fakes');
export const IS_WIN = process.platform === 'win32';

/** sh is required for the server-side tests (Git Bash on Windows). */
export const SH = (() => {
  const r = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'ok' ? 'sh' : '';
})();
const has = (cmd) => SH && spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
export const HAS_REAL_RSYNC = has('rsync') && process.env.XPD_TEST_FAKE_RSYNC !== '1';
export const HAS_CURL = has('curl');
export const HAS_FLOCK = has('flock');
export const HAS_PHP = has('php');

/** PATH for the server scripts: the rsync stand-in only when there is no real rsync. */
export const serverPath = () => (HAS_REAL_RSYNC ? process.env.PATH : `${join(FAKES, 'bin')}${delimiter}${process.env.PATH}`);

/** C:\a\b → /c/a/b on Windows (what sh scripts see); unchanged elsewhere. */
export const shPath = (p) => (IS_WIN ? p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : p);

const created = [];
process.on('exit', () => {
  if (process.env.XPD_TEST_KEEP_TMP) return;
  for (const d of created) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});
/** A fresh temp dir, removed when the test process exits (XPD_TEST_KEEP_TMP=1 keeps them for debugging). */
export const tmp = (prefix = 'xpd-') => {
  // long names: a Windows 8.3 TEMP (C:\Users\RUNNER~1\…) would put "~" into the fake server paths
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  created.push(d);
  return d;
};

/**
 * A fake server account: <t>/home/xs123456 with ~/.deploy/<name> and example.com/public_html.
 * @returns {{home: string, base: string, docroot: string, shHome: string, shBase: string, shDocroot: string}}
 */
export const fakeServer = (name = 'example-site') => {
  const t = tmp();
  const home = join(t, 'home', 'xs123456');
  const base = join(home, '.deploy', name);
  const docroot = join(home, 'example.com', 'public_html');
  mkdirSync(docroot, { recursive: true });
  mkdirSync(base, { recursive: true });
  return { t, home, base, docroot, shHome: shPath(home), shBase: shPath(base), shDocroot: shPath(docroot) };
};

/** Copies the server scripts into base (what a PC deploy installs). */
export const installServerScripts = (s) => {
  for (const f of ['remote-deploy.sh', 'pull.sh']) writeFileSync(join(s.base, f), readFileSync(join(ROOT, 'server', f)));
};

/** Runs a command asynchronously (so in-process servers can answer). */
/** process.env + overrides; on Windows a PATH override replaces "Path" instead of adding a second key */
export const mergeEnv = (over = {}) => {
  const e = { ...process.env };
  for (const k of Object.keys(over)) {
    for (const ek of Object.keys(e)) if (ek !== k && ek.toUpperCase() === k.toUpperCase()) delete e[ek];
    e[k] = over[k];
  }
  return e;
};

export const run = (cmd, args, { env = {}, input, cwd } = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: mergeEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });

/** sh <script in base> args… with the server PATH */
export const runServer = (s, script, args, env = {}) =>
  run('sh', [`${s.shBase}/${script}`, ...args], { env: { PATH: serverPath(), XPD_LOCK_WAIT: '2', XPD_GH_RETRY: '0', ...env } });

/** Lists files under dir as sorted relative posix paths (dirs with a trailing /). */
export const tree = (dir, rel = '') =>
  readdirSync(join(dir, rel)).sort().flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    return statSync(join(dir, r)).isDirectory() ? [`${r}/`, ...tree(dir, r)] : [r];
  });

export const read = (p) => readFileSync(p, 'utf8');
export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
export const write = (p, body) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
};
export const rm = (p) => rmSync(p, { recursive: true, force: true });
export { existsSync };

/** Static HTTP server over a docroot, roughly what Apache + the _deploy/.htaccess do. */
export async function startSite(docroot) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith('/_deploy')) {
      const m = p.match(/^\/_deploy\/((?:live|meta|pull)\.json|kick\.php)$/);
      if (!m) return res.writeHead(403).end('forbidden');
      if (m[1] === 'kick.php') {
        if (req.method !== 'POST') return res.writeHead(405, { allow: 'POST' }).end('{"state":"method_not_allowed"}');
        return res.writeHead(202).end('{"state":"queued"}');
      }
      const f = join(docroot, '_deploy', m[1]);
      if (!existsSync(f)) return res.writeHead(404).end();
      return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(readFileSync(f));
    }
    let f = join(docroot, p);
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
    if (!existsSync(f)) return res.writeHead(404).end('not found');
    return res.writeHead(200, { 'cache-control': 'no-cache' }).end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** git in a directory, synchronously, with a fixed identity. */
export const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
