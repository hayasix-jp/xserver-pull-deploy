# トラブルシューティング

まず見る場所:

| どこ | 何がわかるか |
|---|---|
| `https://example.com/_deploy/pull.json` | サーバーの最後の確認時刻（`checked_at`）、状態（`idle` / `deploying` / `error`）、止めた理由（`message`） |
| `https://example.com/_deploy/live.json` | 公開中のリリース・commit・経路（`local` / `pull` / `rollback`） |
| `npx xpd check` | サーバーのツール、公開フォルダ、`pull.sh`・`pull.env`・`htaccess.pin` の有無、`pull.log` の直近 5 行 |
| サーバーの `~/.deploy/<name>/pull.log` | 1 回 1 行の記録（`published` / `up to date` / `error: …` / `rate-limited` / `busy`） |
| サーバーの `~/.deploy/<name>/deploy.log` | 公開・失敗の履歴 |
| GitHub → Actions → 実行ログ | ビルド・受け渡し・待機の結果 |

## GitHub → サーバー（プル型）

| 症状・メッセージ | 原因 | 対処 |
|---|---|---|
| `pull.json` が「公開用のデータがまだありません」のまま | `deploy` ブランチがまだ無い。GitHub はブランチが存在しないとき **HTTP 422**（`No commit found for SHA: deploy`）を返し、`pull.sh` はそれを「まだ無い」と扱います | Actions が 1 回成功しているか確認。`deployBranch` を変えたなら、`xpd setup-pull` をやり直して `pull.env` の `DEPLOY_BRANCH` を合わせる |
| `pull.sh check` で `main: 見つかりません` | ソースのブランチ名が違う（`master` など）。存在しないブランチは 422 になります | `xpd.config.json` の `branch` を直して `xpd setup-pull` |
| 「リポジトリが見つからないか、トークンにこのリポジトリの権限がありません」 | `GH_REPO` の誤り、トークンの Repository access にこのリポジトリが無い、組織の承認待ち（いずれも 404） | トークンを作り直す（[github.md](github.md)）→ `xpd setup-pull` |
| 「サーバー用トークンが無効か期限切れです」（401） | 期限切れ・削除・貼り間違い | トークンを作り直して `xpd setup-pull` |
| 「GitHub に拒否されました」（403） | 権限不足（Contents: Read-only が無い） | 権限を直す |
| `pull.log` に `rate-limited` | GitHub API の回数制限。条件付きリクエスト（304）は通常数えられないので、同じトークンをほかで使っていないか確認 | 次の回で自動的に再開します |
| Actions が「サーバーが取りに来ていません（cron が止まっている？…）」 | Cron 未設定・コマンドの誤り・`pull.env` の誤り | `xpd check` の pull.log、`pull.json` の `checked_at` を確認。Cron の 1 行を `xpd setup-pull` の表示と見比べる |
| 状態表示が黄「サーバーの自動確認が止まっています」 | `pull.json` が 15 分以上更新されていない | 上と同じ |
| 「中身の検査で止めました（.htaccess が変わっています。PC から公開してください）」 | `.htaccess` を変えたコミットをプル型で公開しようとした（追加・削除も含む） | PC で `git pull` → `npx xpd deploy`（`htaccess.pin` が更新され、以後はプル型も通る） |
| 「中身の検査で止めました（PC からの公開がまだ一度もありません…）」 | `htaccess.pin` が無い | PC から `npx xpd deploy` を一度 |
| 「中身の検査で止めました（実行できる種類のファイル（.php など）や設定ファイルが含まれています）」 | ビルド結果に `.php`・`.sh`・`.py` などがある | 出力から外す。配布したいなら `.txt` などにする（[faq.md](faq.md)） |
| 「…リンクや特殊なファイルが含まれています」 | ビルド結果にシンボリックリンクがある | 実体のファイルにする |
| 「まとめファイルが壊れています（sha256 が一致しません）」 | 受け渡しの途中で壊れた、または deploy ブランチを手で触った | もう一度公開（Run workflow） |
| 「…3 回失敗したので、次の公開まで止めています」 | 同じ公開データで 3 回失敗 | 原因を直して、新しく公開する（push または Run workflow） |
| 「ページ数が公開中の半分未満なので止めました」 | ビルドの一部が失敗した、または意図的にページを大きく減らした | ビルドを確認。意図どおりなら Run workflow で `force` に✓ |
| 「別の公開が実行中です」 | PC からのデプロイと重なった | 自動で続きます |
| Actions の Lineage check が「GitHub にまだ無い内容が公開されています」 | PC から公開したコミットを push していない | PC で `git push` → もう一度公開。古い版を意図的に出すなら `overwrite` |
| Actions の Lineage check が「状態（…/_deploy/live.json）を確認できません」 | サイトが落ちている、DNS 切り替え前、`siteUrl` の誤り | サイトと `siteUrl` を確認。初回（404）は通ります |
| Hand over が `protected branch` で失敗 | `deploy` ブランチにブランチ保護がかかっている | `deploy` / `deploy-status` の保護を外す |
| 公開に 5 分以上かかる | Cron が `*/5`、かつ `kick.php` が使えない（PHP の `exec` 無効・WAF） | 想定内。急ぐときは PC から `xpd deploy` |

