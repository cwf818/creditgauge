#!/usr/bin/env bash
# statusLine wrapper for creditgauge (CreditGauge).
#
# 1. Caches stdin to a temp file so both the optional upstream statusline
#    and our bundled dist/index.js can read it. Without this, whichever
#    runs first drains the pipe and the other sees EOF.
# 2. Optionally runs an arbitrary "upstream" statusline command, captured in
#    the CREDITGAUGE_UPSTREAM env var. The command string is taken from
#    $CREDITGAUGE_UPSTREAM_CMD. If unset, CREDITGAUGE_UPSTREAM is empty and
#    this plugin becomes the sole statusline.
# 3. Execs our bundled dist/index.js, forwarding the cached stdin.
#
# Used as the body of `statusLine.command` in ~/.claude/settings.json.
#
# Portable: works on Linux, macOS, and Git Bash on Windows.

set -u

# Resolve node: prefer what's already on PATH, fall back to common locations.
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  for candidate in "/c/Program Files/nodejs/node" "/usr/local/bin/node" "/usr/bin/node"; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "creditgauge: node not found on PATH" >&2
  exit 0
fi

CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SELF_CACHE_GLOB="${CLAUDE_ROOT}/plugins/cache/creditgauge/creditgauge/*/"

# Pick the highest-version installed creditgauge (ourselves).
SELF_DIR=$(ls -d $SELF_CACHE_GLOB 2>/dev/null \
  | awk -F/ '{ print $(NF-1) "\t" $(0) }' \
  | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n \
  | tail -1 | cut -f2-)

# Cache stdin to a temp file. Both the optional upstream statusline and
# our bundled dist/index.js want to read the same JSON; without teeing,
# whichever runs first drains the pipe and the other sees EOF (we hit
# this when upstream was claude-hud — its readStdin() finished, our
# node readStdin() got 0 bytes). mktemp's behavior varies across
# platforms (macOS needs -t, some BSDs ignore args), so fall back to
# a pid-suffixed path under TMPDIR or /tmp. The trap covers normal exit
# plus the usual termination signals so the file doesn't accumulate.
TMP_STDIN="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/creditgauge-stdin.$$")"
trap 'rm -f "$TMP_STDIN"' EXIT INT TERM HUP
cat > "$TMP_STDIN"

# Run the optional upstream statusline, if the user has set CREDITGAUGE_UPSTREAM_CMD.
# install.sh writes this as the absolute path to
# <claude-root>/plugins/creditgauge/state/upstream-cmd.sh
# (a bash script with a shebang and an `exec bash -c '...'` line for the original
# statusLine command). The path is STABLE — sibling of config.json, survives
# cache wipes and version rolls. We run it as a script, NOT pass it to `bash -c` —
# that would attempt to execute the path as a command line and fail silently.
# stdout -> CREDITGAUGE_UPSTREAM. stdin <- cached tmpfile. Failure / unset /
# empty -> CREDITGAUGE_UPSTREAM="".
UPSTREAM_OUT=""
if [ -n "${CREDITGAUGE_UPSTREAM_CMD:-}" ] && [ -f "$CREDITGAUGE_UPSTREAM_CMD" ]; then
  UPSTREAM_OUT=$(bash "$CREDITGAUGE_UPSTREAM_CMD" < "$TMP_STDIN" 2>/dev/null || true)
fi

if [ -z "$SELF_DIR" ] || [ ! -f "${SELF_DIR}dist/index.js" ]; then
  # No creditgauge plugin installed — fall back to whatever upstream gave us.
  printf '%s' "$UPSTREAM_OUT"
  exit 0
fi

# Forward cached stdin (session JSON) to our entry, with upstream output
# as env var. Both reads of stdin now see the same content.
CREDITGAUGE_UPSTREAM="$UPSTREAM_OUT" "$NODE_BIN" "${SELF_DIR}dist/index.js" < "$TMP_STDIN"