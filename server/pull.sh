#!/bin/sh
# server/pull.sh — runs ON the server. Part of xserver-pull-deploy (MIT).
# Installed by a PC deploy (`xpd deploy`) as ~/.deploy/<name>/pull.sh; a bundle from GitHub never carries or
# replaces it.
#
#   pull.sh cron    every minute from the panel's Cron (output discarded; one line per run goes to pull.log)
#   pull.sh kick    started by /_deploy/kick.php right after GitHub Actions pushed a new bundle
#   pull.sh check   configuration test (`xpd setup-pull`): prints what it sees, publishes nothing
#
# The pull model: GitHub Actions builds and leaves bundle.tar.gz + bundle.sha256 + META.json on the deploy branch
# (one orphan commit). This script asks GitHub (conditional requests: an unchanged branch costs a 304) whether that
# branch moved; if so it downloads, verifies the sha256, inspects the bundle (it is NOT trusted: only site/**,
# META.json and REVISION; no links/devices, no "..", nothing executable, the .htaccess set exactly as the last PC
# deploy pinned it) and hands it to the INSTALLED remote-deploy.sh. GitHub never gets a way into this server.
#
# Config: pull.env next to this script (600; written by `xpd setup-pull`):
#   GH_REPO=owner/repo   GH_TOKEN=<fine-grained PAT: Contents Read-only, this repository only>
#   DOCROOT=/home/<id>/example.com/public_html   KEEP=5   NOTIFY_EMAIL=you@example.com (optional)
#   BRANCH=main  DEPLOY_BRANCH=deploy  STATUS_BRANCH=deploy-status  DOCROOT_SUFFIX=/public_html  SITE_NAME=…
#   MAX_FILES=20000  MAX_MB=300  GH_API=https://api.github.com (tests: http://127.0.0.1:<port>)
# State: pull.state/ (ETags, last handled deploy commit, failure count), pull.log (1 MB cap), /_deploy/pull.json.
# A deploy commit that failed 3 times is not retried until a new one arrives.
#
# Exit: 0 nothing to do / published / skipped (already failed 3x) · 1 publish refused or failed · 2 configuration
#       · 3 GitHub unreachable or rate-limited (retried next run) · 75 another pull is running
set -u
umask 022
trap '' HUP PIPE
PATH=/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}
LC_ALL=C
export PATH LC_ALL

MODE=${1:-cron}
case "$MODE" in cron | kick | check) ;; *) printf 'usage: pull.sh cron|kick|check\n' >&2; exit 64 ;; esac

