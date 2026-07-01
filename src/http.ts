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
    throw new MediaApiError(`${label} request failed with HTTP ${response.status}`, response.status, redactSecrets(text).slice(0, 500));
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MediaApiError(`${label} returned non-JSON response`, response.status, redactSecrets(text).slice(0, 500));
  }
}

function redactSecrets(value: string) {
  return value
    .replace(/(apikey=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password)["'\s:=]+)["']?[^"',\s}]+/gi, "$1[redacted]")
    .replace(/(authorization["'\s:=]+)["']?[^"',\s}]+/gi, "$1[redacted]");
}

export async function arrGet<T>(app: AppConfig, path: string, params: Record<string, string | number | boolean | undefined> = {}) {
  if (!app.url || !app.apiKey || !app.apiVersion) throw new Error(`${app.label} is not configured`);

  const url = new URL(`/api/${app.apiVersion}/${trimSlashes(path)}`, app.url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      "X-Api-Key": app.apiKey,
      Accept: "application/json",
    },
  });
  return readJson<T>(response, app.label);
}

export async function arrPost<T>(app: AppConfig, path: string, body: unknown) {
  if (!app.url || !app.apiKey || !app.apiVersion) throw new Error(`${app.label} is not configured`);

  const url = new URL(`/api/${app.apiVersion}/${trimSlashes(path)}`, app.url);
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "X-Api-Key": app.apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return readJson<T>(response, app.label);
}

export async function arrPut<T>(app: AppConfig, path: string, body: unknown) {
  if (!app.url || !app.apiKey || !app.apiVersion) throw new Error(`${app.label} is not configured`);

  const url = new URL(`/api/${app.apiVersion}/${trimSlashes(path)}`, app.url);
  const response = await fetch(url, {
    method: "PUT",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "X-Api-Key": app.apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
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

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
  return readJson<T>(response, app.label);
}

export async function jellyfinGet<T>(app: AppConfig, path: string, params: Record<string, string | number | boolean | undefined> = {}) {
  if (!app.url || !app.apiKey) throw new Error(`${app.label} is not configured`);

  const url = new URL(`/${trimSlashes(path)}`, app.url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `MediaBrowser Token="${app.apiKey}"`,
      "X-Emby-Token": app.apiKey,
      Accept: "application/json",
    },
  });
  return readJson<T>(response, app.label);
}

export async function beetsGet<T>(app: AppConfig, path: string, params: Record<string, string | number | boolean | undefined> = {}) {
  if (!app.url) throw new Error(`${app.label} is not configured`);

  const url = new URL(`/${trimSlashes(path)}`, app.url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
  return readJson<T>(response, app.label);
}

export async function slskdGet<T>(app: AppConfig, path: string, params: Record<string, string | number | boolean | undefined> = {}) {
  if (!app.url || !app.apiKey) throw new Error(`${app.label} is not configured`);

  const url = new URL(`/${trimSlashes(path)}`, app.url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      "X-API-Key": app.apiKey,
      Accept: "application/json",
    },
  });
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
      ? `\n\n${redactSecrets(error.body)}`
      : "";
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${error instanceof Error ? error.message : String(error)}${details}` }],
  };
}
