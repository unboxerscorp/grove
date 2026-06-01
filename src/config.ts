import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { expandHome } from "./util/paths.js";

export const AgentTypeSchema = z.enum(["codex", "claude"]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const NodeConfigSchema = z
  .object({
    agent: AgentTypeSchema.optional(),
    model: z.string().optional(),
    role: z.string().optional(),
    cwd: z.string().optional(),
    resume: z.string().optional(),
    children: z.array(z.string()).default([]),
    parent: z.string().optional(),
  })
  .strict();
export type NodeConfig = z.infer<typeof NodeConfigSchema>;

export const GroveConfigSchema = z
  .object({
    session: z.string().min(1),
    cwd: z.string().min(1),
    defaults: z
      .object({
        agent: AgentTypeSchema.default("codex"),
        model: z.string().optional(),
      })
      .strict()
      .default({ agent: "codex" }),
    nodes: z.record(z.string(), NodeConfigSchema),
  })
  .strict();
export type GroveConfig = z.infer<typeof GroveConfigSchema>;

export interface ResolvedNode {
  name: string;
  agent: AgentType;
  model?: string;
  role?: string;
  cwd: string;
  resume?: string;
  children: string[];
  parent?: string;
}

const CONFIG_NAMES = ["grove.yaml", "grove.yml", ".grove.yaml"];

export function findConfig(explicit?: string): string {
  if (explicit) {
    const p = path.resolve(expandHome(explicit));
    if (!existsSync(p)) throw new Error(`config not found: ${p}`);
    return p;
  }
  for (const name of CONFIG_NAMES) {
    const p = path.resolve(process.cwd(), name);
    if (existsSync(p)) return p;
  }
  throw new Error(
    `no ${CONFIG_NAMES[0]} found in ${process.cwd()} (pass --config <file> or run \`grove init\`)`,
  );
}

export function loadConfig(explicit?: string): { path: string; config: GroveConfig } {
  const cfgPath = findConfig(explicit);
  const raw = parseYaml(readFileSync(cfgPath, "utf8"));
  const config = GroveConfigSchema.parse(raw);
  return { path: cfgPath, config };
}

export function resolveNodes(config: GroveConfig): ResolvedNode[] {
  const out: ResolvedNode[] = [];
  for (const [name, n] of Object.entries(config.nodes)) {
    out.push({
      name,
      agent: n.agent ?? config.defaults.agent,
      model: n.model ?? config.defaults.model,
      role: n.role,
      cwd: expandHome(n.cwd ?? config.cwd),
      resume: n.resume,
      children: n.children,
      parent: n.parent,
    });
  }
  // Infer parent from declared children when not explicitly set.
  const byName = new Map(out.map((n) => [n.name, n]));
  for (const n of out) {
    for (const childName of n.children) {
      const child = byName.get(childName);
      if (child && !child.parent) child.parent = n.name;
    }
  }
  return out;
}

/** Nodes with no parent (tree roots). */
export function rootNodes(nodes: ResolvedNode[]): ResolvedNode[] {
  return nodes.filter((n) => !n.parent);
}
