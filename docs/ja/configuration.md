# 設定ファイル

設定は 3 か所にあり、**下ほど優先**されます。

| 場所 | Git | 中身 |
|---|---|---|
| `xpd.config.json`（または `xpd.config.mjs`） | 入れる | サイトのこと（ビルド、出力先、URL、保存数、保護するパス） |
| `.env.deploy` | **入れない** | この PC の接続先（ホスト、サーバー ID、公開フォルダ、鍵） |
| 環境変数 | — | 一時的な上書き（`XPD_KEEP=10 npx xpd deploy` など） |

## xpd.config.json

| キー | 既定 | 意味 |
|---|---|---|
| `name` | （必須） | サーバー側のフォルダ名 `~/.deploy/<name>`。英小文字・数字・`.` `_` `-`。1 つのサーバーに複数サイトを置くなら別の名前に |
| `build` | `""` | ビルドのコマンド（シェルで実行）。空ならビルドせず `outDir` をそのまま公開 |
| `outDir` | `dist` | ビルド結果のフォルダ。`index.html` が必須 |
| `siteUrl` | `""` | `https://example.com`。系譜ガード・反映確認・kick・wait・verify が使う |
| `branch` | `main` | ソースのブランチ |
| `deployBranch` | `deploy` | 公開用データのブランチ |
| `statusBranch` | `deploy-status` | ビルド状態のブランチ |
| `keep` | `5` | サーバーに保存するリリース数（2〜100） |
| `docrootSuffix` | `/public_html` | 公開フォルダはこれで終わる絶対パスでなければ拒否（打ち間違いで別の場所を消さないため） |
| `protect` | `[]` | デプロイが触らないパス（rsync の書き方）。`/.well-known/` と `/_deploy/` は常に含まれます |
| `githubRepo` | git の origin | `owner/repo`（`setup-pull` が使う） |
| `notifyEmail` | `""` | サーバーで公開を止めたときの通知先（`setup-pull` が `pull.env` に書く） |

`protect` の書き方:

| 例 | 意味 |
|---|---|
| `/uploads/` | トップの `uploads` フォルダとその中すべて |
| `/google*.html` | トップの `google….html`（`*` と `?` は `/` をまたがない） |
| `*.bak` | 先頭に `/` が無い = どの階層でも、名前が一致するもの |

保護したパスは bundle にも入れません（警告が出ます）。なお `protect` に書かなくても、「デプロイ以外で置かれた
ファイル」は消しません。`protect` は「以前デプロイで置いたが、今はサーバー側で管理しているもの」に使います。

`xpd.config.mjs` なら計算もできます。

```js
export default {
  name: 'example-site',
  build: 'npm run build',
  outDir: 'dist',
  siteUrl: process.env.SITE_URL ?? 'https://example.com',
};
```

## .env.deploy

| 名前 | 例 | 意味 |
|---|---|---|
| `XPD_HOST` | `sv12345.xserver.jp` | SSH のホスト名（`xs123456.xsrv.jp` でも可） |
| `XPD_USER` | `xs123456` | サーバー ID |
| `XPD_PORT` | `10022` | エックスサーバーは 10022 |
| `XPD_DOCROOT` | `/home/xs123456/example.com/public_html` | 公開フォルダ |
| `XPD_SSH_KEY` | `~/.ssh/xpd_deploy` | 秘密鍵 |
| `XPD_KNOWN_HOSTS` | | 別の known_hosts を使うとき |
| `XPD_STRICT_HOST_KEY` | `accept-new` | `yes` にすると、未記録のホスト鍵では接続しない |
| `XPD_SSH_BIN` | `ssh` | ssh のパス（Windows で `C:/Program Files/Git/usr/bin/ssh.exe` など） |
| `XPD_RETRIES` | `3` | 接続失敗（exit 255）の再試行回数 |
| `XPD_GITHUB_REPO` | `your-org/your-site` | `githubRepo` の上書き |
| `XPD_NOTIFY_EMAIL` | `you@example.com` | `notifyEmail` の上書き |
| `XPD_GH_API` | | GitHub Enterprise Server の API（`https://<host>/api/v3`）。`setup-pull` が `pull.env` の `GH_API` に書く |
| `XPD_PULL_TOKEN` | | （環境変数のみ）`setup-pull` でトークンを聞かずにこの値を使う。ファイルには書かないでください |
| `XPD_SITE_URL` / `XPD_KEEP` / `XPD_BUILD` / `XPD_OUT_DIR` | | xpd.config.json の上書き |

> Git Bash で `XPD_DOCROOT=/home/... npx xpd deploy` のように**環境変数で**渡すと、Git Bash がパスを `C:/Program Files/Git/home/...`
> に書き換えてしまいます。`.env.deploy` に書いてください（`xpd` は `C:/…` を検出して止めます）。

## サイトジェネレーター別の例

| ジェネレーター | `build` | `outDir` | `.htaccess` を置く場所 |
|---|---|---|---|
| Astro | `npm run build` | `dist` | `public/.htaccess` |
| Vite | `npm run build` | `dist` | `public/.htaccess` |
| Next.js（`output: 'export'`） | `npm run build` | `out` | `public/.htaccess` |
| 11ty | `npx @11ty/eleventy` | `_site` | `passthroughCopy` で出力にコピー |
| Hugo | `hugo --minify` | `public` | `static/.htaccess` |
| 手書きの HTML | `""` | `public`（など） | そのフォルダに直接 |

例: [`examples/plain-html/`](../../examples/plain-html/)・[`examples/astro/`](../../examples/astro/)。

## サーバー側の pull.env（setup-pull が書く）

| 名前 | 意味 |
|---|---|
| `GH_REPO` / `GH_TOKEN` | リポジトリと読み取り専用トークン |
| `DOCROOT` / `DOCROOT_SUFFIX` | 公開フォルダ（PC の設定と同じ） |
| `KEEP` | 保存するリリース数 |
| `BRANCH` / `DEPLOY_BRANCH` / `STATUS_BRANCH` | ブランチ名 |
| `SITE_NAME` | 通知メールの件名に入る名前 |
| `NOTIFY_EMAIL` | 通知先（空 = 通知しない） |
| `MAX_FILES` / `MAX_MB` | bundle の上限（既定 20000 ファイル・展開後 300 MB） |
| `GH_API` | 既定 `https://api.github.com`（GitHub Enterprise Server なら `https://<host>/api/v3`） |
