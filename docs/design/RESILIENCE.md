# grove Resilience Design

Status: phase 1 draft. This document defines the snapshot/restore, Docker, and
cloud-portable track. Docker builds and runtime packaging stay blocked until this design is
approved.

## Principle

**라이브 중단금지 -> 클론테스트** is the operating rule for this track.

- Do not touch live `dev10`, `~/.grove/dev10`, or port `9131`.
- All validation uses a cloned `GROVE_HOME`, a non-live session name, and a separate port.
- Snapshot and restore tooling defaults to dry-run. Any mutation requires an explicit
  `--execute`.
- Restore never writes into `~/.grove` by default. The operator must point it at a clone target
  such as `~/.grove-restore` or another isolated path.

## Snapshot Format

Snapshots live under the reusable root:

```text
~/grove-snapshots/<ts>/
  dot-grove.tgz
  bundle/
    bundle.json
    grove.project.json
    scaffold.yaml
  snapshot.json
```

`<ts>` is a UTC timestamp such as `20260604T153000Z`. The directory is append-only by default:
rerunning with the same timestamp skips files that already exist instead of overwriting them.

`dot-grove.tgz` is a tarball of the cloned `GROVE_HOME` contents, not the host live
`~/.grove`. It carries registry state, board DB files under `boards/`, dashboard tokens, web
companions, and other local runtime state needed to reconstruct a test room. The archive is
restored only into a separate target `GROVE_HOME`.

`bundle/` reuses the existing portable project bundle contract from `grove export-project`.
Today that bundle contains:

- `bundle.json`: manifest with schema/type/name/file paths.
- `grove.project.json`: portable project file with workspace, nodes, parent/group metadata, and
  node session IDs when available.
- `scaffold.yaml`: YAML scaffold generated from the portable project file.

`snapshot.json` is the resilience-level manifest. Phase 1 records the snapshot version, source
session, source grove home, bundle path, tarball path, creation time, and the SHA-256 checksum of
`dot-grove.tgz` when the script runs in execute mode. Later phases can add grove package versions,
bridge versions, image tags, and object-storage metadata without changing the core layout.

## Snapshot Procedure

The phase 1 script is `scripts/snapshot.sh`.

Default mode is dry-run:

```bash
scripts/snapshot.sh \
  --session dev10-resilience \
  --source-grove-home ~/.grove-clone \
  --project-dir ~/grove-projects/dev10-resilience
```

Mutation requires:

```bash
scripts/snapshot.sh --execute ...
```

The script does three things:

1. Refuses live targets: session `dev10` and source `~/.grove` are not valid resilience-test
   inputs. The source `GROVE_HOME` may not be `~/.grove` or a child path under it. The paired
   restore script also refuses live port `9131`.
2. Writes `dot-grove.tgz` from the cloned source `GROVE_HOME`.
3. Runs `GROVE_HOME=<clone> grove export-project --session <session> --out <snapshot>/bundle`
   from the cloned project directory, unless the bundle already exists.

Session names use grove's strict name shape: `[A-Za-z0-9][A-Za-z0-9_-]*`. Snapshot IDs may contain
letters, digits, dot, hyphen, and underscore, but may not contain path traversal.

The script is intentionally a draft wrapper around existing primitives. It should stay small until
the design is approved and the repo has tests for the hard safety guards.

## Restore Procedure

Restore is re-import plus repair/adopt, always pointed at a clone target.

The phase 1 script is `scripts/restore.sh`.

Default mode is dry-run:

```bash
scripts/restore.sh \
  --snapshot ~/grove-snapshots/20260604T153000Z \
  --target-session dev10-resilience-restore \
  --target-grove-home ~/.grove-restore \
  --target-project-dir ~/grove-projects/dev10-resilience-restore \
  --web-port 19131
```

Mutation requires:

```bash
scripts/restore.sh --execute ...
```

The restore sequence is:

1. Validate the snapshot layout, verify `dot-grove.tgz` against `snapshot.json` when a checksum is
   present, preflight every archive member, and refuse live session/home/port targets. Archive
   members are rejected if they use absolute paths, contain `..` path components, are symlinks,
   hardlinks, or are special files.
2. Resolve the target `GROVE_HOME` and target project directory through their nearest existing
   parents before creating directories, so a missing leaf under a symlinked parent cannot point back
   into live `~/.grove`.
3. Extract `dot-grove.tgz` into the target `GROVE_HOME` only when that directory is empty. A marker
   file records the source snapshot so reruns skip extraction idempotently.
