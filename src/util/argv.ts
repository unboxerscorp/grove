export function rawVariadicMessage(
  command: string,
  fixedArg: string,
  parsedParts: string[],
  argv: string[] = process.argv,
): string {
  const fallback = parsedParts.join(" ");
  const commandIndex = argv.findIndex((arg, index) => index >= 2 && arg === command);
  if (commandIndex < 0) return fallback;

  for (let index = commandIndex + 1; index < argv.length; index += 1) {
    if (argv[index] !== fixedArg) continue;
    const candidate = argv.slice(index + 1, index + 1 + parsedParts.length);
    if (
      candidate.length === parsedParts.length &&
      candidate.every((part, i) => part === parsedParts[i])
    ) {
      return candidate.join(" ");
    }
  }
  return fallback;
}
