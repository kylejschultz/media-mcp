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

export async function navidromeGet<T>(app: AppConfig, method: string, params: Record<string, string | number | boolean | undefined> = {}) {
  if (!app.url || !app.username || !app.password) throw new Error(`${app.label} is not configured`);

  const url = new URL(`/rest/${trimSlashes(method)}.view`, app.url);
  url.searchParams.set("u", app.username);
  url.searchParams.set("p", app.password);
  url.searchParams.set("v", "1.16.1");
  url.searchParams.set("c", "media-mcp");
  url.searchParams.set("f", "json");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
  const body = await readJson<Record<string, any>>(response, app.label);
  const root = body["subsonic-response"] ?? body;
  if (root.status && root.status !== "ok") {
    const message = root.error?.message ?? `${app.label} Subsonic request failed`;
    throw new MediaApiError(message, response.status, redactSecrets(JSON.stringify(root.error ?? root)).slice(0, 500));
  }
  return root as T;
}

function basicAuthHeader(app: AppConfig) {
  if (!app.username || !app.password) throw new Error(`${app.label} admin credentials are not configured`);
  return `Basic ${Buffer.from(`${app.username}:${app.password}`).toString("base64")}`;
}

export async function subwaveGet<T>(app: AppConfig, path: string, params: Record<string, string | number | boolean | undefined> = {}) {
  if (!app.url) throw new Error(`${app.label} is not configured`);

  const url = new URL(`/${trimSlashes(path)}`, app.url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
  return readJson<T>(response, app.label);
}

export async function subwaveAdminGet<T>(app: AppConfig, path: string, params: Record<string, string | number | boolean | undefined> = {}) {
  if (!app.url) throw new Error(`${app.label} is not configured`);

  const url = new URL(`/${trimSlashes(path)}`, app.url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      Accept: "application/json",
      Authorization: basicAuthHeader(app),
    },
  });
  return readJson<T>(response, app.label);
}

export async function subwaveText(app: AppConfig, path: string) {
  if (!app.url) throw new Error(`${app.label} is not configured`);

  const url = new URL(`/${trimSlashes(path)}`, app.url);
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: "text/plain,*/*" } });
  const text = await response.text();
  if (!response.ok) {
    throw new MediaApiError(`${app.label} request failed with HTTP ${response.status}`, response.status, redactSecrets(text).slice(0, 500));
  }
  return text;
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
