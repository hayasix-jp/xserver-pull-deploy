#!/bin/sh
# server/remote-deploy.sh — runs ON the server (Xserver or any POSIX host with rsync), never on the PC.
# Part of xserver-pull-deploy (MIT). Installed as ~/.deploy/<name>/remote-deploy.sh by every PC deploy (atomic mv);
# pull.sh always runs that INSTALLED copy — a bundle fetched from GitHub never carries or replaces it.
#
#   deploy   <upload dir> <docroot> <keep> [install] [force]
#                                     publish a freshly uploaded bundle. "install" (PC deploys only) also installs
#                                     server/pull.sh, kick.php, the _deploy/.htaccess, protect.list and htaccess.pin
#                                     from the upload. "force" skips the "lost more than half of the pages" guard.
#   rollback <docroot> [release id]   re-publish an older release (default: the one before the live one)
#   list                              list kept releases (* = live)
#
# Environment: DEPLOY_SOURCE = local (default) | pull | rollback — recorded in /_deploy/live.json
#              XPD_DOCROOT_SUFFIX     the docroot must end with this (default /public_html)
#              XPD_LOCK_WAIT          seconds to wait for another deploy (default 300)
# Exit: 0 ok · 64 usage/path · 65 docroot missing · 66 incomplete upload · 67 no such release · 68 live release
#       missing · 69 no rsync · 70 rsync failed · 71 page-count guard · 75 another deploy is running
#
# Publishing = the server's own rsync from the release folder into the real docroot:
#   -c --delete-delay --delay-updates  → changed files are swapped in at the very end (no half-updated pages)
#   --no-times                         → unchanged files keep their mtime/ETag (cheap 304s)
#   --chmod=D755,F644                  → the permissions Xserver recommends, whatever OS built the bundle
#   --exclude-from (protect list)      → /.well-known/ (free SSL), /_deploy/ (status files, kick.php) and the
#                                        configured protect paths are never touched
#   foreign-file protection            → --delete only removes files that WE published (that are in the live
#                                        release). Anything else in the docroot — a subdomain folder, a google*.html,
#                                        an upload made in the file manager — is kept and logged. The FIRST deploy
#                                        deletes nothing at all (it overwrites same-named files; the original docroot
#                                        is also copied to original/ when it is at most 500 MB).
# The docroot itself is never replaced or symlinked (hosting panels expect a real folder). Once publishing starts the
# script runs to the end even if the SSH connection drops (SIGHUP/SIGPIPE ignored); the outcome goes to deploy.log.
set -eu
umask 022
trap '' HUP PIPE

case "$0" in */*) BASE=${0%/*} ;; *) BASE=. ;; esac
BASE=$(cd "$BASE" && pwd -P)
RELEASES="$BASE/releases"
SUFFIX=${XPD_DOCROOT_SUFFIX:-/public_html}
LOCK_WAIT=${XPD_LOCK_WAIT:-300}

# Output is best effort: if the SSH connection is gone, writing must not abort a publish half-way.
say() { printf '[server] %s\n' "$*" 2>/dev/null || true; }
FRESH_REL=""   # a release created by this deploy that is not live yet: removed again when the deploy fails
PIN_TMP=""
die() {
  code=${2:-1}
  printf '[server] ERROR: %s\n' "$1" >&2 2>/dev/null || true
  # never leave a release that was not published behind: "rollback previous" would pick it
  if [ -n "$FRESH_REL" ]; then rm -rf "$FRESH_REL" 2>/dev/null || true; fi
  if [ -n "$PIN_TMP" ]; then rm -f "$PIN_TMP" 2>/dev/null || true; fi
  if [ -d "$BASE" ]; then
    printf '%s\tFAILED(%s)\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$code" "$1" >> "$BASE/deploy.log" 2>/dev/null || true
  fi
  exit "$code"
}

case "$SUFFIX" in
  /*) ;;
  *) die "XPD_DOCROOT_SUFFIX は / で始めてください: $SUFFIX" 64 ;;
esac
case "$SUFFIX" in *..* | *[!A-Za-z0-9._/-]*) die "XPD_DOCROOT_SUFFIX に使えない文字があります: $SUFFIX" 64 ;; esac
case "$LOCK_WAIT" in '' | *[!0-9]*) LOCK_WAIT=300 ;; esac

# A docroot must be an existing absolute path ending in $SUFFIX (guards --delete against a wrong path).
check_docroot() {
  case "$1" in
    *..* | *[!A-Za-z0-9._/-]*) die "公開ディレクトリのパスに使えない文字があります: $1" 64 ;;
    /*/*"$SUFFIX") ;;
    *) die "公開ディレクトリは $SUFFIX で終わる絶対パスにしてください: $1" 64 ;;
  esac
  [ -d "$1" ] || die "公開ディレクトリが見つかりません（サーバーパネルでドメインを追加済みか確認）: $1" 65
}

