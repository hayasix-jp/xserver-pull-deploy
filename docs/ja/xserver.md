# エックスサーバーのパネルで行う設定

上から順に進めてください。各手順の最後に「確認」を書いています。画面の名前は 2026 年時点のサーバーパネルのものです
（変わっていたら近い名前の項目を探してください）。

> この文書の値は例です。`xs123456` はサーバー ID、`sv12345.xserver.jp` はホスト名、`example.com` はドメインに
> 読み替えてください。

## 1. ドメインの追加と無料 SSL

1. サーバーパネル → **ドメイン設定** → **ドメインの追加設定** で `example.com` を追加（「無料独自SSLを利用する」に✓）。
2. 公開フォルダは `/home/xs123456/example.com/public_html` になります。これが `XPD_DOCROOT` です。
3. ドメイン設定の「www転送設定」「HTTPS転送設定」は、転送を `.htaccess` で行うなら **OFF のまま**にします（二重に
   設定すると干渉します）。

> 確認: ファイル管理で `example.com/public_html` がある。

## 2. キャッシュ設定を OFF に（すぐ反映させたい場合）

| 設定 | 推奨 | 理由 |
|---|---|---|
| Xアクセラレータ | OFF | 静的ファイルを数分キャッシュし、`.htaccess` に独自の行を書き込みます。その行は次のデプロイで消えるので、パネルの表示と実際の動作が食い違います |
| サーバーキャッシュ設定 | OFF | HTML を 1 分程度キャッシュします |
| ブラウザキャッシュ設定 | OFF（`.htaccess` で指定するなら） | `.htaccess` の `Cache-Control` の方が優先されます |

ON のままでも動きますが、`xpd deploy` 最後の「反映確認」が「まだ古い内容を返しています」と警告することがあります。

## 3. SSH を ON にする（国外アクセス制限は ON のまま）

1. サーバーパネル → **SSH設定** → **ON にする**。
2. **国外アクセス制限は ON のまま**にします。PC からの SSH は国内なので通ります。GitHub からの SSH は使いません。
3. 同じ画面、またはサーバー情報で、ホスト名（`sv12345.xserver.jp`）・ユーザー名（サーバー ID `xs123456`）・
   ポート（`10022`）を確認します。

> 海外経由の回線（VPN・一部のモバイル回線・クラウドの開発環境）からは PC デプロイもつながりません。
> その場合はプル型（GitHub → サーバー）だけで運用できます（[faq.md](faq.md)）。

## 4. 公開鍵の登録

PC（Windows なら Git Bash）で鍵を作ります。

```bash
mkdir -p ~/.ssh
ssh-keygen -t ed25519 -N "" -C "xpd-deploy" -f ~/.ssh/xpd_deploy
cat ~/.ssh/xpd_deploy.pub
```

- `-N ""` はパスフレーズなし。`xpd` は途中で入力を求められない設定（`BatchMode=yes`）で ssh を呼ぶためです。
  パスフレーズを付けたい場合は ssh-agent に登録してから使ってください。
- 秘密鍵（`.pub` の付かない方）は PC の外に出さないでください。**GitHub には登録しません。**

サーバーパネル → **SSH設定** → **公開鍵登録・更新** → **手動で登録** を選び、`cat` で表示された 1 行を貼ります。

> 確認: `npx xpd check` で `connected: xs123456@…` と、`rsync: /usr/bin/rsync` などが表示される。
> 初回はホスト鍵が `~/.ssh/known_hosts` に記録されます（以後、鍵が変わると接続を止めます）。

## 5. 最初の `xpd deploy`（PC から）

```bash
npx xpd deploy
```

これで次のものがサーバーに置かれます。

| 場所 | 内容 |
|---|---|
| `~/.deploy/<name>/remote-deploy.sh` | 公開の本体（PC デプロイのたびに最新に更新） |
| `~/.deploy/<name>/pull.sh` | プル型の取得・検査（PC デプロイでのみ更新） |
| `~/.deploy/<name>/htaccess.pin` | 最後に PC から公開した `.htaccess` の一覧（パスと sha256） |
| `~/.deploy/<name>/protect.list` | 触らないパスの一覧（`/.well-known/`・`/_deploy/`・設定の `protect`） |
| `~/.deploy/<name>/releases/` | 直近 N 回分のリリース |
| `~/.deploy/<name>/original/` | 初回デプロイ前に public_html にあったもの（パネルの初期ページなど）のバックアップ |
| `public_html/_deploy/kick.php` | GitHub から「今すぐ見に来て」を受ける入口 |
| `public_html/_deploy/.htaccess` | `/_deploy/` は 3 つの JSON と kick.php 以外 403、キャッシュさせない |
| `public_html/_deploy/live.json` ほか | 公開状態 |

初回のデプロイは、public_html にもともとあったファイルを**消しません**（`original/` にも保存します。500 MB を
超えるときは保存を省略）。同じ名前のファイル（パネルの初期ページ `index.html` など）は上書きされます。残った
初期ファイル（`default_page.png` など）は不要なら確認してから消してください。デプロイ以外で置いたファイルは、
2 回目以降も消しません。

> 確認: `https://example.com/_deploy/live.json` が `{"release":…,"commit":…,"source":"local"}` を返す。

## 6. サーバー用の読み取り専用トークンと Cron

トークンの作り方は [github.md](github.md#1-サーバー用の読み取り専用トークン)。作ったら PC で:

```bash
npx xpd setup-pull
```

トークンを貼ると、サーバーの `~/.deploy/<name>/pull.env`（権限 600、公開フォルダの外）に保存され、サーバーから GitHub
に届くかを確認し、最後に Cron の 1 行を表示します。

サーバーパネル → **Cron設定** → **Cron設定追加**:

| 欄 | 値 |
|---|---|
| 分 / 時間 / 日 / 月 / 曜日 | `*` / `*` / `*` / `*` / `*`（毎分。選べなければ 分 を `*/5`） |
| コマンド | `/bin/sh /home/xs123456/.deploy/example-site/pull.sh cron >/dev/null 2>&1`（表示されたものをそのまま） |

出力は捨てているので Cron の通知メールは来ません。記録は `~/.deploy/<name>/pull.log`（1 回 1 行、1 MB で切り詰め）。

> 確認: 2〜3 分後に `https://example.com/_deploy/pull.json` の `checked_at` が今の時刻、`state` が `idle`。

## 7. （任意）サイトの `.htaccess` に `/_deploy/` の制限を入れる

`_deploy/.htaccess` はデプロイが自動で置きますが、念のためサイト側の `.htaccess` にも同じ制限を入れておくと安心です。
[`templates/htaccess-snippet`](../../templates/htaccess-snippet) をサイトの `.htaccess`（ビルドで outDir にコピーされる場所。
Astro なら `public/.htaccess`、Hugo なら `static/.htaccess`）にコピーします。
**`.htaccess` の変更は PC から `xpd deploy` で公開してください**（プル型は `.htaccess` の変更を拒否します）。
