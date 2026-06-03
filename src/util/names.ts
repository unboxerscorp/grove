import { z } from "zod";

export const GROVE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const GroveNameSchema = z
  .string()
  .regex(
    GROVE_NAME_RE,
    "must start with a letter or digit and contain only letters, digits, hyphen, or underscore",
  );

export function validateGroveName(value: string, label: string): string {
  const parsed = GroveNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label} must match ${GROVE_NAME_RE}`);
  }
  return parsed.data;
}
