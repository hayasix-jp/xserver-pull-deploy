# xserver-pull-deploy

**エックスサーバーで「国外アクセス制限（SSH）」を ON のまま、GitHub から静的サイトを自動公開する。**
あわせて、PC からの安全な一括入れ替えデプロイ、数秒の切り戻し、公開状態の JSON を提供します。

> 本ツールは非公式のツールで、エックスサーバー株式会社とは関係ありません。「エックスサーバー」「Xserver」は同社の商標です。
> 無保証です（MIT ライセンス）。サポートは可能な範囲で行います。

Astro・Vite・Next.js（静的エクスポート）・Hugo・11ty・手書きの HTML など、静的サイトなら何でも使えます。ビルドの
コマンドと出力フォルダは設定で指定します。依存パッケージはゼロ（Node.js 20 以上と、OS に入っている ssh だけ）です。

- [何を解決するか](#何を解決するか)
- [仕組み](#仕組み)
- [5 分でわかるクイックスタート](#5-分でわかるクイックスタート)
- [コマンド一覧](#コマンド一覧)
- 詳しい手順: [サーバーパネルの設定](xserver.md) ・ [GitHub の設定](github.md) ・ [設定ファイル](configuration.md)
- [セキュリティと脅威モデル](security.md) ・ [トラブルシューティング](troubleshooting.md) ・ [FAQ と制限事項](faq.md) ・
  [公開状態のファイルと表示部品](status.md)

---

## 何を解決するか

エックスサーバーは 2024 年 7 月から、**SSH の「国外アクセス制限」を初期設定で ON** にしています。
GitHub Actions の実行サーバーは海外にあるため、よくある「push → GitHub Actions → SSH（rsync）で送り込む」形の
自動デプロイはつながりません。

| よくある回避策 | 問題 |
|---|---|
| 国外アクセス制限を OFF にする | エックスサーバー自身が非推奨としています。世界中から SSH を試されます |
| GitHub の IP を許可リストに登録する | GitHub が公表している接続元は数千件あり、登録できる上限を大きく超えます |
| FTP で送る | 暗号化されない、途中で切れると半端な状態が公開される、消すべきファイルが残る |
| GitHub にサーバーの鍵を置く | GitHub 側（リポジトリや Actions）が乗っ取られると、サーバーのシェルまで渡ります |

xserver-pull-deploy は向きを逆にします。**GitHub がサーバーに入るのではなく、サーバーが GitHub に取りに行きます。**
サーバーからの外向きの HTTPS 通信は国外アクセス制限の対象外なので、制限は ON のままです。

## 仕組み

```
  あなたの PC（国内）                    GitHub                               エックスサーバー（国外アクセス制限 ON）
 ┌─────────────────────┐   git push   ┌──────────────────────────────┐      ┌────────────────────────────────────────┐
 │ 編集 → コミット        │ ───────────▶ │ main                          │      │ ~/.deploy/<name>/                      │
 │                       │              │ Actions: ビルド → まとめる     │      │   pull.sh   ← Cron 毎分 ＋ kick で即時   │
 │ xpd deploy（SSH）─────┼──┐           │ → deploy ブランチに 1 コミット │      │   remote-deploy.sh                      │
 └─────────────────────┘  │           │   bundle.tar.gz / sha256 /     │      │   releases/  (直近 N 回分)               │
                           │           │   META.json                    │      │   pull.env   (読み取り専用トークン, 600)  │
                           │           │ → POST /_deploy/kick.php ──────┼─────▶│                                        │
                           │           │ → live.json を待つ → 確認      │      │ ① GitHub API に「deploy は変わった？」  │
                           │           └──────────────┬───────────────┘      │    （変化なしは 304。回数制限の対象外）    │
                           │                          │ ② 取得（読み取りのみ）  │ ② bundle を取得 → sha256 照合            │
                           │                          └────────────────────────▶ ③ 中身の検査（信用しない）              │
                           │                                                  │ ④ rsync で public_html に一括入れ替え    │
                           └──────────────────── SSH（国内なので OK）────────────▶│ ⑤ /_deploy/live.json・pull.json を更新  │
                                                                              └────────────────────────────────────────┘
```

公開の経路は 2 つあり、**どちらも最後はサーバー上の同じ処理（`remote-deploy.sh`）**で反映されます。

| 経路 | 使う場面 | 目安 |
|---|---|---|
| **A. GitHub → サーバーが取りに行く（プル型）** | 日常の更新。`git push` するだけ。PC が無くてもよい（GitHub の Web 画面で編集しても公開される） | push から 1〜3 分 |
| **B. PC から `xpd deploy`（SSH）** | 初回、`.htaccess` の変更、サーバー側スクリプトの更新、急ぎ・非常時 | 20〜30 秒 |

### 公開の中身（両経路で共通）

- **途中の状態を見せない**: サーバー自身の rsync で `-c --delete-delay --delay-updates`。変わったファイルは最後に
  まとめて差し替えます。`public_html` そのものはシンボリックリンクに置き換えません（パネルの機能が実フォルダを前提にしているため）。
- **権限をそろえる**: フォルダ 755・ファイル 644（`--chmod=D755,F644`）。
- **触らない場所**: `/.well-known/`（無料 SSL の更新）、`/_deploy/`（公開状態のファイル）、設定した `protect`（例 `/uploads/`）。
- **デプロイ以外で置かれたファイルは消さない**: 削除の対象は「前回のデプロイで公開したファイル」だけ。
  ファイル管理で置いた `google….html` や、サブドメインのフォルダなどは残し、ログに「保護」と出します。
  **初回のデプロイは何も削除しません**（同じ名前のファイルだけ上書き。元の中身は `~/.deploy/<name>/original/` にも保存）。
- **壊れたビルドを公開しない**: HTML の数が公開中の半分未満なら止めます（`--force` で意図的に公開）。
- **切り戻し**: 直近 N 回分（既定 5）を保存。`xpd rollback` で数秒、GitHub の Run workflow からでも戻せます。
- **接続が切れても止まらない**: サーバー側の処理は SSH が切れても最後まで実行し、結果を `deploy.log` に残します。
- **同時実行しない**: サーバー側でロックします（PC とプル型が重なっても順番待ち）。
- **公開状態の記録**: `/_deploy/live.json`（何を・いつ・どの経路で）、`meta.json`、`pull.json`（サーバーの最終確認・エラー・トークン期限）。

### プル型で守っていること（詳しくは [security.md](security.md)）

- GitHub には**サーバーの鍵もパスワードも置きません**。サーバーには「このリポジトリだけ・読み取りだけ」のトークンを置きます。
- サーバーは取ってきたものを**信用しません**。`site/**`・`META.json`・`REVISION` 以外、リンク、`..`、`.php` などの実行
  できるファイル、`.user.ini` などの設定ファイルを含むものは拒否し、`.htaccess` は「最後に PC から公開したときの記録
  （`htaccess.pin`）」と 1 バイトでも違えば拒否します。**サーバーの設定は PC からしか変わりません。**
- 実行するのは常にサーバーに**インストール済み**の `remote-deploy.sh` です（bundle の中身では置き換わりません）。
- `kick.php` は入力を一切読みません。できるのは「今すぐ GitHub を見に行かせる」ことだけです（10 秒に 1 回まで）。
- 同じ公開データで 3 回失敗したら、新しいデータが来るまでやり直しません（最初の失敗でメール 1 通、任意）。

---

## 5 分でわかるクイックスタート

> 前提: エックスサーバーでドメインを追加済み（`/home/<サーバーID>/<ドメイン>/public_html` がある）、
> PC に Node.js 20 以上と Git（Windows なら Git for Windows）、GitHub にサイトのリポジトリ。

**1. 道具を入れて、設定ファイルを作る**（サイトのリポジトリのいちばん上のフォルダで）

```bash
npm init -y                                      # package.json がまだ無いとき（手書き HTML のサイトなど）だけ
npm i -D xserver-pull-deploy                  # GitHub から直接なら github:hayasix-jp/xserver-pull-deploy
npx xpd init                                     # xpd.config.json / .env.deploy.example / .github/workflows/xserver-pull-deploy.yml
```

> **package.json が無いまま `npm i -D` を実行しないでください。** npm は親フォルダ（ホームフォルダなど）の
> package.json / node_modules を探して、そこに入れてしまいます。
>
> npm を使いたくない場合は、このリポジトリを `tools/xserver-pull-deploy/` としてサイトのリポジトリにコピーし、
> `npx xpd …` の代わりに `node tools/xserver-pull-deploy/bin/xpd.mjs …` で実行します（`init` はワークフローにも
> この形を書き込みます）。

`init` は `.gitignore` に `.env.deploy`・`.xpd-bundle/`（npm のプロジェクトなら `node_modules/` も）を足します。
`xpd.config.json` を確認します（`init` が Astro・Next・Vite・11ty・Hugo を見分けて下書きします。手書き HTML なら
`"build": ""` で、公開するファイルが入っているフォルダ（例 `public`）を `outDir` にします）。
**`siteUrl` は必ず自分のサイトの URL に書き換えてください**（`deploy` の系譜ガードと反映確認がここを読みます）。

```json
{
  "name": "example-site",
  "build": "npm run build",
  "outDir": "dist",
  "siteUrl": "https://example.com",
  "branch": "main",
  "keep": 5,
  "protect": []
}
```

**2. サーバーパネル**（[xserver.md](xserver.md)）: SSH を ON（**国外アクセス制限は ON のまま**）、PC で作った公開鍵を登録。

```bash
ssh-keygen -t ed25519 -N "" -C "xpd-deploy" -f ~/.ssh/xpd_deploy
cat ~/.ssh/xpd_deploy.pub      # ← この 1 行をパネルの「SSH設定 → 公開鍵登録」に貼る
```

**3. PC の接続設定**（Git に入れないファイル）

```bash
cp .env.deploy.example .env.deploy
# XPD_HOST=sv12345.xserver.jp  XPD_USER=xs123456  XPD_DOCROOT=/home/xs123456/example.com/public_html
```

**4. コミットしてから、最初の公開は PC から**（サーバー側のスクリプトと `.htaccess` の記録がここで置かれます）

`xpd deploy` は**未コミットの変更があると止まります**（下の「系譜ガード」）。先にコミットします（push は手順 5 で。
今 push すると、サーバーの準備ができる前に GitHub Actions が動いて失敗します）。

```bash
git add . && git commit -m "xserver-pull-deploy の設定"
npx xpd deploy --dry-run       # 何をするか表示するだけ（SSH の接続も送信もしません）
npx xpd check                  # 初めて接続（ホスト鍵を記録）。rsync・公開フォルダ・今の .htaccess を表示
npx xpd deploy                 # ビルド → 送信 → 一括入れ替え → 反映を確認
```

- `--dry-run` も、系譜ガードのために `siteUrl` の `/_deploy/live.json` を読み、`git fetch origin` を実行します
  （どちらも読み取りだけです）。
- 最初の `check` では、サーバー側にまだ何も無いので `remote-deploy.sh` などに `No such file or directory` と
  表示されます。正常です。
- 最初の `deploy` は public_html の既存のファイルを**消しません**（同じ名前のファイル、たとえばパネルの初期ページ
  `index.html` は上書きされます）。不要な初期ファイル（`default_page.png` など）は、確認してからファイル管理で
  消してください。元の中身は `~/.deploy/<name>/original/` にも保存されます（500 MB 以下のとき）。

**5. プル型を有効にする**（[github.md](github.md)）

1. GitHub で **fine-grained token** を作る（このリポジトリだけ・Contents: Read-only・期限 1 年）。
2. `npx xpd setup-pull` → トークンを貼る → サーバーが GitHub に届くか確認され、Cron の 1 行が表示されます。
   リポジトリ名は `git remote` の `origin` から読みます（無ければ `xpd.config.json` に `"githubRepo": "owner/repo"`）。
   Git Bash（mintty）では貼ったトークンが画面に表示されることがあります。気になる場合は PowerShell か
   Windows Terminal で実行してください。
3. サーバーパネル → **Cron設定** にその 1 行（`* * * * * /bin/sh /home/xs123456/.deploy/example-site/pull.sh cron >/dev/null 2>&1`）を追加。
4. `git push`（手順 4 でコミットした設定とワークフローが GitHub に上がり、最初の GitHub Actions が動きます。`origin` が未設定なら `git remote add origin <GitHub の URL>` → `git push -u origin main`）

push のたびに GitHub Actions がビルドして deploy ブランチに置き、サーバーが取りに来て公開します。
`https://example.com/_deploy/live.json` の `"source"` が `"pull"` になれば完成です。

---

## コマンド一覧

| コマンド | 内容 |
|---|---|
| `xpd init` | `xpd.config.json`・`.env.deploy.example`・GitHub ワークフローを作り、`.gitignore` に `.env.deploy` などを足す |
| `xpd deploy` | 系譜ガード → ビルド → 1 本の SSH で送信 → サーバーで一括入れ替え → 反映確認。`pull.sh`・`kick.php`・`htaccess.pin` もここで更新 |
| `xpd deploy --dry-run` | 何をするかを表示するだけ（SSH の接続も送信もしない。`.env.deploy` が無くても動く。系譜ガードの live.json 読み取りと `git fetch` はする） |
| `xpd check` | サーバーに接続して状態を表示（rsync / flock / curl の有無、公開フォルダ、`.htaccess`、リリース、pull.log、live.json） |
| `xpd list` | 保存しているリリースの一覧（`*` が公開中） |
| `xpd rollback [ID]` | 1 つ前（または指定 ID）に戻す |
| `xpd setup-pull` | サーバーの `pull.env` にトークン等を書き（600）、`pull.sh check` で確認し、Cron の 1 行を表示 |
| `xpd bundle-only` | （Actions 用）ビルドして `.xpd-bundle/` に `bundle.tar.gz`・`bundle.sha256`・`META.json`。`--rollback` で切り戻し依頼だけ |
| `xpd lineage --ci` | （Actions 用）公開中の commit がこれから公開するものの祖先か確認 |
| `xpd kick` / `xpd wait` / `xpd verify` | （Actions 用）サーバーを起こす / live.json の一致を待つ / 公開サイトを確認 |

`deploy` の追加の指定: `--skip-build`（今の outDir をそのまま）、`--force`（ページ数ガードを外す）、
`--allow-dirty`（未コミットのまま。live.json に `dirty: true`）、`--overwrite`（系譜ガードを外す）。

### 系譜ガード（PC と GitHub の行き違いを止める）

`xpd deploy` は公開の前に次を確かめ、当てはまれば終了コード 3 で止まります（公開中のサイトは変わりません）。

1. GitHub の `main` に、この PC に無いコミットがある → `git pull` してから。
2. 公開中のサイト（`/_deploy/live.json` の commit）が、この PC の履歴に無い → `git pull` してから。
3. 未コミットの変更がある → コミットしてから（`--allow-dirty` で許可）。

GitHub Actions 側も、公開中の commit がこれから公開するコミットの祖先でなければ失敗します（PC から公開して push
し忘れた内容を、黙って消さないため）。意図的に古い版を出すときは `--overwrite`（Actions では Run workflow の `overwrite`）。
