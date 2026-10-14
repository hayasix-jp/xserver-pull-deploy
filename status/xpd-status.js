// status/xpd-status.js — a tiny, dependency-free publish-status widget for sites deployed with xserver-pull-deploy.
// ES module; ~5 KB. Copy it into your site (e.g. public/xpd-status.js) and:
//
//   <div id="xpd-status"></div>
//   <script type="module">
//     import { mount } from '/xpd-status.js';
//     mount(document.getElementById('xpd-status'), { repo: 'your-org/your-site', lang: 'ja' });
//   </script>
//
// It reads the three same-origin files every 10 s (cache: 'no-store'; paused while the tab is hidden):
//   /_deploy/live.json  /_deploy/meta.json  (remote-deploy.sh)      /_deploy/pull.json (pull.sh)
// and shows ONE state, decided top to bottom:
//   error → stale → building → unpublished → published   (+ a token-expiry warning; unknown = no data)
//
// Security: every value in those files is untrusted (a commit subject is whatever someone typed). Values are
// validated field by field, length-capped and only ever written with textContent / setAttribute. A link is made only
// from a run_url of https://github.com/<repo>/actions/runs/<digits> (and only when `repo` is given).
// The pure parts (parse*, judge) are exported for tests and for your own UI.

const POLL_MS = 10_000;
const TIMEOUT_MS = 8_000;
const MAX_BYTES = 64 * 1024;
export const STALE_MS = 15 * 60_000; // pull.checked_at older than 15 min: the cron has stopped
export const TOKEN_WARN_MS = 30 * 86_400_000; // token expires within 30 days
export const BUILDING_MAX_MS = 30 * 60_000; // a "building" older than this is a run that died without writing its end

// control characters, C1 controls and the two Unicode line/paragraph separators (U+2028, U+2029)
const CTRL = new RegExp(`[\x00-\x1f\x7f-\x9f${String.fromCharCode(0x2028, 0x2029)}]+`, 'g');
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v, max = 300) => (typeof v === 'string' ? v.replace(CTRL, ' ').trim().slice(0, max) : '');
const sha = (v) => (typeof v === 'string' && /^[0-9a-f]{40}$/.test(v) ? v : '');
const oneOf = (v, list) => (typeof v === 'string' && list.includes(v) ? v : '');
const valid = (t) => Number.isFinite(t);

/** ISO 8601 or GitHub's header form ("2027-11-01 09:00:00 +0900", "… UTC") → ms (NaN when invalid). */
export const parseTime = (v) => {
  if (typeof v !== 'string' || v.length > 40) return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i.exec(v.trim());
  if (!m) return NaN;
  const zone = m[7] ?? 'Z';
  const tz = /^(?:Z|UTC|GMT)$/i.test(zone) ? 'Z' : zone.replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${tz}`);
};

/** A GitHub Actions run URL of `repo`, or ''. */
export const runUrl = (v, repo) => {
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || typeof v !== 'string' || v.length > 300) return '';
  const prefix = `https://github.com/${repo}/actions/runs/`;
  if (!v.startsWith(prefix) || !/^\d{1,20}(?:\/(?:job|jobs|attempts)\/\d{1,20})?\/?$/.test(v.slice(prefix.length))) return '';
  try {
    const u = new URL(v);
    return u.origin === 'https://github.com' && !u.username && !u.password && !u.search && !u.hash ? u.href : '';
  } catch {
    return '';
  }
};

export const parseLive = (v) => {
  if (!isObj(v)) return null;
  const live = {
    release: str(v.release, 40),
    publishedAt: parseTime(v.published_at),
    commit: sha(v.commit),
    dirty: v.dirty === true,
    source: oneOf(v.source, ['local', 'pull', 'rollback']),
  };
  return live.commit || live.release || valid(live.publishedAt) ? live : null;
};