case "$0" in */*) BASE=${0%/*} ;; *) BASE=. ;; esac
BASE=$(cd "$BASE" && pwd -P) || exit 2

ENV_FILE="$BASE/pull.env"
STATE="$BASE/pull.state"
PIN="$BASE/htaccess.pin"
LOG="$BASE/pull.log"
FAILS_MAX=3

RESULT="-"
W=""
U=""
LOCKDIR=""

say() { printf '%s\n' "$*" 2>/dev/null || true; }

cleanup() {
  [ -n "$W" ] && rm -rf "$W"
  [ -n "$U" ] && rm -rf "$U"
  [ -n "$LOCKDIR" ] && rm -rf "$LOCKDIR"
  if [ "$MODE" != check ] && [ -d "$BASE" ]; then
    printf '%s\t%s\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$MODE" "$RESULT" >> "$LOG" 2>/dev/null || true
    if [ "$(wc -c < "$LOG" 2>/dev/null | tr -d ' ')" -gt 1048576 ] 2>/dev/null; then
      tail -n 4000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv -f "$LOG.tmp" "$LOG"
    fi
  fi
}
trap cleanup EXIT
trap 'RESULT="interrupted"; exit 130' INT TERM

# ---------- lock: flock when available, else an atomic mkdir with a pid (stale after the owner died / 30 min) ----------
take_lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 8>>"$BASE/.pull.lock" || exit 2
    flock -n 8 || { RESULT="busy"; exit 75; }
    return 0
  fi
  d="$BASE/.pull.lock.d"
  for _ in 1 2; do
    if mkdir "$d" 2>/dev/null; then
      printf '%s\n' "$$" > "$d/pid"
      LOCKDIR=$d
      return 0
    fi
    pid=$(cat "$d/pid" 2>/dev/null || true)
    if { [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; } || [ -n "$(find "$d" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
      rm -rf "$d"
      continue
    fi
    break
  done
  RESULT="busy"
  exit 75
}

# ---------- config ----------
cfg() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -n 1 | tr -d '\r' \
    | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
matches() { printf '%s\n' "$1" | grep -Eq "$2"; }
conf_fail() { say "pull.env: $1"; RESULT="config: $1"; exit 2; }
BRANCH_ERE='^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'

load_config() {
  [ -f "$ENV_FILE" ] || conf_fail "$ENV_FILE がありません（PC で xpd setup-pull）"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  GH_REPO=$(cfg GH_REPO)
  GH_TOKEN=$(cfg GH_TOKEN)
  DOCROOT=$(cfg DOCROOT)
  KEEP=$(cfg KEEP); KEEP=${KEEP:-5}
  NOTIFY_EMAIL=$(cfg NOTIFY_EMAIL)
  GH_API=$(cfg GH_API); GH_API=${GH_API:-https://api.github.com}
  BRANCH=$(cfg BRANCH); BRANCH=${BRANCH:-main}
  DEPLOY_BRANCH=$(cfg DEPLOY_BRANCH); DEPLOY_BRANCH=${DEPLOY_BRANCH:-deploy}
  STATUS_BRANCH=$(cfg STATUS_BRANCH); STATUS_BRANCH=${STATUS_BRANCH:-deploy-status}
  DOCROOT_SUFFIX=$(cfg DOCROOT_SUFFIX); DOCROOT_SUFFIX=${DOCROOT_SUFFIX:-/public_html}
  SITE_NAME=$(cfg SITE_NAME | tr -cd 'A-Za-z0-9._ -' | cut -c 1-64); SITE_NAME=${SITE_NAME:-website}
  MAX_FILES=$(cfg MAX_FILES); MAX_FILES=${MAX_FILES:-20000}
  MAX_MB=$(cfg MAX_MB); MAX_MB=${MAX_MB:-300}
  matches "$GH_REPO" '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || conf_fail "GH_REPO（owner/repo）"
  matches "$GH_TOKEN" '^[A-Za-z0-9_]{20,255}$' || conf_fail "GH_TOKEN（GitHub のトークン）"
  for b in "$BRANCH" "$DEPLOY_BRANCH" "$STATUS_BRANCH"; do
    matches "$b" "$BRANCH_ERE" && ! matches "$b" '\.\.' || conf_fail "BRANCH / DEPLOY_BRANCH / STATUS_BRANCH（ブランチ名）: $b"
  done
  case "$DOCROOT_SUFFIX" in /*) ;; *) conf_fail "DOCROOT_SUFFIX（/ で始まるパス）" ;; esac
  case "$DOCROOT_SUFFIX" in *..* | *[!A-Za-z0-9._/-]*) conf_fail "DOCROOT_SUFFIX に使えない文字があります" ;; esac
  case "$DOCROOT" in *..* | *[!A-Za-z0-9._/-]*) conf_fail "DOCROOT に使えない文字があります" ;; /*/*"$DOCROOT_SUFFIX") ;; *) conf_fail "DOCROOT（$DOCROOT_SUFFIX で終わる絶対パス）" ;; esac
  [ -d "$DOCROOT" ] || conf_fail "DOCROOT が見つかりません: $DOCROOT"
  { matches "$KEEP" '^[0-9]+$' && [ "$KEEP" -ge 2 ]; } || conf_fail "KEEP（2 以上）"
  { matches "$MAX_FILES" '^[0-9]+$' && [ "$MAX_FILES" -ge 1 ]; } || conf_fail "MAX_FILES"
  { matches "$MAX_MB" '^[0-9]+$' && [ "$MAX_MB" -ge 1 ] && [ "$MAX_MB" -le 4000 ]; } || conf_fail "MAX_MB（1〜4000）"
  MAX_BYTES=$((MAX_MB * 1048576))
  # the largest tar stream those limits allow (the data + a header and padding per entry + slack). It caps the
  # download and the decompression: a gzip bomb is cut off at this size instead of being listed in full.
  MAX_STREAM=$((MAX_BYTES + MAX_FILES * 2048 + 1048576))
  [ -z "$NOTIFY_EMAIL" ] || matches "$NOTIFY_EMAIL" '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+$' || conf_fail "NOTIFY_EMAIL"
  # https only; plain http only for a local test server
  matches "$GH_API" '^(https://[A-Za-z0-9.-]+(:[0-9]+)?|http://(127\.0\.0\.1|localhost)(:[0-9]+)?)(/[A-Za-z0-9._/-]*)?$' || conf_fail "GH_API"
  GH_API=${GH_API%/}
  command -v curl >/dev/null 2>&1 || conf_fail "curl がありません"
  [ -f "$BASE/remote-deploy.sh" ] || conf_fail "$BASE/remote-deploy.sh がありません（PC で xpd deploy を一度実行）"
}

