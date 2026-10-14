# 公開状態のファイルと表示部品

## 3 つのファイル（すべて同じオリジン、`Cache-Control: no-store`）

| ファイル | 書く人 | いつ |
|---|---|---|
| `/_deploy/live.json` | `remote-deploy.sh`（PC・プル型・切り戻しのすべてが通る 1 か所） | 公開のたび。サイトの入れ替えの後 |
| `/_deploy/meta.json` | 同上（公開したリリースの `META.json` を 8 KB 以下ならそのまま、超えれば `{}`） | 同上 |
| `/_deploy/pull.json` | `pull.sh` | Cron・kick のたび |

どれも一時ファイルに書いてから `mv` するので、読み手は古いか新しいかのどちらかを見ます（半分だけ書かれた状態は見えません）。
スキーマ: [`status/schema/`](../../status/schema/)。

### live.json

```json
{ "release": "20261001-120301", "published_at": "2026-10-01T12:03:01+09:00",
  "commit": "<40 桁の SHA>", "dirty": false, "source": "pull" }
```

| キー | 意味 |
|---|---|
| `release` | サーバーのリリース ID（`xpd list`・切り戻しで使う） |
| `published_at` | 公開した時刻（サーバーの時刻帯） |
| `commit` | 公開したソースのコミット（`git` が無い PC から公開した場合は空） |
| `dirty` | 未コミットの変更を含めて PC から公開した（`--allow-dirty`） |
| `source` | `local`（PC）・`pull`（GitHub → サーバー）・`rollback`（切り戻し） |

### meta.json

```json
{ "commit": "<40 桁>", "subject": "コミットの 1 行目", "source": "github-actions", "trigger": "push",
  "run_url": "https://github.com/your-org/your-site/actions/runs/123", "built_at": "2026-10-01T03:02:10.000Z",
  "force": false, "dirty": false, "tool": "xserver-pull-deploy/0.1.0" }
```

`trigger` は `push`・`manual`（Run workflow）・`local`（PC）など。ワークフローの `XPD_TRIGGER` で変えられます。
**`subject` はコミットを書いた人が自由に書ける文字列**です。表示するときは必ずテキストとして扱ってください。

### pull.json

```json
{ "checked_at": "2026-10-01T12:05:00+09:00", "state": "idle", "message": "",
  "deploy_ref": "<deploy ブランチの SHA>", "deploy_commit": "<公開しようとしたソースの SHA>",
  "main_commit": "<ソースのブランチの最新 SHA>",
  "build": { "state": "success", "commit": "<SHA>", "run_url": "https://github.com/…/actions/runs/123", "message": "", "at": "…" },
  "token_expires_at": "2027-10-01T09:00:00+09:00" }
```

| キー | 意味 |
|---|---|
| `checked_at` | サーバーが最後に GitHub を確認した時刻。15 分以上古ければ Cron が止まっている |
| `state` | `idle`（正常）・`deploying`（公開処理中）・`error`（止めた） |
| `message` | `error` のときの理由（`pull.sh` 内の固定の日本語文） |
| `main_commit` | ソースのブランチの最新。`live.commit` と違えば「未公開の変更あり」 |
| `build` | `deploy-status` ブランチの `status.json` を、サーバーがキーと文字を絞って写したもの（無ければ `null`） |
| `token_expires_at` | サーバー用トークンの期限（GitHub の応答ヘッダーから） |

## 表示部品 `status/xpd-status.js`

依存なし・ES モジュール 1 ファイル。サイトのどこか（管理用のページなど）に置きます。

```html
<div id="xpd-status"></div>
<script type="module">
  import { mount } from '/xpd-status.js';
  mount(document.getElementById('xpd-status'), { repo: 'your-org/your-site', lang: 'ja' });
</script>
```

10 秒ごとに 3 つのファイルを読み（タブが隠れている間は止める）、上から順に 1 つの状態を決めます。

| 条件（上から順） | 表示 | `data-xpd-state` |
|---|---|---|
| `live.json` も `pull.json` も無い | 公開状態を確認できません | `unknown` |
| `pull.state == error`、またはビルド失敗（`build.commit == main_commit`） | 公開できませんでした ＋ 理由 ＋（あれば）GitHub の実行へのリンク | `error` |
| `pull.checked_at` が 15 分より古い | サーバーの自動確認が止まっています | `stale` |
| ビルド中（30 分以内）または `pull.state == deploying` | 公開処理中… | `building` |
| `main_commit != live.commit` | 未公開の変更があります | `unpublished` |
| それ以外（`pull.json` が無い PC だけの運用も含む） | 公開済み ○分前 | `published` |
| トークンの期限が 30 日以内 | 上に重ねて「サーバー用トークンの期限が近い」 | — |

- 値はすべて**信用しない**前提で、項目ごとに形式を確かめ、長さを切り、`textContent` / `setAttribute` でだけ書きます。
- リンクは `https://github.com/<repo>/actions/runs/<数字>` の形のときだけ作ります（`repo` を渡さなければリンクは作りません）。
- 見た目は `[data-xpd-state="error"]` などで自由に CSS を当ててください。
- 判定だけ使うこともできます: `import { snapshot, judge } from './xpd-status.js'`。
