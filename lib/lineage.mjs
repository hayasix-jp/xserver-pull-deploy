// lib/lineage.mjs — the lineage guard: never silently overwrite what another path published.
//
// PC (xpd deploy):  1. origin/<branch> has commits this PC does not  → stop ("git pull first")
//                   2. the live commit (/_deploy/live.json) is not in this PC's history → stop
//                   3. uncommitted changes (unless --allow-dirty) → stop
// CI (xpd lineage --ci): only 2, and an unreadable live.json (other than 404) fails the run.
// --overwrite (PC) / the workflow's "overwrite" input skips the guard on purpose.
import { getStatusFile } from './http.mjs';
import { gitIn } from './git.mjs';
import { warn } from './log.mjs';

/** @returns {Promise<string[]>} reasons to stop (empty = go) */
export const lineageGuard = async (c, { ci = false, allowDirty = false } = {}) => {
  const git = gitIn(c.root);
  const stops = [];
  if (!git.isRepo()) {
    if (ci) stops.push('git リポジトリではありません（actions/checkout の fetch-depth: 0 を確認）');
    else warn('git リポジトリではないので、系譜ガードを省略します');
    return stops;
  }
  const head = git.head();
  if (!ci) {
    if (!git.hasRemote('origin')) {
      warn('git の origin（GitHub）が未設定です。GitHub との行き違いの確認（ガード 1）を省略します');
    } else {
      const r = git.run(['fetch', '--quiet', 'origin', c.branch], 20000);
      if (r.status !== 0) {
        const why = r.error?.code === 'ETIMEDOUT' ? '20 秒で打ち切り' : (r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`;
        warn(`git fetch origin ${c.branch} に失敗しました（${why}）。手元の origin/${c.branch} で判定します`);
      }
      if (git.hasRef(`refs/remotes/origin/${c.branch}`)) {
        const behind = git.count(`HEAD..origin/${c.branch}`);
        if (behind > 0) stops.push(`GitHub の ${c.branch} に、このPCにない更新が ${behind} 件あります。git pull してから公開してください`);
      }
    }
  }
  if (c.siteUrl) {
    const { status, json, error } = await getStatusFile(c.siteUrl, 'live.json');
    if (status === 200 && json) {
      const live = typeof json.commit === 'string' ? json.commit : '';
      if (json.dirty === true) warn('公開中の内容は、未コミットの変更から公開されたものです（dirty）');
      if (/^[0-9a-f]{40}$/.test(live) && head) {
        if (!git.hasCommit(live) || !git.isAncestor(live, head)) {
          stops.push(ci
            ? `GitHub にまだ無い内容が公開されています（公開中 ${live.slice(0, 12)}）。PC で git push してから公開してください。古い版を意図的に公開するなら overwrite を指定`
            : `公開中のサイト（${live.slice(0, 12)}）に、このPCの履歴にない更新が含まれています。git pull してから公開してください`);
        }
      } else if (!live) {
        warn('live.json に commit がありません。公開中の内容の確認（ガード 2）を省略します');
      }
    } else if (status === 404) {
      // first deploy: nothing to protect yet
    } else if (ci) {
      stops.push(`公開中のサイトの状態（${c.siteUrl}/_deploy/live.json）を確認できません（${status ? `HTTP ${status}` : error}）。サーバーの状態を確認してから、もう一度公開してください`);
    } else {
      warn(`${c.siteUrl}/_deploy/live.json を確認できません（${status ? `HTTP ${status}` : error}）。ガード 2 を省略します`);
    }
  } else {
    warn('siteUrl が未設定なので、公開中の内容の確認（ガード 2）を省略します');
  }
  if (!ci && git.dirty() && !allowDirty) stops.push('未コミットの変更があります。コミットしてから公開してください（このまま公開するなら --allow-dirty）');
  return stops;
};
