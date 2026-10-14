// lib/commands.mjs — the CLI commands (bin/xpd.mjs parses arguments and calls these).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeBundle, rollbackMeta, VERSION } from './bundle.mjs';
import { assertConfig, EMAIL_RE, RELEASE_RE, REPO_RE } from './config.mjs';
import { gitIn, repoFromUrl } from './git.mjs';
import { checkFresh, kick as kickHttp, verify as verifyHttp, waitForLive } from './http.mjs';
import { lineageGuard } from './lineage.mjs';
import { fail, log, warn } from './log.mjs';
import { ask } from './prompt.mjs';
import { checkCmd, deployCmd, listCmd, rollbackCmd, setupPullCmd } from './remote.mjs';
import { ssh, sshPreview } from './ssh.mjs';
import { tarball } from './tar.mjs';

const mask = (s) => s || '（未設定）';

export const printConfig = (c) => {
  log(`  設定        ${c.file || '（xpd.config.json なし）'}${c.envFile ? ` + ${c.envFile}` : ''}`);
  log(`  接続先      ${mask(c.user)}@${mask(c.host)} :${c.port}  (${c.sshBin}, 鍵 ${c.key})`);
  log(`  公開先      ${mask(c.docroot)}（${c.docrootSuffix} で終わること）`);
  log(`  サーバー側  ${c.remoteBase}（リリース ${c.keep} 件を保存）`);
  log(`  保護        ${c.protectAll.join(' ')}`);
  log(`  サイト      ${mask(c.siteUrl)}`);
};

