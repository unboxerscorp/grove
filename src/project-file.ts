import { z } from "zod";

import { AgentTypeSchema } from "./config.js";

export const PROJECT_FILE_NAME = "grove.project.json";

export const ProjectNodeSchema = z
  .object({
    name: z.string().min(1),
    agent: AgentTypeSchema,
    role: z.string().optional(),
    description: z.string().optional(),
    parent: z.string().optional(),
    group: z.string().optional(),
    session_id: z.string().optional(),
  })
  .strict();

export const GroveProjectFileSchema = z
  .object({
    name: z.string().min(1),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    workspace: z.string().min(1),
    nodes: z.array(ProjectNodeSchema),
    board: z
      .object({ slug: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export type GroveProjectFile = z.infer<typeof GroveProjectFileSchema>;
export type ProjectNodeFile = z.infer<typeof ProjectNodeSchema>;
