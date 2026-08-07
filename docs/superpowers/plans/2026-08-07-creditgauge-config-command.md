# /creditgauge:config 命令实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/creditgauge:config` slash 命令，支持切换 `statuslineTemplate` preset、禁用/启用 upstream 链、以及只读查看当前配置。

**Architecture:** Pattern B2 slash 命令（`commands/config.md` + ` ```! ` fenced block + `allowed-tools` 指向 `scripts/config.sh:*`）。`config.sh`（bash 入口）负责参数解析、路径解析、upstream 文件重命名操作和无参状态视图；JSON 读改写委托给 Node 助手 `scripts/lib/edit-config.mjs`（镜像 `edit-settings.mjs` 的读-改-写 + 行尾保留模式）。upstream 开关采用 **state 目录文件重命名**（`state/upstream-cmd.sh` ↔ `.disabled`），零运行时改动。

**Tech Stack:** bash（Git Bash 可移植）、Node.js（`scripts/lib/edit-config.mjs`）、`node:test` 无关（shell 测试用 `scripts/test-config.sh` 隔离 tmpdir）。

## Global Constraints

- 合法 preset 名（硬编码在 `config.sh`，注释要求与 `src/config.template.ts` 的 `DEFAULT_STATUSLINE_PRESETS` key 同步）：
  `simple` / `compact` / `standard` / `abundant` / `standard-slim`。
- `statuslineTemplate` 写成 **字符串形式**（preset 名），不是数组。
- config.json 路径恒为 `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/creditgauge/config.json`（无 `--project` 变体）。
- upstream 开关 = `state/upstream-cmd.sh` ↔ `state/upstream-cmd.sh.disabled` 重命名（wrapper 的 `[ -f "$CREDITGAUGE_UPSTREAM_CMD" ]` 天然以文件存在性为开关）。不碰 settings.json。
- `set-preset` 读-改-写时**保留其他所有字段**，并保留原文件行尾（CRLF/LF）。
- 坏 JSON 的 config.json：`set-preset` 报错退出（非零）、**不覆盖原文件**。
- 脚本本地运行、无网络、绝不打印 `ANTHROPIC_AUTH_TOKEN`。
- `--dry-run` 打印将做的操作、零改动；一次调用可组合多个动作；未知 flag → 退出码 2 + 用法。
- 版本号**不 bump**（按 [[plugin-json-version-sync]]，只有显式要求才 bump）。新命令在 repo 内完成并测试；发布走 full mirror 流程需另行显式要求。

## 文件结构

| 文件 | 责任 |
|---|---|
| `scripts/lib/edit-config.mjs` | Node 助手：`set-preset` 读-改-写 config.json（保留其他字段 + 行尾）。**新建** |
| `scripts/config.sh` | bash 入口：参数解析、路径解析、upstream 重命名、无参状态视图、调 node 助手。**新建** |
| `scripts/test-config.sh` | 隔离 tmpdir 回归测试（镜像 `test-install.sh` 的 assert 风格）。**新建** |
| `commands/config.md` | Pattern B2 slash 命令。**新建** |
| `.claude-plugin/plugin.json` | `commands` 数组加 `./commands/config.md`。**修改** |
| `scripts/uninstall.sh` | `ALWAYS_STATE_FILES` 加 `upstream-cmd.sh.disabled`。**修改**（~line 360） |
| `CLAUDE.md` / `README.md` | 文档列出新命令。**修改** |

---

### Task 1: `scripts/lib/edit-config.mjs`（Node 助手）

**Files:**
- Create: `scripts/lib/edit-config.mjs`

**Interfaces:**
- Consumes: 无（独立）。
- Produces: CLI `node scripts/lib/edit-config.mjs <config-file> <op> [args]`，op=`set-preset`。
  - `set-preset <config-file> <name>`：读-改-写，设置 `statuslineTemplate: "<name>"`，保留其他字段与行尾。成功 → stdout `set statuslineTemplate: <name>`（若原值是数组，追加 `(replaced custom template with N tokens)`）。失败（坏 JSON / 根非对象 / 缺 name）→ stderr + 非零退出，文件不动。config.json 不存在 → 新建 `{"statuslineTemplate": "<name>"}`。

- [ ] **Step 1: 创建 `scripts/lib/edit-config.mjs`**

```javascript
#!/usr/bin/env node
// edit-config.mjs — small helper for scripts/config.sh to read & write
// creditgauge's config.json (CLAUDE_CONFIG_DIR/plugins/creditgauge/config.json).
//
// Usage:
//   node scripts/lib/edit-config.mjs <config-file> <op> [args]
//
// Operations:
//   set-preset <config-file> <name>
//       Read-modify-write: sets `statuslineTemplate` to "<name>" (string form,
//       a preset name). Creates the file if absent; preserves all other keys
//       and the original line ending (CRLF/LF). Bad JSON → stderr + exit 1,
//       file left untouched.
//
// Targets must be absolute, native-OS paths (use `cygpath -w` on Git Bash).

