import type { AppConfig } from "./config.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class MediaApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new MediaApiError(`${label} request failed with HTTP ${response.status}`, response.status, text.slice(0, 500));
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MediaApiError(`${label} returned non-JSON response`, response.status, text.slice(0, 500));
  }
}

export async function arrGet<T>(app: AppConfig, path: string, params: Record<string, string | number | boolean | undefined> = {}) {
  if (!app.url || !app.apiKey || !app.apiVersion) throw new Error(`${app.label} is not configured`);

  const url = new URL(`/api/${app.apiVersion}/${trimSlashes(path)}`, app.url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      "X-Api-Key": app.apiKey,
      Accept: "application/json",
    },
  });
  return readJson<T>(response, app.label);
}

export async function sabGet<T>(app: AppConfig, mode: string, params: Record<string, string | number | boolean | undefined> = {}) {
  if (!app.url || !app.apiKey) throw new Error(`${app.label} is not configured`);

  const url = new URL("/api", app.url);
  url.searchParams.set("apikey", app.apiKey);
  url.searchParams.set("output", "json");
  url.searchParams.set("mode", mode);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  return readJson<T>(response, app.label);
}

export function jsonText(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function errorText(error: unknown) {
  const details =
    error instanceof MediaApiError && error.body
      ? `\n\n${error.body}`
      : "";
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${error instanceof Error ? error.message : String(error)}${details}` }],
  };
}
