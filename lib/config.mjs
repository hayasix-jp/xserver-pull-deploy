// lib/config.mjs — configuration = xpd.config.json | xpd.config.mjs (committed; what the site is) +
// .env.deploy (NOT committed; where this machine deploys to) + environment variables (win over both).
//
// xpd.config.json                         .env.deploy / environment
//   name          server folder name       XPD_HOST          sv12345.xserver.jp / xs123456.xsrv.jp
//   build         build command            XPD_USER          server ID (xs123456)
//   outDir        build output folder      XPD_PORT          10022 (Xserver)
//   siteUrl       https://example.com      XPD_DOCROOT       /home/xs123456/example.com/public_html
//   branch        main                     XPD_SSH_KEY       ~/.ssh/xpd_deploy
//   keep          5 releases               XPD_KNOWN_HOSTS   optional known_hosts file
//   docrootSuffix /public_html             XPD_STRICT_HOST_KEY  accept-new (PC) | yes (CI)
//   protect       ["/uploads/"]            XPD_SSH_BIN       ssh (or the full path of ssh.exe)
//   deployBranch  deploy                   XPD_RETRIES       ssh connection retries (3)
//   statusBranch  deploy-status            XPD_GITHUB_REPO   owner/repo (setup-pull; default: git origin)
//   githubRepo    owner/repo               XPD_NOTIFY_EMAIL  failure mail address (setup-pull)
//                                          XPD_SITE_URL, XPD_KEEP, XPD_BUILD, XPD_OUT_DIR override the file
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail } from './log.mjs';
import { BUILTIN_PROTECT, validProtect } from './pattern.mjs';

export const CONFIG_FILES = ['xpd.config.json', 'xpd.config.mjs'];
export const ENV_FILE = '.env.deploy';

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// no leading "-" (git would read it as an option), no "..", no leading/trailing "/"
export const BRANCH_RE = /^(?!.*\.\.)(?![-/])(?!.*\/$)[A-Za-z0-9._/-]{1,100}$/;
export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const SUFFIX_RE = /^\/[A-Za-z0-9._/-]+$/;
export const DOCROOT_CHARS_RE = /^\/[A-Za-z0-9._/-]+$/;
export const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+$/;
export const RELEASE_RE = /^[0-9][0-9-]{0,40}$/;

/** KEY=value lines; # comments; optional quotes. Unknown keys are kept (callers pick what they need). */
export const parseEnvFile = (text) => {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
};

const expandHome = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p).split(sep).join('/');

/** Where the config lives: --config, else the first xpd.config.* in cwd. '' when there is none. */
export const findConfigFile = (cwd, explicit) => {
  if (explicit) {
    const p = resolve(cwd, explicit);
    if (!existsSync(p)) fail(`設定ファイルが見つかりません: ${p}`, 2);
    return p;
  }
  for (const f of CONFIG_FILES) if (existsSync(join(cwd, f))) return join(cwd, f);
  return '';
};

const readConfigFile = async (file) => {
  if (!file) return {};
  if (file.endsWith('.json')) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      fail(`${file} を JSON として読めません: ${e.message}`, 2);
    }
  }
  const mod = await import(pathToFileURL(file).href);
  const v = mod.default ?? mod.config;
  return typeof v === 'function' ? await v() : v;
};

/**
 * Loads and normalises the configuration. Never throws for missing values: validation is per command
 * (`problemsFor`). Throws only for unreadable files.
 * @param {{cwd?: string, configPath?: string, env?: Record<string,string|undefined>}} [o]
 */
export const loadConfig = async ({ cwd = process.cwd(), configPath, env = process.env } = {}) => {
  const root = resolve(cwd);
  const file = findConfigFile(root, configPath);
  const fileCfg = (await readConfigFile(file)) || {};
  if (typeof fileCfg !== 'object' || Array.isArray(fileCfg)) fail(`${file}: 設定はオブジェクトにしてください`, 2);
  const projectRoot = file ? resolve(file, '..') : root;
  const envPath = join(projectRoot, ENV_FILE);
  const envFile = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
  /** environment > .env.deploy > xpd.config.* > default; empty strings count as unset */
  const pick = (envKey, fileValue, dflt = '') => {
    for (const v of [env[envKey], envFile[envKey]]) if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (fileValue !== undefined && fileValue !== null && fileValue !== '') return fileValue;
    return dflt;
  };

  const keepRaw = pick('XPD_KEEP', fileCfg.keep, 5);
  const protect = Array.isArray(fileCfg.protect) ? fileCfg.protect.map(String) : [];
  const c = {
    root: projectRoot,
    file,
    envFile: existsSync(envPath) ? envPath : '',
    name: String(fileCfg.name ?? '').trim(),
    build: String(pick('XPD_BUILD', fileCfg.build, '')),
    outDir: String(pick('XPD_OUT_DIR', fileCfg.outDir, 'dist')),
    siteUrl: String(pick('XPD_SITE_URL', fileCfg.siteUrl, '')).replace(/\/+$/, ''),
    branch: String(fileCfg.branch ?? 'main'),
    deployBranch: String(fileCfg.deployBranch ?? 'deploy'),
    statusBranch: String(fileCfg.statusBranch ?? 'deploy-status'),
    keep: Number.parseInt(String(keepRaw), 10),
    keepRaw: String(keepRaw),
    docrootSuffix: String(fileCfg.docrootSuffix ?? '/public_html'),
    protect,
    githubRepo: String(pick('XPD_GITHUB_REPO', fileCfg.githubRepo, '')),
    // per machine
    host: String(pick('XPD_HOST', undefined)),
    user: String(pick('XPD_USER', undefined)),
    port: String(pick('XPD_PORT', undefined, '10022')),
    docroot: String(pick('XPD_DOCROOT', undefined)).replace(/\/+$/, ''),
    key: expandHome(String(pick('XPD_SSH_KEY', undefined, '~/.ssh/xpd_deploy'))),
    knownHosts: pick('XPD_KNOWN_HOSTS', undefined) ? expandHome(String(pick('XPD_KNOWN_HOSTS', undefined))) : '',
    strict: String(pick('XPD_STRICT_HOST_KEY', undefined, 'accept-new')),
    sshBin: String(pick('XPD_SSH_BIN', undefined, 'ssh')),
    retries: Math.min(Math.max(Number.parseInt(String(pick('XPD_RETRIES', undefined, '3')), 10) || 0, 0), 10),
    notifyEmail: String(pick('XPD_NOTIFY_EMAIL', fileCfg.notifyEmail, '')),
    ghApi: String(pick('XPD_GH_API', undefined, '')),
    source: env.GITHUB_ACTIONS ? 'github-actions' : 'local',
  };
  c.outPath = isAbsolute(c.outDir) ? c.outDir : join(projectRoot, c.outDir);
  /** remote base folder (on the server, $HOME is expanded by the remote shell) */
  c.remoteBase = `$HOME/.deploy/${c.name}`;
  /** built-in + configured protect entries, de-duplicated */
  c.protectAll = [...new Set([...BUILTIN_PROTECT, ...protect])];
  return c;
};

