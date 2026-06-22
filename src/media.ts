import { apps, type AppConfig, type AppName, configuredApps, getApp } from "./config.js";
import { arrGet, sabGet } from "./http.js";

type AnyRecord = Record<string, any>;

export type ArrAppName = Extract<AppName, "sonarr" | "radarr" | "lidarr" | "prowlarr">;
export type LibraryAppName = Extract<AppName, "sonarr" | "radarr" | "lidarr">;
export type QueueAppName = Extract<AppName, "sonarr" | "radarr" | "lidarr" | "sabnzbd">;

const libraryApps: LibraryAppName[] = ["sonarr", "radarr", "lidarr"];
const queueApps: QueueAppName[] = ["sonarr", "radarr", "lidarr", "sabnzbd"];

function configuredTargets(appName?: AppName) {
  return appName ? [getApp(appName)] : apps.filter((app) => app.url && app.apiKey);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function bytes(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function itemTitle(record: AnyRecord) {
  return firstString(
    record.title,
    record.sourceTitle,
    record.movie?.title,
    record.series?.title,
    record.artist?.artistName,
    record.album?.title,
    record.name,
    record.filename,
    record.nzb_name,
  ) ?? "unknown";
}

function toSummary<T extends { summary: string }>(result: T): T {
  return result;
}

type OperationResult<T> =
  | { app: AppName; label: string; ok: true; latencyMs: number; data: T }
  | { app: AppName; label: string; ok: false; latencyMs: number; error: string; operation: string };

async function withStatus<T>(app: AppConfig, operation: string, fn: () => Promise<T>): Promise<OperationResult<T>> {
  const started = Date.now();
  try {
    const data = await fn();
    return { app: app.name, label: app.label, ok: true, latencyMs: Date.now() - started, data };
  } catch (error) {
    return { app: app.name, label: app.label, ok: false, latencyMs: Date.now() - started, error: errorMessage(error), operation };
  }
}

async function arrHealth(app: AppConfig) {
  return arrGet<AnyRecord[]>(app, "health");
}

async function arrStatus(app: AppConfig) {
  return arrGet<AnyRecord>(app, "system/status");
}

async function sabVersion(app: AppConfig) {
  return sabGet<{ version?: string }>(app, "version");
}

export async function systemStatus(appName?: AppName) {
  const targets = configuredTargets(appName);
  return Promise.all(
    targets.map(async (app) => {
      if (app.kind === "sabnzbd") {
        const result = await withStatus(app, "version", () => sabVersion(app));
        return result.ok ? { app: app.name, label: app.label, ok: true, version: result.data.version } : result;
      }
      const result = await withStatus(app, "system/status", () => arrStatus(app));
      return result.ok ? { app: app.name, label: app.label, ok: true, ...result.data } : result;
    }),
  );
}

export async function serviceStatus(appName?: AppName) {
  const services = await Promise.all(
    configuredTargets(appName).map(async (app) => {
      if (app.kind === "sabnzbd") {
        const result = await withStatus(app, "version", () => sabVersion(app));
        return {
          service: app.name,
          label: app.label,
          configured: true,
          reachable: result.ok,
          authenticated: result.ok,
          version: result.ok ? result.data.version : undefined,
          latencyMs: result.latencyMs,
          warnings: result.ok ? [] : [result.error],
        };
      }

      const [status, health] = await Promise.all([
        withStatus(app, "system/status", () => arrStatus(app)),
        withStatus(app, "health", () => arrHealth(app)),
      ]);
      const issues = health.ok ? health.data : [];
      return {
        service: app.name,
        label: app.label,
        configured: true,
        reachable: status.ok,
        authenticated: status.ok,
        version: status.ok ? status.data.version : undefined,
        branch: status.ok ? status.data.branch : undefined,
        health: issues.length === 0 ? "ok" : "warning",
        latencyMs: status.latencyMs,
        warnings: [
          ...(status.ok ? [] : [status.error]),
          ...issues.map((issue) => firstString(issue.message, issue.source, issue.type) ?? "health issue"),
        ],
      };
    }),
  );

  const missing = configuredApps().filter((app) => !app.configured);
  const okCount = services.filter((service) => service.reachable && service.authenticated).length;
  return toSummary({
    summary: `${okCount}/${services.length} configured services are reachable. ${missing.length} services have missing env config.`,
    services,
    missing,
  });
}

export async function serviceHealth(appName?: AppName) {
  const services = await Promise.all(
    configuredTargets(appName).map(async (app) => {
      if (app.kind === "sabnzbd") {
        const result = await withStatus(app, "queue", () => sabGet<AnyRecord>(app, "queue"));
        return {
          service: app.name,
          ok: result.ok,
          health: result.ok ? "ok" : "error",
          issues: result.ok ? [] : [{ severity: "error", message: result.error }],
        };
      }

      const result = await withStatus(app, "health", () => arrHealth(app));
      const issues = result.ok
        ? result.data.map((issue) => ({
            severity: issue.type ?? "warning",
            source: issue.source,
            message: firstString(issue.message, issue.source, issue.type) ?? "health issue",
            wikiUrl: issue.wikiUrl,
          }))
        : [{ severity: "error", message: result.error }];
      return {
        service: app.name,
        ok: result.ok && issues.length === 0,
        health: issues.length === 0 ? "ok" : "warning",
        issues,
      };
    }),
  );
  const issueCount = services.reduce((sum, service) => sum + service.issues.length, 0);
  return toSummary({
    summary: issueCount === 0 ? "No health issues reported by configured services." : `${issueCount} health issues reported.`,
    services,
  });
}

export async function diskSpace() {
  const services = await Promise.all(
    apps
      .filter((app) => app.kind === "arr" && app.url && app.apiKey)
      .map(async (app) => {
        const result = await withStatus(app, "diskspace", () => arrGet<AnyRecord[]>(app, "diskspace"));
        return {
          service: app.name,
          ok: result.ok,
          paths: result.ok
            ? result.data.map((disk) => {
                const free = bytes(disk.freeSpace);
                const total = bytes(disk.totalSpace);
                return {
                  path: disk.path,
                  label: disk.label,
                  freeBytes: free,
                  totalBytes: total,
                  usedPercent: free !== undefined && total ? Math.round(((total - free) / total) * 1000) / 10 : undefined,
                };
              })
            : [],
          warnings: result.ok ? [] : [result.error],
        };
      }),
  );

  const low = services.flatMap((service) =>
    service.paths.filter((path) => typeof path.usedPercent === "number" && path.usedPercent >= 90).map((path) => `${service.service}:${path.path}`),
  );
  return toSummary({
    summary: low.length === 0 ? "No service-visible disks are above 90% used." : `${low.length} service-visible paths are above 90% used.`,
    services,
    warnings: low,
  });
}

export async function queue(appName: QueueAppName, pageSize = 20) {
  const app = getApp(appName);
  if (app.kind === "sabnzbd") return sabGet(app, "queue", { limit: pageSize });
  return arrGet(app, "queue", { page: 1, pageSize, sortKey: "timeleft", sortDirection: "ascending" });
}

function normalizeArrQueue(app: AppConfig, response: AnyRecord) {
  const records: AnyRecord[] = Array.isArray(response.records) ? response.records : [];
  return {
    service: app.name,
    total: response.totalRecords ?? records.length,
    items: records.map((record) => ({
      service: app.name,
      title: itemTitle(record),
      status: record.status,
      progress: record.size ? Math.round(((record.size - (record.sizeleft ?? 0)) / record.size) * 1000) / 10 : undefined,
      eta: firstString(record.timeleft, record.estimatedCompletionTime),
      trackedDownloadStatus: record.trackedDownloadStatus,
      statusMessages: record.statusMessages,
    })),
  };
}

function normalizeSabQueue(app: AppConfig, response: AnyRecord) {
  const queueData = response.queue ?? {};
  const slots: AnyRecord[] = Array.isArray(queueData.slots) ? queueData.slots : [];
  return {
    service: app.name,
    total: Number(queueData.noofslots ?? slots.length),
    speed: queueData.speed,
    sizeLeft: queueData.mbleft,
    items: slots.map((slot) => ({
      service: app.name,
      title: itemTitle(slot),
      status: slot.status,
      progress: typeof slot.percentage === "string" ? Number(slot.percentage) : slot.percentage,
      eta: slot.timeleft,
    })),
  };
}

export async function downloadQueue(appName?: QueueAppName, pageSize = 50) {
  const targets = (appName ? [getApp(appName)] : queueApps.map((name) => getApp(name))).filter((app) => app.url && app.apiKey);
  const services = await Promise.all(
    targets.map(async (app) => {
      const result = await withStatus(app, "queue", () => queue(app.name as QueueAppName, pageSize));
      if (!result.ok) return { service: app.name, ok: false, total: 0, items: [], warnings: [result.error] };
      return {
        ok: true,
        ...(app.kind === "sabnzbd" ? normalizeSabQueue(app, result.data as AnyRecord) : normalizeArrQueue(app, result.data as AnyRecord)),
      };
    }),
  );
  const total = services.reduce((sum, service) => sum + Number(service.total ?? 0), 0);
  return toSummary({
    summary: total === 0 ? "No active queue items reported." : `${total} queue items reported across ${services.length} services.`,
    services,
  });
}

export async function history(appName: AppName, pageSize = 20) {
  const app = getApp(appName);
  if (app.kind === "sabnzbd") return sabGet(app, "history", { limit: pageSize });
  return arrGet(app, "history", { page: 1, pageSize, sortKey: "date", sortDirection: "descending" });
}

function normalizeArrHistory(app: AppConfig, response: AnyRecord) {
  const records: AnyRecord[] = Array.isArray(response.records) ? response.records : [];
  return records.map((record) => ({
    service: app.name,
    title: itemTitle(record),
    eventType: record.eventType,
    date: record.date,
    successful: record.eventType ? !String(record.eventType).toLowerCase().includes("fail") : undefined,
  }));
}

function normalizeSabHistory(app: AppConfig, response: AnyRecord) {
  const historyData = response.history ?? {};
  const slots: AnyRecord[] = Array.isArray(historyData.slots) ? historyData.slots : [];
  return slots.map((slot) => ({
    service: app.name,
    title: itemTitle(slot),
    eventType: slot.status,
    date: slot.completed,
    successful: String(slot.status ?? "").toLowerCase() !== "failed",
  }));
}

export async function recentActivity(appName?: AppName, pageSize = 20) {
  const targets = configuredTargets(appName);
  const services = await Promise.all(
    targets.map(async (app) => {
      const result = await withStatus(app, "history", () => history(app.name, pageSize));
      if (!result.ok) return { service: app.name, ok: false, items: [], warnings: [result.error] };
      const items = app.kind === "sabnzbd" ? normalizeSabHistory(app, result.data as AnyRecord) : normalizeArrHistory(app, result.data as AnyRecord);
      return { service: app.name, ok: true, items };
    }),
  );
  const total = services.reduce((sum, service) => sum + service.items.length, 0);
  return toSummary({
    summary: `${total} recent activity items returned across ${services.length} services.`,
    services,
  });
}

export async function calendar(appName: LibraryAppName, start: string, end: string) {
  return arrGet(getApp(appName), "calendar", { start, end });
}

export async function wantedMissing(appName: LibraryAppName, pageSize = 20) {
  return arrGet<AnyRecord>(getApp(appName), "wanted/missing", { page: 1, pageSize, sortKey: "airDateUtc", sortDirection: "ascending" });
}

export async function missingSummary(pageSize = 10) {
  const services = await Promise.all(
    libraryApps.map(async (name) => {
      const app = getApp(name);
      const result = await withStatus(app, "wanted/missing", () => wantedMissing(name, pageSize));
      if (!result.ok) return { service: name, ok: false, total: 0, sample: [], warnings: [result.error] };
      const records: AnyRecord[] = Array.isArray(result.data.records) ? result.data.records : [];
      return {
        service: name,
        ok: true,
        total: result.data.totalRecords ?? records.length,
        sample: records.map((record) => ({
          title: itemTitle(record),
          airDateUtc: record.airDateUtc,
          releaseDate: record.releaseDate,
          monitored: record.monitored,
        })),
      };
    }),
  );
  const total = services.reduce((sum, service) => sum + Number(service.total ?? 0), 0);
  return toSummary({
    summary: `${total} missing wanted items reported across Sonarr/Radarr/Lidarr.`,
    services,
  });
}

export async function libraryCounts() {
  const [sonarrSeries, radarrMovies, lidarrArtists, lidarrAlbums] = await Promise.all([
    withStatus(getApp("sonarr"), "series", () => arrGet<AnyRecord[]>(getApp("sonarr"), "series")),
    withStatus(getApp("radarr"), "movie", () => arrGet<AnyRecord[]>(getApp("radarr"), "movie")),
    withStatus(getApp("lidarr"), "artist", () => arrGet<AnyRecord[]>(getApp("lidarr"), "artist")),
    withStatus(getApp("lidarr"), "album", () => arrGet<AnyRecord[]>(getApp("lidarr"), "album")),
  ]);
  const counts = {
    sonarrSeries: sonarrSeries.ok ? sonarrSeries.data.length : undefined,
    radarrMovies: radarrMovies.ok ? radarrMovies.data.length : undefined,
    lidarrArtists: lidarrArtists.ok ? lidarrArtists.data.length : undefined,
    lidarrAlbums: lidarrAlbums.ok ? lidarrAlbums.data.length : undefined,
  };
  const results = [sonarrSeries, radarrMovies, lidarrArtists, lidarrAlbums];
  const warnings = results.filter((result) => !result.ok).map((result) => `${result.app}: ${result.error}`);
  return toSummary({
    summary: `Library counts loaded for ${Object.values(counts).filter((value) => value !== undefined).length}/4 categories.`,
    counts,
    warnings,
  });
}

export async function importIssues(pageSize = 50) {
  const queueSummary = await downloadQueue(undefined, pageSize);
  const queueServices = (queueSummary.services as Array<{ service: string; items: AnyRecord[] }>) ?? [];
  const queueIssues = queueServices.flatMap((service) =>
    service.items
      .filter((item) => item.trackedDownloadStatus && item.trackedDownloadStatus !== "ok")
      .map((item) => ({
        service: service.service,
        title: item.title,
        status: item.status,
        trackedDownloadStatus: item.trackedDownloadStatus,
        statusMessages: item.statusMessages,
      })),
  );

  const activity = await recentActivity(undefined, pageSize);
  const activityServices = (activity.services as Array<{ service: string; items: AnyRecord[] }>) ?? [];
  const failedHistory = activityServices.flatMap((service) =>
    service.items
      .filter((item) => item.successful === false)
      .map((item) => ({ service: service.service, title: item.title, eventType: item.eventType, date: item.date })),
  );

  return toSummary({
    summary: `${queueIssues.length} queue/import warnings and ${failedHistory.length} failed recent history items found.`,
    queueIssues,
    failedHistory,
  });
}

export async function indexerStatus() {
  const app = getApp("prowlarr");
  const [health, indexers, indexerStatuses] = await Promise.all([
    withStatus(app, "health", () => arrHealth(app)),
    withStatus(app, "indexer", () => arrGet<AnyRecord[]>(app, "indexer")),
    withStatus(app, "indexerstatus", () => arrGet<AnyRecord[]>(app, "indexerstatus")),
  ]);
  const indexerList = indexers.ok ? indexers.data : [];
  const disabled = indexerStatuses.ok ? indexerStatuses.data.filter((status) => status.disabledTill || status.mostRecentFailure) : [];
  return toSummary({
    summary: `${indexerList.length} indexers configured; ${disabled.length} currently have failure/disabled status.`,
    ok: health.ok && indexers.ok && indexerStatuses.ok,
    healthIssues: health.ok ? health.data : [{ message: health.error }],
    indexers: indexerList.map((indexer) => ({
      id: indexer.id,
      name: indexer.name,
      enable: indexer.enable,
      protocol: indexer.protocol,
      priority: indexer.priority,
      tags: indexer.tags,
    })),
    indexerStatuses: indexerStatuses.ok ? indexerStatuses.data : [],
    warnings: [health, indexers, indexerStatuses].filter((result) => !result.ok).map((result) => `${result.operation}: ${result.error}`),
  });
}

export async function mediaStackOverview() {
  const [status, health, queues, missing, disks, indexers, libraries, issues] = await Promise.all([
    serviceStatus(),
    serviceHealth(),
    downloadQueue(),
    missingSummary(5),
    diskSpace(),
    indexerStatus(),
    libraryCounts(),
    importIssues(25),
  ]);
  const services = (status.services as AnyRecord[]) ?? [];
  const reachable = services.filter((service) => service.reachable).length;
  return toSummary({
    summary: `${reachable}/${services.length} services reachable. ${queues.summary} ${missing.summary}`,
    status,
    health,
    queues,
    missing,
    disks,
    indexers,
    libraries,
    issues,
  });
}

export async function prowlarrSearch(query: string, type = "search", limit = 25) {
  const result = await arrGet<unknown[]>(getApp("prowlarr"), "search", { query, type });
  return Array.isArray(result) ? result.slice(0, limit) : result;
}
