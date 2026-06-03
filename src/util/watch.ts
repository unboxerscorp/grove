import { type FSWatcher, watch } from "node:fs";
import { dirname } from "node:path";

/**
 * Resolve on the next `fs.watch` event for `path`, or after `ms`, whichever is
 * first. The watcher is always closed. If the file does not exist yet, watch
 * the parent directory so creation/appends can still wake the caller.
 */
export function waitForChangeOrTimeout(path: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let watcher: FSWatcher | undefined;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        watcher?.close();
      } catch {
        /* already closed */
      }
      resolve();
    };
    try {
      watcher = watch(path, finish);
    } catch {
      try {
        watcher = watch(dirname(path), finish);
      } catch {
        /* no watcher available — rely on the timeout */
      }
    }
    watcher?.on("error", finish);
    const timer = setTimeout(finish, ms);
  });
}