# ---------- GitHub ----------
# gh <cache name|""> <api path> <accept> <out file> → $HTTP. With a cache name the request is conditional
# (If-None-Match) and a 304 restores the cached body. The token goes in through a curl config on stdin, so it never
# appears in the process list.
HTTP=000
TOKEN_EXP=""
RL_LEFT=""
# last value of a response header (case-insensitive name) from the dump of the last request
hv() { tr -d '\r' < "$W/headers" | awk -v k="$1" '{ i = index($0, ":") } i && tolower(substr($0, 1, i - 1)) == k { v = substr($0, i + 1); sub(/^ +/, "", v) } END { print v }'; }
gh() {
  g_name=$1 g_path=$2 g_accept=$3 g_out=$4
  set -- -K - -sS --max-time "${GH_MAXTIME:-60}" --retry "${XPD_GH_RETRY:-2}" --retry-delay 3 -o "$g_out" -D "$W/headers" -w '%{http_code}' \
    -H "Accept: $g_accept" -H 'X-GitHub-Api-Version: 2022-11-28' -H 'User-Agent: xserver-pull-deploy'
  # a size cap (bytes) for downloads: curl stops with exit 63, reported here as HTTP 413
  [ -z "${GH_MAXSIZE:-}" ] || set -- "$@" --max-filesize "$GH_MAXSIZE"
  if [ -n "$g_name" ] && [ -s "$STATE/$g_name.etag" ] && [ -s "$STATE/$g_name.body" ]; then
    set -- "$@" -H "If-None-Match: $(cat "$STATE/$g_name.etag")"
  fi
  : > "$W/headers"
  HTTP=$(printf 'header = "Authorization: Bearer %s"\n' "$GH_TOKEN" | curl "$@" "$GH_API$g_path" 2>"$W/curl.err") \
    || { if [ $? -eq 63 ]; then HTTP=413; rm -f "$g_out"; else HTTP=000; fi; }
  v=$(hv github-authentication-token-expiration | tr -cd '0-9A-Za-z :+-')
  [ -z "$v" ] || TOKEN_EXP=$v
  RL_LEFT=$(hv x-ratelimit-remaining | tr -cd '0-9')
  case "$HTTP" in
    200)
      if [ -n "$g_name" ]; then
        e=$(hv etag | tr -cd 'A-Za-z0-9/"_.:-')
        if [ -n "$e" ]; then printf '%s\n' "$e" > "$STATE/$g_name.etag"; cp "$g_out" "$STATE/$g_name.body"; else rm -f "$STATE/$g_name.etag"; fi
      fi ;;
    304) if [ -n "$g_name" ] && [ -f "$STATE/$g_name.body" ]; then cp "$STATE/$g_name.body" "$g_out"; else HTTP=000; fi ;;
  esac
}
errline() { tr '\r\n' '  ' < "$W/curl.err" 2>/dev/null | cut -c 1-160; }

# Turns a failed API answer into a final state. 401/403/404 on the source branch = a configuration problem.
api_fail() {
  case "$HTTP" in
    401) fail_state "サーバー用トークンが無効か期限切れです。PC で xpd setup-pull を実行して入れ直してください" "http 401"; exit 1 ;;
    403 | 429)
      if [ "$HTTP" = 429 ] || [ "${RL_LEFT:-1}" = 0 ]; then RESULT="rate-limited ($1)"; exit 3; fi
      fail_state "GitHub に拒否されました（トークンの権限は Contents: Read-only、対象はこのリポジトリが必要です）" "http 403"; exit 1 ;;
    404) fail_state "リポジトリが見つからないか、トークンにこのリポジトリの権限がありません（pull.env の GH_REPO とトークンを確認）" "http 404 ($1)"; exit 1 ;;
    413) publish_failed "公開用データが大きすぎます（$1。MAX_MB / MAX_FILES を確認）" "too large ($1)" ;;
    *) RESULT="github unreachable ($1: http $HTTP $(errline))"; exit 3 ;;
  esac
}

