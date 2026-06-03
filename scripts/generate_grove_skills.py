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
AGENT_SKILLS_DIR = Path(".agents") / "skills"
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
    if len(sources) != 6:
        raise SystemExit(f"expected 6 skills, found {len(sources)}")
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
    for source in sources:
        copy_skill(source, root / PLUGIN_SKILLS_DIR / source.name / SKILL_FILE)
        copy_skill(source, root / AGENT_SKILLS_DIR / source.name / SKILL_FILE)
    for relative_path, manifest in MANIFESTS.items():
        write_json(root / relative_path, manifest)


def copy_skill(source: SkillSource, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source.path, target)


def write_json(path: Path, value: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def check_targets(root: Path, sources: list[SkillSource]) -> int:
    failures: list[str] = []
    for source in sources:
        for target_root in (PLUGIN_SKILLS_DIR, AGENT_SKILLS_DIR):
            target = root / target_root / source.name / SKILL_FILE
            if not target.is_file():
                failures.append(f"missing target: {target}")
                continue
            if target.read_text(encoding="utf-8") != source.body:
                failures.append(f"stale target: {target}")
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
    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1
    print(f"checked {len(sources)} grove skills")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