/**
 * What is wrong for `mode`: 'ssh' (deploy/check/list/rollback/setup-pull), 'bundle', 'site' (wait/verify/kick).
 * @returns {string[]} problems, in Japanese, each naming the setting
 */
export const problemsFor = (c, mode, { dry = false } = {}) => {
  const p = [];
  const need = (ok, msg) => {
    if (!ok) p.push(msg);
  };
  need(NAME_RE.test(c.name), 'name（英小文字・数字・. _ -。サーバーの ~/.deploy/<name> になります。例: example-site）');
  need(SUFFIX_RE.test(c.docrootSuffix) && !c.docrootSuffix.split('/').includes('..'), 'docrootSuffix（/ で始まるパス。既定 /public_html）');
  for (const b of [['branch', c.branch], ['deployBranch', c.deployBranch], ['statusBranch', c.statusBranch]]) {
    need(BRANCH_RE.test(b[1]), `${b[0]}（ブランチ名）`);
  }
  need(new Set([c.branch, c.deployBranch, c.statusBranch]).size === 3, 'branch / deployBranch / statusBranch はすべて別の名前にしてください');
  for (const e of c.protect) need(validProtect(e), `protect の "${e}"（/uploads/ や /google*.html の形。.. は使えません）`);
  need(Number.isInteger(c.keep) && String(c.keep) === c.keepRaw.trim() && c.keep >= 2 && c.keep <= 100, 'keep（2〜100 の整数）');
  if (c.siteUrl) {
    let ok = false;
    try {
      const u = new URL(c.siteUrl);
      ok = /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
    } catch { /* invalid */ }
    need(ok, `siteUrl（https://example.com の形）: ${c.siteUrl}`);
  }
  if (mode === 'site') need(Boolean(c.siteUrl), 'siteUrl（https://example.com）');
  if (mode === 'ssh') {
    // a leading "-" would turn the ssh destination into an option
    need(/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(c.host), 'XPD_HOST（例: sv12345.xserver.jp / xs123456.xsrv.jp）');
    need(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c.user), 'XPD_USER（サーバーID。例: xs123456）');
    need(/^\d{1,5}$/.test(c.port), 'XPD_PORT（エックスサーバーは 10022）');
    if (/^[A-Za-z]:[\\/]/.test(c.docroot)) {
      p.push('XPD_DOCROOT が C:/… になっています。Git Bash で環境変数として渡すとパスが変換されるので、.env.deploy に書いてください');
    } else {
      need(DOCROOT_CHARS_RE.test(c.docroot) && !c.docroot.split('/').includes('..') && c.docroot.endsWith(c.docrootSuffix) &&
        c.docroot.length > c.docrootSuffix.length,
        `XPD_DOCROOT（${c.docrootSuffix} で終わる絶対パス。例: /home/xs123456/example.com${c.docrootSuffix}）`);
    }
    need(['yes', 'accept-new'].includes(c.strict), 'XPD_STRICT_HOST_KEY（yes または accept-new）');
    if (!dry) need(existsSync(c.key), `XPD_SSH_KEY の秘密鍵が見つかりません: ${c.key}`);
  }
  return p;
};

/** Throws (exit 2) listing every problem, unless `dry` (then the caller only warns). */
export const assertConfig = (c, mode, opts = {}) => {
  const p = problemsFor(c, mode, opts);
  if (p.length && !opts.dry) {
    const where = c.file ? `${c.file}${c.envFile ? ` / ${c.envFile}` : ' / .env.deploy（ありません）'}` : 'xpd.config.json がありません（xpd init）';
    fail(`設定が足りないか、形式が違います（${where}）:\n  - ${p.join('\n  - ')}`, 2);
  }
  return p;
};