import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";

// v1 — set-preset CREATE-IF-ABSENT (fix 2026-08-07): config.json may not
// exist yet (fresh install). The loader fills defaults for missing fields,
// so an absent file seeds as an empty object instead of erroring. Only a
// real parse failure of an EXISTING file exits 1 with the file untouched.

const [, , target, op, ...rest] = process.argv;

if (!target || !op) {
  console.error("edit-config.mjs: missing target or op");
  process.exit(2);
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  const text = JSON.stringify(obj, null, 2) + "\n";
  // Preserve the original line ending: detect CRLF vs LF from a sample byte.
  let eol = "\n";
  try {
    const size = statSync(p).size;
    const head = Buffer.alloc(Math.min(64, size));
    const fd = openSync(p, "r");
    readSync(fd, head, 0, head.length, 0);
    closeSync(fd);
    if (head.includes(0x0d)) eol = "\r\n";
  } catch {
    /* target may be new; default to LF */
  }
  const body = text.replace(/\n/g, eol);
  writeFileSync(p, body);
}

switch (op) {
  case "set-preset": {
    const [name] = rest;
    if (!name) {
      console.error("edit-config.mjs: set-preset requires a preset name");
      process.exit(2);
    }
    let data;
    if (!existsSync(target)) {
      // config.json absent → create it fresh (the loader fills defaults).
      data = {};
    } else {
      try {
        data = readJson(target);
      } catch (e) {
        console.error(`edit-config.mjs: cannot read config (${e.message}); leaving file untouched`);
        process.exit(1);
      }
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      console.error("edit-config.mjs: config.json root must be an object; leaving file untouched");
      process.exit(1);
    }
    const prev = data.statuslineTemplate;
    data.statuslineTemplate = name;
    writeJson(target, data);
    if (Array.isArray(prev)) {
      console.log(`set statuslineTemplate: ${name} (replaced custom template with ${prev.length} tokens)`);
    } else {
      console.log(`set statuslineTemplate: ${name}`);
    }
    break;
  }

  default:
    console.error(`edit-config.mjs: unknown op '${op}'`);
    process.exit(2);
}
```

- [ ] **Step 2: 手动验证（fixture）**

Run:
```bash
TMP=$(mktemp -d -t cg-editcfg-XXXXXX)
printf '{\n  "modeLabels": { "used": "Usage:" },\n  "statuslineTemplate": ["m_version"],\n  "cacheTtlMs": 60000\n}\n' > "$TMP/config.json"
node scripts/lib/edit-config.mjs "$TMP/config.json" set-preset standard
cat "$TMP/config.json"
```
Expected: stdout 含 `set statuslineTemplate: standard (replaced custom template with 1 tokens)`；文件保留 `modeLabels`、`cacheTtlMs`，`statuslineTemplate` 变为 `"standard"`。

Run:
```bash
printf '{ nope\n' > "$TMP/config.json"
node scripts/lib/edit-config.mjs "$TMP/config.json" set-preset standard; echo "rc=$?"
```
Expected: stderr 含 `cannot read config`，`rc=1`，文件内容未变。

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/edit-config.mjs
git commit -m "feat(config): add edit-config.mjs node helper for statuslineTemplate writes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `scripts/config.sh`（bash 入口）

**Files:**
- Create: `scripts/config.sh`

**Interfaces:**
- Consumes: `scripts/lib/edit-config.mjs`（Task 1）的 `set-preset` CLI。
- Produces: CLI（被 `commands/config.md` 的 ` ```! ` 块以 `"${CLAUDE_PLUGIN_ROOT}/scripts/config.sh" $ARGUMENTS` 调用）：
  - 无参数 → 打印状态视图（`当前配置:` + 两行），随后一行用法。
  - `--preset-<name>` → 校验 name ∈ 合法 preset；通过 → 调 node 助手写；未知 → stderr + 退出码 1。
  - `--disable-upstream` → 重命名 `upstream-cmd.sh` → `.disabled`（含 no-op / both-exist 错误）。
  - `--enable-upstream` → 重命名 `.disabled` → `upstream-cmd.sh`（含 no-op / both-exist 错误）。
  - `--dry-run` → 只打印 `would <动作>` 行，零改动。
  - `--help|-h` → 打印 usage。未知参数 → stderr + 退出码 2。
  - 退出码：成功/no-op=0，错误=1（未知 flag 是 2）。

- [ ] **Step 1: 创建 `scripts/config.sh`**

