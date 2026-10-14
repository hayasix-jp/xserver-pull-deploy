# xserver-pull-deploy

**日本語のドキュメントはこちら → [docs/ja/README.md](docs/ja/README.md)**（メインのドキュメントです）

> Unofficial tool, not affiliated with or endorsed by XServer Inc. "Xserver" / 「エックスサーバー」 is a trademark of XServer Inc. Provided as is under the MIT License, with best-effort support.

Publish a static site to **Xserver** (エックスサーバー) — or any shared host with SSH, cron, curl and rsync — from
GitHub, **without opening SSH to overseas IP addresses**. Works with any static site generator: Astro, Vite, Next.js
static export, Hugo, 11ty, plain HTML. The build command and output folder are configuration.

## The problem

Since July 2024 Xserver enables "国外アクセス制限" (foreign-IP restriction) for SSH by default. GitHub Actions
runners are outside Japan, so the usual "push → Actions → rsync over SSH" deploy cannot connect, and GitHub's IP
ranges (thousands of CIDRs) do not fit Xserver's allow-list. Turning the restriction off is discouraged.

## The idea: let the server pull

```
 GitHub Actions                              Xserver (foreign-IP restriction stays ON)
 ─────────────                               ─────────────────────────────────────────
 build → bundle.tar.gz + sha256 + META.json
 → one orphan commit on branch "deploy"
 → POST /_deploy/kick.php  ───────────────▶  pull.sh (cron every minute + kick)
                                               asks the GitHub API (read-only token, 304 when unchanged)
                                               downloads → sha256 → content inspection
                                               → remote-deploy.sh: rsync into public_html, atomic swap
 wait for /_deploy/live.json  ◀───────────   writes /_deploy/live.json, meta.json, pull.json
```

- GitHub holds **no** server credentials. The server holds only a fine-grained, **read-only** token for **one**
  repository.
- The server **does not trust the bundle**: only `site/**`, `META.json`, `REVISION`; no symlinks/hard links/devices,
  no `..`, nothing executable (`.php`, `x.php.jpg`, `.cgi`, `.phar`, `.user.ini`, …), size caps on the download and
  the decompression, and the set of `.htaccess` files must be
  byte-identical to what the last deploy **from your PC** recorded. Server configuration only ever changes from the PC.
- `kick.php` reads no input; all it can do is make the server check GitHub sooner (rate-limited to once per 10 s).

From your PC (a Japanese IP, so SSH works with the restriction ON) the same tool does a one-command deploy over a
single SSH connection, keeps N releases, rolls back in seconds, and installs/updates the server-side scripts.

Both paths publish through the same server script: `rsync -c --delete-delay --delay-updates` into the real
`public_html` (never a symlink swap), `--chmod=D755,F644`, `/.well-known/` and `/_deploy/` untouched, files that a
deploy did not put there (uploads, verification files, subdomain folders) are kept — the very first deploy deletes
nothing at all — and a build that lost more than half of its pages is refused unless forced.

## Quick start

```bash
npm init -y                                    # only if the site has no package.json yet (plain HTML)
npm i -D xserver-pull-deploy   # or github:hayasix-jp/xserver-pull-deploy, or vendor this folder; zero dependencies, Node 20+
npx xpd init                                   # xpd.config.json, .env.deploy.example, .github/workflows/…
cp .env.deploy.example .env.deploy             # host, server ID, docroot, SSH key (never committed)
git add . && git commit -m "xserver-pull-deploy" # deploy refuses uncommitted changes (lineage guard)
npx xpd deploy --dry-run                       # no SSH; it does read <siteUrl>/_deploy/live.json and git fetch
npx xpd deploy                                 # first deploy from the PC: also installs pull.sh / kick.php
npx xpd setup-pull                             # stores the read-only token on the server, prints the cron line
git push                                       # from now on GitHub Actions publishes via the pull path
```

Commands: `init`, `deploy [--dry-run|--skip-build|--force|--allow-dirty|--overwrite]`, `check`, `list`,
`rollback [ID]`, `setup-pull`, `bundle-only`, `lineage --ci`, `kick`, `wait`, `verify`. See `xpd help`.

## Status

`/_deploy/live.json` (what is live, since when, which commit, from which path), `/_deploy/meta.json` and
`/_deploy/pull.json` (the server's last check, errors, token expiry). A tiny dependency-free widget is in
[`status/`](status/), the schemas in [`status/schema/`](status/schema/).

## Documentation (Japanese)

| | |
|---|---|
| [Overview, how it works, 5-minute quick start](docs/ja/README.md) | [Xserver panel steps](docs/ja/xserver.md) |
| [GitHub (token, Actions)](docs/ja/github.md) | [Configuration](docs/ja/configuration.md) |
| [Security & threat model](docs/ja/security.md) | [Troubleshooting](docs/ja/troubleshooting.md) |
| [FAQ & limitations](docs/ja/faq.md) | [Status files & widget](docs/ja/status.md) |

## Development

```bash
npm test        # node --test; the server scripts run under sh against a fake GitHub API and a fake docroot
```

On Windows run the tests from Git Bash. Without a real `rsync` the suite uses a small stand-in
(`test/fakes/rsync.mjs`); CI on Linux uses the real one.

## License

MIT — see [LICENSE](LICENSE). No warranty; best-effort support (see [CONTRIBUTING.md](CONTRIBUTING.md)).
Not affiliated with Xserver Inc. "Xserver" / "エックスサーバー" are trademarks of their owner.
