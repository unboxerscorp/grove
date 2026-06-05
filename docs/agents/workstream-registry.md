# Workstream Registry

## grove-core

Owns the TypeScript CLI, adapters, registry, tmux operations, durable event log, watch loop, fan-in, wait, gather, and tests under `src/`.

## bridge

Owns Python integration code under `bridge/`, including future process bridges, adapters, protocol shims, and Python-side tests.

## ui

Owns cockpit UI surfaces under `web/` and related product-facing flows. UI ownership is a coordination label, not a restriction on who may inspect or fix UI when the human request or practical task requires it.

## reviewer

Owns review focus: correctness, regressions, missing tests, contract drift, and unsafe operational changes. Reviewer is a default role, not a capability limit; reviewers may run checks and make changes when explicitly asked or when it is the practical route.

## qa

Owns verification plans, execution, reproducible commands, environment notes, and observed failures. QA may add tests or make focused fixes when explicitly asked or when that is the practical route.

## harness

Owns repo-wide tooling, gates, hooks, coding rules, and agent coordination documents.
