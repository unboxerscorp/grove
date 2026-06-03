// Ambient globals describing the Legacy dashboard host surface this plugin
// binds to at runtime. Kept as a script (no top-level import/export) so the
// declarations land in global scope without an import in each module.

interface LegacySDK {
  React: typeof import("react");
  components?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  utils?: {
    cn?: (...args: unknown[]) => string;
    timeAgo?: (t: number | string) => string;
  };
  // Credentialed JSON helper; throws Error("<status>: <body>") on non-2xx.
  fetchJSON?: <T = unknown>(url: string, init?: RequestInit) => Promise<T>;
  useI18n?: () => unknown;
}

interface LegacyPluginRegistry {
  register: (name: string, component: unknown) => void;
}

interface Window {
  __LEGACY_PLUGIN_SDK__?: LegacySDK;
  __LEGACY_PLUGINS__?: LegacyPluginRegistry;
  __LEGACY_SESSION_TOKEN__?: string;
  // True when the dashboard auth gate is engaged (public bind, no --insecure).
  // Mirrors legacy web/src/lib/api.ts; drives WS auth mode selection.
  __LEGACY_AUTH_REQUIRED__?: boolean;
}

declare module "*.css";