```bash
#!/usr/bin/env bash
# config.sh — read/modify creditgauge's runtime config via the
# /creditgauge:config slash command.
#
# Usage:
#   config.sh                        # print current status (read-only)
#   config.sh --preset-<name>        # set statuslineTemplate to a preset name
#   config.sh --disable-upstream     # disable the upstream chain (rename state/upstream-cmd.sh -> .disabled)
#   config.sh --enable-upstream      # re-enable it (rename back)
#   config.sh --dry-run [...]        # print actions, change nothing
#   config.sh --help|-h
#
# Multiple action flags may be combined in one invocation; --dry-run is a
# modifier. The upstream toggle works by renaming the file in the STABLE
# state dir: wrapper.sh only runs the upstream when state/upstream-cmd.sh
# exists ([ -f "$CREDITGAUGE_UPSTREAM_CMD" ]), so a rename flips the switch
# without touching settings.json.
#
# Valid presets (MUST stay in sync with DEFAULT_STATUSLINE_PRESETS keys in
# src/config.template.ts): simple, compact, standard, abundant, standard-slim.

set -u

DRY_RUN=0
ACTION_PRESET=""
ACTION_DISABLE=0
ACTION_ENABLE=0
HELP=0
VALID_PRESETS="simple compact standard abundant standard-slim"

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --disable-upstream) ACTION_DISABLE=1 ;;
    --enable-upstream) ACTION_ENABLE=1 ;;
    --preset-*)
      ACTION_PRESET="${arg#--preset-}"
      if [ -z "$ACTION_PRESET" ]; then
        echo "config.sh: --preset- requires a preset name" >&2
        echo "usage: /creditgauge:config [--preset-<name>] [--disable-upstream] [--enable-upstream] [--dry-run]" >&2
        exit 2
      fi
      ;;
    --help|-h) HELP=1 ;;
    *)
      echo "config.sh: unknown argument: $arg" >&2
      echo "usage: /creditgauge:config [--preset-<name>] [--disable-upstream] [--enable-upstream] [--dry-run]" >&2
      exit 2
      ;;
  esac
done

# Convert a POSIX-style path to the format Node.js prefers on this OS.
# On native Linux/macOS this is a no-op. On Git Bash it converts
# /c/Users/... -> C:\Users\... so Node doesn't read the path relative to cwd.
winpath() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$p" 2>/dev/null || echo "$p"
  else
    echo "$p"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER="${SCRIPT_DIR}/lib/edit-config.mjs"
if [ ! -f "$HELPER" ]; then
  echo "config.sh: missing helper ${HELPER}" >&2
  exit 1
fi

CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CONFIG_FILE="${CLAUDE_ROOT}/plugins/creditgauge/config.json"
STATE_DIR="${CLAUDE_ROOT}/plugins/creditgauge/state"
UPSTREAM_CMD="${STATE_DIR}/upstream-cmd.sh"
UPSTREAM_DISABLED="${STATE_DIR}/upstream-cmd.sh.disabled"
WIN_CONFIG_FILE="$(winpath "$CONFIG_FILE")"

# Classify the current statuslineTemplate into a human line. Mirrors the
# loader's own resolution: string = preset name, array = custom template.
template_status_line() {
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const presets = process.argv[2].split(" ");
    if (!fs.existsSync(p)) {
      console.log("standard-slim   (default preset — no config.json)");
      process.exit(0);
    }
    let d;
    try { d = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) { console.error("config.sh: config.json not valid JSON: " + e.message); process.exit(1); }
    const t = d && typeof d === "object" ? d.statuslineTemplate : undefined;
    if (typeof t === "string") {
      if (presets.includes(t)) console.log(t + "   (preset)");
      else console.log(t + "   (unknown preset; valid: " + presets.join(" ") + ")");
    } else if (Array.isArray(t)) {
      console.log("(custom template, " + t.length + " tokens)");
    } else {
      console.log("(no statuslineTemplate — default preset)");
    }
  ' "$WIN_CONFIG_FILE" "$VALID_PRESETS"
}

print_status() {
  echo "当前配置:"
  local tline
  tline="$(template_status_line)" || exit 1
  echo "  statuslineTemplate: ${tline}"
  if [ -f "$UPSTREAM_CMD" ]; then
    echo "  upstream:           enabled   (state/upstream-cmd.sh)"
  elif [ -f "$UPSTREAM_DISABLED" ]; then
    echo "  upstream:           disabled (preserved at state/upstream-cmd.sh.disabled)"
  else
    echo "  upstream:           none (no upstream was preserved)"
  fi
}

disable_upstream() {
  if [ -f "$UPSTREAM_CMD" ] && [ -f "$UPSTREAM_DISABLED" ]; then
    echo "config.sh: both ${UPSTREAM_CMD} and ${UPSTREAM_DISABLED} exist; resolve manually" >&2
    exit 1
  fi
  if [ ! -f "$UPSTREAM_CMD" ]; then
    if [ -f "$UPSTREAM_DISABLED" ]; then
      echo "upstream already disabled (no-op)"
    else
      echo "no upstream to disable (no upstream-cmd.sh found)"
    fi
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "would disable upstream: rename state/upstream-cmd.sh -> state/upstream-cmd.sh.disabled"
    return 0
  fi
  if ! mv "$UPSTREAM_CMD" "$UPSTREAM_DISABLED"; then
    echo "config.sh: mv failed for upstream disable" >&2
    exit 1
  fi
  echo "disabled upstream: renamed state/upstream-cmd.sh -> state/upstream-cmd.sh.disabled"
}

enable_upstream() {
  if [ -f "$UPSTREAM_CMD" ] && [ -f "$UPSTREAM_DISABLED" ]; then
    echo "config.sh: both ${UPSTREAM_CMD} and ${UPSTREAM_DISABLED} exist; resolve manually" >&2
    exit 1
  fi
  if [ ! -f "$UPSTREAM_DISABLED" ]; then
    if [ -f "$UPSTREAM_CMD" ]; then
      echo "upstream already enabled (no-op)"
    else
      echo "no preserved upstream to enable"
    fi
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "would enable upstream: rename state/upstream-cmd.sh.disabled -> state/upstream-cmd.sh"
    return 0
  fi
  if ! mv "$UPSTREAM_DISABLED" "$UPSTREAM_CMD"; then
    echo "config.sh: mv failed for upstream enable" >&2
    exit 1
  fi
  echo "enabled upstream: restored state/upstream-cmd.sh from state/upstream-cmd.sh.disabled"
}

if [ "$HELP" = 1 ]; then
  sed -n '2,20p' "$0"
  exit 0
fi

# No action flags -> read-only status view.
if [ -z "$ACTION_PRESET" ] && [ "$ACTION_DISABLE" = 0 ] && [ "$ACTION_ENABLE" = 0 ]; then
  print_status
  echo ""
  echo "用法: /creditgauge:config [--preset-<name>] [--disable-upstream] [--enable-upstream] [--dry-run]"
  exit 0
fi

if [ -n "$ACTION_PRESET" ]; then
  if ! echo " $VALID_PRESETS " | grep -qF " $ACTION_PRESET "; then
    echo "config.sh: unknown preset '${ACTION_PRESET}'; valid presets: ${VALID_PRESETS}" >&2
    exit 1
  fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "would set statuslineTemplate: ${ACTION_PRESET} in ${CONFIG_FILE}"
  else
    # v2 — ensure the plugin config dir exists (fresh system without :install);
    # the node helper writes into it and would otherwise ENOENT.
    mkdir -p "$(dirname "$CONFIG_FILE")"
    node "$HELPER" "$WIN_CONFIG_FILE" set-preset "$ACTION_PRESET" || exit 1
  fi
fi

if [ "$ACTION_DISABLE" = 1 ]; then
  disable_upstream
fi

if [ "$ACTION_ENABLE" = 1 ]; then
  enable_upstream
fi
```

