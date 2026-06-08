#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=1
SESSION="sample-resilience"
SOURCE_GROVE_HOME="${GROVE_SOURCE_HOME:-$HOME/.grove-clone}"
PROJECT_DIR="$HOME/grove-projects/$SESSION"
PROJECT_DIR_SET=0
SNAPSHOT_ROOT="$HOME/grove-snapshots"
SNAPSHOT_ID="$(date -u +%Y%m%dT%H%M%SZ)"
GROVE_BIN="${GROVE_BIN:-grove}"

usage() {
  cat <<'EOF'
Usage: scripts/snapshot.sh [options]

Dry-run is the default. Add --execute to write snapshot files.

Options:
  --execute                    create files and run grove export-project
  --session <name>             clone/test session name (default: sample-resilience)
  --source-grove-home <path>   cloned GROVE_HOME to archive (default: ~/.grove-clone)
  --project-dir <path>         cloned project dir with grove.project.json
  --out-root <path>            snapshot root (default: ~/grove-snapshots)
  --snapshot-id <id>           snapshot directory name (default: current UTC timestamp)
  --grove-bin <path>           grove executable (default: grove)
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

validate_snapshot_id() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "--snapshot-id must contain only letters, digits, dot, hyphen, or underscore and cannot start with dot"
  [[ "$value" != *".."* ]] || die "--snapshot-id must not contain '..'"
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

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    print_command "$@"
  else
    "$@"
  fi
}

run_in_project_dir() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] cd %q &&' "$PROJECT_DIR"
    printf ' %q' "$@"
    printf '\n'
  else
    (cd "$PROJECT_DIR" && "$@")
  fi
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

write_manifest() {
  local manifest="$1"
  local archive_sha=""
  if [[ -e "$manifest" ]]; then
    printf 'skip existing manifest: %s\n' "$manifest"
    return
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] write %s\n' "$manifest"
    return
  fi
  if [[ -f "$DOT_GROVE_TGZ" ]]; then
    archive_sha="$(sha256_file "$DOT_GROVE_TGZ")"
  fi
  node -e '
const fs = require("fs");
const [manifest, session, sourceGroveHome, projectDir, archiveSha] = process.argv.slice(1);
const payload = {
  schema: 1,
  type: "grove.resilience.snapshot",
  created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  session,
  source_grove_home: sourceGroveHome,
  project_dir: projectDir,
  files: {
    dot_grove: "dot-grove.tgz",
    bundle: "bundle",
  },
};
if (archiveSha) payload.files.dot_grove_sha256 = archiveSha;
fs.writeFileSync(manifest, `${JSON.stringify(payload, null, 2)}\n`);
' "$manifest" "$SESSION" "$SOURCE_GROVE_HOME" "$PROJECT_DIR" "$archive_sha"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute)
      DRY_RUN=0
      shift
      ;;
    --session)
      SESSION="${2:-}"
      if [[ "$PROJECT_DIR_SET" -eq 0 ]]; then
        PROJECT_DIR="$HOME/grove-projects/$SESSION"
      fi
      shift 2
      ;;
    --source-grove-home)
      SOURCE_GROVE_HOME="${2:-}"
      shift 2
      ;;
    --project-dir)
      PROJECT_DIR="${2:-}"
      PROJECT_DIR_SET=1
      shift 2
      ;;
    --out-root)
      SNAPSHOT_ROOT="${2:-}"
      shift 2
      ;;
    --snapshot-id)
      SNAPSHOT_ID="${2:-}"
      shift 2
      ;;
    --grove-bin)
      GROVE_BIN="${2:-}"
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

[[ -n "$SESSION" ]] || die "--session is required"
validate_grove_name "$SESSION" "--session"
validate_snapshot_id "$SNAPSHOT_ID"
[[ "$SESSION" != "sample" ]] || die "refusing live session sample; use a clone session"

SOURCE_GROVE_HOME="$(expand_path "$SOURCE_GROVE_HOME")"
PROJECT_DIR="$(expand_path "$PROJECT_DIR")"
SNAPSHOT_ROOT="$(expand_path "$SNAPSHOT_ROOT")"
LIVE_GROVE_HOME="$(resolve_existing_path "$HOME/.grove")"
RESOLVED_SOURCE_HOME="$(resolve_existing_path "$SOURCE_GROVE_HOME")"
if path_inside_or_equal "$RESOLVED_SOURCE_HOME" "$LIVE_GROVE_HOME"; then
  die "refusing live GROVE_HOME or child path: $SOURCE_GROVE_HOME"
fi

SNAPSHOT_DIR="$SNAPSHOT_ROOT/$SNAPSHOT_ID"
RESOLVED_SNAPSHOT_ROOT="$(resolve_existing_path "$SNAPSHOT_ROOT")"
RESOLVED_SNAPSHOT_DIR="$(resolve_existing_path "$SNAPSHOT_DIR")"
path_inside_or_equal "$RESOLVED_SNAPSHOT_DIR" "$RESOLVED_SNAPSHOT_ROOT" || die "snapshot dir escaped --out-root: $SNAPSHOT_DIR"
DOT_GROVE_TGZ="$SNAPSHOT_DIR/dot-grove.tgz"
BUNDLE_DIR="$SNAPSHOT_DIR/bundle"
MANIFEST="$SNAPSHOT_DIR/snapshot.json"

printf 'mode: %s\n' "$([[ "$DRY_RUN" -eq 1 ]] && printf dry-run || printf execute)"
printf 'session: %s\n' "$SESSION"
printf 'source-grove-home: %s\n' "$SOURCE_GROVE_HOME"
printf 'project-dir: %s\n' "$PROJECT_DIR"
printf 'snapshot-dir: %s\n' "$SNAPSHOT_DIR"

if [[ "$DRY_RUN" -eq 0 ]]; then
  [[ -d "$SOURCE_GROVE_HOME" ]] || die "source GROVE_HOME not found: $SOURCE_GROVE_HOME"
  [[ -d "$PROJECT_DIR" ]] || die "project dir not found: $PROJECT_DIR"
  [[ -f "$PROJECT_DIR/grove.project.json" ]] || die "project file not found: $PROJECT_DIR/grove.project.json"
fi

run mkdir -p "$SNAPSHOT_DIR"

if [[ -e "$DOT_GROVE_TGZ" ]]; then
  printf 'skip existing archive: %s\n' "$DOT_GROVE_TGZ"
else
  run tar -C "$SOURCE_GROVE_HOME" -czf "$DOT_GROVE_TGZ" .
fi

if [[ -e "$BUNDLE_DIR/bundle.json" ]]; then
  printf 'skip existing bundle: %s\n' "$BUNDLE_DIR"
else
  run_in_project_dir env GROVE_HOME="$SOURCE_GROVE_HOME" "$GROVE_BIN" export-project "$SESSION" --session "$SESSION" --out "$BUNDLE_DIR"
fi

write_manifest "$MANIFEST"
printf 'snapshot draft complete: %s\n' "$SNAPSHOT_DIR"
