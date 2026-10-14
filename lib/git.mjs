// lib/git.mjs — the few git questions the deploy asks. Every call is non-interactive.
import { spawnSync } from 'node:child_process';

export const gitIn = (cwd) => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const run = (args, timeout = 0) => spawnSync('git', args, { cwd, encoding: 'utf8', env, ...(timeout && { timeout }) });
  const out = (...a) => {
    const r = run(a);
    return r.status === 0 ? r.stdout.trim() : '';
  };
  const ok = (...a) => run(a).status === 0;
  return {
    run,
    out,
    ok,
    isRepo: () => ok('rev-parse', '--git-dir'),
    head: () => out('rev-parse', 'HEAD'),
    subject: () => out('log', '-1', '--format=%s'),
    dirty: () => Boolean(out('status', '--porcelain')),
    hasRemote: (name) => out('remote').split(/\s+/).includes(name),
    hasRef: (ref) => ok('rev-parse', '--verify', '--quiet', ref),
    hasCommit: (sha) => ok('cat-file', '-e', `${sha}^{commit}`),
    isAncestor: (a, b) => ok('merge-base', '--is-ancestor', a, b),
    count: (range) => Number(out('rev-list', '--count', range) || 0),
    originUrl: () => out('remote', 'get-url', 'origin'),
  };
};

/** owner/repo from a GitHub remote URL (https or ssh), or '' */
export const repoFromUrl = (url) => url.match(/github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)?.[1] || '';