- [ ] **Step 2: 手动验证（fixture）**

Run:
```bash
TMP=$(mktemp -d -t cg-config-XXXXXX)
printf '#!/usr/bin/env bash\necho "upstream"\n' > "$TMP/plugins" 2>/dev/null || true
mkdir -p "$TMP/plugins/creditgauge/state"
printf '#!/usr/bin/env bash\necho "upstream"\n' > "$TMP/plugins/creditgauge/state/upstream-cmd.sh"
# 无参状态（upstream enabled）
CLAUDE_CONFIG_DIR="$TMP" HOME="$TMP" bash scripts/config.sh
# disable
CLAUDE_CONFIG_DIR="$TMP" HOME="$TMP" bash scripts/config.sh --disable-upstream
ls "$TMP/plugins/creditgauge/state/"
# enable
CLAUDE_CONFIG_DIR="$TMP" HOME="$TMP" bash scripts/config.sh --enable-upstream
ls "$TMP/plugins/creditgauge/state/"
# preset 写入
CLAUDE_CONFIG_DIR="$TMP" HOME="$TMP" bash scripts/config.sh --preset-compact
cat "$TMP/plugins/creditgauge/config.json"
# unknown preset -> rc=1
CLAUDE_CONFIG_DIR="$TMP" HOME="$TMP" bash scripts/config.sh --preset-nope; echo "rc=$?"
```
Expected: 状态视图显示 `upstream:           enabled`；disable 后 `state/` 只有 `upstream-cmd.sh.disabled`；enable 后恢复；`--preset-compact` 写出 `"statuslineTemplate": "compact"`；`--preset-nope` 打印 `unknown preset 'nope'` 且 `rc=1`。

