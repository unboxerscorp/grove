import { z } from "zod";

import { AgentTypeSchema } from "./config.js";
import { GroveNameSchema } from "./util/names.js";

export const PROJECT_FILE_NAME = "grove.project.json";

const RelativeWorkspaceSchema = z
  .string()
  .min(1)
  .refine((workspace) => !workspace.startsWith("/"), {
    message: "workspace must be relative",
  });

export const ProjectNodeSchema = z
  .object({
    name: GroveNameSchema,
    agent: AgentTypeSchema,
    role: z.string().optional(),
    description: z.string().optional(),
    parent: GroveNameSchema.optional(),
    group: GroveNameSchema.optional(),
    session_id: z.string().optional(),
  })
  .strict();

export const GroveProjectFileSchema = z
  .object({
    name: GroveNameSchema,
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    workspace: RelativeWorkspaceSchema,
    nodes: z.array(ProjectNodeSchema),
    board: z.object({ slug: GroveNameSchema }).strict().optional(),
  })
  .strict();

export type GroveProjectFile = z.infer<typeof GroveProjectFileSchema>;
export type ProjectNodeFile = z.infer<typeof ProjectNodeSchema>;