take_lock() {
  mkdir -p "$BASE"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$BASE/.lock"
    flock -w "$LOCK_WAIT" 9 || die "別のデプロイが実行中です（${LOCK_WAIT} 秒待っても終わりませんでした）" 75
  else
    # no flock: mkdir lock (atomic); a lock older than 30 min is treated as stale
    i=0
    until mkdir "$BASE/.lock.d" 2>/dev/null; do
      if [ -n "$(find "$BASE/.lock.d" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then rmdir "$BASE/.lock.d" 2>/dev/null || true; continue; fi
      i=$((i + 1)); [ "$i" -le "$LOCK_WAIT" ] || die "別のデプロイが実行中です（${LOCK_WAIT} 秒待っても終わりませんでした）" 75
      sleep 1
    done
    trap 'rmdir "$BASE/.lock.d" 2>/dev/null || true' EXIT
  fi
}

# First deploy only: keep what the hosting panel put in the docroot (placeholder page, panel-written .htaccess).
backup_original() {
  d=$1
  [ -e "$BASE/original" ] && return 0
  kb=$(du -sk "$d" 2>/dev/null | cut -f1)
  if [ "${kb:-0}" -gt 512000 ]; then
    say "初回バックアップは省略（$d が 500MB 超）"
    mkdir -p "$BASE/original"
    return 0
  fi
  mkdir -p "$BASE/original"
  cp -a "$d/." "$BASE/original/" 2>/dev/null || cp -R "$d/." "$BASE/original/"
  say "初回バックアップ: $d → $BASE/original"
}

# The rsync exclude list: the built-ins + protect.list (installed from the PC). Invalid lines are skipped.
write_excludes() {
  ex=$1
  printf '%s\n' '/.well-known/' '/_deploy/' > "$ex"
  [ -f "$BASE/protect.list" ] || return 0
  tr -d '\r' < "$BASE/protect.list" | while IFS= read -r p; do
    case "$p" in
      '' | '#'*) continue ;;
      /.well-known/ | /_deploy/) continue ;;
      *..* | *//* | *[!A-Za-z0-9._*?/-]*) say "警告: protect.list の行を無視します: $p"; continue ;;
    esac
    printf '%s\n' "$p" >> "$ex"
  done
}

# Writes an rsync filter file ($4) protecting every path that --delete would remove from $3 but that is NOT part
# of the live release ($2 = its site/ dir). $2 is empty on the very first deploy: then every such path is protected
# (the first deploy only adds and overwrites; it never deletes what was there before).
protect_foreign() {
  src=$1 live=$2 docroot=$3 filter=$4 ex=$5
  : > "$filter"
  rsync -a -n -i --delete --exclude-from="$ex" "$src/" "$docroot/" > "$filter.raw" \
    || { rm -f "$filter.raw"; die "rsync（削除対象の確認）が失敗しました。何も変更していません" 70; }
  sed -n 's/^\*deleting  *//p' "$filter.raw" > "$filter.list"
  rm -f "$filter.raw"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    q=${p%/}
    if [ -z "$live" ] || { [ ! -e "$live/$q" ] && [ ! -L "$live/$q" ]; }; then
      # rsync filter syntax: escape wildcard characters so the rule matches this exact path
      esc=$(printf '%s' "$p" | sed 's/[][*?\\]/\\&/g')
      printf 'P /%s\n' "$esc" >> "$filter"
      if [ -n "$live" ]; then say "  保護（デプロイ以外で置かれたファイルなので残します）: $p"
      else say "  保護（初回のデプロイなので、元からあるファイルは消しません）: $p"; fi
    fi
  done < "$filter.list"
  rm -f "$filter.list"
}

