#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=1
SNAPSHOT_DIR=""
TARGET_GROVE_HOME="${GROVE_TARGET_HOME:-$HOME/.grove-restore}"
TARGET_SESSION=""
TARGET_PROJECT_DIR=""
WEB_PORT="${GROVE_WEB_PORT:-19131}"
GROVE_BIN="${GROVE_BIN:-grove}"
GROVE_WEB_BIN="${GROVE_WEB_BIN:-grove-web}"
START_WEB=0

usage() {
  cat <<'EOF'
Usage: scripts/restore.sh --snapshot <dir> [options]

Dry-run is the default. Add --execute to restore into clone/test paths.

Options:
  --snapshot <dir>             snapshot directory under ~/grove-snapshots
  --execute                    extract/import/load/repair against clone targets
  --target-session <name>      restored clone session name
  --target-grove-home <path>   restored GROVE_HOME (default: ~/.grove-restore)
  --target-project-dir <path>  restored project dir
  --web-port <port>            optional clone web port (default: 19131)
  --start-web                  start grove-web after load/repair; blocks in foreground
  --grove-bin <path>           grove executable (default: grove)
  --grove-web-bin <path>       grove-web executable (default: grove-web)
  -h, --help                   show this help
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

validate_grove_name() {
  local value="$1"
  local label="$2"
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || die "$label must match ^[A-Za-z0-9][A-Za-z0-9_-]*$"
}

validate_port() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] || die "--web-port must be numeric"
  ((value >= 1 && value <= 65535)) || die "--web-port must be between 1 and 65535"
  case "$value" in
    8765 | 9131)
      die "refusing live web port $value; use a clone port"
      ;;
  esac
}

expand_path() {
  local value="$1"
  case "$value" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${value#~/}" ;;
    *) printf '%s\n' "$value" ;;
  esac
}

resolve_existing_path() {
  local value
  value="$(expand_path "$1")"
  node -e '
const fs = require("fs");
const path = require("path");
const value = process.argv[1];
const resolved = path.resolve(value);
try {
  process.stdout.write(fs.realpathSync.native(resolved));
} catch {
  process.stdout.write(resolved);
}
' "$value"
}

resolve_real_target_path() {
  local value
  value="$(expand_path "$1")"
  node -e '
const fs = require("fs");
const path = require("path");
const input = path.resolve(process.argv[1]);
let current = input;
const missing = [];
while (!fs.existsSync(current)) {
  const parent = path.dirname(current);
  if (parent === current) break;
  missing.unshift(path.basename(current));
  current = parent;
}
let realParent;
try {
  realParent = fs.realpathSync.native(current);
} catch {
  realParent = path.resolve(current);
}
process.stdout.write(path.join(realParent, ...missing));
' "$value"
}

path_inside_or_equal() {
  local candidate="$1"
  local root="$2"
  node -e '
const path = require("path");
const candidate = path.resolve(process.argv[1]);
const root = path.resolve(process.argv[2]);
const relative = path.relative(root, candidate);
process.exit(relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? 0 : 1);
' "$candidate" "$root"
}

print_command() {
  printf '[dry-run]'
  printf ' %q' "$@"
  printf '\n'
}

print_not_started() {
  printf 'web command (not started)'
  printf ' %q' "$@"
  printf '\n'
}

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    print_command "$@"
  else
    "$@"
  fi
}

json_field() {
  local file="$1"
  local expr="$2"
  node -e '
const fs = require("fs");
const file = process.argv[1];
const expr = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const value = expr.split(".").reduce((acc, key) => acc == null ? undefined : acc[key], data);
if (value == null) process.exit(2);
process.stdout.write(String(value));
' "$file" "$expr"
}