- [ ] **Step 3: Commit**

```bash
git add scripts/config.sh
git commit -m "feat(config): add config.sh entry for /creditgauge:config

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `scripts/test-config.sh`（回归测试套件）

**Files:**
- Create: `scripts/test-config.sh`

**Interfaces:**
- Consumes: `scripts/config.sh` 的完整 CLI（Task 2）——黑盒测试，不直接调 `edit-config.mjs`。
- Produces: 可独立运行的 shell 测试脚本；退出码 = FAIL 数。

- [ ] **Step 1: 创建 `scripts/test-config.sh`**

```bash
#!/usr/bin/env bash
# test-config.sh — smoke tests for scripts/config.sh + scripts/lib/edit-config.mjs
# (the /creditgauge:config slash command).
#
# These tests build a synthetic CLAUDE_CONFIG_DIR (fixture root), invoke the
# real config.sh with CLAUDE_CONFIG_DIR / HOME pointed at it, and assert on
# the resulting files / stdout. No real user state is touched.
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_SH="${SCRIPT_DIR}/config.sh"
if [ ! -f "$CONFIG_SH" ]; then
  echo "missing $CONFIG_SH" >&2
  exit 1
fi

# --- Test helpers ------------------------------------------------------------

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "$path" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (missing: $path)"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_missing() {
  local label="$1" path="$2"
  if [ ! -f "$path" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (unexpected file: $path)"
    FAIL=$((FAIL + 1))
  fi
}

assert_match_str() {
  local label="$1" pattern="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$pattern"; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (pattern not found: $pattern)"
    echo "       output: $haystack"
    FAIL=$((FAIL + 1))
  fi
}

# Read a JSON field via node — same helper as test-install.sh.
jget_field() {
  local f="$1" path="$2"
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const parts = process.argv[2].split(".");
    let v = j;
    for (const p of parts) { v = v?.[p]; }
    process.stdout.write(v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
  ' "$f" "$path"
}

# Build a fresh fixture:
#   $FIXTURE_ROOT/                        (synthetic CLAUDE_CONFIG_DIR)
#     plugins/creditgauge/config.json     (only when write_config is called)
#     plugins/creditgauge/state/          (always created)
build_fixture() {
  FIXTURE_ROOT="$(mktemp -d -t creditgauge-config-test-XXXXXX)"
  mkdir -p "${FIXTURE_ROOT}/plugins/creditgauge/state"
  CONFIG_FILE="${FIXTURE_ROOT}/plugins/creditgauge/config.json"
  STATE_DIR="${FIXTURE_ROOT}/plugins/creditgauge/state"
}

write_config() { printf '%s\n' "$1" > "$CONFIG_FILE"; }

write_upstream() {
  printf '#!/usr/bin/env bash\necho "upstream"\n' > "${STATE_DIR}/upstream-cmd.sh"
  chmod +x "${STATE_DIR}/upstream-cmd.sh"
}

write_disabled() {
  printf '#!/usr/bin/env bash\necho "upstream"\n' > "${STATE_DIR}/upstream-cmd.sh.disabled"
}

# Run config.sh against the fixture, capturing stdout+stderr.
run_config() {
  CLAUDE_CONFIG_DIR="$FIXTURE_ROOT" HOME="$FIXTURE_ROOT" bash "$CONFIG_SH" "$@" 2>&1
}

# --- status view -------------------------------------------------------------

echo "-- status: no config.json, no upstream --"
build_fixture
out="$(run_config)"
assert_match_str "[status-default] default preset caption" "standard-slim   (default preset — no config.json)" "$out"
assert_match_str "[status-default] upstream none" "upstream:           none (no upstream was preserved)" "$out"

echo "-- status: preset string --"
build_fixture
write_config '{
  "statuslineTemplate": "compact"
}'
out="$(run_config)"
assert_match_str "[status-preset] preset caption" "statuslineTemplate: compact   (preset)" "$out"

echo "-- status: custom array --"
build_fixture
write_config '{
  "statuslineTemplate": ["m_version", "s_space", "m_tokenIn"]
}'
out="$(run_config)"
assert_match_str "[status-array] custom caption" "statuslineTemplate: (custom template, 3 tokens)" "$out"

echo "-- status: unknown preset string --"
build_fixture
write_config '{
  "statuslineTemplate": "nope"
}'
out="$(run_config)"
assert_match_str "[status-unknown] lists valid presets" "unknown preset; valid: simple compact standard abundant standard-slim" "$out"

echo "-- status: upstream enabled / disabled --"
build_fixture
write_upstream
out="$(run_config)"
assert_match_str "[status-upstream-on] enabled" "upstream:           enabled   (state/upstream-cmd.sh)" "$out"
rm -f "${STATE_DIR}/upstream-cmd.sh"
write_disabled
out="$(run_config)"
assert_match_str "[status-upstream-off] disabled" "upstream:           disabled (preserved at state/upstream-cmd.sh.disabled)" "$out"