publish() {
  rel=$1 docroot=$2
  [ -f "$RELEASES/$rel/site/index.html" ] || die "リリースが不完全です: $rel" 66
  cur=$(cat "$BASE/current" 2>/dev/null || true)
  live=""
  if [ -n "$cur" ]; then
    [ -d "$RELEASES/$cur/site" ] || die "公開中のリリース $cur が $RELEASES にありません。消してよいファイルを判断できないので止めます（$BASE/current を確認）" 68
    live="$RELEASES/$cur/site"
  fi
  ex="$BASE/.exclude.$$"
  filter="$BASE/.protect.$$"
  write_excludes "$ex"
  protect_foreign "$RELEASES/$rel/site" "$live" "$docroot" "$filter" "$ex"
  rc=0
  out=$(rsync -a --no-times -c -i --delete-delay --delay-updates --chmod=D755,F644 --exclude-from="$ex" \
    --filter=". $filter" "$RELEASES/$rel/site/" "$docroot/") || rc=$?
  rm -f "$filter" "$ex"
  [ "$rc" -eq 0 ] || die "rsync が失敗しました（exit $rc）。--delay-updates のため、公開中のファイルは基本的に変更前のままです" 70
  n=$(printf '%s\n' "$out" | grep -c -v -e '^$' -e '^\.' || true)
  { printf '%s\n' "$out" | grep -v -e '^$' -e '^\.' | head -n 40 | sed 's/^/[server]   /'; } 2>/dev/null || true
  if [ "$n" -gt 40 ]; then say "  …ほか $((n - 40)) 件"; fi
  say "公開ディレクトリを更新: $docroot（変更 $n 件）"
  printf '%s\n' "$rel" > "$BASE/current.tmp.$$"
  mv -f "$BASE/current.tmp.$$" "$BASE/current"
  printf '%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$rel" "${DEPLOY_SOURCE:-local}" "$(head -n 1 "$RELEASES/$rel/REVISION" 2>/dev/null || echo '-')" >> "$BASE/deploy.log" 2>/dev/null || true
  write_live "$rel" "$docroot"
  say "公開中のリリース: $rel"
}

iso_now() { date '+%Y-%m-%dT%H:%M:%S%z' | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'; }

# /_deploy/live.json + meta.json. Every publish (PC, pull, rollback) passes here, after the site swap. Each file goes
# tmp → mv, so readers see the old or the new file, never half of one. Best effort: the site is already live at this
# point, so a failure only warns.
write_live() {
  wl_rel=$1 wl_dir="$2/_deploy" wl_r="$RELEASES/$1"
  wl_commit=$(sed -n 's/.*"commit" *: *"\([0-9a-f]\{40\}\)".*/\1/p' "$wl_r/META.json" 2>/dev/null | head -n 1)
  wl_dirty=false
  if grep -q '"dirty" *: *true' "$wl_r/META.json" 2>/dev/null; then wl_dirty=true; fi
  case "${DEPLOY_SOURCE:-local}" in pull) wl_src=pull ;; rollback) wl_src=rollback ;; *) wl_src=local ;; esac
  if [ "$mode" = rollback ]; then wl_src=rollback; fi
  if ! { mkdir -p "$wl_dir" && chmod 755 "$wl_dir" \
      && printf '{"release":"%s","published_at":"%s","commit":"%s","dirty":%s,"source":"%s"}\n' \
        "$wl_rel" "$(iso_now)" "$wl_commit" "$wl_dirty" "$wl_src" > "$wl_dir/.live.json.$$" \
      && chmod 644 "$wl_dir/.live.json.$$" && mv -f "$wl_dir/.live.json.$$" "$wl_dir/live.json"; } 2>/dev/null; then
    rm -f "$wl_dir/.live.json.$$" 2>/dev/null || true
    say "警告: $wl_dir/live.json を書けませんでした（公開自体は完了しています）"
    return 0
  fi
  # meta.json = the release's META.json when it is one JSON object of at most 8 KB, else {}
  wl_m="$wl_r/META.json"
  if [ -f "$wl_m" ] && [ "$(wc -c < "$wl_m" | tr -d ' ')" -le 8192 ] && [ "$(head -c 1 "$wl_m")" = "{" ]; then
    cp "$wl_m" "$wl_dir/.meta.json.$$" 2>/dev/null || true
  else
    printf '{}\n' > "$wl_dir/.meta.json.$$" 2>/dev/null || true
  fi
  if ! { chmod 644 "$wl_dir/.meta.json.$$" && mv -f "$wl_dir/.meta.json.$$" "$wl_dir/meta.json"; } 2>/dev/null; then
    rm -f "$wl_dir/.meta.json.$$" 2>/dev/null || true
    say "警告: $wl_dir/meta.json を書けませんでした"
  fi
}