json_optional_field() {
  local file="$1"
  local expr="$2"
  [[ -f "$file" ]] || return 0
  node -e '
const fs = require("fs");
const file = process.argv[1];
const expr = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const value = expr.split(".").reduce((acc, key) => acc == null ? undefined : acc[key], data);
if (value != null) process.stdout.write(String(value));
' "$file" "$expr"
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

verify_archive_checksum() {
  local archive="$1"
  local expected="$2"
  [[ -n "$expected" ]] || return 0
  local actual
  actual="$(sha256_file "$archive")"
  [[ "$actual" == "$expected" ]] || die "dot-grove.tgz checksum mismatch"
}

validate_archive_members() {
  local archive="$1"
  python3 - "$archive" <<'PY' || die "dot-grove.tgz contains unsafe archive members"
import pathlib
import sys
import tarfile

archive = sys.argv[1]

try:
    handle = tarfile.open(archive, "r:gz")
except (tarfile.TarError, OSError) as exc:
    print(f"invalid tar archive: {exc}", file=sys.stderr)
    sys.exit(1)

with handle:
    for member in handle.getmembers():
        name = member.name
        parts = pathlib.PurePosixPath(name).parts
        if not name or name.startswith("/") or ".." in parts:
            print(f"unsafe path: {name}", file=sys.stderr)
            sys.exit(1)
        if member.issym() or member.islnk():
            print(f"link member rejected: {name}", file=sys.stderr)
            sys.exit(1)
        if not (member.isfile() or member.isdir()):
            print(f"special member rejected: {name}", file=sys.stderr)
            sys.exit(1)
PY
}

dir_is_empty() {
  local dir="$1"
  [[ ! -d "$dir" ]] || [[ -z "$(find "$dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]
}

rewrite_bundle() {
  local source_bundle="$1"
  local rewrite_dir="$2"
  local source_name="$3"
  local target_name="$4"
  if [[ "$source_name" == "$target_name" ]]; then
    printf '%s\n' "$source_bundle"
    return
  fi
  if [[ -e "$rewrite_dir/bundle.json" ]]; then
    printf '%s\n' "$rewrite_dir"
    return
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] rewrite bundle %s -> %s for session %s\n' "$source_bundle" "$rewrite_dir" "$target_name" >&2
    printf '%s\n' "$rewrite_dir"
    return
  fi
  mkdir -p "$rewrite_dir"
  cp -R "$source_bundle"/. "$rewrite_dir"/
  node -e '
const fs = require("fs");
const path = require("path");
const bundle = process.argv[1];
const target = process.argv[2];
const manifestPath = path.join(bundle, "bundle.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const projectPath = path.join(bundle, manifest.files.project);
const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
const oldName = project.name;
manifest.name = target;
project.name = target;
if (project.board && project.board.slug === oldName) project.board.slug = target;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
' "$rewrite_dir" "$target_name"
  printf '%s\n' "$rewrite_dir"
}

restore_dot_grove() {
  local archive="$1"
  local target_home="$2"
  local marker="$target_home/.restored-from-snapshot"
  validate_archive_members "$archive"
  if [[ -e "$marker" ]]; then
    if [[ "$(cat "$marker")" != "$SNAPSHOT_DIR" ]]; then
      die "target GROVE_HOME was restored from a different snapshot: $marker"
    fi
    printf 'skip dot-grove restore; marker exists: %s\n' "$marker"
    return
  fi
  if ! dir_is_empty "$target_home"; then
    die "target GROVE_HOME is not empty and has no restore marker: $target_home"
  fi
  run mkdir -p "$target_home"
  run tar -xzf "$archive" -C "$target_home"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] write %s\n' "$marker"
  else
    printf '%s\n' "$SNAPSHOT_DIR" >"$marker"
  fi
}

tmux_session_exists() {
  local session="$1"
  tmux has-session -t "$session" >/dev/null 2>&1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --snapshot)
      SNAPSHOT_DIR="${2:-}"
      shift 2
      ;;
    --execute)
      DRY_RUN=0
      shift
      ;;
    --target-session)
      TARGET_SESSION="${2:-}"
      shift 2
      ;;
    --target-grove-home)
      TARGET_GROVE_HOME="${2:-}"
      shift 2
      ;;
    --target-project-dir)
      TARGET_PROJECT_DIR="${2:-}"
      shift 2
      ;;
    --web-port)
      WEB_PORT="${2:-}"
      shift 2
      ;;
    --start-web)
      START_WEB=1
      shift
      ;;
    --grove-bin)
      GROVE_BIN="${2:-}"
      shift 2
      ;;
    --grove-web-bin)
      GROVE_WEB_BIN="${2:-}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$SNAPSHOT_DIR" ]] || die "--snapshot is required"
SNAPSHOT_DIR="$(expand_path "$SNAPSHOT_DIR")"
TARGET_GROVE_HOME="$(expand_path "$TARGET_GROVE_HOME")"

BUNDLE_DIR="$SNAPSHOT_DIR/bundle"
ARCHIVE="$SNAPSHOT_DIR/dot-grove.tgz"
SNAPSHOT_MANIFEST="$SNAPSHOT_DIR/snapshot.json"
MANIFEST="$BUNDLE_DIR/bundle.json"
[[ -d "$BUNDLE_DIR" ]] || die "snapshot bundle not found: $BUNDLE_DIR"
[[ -f "$MANIFEST" ]] || die "bundle manifest not found: $MANIFEST"
[[ -f "$ARCHIVE" ]] || die "dot-grove archive not found: $ARCHIVE"
EXPECTED_ARCHIVE_SHA="$(json_optional_field "$SNAPSHOT_MANIFEST" files.dot_grove_sha256)"
verify_archive_checksum "$ARCHIVE" "$EXPECTED_ARCHIVE_SHA"

