# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-09

### Added

- `xpd` CLI (zero dependencies, Node 20+): `init`, `deploy` (`--dry-run`, `--skip-build`, `--force`, `--allow-dirty`,
  `--overwrite`), `check`, `list`, `rollback`, `setup-pull`, `bundle-only`, `lineage --ci`, `kick`, `wait`, `verify`.
- Configuration from `xpd.config.json` / `xpd.config.mjs` + `.env.deploy` + environment variables. Any static site
  generator: the build command and output folder are settings.
- Server side (POSIX sh): `remote-deploy.sh` (rsync publish with delayed swap, N releases, rollback, foreign-file
  protection, page-count guard, lock, `/_deploy/live.json` + `meta.json`) and `pull.sh` (pull from GitHub with
  conditional requests, sha256 check, bundle inspection, `.htaccess` pin, retry cap, failure mail, `pull.json`).
- `kick.php` (no input, rate-limited) and a `_deploy/.htaccess` installed by PC deploys.
- GitHub Actions workflow template (build → bundle → orphan deploy branch → kick → wait → verify; rollback input).
- Dependency-free status widget (`status/xpd-status.js`) and JSON schemas for the status files.
- Japanese documentation (`docs/ja/`), examples, and a test suite with a fake GitHub API and a fake docroot.

### Security

- `pull.sh` refuses PHP-family extensions anywhere in a file name (`x.php.jpg`), caps every download
  (`--max-filesize`), cuts off a decompression bomb before listing the archive, and lists the archive with
  `--numeric-owner` so an owner name cannot shift the size column.
- `remote-deploy.sh`: the first deploy deletes nothing (no data loss when public_html already holds a subdomain
  folder or other files, even when the 500 MB backup is skipped); a release whose publish failed is removed again, so
  "rollback previous" never picks it; the server folder path is checked before it is written into `kick.php`.
- Workflow template: `persist-credentials: false` (the write token is not in `.git/config` while dependencies install
  and the build runs) and the token reaches `git push` through `GIT_CONFIG_*` environment variables, not argv.
- CLI: host, user and branch names may not start with `-`; `init --branch` is validated before it goes into YAML.
  `init` adds `node_modules/` to `.gitignore` in npm projects.
