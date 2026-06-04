# grove v1.27 — Roadmap

> Status: autonomous build (after v1.26.0). Headline = **drive nodes from the web** (user's
> "ideal picture"): a per-node command input + a per-node "SSH connect" copy button. Safety-first.

## Workstreams

- **V27-W1 web→node command + connect info (bridge)** — `POST /api/nodes/{node}/send` writes a
  prompt/command to the node's tmux pane (grove send equivalent: send-keys text + Enter), and a
  read-only connect-info endpoint returns the node's tmux target + an SSH/attach command string.
  **operator/admin only** (viewers 403), project-scoped (strict node-name + pane allowlist),
  audited (actor+node, message redacted), rate-limited, default OFF (--enable-node-input). No
  secret beyond what the user is authorized for. Adversarially tested (non-operator send blocked,
  pane outside project blocked, injection/secret in audit).
- **V27-W2 node command box + SSH-connect button (web)** — on the node/terminal view: an
  operator-only send box (disabled for viewers) → POST send; the live terminal already streams the
  result. A per-node **"SSH 접속 명령어"** copy button (copies the connect string). Palette-reachable.
- **V27-W3 brainstorm → MASTER (arch)** — design the MASTER node (Codex governs ~/dev) + floating
  web chat + grove-feedback→grove-dev-team routing (the headline vision); + README.
- **Wave-2** — pending feedback: board-query FE, tutorial+sidebar entry, GROVE logo (Codex asset);
  real-server e2e for the new endpoints.

## Exit criteria

Web command-send to a node (operator-gated, audited, default OFF, pane-scoped) + SSH-connect copy;
no non-operator/cross-project send; full check + e2e green; CHANGELOG + README + 0.28.0.

## Conventions

Unchanged + safety-first: web→node send is a powerful mutation → operator-only, scoped, audited,
rate-limited, default OFF, adversarial review; per-node SSH only the authorized connect string;
dogfood (board-tracked, delegate); push + README + :9131 refresh at release; one writer per area.
