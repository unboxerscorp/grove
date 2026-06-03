import { z } from "zod";

import {
  type GroveProjectFile,
  GroveProjectFileSchema,
  type ProjectNodeFile,
} from "./project-file.js";

export const PROJECT_BUNDLE_MANIFEST = "bundle.json";
export const PROJECT_BUNDLE_SCAFFOLD = "scaffold.yaml";
export const PROJECT_BUNDLE_TYPE = "grove.project.bundle";
export const PROJECT_BUNDLE_SCHEMA = 1;

export const ProjectBundleManifestSchema = z
  .object({
    schema: z.literal(PROJECT_BUNDLE_SCHEMA),
    type: z.literal(PROJECT_BUNDLE_TYPE),
    name: z.string().min(1),
    exported_at: z.string().min(1),
    files: z
      .object({
        project: z.string().min(1),
        scaffold: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type ProjectBundleManifest = z.infer<typeof ProjectBundleManifestSchema>;

export interface ProjectScaffoldNode {
  agent: ProjectNodeFile["agent"];
  role?: string;
  description?: string;
  parent?: string;
  group?: string;
}

export interface ProjectScaffold {
  nodes: Record<string, ProjectScaffoldNode>;
}

export function parseProjectJson(raw: string, label: string): GroveProjectFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`invalid grove project JSON: ${label}`);
  }
  const result = GroveProjectFileSchema.safeParse(parsed);
  if (!result.success) throw new Error(`invalid grove project file: ${label}`);
  return result.data;
}

export function parseBundleManifestJson(raw: string, label: string): ProjectBundleManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`invalid grove project bundle JSON: ${label}`);
  }
  const result = ProjectBundleManifestSchema.safeParse(parsed);
  if (!result.success) throw new Error(`invalid grove project bundle: ${label}`);
  return result.data;
}

export function portableProjectFile(project: GroveProjectFile): GroveProjectFile {
  return {
    board: project.board,
    created_at: project.created_at,
    name: project.name,
    nodes: project.nodes.map((node) => ({
      agent: node.agent,
      description: node.description,
      group: node.group,
      name: node.name,
      parent: node.parent,
      role: node.role,
    })),
    updated_at: project.updated_at,
    workspace: project.workspace,
  };
}

export function scaffoldFromProject(project: GroveProjectFile): ProjectScaffold {
  const nodes: Record<string, ProjectScaffoldNode> = {};
  for (const node of project.nodes) {
    nodes[node.name] = {
      agent: node.agent,
      description: node.description,
      group: node.group,
      parent: node.parent,
      role: node.role,
    };
  }
  return { nodes };
}
