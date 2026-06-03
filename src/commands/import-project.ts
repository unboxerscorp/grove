import { access, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseBundleManifestJson,
  parseProjectJson,
  portableProjectFile,
  PROJECT_BUNDLE_MANIFEST,
} from "../project-bundle.js";
import { PROJECT_FILE_NAME } from "../project-file.js";
import { writeFileAtomic } from "../util/atomic.js";
import { expandHome } from "../util/paths.js";

export interface ImportProjectOptions {
  dir?: string;
  json?: boolean;
}

export interface ImportProjectResult {
  name: string;
  bundle: string;
  dir: string;
  projectFile: string;
  workspace: string;
  nodes: number;
  nextSteps: string[];
}

export interface ImportProjectDeps {
  ensureDir(dir: string): Promise<void>;
  exists(file: string): Promise<boolean>;
  homeDir(): string;
  readFile(file: string): Promise<string>;
  writeFile(file: string, text: string): Promise<void>;
}

const defaultDeps: ImportProjectDeps = {
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
  readFile: async (file) => readFile(file, "utf8"),
  writeFile: async (file, text) => writeFileAtomic(file, text),
};

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function ensureContained(root: string, resolved: string, label: string, value: string): void {
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} must stay inside the project root: ${value}`);
  }
}

function resolveRelative(root: string, value: string, label: string): string {
  if (path.isAbsolute(value)) throw new Error(`${label} must be relative: ${value}`);
  const resolved = path.resolve(root, value);
  ensureContained(root, resolved, label, value);
  return resolved;
}

function destinationDir(
  projectName: string,
  opts: ImportProjectOptions,
  deps: ImportProjectDeps,
): string {
  const dir = trimmed(opts.dir);
  if (dir) return path.resolve(expandHome(dir));
  return path.join(deps.homeDir(), "grove-projects", projectName);
}

export async function importProject(
  bundleInput: string,
  opts: ImportProjectOptions = {},
  deps: ImportProjectDeps = defaultDeps,
): Promise<ImportProjectResult> {
  const bundle = path.resolve(expandHome(bundleInput));
  const manifestPath = path.join(bundle, PROJECT_BUNDLE_MANIFEST);
  if (!(await deps.exists(manifestPath)))
    throw new Error(`project bundle manifest not found: ${manifestPath}`);

  const manifest = parseBundleManifestJson(await deps.readFile(manifestPath), manifestPath);
  const bundledProjectFile = resolveRelative(bundle, manifest.files.project, "bundle project file");
  if (!(await deps.exists(bundledProjectFile))) {
    throw new Error(`bundled project file not found: ${bundledProjectFile}`);
  }
  const project = portableProjectFile(
    parseProjectJson(await deps.readFile(bundledProjectFile), bundledProjectFile),
  );
  if (project.name !== manifest.name) {
    throw new Error(
      `bundle project name mismatch: manifest ${manifest.name}, project ${project.name}`,
    );
  }

  const dir = destinationDir(project.name, opts, deps);
  const projectFile = path.join(dir, PROJECT_FILE_NAME);
  if (await deps.exists(projectFile))
    throw new Error(`project file already exists: ${projectFile}`);

  const workspace = resolveRelative(dir, project.workspace, "project workspace");
  await deps.ensureDir(dir);
  await deps.ensureDir(workspace);
  await deps.writeFile(projectFile, JSON.stringify(project, null, 2) + "\n");

  return {
    bundle,
    dir,
    name: project.name,
    nextSteps: [`grove load-project ${dir}`, `grove-web --session ${project.name}`],
    nodes: project.nodes.length,
    projectFile,
    workspace,
  };
}

export function renderImportProjectText(result: ImportProjectResult): string {
  return [
    `project: ${result.name}`,
    `dir: ${result.dir}`,
    `workspace: ${result.workspace}`,
    `nodes: ${result.nodes}`,
    "next:",
    ...result.nextSteps.map((step) => `- ${step}`),
  ].join("\n");
}

export function renderImportProjectJson(result: ImportProjectResult): string {
  return JSON.stringify(result, null, 2);
}

export async function cmdImportProject(
  bundle: string,
  opts: ImportProjectOptions = {},
  deps: ImportProjectDeps = defaultDeps,
): Promise<void> {
  const result = await importProject(bundle, opts, deps);
  process.stdout.write(
    `${opts.json ? renderImportProjectJson(result) : renderImportProjectText(result)}\n`,
  );
}