# branch_sha <branch> <cache name> → $SHA ("" when the branch does not exist)
branch_sha() {
  gh "$2" "/repos/$GH_REPO/commits/$1" application/vnd.github.sha "$W/sha"
  case "$HTTP" in
    200 | 304) SHA=$(head -n 1 "$W/sha" | tr -d '\r\n')
      matches "$SHA" '^[0-9a-f]{40}$' || { RESULT="bad sha answer ($1)"; exit 3; } ;;
    # 422 is GitHub's answer for a branch that does not exist (yet); 404 is kept for API versions that use it
    404 | 422) SHA=""; rm -f "$STATE/$2.etag" "$STATE/$2.body" ;;
    *) api_fail "$1" ;;
  esac
}

# raw <path> <ref> <out> <max bytes> [max time] — a file of the repository at a commit (Contents API, raw)
raw() {
  GH_MAXSIZE=$4 GH_MAXTIME=${5:-60} gh "" "/repos/$GH_REPO/contents/$1?ref=$2" application/vnd.github.raw+json "$3"
  [ "$HTTP" = 200 ]
}

# ---------- status files ----------
iso_now() { date '+%Y-%m-%dT%H:%M:%S%z' | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'; }

# pull_json <state> <message> — /_deploy/pull.json (tmp → mv). Messages are fixed texts from this file.
DEPLOY_REF=""
DEPLOY_COMMIT=""
MAIN_COMMIT=""
pull_json() {
  [ "$MODE" = check ] && return 0
  b=$(cat "$STATE/build.json" 2>/dev/null || true)
  [ -n "$b" ] || b=null
  exp=$TOKEN_EXP
  if [ -n "$exp" ]; then exp=$(date -d "$exp" '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/' || true); [ -n "$exp" ] || exp=$TOKEN_EXP; fi
  d="$DOCROOT/_deploy"
  { mkdir -p "$d" && chmod 755 "$d" \
    && printf '{"checked_at":"%s","state":"%s","message":"%s","deploy_ref":"%s","deploy_commit":"%s","main_commit":"%s","build":%s,"token_expires_at":"%s"}\n' \
      "$(iso_now)" "$1" "$2" "$DEPLOY_REF" "$DEPLOY_COMMIT" "$MAIN_COMMIT" "$b" "$exp" > "$d/.pull.json.$$" \
    && chmod 644 "$d/.pull.json.$$" && mv -f "$d/.pull.json.$$" "$d/pull.json"; } 2>/dev/null \
    || rm -f "$d/.pull.json.$$" 2>/dev/null
  return 0
}
fail_state() { pull_json error "$1"; RESULT="error: ${2:-$1}"; }

# ---------- failure bookkeeping (per deploy commit) ----------
fail_count() {
  f_ref="" f_n=0
  [ -f "$STATE/fail" ] && read -r f_ref f_n < "$STATE/fail"
  if [ "$f_ref" = "$DEPLOY_REF" ] && matches "$f_n" '^[0-9]+$'; then printf '%s' "$f_n"; else printf 0; fi
}

notify() {
  [ -n "$NOTIFY_EMAIL" ] || return 0
  sm=$(command -v sendmail 2>/dev/null || true)
  [ -n "$sm" ] || { [ -x /usr/sbin/sendmail ] && sm=/usr/sbin/sendmail; } || return 0
  subj="[$SITE_NAME] site publish failed"
  if command -v base64 >/dev/null 2>&1; then subj="=?UTF-8?B?$(printf '【%s】サイトの公開に失敗しました' "$SITE_NAME" | base64 | tr -d '\n')?="; fi
  printf 'To: %s\nSubject: %s\nMIME-Version: 1.0\nContent-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: 8bit\n\n%s\n\n%s\n%s\n' \
    "$NOTIFY_EMAIL" "$subj" "$1" "公開しようとしたコミット: ${DEPLOY_COMMIT:-$DEPLOY_REF}" \
    "サイトは前の状態のままです。/_deploy/pull.json、またはサーバーの $LOG を確認してください。" \
    | "$sm" -t -i >/dev/null 2>&1 || true
}

# publish_failed <message> <log detail> — count it, mail on the first failure, write the state; exit 1
publish_failed() {
  n=$(( $(fail_count) + 1 ))
  printf '%s %s\n' "$DEPLOY_REF" "$n" > "$STATE/fail"
  printf '%s\n' "$1" > "$STATE/fail.msg"
  [ "$n" -eq 1 ] && notify "$1"
  if [ "$n" -ge "$FAILS_MAX" ]; then m="$1（${FAILS_MAX} 回失敗したので、次の公開まで止めています）"; else m="$1（自動でやり直します ${n}/${FAILS_MAX}）"; fi
  fail_state "$m" "$2 [$n/$FAILS_MAX]"
  exit 1
}

# ---------- bundle inspection ----------
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -c 1-64
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 < "$1" | cut -c 1-64
  else openssl dgst -sha256 -r < "$1" | cut -c 1-64; fi
}