const runBuild = (c) => {
  if (!c.build) {
    log('  build が未設定なので、ビルドはしません（outDir をそのまま公開）');
    return;
  }
  log(`  $ ${c.build}`);
  const r = spawnSync(c.build, { cwd: c.root, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail(`ビルドが失敗しました（exit ${r.status ?? r.error?.message}）: ${c.build}`);
};

const gitInfo = (c) => {
  const git = gitIn(c.root);
  if (!git.isRepo()) return { commit: 'no-git', subject: '', dirty: false };
  return { commit: git.head() || 'no-git', subject: git.subject(), dirty: git.dirty() };
};

const runUrlFromEnv = (env = process.env) =>
  env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '';

const trigger = (c) => {
  const t = (process.env.XPD_TRIGGER || '').trim();
  if (/^[a-z][a-z0-9_-]{0,31}$/.test(t)) return t === 'workflow_dispatch' ? 'manual' : t;
  return c.source === 'local' ? 'local' : 'manual';
};

/* ───────── deploy (PC) ───────── */
export async function deploy(c, o) {
  log(`\nxserver-pull-deploy ${VERSION} — deploy${o.dryRun ? ' (dry-run)' : ''}`);
  const problems = assertConfig(c, 'ssh', { dry: o.dryRun });
  if (problems.length) warn(`設定が足りません（dry-run なので続けます）:\n  - ${problems.join('\n  - ')}`);

  // 1. lineage guard
  if (c.source === 'local') {
    if (o.overwrite) warn('--overwrite: 系譜ガードを飛ばします（公開中の内容を意図的に置き換えます）');
    else {
      const stops = await lineageGuard(c, { allowDirty: o.allowDirty });
      if (stops.length) {
        const msg = `${stops.join('\n  ')}\n  （内容を確認したうえで意図的に上書きするなら xpd deploy --overwrite）`;
        if (o.dryRun) warn(`[dry-run] 本番ならここで止まります:\n  ${msg}`);
        else fail(msg, 3);
      }
    }
  }

  // 2. build
  const t0 = Date.now();
  if (o.dryRun) log(`\n1/4 [dry-run] ビルドは省略（本番では: ${c.build || '（build 未設定）'}）`);
  else if (o.skipBuild) log('\n1/4 --skip-build: 既存の outDir を使います');
  else {
    log('\n1/4 ビルド');
    runBuild(c);
  }

  // 3. bundle
  const info = gitInfo(c);
  if (info.dirty) warn('未コミットの変更を含めてデプロイします。live.json に dirty: true が残ります。');
  log('\n2/4 アップロード用のまとめファイルを作成');
  let b = null;
  if (existsSync(join(c.outPath, 'index.html')) || !o.dryRun) {
    b = makeBundle(c, { ...info, force: o.force, trigger: trigger(c), runUrl: runUrlFromEnv(), withServer: true });
    log(`  ${b.files} ファイル / ${(b.bytes / 1024 / 1024).toFixed(2)} MB → 圧縮 ${(b.buffer.length / 1024).toFixed(0)} KB · .htaccess ${b.pin.length} 件 · ${b.revision}`);
  } else {
    log(`  [dry-run] ${c.outPath}/index.html がまだありません（ビルド後に作られます）`);
  }

  // 4. upload + publish
  const cmd = deployCmd(c, { force: o.force });
  if (o.dryRun) {
    log('\n3/4 [dry-run] 送信とサーバー側の処理（実行しません）');
    printConfig(c);
    log(`  コマンド: ${sshPreview(c, cmd)}  < bundle`);
    log('  サーバー側: 展開 → ページ数チェック → pull.sh・kick.php・protect.list を設置 → releases/<日時> に保存');
    log('              → rsync -a --no-times -c --delete-delay --delay-updates --chmod=D755,F644（デプロイ以外のファイルは保護）');
    log(`              → ${mask(c.docroot)}/_deploy/live.json・meta.json を更新 → htaccess.pin を記録 → 古いリリースを整理（${c.keep} 件）`);
    log(`\n4/4 [dry-run] 反映確認: ${mask(c.siteUrl)}/ と ${c.outDir}/index.html を比較`);
    log('\n[dry-run] 何も送信していません。');
    return 0;
  }
  log(`\n3/4 送信して公開（${c.user}@${c.host}:${c.port}）`);
  const code = await ssh(c, cmd, b.buffer, o.sshOpts);
  if (code === 255) {
    fail('SSH 接続に失敗、または途中で切れました（exit 255）。送信が終わっていれば、サーバー側は接続が切れても公開を最後まで続けます。xpd list で「*」の付いたリリースを確認し、必要なら xpd deploy をやり直してください。', 255);
  }
  if (code !== 0) fail(`デプロイ失敗（exit ${code}）。公開中のサイトは直前の状態のままです。`, code);

  log('\n4/4 反映確認');
  if (c.siteUrl) {
    const fresh = await checkFresh(c.siteUrl, c.outPath);
    if (fresh.ok) log(`  OK ${fresh.detail}`);
    else warn(fresh.detail);
  } else log('  siteUrl が未設定なので省略');
  const git = gitIn(c.root);
  if (c.source === 'local' && git.isRepo() && git.hasRef(`refs/remotes/origin/${c.branch}`) && git.count(`origin/${c.branch}..HEAD`) > 0) {
    warn('このPCのコミットが GitHub にまだありません。git push してください（push するまで GitHub からの公開は系譜チェックで止まります）。');
  }
  log(`\n完了（${((Date.now() - t0) / 1000).toFixed(1)} 秒）${c.siteUrl ? `: ${c.siteUrl}/` : ''}`);
  return 0;
}

/* ───────── check / list / rollback (PC, ssh) ───────── */
export async function remoteSimple(c, kind, o) {
  log(`\nxserver-pull-deploy ${VERSION} — ${kind}${o.dryRun ? ' (dry-run)' : ''}`);
  const problems = assertConfig(c, 'ssh', { dry: o.dryRun });
  if (problems.length) warn(`設定が足りません:\n  - ${problems.join('\n  - ')}`);
  const cmd = kind === 'check' ? checkCmd(c) : kind === 'list' ? listCmd(c) : rollbackCmd(c, o.release);
  if (kind === 'check') printConfig(c);
  if (o.dryRun) {
    log(`\n[dry-run] 実行するコマンド:\n  ${sshPreview(c, cmd)}`);
    return 0;
  }
  const code = await ssh(c, cmd, undefined, o.sshOpts);
  if (code !== 0) fail(`サーバー側でエラー（exit ${code}）`, code);
  if (kind === 'rollback') log(`\n切り戻し完了。${c.siteUrl || 'サイト'} で表示を確認してください（次に公開すると、最新の内容に戻ります）。`);
  return 0;
}

/* ───────── setup-pull ───────── */
export async function setupPull(c, o) {
  log(`\nxserver-pull-deploy ${VERSION} — setup-pull${o.dryRun ? ' (dry-run)' : ''}`);
  const problems = assertConfig(c, 'ssh', { dry: o.dryRun });
  if (problems.length) warn(`設定が足りません:\n  - ${problems.join('\n  - ')}`);
  printConfig(c);
  const repo = c.githubRepo || repoFromUrl(gitIn(c.root).originUrl());
  if (!REPO_RE.test(repo)) fail('GitHub のリポジトリ名が分かりません。xpd.config.json に "githubRepo": "owner/repo" を書くか、git remote add origin … を先に', 2);
  log(`  リポジトリ  ${repo}`);
  if (c.ghApi && !/^(https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?|http:\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?)(\/[A-Za-z0-9._/-]*)?$/.test(c.ghApi)) {
    fail('XPD_GH_API の形式が違います（https://… のみ。http はローカルのテスト用だけ）', 2);
  }
  log('\nサーバー用の読み取り専用トークンを入力します（GitHub → Settings → Developer settings → Fine-grained tokens:');
  log(`  Repository access = ${repo} のみ、Permissions = Contents: Read-only（Metadata: Read-only は自動）、期限 1 年）`);
  const token = (process.env.XPD_PULL_TOKEN || '').trim() || (o.dryRun ? 'github_pat_DRYRUN000000000000000000' : await ask('トークン: ', { secret: true }));
  if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) fail('トークンの形式が違います（github_pat_… をそのまま貼ってください）', 2);
  let email = c.notifyEmail;
  if (!email && !o.dryRun && process.stdin.isTTY) email = await ask('公開に失敗したときの通知先メール（空 = 通知しない）: ');
  if (email && !EMAIL_RE.test(email)) fail(`メールアドレスの形式が違います: ${email}`, 2);
  const lines = [
    `# ~/.deploy/${c.name}/pull.env — written by xpd setup-pull (${new Date().toISOString()})`,
    `GH_REPO=${repo}`, `GH_TOKEN=${token}`, `DOCROOT=${c.docroot}`, `DOCROOT_SUFFIX=${c.docrootSuffix}`, `KEEP=${c.keep}`,
    `BRANCH=${c.branch}`, `DEPLOY_BRANCH=${c.deployBranch}`, `STATUS_BRANCH=${c.statusBranch}`, `SITE_NAME=${c.name}`,
    `NOTIFY_EMAIL=${email || ''}`,
    ...(c.ghApi ? [`GH_API=${c.ghApi}`] : []),
  ];
  const cmd = setupPullCmd(c);
  if (o.dryRun) {
    log(`\n[dry-run] 送るもの: pull.env（トークンは表示しません）\n  コマンド: ${sshPreview(c, cmd)}`);
    return 0;
  }
  const bundle = tarball([['pull.env', Buffer.from(`${lines.join('\n')}\n`)]]);
  const code = await ssh(c, cmd, bundle, o.sshOpts);
  if (code !== 0) fail(`サーバー側でエラー（exit ${code}）`, code);
  return 0;
}

/* ───────── bundle-only (CI) ───────── */
const OUT_NAMES = new Set(['bundle.tar.gz', 'bundle.sha256', 'META.json', '.git']);

export async function bundleOnly(c, o) {
  log(`\nxserver-pull-deploy ${VERSION} — bundle-only${o.rollback !== undefined ? ' (rollback)' : ''}`);
  assertConfig(c, 'bundle');
  const out = resolve(c.root, o.out || '.xpd-bundle');
  if (existsSync(out)) {
    const extra = readdirSync(out).filter((n) => !OUT_NAMES.has(n));
    if (extra.length) fail(`出力先 ${out} にほかのファイルがあります（${extra.slice(0, 3).join(', ')}）。空のフォルダを指定してください`, 2);
    for (const n of OUT_NAMES) rmSync(join(out, n), { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
  if (o.rollback !== undefined) {
    const release = o.rollback || 'previous';
    if (release !== 'previous' && !RELEASE_RE.test(release)) fail(`rollback は previous か リリース ID（数字と -）です: ${release}`, 64);
    writeFileSync(join(out, 'META.json'), rollbackMeta(c, { release, trigger: trigger(c), runUrl: runUrlFromEnv() }));
    log(`  ${join(out, 'META.json')}: rollback ${release}`);
    return 0;
  }
  if (!o.skipBuild) runBuild(c);
  const info = gitInfo(c);
  const b = makeBundle(c, { ...info, force: o.force, trigger: trigger(c), runUrl: runUrlFromEnv(), withServer: false });
  writeFileSync(join(out, 'bundle.tar.gz'), b.buffer);
  writeFileSync(join(out, 'bundle.sha256'), `${b.sha256}  bundle.tar.gz\n`);
  writeFileSync(join(out, 'META.json'), b.metaJson);
  log(`  ${b.files} ファイル / ${(b.bytes / 1024 / 1024).toFixed(2)} MB → ${out}/bundle.tar.gz（${(b.buffer.length / 1024).toFixed(0)} KB）`);
  log(`  sha256 ${b.sha256.slice(0, 16)}… · commit ${b.meta.commit.slice(0, 12)} · trigger ${b.meta.trigger}`);
  if (b.buffer.length > 95 * 1024 * 1024) warn('bundle が 95 MB を超えています。GitHub の Contents API（raw）は 100 MB までです');
  return 0;
}

/* ───────── lineage / kick / wait / verify ───────── */
export async function lineage(c, o) {
  const stops = await lineageGuard(c, { ci: o.ci, allowDirty: o.allowDirty });
  if (stops.length) fail(stops.join('\n'), 3);
  log('OK: 系譜チェックを通過しました');
  return 0;
}

export async function kick(c) {
  assertConfig(c, 'site');
  const r = await kickHttp(c.siteUrl);
  log(`kick: HTTP ${r.status} ${r.body}（届かなくても、サーバーの cron が 1 分以内に取りに来ます）`);
  return 0;
}

const resolveCommit = (c, v) => {
  if (!v) return '';
  if (v === 'HEAD') return gitIn(c.root).head();
  if (!/^[0-9a-f]{40}$/.test(v)) fail(`--commit は 40 桁の SHA か HEAD です: ${v}`, 64);
  return v;
};

export async function wait(c, o) {
  assertConfig(c, 'site');
  const commit = resolveCommit(c, o.commit);
  const since = o.rollbackSince ? Number(o.rollbackSince) : 0;
  if (!commit && !since) fail('--commit <sha> か --rollback-since <epoch 秒> を指定してください', 64);
  const r = await waitForLive({
    siteUrl: c.siteUrl, commit, rollbackSince: since, deployRef: o.deployRef,
    timeoutSec: Number(o.timeout ?? 360), intervalSec: Number(o.interval ?? 10), onTick: (s) => log(s),
  });
  if (!r.ok) fail(r.detail, 1);
  log(r.detail);
  return 0;
}

export async function verify(c, o) {
  assertConfig(c, 'site');
  const commit = resolveCommit(c, o.commit);
  const results = await verifyHttp({ siteUrl: c.siteUrl, commit, outPath: c.outPath, fresh: o.fresh });
  const w = Math.max(...results.map((r) => r.name.length));
  log(`\nverify: ${c.siteUrl}`);
  for (const r of results) log(`${r.ok ? 'OK' : 'NG'}  ${r.name.padEnd(w)}  ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  if (failed) fail(`verify: ${failed} 件 NG`, 1);
  log('\nverify: すべて OK');
  return 0;
}
