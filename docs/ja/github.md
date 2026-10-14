# GitHub の設定

## 1. サーバー用の読み取り専用トークン

サーバーが GitHub から公開用のデータを取りに行くための鍵です。**このリポジトリだけ・読み取りだけ**に絞ります。

GitHub → 右上のアイコン → **Settings** → **Developer settings** → **Personal access tokens** →
**Fine-grained tokens** → **Generate new token**

| 欄 | 値 |
|---|---|
| Token name | `example-site-server-pull` など |
| Resource owner | リポジトリの持ち主（個人または組織） |
| Expiration | **Custom → 1 年後**（期限が 30 日以内になると、状態表示に黄色の警告が出ます） |
| Repository access | **Only select repositories** → サイトのリポジトリ 1 つだけ |
| Repository permissions | **Contents: Read-only**（Metadata: Read-only は自動で付きます）。**ほかはすべて No access** |

**Generate token** → 表示された `github_pat_…` をすぐ `npx xpd setup-pull` に貼ります（画面を閉じると二度と表示
されません。メモ帳などに保存しないでください）。

- 組織（Organization）のリポジトリの場合: 組織の Settings → Personal access tokens で fine-grained tokens を許可し、
  承認制なら承認してください。承認待ちの間は `pull.sh check` が 404 / 403 になります。
- classic token（`ghp_…`）でも動きますが、権限が広すぎるので使わないでください。
- **このトークンは GitHub の Secrets には登録しません。** 置き場所はサーバーの `pull.env`（600）だけです。

### 期限が来たら（1 年ごと）

1. Fine-grained tokens → 該当トークン → **Regenerate token**（または同じ設定で作り直し）。
2. PC で `npx xpd setup-pull` → 新しいトークンを貼る。

## 2. GitHub Actions のワークフロー

`npx xpd init` が `.github/workflows/xserver-pull-deploy.yml` を作ります（元は [`templates/github-workflow.yml`](../../templates/github-workflow.yml)）。

流れ:

1. checkout（全履歴）→ Node のセットアップ → 依存のインストール（`package-lock.json` があれば `npm ci`。xpd 自体もここで入る）
2. `deploy-status` ブランチに `status.json`（ビルド中）を書く（サーバーが `pull.json` に写し、状態表示に出ます）
3. 系譜チェック（`xpd lineage --ci`）
4. （Node 以外のツールが要るなら、ここにセットアップのステップを足す）
5. `xpd bundle-only` = `xpd.config.json` の `build` を実行 → `.xpd-bundle/` に `bundle.tar.gz`・`bundle.sha256`・`META.json`
6. それを `deploy` ブランチに **orphan コミット 1 つ**として force push（履歴は残りません。常に最新の 1 つ）
7. `xpd kick`（`POST /_deploy/kick.php`。届かなくても Cron が 1 分以内に取りに来ます）
8. `xpd wait`（`/_deploy/live.json` の commit が一致するまで最大 6 分。サーバーが止めたら、その理由で失敗）
9. `xpd verify`（公開サイトの確認。Variable `XPD_VERIFY` で動作を選ぶ）
10. `status.json` に成功／失敗を書く

### 何も登録しなくてよいもの

- **Secrets は不要です。** deploy ブランチへの push はワークフローの `GITHUB_TOKEN`（`contents: write`）で行います。
  `GITHUB_TOKEN` による push は、新しいワークフローを起動しません（無限ループになりません）。
- サーバーの SSH 鍵・パスワード・XServer API キーは**登録しません**。

### Variables（任意）

Settings → Secrets and variables → Actions → **Variables**

| 名前 | 値 | 意味 |
|---|---|---|
| `XPD_VERIFY` | `true` / `false` / 未設定 | 公開後の確認。`true` = 失敗したら実行も失敗、`false` = 確認しない、未設定 = 警告だけ |

ビルドに必要な環境変数（例: フォームの送信先 URL）は、通常どおり `Build and bundle` のステップに `env:` で渡してください。

### Run workflow（手動実行）の入力

Actions → **Deploy** → **Run workflow**

| 入力 | 意味 |
|---|---|
| `ref` | 公開するコミット / タグ（空 = 最新） |
| `force` | HTML の数が公開中の半分未満でも公開する |
| `overwrite` | 系譜チェックを無視する（古いコミットを意図的に公開するとき） |
| `rollback` | `previous` またはリリース ID。入力するとビルドせず、サーバーが保存済みのリリースに戻す |

### Node 以外のサイト（Hugo など）

- `xpd` 自体は Node で動くので、`actions/setup-node` はそのまま残します。
- `Install dependencies` の後に、そのツールのセットアップ（例: `peaceiris/actions-hugo`）を足します。
- `xpd` を devDependency として入れない場合は、このリポジトリのフォルダをサイトのリポジトリ（例: `tools/xserver-pull-deploy/`）
  にコピーし、ワークフローの `XPD:` を `node tools/xserver-pull-deploy/bin/xpd.mjs` にします（`xpd init` をそのコピーから
  実行すると自動でそうなります）。

## 3. 通知

- **GitHub**: Settings → Notifications → Actions → 「Only notify for failed workflows」。
- **サーバー**: `xpd setup-pull` で通知先メールを入れると、サーバー側で公開を止めたときに 1 通届きます
  （同じ公開データでは最初の 1 回だけ）。サーバーの `sendmail` を使います。

## 4. ブランチ

| ブランチ | 中身 | 書く人 |
|---|---|---|
| `main`（`branch`） | サイトのソース | あなた |
| `deploy`（`deployBranch`） | 最新の公開用データ（orphan コミット 1 つ） | Actions（毎回上書き。手で触らない） |
| `deploy-status`（`statusBranch`） | `status.json`（ビルド中／成功／失敗） | Actions（毎回上書き） |

ブランチ保護（Branch protection rules）を `deploy` / `deploy-status` に掛けると force push できず失敗します。
**`main` を保護するのはかまいません。**

> サーバーは `deploy` ブランチの中身を一切信用しません。リポジトリに書き込める人が勝手に `deploy` を書き換えても、
> できるのは「検査を通る静的ファイルの公開」だけです（[security.md](security.md)）。
