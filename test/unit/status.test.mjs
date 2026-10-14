// Unit tests for status/xpd-status.js: parsing untrusted JSON and the state decision.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge, parseTime, runUrl, snapshot } from '../../status/xpd-status.js';

const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const B = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890';
const NOW = Date.parse('2026-10-01T03:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const REPO = 'your-org/your-site';
const RUN = `https://github.com/${REPO}/actions/runs/123`;

const live = { release: '20261001-115300', published_at: iso(NOW - 7 * 60_000), commit: A, dirty: false, source: 'pull' };
const pull = (o = {}, b = {}) => ({
  checked_at: iso(NOW - 20_000), state: 'idle', message: '', deploy_commit: A, main_commit: A,
  build: { state: 'success', commit: A, run_url: RUN, message: '', at: iso(NOW - 8 * 60_000), ...b },
  token_expires_at: '2027-06-01 00:00:00 UTC', ...o,
});
const key = (raw, opts) => judge(snapshot(raw, { repo: REPO }), NOW, opts);

test('parseTime: ISO and GitHub header forms', () => {
  assert.equal(parseTime('2026-10-01T12:00:00+09:00'), Date.parse('2026-10-01T03:00:00Z'));
  assert.equal(parseTime('2026-10-01 03:00:00 UTC'), Date.parse('2026-10-01T03:00:00Z'));
  assert.equal(parseTime('2026-10-01 12:00:00 +0900'), Date.parse('2026-10-01T03:00:00Z'));
  assert.ok(Number.isNaN(parseTime('yesterday')));
});

test('runUrl only for this repository', () => {
  assert.equal(runUrl(RUN, REPO), RUN);
  assert.equal(runUrl(`${RUN}/attempts/2`, REPO), `${RUN}/attempts/2`);
  assert.equal(runUrl('https://github.com/other/repo/actions/runs/1', REPO), '');
  assert.equal(runUrl(`https://github.com/${REPO}/actions/runs/1/../../../evil`, REPO), '');
  assert.equal(runUrl('javascript:alert(1)', REPO), '');
  assert.equal(runUrl(RUN, ''), '', 'no repo configured → no links');
});

test('state table, top to bottom', () => {
  assert.equal(key({ live, pull: pull() }).key, 'published');
  assert.equal(key({ live, pull: pull({ main_commit: B }) }).key, 'unpublished');
  assert.equal(key({ live, pull: pull({ main_commit: B }, { state: 'building', commit: B, at: iso(NOW - 40_000) }) }).key, 'building');
  assert.equal(key({ live, pull: pull({ main_commit: B }, { state: 'building', commit: B, at: iso(NOW - 3600_000) }) }).key, 'unpublished',
    'a "building" older than 30 min is ignored');
  assert.equal(key({ live, pull: pull({ state: 'deploying' }) }).key, 'building');
  assert.equal(key({ live, pull: pull({ checked_at: iso(NOW - 42 * 60_000) }) }).key, 'stale');
  const err = key({ live, pull: pull({ state: 'error', message: '中身の検査で止めました' }, { run_url: RUN }) });
  assert.equal(err.key, 'error');
  assert.equal(err.detail, '中身の検査で止めました');
  assert.equal(err.link, RUN);
  assert.equal(key({ live, pull: pull({ main_commit: B }, { state: 'failed', commit: B, message: 'build broke' }) }).detail, 'build broke');
  assert.equal(key({}).key, 'unknown');
  assert.equal(key({ live }).key, 'published', 'PC-only setup (no pull.json) is not a warning');
});

test('token warning stacks on top', () => {
  const soon = key({ live, pull: pull({ token_expires_at: iso(NOW + 12 * 86_400_000) }) });
  assert.equal(soon.key, 'published');
  assert.equal(soon.token.expired, false);
  const gone = key({ live, pull: pull({ token_expires_at: iso(NOW - 86_400_000) }) }, { lang: 'en' });
  assert.equal(gone.token.expired, true);
  assert.match(gone.token.label, /expired/);
});

test('hostile values are dropped or neutralised', () => {
  const s = snapshot({
    live: { ...live, commit: '<b>x</b>', release: 'x'.repeat(500) },
    meta: { commit: A, subject: 'a <script>', trigger: 'Evil Trigger', run_url: 'javascript:alert(1)' },
    pull: pull({ state: 'pwned', message: 'm\u0000\u001b[31m' }),
  }, { repo: REPO });
  assert.equal(s.live.commit, '');
  assert.equal(s.live.release.length, 40);
  assert.equal(s.meta.subject, 'a <script>', 'line separators → space; text is only ever set via textContent');
  assert.equal(s.meta.trigger, '');
  assert.equal(s.meta.runUrl, '');
  assert.equal(s.pull.state, '');
  assert.equal(s.pull.message, 'm [31m');
});