# inspect <bundle> <empty dir> — extracts into the dir only if the listing is clean; then re-checks what landed.
# Sets REASON / DETAIL and returns 1 on refusal.
REFUSED="中身の検査で止めました"
inspect() {
  t=$1 x=$2
  # the decompressed size first, reading at most MAX_STREAM + 1 bytes (a gzip bomb is cut off, never unpacked)
  z=$(gzip -dc < "$t" 2>/dev/null | head -c "$((MAX_STREAM + 1))" | wc -c | tr -d ' ')
  if [ "${z:-0}" -gt "$MAX_STREAM" ]; then
    REASON="$REFUSED（ファイルが大きすぎます）"; DETAIL="stream over $MAX_STREAM bytes"; return 1
  fi
  # --numeric-owner: owner names come from the archive and could contain spaces that shift the size column
  if ! tar -tzf "$t" > "$W/names" 2>/dev/null || ! tar --numeric-owner -tvzf "$t" > "$W/long" 2>/dev/null; then
    REASON="まとめファイルを展開できません。もう一度公開してください"; DETAIL="tar list failed"; return 1
  fi
  n=$(wc -l < "$W/names" | tr -d ' ')
  if [ "$n" -ne "$(wc -l < "$W/long" | tr -d ' ')" ] || [ "$n" -gt "$MAX_FILES" ]; then
    REASON="$REFUSED（ファイルが多すぎるか、名前が不正です）"; DETAIL="entries $n"; return 1
  fi
  if cut -c 1 "$W/long" | grep -qv '^[-d]$'; then
    REASON="$REFUSED（リンクや特殊なファイルが含まれています）"; DETAIL="non-regular entry: $(grep -v '^[-d]' "$W/long" | head -n 1 | cut -c 1-120)"; return 1
  fi
  # names: only site/**, META.json, REVISION; no "." / ".." segments, no control characters or backslashes
  bad=$(grep -Ev '^(site/.*|META\.json|REVISION)$' "$W/names" | head -n 1)
  [ -n "$bad" ] || bad=$(grep -E '(^|/)\.{1,2}(/|$)|^site/_deploy(/|$)|[[:cntrl:]\\]' "$W/names" | head -n 1)
  if [ -n "$bad" ]; then
    REASON="$REFUSED（想定外の場所のファイルが含まれています）"; DETAIL="path: $(printf '%s' "$bad" | tr -d '[:cntrl:]' | cut -c 1-120)"; return 1
  fi
  # nothing the web server could execute or read as configuration (.htaccess is checked against the pin below)
  # PHP-family extensions anywhere in a name (x.php.jpg: Apache's AddHandler matches every extension, not only the
  # last one); CGI-style ones as the last extension (those also need an exec bit, which a deploy never sets)
  bad=$(grep -Ei '\.(php[0-9]*|phtml|pht|phps|phar|shtml)(\.[^/]*)?/?$|\.(cgi|fcgi|pl|py|rb|sh)/?$|(^|/)(\.user\.ini|php\.ini|\.ht[^/]*)/?$' "$W/names" \
    | grep -Ev '(^|/)\.htaccess$' | head -n 1)
  if [ -n "$bad" ]; then
    REASON="$REFUSED（実行できる種類のファイル（.php など）や設定ファイルが含まれています）"; DETAIL="file: $(printf '%s' "$bad" | cut -c 1-120)"; return 1
  fi
  bytes=$(awk '{ s += $3 } END { printf "%.0f\n", s }' "$W/long")
  if [ "$bytes" -gt "$MAX_BYTES" ]; then
    REASON="$REFUSED（ファイルが大きすぎます）"; DETAIL="unpacked $bytes bytes"; return 1
  fi
  if ! tar -xzf "$t" -C "$x" --no-same-owner --no-same-permissions 2>"$W/tar.err"; then
    REASON="まとめファイルを展開できません。もう一度公開してください"; DETAIL="extract: $(head -n 1 "$W/tar.err")"; return 1
  fi
  # what actually landed (belt and braces: the listing could lie about a member)
  odd=$(find "$x" ! -type f ! -type d 2>/dev/null | head -n 1)
  [ -z "$odd" ] || { REASON="$REFUSED（リンクや特殊なファイルが含まれています）"; DETAIL="landed: ${odd#"$x"/}"; return 1; }
  odd=$(find "$x" -type f -links +1 2>/dev/null | head -n 1)
  [ -z "$odd" ] || { REASON="$REFUSED（リンクや特殊なファイルが含まれています）"; DETAIL="hard link: ${odd#"$x"/}"; return 1; }
  [ -f "$x/site/index.html" ] && [ -f "$x/META.json" ] \
    || { REASON="$REFUSED（site/index.html か META.json がありません）"; DETAIL="incomplete"; return 1; }
  # .htaccess set == what the last PC deploy pinned (path + sha256), so server config only ever changes from the PC
  [ -f "$PIN" ] || { REASON="$REFUSED（PC からの公開がまだ一度もありません。先に PC で xpd deploy を実行してください）"; DETAIL="no htaccess.pin"; return 1; }
  ( cd "$x" && find site -type f -name .htaccess | sort | while IFS= read -r f; do printf '%s %s\n' "$f" "$(sha256 "$f")"; done ) > "$W/pin.new"
  tr -d '\r' < "$PIN" | sed '/^$/d' | sort > "$W/pin.old"
  if ! cmp -s "$W/pin.old" "$W/pin.new"; then
    REASON="$REFUSED（.htaccess が変わっています。PC から公開してください）"
    DETAIL="htaccess: $(diff "$W/pin.old" "$W/pin.new" 2>/dev/null | grep '^[<>]' | head -n 1 | cut -c 1-90)"
    return 1
  fi
  return 0
}

