const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;

function c(code: string, s: string): string {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const color = {
  dim: (s: string) => c("2", s),
  bold: (s: string) => c("1", s),
  red: (s: string) => c("31", s),
  green: (s: string) => c("32", s),
  yellow: (s: string) => c("33", s),
  blue: (s: string) => c("34", s),
  magenta: (s: string) => c("35", s),
  cyan: (s: string) => c("36", s),
  gray: (s: string) => c("90", s),
};

const tag = color.green("grove");

// Logs go to stderr so stdout stays clean for command results.
export function info(msg: string): void {
  console.error(`${tag} ${msg}`);
}
export function warn(msg: string): void {
  console.error(`${tag} ${color.yellow("warn")} ${msg}`);
}
export function err(msg: string): void {
  console.error(`${tag} ${color.red("error")} ${msg}`);
}
export function step(msg: string): void {
  console.error(`${tag} ${color.cyan("›")} ${msg}`);
}
