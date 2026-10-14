# 例: 手書きの HTML サイト

ビルドなし。`public/` をそのまま公開します。

```bash
# このフォルダで（xpd を devDependency に入れたサイトなら npx xpd …）
node ../../bin/xpd.mjs deploy --dry-run           # 接続せずに計画を表示（.env.deploy が無くても動く）
node ../../bin/xpd.mjs bundle-only --skip-build   # .xpd-bundle/ に bundle.tar.gz・bundle.sha256・META.json を作る
```

- `protect: ["/uploads/"]` … サーバーの `public_html/uploads/` はデプロイで触りません（ファイル管理で直接置く画像など）。
- `public/.htaccess` … `/_deploy/` の制限と http → https。**変更は PC から `xpd deploy` で公開**します。
