# Coding Rules

These rules define grove's house style across TypeScript core and the Python bridge.

## Gate

Run the full gate before handoff:

```bash
pnpm check
```

The gate is intentionally strict: Prettier, ESLint, TypeScript, Vitest, Ruff, Ruff format, mypy strict, and pytest all have to pass.

## TypeScript

- Use strict TypeScript. Keep `strict` and `noUncheckedIndexedAccess` clean.
- Do not use explicit `any`; model unknown inputs with `unknown`, narrow them, or define a type.
- Use `import type` for type-only imports.
- Do not leave floating promises. Await them or handle rejection explicitly.
- Keep imports sorted by `eslint-plugin-simple-import-sort`.
- Preserve CLI contracts unless the task explicitly changes behavior.
- Add or update Vitest coverage for behavior changes.

## Python

- Python bridge code lives under `bridge/src/grove_bridge`.
- Use Ruff for linting and formatting.
- Use mypy strict for type checking.
- Use pytest for tests under `bridge/tests`.
- Keep public bridge functions typed and small.
- Prefer explicit protocol/data types over untyped dictionaries.

## Collaboration

- Keep edits scoped to the assigned workstream.
- Do not edit generated `dist/` output.
- Do not edit operational fleet configs unless assigned.
- Handoffs must include changed files, verification commands, and residual risks.
- Reviewers report findings first; makers fix or explain each finding before merging.