export const parseMeta = (v, repo) => {
  if (!isObj(v)) return null;
  return {
    commit: sha(v.commit),
    subject: str(v.subject, 200),
    trigger: typeof v.trigger === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(v.trigger) ? v.trigger : '',
    runUrl: runUrl(v.run_url, repo),
    builtAt: parseTime(v.built_at),
    force: v.force === true,
  };
};

const parseBuild = (v, repo) => {
  if (!isObj(v)) return null;
  return {
    state: oneOf(v.state, ['building', 'success', 'failed']),
    commit: sha(v.commit),
    runUrl: runUrl(v.run_url, repo),
    message: str(v.message, 300),
    at: parseTime(v.at),
  };
};

export const parsePull = (v, repo) => {
  if (!isObj(v)) return null;
  return {
    checkedAt: parseTime(v.checked_at),
    state: oneOf(v.state, ['idle', 'deploying', 'error']),
    message: str(v.message, 300),
    deployCommit: sha(v.deploy_commit),
    mainCommit: sha(v.main_commit),
    build: parseBuild(v.build, repo),
    tokenExpiresAt: parseTime(v.token_expires_at),
  };
};

/** raw {live, meta, pull} (parsed JSON or undefined) → snapshot */
export const snapshot = (raw, { repo = '', offline = false } = {}) => ({
  live: parseLive(raw.live),
  meta: parseMeta(raw.meta, repo),
  pull: parsePull(raw.pull, repo),
  offline,
  fetchedAt: Date.now(),
});

const TEXT = {
  ja: {
    unknown: '公開状態を確認できません', unknownShort: '公開状態：不明',
    offline: '通信できませんでした。ネットワークの状態を確認してください。',
    noLive: '公開の記録（/_deploy/live.json）がまだありません。一度公開すると表示されます。',
    error: '公開できませんでした', errorServer: 'サーバーでの公開処理が止まりました。', errorBuild: 'ビルドが失敗しました。',
    stale: 'サーバーの自動確認が止まっています', staleShort: '自動確認が停止中',
    staleNoPull: '自動確認の記録（/_deploy/pull.json）がありません。サーバーの初期設定（xpd setup-pull と Cron）を確認してください。',
    staleAgo: (ago) => `最後の確認は${ago || '不明'}です。サーバーの Cron が止まっている可能性があります。`,
    building: '公開処理中…', buildingServer: 'サーバーが新しい内容に入れ替えています。', buildingGh: 'GitHub でサイトを組み立てています。',
    unpublished: '未公開の変更があります', unpublishedDetail: 'リポジトリの最新の内容が、まだサイトに出ていません。',
    published: '公開済み', publishedAt: (d) => `${d} に公開されました。`,
    tokenSoon: (d) => `サーバー用トークンの期限が近い（${d}）`, tokenExpired: (d) => `サーバー用トークンの期限が切れています（${d}）`,
    now: 'たった今', s: (n) => `${n}秒前`, m: (n) => `${n}分前`, h: (n) => `${n}時間前`, d: (n) => `${n}日前`, sep: ' ', details: '詳細（GitHub）',
  },
  en: {
    unknown: 'Publish status unknown', unknownShort: 'Status: unknown',
    offline: 'Could not reach the site. Check the network.',
    noLive: 'No publish record (/_deploy/live.json) yet. It appears after the first deploy.',
    error: 'Publishing failed', errorServer: 'The server stopped the publish.', errorBuild: 'The build failed.',
    stale: 'The server has stopped checking', staleShort: 'Server check stopped',
    staleNoPull: 'No /_deploy/pull.json. Check the server setup (xpd setup-pull and the cron line).',
    staleAgo: (ago) => `Last check: ${ago || 'unknown'}. The server's cron may have stopped.`,
    building: 'Publishing…', buildingServer: 'The server is swapping in the new version.', buildingGh: 'GitHub is building the site.',
    unpublished: 'Unpublished changes', unpublishedDetail: 'The latest commit is not on the site yet.',
    published: 'Published', publishedAt: (d) => `Published ${d}.`,
    tokenSoon: (d) => `Server token expires soon (${d})`, tokenExpired: (d) => `Server token expired (${d})`,
    now: 'just now', s: (n) => `${n}s ago`, m: (n) => `${n} min ago`, h: (n) => `${n} h ago`, d: (n) => `${n} days ago`, sep: ' ', details: 'Details (GitHub)',
  },
};

