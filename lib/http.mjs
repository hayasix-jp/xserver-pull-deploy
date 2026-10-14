// lib/http.mjs — everything that talks to the live site over HTTP(S): live.json, kick, wait, verify, freshness.
// Node 20+ fetch; no dependencies.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'xserver-pull-deploy';
const TIMEOUT = 15000;

export const errText = (e) => e?.cause?.code || e?.cause?.message || e?.name || String(e);

export const get = (url, opts = {}) =>
  fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(opts.timeout ?? TIMEOUT),
    method: opts.method ?? 'GET',
    headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache', ...(opts.headers || {}) },
  });

/** Fetches a /_deploy/*.json file. → {status, json|null, error?} (never throws) */
export const getStatusFile = async (siteUrl, name) => {
  try {
    const res = await get(`${siteUrl}/_deploy/${name}?t=${Date.now()}`);
    if (res.status !== 200) return { status: res.status, json: null };
    const text = await res.text();
    if (text.length > 65536) return { status: res.status, json: null };
    try {
      return { status: 200, json: JSON.parse(text), headers: res.headers };
    } catch {
      return { status: 200, json: null };
    }
  } catch (e) {
    return { status: 0, json: null, error: errText(e) };
  }
};

/** POST /_deploy/kick.php — best effort; the server's cron picks the bundle up anyway. */
export const kick = async (siteUrl) => {
  try {
    const res = await get(`${siteUrl}/_deploy/kick.php`, { method: 'POST', timeout: 90000 });
    const body = (await res.text()).trim().slice(0, 200);
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: errText(e) };
  }
};

/** Is the live top page byte-identical to outDir/index.html? */
export const checkFresh = async (siteUrl, outPath) => {
  const file = join(outPath, 'index.html');
  if (!existsSync(file)) return { ok: false, detail: `${file} がありません` };
  try {
    const res = await get(`${siteUrl}/`);
    if (res.status !== 200) return { ok: false, detail: `${siteUrl}/ が HTTP ${res.status}` };
    const live = Buffer.from(await res.arrayBuffer());
    return live.equals(readFileSync(file))
      ? { ok: true, detail: `${siteUrl}/ はビルドしたものと同一（最新）` }
      : { ok: false, detail: `${siteUrl}/ はまだ古い内容を返しています（サーバーパネルのキャッシュ設定を確認）` };
  } catch (e) {
    return { ok: false, detail: `${siteUrl}/ に接続できません（${errText(e)}）— DNS 切り替え前なら正常です` };
  }
};

const field = (o, k) => (o && typeof o[k] === 'string' ? o[k] : '');

/**
 * Waits until the server published what we handed over.
 * @param {{siteUrl: string, commit?: string, rollbackSince?: number, deployRef?: string, timeoutSec?: number,
 *          intervalSec?: number, onTick?: (s: string) => void}} o
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export const waitForLive = async (o) => {
  const interval = (o.intervalSec ?? 10) * 1000;
  const deadline = Date.now() + (o.timeoutSec ?? 360) * 1000;
  for (let i = 1; ; i++) {
    await new Promise((r) => setTimeout(r, interval));
    const [live, pull] = await Promise.all([getStatusFile(o.siteUrl, 'live.json'), getStatusFile(o.siteUrl, 'pull.json')]);
    const l = live.json;
    const p = pull.json;
    if (o.rollbackSince) {
      const at = Date.parse(field(l, 'published_at'));
      if (field(l, 'source') === 'rollback' && at >= o.rollbackSince * 1000) return { ok: true, detail: `切り戻し完了: ${JSON.stringify(l)}` };
    } else if (o.commit && field(l, 'commit') === o.commit) {
      return { ok: true, detail: `公開完了: ${JSON.stringify(l)}` };
    }
    if (o.deployRef && field(p, 'deploy_ref') === o.deployRef && field(p, 'state') === 'error') {
      return { ok: false, detail: `サーバーが公開を止めました: ${field(p, 'message')}` };
    }
    o.onTick?.(`待機中 ${Math.round((i * interval) / 1000)} 秒 · live ${field(l, 'commit').slice(0, 12) || '-'} · server ${field(p, 'state') || '-'}`);
    if (Date.now() >= deadline) {
      return { ok: false, detail: 'サーバーが取りに来ていません（cron が止まっている？ サーバーの pull.log を確認）。急ぐときは PC から xpd deploy' };
    }
  }
};

/**
 * Generic post-deploy checks. @returns {Promise<{name: string, ok: boolean, detail: string}[]>}
 * @param {{siteUrl: string, commit?: string, outPath?: string, fresh?: boolean}} o
 */
export const verify = async (o) => {
  const site = o.siteUrl;
  const results = [];
  const check = async (name, url, expect, opts) => {
    try {
      const res = await get(url, opts);
      const detail = await expect(res);
      results.push({ name, ok: detail === true, detail: detail === true ? `${res.status}` : detail });
    } catch (e) {
      results.push({ name, ok: false, detail: `接続失敗 (${errText(e)})` });
    }
  };
  const status = (code) => async (res) => (res.status === code ? true : `HTTP ${res.status}（期待 ${code}）`);

  if (o.fresh && o.outPath) results.push({ name: 'トップページが最新', ...(await checkFresh(site, o.outPath)) });
  await check('トップページ 200', `${site}/`, status(200));
  await check('/_deploy/live.json', `${site}/_deploy/live.json?t=${Date.now()}`, async (res) => {
    if (res.status !== 200) return `HTTP ${res.status}（期待 200。PC から一度 xpd deploy すると作られます）`;
    const cc = res.headers.get('cache-control') || '';
    if (!/no-store/.test(cc)) return `Cache-Control: "${cc}"（期待 no-store。_deploy/.htaccess を確認）`;
    let live;
    try {
      live = JSON.parse(await res.text());
    } catch {
      return 'JSON ではありません';
    }
    if (typeof live.release !== 'string') return 'JSON の形が違います';
    if (o.commit && live.commit !== o.commit) return `commit が ${String(live.commit).slice(0, 12)}（期待 ${o.commit.slice(0, 12)}）`;
    return true;
  });
  await check('/_deploy/ の一覧は 403', `${site}/_deploy/`, status(403));
  await check('/_deploy/ のその他は 403', `${site}/_deploy/xpd-smoke.txt`, status(403));
  await check('kick.php は POST のみ（GET は 405）', `${site}/_deploy/kick.php`, status(405));
  await check('.well-known は転送しない', `${site}/.well-known/acme-challenge/xpd-smoke`, async (res) =>
    res.status >= 300 && res.status < 400 ? `HTTP ${res.status}（転送されている: 無料SSLの更新が失敗します）` : true);
  return results;
};
