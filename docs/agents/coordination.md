# Coordination Rules

## Ownership

- Work in the assigned stream unless the lead expands scope.
- If a change crosses streams, name the dependency in the handoff.
- Do not rewrite another maker's work without first identifying the conflict.

## Parallel Work

- Prefer additive changes and narrow patches.
- Keep shared contracts stable unless the task is specifically to change them.
- When changing shared contracts, update tests and docs in the same handoff.

## Review and QA

- Review findings should lead with risks and file references.
- QA reports should include exact commands, environment notes, and reproduction steps.
- A maker may not use reviewer or QA silence as proof of correctness; run the gate.

## Operational Safety

- Treat `fleet.yaml`, `grove.yaml`, and `cockpit.grove.yaml` as operational config.
- Do not edit live fleet config during harness/tooling work.
- Avoid changes that create background processes or persistent sessions unless assigned.
