export interface SafeError {
  code: string;
  message: string;
}

export function safeError(code: string, message: string): SafeError {
  return { code, message };
}

export function logRawError(scope: string, error: unknown): void {
  console.error(`grove ${scope}:`, error);
}