short() { printf '%s' "$1" | cut -c 1-12; }

# ---------- main ----------
mkdir -p "$BASE/incoming" "$STATE" || exit 2
take_lock
load_config
W=$(mktemp -d "$BASE/incoming/w.XXXXXX") || exit 2

if [ "$MODE" = check ]; then
  say "pull.sh check — $GH_REPO → $DOCROOT"
  say "  curl: $(curl --version | head -n 1 | cut -d ' ' -f 1-2) · lock: $(command -v flock >/dev/null 2>&1 && echo flock || echo mkdir)"
  for br in "$BRANCH" "$DEPLOY_BRANCH" "$STATUS_BRANCH"; do
    gh "" "/repos/$GH_REPO/commits/$br" application/vnd.github.sha "$W/sha"
    case "$HTTP" in
      200) say "  $br: $(cut -c 1-12 "$W/sha")" ;;
      404 | 422) [ "$br" = "$BRANCH" ] && { say "  $br: 見つかりません（リポジトリ名・ブランチ名とトークンの対象を確認）"; exit 1; }; say "  $br: まだありません（GitHub Actions の初回実行で作られます）" ;;
      401) say "  トークンが無効か期限切れです"; exit 1 ;;
      403) say "  GitHub に拒否されました（トークンの権限: Contents Read-only・このリポジトリ）"; exit 1 ;;
      *) say "  $br: HTTP $HTTP $(errline)"; exit 3 ;;
    esac
  done
  say "  token expires: ${TOKEN_EXP:-（期限なし／不明）}"
  say "  htaccess.pin: $([ -f "$PIN" ] && echo ok || echo 'なし（PC から xpd deploy を一度実行）')"
  say "OK"
  exit 0
