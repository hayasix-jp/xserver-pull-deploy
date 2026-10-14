# 例: Astro

`package.json`（抜粋）:

```json
{
  "scripts": {
    "build": "astro build",
    "deploy": "xpd deploy",
    "deploy:dry": "xpd deploy --dry-run",
    "deploy:list": "xpd list",
    "deploy:rollback": "xpd rollback"
  },
  "devDependencies": {
    "astro": "^5.0.0",
    "xserver-pull-deploy": "^0.1.0"
  }
}
```

- `.htaccess` は `public/.htaccess` に置くと、Astro が `dist/` にそのままコピーします
  （[`templates/htaccess-snippet`](../../templates/htaccess-snippet) を参考に）。
- `npx xpd init` が `.github/workflows/xserver-pull-deploy.yml` を作ります。ワークフローは `npm ci` の後に
  `xpd bundle-only`（= `npm run build` → bundle）を実行します。
- ビルドに環境変数が必要なら、ワークフローの `Build and bundle` ステップに `env:` を足してください。
- `xpd.config.mjs.example` は設定を JS で書く例です。