export const agoText = (t, now, lang = 'ja', coarse = false) => {
  if (!valid(t)) return '';
  const T = TEXT[lang] || TEXT.ja;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return coarse || s < 5 ? T.now : T.s(s);
  const m = Math.floor(s / 60);
  if (m < 60) return T.m(m);
  const h = Math.floor(m / 60);
  return h < 24 ? T.h(h) : T.d(Math.floor(h / 24));
};

const fmt = (t, lang, timeZone, opts) => new Intl.DateTimeFormat(lang === 'en' ? 'en' : 'ja-JP', { timeZone, ...opts }).format(t);

/**
 * The one state to show. key: error | stale | building | unpublished | published | unknown.
 * @returns {{key: string, label: string, short: string, detail: string, link: string, token: null|{label: string, expired: boolean}}}
 */
export const judge = (s, now, { lang = 'ja', timeZone = 'Asia/Tokyo' } = {}) => {
  const T = TEXT[lang] || TEXT.ja;
  const { live, pull } = s;
  const build = pull?.build ?? null;
  const v = { key: 'unknown', label: '', short: '', detail: '', link: '', token: null };

  if (pull && valid(pull.tokenExpiresAt) && pull.tokenExpiresAt - now <= TOKEN_WARN_MS) {
    const expired = pull.tokenExpiresAt <= now;
    const day = fmt(pull.tokenExpiresAt, lang, timeZone, { month: 'long', day: 'numeric' });
    v.token = { expired, label: expired ? T.tokenExpired(day) : T.tokenSoon(day) };
  }
  const buildFailed = !!build && build.state === 'failed' && !!build.commit && build.commit === pull?.mainCommit;
  const building = !!build && build.state === 'building' && !(valid(build.at) && now - build.at > BUILDING_MAX_MS);

  if (!live && !pull) {
    v.key = 'unknown';
    v.label = T.unknown;
    v.short = T.unknownShort;
    v.detail = s.offline ? T.offline : T.noLive;
  } else if (pull && (pull.state === 'error' || buildFailed)) {
    v.key = 'error';
    v.label = T.error;
    v.short = T.error;
    v.detail = (pull.state === 'error' ? pull.message : build?.message) || (pull.state === 'error' ? T.errorServer : T.errorBuild);
    v.link = build?.runUrl || '';
  } else if (!pull || !valid(pull.checkedAt) || now - pull.checkedAt > STALE_MS) {
    // no pull.json at all: a PC-only setup is fine — show what is live instead of a warning
    if (!pull && live) return published(v, live, now, T, lang, timeZone);
    v.key = 'stale';
    v.label = T.stale;
    v.short = T.staleShort;
    v.detail = !pull ? T.staleNoPull : T.staleAgo(agoText(pull.checkedAt, now, lang));
  } else if (building || pull.state === 'deploying') {
    v.key = 'building';
    v.label = T.building;
    v.short = T.building;
    v.detail = pull.state === 'deploying' ? T.buildingServer : T.buildingGh;
    v.link = building ? build?.runUrl || '' : '';
  } else if (pull.mainCommit && (!live || live.commit !== pull.mainCommit)) {
    v.key = 'unpublished';
    v.label = T.unpublished;
    v.short = T.unpublished;
    v.detail = T.unpublishedDetail;
  } else {
    return published(v, live, now, T, lang, timeZone);
  }
  return v;
};