# --- set-preset --------------------------------------------------------------

echo "-- set-preset: preserves other keys --"
build_fixture
write_config '{
  "modeLabels": { "used": "Usage:" },
  "cacheTtlMs": 60000
}'
out="$(run_config --preset-standard)"
assert_match_str "[set-preset] ok line" "set statuslineTemplate: standard" "$out"
assert_eq "[set-preset] wrote string form" "standard" "$(jget_field "$CONFIG_FILE" statuslineTemplate)"
assert_eq "[set-preset] preserved modeLabels.used" "Usage:" "$(jget_field "$CONFIG_FILE" modeLabels.used)"
assert_eq "[set-preset] preserved cacheTtlMs" "60000" "$(jget_field "$CONFIG_FILE" cacheTtlMs)"

echo "-- set-preset: creates config.json when absent --"
build_fixture
out="$(run_config --preset-standard-slim)"
assert_match_str "[set-preset-create] ok line" "set statuslineTemplate: standard-slim" "$out"
assert_file_exists "[set-preset-create] config.json created" "$CONFIG_FILE"
assert_eq "[set-preset-create] value" "standard-slim" "$(jget_field "$CONFIG_FILE" statuslineTemplate)"

echo "-- set-preset: replaces custom array --"
build_fixture
write_config '{
  "statuslineTemplate": ["m_version", "s_space", "m_tokenIn"],
  "display": "used"
}'
out="$(run_config --preset-abundant)"
assert_match_str "[set-preset-replace] replaced hint" "replaced custom template with 3 tokens" "$out"
assert_eq "[set-preset-replace] value" "abundant" "$(jget_field "$CONFIG_FILE" statuslineTemplate)"
assert_eq "[set-preset-replace] preserved display" "used" "$(jget_field "$CONFIG_FILE" display)"

echo "-- set-preset: unknown preset errors --"
build_fixture
out="$(run_config --preset-nope 2>&1)"; rc=$?
assert_eq "[set-preset-unknown] exit code" "1" "$rc"
assert_match_str "[set-preset-unknown] lists valid presets" "valid presets: simple compact standard abundant standard-slim" "$out"

echo "-- set-preset: bad JSON leaves file untouched --"
build_fixture
write_config '{ this is not json'
before="$(cat "$CONFIG_FILE")"
out="$(run_config --preset-standard 2>&1)"; rc=$?
assert_eq "[set-preset-badjson] exit code" "1" "$rc"
assert_eq "[set-preset-badjson] file untouched" "$before" "$(cat "$CONFIG_FILE")"

# --- upstream toggle ---------------------------------------------------------

echo "-- disable: renames file --"
build_fixture
write_upstream
out="$(run_config --disable-upstream)"
assert_match_str "[disable] ok line" "disabled upstream" "$out"
assert_file_missing "[disable] original gone" "${STATE_DIR}/upstream-cmd.sh"
assert_file_exists "[disable] disabled present" "${STATE_DIR}/upstream-cmd.sh.disabled"

echo "-- disable: idempotent --"
out="$(run_config --disable-upstream)"
assert_match_str "[disable-idempotent] no-op" "upstream already disabled (no-op)" "$out"

echo "-- disable: no upstream --"
build_fixture
out="$(run_config --disable-upstream)"
assert_match_str "[disable-none] no-op" "no upstream to disable (no upstream-cmd.sh found)" "$out"

echo "-- enable: renames back --"
build_fixture
write_disabled
out="$(run_config --enable-upstream)"
assert_match_str "[enable] ok line" "enabled upstream" "$out"
assert_file_exists "[enable] restored" "${STATE_DIR}/upstream-cmd.sh"
assert_file_missing "[enable] disabled gone" "${STATE_DIR}/upstream-cmd.sh.disabled"

echo "-- enable: idempotent --"
out="$(run_config --enable-upstream)"
assert_match_str "[enable-idempotent] no-op" "upstream already enabled (no-op)" "$out"

echo "-- enable: no preserved upstream --"
build_fixture
out="$(run_config --enable-upstream)"
assert_match_str "[enable-none] no-op" "no preserved upstream to enable" "$out"

echo "-- both files exist: error --"
build_fixture
write_upstream
write_disabled
out="$(run_config --disable-upstream 2>&1)"; rc=$?
assert_eq "[both-exist] exit code" "1" "$rc"
assert_match_str "[both-exist] message" "resolve manually" "$out"

# --- dry-run ----------------------------------------------------------------

