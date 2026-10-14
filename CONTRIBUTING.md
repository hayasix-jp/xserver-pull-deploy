# Contributing

Thank you for your interest!

- **No warranty, best-effort support.** This is a small tool maintained in spare time. Issues and pull requests are
  welcome, but there is no guaranteed response time. Please do not rely on it for anything you cannot roll back.
- Issues and pull requests in Japanese or English are both fine. / 日本語でも英語でもかまいません。
- Never paste tokens, private keys, server IDs or `pull.env` contents into an issue. Use placeholders such as
  `xs123456`, `sv12345.xserver.jp`, `example.com`, `your-org/your-site`.
- Security problems: see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development

```bash
npm test            # all tests (node --test); the server scripts run under sh against local fakes
npm run test:unit   # fast unit tests only
npm run lint:sh     # sh -n on the server scripts
```

- Keep runtime dependencies at zero and the server scripts POSIX sh (no bash-isms; they run under `/bin/sh` on
  the server with curl 7.x).
- Server-side changes need a test in `test/server/`. The tests must never contact real servers or GitHub.
- Keep the security properties described in `docs/ja/security.md`: GitHub holds no server credentials, the server
  trusts nothing it downloads, server configuration only changes from a PC deploy.