prune() {
  keep=$1
  cur=$(cat "$BASE/current" 2>/dev/null || true)
  ls -1 "$RELEASES" | LC_ALL=C sort -r | tail -n +"$((keep + 1))" | while read -r old; do
    if [ -n "$old" ] && [ "$old" != "$cur" ]; then rm -rf "${RELEASES:?}/$old"; fi
  done
  # leftovers of interrupted uploads (older than a day)
  if [ -d "$BASE/incoming" ]; then find "$BASE/incoming" -mindepth 1 -maxdepth 1 -mtime +0 -exec rm -rf {} + 2>/dev/null || true; fi
}

# release id: YYYYmmdd-HHMMSS. When that does not sort after the newest release (same second, or the clock went
# back), the newest id's time with the next -NN suffix: ids always sort in publish order, and an id pruned a moment
# ago is never handed out again.
new_release_id() {
  r=$(date +%Y%m%d-%H%M%S)
  last=$(ls -1 "$RELEASES" 2>/dev/null | LC_ALL=C sort | tail -n 1)
  case "$last" in
    ????????-??????) stamp=$last k=0 ;;
    ????????-??????-*) stamp=${last%-*} k=${last##*-} ;;
    *) printf '%s' "$r"; return ;;
  esac
  if [ "$r" != "$last" ] && [ "$(printf '%s\n%s\n' "$last" "$r" | LC_ALL=C sort | tail -n 1)" = "$r" ]; then
    printf '%s' "$r"
    return
  fi
  printf '%s-%02d' "$stamp" "$(expr "$k" + 1)"
}

# atomic install of one file: install_file <src> <dest> <mode>
install_file() {
  cp "$1" "$2.tmp.$$" && chmod "$3" "$2.tmp.$$" && mv -f "$2.tmp.$$" "$2"
}

# PC deploys only: pull.sh, protect.list, /_deploy/kick.php and /_deploy/.htaccess (before publishing, so the
# publish already uses the new protect list). htaccess.pin is installed after a successful publish (finish_install).
install_server() {
  s="$1/server" docroot=$2
  # $BASE is written into kick.php as a PHP string literal (through sed): no quote, backslash, # or &
  case "$BASE" in *\'* | *\\* | *'#'* | *'&'*) die "サーバー側フォルダのパスに使えない文字があります: $BASE" 64 ;; esac
  for f in pull.sh kick.php deploy.htaccess protect.list htaccess.pin; do
    [ -f "$s/$f" ] || die "アップロード内容が不完全です（server/$f がない）" 66
  done
  install_file "$s/pull.sh" "$BASE/pull.sh" 700
  install_file "$s/protect.list" "$BASE/protect.list" 600
  mkdir -p "$docroot/_deploy"
  chmod 755 "$docroot/_deploy"
  sed "s#__BASE__#$BASE#g" "$s/kick.php" > "$docroot/_deploy/.kick.php.$$"
  chmod 644 "$docroot/_deploy/.kick.php.$$"
  mv -f "$docroot/_deploy/.kick.php.$$" "$docroot/_deploy/kick.php"
  install_file "$s/deploy.htaccess" "$docroot/_deploy/.htaccess" 644
  say "pull.sh・_deploy/kick.php・_deploy/.htaccess・protect.list を設置"
}

