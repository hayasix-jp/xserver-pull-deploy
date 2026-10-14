// lib/bundle.mjs — the deploy bundle (.tar.gz).
//
//   site/**          the build output (outDir), minus /.well-known/, /_deploy/ and the configured protect paths
//   META.json        {commit, subject, source, trigger, run_url, built_at, force, dirty, tool}
//   REVISION         "<commit>[ dirty] <built_at> <source>"
// PC bundles (withServer) add server/: remote-deploy.sh, pull.sh, kick.php, deploy.htaccess, protect.list and
// htaccess.pin. Those are the only way the server-side scripts and the .htaccess pin ever change; pull.sh refuses any
// bundle from GitHub that carries them.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, warn } from './log.mjs';
import { matchesSelfOrParent } from './pattern.mjs';
import { tarball } from './tar.mjs';

export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER_DIR = join(PKG_ROOT, 'server');
export const VERSION = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** CRLF → LF (Windows checkouts with core.autocrlf) so PC and CI produce the same bytes and the same pin */
export const lf = (buf) => Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'));
const toPosix = (p) => p.split(sep).join(posix.sep);

/** Every file and directory under dir (no symlinks followed: a link in the build output is an error). */
export const walk = (dir) =>
  readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) fail(`ビルド結果にシンボリックリンクがあります（公開できません）: ${p}`);
    return st.isDirectory() ? [{ p, dir: true }, ...walk(p)] : [{ p, dir: false }];
  });

/** The files the server-side install needs (from this package's server/). */
export const serverFiles = () => [
  ['server/', null, 'dir'],
  ['server/remote-deploy.sh', lf(readFileSync(join(SERVER_DIR, 'remote-deploy.sh')))],
  ['server/pull.sh', lf(readFileSync(join(SERVER_DIR, 'pull.sh')))],
  ['server/kick.php', lf(readFileSync(join(SERVER_DIR, 'kick.php')))],
  ['server/deploy.htaccess', lf(readFileSync(join(SERVER_DIR, 'deploy.htaccess')))],
];

/**
 * Builds the bundle from c.outPath.
 * @param {object} c config (lib/config.mjs)
 * @param {{commit: string, subject?: string, dirty?: boolean, force?: boolean, trigger?: string, runUrl?: string,
 *          withServer?: boolean, now?: Date}} o
 */
export const makeBundle = (c, o) => {
  const builtAt = (o.now ?? new Date()).toISOString();
  const meta = {
    commit: o.commit,
    subject: (o.subject ?? '').slice(0, 200),
    source: c.source,
    trigger: o.trigger || (c.source === 'local' ? 'local' : 'manual'),
    run_url: o.runUrl ?? '',
    built_at: builtAt,
    force: Boolean(o.force),
    dirty: Boolean(o.dirty),
    tool: `xserver-pull-deploy/${VERSION}`,
  };
  const metaJson = Buffer.from(`${JSON.stringify(meta)}\n`);
  const revision = `${o.commit}${o.dirty ? ' dirty' : ''} ${builtAt} ${c.source}`;

  const entries = [['site/', null, 'dir']];
  const pin = [];
  const skipped = [];
  let files = 0;
  let bytes = 0;
  let hasIndex = false;
  for (const { p, dir } of walk(c.outPath)) {
    const relSite = toPosix(relative(c.outPath, p));
    if (c.protectAll.some((pat) => matchesSelfOrParent(pat, relSite, dir))) {
      if (!skipped.some((s) => relSite.startsWith(`${s}/`))) skipped.push(relSite);
      continue;
    }
    const rel = `site/${relSite}${dir ? '/' : ''}`;
    if (/[\u0000-\u001f\u007f\\]/.test(relSite)) fail(`公開できないファイル名です（制御文字や \\ を含む）: ${relSite}`);
    if (dir) {
      entries.push([rel, null, 'dir']);
      continue;
    }
    const isHtaccess = basename(p) === '.htaccess';
    const body = isHtaccess ? lf(readFileSync(p)) : readFileSync(p);
    if (isHtaccess) pin.push(`${rel} ${sha256(body)}`);
    if (rel === 'site/index.html') hasIndex = true;
    entries.push([rel, body]);
    files++;
    bytes += body.length;
  }
  if (!hasIndex) fail(`${c.outPath}/index.html がありません（ビルド結果が不完全か、outDir の指定が違います）`);
  for (const s of skipped) warn(`保護対象なので bundle に入れません: ${s}`);
  entries.push(['META.json', metaJson], ['REVISION', Buffer.from(`${revision}\n`)]);
  pin.sort();
  if (o.withServer) {
    entries.push(
      ...serverFiles(),
      ['server/protect.list', Buffer.from(`${c.protectAll.join('\n')}\n`)],
      ['server/htaccess.pin', Buffer.from(pin.length ? `${pin.join('\n')}\n` : '')],
    );
  }
  const buffer = tarball(entries);
  return { buffer, sha256: sha256(buffer), meta, metaJson, revision, pin, files, bytes };
};

/** A rollback request for the pull path: META.json only. */
export const rollbackMeta = (c, { release, trigger, runUrl }) =>
  Buffer.from(`${JSON.stringify({
    action: 'rollback',
    release: release || 'previous',
    source: c.source,
    trigger: trigger || 'manual',
    run_url: runUrl || '',
    tool: `xserver-pull-deploy/${VERSION}`,
  })}\n`);
