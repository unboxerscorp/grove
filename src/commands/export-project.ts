import { access, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { stringify as stringifyYaml } from "yaml";

import {
  parseProjectJson,
  portableProjectFile,
  PROJECT_BUNDLE_MANIFEST,
  PROJECT_BUNDLE_SCAFFOLD,
  PROJECT_BUNDLE_SCHEMA,
  PROJECT_BUNDLE_TYPE,
  scaffoldFromProject,
} from "../project-bundle.js";
import { type GroveProjectFile, PROJECT_FILE_NAME } from "../project-file.js";
import { writeFileAtomic } from "../util/atomic.js";
import { validateGroveName } from "../util/names.js";
import { expandHome } from "../util/paths.js";

export interface ExportProjectOptions {
  out?: string;
  session?: string;
  json?: boolean;
}

export interface ExportProjectResult {
  name: string;
  bundle: string;
  projectFile: string;
  files: {
    manifest: string;
    project: string;
    scaffold: string;
  };
  nodes: number;
}

export interface ExportProjectDeps {
  cwd(): string;
  ensureDir(dir: string): Promise<void>;
  exists(file: string): Promise<boolean>;
  homeDir(): string;
  now(): string;
  readFile(file: string): Promise<string>;
  writeFile(file: string, text: string): Promise<void>;
}

const defaultDeps: ExportProjectDeps = {
  cwd: () => process.cwd(),
  ensureDir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  exists: async (file) => {
    try {
      await access(file);
      return true;
    } catch {
      return false;
    }
  },
  homeDir: () => os.homedir(),
  now: () => new Date().toISOString(),
  readFile: async (file) => readFile(file, "utf8"),
  writeFile: async (file, text) => writeFileAtomic(file, text),
};

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function expectedProjectName(name: string | undefined, opts: ExportProjectOptions): string | null {
  const rawName = trimmed(name);
  const session = trimmed(opts.session);
  if (rawName && session && rawName !== session) {
    throw new Error("export project name and --session must match when both are provided");
  }
  return rawName || session ? validateGroveName((rawName ?? session)!, "project name") : null;
}

function defaultProjectDir(name: string, deps: ExportProjectDeps): string {
  return path.join(deps.homeDir(), "grove-projects", name);
}

function candidateProjectFiles(expected: string | null, deps: ExportProjectDeps): string[] {
  const candidates = [path.join(deps.cwd(), PROJECT_FILE_NAME)];
  if (expected) candidates.push(path.join(defaultProjectDir(expected, deps), PROJECT_FILE_NAME));
  return [...new Set(candidates)];
}

async function loadProjectForExport(
  name: string | undefined,
  opts: ExportProjectOptions,
  deps: ExportProjectDeps,
): Promise<{ project: GroveProjectFile; projectFile: string }> {
  const expected = expectedProjectName(name, opts);
  for (const projectFile of candidateProjectFiles(expected, deps)) {
    if (!(await deps.exists(projectFile))) continue;
    const project = parseProjectJson(await deps.readFile(projectFile), projectFile);
    if (expected && project.name !== expected) {
      throw new Error(`project file name mismatch: expected ${expected}, got ${project.name}`);
    }
    return { project, projectFile };
  }
  throw new Error(
    expected
      ? `project file not found for ${expected}`
      : `project file not found: ${path.join(deps.cwd(), PROJECT_FILE_NAME)}`,
  );
}

function bundleDir(
  project: GroveProjectFile,
  opts: ExportProjectOptions,
  deps: ExportProjectDeps,
): string {
  const out = trimmed(opts.out);
  if (out) return path.resolve(expandHome(out));
  return path.resolve(deps.cwd(), `${project.name}.grove-project`);
}

export async function exportProject(
  name: string | undefined,
  opts: ExportProjectOptions = {},
  deps: ExportProjectDeps = defaultDeps,
): Promise<ExportProjectResult> {
  const loaded = await loadProjectForExport(name, opts, deps);
  const portable = portableProjectFile(loaded.project);
  const bundle = bundleDir(portable, opts, deps);
  if (await deps.exists(bundle)) throw new Error(`bundle path already exists: ${bundle}`);

  await deps.ensureDir(bundle);
  const manifestPath = path.join(bundle, PROJECT_BUNDLE_MANIFEST);
  const projectPath = path.join(bundle, PROJECT_FILE_NAME);
  const scaffoldPath = path.join(bundle, PROJECT_BUNDLE_SCAFFOLD);
  await deps.writeFile(
    manifestPath,
    JSON.stringify(
      {
        exported_at: deps.now(),
        files: {
          project: PROJECT_FILE_NAME,
          scaffold: PROJECT_BUNDLE_SCAFFOLD,
        },
        name: portable.name,
        schema: PROJECT_BUNDLE_SCHEMA,
        type: PROJECT_BUNDLE_TYPE,
      },
      null,
      2,
    ) + "\n",
  );
  await deps.writeFile(projectPath, JSON.stringify(portable, null, 2) + "\n");
  await deps.writeFile(scaffoldPath, stringifyYaml(scaffoldFromProject(portable)));

  return {
    bundle,
    files: {
      manifest: manifestPath,
      project: projectPath,
      scaffold: scaffoldPath,
    },
    name: portable.name,
    nodes: portable.nodes.length,
    projectFile: loaded.projectFile,
  };
}

export function renderExportProjectText(result: ExportProjectResult): string {
  return [
    `project: ${result.name}`,
    `bundle: ${result.bundle}`,
    `nodes: ${result.nodes}`,
    `project-file: ${result.files.project}`,
    `scaffold: ${result.files.scaffold}`,
  ].join("\n");
}

export function renderExportProjectJson(result: ExportProjectResult): string {
  return JSON.stringify(result, null, 2);
}

export async function cmdExportProject(
  name: string | undefined,
  opts: ExportProjectOptions = {},
  deps: ExportProjectDeps = defaultDeps,
): Promise<void> {
  const result = await exportProject(name, opts, deps);
  process.stdout.write(
    `${opts.json ? renderExportProjectJson(result) : renderExportProjectText(result)}\n`,
  );
}