echo "-- dry-run: preset does not write --"
build_fixture
out="$(run_config --preset-standard --dry-run)"
assert_match_str "[dry-preset] would line" "would set statuslineTemplate: standard" "$out"
assert_file_missing "[dry-preset] no config created" "$CONFIG_FILE"

echo "-- dry-run: disable does not rename --"
build_fixture
write_upstream
out="$(run_config --disable-upstream --dry-run)"
assert_match_str "[dry-disable] would line" "would disable upstream" "$out"
assert_file_exists "[dry-disable] file intact" "${STATE_DIR}/upstream-cmd.sh"
assert_file_missing "[dry-disable] no disabled file" "${STATE_DIR}/upstream-cmd.sh.disabled"

# --- line ending preservation ------------------------------------------------

echo "-- set-preset preserves CRLF line endings --"
build_fixture
printf '{\r\n  "display": "used"\r\n}\r\n' > "$CONFIG_FILE"
out="$(run_config --preset-standard)"
assert_match_str "[crlf] ok line" "set statuslineTemplate: standard" "$out"
# Portable CRLF probe: GNU grep strips trailing \r from each line (so
# `grep -q $'\r'` can never match a CRLF file), and BSD grep differs.
# Stripping \n first makes any CR byte mid-stream and matchable on both.
if tr -d '\n' < "$CONFIG_FILE" | grep -q $'\r'; then
  echo "  ok  [crlf] line ending preserved"
  PASS=$((PASS + 1))
else
  echo "  FAIL [crlf] line ending NOT preserved"
  FAIL=$((FAIL + 1))
fi

# --- unknown flag ------------------------------------------------------------

echo "-- unknown flag errors --"
build_fixture
out="$(run_config --bogus 2>&1)"; rc=$?
assert_eq "[unknown-flag] exit code" "2" "$rc"
assert_match_str "[unknown-flag] usage" "usage: /creditgauge:config" "$out"

# --- Summary -----------------------------------------------------------------
echo ""
echo "test-config.sh: $PASS pass, $FAIL fail"
exit $FAIL
```

- [ ] **Step 2: 运行测试，确认全部通过**

Run: `bash scripts/test-config.sh`
Expected: 全部 `ok` 行，末行 `test-config.sh: NN pass, 0 fail`，退出码 0。

- [ ] **Step 3: Commit**

```bash
git add scripts/test-config.sh
git commit -m "test(config): add regression suite for /creditgauge:config

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: `commands/config.md` + 注册到 plugin.json + 文档

**Files:**
- Create: `commands/config.md`
- Modify: `.claude-plugin/plugin.json:6-13`（commands 数组）
- Modify: `CLAUDE.md`（架构节 commands/ 列表）
- Modify: `README.md`（命令表 ~line 135 与 commands/ 列表 ~line 480）

**Interfaces:**
- Consumes: `scripts/config.sh` CLI（Task 2）。
- Produces: `/creditgauge:config` slash 命令，通过 ` ```! ` fenced block 以 `$ARGUMENTS` 透传用户参数。

- [ ] **Step 1: 创建 `commands/config.md`**

```markdown
---
description: Read or modify creditgauge runtime config — switch statuslineTemplate to a preset, or disable/enable the upstream chain
argument-hint: "[--preset-<name> | --disable-upstream | --enable-upstream] [--dry-run]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/config.sh:*)"]
---

# creditgauge :config

Reads or modifies creditgauge's runtime config. Runs locally with no network
access and never prints `ANTHROPIC_AUTH_TOKEN`.

- **No arguments** — prints the current status: which `statuslineTemplate`
  preset is active, and whether the upstream statusline chain is enabled.
- **`--preset-<name>`** — sets `statuslineTemplate` to the named preset in
  `~/.claude/plugins/creditgauge/config.json`. All other config keys and the
  file's line ending are preserved; an absent config.json is created. A custom
  `string[]` template is replaced (with a notice). Valid presets:
  `simple`, `compact`, `standard`, `abundant`, `standard-slim`.
- **`--disable-upstream`** — disables the upstream statusline chain by
  renaming `state/upstream-cmd.sh` → `state/upstream-cmd.sh.disabled`
  (the original command is preserved and can be re-enabled).
- **`--enable-upstream`** — re-enables a previously disabled upstream by
  renaming the file back.
- **`--dry-run`** — prints the actions without changing anything.

Multiple action flags may be combined in one invocation.

Execute the config script with whatever arguments were passed:

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/config.sh" $ARGUMENTS
```
```

- [ ] **Step 2: 在 `.claude-plugin/plugin.json` 注册命令**

Modify the `commands` array（当前 `"version": "1.1.11"` 不变，不 bump）:

```json
  "commands": [
    "./commands/install.md",
    "./commands/uninstall.md",
    "./commands/clean.md",
    "./commands/clean-cache.md",
    "./commands/clean-journal.md",
    "./commands/reset.md",
    "./commands/config.md"
  ],
```

