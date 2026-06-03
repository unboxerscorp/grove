import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

function tempPathFor(file: string): string {
  const dir = path.dirname(file);
  const base = path.basename(file);
  return path.join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);
}

export function writeFileAtomicSync(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = tempPathFor(file);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, data, "utf8");
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

export async function writeFileAtomic(file: string, data: string): Promise<void> {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = tempPathFor(file);
  await writeFile(temp, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temp, file);
}
