// test/helpers/bundles.mjs — site fixtures, uploads (extracted bundles) and tar.gz bundles, including hostile ones.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tarball } from '../../lib/tar.mjs';
import { randomSha } from './fake-github.mjs';
import { write } from './env.mjs';

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export const HTACCESS = 'Options -Indexes\nErrorDocument 404 /404.html\n';

/** A small site as {path: content}. `pages` extra pages are added as about-N/index.html. */
export const siteFiles = ({ title = 'v1', pages = 3, htaccess = HTACCESS } = {}) => {
  const files = {
    'index.html': `<!doctype html><title>${title}</title><h1>${title}</h1>\n`,
    '404.html': '<!doctype html><title>404</title>\n',
    'assets/app.css': `body{color:#111}/*${title}*/\n`,
  };
  for (let i = 1; i <= pages; i++) files[`about-${i}/index.html`] = `<!doctype html><p>page ${i} ${title}</p>\n`;
  if (htaccess !== null) files['.htaccess'] = htaccess;
  return files;
};

export const meta = (commit, extra = {}) => ({
  commit, subject: 'test commit', source: 'github-actions', trigger: 'push', run_url: '', built_at: new Date().toISOString(),
  force: false, dirty: false, ...extra,
});

/** Writes an extracted upload under base/incoming (what remote-deploy.sh deploy expects). */
export const makeUpload = (base, files, m = meta(randomSha())) => {
  const dir = join(base, 'incoming', `u.${randomBytes(4).toString('hex')}`);
  mkdirSync(join(dir, 'site'), { recursive: true });
  for (const [p, body] of Object.entries(files)) write(join(dir, 'site', p), body);
  write(join(dir, 'META.json'), `${JSON.stringify(m)}\n`);
  write(join(dir, 'REVISION'), `${m.commit} ${m.built_at} test\n`);
  return dir;
};

/** The .htaccess pin for a set of site files (what a PC deploy records). */
export const pinFor = (files) =>
  Object.entries(files)
    .filter(([p]) => p === '.htaccess' || p.endsWith('/.htaccess'))
    .map(([p, b]) => `site/${p} ${sha256(Buffer.from(b))}`)
    .sort()
    .join('\n');

/**
 * A pull bundle: {tar, sha, meta} as the GitHub workflow leaves them on the deploy branch.
 * `extra` = additional raw tar entries [name, body, type, link] (for hostile bundles).
 */
export const pullBundle = (files, { commit = randomSha(), extra = [], metaExtra = {} } = {}) => {
  const m = meta(commit, metaExtra);
  const entries = [['site/', null, 'dir']];
  const dirs = new Set();
  for (const p of Object.keys(files).sort()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = `site/${parts.slice(0, i).join('/')}/`;
      if (!dirs.has(d)) {
        dirs.add(d);
        entries.push([d, null, 'dir']);
      }
    }
    entries.push([`site/${p}`, Buffer.from(files[p])]);
  }
  entries.push(['META.json', Buffer.from(`${JSON.stringify(m)}\n`)], ['REVISION', Buffer.from(`${commit} test\n`)], ...extra);
  const tar = tarball(entries);
  return { tar, sha: sha256(tar), meta: m, metaJson: Buffer.from(`${JSON.stringify(m)}\n`), commit };
};

/** Deploy-branch files for the fake GitHub from a pull bundle. */
export const deployFiles = (b, { sha = b.sha } = {}) => ({
  'bundle.tar.gz': b.tar,
  'bundle.sha256': Buffer.from(`${sha}  bundle.tar.gz\n`),
  'META.json': b.metaJson,
});
