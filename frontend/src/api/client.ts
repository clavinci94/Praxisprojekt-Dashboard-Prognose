// Forecasting/src/api/client.ts
export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export class ApiError extends Error {
  status: number;
  body?: unknown;

  constructor(status: number, body?: unknown) {
    super(`API Error ${status}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Wichtig:
 * - Default ist "/api" (passt zum Vite-Proxy)
 * - Wenn du VITE_API_BASE_URL setzt, dann bitte OHNE doppeltes /api.
 *   Empfehlung:
 *   - Dev: gar nicht setzen (nimmt "/api")
 *   - Oder: VITE_API_BASE_URL="/api"
 *   - Oder (ohne Proxy): VITE_API_BASE_URL="http://localhost:8080/api"
 */
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/json");

  if (init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
  });

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, data);
  }

  return data as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "GET" });
}
