# Workstream Registry

## grove-core

Owns the TypeScript CLI, adapters, registry, tmux operations, durable event log, watch loop, fan-in, wait, gather, and tests under `src/`.

## bridge

Owns Python integration code under `bridge/`, including future process bridges, adapters, protocol shims, and Python-side tests.

## ui

Owns future cockpit UI surfaces. Until a UI directory exists, ui agents should produce plans or prototypes only when assigned by the lead.

## reviewer

Owns read-only review. Focus on correctness, regressions, missing tests, contract drift, and unsafe operational changes.

## qa

Owns verification plans and execution. QA may add tests when assigned, but should otherwise report reproducible commands and observed failures.

## harness

Owns repo-wide tooling, gates, hooks, coding rules, and agent coordination documents.
