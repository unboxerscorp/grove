#!/usr/bin/env python3
"""Copy grove skills from skills-src to local agent surfaces."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path


SKILL_FILE = "SKILL.md"
PLUGIN_SKILLS_DIR = Path("skills")
AGENT_ROOT_DIR = Path(".agents")
AGENT_SKILLS_DIR = AGENT_ROOT_DIR / "skills"
AGENT_INSTRUCTIONS_PATH = AGENT_ROOT_DIR / "AGENTS.md"
MANIFESTS = {
    Path(".runner-plugin") / "plugin.json": {
        "name": "grove-runner-skills",
        "version": "0.1.0",
        "skills": "./skills/",
    },
    Path(".codex-plugin") / "plugin.json": {
        "name": "grove-codex-skills",
        "version": "0.1.0",
        "skills": "./skills/",
    },
}
AGENT_INSTRUCTIONS = """# grove Agent Surface

This directory mirrors grove skills for agent runtimes that read `.agents/skills`.

## Startup

1. Read the project-root `AGENTS.md`.
2. Load the relevant skill from `.agents/skills/*/SKILL.md` before acting.
3. Start with `grove:harness` for org lookup, direct node communication, group work, human-facing item actions, or routing.

## Runtime parity

- Grove skills in this tree must stay byte-for-byte aligned with `skills-src/` and `skills/`.
- `agy` nodes use grove's `antigravity` agent type and follow the same org-awareness and direct-communication model as `codex` and `claude`.
- Interactive grove nodes run in a visible pane; headless mode is only for explicit one-shot checks.
- grove may launch the interactive CLI with `--dangerously-skip-permissions`; that flag does not change repo, board, skill, or handoff rules.
- Interactive submit is paste, Enter, Enter. Live parity verification stays with the lead.
- Nodes do not autonomously create, terminate, or rearrange other nodes. Organization changes require explicit human instruction and the operator-marked GUI/API/CLI path.
"""


@dataclass(frozen=True)
class SkillSource:
    name: str
    description: str
    path: Path
    body: str


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate grove skill target surfaces.")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    sources = load_sources(root / "skills-src")
    if args.check:
        return check_targets(root, sources)
    write_targets(root, sources)
    print(f"generated {len(sources)} grove skills")
    return 0


def load_sources(source_root: Path) -> list[SkillSource]:
    if not source_root.is_dir():
        raise SystemExit(f"missing source directory: {source_root}")
    sources: list[SkillSource] = []
    for skill_dir in sorted(path for path in source_root.iterdir() if path.is_dir()):
        skill_path = skill_dir / SKILL_FILE
        if not skill_path.is_file():
            raise SystemExit(f"missing {SKILL_FILE}: {skill_path}")
        body = skill_path.read_text(encoding="utf-8")
        frontmatter = parse_frontmatter(body, skill_path)
        name = frontmatter.get("name")
        description = frontmatter.get("description")
        if name != skill_dir.name:
            raise SystemExit(f"{skill_path}: frontmatter name must match directory")
        if not description:
            raise SystemExit(f"{skill_path}: description is required")
        sources.append(
            SkillSource(
                name=name,
                description=description,
                path=skill_path,
                body=body,
            )
        )
    return sources


def parse_frontmatter(body: str, path: Path) -> dict[str, str]:
    lines = body.splitlines()
    if not lines or lines[0] != "---":
        raise SystemExit(f"{path}: missing frontmatter")
    values: dict[str, str] = {}
    for line in lines[1:]:
        if line == "---":
            break
        key, separator, value = line.partition(":")
        if not separator:
            raise SystemExit(f"{path}: invalid frontmatter line: {line}")
        key = key.strip()
        value = value.strip()
        if key not in {"name", "description"}:
            raise SystemExit(f"{path}: unsupported frontmatter key: {key}")
        values[key] = value
    else:
        raise SystemExit(f"{path}: unterminated frontmatter")
    if set(values) != {"name", "description"}:
        raise SystemExit(f"{path}: frontmatter must contain only name and description")
    return values


def write_targets(root: Path, sources: list[SkillSource]) -> None:
    expected_names = {source.name for source in sources}
    for target_root in (PLUGIN_SKILLS_DIR, AGENT_SKILLS_DIR):
        target_dir = root / target_root
        if not target_dir.is_dir():
            continue
        for path in target_dir.iterdir():
            if path.is_dir() and path.name not in expected_names:
                shutil.rmtree(path)
    for source in sources:
        copy_skill(source, root / PLUGIN_SKILLS_DIR / source.name / SKILL_FILE)
        copy_skill(source, root / AGENT_SKILLS_DIR / source.name / SKILL_FILE)
    for relative_path, manifest in MANIFESTS.items():
        write_json(root / relative_path, manifest)
    write_text(root / AGENT_INSTRUCTIONS_PATH, AGENT_INSTRUCTIONS)


def copy_skill(source: SkillSource, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source.path, target)


def write_json(path: Path, value: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")


def check_targets(root: Path, sources: list[SkillSource]) -> int:
    failures: list[str] = []
    expected_names = {source.name for source in sources}
    for source in sources:
        for target_root in (PLUGIN_SKILLS_DIR, AGENT_SKILLS_DIR):
            target = root / target_root / source.name / SKILL_FILE
            if not target.is_file():
                failures.append(f"missing target: {target}")
                continue
            if target.read_text(encoding="utf-8") != source.body:
                failures.append(f"stale target: {target}")
    for target_root in (PLUGIN_SKILLS_DIR, AGENT_SKILLS_DIR):
        target_dir = root / target_root
        if not target_dir.is_dir():
            continue
        actual_names = {
            path.name
            for path in target_dir.iterdir()
            if path.is_dir() and (path / SKILL_FILE).is_file()
        }
        for extra in sorted(actual_names - expected_names):
            failures.append(f"extra target: {target_dir / extra / SKILL_FILE}")
    for relative_path, manifest in MANIFESTS.items():
        target = root / relative_path
        if not target.is_file():
            failures.append(f"missing manifest: {target}")
            continue
        try:
            loaded = json.loads(target.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            failures.append(f"invalid manifest json: {target}")
            continue
        if loaded != manifest:
            failures.append(f"stale manifest: {target}")
    instructions = root / AGENT_INSTRUCTIONS_PATH
    if not instructions.is_file():
        failures.append(f"missing agent instructions: {instructions}")
    elif instructions.read_text(encoding="utf-8") != AGENT_INSTRUCTIONS:
        failures.append(f"stale agent instructions: {instructions}")
    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1
    print(f"checked {len(sources)} grove skills")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
