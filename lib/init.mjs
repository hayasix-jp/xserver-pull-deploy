// lib/init.mjs — `xpd init`: scaffold xpd.config.json, .env.deploy.example, the GitHub workflow and .gitignore lines.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { PKG_ROOT } from './bundle.mjs';
import { BRANCH_RE, NAME_RE } from './config.mjs';
import { fail, log, warn } from './log.mjs';

const TEMPLATES = join(PKG_ROOT, 'templates');

/** Guesses the build command and output folder from the files present. */
export const detect = (root) => {
  const has = (f) => existsSync(join(root, f));
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch { /* no package.json */ }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const script = pkg.scripts?.build ? 'npm run build' : '';
  if (deps.astro) return { build: script || 'npx astro build', outDir: 'dist', kind: 'Astro' };
  if (deps.next) return { build: script || 'npx next build', outDir: 'out', kind: 'Next.js (output: "export")' };
  if (deps.vite) return { build: script || 'npx vite build', outDir: 'dist', kind: 'Vite' };
  if (deps['@11ty/eleventy']) return { build: script || 'npx @11ty/eleventy', outDir: '_site', kind: '11ty' };
  if (has('hugo.toml') || has('hugo.yaml') || has('config.toml')) return { build: 'hugo --minify', outDir: 'public', kind: 'Hugo' };
  if (script) return { build: script, outDir: 'dist', kind: 'npm' };
  return { build: '', outDir: 'public', kind: 'plain HTML' };
};

const safeName = (s) => {
  const n = String(s || '').toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64);
  return NAME_RE.test(n) ? n : 'my-site';
};

/** How the workflow runs xpd: a devDependency → npx; a vendored copy inside the project → node <path>. */
export const xpdInvocation = (root) => {
  const rel = relative(root, join(PKG_ROOT, 'bin', 'xpd.mjs')).split(sep).join('/');
  if (!rel.startsWith('..') && !rel.startsWith('node_modules/')) return `node ${rel}`;
  return 'npx --no-install xpd';
};

/**
 * @param {string} root project root
 * @param {{force?: boolean, name?: string, build?: string, outDir?: string, siteUrl?: string, branch?: string}} o
 * @returns {string[]} written files
 */
export const init = (root, o = {}) => {
  const d = detect(root);
  let pkgName = '';
  try {
    pkgName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
  } catch { /* none */ }
  const branch = o.branch || 'main';
  // the branch name is written into the workflow YAML as-is
  if (!BRANCH_RE.test(branch)) fail(`--branch の形式が違います（英数字と . _ / - のブランチ名）: ${branch}`, 64);
  const cfg = {
    name: safeName(o.name || pkgName || basename(root)),
    build: o.build ?? d.build,
    outDir: o.outDir || d.outDir,
    siteUrl: o.siteUrl || 'https://example.com',
    branch,
    keep: 5,
    protect: [],
  };
  const written = [];
  const write = (rel, content) => {
    const p = join(root, rel);
    if (existsSync(p) && !o.force) {
      warn(`${rel} はすでにあるので変更しません（上書きするなら --force）`);
      return;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    written.push(rel);
  };
  write('xpd.config.json', `${JSON.stringify(cfg, null, 2)}\n`);
  write('.env.deploy.example', readFileSync(join(TEMPLATES, 'env.deploy.example'), 'utf8'));
  const wf = readFileSync(join(TEMPLATES, 'github-workflow.yml'), 'utf8')
    .replaceAll('__BRANCH__', branch)
    .replaceAll('__DEPLOY_BRANCH__', 'deploy')
    .replaceAll('__STATUS_BRANCH__', 'deploy-status')
    .replaceAll('__XPD__', xpdInvocation(root));
  write('.github/workflows/xserver-pull-deploy.yml', wf);

  const gi = join(root, '.gitignore');
  const current = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const lines = current.split(/\r?\n/);
  // node_modules/ too when this is an npm project (`npm i -D` in a plain HTML site creates it; it must not be committed)
  const npm = existsSync(join(root, 'package.json')) && !lines.some((l) => /^\/?node_modules\/?$/.test(l.trim()));
  const add = ['.env.deploy', '.xpd-bundle/', ...(npm ? ['node_modules/'] : [])].filter((l) => !lines.includes(l));
  if (add.length) {
    writeFileSync(gi, `${current}${current && !current.endsWith('\n') ? '\n' : ''}# xserver-pull-deploy\n${add.join('\n')}\n`);
    written.push('.gitignore');
  }
  log(`検出: ${d.kind}（build: ${cfg.build || '（なし）'}, outDir: ${cfg.outDir}）`);
  return written;
};
