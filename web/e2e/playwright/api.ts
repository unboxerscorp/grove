import type { APIRequestContext, APIResponse } from "@playwright/test";

// Reusable API helper — the shared foundation for API-contract specs.
//
// Wraps Playwright's request context with the loopback operator token + Origin
// (the grove-web state-change guard requires a same-origin operator). Future
// specs build on this single entry point instead of hand-rolling headers. It is
// intentionally thin: GET/POST/PATCH plus a couple of named convenience calls.
export function makeApi(request: APIRequestContext, baseUrl: string, token: string) {
  const headers: Record<string, string> = {
    "X-Grove-Session-Token": token,
    Origin: baseUrl,
    "Content-Type": "application/json",
  };
  const url = (path: string) => `${baseUrl}${path}`;
  return {
    headers,
    get: (path: string): Promise<APIResponse> => request.get(url(path), { headers }),
    post: (path: string, data: unknown = {}): Promise<APIResponse> => request.post(url(path), { headers, data }),
    patch: (path: string, data: unknown = {}): Promise<APIResponse> => request.patch(url(path), { headers, data }),
    health: (): Promise<APIResponse> => request.get(url("/api/health"), { headers }),
    boardTasks: (board: string): Promise<APIResponse> =>
      request.get(url(`/api/boards/${encodeURIComponent(board)}/tasks`), { headers }),
  };
}