fi

# 1. build status (status branch → status.json, copied into pull.json.build)
branch_sha "$STATUS_BRANCH" branch-status
if [ -z "$SHA" ]; then
  rm -f "$STATE/build.json"
elif [ "$HTTP" = 200 ] || [ ! -f "$STATE/build.json" ]; then
  if raw status.json "$SHA" "$W/status.json" 4096 && [ "$(wc -c < "$W/status.json" | tr -d ' ')" -le 4096 ]; then
    # rebuilt field by field from known keys and safe characters (the branch is writable by anyone with repo access)
    tr -d '\r\n' < "$W/status.json" > "$W/st.one"
    sfield() { sed -n "s/.*\"$1\" *: *\"\([^\"]*\)\".*/\1/p" "$W/st.one" | head -n 1 | tr -d '\\[:cntrl:]' | cut -c "1-$2"; }
    s_state=$(sfield state 16)
    case "$s_state" in building | success | failed) ;; *) s_state=unknown ;; esac
    s_commit=$(sfield commit 40)
    matches "$s_commit" '^[0-9a-f]{40}$' || s_commit=""
    s_url=$(sfield run_url 200)
    matches "$s_url" '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+(/attempts/[0-9]+)?$' || s_url=""
    s_at=$(sfield at 40 | tr -cd '0-9T:+.Z-')
    s_msg=$(sfield message 900 | tr -d '<>')
    printf '{"state":"%s","commit":"%s","run_url":"%s","message":"%s","at":"%s"}' \
      "$s_state" "$s_commit" "$s_url" "$s_msg" "$s_at" > "$STATE/build.json"
  else
    rm -f "$STATE/branch-status.etag"   # keep the last known status; retry next run
  fi
fi

# 2. source branch (what "unpublished changes" is measured against)
branch_sha "$BRANCH" branch-main
[ -n "$SHA" ] || { HTTP=404; api_fail "$BRANCH"; }
MAIN_COMMIT=$SHA

# 3. deploy branch
branch_sha "$DEPLOY_BRANCH" branch-deploy
DEPLOY_REF=$SHA
if [ -z "$DEPLOY_REF" ]; then
  pull_json idle "公開用のデータがまだありません（GitHub Actions の初回の実行を待っています）"
  RESULT="no deploy branch"; exit 0
fi
DEPLOY_COMMIT=$(cat "$STATE/deploy.commit" 2>/dev/null || true)
if [ "$DEPLOY_REF" = "$(cat "$STATE/done" 2>/dev/null || true)" ]; then
  pull_json idle ""
  RESULT="up to date $(short "$DEPLOY_REF")"; exit 0
fi
if [ "$(fail_count)" -ge "$FAILS_MAX" ]; then
  fail_state "$(cat "$STATE/fail.msg" 2>/dev/null)（${FAILS_MAX} 回失敗したので、次の公開まで止めています）" "stopped"
  RESULT="stopped $(short "$DEPLOY_REF") (failed $FAILS_MAX times)"; exit 0
fi

# 4. a new deploy commit: META.json first (it says whether this is a publish or a rollback)
DEPLOY_COMMIT=""
raw META.json "$DEPLOY_REF" "$W/META.json" 65536 || { [ "$HTTP" = 404 ] && publish_failed "公開用データの記録（META.json）がありません" "no META.json"; api_fail META.json; }
tr -d '\r\n' < "$W/META.json" > "$W/meta.one"
{ [ "$(wc -c < "$W/meta.one" | tr -d ' ')" -le 8192 ] && grep -q '^{.*}$' "$W/meta.one"; } || publish_failed "公開用データの記録（META.json）が不正です" "bad META.json"
jstr() { sed -n "s/.*\"$1\" *: *\"\([^\"]*\)\".*/\1/p" "$W/meta.one" | head -n 1; }
action=$(jstr action)
DEPLOY_COMMIT=$(jstr commit)
matches "$DEPLOY_COMMIT" '^[0-9a-f]{40}$' || DEPLOY_COMMIT=""
printf '%s\n' "$DEPLOY_COMMIT" > "$STATE/deploy.commit"
pull_json deploying "公開しています…"

