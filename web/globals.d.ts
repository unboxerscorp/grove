// Globals the grove web server injects into index.html before the app bundle.
// Kept as a script (no top-level import/export) so they land in global scope.

interface Window {
  // Per-session token; echoed back on REST as the X-Grove-Session-Token header.
  __GROVE_SESSION_TOKEN__?: string;
  // True when the server runs gated (public bind). Drives the auth badge; WS
  // auth always goes through the single-use ticket regardless.
  __GROVE_AUTH_REQUIRED__?: boolean;
}

declare module "*.css";