- [ ] **Step 3: 更新 `CLAUDE.md` 架构节**

在 `commands/` 列表（install.md / uninstall.md / clean.md / clean-cache.md 附近）追加一行：

```markdown
  config.md           # /creditgauge:config slash command (Pattern B2)
```

- [ ] **Step 4: 更新 `README.md`**

命令表（~line 135，`/creditgauge:install` / `:uninstall` / `:clean` / `:clean-cache` 行后）加一行：

```markdown
| `/creditgauge:config`            | Read config state; switch statuslineTemplate preset; disable/enable upstream. |
```

commands/ 列表（~line 480 附近）加：

```markdown
  config.md            # /creditgauge:config slash command
```

- [ ] **Step 5: 验证 + Commit**

Run: `node -e 'const p=require("./.claude-plugin/plugin.json"); if(!p.commands.includes("./commands/config.md")){process.exit(1)}; console.log("plugin.json ok: "+p.commands.length+" commands")'`
Expected: `plugin.json ok: 7 commands`

```bash
git add commands/config.md .claude-plugin/plugin.json CLAUDE.md README.md
git commit -m "feat(config): register /creditgauge:config slash command + docs

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: `scripts/uninstall.sh` 清理 `.disabled` 残留

**Files:**
- Modify: `scripts/uninstall.sh:356-363`（`ALWAYS_STATE_FILES` 数组）

**Interfaces:**
- Consumes: 无。
- Produces: uninstall 时同样清理 `state/upstream-cmd.sh.disabled`，避免禁用 upstream 后 uninstall 残留。

- [ ] **Step 1: 在 `ALWAYS_STATE_FILES` 加一行**

Modify（在 `"${STATE_DIR}/upstream-cmd.sh"` 与 `"${STATE_DIR}/upstream-cmd.txt"` 之间或之后）：

```bash
    "${STATE_DIR}/upstream-cmd.sh"
    "${STATE_DIR}/upstream-cmd.sh.disabled"
    "${STATE_DIR}/upstream-cmd.txt"
```

- [ ] **Step 2: 验证 + Commit**

Run: `grep -n "upstream-cmd.sh.disabled" scripts/uninstall.sh`
Expected: 输出包含该行（在 `ALWAYS_STATE_FILES` 内）。

```bash
git add scripts/uninstall.sh
git commit -m "chore(uninstall): wipe upstream-cmd.sh.disabled alongside the state cache

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 全量验证

**Files:**
- 无新文件；运行既有 + 新增测试。

**Interfaces:**
- Consumes: Task 1–5 全部产物。

- [ ] **Step 1: 运行全部测试**

Run:
```bash
npm test
bash scripts/test-config.sh
```
Expected: `npm test` 64 个测试全过；`test-config.sh` 末行 `NN pass, 0 fail`，退出码 0。

- [ ] **Step 2: 手动冒烟（真实 CLAUDE_CONFIG_DIR 不触碰，用 fixture）**

Run:
```bash
TMP=$(mktemp -d -t cg-final-XXXXXX)
mkdir -p "$TMP/plugins/creditgauge/state"
CLAUDE_CONFIG_DIR="$TMP" HOME="$TMP" bash scripts/config.sh --preset-standard
CLAUDE_CONFIG_DIR="$TMP" HOME="$TMP" bash scripts/config.sh
CLAUDE_CONFIG_DIR="$TMP" HOME="$TMP" bash scripts/config.sh --disable-upstream
CLAUDE_CONFIG_DIR="$TMP" HOME="$TMP" bash scripts/config.sh
rm -rf "$TMP"
```
Expected: preset 写入成功；状态视图两行显示正确；disable 后 upstream 行变 disabled；全程无 `ANTHROPIC_AUTH_TOKEN` 相关输出。

- [ ] **Step 3: 收尾（无新 commit 需要；若有意外改动，单独 commit）**

Run: `git status --short`
Expected: 干净（所有改动已在 Task 1–5 提交）。

---

## Self-Review 备注

- **Spec 覆盖**：spec 的组件结构（config.sh / edit-config.mjs / config.md / test-config.sh / plugin.json / uninstall.sh 清理）、参数语法、preset 字符串形式、upstream 重命名机制、状态视图、错误处理、dry-run、测试清单——全部映射到 Task 1–6。spec 中「发布注意（版本 bump 需显式要求）」落实在 Global Constraints。
- **占位符**：每个代码步含完整内容，无 TBD/TODO。
- **类型一致性**：`set-preset` CLI 签名在 Task 1 定义、Task 2 调用处一致；`run_config`/`write_config`/`write_upstream`/`write_disabled`/`CONFIG_FILE`/`STATE_DIR` 在 Task 3 内定义并全量一致使用。
