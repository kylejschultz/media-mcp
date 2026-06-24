import type { AppConfig, AppName } from "./config.js";

export type OperationResult<T> =
  | { app: AppName; label: string; ok: true; latencyMs: number; data: T }
  | { app: AppName; label: string; ok: false; latencyMs: number; error: string; operation: string };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function withStatus<T>(app: AppConfig, operation: string, fn: () => Promise<T>): Promise<OperationResult<T>> {
  const started = Date.now();
  try {
    const data = await fn();
    return { app: app.name, label: app.label, ok: true, latencyMs: Date.now() - started, data };
  } catch (error) {
    return { app: app.name, label: app.label, ok: false, latencyMs: Date.now() - started, error: errorMessage(error), operation };
  }
}

export function toSummary<T extends { summary: string; warnings?: unknown[]; errors?: unknown[] }>(
  result: T,
): T & { checkedAt: string; warnings: unknown[]; errors: unknown[] } {
  return {
    ...result,
    checkedAt: new Date().toISOString(),
    warnings: result.warnings ?? [],
    errors: result.errors ?? [],
  };
}