if [ "$action" = rollback ]; then
  release=$(jstr release)
  case "$release" in previous | "") release="" ;; *[!0-9-]*) publish_failed "切り戻し先の指定が不正です（previous またはリリース ID）" "bad release" ;; esac
  rc=0
  DEPLOY_SOURCE=rollback XPD_DOCROOT_SUFFIX="$DOCROOT_SUFFIX" sh "$BASE/remote-deploy.sh" rollback "$DOCROOT" ${release:+"$release"} > "$W/deploy.out" 2>&1 || rc=$?
else
  [ -n "$DEPLOY_COMMIT" ] || publish_failed "公開用データの記録（META.json）にコミットがありません" "META.json without commit"
  # 5. bundle + checksum
  raw bundle.sha256 "$DEPLOY_REF" "$W/bundle.sha256" 4096 || { [ "$HTTP" = 404 ] && publish_failed "まとめファイルの sha256 がありません" "no bundle.sha256"; api_fail bundle.sha256; }
  raw bundle.tar.gz "$DEPLOY_REF" "$W/bundle.tar.gz" "$MAX_STREAM" 300 || { [ "$HTTP" = 404 ] && publish_failed "まとめファイルがありません" "no bundle.tar.gz"; api_fail bundle.tar.gz; }
  want=$(head -n 1 "$W/bundle.sha256" | cut -c 1-64)
  { matches "$want" '^[0-9a-f]{64}$' && [ "$want" = "$(sha256 "$W/bundle.tar.gz")" ]; } \
    || publish_failed "まとめファイルが壊れています（sha256 が一致しません）。もう一度公開してください" "sha256 mismatch"
  # 6. inspect + unpack
  U=$(mktemp -d "$BASE/incoming/p.XXXXXX") || exit 2
  inspect "$W/bundle.tar.gz" "$U" || publish_failed "$REASON" "$DETAIL"
  inner=$(sed -n 's/.*"commit" *: *"\([0-9a-f]\{40\}\)".*/\1/p' "$U/META.json" | head -n 1)
  [ "$inner" = "$DEPLOY_COMMIT" ] || publish_failed "公開用データの記録（META.json）がまとめファイルの中身と一致しません" "META commit mismatch"
  force=""
  grep -q '"force" *: *true' "$U/META.json" && force=force
  # 7. publish with the INSTALLED remote-deploy.sh (it moves $U into releases/)
  rc=0
  DEPLOY_SOURCE=pull XPD_DOCROOT_SUFFIX="$DOCROOT_SUFFIX" sh "$BASE/remote-deploy.sh" deploy "$U" "$DOCROOT" "$KEEP" ${force:+"$force"} > "$W/deploy.out" 2>&1 || rc=$?
  [ -d "$U" ] || U=""
fi
[ "$MODE" = kick ] || [ ! -t 1 ] || cat "$W/deploy.out"

# 8. record
case "$rc" in
  0)
    printf '%s\n' "$DEPLOY_REF" > "$STATE/done"
    rm -f "$STATE/fail" "$STATE/fail.msg"
    pull_json idle ""
    RESULT="published $(short "$DEPLOY_REF") ${action:-deploy} commit=${DEPLOY_COMMIT:-"-"} $(grep -o 'リリース: [0-9-]*' "$W/deploy.out" | tail -n 1)"
    exit 0 ;;
  75) pull_json deploying "別の公開が実行中です。終わりしだい続けます"; RESULT="remote-deploy busy"; exit 75 ;;
  71) publish_failed "ページ数が公開中の半分未満なので止めました（意図どおりなら GitHub の Run workflow で force に✓）" "page-count guard" ;;
  67) publish_failed "切り戻し先のリリースが見つかりません（xpd list で確認）" "rollback target missing" ;;
  *) publish_failed "サーバーでの公開処理に失敗しました（コード $rc。サーバーの deploy.log を確認）" "remote-deploy exit $rc: $(grep 'ERROR' "$W/deploy.out" | head -n 1 | cut -c 1-160)" ;;
esac