4. Re-import the bundle into the target project directory. If `target-session` differs from the
   bundle name, the script creates a rewritten bundle copy under the target `GROVE_HOME`; it updates
   `bundle.json`, `grove.project.json` project name, and matching board slug. This is a draft
   workaround for the current `import-project` behavior, which preserves bundle names.
5. Run `GROVE_HOME=<target> grove load-project <target-project-dir>` if the target tmux session is
   not already present. `load-project` starts the tmux session and restores nodes with matching
   session transcripts when available.
6. Run `GROVE_HOME=<target> grove repair --session <target-session> --all` to repair/adopt pane and
   transcript bindings inside the clone room.
7. Optionally start `grove-web` against the clone session and clone board DB on a non-live port.

`repair` may report stale or unrecoverable nodes if the cloned transcripts or panes cannot be
resolved. That is a test result, not permission to touch live state.

## Docker Image

The proposed Docker image contains the three repo runtime surfaces:

- TypeScript core CLI from `dist/`.
- Python bridge console scripts: `grove-web`, `grove-bridge-pull`, and `grove-slack`.
- Built web assets from `web/dist`.

The phase 1 Docker draft is `Dockerfile` plus `.dockerignore` and `docker/README.md`. It uses a
multi-stage build from Node 20 on Debian bookworm, installs Python only for bridge packaging,
builds the TypeScript CLI and web SPA from source, builds a bridge wheel, then copies only runtime
artifacts into the final stage. The final image includes Node, Python, tmux, `tini`, the `grove`
CLI, bridge console scripts, web assets, and the draft snapshot/restore scripts.

The Docker context explicitly ignores host runtime state and operational inputs, including
`.grove`, local `dist`, local `node_modules`, snapshot tarballs, SQLite DBs, dashboard tokens,
`web.json`, `fleet.yaml`, `grove.yaml`, and `cockpit.grove.yaml`.

CLI decision: include `grove` in the image for parity and one-shot restore/admin commands, but keep
the host CLI as the primary interactive control surface for local tmux rooms. In local clone tests,
the host owns tmux and agent CLIs; the container can run bridge/web against mounted clone volumes.
In cloud mode, the same image can run as a sidecar next to a tmux/agent runner, or as the web/bridge
process when the runner provides the mounted `GROVE_HOME` and workspace.

Required runtime mounts:

- `/data/grove-home`: target `GROVE_HOME`.
- `/workspace`: project workspace root.
- `/snapshots`: optional snapshot import/export root.

Required runtime environment:

- `GROVE_HOME=/data/grove-home`
- `GROVE_VIEWER_SESSION=<clone-session>`
- `GROVE_WEB_PORT=<non-live-port>`

The container defaults to `GROVE_HOME=/data/grove-home`, `GROVE_VIEWER_SESSION=grove-container`,
and `GROVE_WEB_PORT=8765`. It must not be run with `dev10`, the host `~/.grove`, or port `9131`.

## Cloud-Portability Strategy

The portable unit is a pair:

1. Project bundle: topology and portable project metadata.
2. `dot-grove.tgz`: local runtime state for boards, registries, tokens, web companion data, and
   transcripts that are safe to move for the target environment.

For cloud restore, upload the snapshot directory to object storage as immutable content. A runner
downloads it, restores into a fresh volume, re-imports the bundle into a workspace volume, runs
`load-project`, then `repair --all`, and finally starts bridge/web with explicit host, port, auth,
and allowed-host settings.

Secrets should move to the cloud secret manager before shared access is enabled. Snapshot tokens are
acceptable for isolated clone tests but should be rotated or regenerated for multi-user cloud rooms.
Board DB state is local-first SQLite in phase 1; cloud deployments should mount it on persistent
storage, back it up with the snapshot root, and avoid simultaneous writers until a server-side DB
contract exists.

Cloud networking stays explicit:

- Loopback bind for local validation.
- Tailnet/LAN bind only with `--allow-host` and auth enabled.
- Public internet bind is out of scope for this phase.

## Phase 1 Acceptance

- `docs/design/RESILIENCE.md` documents the snapshot format, restore sequence, Docker image
  strategy, cloud portability, and no-live-interruption rule.
- `scripts/snapshot.sh` and `scripts/restore.sh` are dry-run-first drafts with live guards.
- `Dockerfile`, `.dockerignore`, and `docker/README.md` provide a buildable draft that excludes
  secrets and local runtime state.
- No commit is created.
