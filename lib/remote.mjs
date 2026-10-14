// lib/remote.mjs — the shell command lines sent over ssh. Every interpolated value was validated by lib/config.mjs
// (name, docroot, suffix: [A-Za-z0-9._/-] only; keep: integer; release id: [0-9-]), so nothing here needs quoting
// beyond what is shown.
import { RELEASE_RE } from './config.mjs';
import { fail } from './log.mjs';

const base = (c) => `B="${c.remoteBase}"`;
const env = (c, source) => `DEPLOY_SOURCE=${source} XPD_DOCROOT_SUFFIX=${c.docrootSuffix}`;
const needInstalled = 'if [ ! -f "$B/remote-deploy.sh" ]; then echo "[server] ERROR: まだ一度も PC から xpd deploy されていません（$B/remote-deploy.sh がありません）" >&2; exit 67; fi';

/** PC deploy: unpack the bundle, install the newest remote-deploy.sh, publish (+ install pull.sh, kick.php, pin). */
export const deployCmd = (c, { force = false } = {}) => [
  'set -e', "trap '' HUP PIPE", 'umask 022', base(c), 'mkdir -p "$B/incoming"', 'U=$(mktemp -d "$B/incoming/u.XXXXXX")',
  'tar -xzf - -C "$U" --no-same-owner --no-same-permissions',
  'cp "$U/server/remote-deploy.sh" "$B/remote-deploy.sh.$$"', 'chmod 700 "$B/remote-deploy.sh.$$"',
  'mv -f "$B/remote-deploy.sh.$$" "$B/remote-deploy.sh"',
  `${env(c, 'local')} exec sh "$B/remote-deploy.sh" deploy "$U" ${c.docroot} ${c.keep} install${force ? ' force' : ''}`,
].join('; ');

export const rollbackCmd = (c, id) => {
  if (id && !RELEASE_RE.test(id)) fail(`リリース ID の形式が違います: ${id}`, 64);
  return [base(c), needInstalled, `${env(c, 'rollback')} sh "$B/remote-deploy.sh" rollback ${c.docroot}${id ? ` ${id}` : ''}`].join('; ');
};

export const listCmd = (c) => [base(c), needInstalled, 'sh "$B/remote-deploy.sh" list'].join('; ');

export const checkCmd = (c) => [
  base(c), 'D=' + c.docroot,
  'echo "connected: $(whoami)@$(hostname)"',
  "for t in rsync tar gzip flock mktemp curl sha256sum sendmail php; do printf '  %s: ' $t; command -v $t || echo MISSING; done",
  'curl --version 2>/dev/null | head -n 1 | sed "s/^/  /"',
  'ls -ld "$D" || echo "  公開ディレクトリがありません（サーバーパネルでドメインを追加済みか確認）"',
  'echo "--- $D"', 'ls -la "$D" 2>/dev/null | head -n 30',
  'if [ -f "$D/.htaccess" ]; then echo "--- $D/.htaccess"; cat "$D/.htaccess"; fi',
  'echo "--- $B"', 'cat "$B/current" 2>/dev/null | sed "s/^/current release: /"',
  'ls -l "$B/remote-deploy.sh" "$B/pull.sh" "$B/pull.env" "$B/htaccess.pin" "$B/protect.list" "$D/_deploy" 2>&1 | sed "s/^/  /"',
  'echo "--- pull.log (last 5)"', 'tail -n 5 "$B/pull.log" 2>/dev/null',
  'echo "--- live.json / pull.json"', 'cat "$D/_deploy/live.json" "$D/_deploy/pull.json" 2>/dev/null',
  'true',
].join('; ');

/** setup-pull: stdin = tar.gz with pull.env. Requires one PC deploy first (pull.sh and the .htaccess pin). */
export const setupPullCmd = (c) => [
  'set -e', "trap '' HUP PIPE", 'umask 077', base(c),
  'if [ ! -f "$B/pull.sh" ]; then echo "[server] ERROR: 先に PC から xpd deploy を一度実行してください（$B/pull.sh がありません）" >&2; exit 67; fi',
  'mkdir -p "$B/incoming"', 'U=$(mktemp -d "$B/incoming/s.XXXXXX")',
  'tar -xzf - -C "$U" --no-same-owner --no-same-permissions',
  'mv -f "$U/pull.env" "$B/pull.env"', 'chmod 600 "$B/pull.env"', 'rm -rf "$U"',
  'echo', 'sh "$B/pull.sh" check || echo "（上の表示を確認してください。設定は保存済みです）"',
  'echo', 'echo "サーバーパネル → Cron設定 に次の 1 行を追加してください（毎分が選べなければ */5）:"',
  'echo "  * * * * * /bin/sh $B/pull.sh cron >/dev/null 2>&1"',
].join('; ');