## PC から（SSH）

| 症状・メッセージ | 原因 | 対処 |
|---|---|---|
| `Connection timed out` / `exit 255`（再試行しても失敗） | SSH が OFF、ホスト名・ポートの誤り、海外経由の回線（VPN など。国外アクセス制限に当たる） | SSH設定が ON か、ポート 10022 か確認。VPN を切る |
| `Permission denied (publickey)` | 公開鍵が未登録・OFF、サーバー ID の誤り、鍵ファイルの取り違え | パネルで鍵を確認。`XPD_USER`・`XPD_SSH_KEY` を確認 |
| `Host key verification failed` / `REMOTE HOST IDENTIFICATION HAS CHANGED` | サーバーの鍵が変わった（サーバー移転、またはなりすまし） | 事業者のお知らせを確認してから `ssh-keygen -R "[sv12345.xserver.jp]:10022"` → `xpd check` |
| `UNPROTECTED PRIVATE KEY FILE`（Windows） | Windows 標準の ssh が鍵ファイルの権限を広すぎると判断 | `.env.deploy` に `XPD_SSH_BIN=C:/Program Files/Git/usr/bin/ssh.exe` |
| `ssh を起動できません` | PATH に ssh が無い | `XPD_SSH_BIN` にフルパス |
| `XPD_DOCROOT が C:/… になっています` | Git Bash が環境変数のパスを書き換えた | `.env.deploy` に書く |
| `設定が足りないか、形式が違います` | `xpd.config.json` / `.env.deploy` の不足・形式違い | 表示された項目を直す |
| `[server] ERROR: 公開ディレクトリが見つかりません`（exit 65） | ドメイン未追加、パスの誤字 | パネルとパスを確認 |
| `[server] ERROR: 公開ディレクトリは /public_html で終わる絶対パスに…`（exit 64） | パスの誤り。別の構成なら | `docrootSuffix` を設定（例 `/htdocs`） |
| `GitHub の main に、このPCにない更新が N 件あります`（exit 3） | GitHub 側（Web 編集・別の PC）の更新が手元に無い | `git pull` → `xpd deploy` |
| `公開中のサイト（…）に、このPCの履歴にない更新が含まれています`（exit 3） | 別の PC やプル型で公開された内容が手元に無い | `git pull`。意図的に上書きするなら `--overwrite` |
| `未コミットの変更があります`（exit 3） | コミットしていない | コミット。または `--allow-dirty` |
| `ページ数が公開中の半分未満です`（exit 71） | ビルドの一部が失敗した | 出力を確認。意図どおりなら `--force` |
| `rsync が失敗しました`（exit 70） | 容量不足・権限 | 公開中のファイルは基本的に変更前のまま。容量を確認して再実行。表示が崩れていたら `xpd rollback` |
| `公開中のリリース … がありません`（exit 68） | `releases/` を手で消した | どのファイルを消してよいか判断できないので止めています。`~/.deploy/<name>/current` を消すと、次は初回と同じ扱い（公開フォルダ内の不要なファイルも削除）になります |
| `別のデプロイが実行中です`（exit 75） | プル型の公開と重なった | 少し待って再実行 |
| `SSH 接続に失敗、または途中で切れました（exit 255）` が送信の後に出た | 送信後に回線が切れた | サーバー側は最後まで続けます。`xpd list` で `*` のリリースを確認し、今回のものでなければ再実行 |
| 反映確認が「まだ古い内容を返しています」 | パネルのキャッシュが ON、CDN | [xserver.md](xserver.md#2-キャッシュ設定を-off-にすぐ反映させたい場合) |
| ログに「保護（デプロイ以外で置かれたファイルなので残します）」 | ファイル管理などで直接置いたファイルがある | 必要ならそのまま。不要ならファイル管理で削除 |
| 無料 SSL の更新に失敗したとメールが来た | `/.well-known/` が転送されている | `xpd verify` の「.well-known は転送しない」を確認。[htaccess-snippet](../../templates/htaccess-snippet) を参照 |
