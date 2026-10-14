#!/usr/bin/env node
// xpd — xserver-pull-deploy CLI. Zero dependencies; Node 20+ and the system ssh.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERSION } from '../lib/bundle.mjs';
import { bundleOnly, deploy, kick, lineage, remoteSimple, setupPull, verify, wait } from '../lib/commands.mjs';
import { loadConfig } from '../lib/config.mjs';
import { init } from '../lib/init.mjs';
import { errorLine, log, XpdError } from '../lib/log.mjs';

export const HELP = `xserver-pull-deploy ${VERSION} — 静的サイトを Xserver に安全に公開する

使い方: xpd <command> [options]

PC から（SSH、国内回線。国外アクセス制限 ON のままで可）
  init                     xpd.config.json・.env.deploy.example・GitHub ワークフローを作る
  deploy                   ビルド → まとめて送信 → サーバーで一括入れ替え（pull.sh・kick.php も設置）
    --dry-run              何をするかを表示するだけ（SSH の接続も送信もしない）
    --skip-build           今の outDir をそのまま公開
    --force                ページ数が公開中の半分未満でも公開
    --allow-dirty          未コミットの変更を含めて公開（live.json に dirty: true）
    --overwrite            系譜ガードを飛ばす（公開中の内容を意図的に置き換える）
  check                    サーバーに接続して状態を表示（何も変更しない）
  list                     保存しているリリースの一覧（* = 公開中）
  rollback [ID]            1 つ前（または ID）のリリースに戻す
  setup-pull               サーバーに読み取り専用トークン（pull.env）を書き、確認し、Cron の 1 行を表示

GitHub Actions から（SSH なし）
  bundle-only              ビルドして .xpd-bundle/（bundle.tar.gz・bundle.sha256・META.json）を作る
    --out DIR  --skip-build  --force  --rollback [ID|previous]
  lineage --ci             公開中の commit がこれから公開するものの祖先か確認
  kick                     POST /_deploy/kick.php（サーバーにすぐ取りに来てもらう）
  wait --commit SHA|HEAD [--deploy-ref SHA] [--timeout 360] | --rollback-since EPOCH
  verify [--commit SHA|HEAD] [--fresh]    公開サイトの確認

共通: --config FILE  --cwd DIR  --help  --version
ドキュメント: docs/ja/README.md
`;

/** Minimal argv parser: positionals + --flag / --key value / --key=value */
export const parseArgs = (argv) => {
  const flags = {};
  const pos = [];
  const VALUED = new Set(['config', 'cwd', 'out', 'commit', 'deploy-ref', 'rollback-since', 'timeout', 'interval', 'name', 'build',
    'out-dir', 'site', 'branch']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = a.slice(2, eq > 0 ? eq : undefined);
    if (eq > 0) flags[key] = a.slice(eq + 1);
    else if (key === 'rollback') {
      // optional value: --rollback [ID|previous]
      flags[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
    } else if (VALUED.has(key)) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new XpdError(`--${key} には値が必要です`, 64);
      flags[key] = argv[++i];
    } else flags[key] = true;
  }
  return { cmd: pos[0] || '', args: pos.slice(1), flags };
};

export async function main(argv = process.argv.slice(2)) {
  const { cmd, args, flags } = parseArgs(argv);
  if (flags.version || cmd === 'version') {
    log(VERSION);
    return 0;
  }
  if (flags.help || !cmd || cmd === 'help') {
    log(HELP);
    return cmd || flags.help ? 0 : 64;
  }
  const cwd = resolve(typeof flags.cwd === 'string' ? flags.cwd : process.cwd());
  if (cmd === 'init') {
    const written = init(cwd, {
      force: Boolean(flags.force), name: flags.name, build: flags.build, outDir: flags['out-dir'], siteUrl: flags.site, branch: flags.branch,
    });
    for (const f of written) log(`  作成: ${f}`);
    log('\n次: xpd.config.json の siteUrl / build / outDir を確認 → .env.deploy.example を .env.deploy にコピーして記入 → xpd deploy --dry-run');
    return 0;
  }
  const c = await loadConfig({ cwd, configPath: typeof flags.config === 'string' ? flags.config : undefined });
  const o = {
    dryRun: Boolean(flags['dry-run']),
    skipBuild: Boolean(flags['skip-build']),
    force: Boolean(flags.force),
    allowDirty: Boolean(flags['allow-dirty']),
    overwrite: Boolean(flags.overwrite),
    ci: Boolean(flags.ci),
    fresh: Boolean(flags.fresh),
    out: typeof flags.out === 'string' ? flags.out : undefined,
    rollback: typeof flags.rollback === 'string' ? flags.rollback : undefined,
    commit: typeof flags.commit === 'string' ? flags.commit : undefined,
    deployRef: typeof flags['deploy-ref'] === 'string' ? flags['deploy-ref'] : undefined,
    rollbackSince: flags['rollback-since'],
    timeout: flags.timeout,
    interval: flags.interval,
    release: args[0],
    sshOpts: process.env.XPD_TEST_RETRY_DELAY_MS ? { retryDelayMs: Number(process.env.XPD_TEST_RETRY_DELAY_MS) } : undefined,
  };
  switch (cmd) {
    case 'deploy': return deploy(c, o);
    case 'check': case 'list': case 'rollback': return remoteSimple(c, cmd, o);
    case 'setup-pull': return setupPull(c, o);
    case 'bundle-only': return bundleOnly(c, o);
    case 'lineage': return lineage(c, o);
    case 'kick': return kick(c);
    case 'wait': return wait(c, o);
    case 'verify': return verify(c, o);
    default:
      throw new XpdError(`不明なコマンドです: ${cmd}（xpd help）`, 64);
  }
}

const isMain = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  }
})();

if (isMain) {
  main().then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (e) => {
      if (e instanceof XpdError) {
        errorLine(e.message);
        process.exitCode = e.code;
        return;
      }
      errorLine(e?.stack || String(e));
      process.exitCode = 1;
    },
  );
}