function published(v, live, now, T, lang, timeZone) {
  v.key = 'published';
  const at = live?.publishedAt ?? NaN;
  v.label = valid(at) ? `${T.published}${T.sep}${agoText(at, now, lang, true)}` : T.published;
  v.short = v.label;
  v.detail = valid(at) ? T.publishedAt(fmt(at, lang, timeZone, { dateStyle: 'long', timeStyle: 'short' })) : '';
  return v;
}

/* ───────── browser part ───────── */

const getJson = async (url, signal) => {
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json' }, signal });
    if (!res.ok) return res.status >= 500 ? { kind: 'failed' } : { kind: 'absent' };
    const text = await res.text();
    if (text.length > MAX_BYTES) return { kind: 'absent' };
    return { kind: 'ok', data: JSON.parse(text) };
  } catch (err) {
    return err instanceof SyntaxError ? { kind: 'absent' } : { kind: 'failed' };
  }
};

const COLORS = { error: '#d93f2b', stale: '#c99a1e', building: '#3b82c4', unpublished: '#7a828c', published: '#2f9e5e', unknown: '#7a828c' };

/**
 * Renders into `el` (plain DOM, no styles beyond a coloured dot; style it with [data-xpd-state]).
 * @param {HTMLElement} el
 * @param {{base?: string, repo?: string, lang?: 'ja'|'en', timeZone?: string, interval?: number}} [opts]
 * @returns {() => void} stop
 */
export const mount = (el, opts = {}) => {
  const base = (opts.base ?? '/_deploy/').replace(/\/?$/, '/');
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  const repo = opts.repo ?? '';
  const doc = el.ownerDocument;
  el.textContent = '';
  const dot = doc.createElement('span');
  dot.setAttribute('aria-hidden', 'true');
  dot.style.cssText = 'display:inline-block;width:.6em;height:.6em;border-radius:50%;margin-inline-end:.4em;vertical-align:middle';
  const label = doc.createElement('span');
  const link = doc.createElement('a');
  link.rel = 'noopener noreferrer';
  link.target = '_blank';
  link.style.marginInlineStart = '.6em';
  link.hidden = true;
  link.textContent = (TEXT[lang] || TEXT.ja).details;
  const token = doc.createElement('div');
  token.hidden = true;
  el.append(token, dot, label, link);
  el.setAttribute('role', 'status');

  let last = null;
  let timer = 0;
  let stopped = false;
  const render = () => {
    if (!last) return;
    const v = judge(last, Date.now(), { lang, timeZone: opts.timeZone });
    el.dataset.xpdState = v.key;
    dot.style.background = COLORS[v.key];
    if (label.textContent !== v.label) label.textContent = v.label;
    el.title = v.detail;
    if (v.key === 'error' && v.link) {
      link.setAttribute('href', v.link);
      link.hidden = false;
    } else {
      link.hidden = true;
      link.removeAttribute('href');
    }
    token.hidden = !v.token;
    token.textContent = v.token?.label ?? '';
  };
  const tick = async () => {
    clearTimeout(timer);
    if (stopped) return;
    if (!doc.hidden) {
      const ac = new AbortController();
      const kill = setTimeout(() => ac.abort(), TIMEOUT_MS);
      const [l, m, p] = await Promise.all(['live.json', 'meta.json', 'pull.json'].map((f) => getJson(base + f, ac.signal)));
      clearTimeout(kill);
      const s = snapshot({ live: l.data, meta: m.data, pull: p.data }, { repo });
      if (last) {
        if (l.kind === 'failed') s.live = last.live;
        if (m.kind === 'failed') s.meta = last.meta;
        if (p.kind === 'failed') s.pull = last.pull;
      }
      s.offline = l.kind === 'failed' && m.kind === 'failed' && p.kind === 'failed';
      last = s;
      render();
    }
    timer = setTimeout(tick, opts.interval ?? POLL_MS);
  };
  const onVis = () => {
    if (!doc.hidden) void tick();
  };
  doc.addEventListener('visibilitychange', onVis);
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    doc.removeEventListener('visibilitychange', onVis);
  };
};