BUNDLE_NAME="$(json_field "$MANIFEST" name)"
validate_grove_name "$BUNDLE_NAME" "bundle name"
if [[ -z "$TARGET_SESSION" ]]; then
  TARGET_SESSION="$BUNDLE_NAME-restore"
fi
if [[ -z "$TARGET_PROJECT_DIR" ]]; then
  TARGET_PROJECT_DIR="$HOME/grove-projects/$TARGET_SESSION"
fi
TARGET_PROJECT_DIR="$(expand_path "$TARGET_PROJECT_DIR")"

validate_grove_name "$TARGET_SESSION" "--target-session"
validate_port "$WEB_PORT"
[[ "$TARGET_SESSION" != "dev10" ]] || die "refusing live session dev10; use a clone session"
LIVE_GROVE_HOME="$(resolve_existing_path "$HOME/.grove")"
RESOLVED_TARGET_HOME="$(resolve_real_target_path "$TARGET_GROVE_HOME")"
if path_inside_or_equal "$RESOLVED_TARGET_HOME" "$LIVE_GROVE_HOME"; then
  die "refusing live GROVE_HOME or child path: $TARGET_GROVE_HOME"
fi
RESOLVED_TARGET_PROJECT_DIR="$(resolve_real_target_path "$TARGET_PROJECT_DIR")"
if path_inside_or_equal "$RESOLVED_TARGET_PROJECT_DIR" "$LIVE_GROVE_HOME"; then
  die "refusing target project dir under live GROVE_HOME: $TARGET_PROJECT_DIR"
fi

BOARD_DB_PATH="$TARGET_GROVE_HOME/boards/board.db"

printf 'mode: %s\n' "$([[ "$DRY_RUN" -eq 1 ]] && printf dry-run || printf execute)"
printf 'snapshot: %s\n' "$SNAPSHOT_DIR"
printf 'bundle-session: %s\n' "$BUNDLE_NAME"
printf 'target-session: %s\n' "$TARGET_SESSION"
printf 'target-grove-home: %s\n' "$TARGET_GROVE_HOME"
printf 'target-project-dir: %s\n' "$TARGET_PROJECT_DIR"
printf 'web-port: %s\n' "$WEB_PORT"

restore_dot_grove "$ARCHIVE" "$TARGET_GROVE_HOME"

REWRITE_BUNDLE_DIR="$TARGET_GROVE_HOME/restore-bundles/$(basename "$SNAPSHOT_DIR")-$TARGET_SESSION"
EFFECTIVE_BUNDLE="$(rewrite_bundle "$BUNDLE_DIR" "$REWRITE_BUNDLE_DIR" "$BUNDLE_NAME" "$TARGET_SESSION")"

if [[ -e "$TARGET_PROJECT_DIR/grove.project.json" ]]; then
  EXISTING_PROJECT_NAME="$(json_field "$TARGET_PROJECT_DIR/grove.project.json" name)"
  [[ "$EXISTING_PROJECT_NAME" == "$TARGET_SESSION" ]] || die "existing project name $EXISTING_PROJECT_NAME does not match target session $TARGET_SESSION"
  printf 'skip import; project already exists: %s\n' "$TARGET_PROJECT_DIR/grove.project.json"
else
  run env GROVE_HOME="$TARGET_GROVE_HOME" "$GROVE_BIN" import-project "$EFFECTIVE_BUNDLE" --dir "$TARGET_PROJECT_DIR"
fi

if [[ "$DRY_RUN" -eq 0 ]] && tmux_session_exists "$TARGET_SESSION"; then
  printf 'skip load-project; tmux session already exists: %s\n' "$TARGET_SESSION"
else
  run env GROVE_HOME="$TARGET_GROVE_HOME" "$GROVE_BIN" load-project "$TARGET_PROJECT_DIR"
fi

run env GROVE_HOME="$TARGET_GROVE_HOME" "$GROVE_BIN" repair --session "$TARGET_SESSION" --all

if [[ "$START_WEB" -eq 1 ]]; then
  run env GROVE_HOME="$TARGET_GROVE_HOME" GROVE_VIEWER_SESSION="$TARGET_SESSION" "$GROVE_WEB_BIN" --session "$TARGET_SESSION" --port "$WEB_PORT" --board-db-path "$BOARD_DB_PATH"
else
  print_not_started env GROVE_HOME="$TARGET_GROVE_HOME" GROVE_VIEWER_SESSION="$TARGET_SESSION" "$GROVE_WEB_BIN" --session "$TARGET_SESSION" --port "$WEB_PORT" --board-db-path "$BOARD_DB_PATH"
fi

printf 'restore draft complete: %s -> %s\n' "$SNAPSHOT_DIR" "$TARGET_SESSION"
