import { apps, type AppName, getApp } from "./config.js";
import { arrGet, sabGet } from "./http.js";

export type ArrAppName = Extract<AppName, "sonarr" | "radarr" | "lidarr" | "prowlarr">;
export type LibraryAppName = Extract<AppName, "sonarr" | "radarr" | "lidarr">;
export type QueueAppName = Extract<AppName, "sonarr" | "radarr" | "lidarr" | "sabnzbd">;

export async function systemStatus(appName?: AppName) {
  const targets = appName ? [getApp(appName)] : apps.filter((app) => app.url && app.apiKey);
  return Promise.all(
    targets.map(async (app) => {
      try {
        if (app.kind === "sabnzbd") {
          const version = await sabGet<{ version: string }>(app, "version");
          return { app: app.name, label: app.label, ok: true, version: version.version };
        }
        const status = await arrGet<Record<string, unknown>>(app, "system/status");
        return { app: app.name, label: app.label, ok: true, ...status };
      } catch (error) {
        return {
          app: app.name,
          label: app.label,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

export async function queue(appName: QueueAppName, pageSize = 20) {
  const app = getApp(appName);
  if (app.kind === "sabnzbd") return sabGet(app, "queue", { limit: pageSize });
  return arrGet(app, "queue", { page: 1, pageSize, sortKey: "timeleft", sortDirection: "ascending" });
}

export async function history(appName: AppName, pageSize = 20) {
  const app = getApp(appName);
  if (app.kind === "sabnzbd") return sabGet(app, "history", { limit: pageSize });
  return arrGet(app, "history", { page: 1, pageSize, sortKey: "date", sortDirection: "descending" });
}

export async function calendar(appName: LibraryAppName, start: string, end: string) {
  return arrGet(getApp(appName), "calendar", { start, end });
}

export async function wantedMissing(appName: LibraryAppName, pageSize = 20) {
  return arrGet(getApp(appName), "wanted/missing", { page: 1, pageSize, sortKey: "airDateUtc", sortDirection: "ascending" });
}

export async function prowlarrSearch(query: string, type = "search", limit = 25) {
  const result = await arrGet<unknown[]>(getApp("prowlarr"), "search", { query, type });
  return Array.isArray(result) ? result.slice(0, limit) : result;
}