mode=${1:-}
if [ "$mode" != list ]; then command -v rsync >/dev/null 2>&1 || die "サーバーに rsync が見つかりません" 69; fi
case "$mode" in
  deploy)
    [ $# -ge 4 ] || die "usage: deploy <upload> <docroot> <keep> [install] [force]" 64
    upload=${2%/} docroot=${3%/} keep=$4
    shift 4
    install="" force=""
    for a in "$@"; do
      case "$a" in install) install=1 ;; force) force=1 ;; *) die "不明な指定: $a" 64 ;; esac
    done
    case "$keep" in '' | *[!0-9]*) die "keep は 2 以上の整数です: $keep" 64 ;; esac
    [ "$keep" -ge 2 ] || die "keep は 2 以上の整数です: $keep" 64
    # only folders made by our own upload / pull (mktemp under incoming/) are moved into releases/
    [ -d "$upload" ] || die "アップロード先がありません: $upload" 66
    upload=$(cd "$upload" && pwd -P)
    case "$upload" in *..* | "$BASE"/incoming/*/*) die "アップロード先が想定外です: $upload" 64 ;; "$BASE"/incoming/[!.]*) ;; *) die "アップロード先が想定外です: $upload" 64 ;; esac
    check_docroot "$docroot"
    [ -f "$upload/site/index.html" ] || die "アップロード内容が不完全です（site/index.html がない）" 66
    take_lock
    # Guard against publishing a broken build that lost most pages (--delete would remove them from the site).
    cur=$(cat "$BASE/current" 2>/dev/null || true)
    if [ -n "$cur" ] && [ -d "$RELEASES/$cur/site" ] && [ -z "$force" ]; then
      old_n=$(find "$RELEASES/$cur/site" -type f -name '*.html' | wc -l)
      new_n=$(find "$upload/site" -type f -name '*.html' | wc -l)
      if [ "$new_n" -lt $(( (old_n + 1) / 2 )) ]; then
        rm -rf "$upload"
        die "ページ数が公開中の半分未満です（$old_n → $new_n）。ビルドの失敗の可能性があるので止めました。意図どおりなら --force" 71
      fi
    fi
    if [ -n "$install" ]; then install_server "$upload" "$docroot"; fi
    mkdir -p "$RELEASES"
    rel=$(new_release_id)
    if [ -n "$install" ]; then
      PIN_TMP="$BASE/htaccess.pin.new.$$"
      mv -f "$upload/server/htaccess.pin" "$PIN_TMP"
      rm -rf "$upload/server"
    fi
    mv "$upload" "$RELEASES/$rel"
    FRESH_REL="$RELEASES/$rel"
    backup_original "$docroot"
    publish "$rel" "$docroot"
    FRESH_REL=""
    if [ -n "$PIN_TMP" ]; then
      chmod 600 "$PIN_TMP"
      mv -f "$PIN_TMP" "$BASE/htaccess.pin"
      PIN_TMP=""
      say ".htaccess の記録を更新（$(grep -c . "$BASE/htaccess.pin" || true) 件）"
    fi
    prune "$keep"
    ;;
  rollback)
    [ $# -ge 2 ] || die "usage: rollback <docroot> [release id]" 64
    docroot=${2%/}
    check_docroot "$docroot"
    target=${3:-}
    case "$target" in *[!0-9-]*) die "リリース ID の形式が違います: $target" 64 ;; esac
    take_lock
    cur=$(cat "$BASE/current" 2>/dev/null || true)
    if [ -z "$target" ]; then
      target=$(ls -1 "$RELEASES" 2>/dev/null | LC_ALL=C sort | awk -v c="$cur" '$0 == c { print prev; exit } { prev = $0 }')
    fi
    [ -n "$target" ] || die "戻せる前のリリースがありません（xpd list で確認）" 67
    [ -d "$RELEASES/$target" ] || die "リリースが見つかりません: $target" 67
    say "切り戻し: ${cur:-（なし）} → $target"
    publish "$target" "$docroot"
    ;;
  list)
    cur=$(cat "$BASE/current" 2>/dev/null || true)
    [ -d "$RELEASES" ] || { say "まだリリースがありません"; exit 0; }
    ls -1 "$RELEASES" | LC_ALL=C sort -r | while read -r r; do
      mark='  '
      [ "$r" = "$cur" ] && mark='* '
      printf '%s%s  %s\n' "$mark" "$r" "$(head -n 1 "$RELEASES/$r/REVISION" 2>/dev/null || echo '-')"
    done
    ;;
  *) die "usage: remote-deploy.sh deploy|rollback|list …" 64 ;;
esac
