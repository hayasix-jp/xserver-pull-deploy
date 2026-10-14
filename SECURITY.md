# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** using GitHub's "Report a vulnerability" (Security → Advisories) on this
repository. Do not open a public issue. Japanese or English is fine.

Include what an attacker needs (e.g. write access to the site repository, a leaked read-only token, network
position), what they gain (e.g. code execution on the server, `.htaccess` changes, reading files outside the docroot),
and a minimal reproduction using placeholders only.

This is a best-effort project: there is no bug bounty and no guaranteed response time, but security reports are
handled first.

## Scope

In scope: `server/remote-deploy.sh`, `server/pull.sh`, `server/kick.php`, `server/deploy.htaccess`, the bundle
format and inspection, the CLI's handling of credentials, the workflow template, `status/xpd-status.js`.

The security model and the threats it does and does not cover are described in
[docs/ja/security.md](docs/ja/security.md). Notably out of scope: anyone with write access to the site repository can
publish arbitrary static files (HTML/JS) — that is what publishing means.
