# grove Docker Draft

This image is for clone-to-test and cloud-portable experiments. It must not be built with or run
against live `dev10`, the host `~/.grove`, or host live web ports `8765`/legacy `9131`. Mapping a
non-live host port to the container's internal `8765` is fine.

Build:

```bash
docker build -t grove-cockpit:resilience .
```

Run a clone room by mounting isolated state and workspace directories:

```bash
docker run --rm -it \
  -p 18765:8765 \
  -e GROVE_HOME=/data/grove-home \
  -e GROVE_VIEWER_SESSION=dev10-resilience-restore \
  -v "$HOME/.grove-restore:/data/grove-home" \
  -v "$HOME/grove-projects/dev10-resilience-restore:/workspace" \
  -v "$HOME/grove-snapshots:/snapshots:ro" \
  grove-cockpit:resilience
```

The runtime image contains:

- `grove` from the built TypeScript CLI.
- `grove-web`, `grove-bridge-pull`, and `grove-slack` from the Python bridge package.
- Built web assets under `/opt/grove/web/dist`.
- Draft snapshot/restore scripts under `/opt/grove/scripts`.

Runtime state belongs in mounted volumes:

- `/data/grove-home`: clone `GROVE_HOME`.
- `/workspace`: clone project workspace.
- `/snapshots`: optional read-only snapshot source.

The Dockerfile does not copy host runtime state, operational fleet configs, tokens, local
`node_modules`, local `dist`, or snapshot tarballs.
