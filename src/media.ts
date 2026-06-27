import { apps, type AppConfig, type AppName, configuredApps, getApp } from "./config.js";
import {
  arrHealth,
  arrQualityProfiles,
  arrRootFolders,
  arrStatus,
  arrTags,
  beetsInboxTree,
  beetsJobs,
  beetsLibraryStats,
  beetsQueues,
  beetsWorkers,
  jellyfinSystemInfo,
  radarrAddMovie,
  radarrMovieLookup,
  radarrMovies,
  sabVersion,
  sonarrAddSeries,
  sonarrSeries,
  sonarrSeriesLookup,
  slskdDownloads,
  slskdServer,
  slskdShares,
  slskdUploads,
} from "./adapters.js";
import { arrGet, jellyfinGet, sabGet } from "./http.js";
import { bytes, completedAfterFailure, firstString, itemTitle } from "./format.js";
import { toSummary, withStatus } from "./results.js";
import { requireRequestToolsEnabled, safetyStatus } from "./safety.js";
import { expectedServiceIssue, getStackFlow, getStackModel, type StackFlowName } from "./stack-model.js";
import { diskApps, libraryApps, queueApps, type AnyRecord, type LibraryAppName, type QueueAppName } from "./types.js";
import {
  componentView,
  countTone,
  healthTone,
  panelState,
  serviceLabel,
  withViewState,
  type DiscordComponentField,
  type DiscordComponentSpec,
  type ViewItem,
  type ViewMetric,
} from "./views.js";

function configuredTargets(appName?: AppName) {
  return appName ? [getApp(appName)] : apps.filter((app) => app.url && (!app.keyEnv || app.apiKey));
}

function futureDateLabel(value?: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) return undefined;
  return value.slice(0, 10);
}

function normalizeHealthIssues(app: AppConfig, issues: AnyRecord[]) {
  return issues.map((issue) => {
    const message = firstString(issue.message, issue.source, issue.type) ?? "health issue";
    const expected = expectedServiceIssue(app.name, { source: issue.source, message });
    return {
      severity: expected ? "expected" : issue.type ?? "warning",
      source: issue.source,
      message,
      wikiUrl: issue.wikiUrl,
      expected: Boolean(expected),
      interpretation: expected?.interpretation,
      verifyWith: expected?.verifyWith,
    };
  });
}

function configuredJellyfin() {
  return getApp("jellyfin");
}

export async function systemStatus(appName?: AppName) {
  const targets = configuredTargets(appName);
  return Promise.all(
    targets.map(async (app) => {
      if (app.kind === "sabnzbd") {
        const result = await withStatus(app, "version", () => sabVersion(app));
        return result.ok ? { app: app.name, label: app.label, ok: true, version: result.data.version } : result;
      }
      if (app.kind === "jellyfin") {
        const result = await withStatus(app, "System/Info", () => jellyfinSystemInfo(app));
        return result.ok
          ? {
              app: app.name,
              label: app.label,
              ok: true,
              version: result.data.Version,
              serverName: result.data.ServerName,
              operatingSystem: result.data.OperatingSystem,
              startupWizardCompleted: result.data.StartupWizardCompleted,
            }
          : result;
      }
      if (app.kind === "beets-flask") {
        const result = await withStatus(app, "api_v1/library/stats", () => beetsLibraryStats(app));
        return result.ok
          ? { app: app.name, label: app.label, ok: true, libraryPath: result.data.libraryPath, items: result.data.items, albums: result.data.albums }
          : result;
      }
      if (app.kind === "slskd") {
        const result = await withStatus(app, "api/v0/server", () => slskdServer(app));
        return result.ok
          ? { app: app.name, label: app.label, ok: true, state: result.data.state, connected: result.data.isConnected, loggedIn: result.data.isLoggedIn }
          : result;
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
      if (app.kind === "jellyfin") {
        const result = await withStatus(app, "System/Info", () => jellyfinSystemInfo(app));
        return {
          service: app.name,
          label: app.label,
          configured: true,
          reachable: result.ok,
          authenticated: result.ok,
          version: result.ok ? result.data.Version : undefined,
          branch: undefined,
          health: result.ok ? "ok" : "error",
          latencyMs: result.latencyMs,
          warnings: result.ok ? [] : [result.error],
        };
      }
      if (app.kind === "beets-flask") {
        const result = await withStatus(app, "api_v1/library/stats", () => beetsLibraryStats(app));
        return {
          service: app.name,
          label: app.label,
          configured: true,
          reachable: result.ok,
          authenticated: result.ok,
          version: undefined,
          health: result.ok ? "ok" : "error",
          latencyMs: result.latencyMs,
          warnings: result.ok ? [] : [result.error],
          details: result.ok ? { albums: result.data.albums, items: result.data.items, libraryPath: result.data.libraryPath } : undefined,
        };
      }
      if (app.kind === "slskd") {
        const result = await withStatus(app, "api/v0/server", () => slskdServer(app));
        return {
          service: app.name,
          label: app.label,
          configured: true,
          reachable: result.ok,
          authenticated: result.ok,
          version: undefined,
          health: result.ok && result.data.isConnected && result.data.isLoggedIn ? "ok" : "warning",
          latencyMs: result.latencyMs,
          warnings: result.ok
            ? [
                ...(!result.data.isConnected ? ["Soulseek server is not connected"] : []),
                ...(!result.data.isLoggedIn ? ["Soulseek user is not logged in"] : []),
              ]
            : [result.error],
          details: result.ok ? { state: result.data.state } : undefined,
        };
      }

      const [status, health] = await Promise.all([
        withStatus(app, "system/status", () => arrStatus(app)),
        withStatus(app, "health", () => arrHealth(app)),
      ]);
      const issues = health.ok ? health.data : [];
      const normalizedIssues = normalizeHealthIssues(app, issues);
      const unexpectedIssues = normalizedIssues.filter((issue) => !issue.expected);
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
        warnings: [...(status.ok ? [] : [status.error]), ...unexpectedIssues.map((issue) => issue.message)],
        expectedWarnings: normalizedIssues.filter((issue) => issue.expected),
      };
    }),
  );

  const missing = configuredApps().filter((app) => !app.configured);
  const okCount = services.filter((service) => service.reachable && service.authenticated).length;
  const warnings = [
    ...services.flatMap((service) => service.warnings?.map((warning: string) => `${service.service}: ${warning}`) ?? []),
    ...missing.map((app) => `${app.name}: missing config`),
  ];
  const summary = `${okCount}/${services.length} configured services are reachable. ${missing.length} services have missing env config.`;
  return toSummary({
    summary,
    view: withViewState(componentView("Service Status", summary, [
      {
        id: "reachability",
        title: "Reachability",
        tone: okCount === services.length && missing.length === 0 ? "ok" : "warning",
        metrics: [
          { label: "Reachable", value: `${okCount}/${services.length}`, tone: okCount === services.length ? "ok" : "warning" },
          { label: "Missing Config", value: missing.length, tone: countTone(missing.length) },
        ],
        items: services.map((service) => ({
          label: service.label,
          value: service.version ?? (service.reachable ? "reachable" : "offline"),
          detail: service.warnings?.[0],
          tone: service.reachable && service.authenticated && service.warnings.length === 0 ? "ok" : "warning",
        })),
      },
    ]), panelState({ warnings })),
    services,
    missing,
    warnings,
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
      if (app.kind === "jellyfin") {
        const result = await withStatus(app, "System/Info", () => jellyfinSystemInfo(app));
        return {
          service: app.name,
          ok: result.ok,
          health: result.ok ? "ok" : "error",
          issues: result.ok ? [] : [{ severity: "error", message: result.error }],
        };
      }
      if (app.kind === "beets-flask") {
        const [queues, workers, jobs] = await Promise.all([
          withStatus(app, "api_v1/monitor/queues", () => beetsQueues(app)),
          withStatus(app, "api_v1/monitor/workers", () => beetsWorkers(app)),
          withStatus(app, "api_v1/monitor/jobs", () => beetsJobs(app)),
        ]);
        const queueRecords = queues.ok ? Object.values((queues.data.queues as AnyRecord | undefined) ?? {}) as AnyRecord[] : [];
        const workerRecords = workers.ok ? Object.values((workers.data.workers as AnyRecord | undefined) ?? {}) as AnyRecord[] : [];
        const failedJobs = queueRecords.reduce((sum, queue) => sum + Number(queue.failed ?? 0), 0);
        const issues = [
          ...(queues.ok ? [] : [{ severity: "error", message: queues.error }]),
          ...(workers.ok ? [] : [{ severity: "error", message: workers.error }]),
          ...(jobs.ok ? [] : [{ severity: "error", message: jobs.error }]),
          ...(failedJobs > 0 ? [{ severity: "warning", message: `${failedJobs} failed beets-flask queue jobs reported` }] : []),
          ...(workerRecords.length === 0 ? [{ severity: "warning", message: "No beets-flask workers reported" }] : []),
        ];
        return {
          service: app.name,
          ok: issues.length === 0,
          health: issues.length === 0 ? "ok" : "warning",
          issues,
          queues: queueRecords,
          workers: workerRecords.length,
          activeJobs: jobs.ok ? jobs.data.length : undefined,
        };
      }
      if (app.kind === "slskd") {
        const result = await withStatus(app, "api/v0/server", () => slskdServer(app));
        const issues = result.ok
          ? [
              ...(!result.data.isConnected ? [{ severity: "warning", message: "Soulseek server is not connected" }] : []),
              ...(!result.data.isLoggedIn ? [{ severity: "warning", message: "Soulseek user is not logged in" }] : []),
            ]
          : [{ severity: "error", message: result.error }];
        return {
          service: app.name,
          ok: result.ok && issues.length === 0,
          health: issues.length === 0 ? "ok" : "warning",
          issues,
          state: result.ok ? result.data.state : undefined,
        };
      }

      const result = await withStatus(app, "health", () => arrHealth(app));
      const issues = result.ok ? normalizeHealthIssues(app, result.data) : [{ severity: "error", message: result.error, expected: false }];
      const unexpectedIssues = issues.filter((issue) => !issue.expected);
      return {
        service: app.name,
        ok: result.ok && unexpectedIssues.length === 0,
        health: unexpectedIssues.length === 0 ? "ok" : "warning",
        issues,
        expectedIssues: issues.filter((issue) => issue.expected),
      };
    }),
  );
  const issueCount = services.reduce((sum, service) => sum + service.issues.filter((issue: AnyRecord) => !issue.expected).length, 0);
  const expectedCount = services.reduce((sum, service) => sum + service.issues.filter((issue: AnyRecord) => issue.expected).length, 0);
  const summary =
    issueCount === 0
      ? expectedCount === 0
        ? "No health issues reported by configured services."
        : `No unexpected health issues reported; ${expectedCount} expected stack-design warning noted.`
      : `${issueCount} unexpected health issues reported; ${expectedCount} expected stack-design warnings noted.`;
  const warnings = services.flatMap((service) =>
    service.issues
      .filter((issue: AnyRecord) => !issue.expected)
      .map((issue: AnyRecord) => `${service.service}: ${issue.message}`),
  );
  return toSummary({
    summary,
    view: withViewState(componentView("Service Health", summary, [
      {
        id: "health",
        title: "Health",
        tone: countTone(issueCount),
        metrics: [
          { label: "Unexpected Issues", value: issueCount, tone: countTone(issueCount) },
          { label: "Expected Warnings", value: expectedCount, tone: expectedCount > 0 ? "info" : "ok" },
        ],
        items: services.map((service) => ({
          label: serviceLabel(service.service),
          value: service.health,
          detail: service.issues[0]?.message,
          tone: service.ok ? "ok" : service.health === "error" ? "error" : "warning",
        })),
      },
    ]), panelState({ warnings })),
    services,
    warnings,
  });
}

export async function diskSpace() {
  const targets = apps.filter(
    (app): app is AppConfig & { name: LibraryAppName; url: string; apiKey: string } =>
      diskApps.includes(app.name as LibraryAppName) && Boolean(app.url && app.apiKey),
  );
  const services = await Promise.all(
    targets.map(async (app) => {
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
  const skipped = apps
    .filter((app) => app.name === "prowlarr" && app.url && app.apiKey)
    .map((app) => ({
      service: app.name,
      reason: "Prowlarr does not manage media library storage, so diskspace is skipped.",
    }));

  const low = services.flatMap((service) =>
    service.paths.filter((path) => typeof path.usedPercent === "number" && path.usedPercent >= 90).map((path) => `${service.service}:${path.path}`),
  );
  const endpointWarnings = services.flatMap((service) => service.warnings.map((warning) => `${service.service}: ${warning}`));
  const warnings = [...low, ...endpointWarnings];
  const summary = low.length === 0 ? "No media service-visible disks are above 90% used." : `${low.length} media service-visible paths are above 90% used.`;
  return toSummary({
    summary,
    view: withViewState(componentView("Disk Space", summary, [
      {
        id: "disks",
        title: "Service-Visible Paths",
        tone: countTone(low.length),
        metrics: [{ label: "90%+ Used", value: low.length, tone: countTone(low.length) }],
        items: services.flatMap((service) =>
          service.paths.map((path) => ({
            label: `${serviceLabel(service.service)} ${path.label ?? path.path}`,
            value: path.usedPercent === undefined ? "unknown" : `${path.usedPercent}%`,
            detail: path.path,
            tone: typeof path.usedPercent === "number" && path.usedPercent >= 90 ? "warning" : "ok",
          })),
        ),
      },
    ]), panelState({ empty: services.every((service) => service.paths.length === 0), emptyLabel: "No disk paths reported", warnings })),
    services,
    skipped,
    warnings,
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
  const warnings = services.flatMap((service) => service.warnings?.map((warning: string) => `${service.service}: ${warning}`) ?? []);
  const summary = total === 0 ? "No active queue items reported." : `${total} queue items reported across ${services.length} services.`;
  const queueItems = services.flatMap((service) =>
    service.items.map((item: AnyRecord) => ({
      label: serviceLabel(service.service),
      value: item.progress !== undefined ? `${item.progress}%` : item.status,
      detail: item.title,
      tone: "info" as const,
    })),
  );
  const queueWarnings = services
    .filter((service) => service.warnings?.length)
    .map((service) => ({
      label: serviceLabel(service.service),
      value: "warning",
      detail: service.warnings?.[0],
      tone: "warning" as const,
    }));
  return toSummary({
    summary,
    view: withViewState(componentView("Download Queue", summary, [
      {
        id: "queue",
        title: "Queue",
        tone: countTone(total),
        metrics: total > 0 ? [{ label: "Items", value: total, tone: countTone(total) }] : [],
        items: [...queueItems, ...queueWarnings],
      },
    ]), panelState({ empty: total === 0, emptyLabel: "No active queue items", warnings })),
    services,
    warnings,
  });
}

export async function history(appName: AppName, pageSize = 20) {
  const app = getApp(appName);
  if (app.kind === "sabnzbd") return sabGet(app, "history", { limit: pageSize });
  if (app.kind === "jellyfin") return jellyfinActivity(pageSize);
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

function normalizeJellyfinActivity(app: AppConfig, response: AnyRecord) {
  const items: AnyRecord[] = Array.isArray(response.Items) ? response.Items : [];
  return items.map((item) => ({
    service: app.name,
    title: firstString(item.Name, item.ShortOverview, item.Overview) ?? "activity",
    eventType: firstString(item.Type, item.Severity) ?? "activity",
    date: item.Date,
    userName: item.UserName,
    successful: item.Severity ? String(item.Severity).toLowerCase() !== "error" : undefined,
  }));
}

function flattenTransfers(groups: AnyRecord[] = []) {
  return groups.flatMap((group) =>
    (Array.isArray(group.directories) ? group.directories : []).flatMap((directory: AnyRecord) =>
      (Array.isArray(directory.files) ? directory.files : []).map((file: AnyRecord) => ({
        username: group.username,
        directory: directory.directory,
        filename: file.filename,
        state: file.stateDescription ?? file.state,
        percentComplete: file.percentComplete,
        bytesRemaining: file.bytesRemaining,
        requestedAt: file.requestedAt,
        endedAt: file.endedAt,
      })),
    ),
  );
}

export async function recentActivity(appName?: AppName, pageSize = 20) {
  const targets = configuredTargets(appName);
  const services = await Promise.all(
    targets.map(async (app) => {
      const result = await withStatus(app, "history", () => history(app.name, pageSize));
      if (!result.ok) return { service: app.name, ok: false, items: [], warnings: [result.error] };
      const items =
        app.kind === "sabnzbd"
          ? normalizeSabHistory(app, result.data as AnyRecord)
          : app.kind === "jellyfin"
            ? normalizeJellyfinActivity(app, result.data as AnyRecord)
            : normalizeArrHistory(app, result.data as AnyRecord);
      return { service: app.name, ok: true, items };
    }),
  );
  const total = services.reduce((sum, service) => sum + service.items.length, 0);
  const warnings = services.flatMap((service) => service.warnings?.map((warning: string) => `${service.service}: ${warning}`) ?? []);
  const summary = `${total} recent activity items returned across ${services.length} services.`;
  return toSummary({
    summary,
    view: withViewState(componentView("Recent Activity", summary, [
      {
        id: "activity",
        title: "Recent Activity",
        tone: warnings.length > 0 ? "warning" : "ok",
        metrics: [
          { label: "Items", value: total },
          { label: "Warnings", value: warnings.length, tone: countTone(warnings.length) },
        ],
        items: services.map((service) => ({
          label: serviceLabel(service.service),
          value: service.items.length,
          detail: service.items[0]?.title ?? service.warnings?.[0],
          tone: service.warnings?.length ? "warning" : service.items.length > 0 ? "info" : "ok",
        })),
      },
    ]), panelState({ empty: total === 0, emptyLabel: "No recent activity", warnings })),
    services,
    warnings,
  });
}

export async function calendar(appName: LibraryAppName, start: string, end: string) {
  return arrGet(getApp(appName), "calendar", { start, end });
}

export async function wantedMissing(appName: LibraryAppName, pageSize = 20) {
  const sortKey = appName === "lidarr" ? "releaseDate" : "airDateUtc";
  return arrGet<AnyRecord>(getApp(appName), "wanted/missing", { page: 1, pageSize, sortKey, sortDirection: "ascending" });
}

export async function wantedMissingNormalized(appName: LibraryAppName, pageSize = 20) {
  const app = getApp(appName);
  const result = await withStatus(app, "wanted/missing", () => wantedMissing(appName, pageSize));
  const records: AnyRecord[] = result.ok && Array.isArray(result.data.records) ? result.data.records : [];
  const total = result.ok ? result.data.totalRecords ?? records.length : 0;
  const items = records.map((record) => ({
    title: itemTitle(record),
    airDateUtc: record.airDateUtc,
    releaseDate: record.releaseDate,
    monitored: record.monitored,
  }));
  const summary = result.ok ? `${total} missing wanted items reported for ${app.label}.` : `${app.label} missing wanted lookup failed: ${result.error}`;
  const warnings = result.ok ? [] : [result.error];
  return toSummary({
    summary,
    view: withViewState(componentView("Wanted Missing", summary, [
      {
        id: "missing",
        title: app.label,
        tone: result.ok ? (total > 0 ? "info" : "ok") : "warning",
        metrics: [{ label: "Missing", value: total, tone: total > 0 ? "info" : "ok" }],
        items: items.slice(0, 10).map((item) => ({
          label: item.title,
          value: futureDateLabel(item.releaseDate ?? item.airDateUtc),
          tone: "info",
        })),
      },
    ]), panelState({ empty: result.ok && total === 0, emptyLabel: `No missing wanted items for ${app.label}`, warnings })),
    service: app.name,
    total,
    items,
    warnings,
  });
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
  const warnings = services.flatMap((service) => service.warnings?.map((warning: string) => `${service.service}: ${warning}`) ?? []);
  const summary = `${total} missing wanted items reported across Sonarr/Radarr/Lidarr.`;
  const missingCards = services
    .filter((service) => service.sample.length > 0)
    .map((service) => ({
      id: `missing-${service.service}`,
      title: serviceLabel(service.service),
      tone: "info" as const,
      metrics: [{ label: "Missing", value: service.total, tone: countTone(Number(service.total ?? 0)) }],
      items: service.sample.map((item) => ({
        label: item.title,
        value: futureDateLabel(item.releaseDate ?? item.airDateUtc),
        tone: "info" as const,
      })),
    }));
  const missingWarnings = services
    .filter((service) => service.warnings?.length)
    .map((service) => ({
      id: `missing-warning-${service.service}`,
      title: serviceLabel(service.service),
      tone: "warning" as const,
      items: [{
        label: "Warning",
        detail: service.warnings?.[0],
        tone: "warning" as const,
      }],
    }));
  return toSummary({
    summary,
    view: withViewState(componentView("Missing Media", summary, [
      {
        id: "missing",
        title: "Wanted Missing",
        tone: countTone(total),
        metrics: [{ label: "Missing", value: total, tone: countTone(total) }],
        items: [],
      },
      ...missingCards,
      ...missingWarnings,
    ]), panelState({ empty: total === 0, emptyLabel: "No missing wanted media", warnings })),
    services,
    warnings,
  });
}

export async function jellyfinInfo() {
  const app = configuredJellyfin();
  const result = await withStatus(app, "System/Info", () => jellyfinSystemInfo(app));
  const summary = result.ok
    ? `Jellyfin ${result.data.Version ?? "unknown version"} is reachable.`
    : `Jellyfin system info failed: ${result.error}`;
  return toSummary({
    summary,
    view: componentView("Jellyfin System", summary, [
      {
        id: "system",
        title: "System",
        tone: result.ok ? "ok" : "error",
        metrics: [
          { label: "Reachable", value: result.ok ? "yes" : "no", tone: result.ok ? "ok" : "error" },
          { label: "Version", value: result.ok ? result.data.Version ?? "unknown" : "unknown" },
        ],
        items: result.ok
          ? [
              { label: "Server", value: result.data.ServerName ?? "unknown" },
              { label: "OS", value: result.data.OperatingSystem ?? "unknown" },
            ]
          : [{ label: "Error", detail: result.error, tone: "error" }],
      },
    ]),
    ok: result.ok,
    info: result.ok ? result.data : undefined,
    warnings: result.ok ? [] : [result.error],
  });
}

export async function jellyfinLibraryCounts() {
  const app = configuredJellyfin();
  const result = await withStatus(app, "Items/Counts", () => jellyfinGet<AnyRecord>(app, "Items/Counts"));
  const counts = result.ok ? result.data : {};
  const summary = result.ok ? "Jellyfin library counts loaded." : `Jellyfin library counts failed: ${result.error}`;
  return toSummary({
    summary,
    view: componentView("Jellyfin Libraries", summary, [
      {
        id: "libraries",
        title: "Libraries",
        tone: result.ok ? "ok" : "error",
        metrics: [
          { label: "Movies", value: counts.MovieCount ?? "unknown" },
          { label: "Series", value: counts.SeriesCount ?? "unknown" },
          { label: "Episodes", value: counts.EpisodeCount ?? "unknown" },
          { label: "Songs", value: counts.SongCount ?? "unknown" },
        ],
      },
    ]),
    ok: result.ok,
    counts,
    warnings: result.ok ? [] : [result.error],
  });
}

export async function jellyfinActiveSessions() {
  const app = configuredJellyfin();
  const result = await withStatus(app, "Sessions", () => jellyfinGet<AnyRecord[]>(app, "Sessions"));
  const sessions = result.ok ? result.data : [];
  const summary = result.ok ? `${sessions.length} Jellyfin sessions returned.` : `Jellyfin sessions failed: ${result.error}`;
  return toSummary({
    summary,
    view: componentView("Jellyfin Sessions", summary, [
      {
        id: "sessions",
        title: "Active Sessions",
        tone: result.ok ? "ok" : "error",
        metrics: [{ label: "Sessions", value: sessions.length, tone: sessions.length > 0 ? "info" : "ok" }],
        items: sessions.slice(0, 10).map((session) => ({
          label: firstString(session.UserName, session.Client, session.DeviceName) ?? "session",
          value: firstString(session.NowPlayingItem?.Name, session.Client) ?? "idle",
          detail: firstString(session.DeviceName, session.RemoteEndPoint),
          tone: session.NowPlayingItem ? "info" : "ok",
        })),
      },
    ]),
    ok: result.ok,
    sessions: sessions.map((session) => ({
      userName: session.UserName,
      client: session.Client,
      deviceName: session.DeviceName,
      nowPlaying: session.NowPlayingItem?.Name,
      playState: session.PlayState,
      lastActivityDate: session.LastActivityDate,
    })),
    warnings: result.ok ? [] : [result.error],
  });
}

export async function jellyfinActivity(pageSize = 20) {
  const app = configuredJellyfin();
  return jellyfinGet<AnyRecord>(app, "System/ActivityLog/Entries", { limit: pageSize });
}

export async function jellyfinRecentActivity(pageSize = 20) {
  const app = configuredJellyfin();
  const result = await withStatus(app, "System/ActivityLog/Entries", () => jellyfinActivity(pageSize));
  const items = result.ok ? normalizeJellyfinActivity(app, result.data) : [];
  const summary = result.ok ? `${items.length} Jellyfin activity items returned.` : `Jellyfin activity failed: ${result.error}`;
  return toSummary({
    summary,
    view: componentView("Jellyfin Activity", summary, [
      {
        id: "activity",
        title: "Recent Activity",
        tone: result.ok ? "ok" : "error",
        metrics: [{ label: "Items", value: items.length }],
        items: items.slice(0, 10).map((item) => ({
          label: item.eventType ?? "activity",
          detail: item.title,
          value: item.date,
          tone: item.successful === false ? "warning" : "info",
        })),
      },
    ]),
    ok: result.ok,
    items,
    warnings: result.ok ? [] : [result.error],
  });
}

export async function jellyfinScheduledTasks() {
  const app = configuredJellyfin();
  const result = await withStatus(app, "ScheduledTasks", () => jellyfinGet<AnyRecord[]>(app, "ScheduledTasks"));
  const tasks = result.ok ? result.data : [];
  const running = tasks.filter((task) => String(task.State ?? "").toLowerCase() === "running");
  const failed = tasks.filter((task) => String(task.LastExecutionResult?.Status ?? "").toLowerCase() === "failed");
  const summary = result.ok ? `${tasks.length} Jellyfin scheduled tasks returned; ${running.length} running.` : `Jellyfin scheduled tasks failed: ${result.error}`;
  return toSummary({
    summary,
    view: componentView("Jellyfin Tasks", summary, [
      {
        id: "tasks",
        title: "Scheduled Tasks",
        tone: failed.length > 0 ? "warning" : result.ok ? "ok" : "error",
        metrics: [
          { label: "Tasks", value: tasks.length },
          { label: "Running", value: running.length, tone: running.length > 0 ? "info" : "ok" },
          { label: "Failed Last Run", value: failed.length, tone: countTone(failed.length) },
        ],
        items: tasks.slice(0, 10).map((task) => ({
          label: task.Name ?? task.Key ?? "task",
          value: task.State ?? task.LastExecutionResult?.Status,
          detail: task.LastExecutionResult?.EndTimeUtc,
          tone: String(task.LastExecutionResult?.Status ?? "").toLowerCase() === "failed" ? "warning" : "ok",
        })),
      },
    ]),
    ok: result.ok,
    tasks: tasks.map((task) => ({
      name: task.Name,
      key: task.Key,
      state: task.State,
      lastExecutionResult: task.LastExecutionResult,
    })),
    warnings: result.ok ? [] : [result.error],
  });
}

export async function beetsFlaskStatus() {
  const app = getApp("beets-flask");
  const [queues, workers, jobs, inbox, library] = await Promise.all([
    withStatus(app, "api_v1/monitor/queues", () => beetsQueues(app)),
    withStatus(app, "api_v1/monitor/workers", () => beetsWorkers(app)),
    withStatus(app, "api_v1/monitor/jobs", () => beetsJobs(app)),
    withStatus(app, "api_v1/inbox/tree", () => beetsInboxTree(app)),
    withStatus(app, "api_v1/library/stats", () => beetsLibraryStats(app)),
  ]);
  const queueRecords = queues.ok ? Object.values((queues.data.queues as AnyRecord | undefined) ?? {}) as AnyRecord[] : [];
  const workerRecords = workers.ok ? Object.values((workers.data.workers as AnyRecord | undefined) ?? {}) as AnyRecord[] : [];
  const inboxRoots = inbox.ok ? inbox.data : [];
  const inboxAlbums = inboxRoots.flatMap((root) => (Array.isArray(root.children) ? root.children : []).filter((child: AnyRecord) => child.is_album));
  const failedJobs = queueRecords.reduce((sum, queue) => sum + Number(queue.failed ?? 0), 0);
  const warnings = [
    ...[queues, workers, jobs, inbox, library].filter((result) => !result.ok).map((result) => `${result.operation}: ${result.error}`),
    ...(failedJobs > 0 ? [`${failedJobs} failed queue jobs reported`] : []),
  ];
  const summary = warnings.length === 0
    ? `beets-flask is reachable; ${inboxAlbums.length} inbox albums pending preview/import.`
    : `beets-flask reported ${warnings.length} warnings; ${inboxAlbums.length} inbox albums pending preview/import.`;
  return toSummary({
    summary,
    view: componentView("beets-flask", summary, [
      {
        id: "pipeline",
        title: "Music Import Pipeline",
        tone: warnings.length > 0 ? "warning" : inboxAlbums.length > 0 ? "info" : "ok",
        metrics: [
          { label: "Inbox Albums", value: inboxAlbums.length, tone: inboxAlbums.length > 0 ? "info" : "ok" },
          { label: "Workers", value: workerRecords.length, tone: workerRecords.length > 0 ? "ok" : "warning" },
          { label: "Active Jobs", value: jobs.ok ? jobs.data.length : "unknown" },
          { label: "Failed Jobs", value: failedJobs, tone: countTone(failedJobs) },
        ],
        items: inboxAlbums.slice(0, 8).map((album) => ({
          label: String(album.full_path ?? "").split("/").pop() ?? "album",
          detail: album.full_path,
          tone: "info",
        })),
      },
    ]),
    ok: warnings.length === 0,
    queues: queueRecords,
    workers: workerRecords,
    activeJobs: jobs.ok ? jobs.data : [],
    inbox: {
      roots: inboxRoots.map((root) => ({ path: root.full_path, children: Array.isArray(root.children) ? root.children.length : 0 })),
      albums: inboxAlbums.map((album) => ({ path: album.full_path, hash: album.hash })),
    },
    library: library.ok ? library.data : undefined,
    warnings,
  });
}

export async function slskdStatus() {
  const app = getApp("slskd");
  const [server, downloads, uploads, shares] = await Promise.all([
    withStatus(app, "api/v0/server", () => slskdServer(app)),
    withStatus(app, "api/v0/transfers/downloads", () => slskdDownloads(app)),
    withStatus(app, "api/v0/transfers/uploads", () => slskdUploads(app)),
    withStatus(app, "api/v0/shares", () => slskdShares(app)),
  ]);
  const downloadFiles = downloads.ok ? flattenTransfers(downloads.data) : [];
  const uploadFiles = uploads.ok ? flattenTransfers(uploads.data) : [];
  const activeDownloads = downloadFiles.filter((file) => !String(file.state ?? "").toLowerCase().includes("completed"));
  const failedDownloads = downloadFiles.filter((file) => /failed|errored|cancelled/i.test(String(file.state ?? "")));
  const localShares = shares.ok && Array.isArray(shares.data.local) ? shares.data.local : [];
  const warnings = [
    ...[server, downloads, uploads, shares].filter((result) => !result.ok).map((result) => `${result.operation}: ${result.error}`),
    ...(server.ok && !server.data.isConnected ? ["Soulseek server is not connected"] : []),
    ...(server.ok && !server.data.isLoggedIn ? ["Soulseek user is not logged in"] : []),
    ...(failedDownloads.length > 0 ? [`${failedDownloads.length} failed slskd downloads retained in history`] : []),
  ];
  const summary = warnings.length === 0
    ? `slskd is ${server.ok ? server.data.state : "reachable"}; ${activeDownloads.length} active downloads.`
    : `slskd reported ${warnings.length} warnings; ${activeDownloads.length} active downloads.`;
  return toSummary({
    summary,
    view: componentView("slskd", summary, [
      {
        id: "transfers",
        title: "Soulseek Transfers",
        tone: warnings.length > 0 ? "warning" : activeDownloads.length > 0 ? "info" : "ok",
        metrics: [
          { label: "Active Downloads", value: activeDownloads.length, tone: activeDownloads.length > 0 ? "info" : "ok" },
          { label: "Failed Downloads", value: failedDownloads.length, tone: countTone(failedDownloads.length) },
          { label: "Recent Uploads", value: uploadFiles.length },
          { label: "Shared Files", value: localShares[0]?.files ?? "unknown" },
        ],
        items: activeDownloads.slice(0, 8).map((file) => ({
          label: String(file.filename ?? "").split("\\").pop() ?? "download",
          value: file.percentComplete === undefined ? file.state : `${file.percentComplete}%`,
          detail: file.username,
          tone: "info",
        })),
      },
    ]),
    ok: warnings.length === 0,
    server: server.ok ? server.data : undefined,
    downloads: {
      totalFiles: downloadFiles.length,
      active: activeDownloads,
      failed: failedDownloads.slice(0, 20),
    },
    uploads: {
      totalFiles: uploadFiles.length,
    },
    shares: localShares,
    warnings,
  });
}

export async function libraryCounts() {
  const jellyfinConfigured = apps.some((app) => app.name === "jellyfin" && app.url && app.apiKey);
  const [sonarrSeries, radarrMovies, lidarrArtists, lidarrAlbums, jellyfinCounts] = await Promise.all([
    withStatus(getApp("sonarr"), "series", () => arrGet<AnyRecord[]>(getApp("sonarr"), "series")),
    withStatus(getApp("radarr"), "movie", () => arrGet<AnyRecord[]>(getApp("radarr"), "movie")),
    withStatus(getApp("lidarr"), "artist", () => arrGet<AnyRecord[]>(getApp("lidarr"), "artist")),
    withStatus(getApp("lidarr"), "album", () => arrGet<AnyRecord[]>(getApp("lidarr"), "album")),
    jellyfinConfigured
      ? withStatus(getApp("jellyfin"), "Items/Counts", () => jellyfinGet<AnyRecord>(getApp("jellyfin"), "Items/Counts"))
      : Promise.resolve(undefined),
  ]);
  const counts = {
    sonarrSeries: sonarrSeries.ok ? sonarrSeries.data.length : undefined,
    radarrMovies: radarrMovies.ok ? radarrMovies.data.length : undefined,
    lidarrArtists: lidarrArtists.ok ? lidarrArtists.data.length : undefined,
    lidarrAlbums: lidarrAlbums.ok ? lidarrAlbums.data.length : undefined,
    jellyfinMovies: jellyfinCounts?.ok ? jellyfinCounts.data.MovieCount : undefined,
    jellyfinSeries: jellyfinCounts?.ok ? jellyfinCounts.data.SeriesCount : undefined,
    jellyfinEpisodes: jellyfinCounts?.ok ? jellyfinCounts.data.EpisodeCount : undefined,
    jellyfinSongs: jellyfinCounts?.ok ? jellyfinCounts.data.SongCount : undefined,
  };
  const results = [sonarrSeries, radarrMovies, lidarrArtists, lidarrAlbums, jellyfinCounts].filter((result) => result !== undefined);
  const warnings = results.filter((result) => !result.ok).map((result) => `${result.app}: ${result.error}`);
  const loaded = Object.values(counts).filter((value) => value !== undefined).length;
  const expected = jellyfinConfigured ? 8 : 4;
  const summary = `Library counts loaded for ${loaded}/${expected} categories.`;
  return toSummary({
    summary,
    view: withViewState(componentView("Library Counts", summary, [
      {
        id: "libraries",
        title: "Libraries",
        tone: healthTone(warnings),
        metrics: [
          { label: "Series", value: counts.sonarrSeries ?? "unknown" },
          { label: "Movies", value: counts.radarrMovies ?? "unknown" },
          { label: "Artists", value: counts.lidarrArtists ?? "unknown" },
          { label: "Albums", value: counts.lidarrAlbums ?? "unknown" },
          ...(jellyfinConfigured
            ? [
                { label: "Jellyfin Movies", value: counts.jellyfinMovies ?? "unknown" },
                { label: "Jellyfin Episodes", value: counts.jellyfinEpisodes ?? "unknown" },
              ]
            : []),
        ],
      },
    ]), panelState({ warnings })),
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
  const warnings = [...queueSummary.warnings, ...activity.warnings];
  const historyFailures = activityServices.flatMap((service) =>
    service.items.filter((item) => item.successful === false).map((item) => ({ service: service.service, item, serviceItems: service.items })),
  );
  const resolvedFailedHistory = historyFailures
    .map(({ service, item, serviceItems }) => {
      const resolvedBy = completedAfterFailure(item, serviceItems);
      return resolvedBy
        ? {
            service,
            title: item.title,
            eventType: item.eventType,
            date: item.date,
            resolvedBy: {
              eventType: resolvedBy.eventType,
              date: resolvedBy.date,
            },
          }
        : undefined;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const failedHistory = historyFailures
    .filter(({ item, serviceItems }) => !completedAfterFailure(item, serviceItems))
    .map(({ service, item }) => ({ service, title: item.title, eventType: item.eventType, date: item.date }));

  const resolvedCount = resolvedFailedHistory.length;
  const summary = `${queueIssues.length} queue/import warnings and ${failedHistory.length} unresolved failed recent history items found; ${resolvedCount} later completed.`;
  return toSummary({
    summary,
    view: withViewState(componentView("Import Issues", summary, [
      {
        id: "issues",
        title: "Issues",
        tone: queueIssues.length + failedHistory.length > 0 ? "warning" : "ok",
        metrics: [
          { label: "Queue Warnings", value: queueIssues.length, tone: countTone(queueIssues.length) },
          { label: "Failed History", value: failedHistory.length, tone: countTone(failedHistory.length) },
          { label: "Later Completed", value: resolvedCount, tone: "ok" },
        ],
        items: [...queueIssues, ...failedHistory].slice(0, 8).map((issue) => {
          const record = issue as AnyRecord;
          return {
            label: serviceLabel(record.service),
            value: record.eventType ?? record.trackedDownloadStatus ?? record.status ?? "issue",
            detail: record.title,
            tone: "warning",
          };
        }),
      },
    ]), panelState({
      empty: queueIssues.length === 0 && failedHistory.length === 0,
      emptyLabel: "No active import issues",
      warnings,
    })),
    queueIssues,
    failedHistory,
    resolvedFailedHistory,
    warnings,
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
  const warnings = [health, indexers, indexerStatuses].filter((result) => !result.ok).map((result) => `${result.operation}: ${result.error}`);
  const summary = `${indexerList.length} indexers configured; ${disabled.length} currently have failure/disabled status.`;
  return toSummary({
    summary,
    view: withViewState(componentView("Indexer Status", summary, [
      {
        id: "indexers",
        title: "Prowlarr Indexers",
        tone: disabled.length > 0 || warnings.length > 0 ? "warning" : "ok",
        metrics: [
          { label: "Configured", value: indexerList.length },
          { label: "Disabled/Failed", value: disabled.length, tone: countTone(disabled.length) },
        ],
        items: indexerList.map((indexer) => ({
          label: indexer.name,
          value: indexer.enable ? "enabled" : "disabled",
          detail: indexer.protocol,
          tone: indexer.enable ? "ok" : "warning",
        })),
      },
    ]), panelState({
      empty: indexerList.length === 0,
      emptyLabel: "No indexers configured",
      warnings: [...warnings, ...disabled.map((indexer) => `${indexer.indexerId ?? "indexer"}: disabled or failed`)],
    })),
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
    warnings,
  });
}

export async function mediaStackOverview() {
  const safety = safetyStatus();
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
  const issueSummary = issues as AnyRecord;
  const queueTotal = ((queues.services as AnyRecord[]) ?? []).reduce((sum, service) => sum + Number(service.total ?? 0), 0);
  const healthServices = (health.services as AnyRecord[]) ?? [];
  const healthIssueCount = healthServices.reduce(
    (sum, service) => sum + Number(service.issues?.filter((issue: AnyRecord) => !issue.expected).length ?? 0),
    0,
  );
  const expectedHealthIssueCount = healthServices.reduce(
    (sum, service) => sum + Number(service.issues?.filter((issue: AnyRecord) => issue.expected).length ?? 0),
    0,
  );
  const missingTotal = ((missing.services as AnyRecord[]) ?? []).reduce((sum, service) => sum + Number(service.total ?? 0), 0);
  const diskWarnings = Array.isArray(disks.warnings) ? disks.warnings.length : 0;
  const importIssueCount = Number(issueSummary.queueIssues?.length ?? 0) + Number(issueSummary.failedHistory?.length ?? 0);
  const warnings = [
    ...(reachable < services.length ? [`${services.length - reachable} services are not reachable`] : []),
    ...(healthIssueCount > 0 ? [`${healthIssueCount} unexpected health issues`] : []),
    ...(diskWarnings > 0 ? [`${diskWarnings} disk warnings`] : []),
    ...(importIssueCount > 0 ? [`${importIssueCount} import issues`] : []),
  ];
  const summary = `${reachable}/${services.length} services reachable. ${queues.summary} ${missing.summary}`;
  return toSummary({
    summary,
    view: withViewState(componentView("Media Stack", summary, [
      {
        id: "services",
        title: "Services",
        tone: reachable === services.length && healthIssueCount === 0 ? "ok" : "warning",
        metrics: [
          { label: "Reachable", value: `${reachable}/${services.length}`, tone: reachable === services.length ? "ok" : "warning" },
          { label: "Health Issues", value: healthIssueCount, tone: countTone(healthIssueCount) },
          { label: "Expected Warnings", value: expectedHealthIssueCount, tone: expectedHealthIssueCount > 0 ? "info" : "ok" },
        ],
        items: services.map((service) => ({
          label: service.label,
          value: service.version ?? (service.reachable ? "reachable" : "offline"),
          detail: service.warnings?.[0],
          tone: service.reachable && (service.warnings?.length ?? 0) === 0 ? "ok" : "warning",
        })),
      },
      {
        id: "activity",
        title: "Activity",
        tone: queueTotal + importIssueCount > 0 ? "warning" : "ok",
        metrics: [
          { label: "Queue", value: queueTotal, tone: countTone(queueTotal) },
          { label: "Import Issues", value: importIssueCount, tone: countTone(importIssueCount) },
          { label: "Missing", value: missingTotal, tone: missingTotal > 0 ? "info" : "ok" },
        ],
      },
      {
        id: "storage-indexers",
        title: "Storage & Indexers",
        tone: diskWarnings > 0 || !indexers.ok ? "warning" : "ok",
        metrics: [
          { label: "Disk Warnings", value: diskWarnings, tone: countTone(diskWarnings) },
          { label: "Indexers", value: (indexers.indexers as AnyRecord[] | undefined)?.length ?? "unknown" },
          { label: "Indexer Failures", value: (indexers.indexerStatuses as AnyRecord[] | undefined)?.length ?? "unknown" },
        ],
      },
      {
        id: "safety",
        title: "Safety",
        tone: safety.writeToolsEnabled ? "warning" : "ok",
        metrics: [
          { label: "Mode", value: safety.mode },
          { label: "Write Tools", value: safety.writeToolsEnabled ? "enabled" : "disabled", tone: safety.writeToolsEnabled ? "warning" : "ok" },
        ],
      },
      {
        id: "stack-model",
        title: "Stack Model",
        tone: "ok",
        metrics: [
          { label: "Flows", value: Object.keys(getStackModel().flows).length },
          { label: "Expectations", value: getStackModel().expectations.serviceIssues.length },
        ],
      },
    ]), panelState({ warnings })),
    status,
    health,
    queues,
    missing,
    disks,
    indexers,
    libraries,
    issues,
    safety,
    warnings,
  });
}

export async function mediaStackModel() {
  const model = getStackModel();
  const flowCount = Object.keys(model.flows).length;
  const summary = `Generated stack model loaded from ${model.source.title}; ${flowCount} media flows and ${model.expectations.serviceIssues.length} stack-aware service expectations.`;
  return toSummary({
    summary,
    view: componentView("Stack Model", summary, [
      {
        id: "source",
        title: "Source",
        tone: "ok",
        metrics: [
          { label: "Flows", value: flowCount },
          { label: "Expectations", value: model.expectations.serviceIssues.length },
        ],
        items: [
          { label: "Source", value: model.source.title, detail: model.source.pageId },
          { label: "Last Reviewed", value: model.source.lastReviewed },
        ],
      },
    ]),
    model,
  });
}

export async function mediaStackFlow(mediaType?: StackFlowName) {
  const flow = getStackFlow(mediaType);
  const summary = mediaType ? `${getStackModel().flows[mediaType].label} flow loaded from generated stack model.` : "All media flows loaded from generated stack model.";
  return toSummary({
    summary,
    view: componentView("Media Flow", summary, [
      {
        id: "flows",
        title: mediaType ? getStackModel().flows[mediaType].label : "Flows",
        tone: "ok",
        metrics: [{ label: "Flows", value: mediaType ? 1 : Object.keys(getStackModel().flows).length }],
        items: Object.entries(mediaType ? { [mediaType]: getStackModel().flows[mediaType] } : getStackModel().flows).map(([key, value]) => ({
          label: value.label,
          value: value.importAuthority.join(", "),
          detail: `${key}: ${value.downloaders.join(", ")} -> ${value.library.join(", ")}`,
        })),
      },
    ]),
    flow,
  });
}

type MovieRequestInput = {
  tmdbId: number;
  qualityProfileId: number;
  rootFolderPath: string;
  monitored?: boolean;
  searchNow?: boolean;
  tagIds?: number[];
};

type MovieRequestDefaults = {
  qualityProfileId?: number;
  rootFolderPath?: string;
  monitored: boolean;
  searchNow: boolean;
  tagIds: number[];
};

function movieCandidate(record: AnyRecord) {
  return {
    tmdbId: record.tmdbId,
    title: record.title,
    year: record.year,
    titleSlug: record.titleSlug,
    overview: record.overview,
    runtime: record.runtime,
    certification: record.certification,
    genres: record.genres,
    images: record.images,
    remotePoster: record.remotePoster,
    alreadyExists: Boolean(record.isExisting),
  };
}

function moviePoster(record: AnyRecord) {
  return typeof record.remotePoster === "string" && record.remotePoster.length > 0
    ? { type: "image" as const, url: record.remotePoster, alt: `${record.title ?? "Movie"} poster` }
    : undefined;
}

function qualityProfileOptions(records: AnyRecord[]) {
  return records.map((profile) => ({
    id: profile.id,
    label: profile.name,
    name: profile.name,
  }));
}

function rootFolderOptions(records: AnyRecord[]) {
  return records.map((folder) => ({
    path: folder.path,
    label: folder.path,
    freeSpace: folder.freeSpace,
    unmappedFolders: folder.unmappedFolders,
  }));
}

function tagOptions(records: AnyRecord[]) {
  return records.map((tag) => ({
    id: tag.id,
    label: tag.label,
  }));
}

function defaultMovieRequestValues(args: {
  qualityProfiles: AnyRecord[];
  rootFolders: AnyRecord[];
  request?: MovieRequestInput;
}): MovieRequestDefaults {
  return {
    qualityProfileId: args.request?.qualityProfileId ?? args.qualityProfiles[0]?.id,
    rootFolderPath: args.request?.rootFolderPath ?? args.rootFolders[0]?.path,
    monitored: args.request?.monitored ?? true,
    searchNow: args.request?.searchNow ?? true,
    tagIds: args.request?.tagIds ?? [],
  };
}

function movieRequestFormFields(args: {
  qualityProfiles: AnyRecord[];
  rootFolders: AnyRecord[];
  defaults: MovieRequestDefaults;
}): DiscordComponentField[] {
  return [
    {
      id: "qualityProfileId",
      label: "Quality Profile",
      type: "select",
      required: true,
      value: args.defaults.qualityProfileId,
      placeholder: "Choose quality",
      options: qualityProfileOptions(args.qualityProfiles).map((profile) => ({
        label: truncateComponentText(profile.label, 100),
        value: String(profile.id),
      })),
    },
    {
      id: "rootFolderPath",
      label: "Root Folder",
      type: "select",
      required: true,
      value: args.defaults.rootFolderPath,
      placeholder: "Choose root folder",
      options: rootFolderOptions(args.rootFolders).map((folder) => ({
        label: truncateComponentText(folder.label, 100),
        value: folder.path,
        description: folder.freeSpace !== undefined ? `${bytes(Number(folder.freeSpace))} free` : undefined,
      })),
    },
    {
      id: "monitored",
      label: "Monitored",
      type: "checkbox",
      value: args.defaults.monitored,
    },
    {
      id: "searchNow",
      label: "Search Now",
      type: "checkbox",
      value: args.defaults.searchNow,
    },
  ];
}

function movieRequestDraft(args: {
  candidates?: AnyRecord[];
  selected?: AnyRecord;
  qualityProfiles: AnyRecord[];
  rootFolders: AnyRecord[];
  tags: AnyRecord[];
  request?: MovieRequestInput;
}) {
  const defaults = defaultMovieRequestValues(args);
  return {
    schema: "media-mcp.requestDraft.v1",
    kind: "movie",
    service: "radarr",
    candidateOptions: args.candidates?.map(movieCandidate) ?? [],
    selectedCandidate: args.selected ? movieCandidate(args.selected) : undefined,
    qualityProfileOptions: qualityProfileOptions(args.qualityProfiles),
    rootFolderOptions: rootFolderOptions(args.rootFolders),
    tagOptions: tagOptions(args.tags),
    defaults,
    formFields: movieRequestFormFields({
      qualityProfiles: args.qualityProfiles,
      rootFolders: args.rootFolders,
      defaults,
    }),
    request: args.request,
    writeGate: {
      env: "ALLOW_REQUESTS",
      enabled: safetyStatus().requestToolsEnabled,
    },
  };
}

function truncateComponentText(value: unknown, maxLength: number) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function movieLabel(record: AnyRecord) {
  return truncateComponentText(`${record.title ?? "Untitled"}${record.year ? ` (${record.year})` : ""}`, 100);
}

function movieDescription(record: AnyRecord) {
  const pieces = [
    record.isExisting ? "Already in Radarr" : undefined,
    Array.isArray(record.genres) ? record.genres.slice(0, 2).join(", ") : undefined,
    record.certification,
  ].filter(Boolean);
  return pieces.length > 0 ? truncateComponentText(pieces.join(" | "), 100) : undefined;
}

function moviePreviewCommand(record: AnyRecord) {
  return `Preview Radarr movie TMDB ${record.tmdbId} with default request options`;
}

function discordMovieSearchComponents(query: string, summary: string, candidates: AnyRecord[]): DiscordComponentSpec | undefined {
  if (candidates.length === 0) return;
  const featured = candidates[0];
  const poster = moviePoster(featured);
  return {
    container: { accentColor: "#2f81f7" },
    blocks: [
      { type: "text", text: `**Movie Search**\n${summary}` },
      {
        type: "section",
        text: `Pick the exact match for "${truncateComponentText(query, 80)}".`,
        accessory: poster ? { type: "thumbnail", url: poster.url } : undefined,
      },
      {
        type: "actions",
        select: {
          type: "string",
          placeholder: "Choose a movie to preview",
          minValues: 1,
          maxValues: 1,
          callbackDataKind: "command",
          options: candidates.slice(0, 25).map((candidate) => ({
            label: movieLabel(candidate),
            value: moviePreviewCommand(candidate),
            description: movieDescription(candidate),
          })),
        },
      },
    ],
  };
}

function discordMoviePreviewComponents(args: {
  summary: string;
  selected: AnyRecord;
  request: MovieRequestInput;
  qualityProfile: AnyRecord;
  rootFolder: AnyRecord;
  formFields: DiscordComponentField[];
  disabled: boolean;
}): DiscordComponentSpec {
  const poster = moviePoster(args.selected);
  return {
    container: { accentColor: args.disabled ? "#9a6700" : "#1a7f37" },
    blocks: [
      {
        type: "section",
        texts: [
          `**${movieLabel(args.selected)}**`,
          args.summary,
          `Quality: ${args.qualityProfile.name}\nRoot: ${args.rootFolder.path}\nMonitored: ${args.request.monitored ? "yes" : "no"}\nSearch now: ${args.request.searchNow ? "yes" : "no"}`,
        ],
        accessory: poster ? { type: "thumbnail", url: poster.url } : undefined,
      },
      {
        type: "form",
        fields: args.formFields,
      },
      {
        type: "actions",
        buttons: [
          {
            label: args.disabled ? "Requests disabled" : "Request movie",
            style: args.disabled ? "secondary" : "success",
            disabled: args.disabled,
            callbackData: `Request Radarr movie TMDB ${args.request.tmdbId}`,
            callbackDataKind: "command",
          },
        ],
      },
    ],
  };
}

export async function radarrRequestOptions() {
  const app = getApp("radarr");
  const [qualityProfiles, rootFolders, tags] = await Promise.all([
    arrQualityProfiles(app),
    arrRootFolders(app),
    arrTags(app),
  ]);
  const summary = `${qualityProfiles.length} Radarr quality profiles and ${rootFolders.length} root folders available.`;
  return toSummary({
    summary,
    view: componentView("Radarr Request Options", summary, [
      {
        id: "radarr-options",
        title: "Options",
        tone: rootFolders.length > 0 && qualityProfiles.length > 0 ? "ok" : "warning",
        metrics: [
          { label: "Quality Profiles", value: qualityProfiles.length },
          { label: "Root Folders", value: rootFolders.length },
          { label: "Tags", value: tags.length },
        ],
        items: [
          ...qualityProfileOptions(qualityProfiles).slice(0, 5).map((profile) => ({ label: "Quality", value: profile.label })),
          ...rootFolderOptions(rootFolders).slice(0, 5).map((folder) => ({ label: "Root", value: folder.path })),
        ],
      },
    ]),
    requestDraft: movieRequestDraft({ qualityProfiles, rootFolders, tags }),
  });
}

export async function searchMovie(query: string, limit = 10) {
  const app = getApp("radarr");
  const [results, qualityProfiles, rootFolders, tags] = await Promise.all([
    radarrMovieLookup(app, query),
    arrQualityProfiles(app),
    arrRootFolders(app),
    arrTags(app),
  ]);
  const candidates = results.slice(0, limit);
  const summary = `${candidates.length} Radarr movie candidates returned for "${query}".`;
  const defaultQualityProfile = qualityProfiles[0];
  const defaultRootFolder = rootFolders[0];
  return toSummary({
    summary,
    view: withViewState(componentView("Movie Search", summary, [
      {
        id: "movie-results",
        title: "Results",
        tone: candidates.length > 0 ? "info" : "warning",
        media: candidates.length === 1 ? moviePoster(candidates[0]) : undefined,
        metrics: [{ label: "Candidates", value: candidates.length, tone: candidates.length > 0 ? "info" : "warning" }],
        items: candidates.map((candidate) => ({
          label: candidate.title,
          value: candidate.year ?? "unknown year",
          detail: candidate.overview,
          tone: candidate.isExisting ? "ok" : "info",
          media: moviePoster(candidate),
        })),
        actions: candidates.length === 1 && defaultQualityProfile && defaultRootFolder
          ? [
              {
                id: "preview-movie-request",
                label: "Preview request",
                kind: "preview",
                payload: {
                  tool: "preview_movie_request",
                  tmdbId: candidates[0].tmdbId,
                  qualityProfileId: defaultQualityProfile.id,
                  rootFolderPath: defaultRootFolder.path,
                  monitored: true,
                  searchNow: true,
                  tagIds: [],
                },
              },
            ]
          : undefined,
      },
    ]), panelState({ empty: candidates.length === 0, emptyLabel: "No movie candidates found" })),
    components: discordMovieSearchComponents(query, summary, candidates),
    candidates: candidates.map(movieCandidate),
    requestDraft: movieRequestDraft({ candidates, qualityProfiles, rootFolders, tags }),
  });
}

async function validateMovieRequest(input: MovieRequestInput) {
  const app = getApp("radarr");
  const tagIds = input.tagIds ?? [];
  const [lookup, qualityProfiles, rootFolders, tags, existingMovies] = await Promise.all([
    radarrMovieLookup(app, `tmdb:${input.tmdbId}`),
    arrQualityProfiles(app),
    arrRootFolders(app),
    arrTags(app),
    radarrMovies(app),
  ]);
  const selected = lookup.find((candidate) => Number(candidate.tmdbId) === input.tmdbId);
  if (!selected) throw new Error(`Radarr could not resolve TMDB ID ${input.tmdbId}`);

  const qualityProfile = qualityProfiles.find((profile) => Number(profile.id) === input.qualityProfileId);
  if (!qualityProfile) throw new Error(`Quality profile ${input.qualityProfileId} is not available in Radarr`);

  const rootFolder = rootFolders.find((folder) => folder.path === input.rootFolderPath);
  if (!rootFolder) throw new Error(`Root folder is not available in Radarr: ${input.rootFolderPath}`);

  const unknownTags = tagIds.filter((tagId) => !tags.some((tag) => Number(tag.id) === tagId));
  if (unknownTags.length > 0) throw new Error(`Radarr tag IDs are not available: ${unknownTags.join(", ")}`);

  const existing = existingMovies.find((movie) => Number(movie.tmdbId) === input.tmdbId);
  const request: MovieRequestInput = {
    tmdbId: input.tmdbId,
    qualityProfileId: input.qualityProfileId,
    rootFolderPath: input.rootFolderPath,
    monitored: input.monitored ?? true,
    searchNow: input.searchNow ?? true,
    tagIds,
  };
  return { app, selected, qualityProfiles, rootFolders, tags, qualityProfile, rootFolder, existing, request };
}

function radarrAddPayload(selected: AnyRecord, request: MovieRequestInput) {
  return {
    ...selected,
    qualityProfileId: request.qualityProfileId,
    rootFolderPath: request.rootFolderPath,
    monitored: request.monitored ?? true,
    tags: request.tagIds ?? [],
    addOptions: {
      searchForMovie: request.searchNow ?? true,
    },
  };
}

export async function previewMovieRequest(input: MovieRequestInput) {
  const context = await validateMovieRequest(input);
  const requestToolsEnabled = safetyStatus().requestToolsEnabled;
  const warnings = context.existing ? [`${context.selected.title} already exists in Radarr`] : [];
  const defaults = defaultMovieRequestValues({
    qualityProfiles: context.qualityProfiles,
    rootFolders: context.rootFolders,
    request: context.request,
  });
  const formFields = movieRequestFormFields({
    qualityProfiles: context.qualityProfiles,
    rootFolders: context.rootFolders,
    defaults,
  });
  const summary = warnings.length > 0
    ? `Preview ready for ${context.selected.title}; ${warnings[0]}.`
    : `Preview ready to request ${context.selected.title} (${context.selected.year}) in Radarr.`;
  return toSummary({
    summary,
    view: withViewState(componentView("Movie Request Preview", summary, [
      {
        id: "movie-request",
        title: context.selected.title,
        tone: warnings.length > 0 ? "warning" : "info",
        media: moviePoster(context.selected),
        metrics: [
          { label: "Year", value: context.selected.year ?? "unknown" },
          { label: "Quality", value: context.qualityProfile.name },
          { label: "Search Now", value: context.request.searchNow ? "yes" : "no" },
        ],
        items: [
          { label: "Root Folder", value: context.rootFolder.path },
          { label: "Monitored", value: context.request.monitored ? "yes" : "no" },
          { label: "Tags", value: context.request.tagIds?.length ?? 0 },
        ],
        actions: [
          {
            id: "request-movie",
            label: requestToolsEnabled ? "Request movie" : "Requests disabled",
            kind: "submit",
            disabled: warnings.length > 0 || !requestToolsEnabled,
            payload: {
              tool: "request_movie",
              ...context.request,
            },
          },
        ],
      },
    ]), panelState({
      warnings: warnings.length > 0 || !requestToolsEnabled
        ? [...warnings, ...(!requestToolsEnabled ? ["Request tools are disabled"] : [])]
        : [],
      confirmActionId: "request-movie",
      confirmLabel: "Confirm movie request",
      confirmDetail: `Request ${context.selected.title} in Radarr`,
    })),
    requestDraft: movieRequestDraft({
      selected: context.selected,
      qualityProfiles: context.qualityProfiles,
      rootFolders: context.rootFolders,
      tags: context.tags,
      request: context.request,
    }),
    components: discordMoviePreviewComponents({
      summary,
      selected: context.selected,
      request: context.request,
      qualityProfile: context.qualityProfile,
      rootFolder: context.rootFolder,
      formFields,
      disabled: warnings.length > 0 || !requestToolsEnabled,
    }),
    payloadPreview: radarrAddPayload(context.selected, context.request),
    warnings,
  });
}

export async function requestMovie(input: MovieRequestInput) {
  requireRequestToolsEnabled();
  const context = await validateMovieRequest(input);
  if (context.existing) throw new Error(`${context.selected.title} already exists in Radarr`);

  const result = await radarrAddMovie(context.app, radarrAddPayload(context.selected, context.request));
  const summary = `Requested ${result.title ?? context.selected.title} in Radarr.`;
  return toSummary({
    summary,
    view: withViewState(componentView("Movie Requested", summary, [
      {
        id: "movie-requested",
        title: "Radarr",
        tone: "ok",
        metrics: [
          { label: "Movie", value: result.title ?? context.selected.title },
          { label: "Search", value: context.request.searchNow ? "started" : "not started" },
        ],
      },
    ]), panelState({ successDetail: summary })),
    movie: {
      id: result.id,
      tmdbId: result.tmdbId,
      title: result.title,
      year: result.year,
      monitored: result.monitored,
    },
  });
}

type SeriesRequestInput = {
  tvdbId: number;
  qualityProfileId: number;
  rootFolderPath: string;
  monitorMode?: string;
  seasonFolder?: boolean;
  searchNow?: boolean;
  tagIds?: number[];
};

type RequestFollowInput = {
  service: "sonarr" | "radarr";
  title?: string;
  tmdbId?: number;
  tvdbId?: number;
  year?: number;
  expectedEpisodeCount?: number;
  monitorMode?: string;
  polls?: number;
  pageSize?: number;
};

type SeriesRequestDefaults = {
  qualityProfileId?: number;
  rootFolderPath?: string;
  monitorMode: string;
  seasonFolder: boolean;
  searchNow: boolean;
  tagIds: number[];
};

const sonarrMonitorOptions = [
  { id: "all", label: "All Episodes" },
  { id: "future", label: "Future Episodes" },
  { id: "missing", label: "Missing Episodes" },
  { id: "existing", label: "Existing Episodes" },
  { id: "firstSeason", label: "First Season" },
  { id: "latestSeason", label: "Latest Season" },
  { id: "none", label: "None" },
];

function seriesCandidate(record: AnyRecord) {
  return {
    tvdbId: record.tvdbId,
    title: record.title,
    year: record.year,
    titleSlug: record.titleSlug,
    overview: record.overview,
    status: record.status,
    network: record.network,
    genres: record.genres,
    images: record.images,
    remotePoster: record.remotePoster,
    seasons: Array.isArray(record.seasons) ? record.seasons.map((season: AnyRecord) => ({
      seasonNumber: season.seasonNumber,
      monitored: season.monitored,
      episodeCount: season.statistics?.episodeCount,
      totalEpisodeCount: season.statistics?.totalEpisodeCount,
      episodeFileCount: season.statistics?.episodeFileCount,
    })) : undefined,
    alreadyExists: Boolean(record.isExisting),
  };
}

function seriesPoster(record: AnyRecord) {
  return typeof record.remotePoster === "string" && record.remotePoster.length > 0
    ? { type: "image" as const, url: record.remotePoster, alt: `${record.title ?? "Series"} poster` }
    : undefined;
}

function defaultSeriesRequestValues(args: {
  qualityProfiles: AnyRecord[];
  rootFolders: AnyRecord[];
  request?: SeriesRequestInput;
}): SeriesRequestDefaults {
  return {
    qualityProfileId: args.request?.qualityProfileId ?? args.qualityProfiles[0]?.id,
    rootFolderPath: args.request?.rootFolderPath ?? args.rootFolders[0]?.path,
    monitorMode: args.request?.monitorMode ?? "all",
    seasonFolder: args.request?.seasonFolder ?? true,
    searchNow: args.request?.searchNow ?? true,
    tagIds: args.request?.tagIds ?? [],
  };
}

function seriesRequestFormFields(args: {
  qualityProfiles: AnyRecord[];
  rootFolders: AnyRecord[];
  defaults: SeriesRequestDefaults;
}): DiscordComponentField[] {
  return [
    {
      id: "qualityProfileId",
      label: "Quality Profile",
      type: "select",
      required: true,
      value: args.defaults.qualityProfileId,
      placeholder: "Choose quality",
      options: qualityProfileOptions(args.qualityProfiles).map((profile) => ({
        label: truncateComponentText(profile.label, 100),
        value: String(profile.id),
      })),
    },
    {
      id: "rootFolderPath",
      label: "Root Folder",
      type: "select",
      required: true,
      value: args.defaults.rootFolderPath,
      placeholder: "Choose root folder",
      options: rootFolderOptions(args.rootFolders).map((folder) => ({
        label: truncateComponentText(folder.label, 100),
        value: folder.path,
        description: folder.freeSpace !== undefined ? `${bytes(Number(folder.freeSpace))} free` : undefined,
      })),
    },
    {
      id: "monitorMode",
      label: "Monitor",
      type: "select",
      required: true,
      value: args.defaults.monitorMode,
      placeholder: "Choose monitoring",
      options: sonarrMonitorOptions.map((option) => ({
        label: option.label,
        value: option.id,
      })),
    },
    {
      id: "seasonFolder",
      label: "Season Folders",
      type: "checkbox",
      value: args.defaults.seasonFolder,
    },
    {
      id: "searchNow",
      label: "Search Now",
      type: "checkbox",
      value: args.defaults.searchNow,
    },
  ];
}

function seriesRequestDraft(args: {
  candidates?: AnyRecord[];
  selected?: AnyRecord;
  qualityProfiles: AnyRecord[];
  rootFolders: AnyRecord[];
  tags: AnyRecord[];
  request?: SeriesRequestInput;
}) {
  const defaults = defaultSeriesRequestValues(args);
  return {
    schema: "media-mcp.requestDraft.v1",
    kind: "series",
    service: "sonarr",
    candidateOptions: args.candidates?.map(seriesCandidate) ?? [],
    selectedCandidate: args.selected ? seriesCandidate(args.selected) : undefined,
    qualityProfileOptions: qualityProfileOptions(args.qualityProfiles),
    rootFolderOptions: rootFolderOptions(args.rootFolders),
    tagOptions: tagOptions(args.tags),
    monitorOptions: sonarrMonitorOptions,
    defaults,
    formFields: seriesRequestFormFields({
      qualityProfiles: args.qualityProfiles,
      rootFolders: args.rootFolders,
      defaults,
    }),
    request: args.request,
    writeGate: {
      env: "ALLOW_REQUESTS",
      enabled: safetyStatus().requestToolsEnabled,
    },
  };
}

function seriesLabel(record: AnyRecord) {
  return truncateComponentText(`${record.title ?? "Untitled"}${record.year ? ` (${record.year})` : ""}`, 100);
}

function seriesDescription(record: AnyRecord) {
  const pieces = [
    record.isExisting ? "Already in Sonarr" : undefined,
    record.network,
    Array.isArray(record.genres) ? record.genres.slice(0, 2).join(", ") : undefined,
  ].filter(Boolean);
  return pieces.length > 0 ? truncateComponentText(pieces.join(" | "), 100) : undefined;
}

function seriesPreviewCommand(record: AnyRecord) {
  return `Preview Sonarr series TVDB ${record.tvdbId} with default request options`;
}

function discordSeriesSearchComponents(query: string, summary: string, candidates: AnyRecord[]): DiscordComponentSpec | undefined {
  if (candidates.length === 0) return;
  const featured = candidates[0];
  const poster = seriesPoster(featured);
  return {
    container: { accentColor: "#2f81f7" },
    blocks: [
      { type: "text", text: `**Series Search**\n${summary}` },
      {
        type: "section",
        text: `Pick the exact match for "${truncateComponentText(query, 80)}".`,
        accessory: poster ? { type: "thumbnail", url: poster.url } : undefined,
      },
      {
        type: "actions",
        select: {
          type: "string",
          placeholder: "Choose a series to preview",
          minValues: 1,
          maxValues: 1,
          callbackDataKind: "command",
          options: candidates.slice(0, 25).map((candidate) => ({
            label: seriesLabel(candidate),
            value: seriesPreviewCommand(candidate),
            description: seriesDescription(candidate),
          })),
        },
      },
    ],
  };
}

function discordSeriesPreviewComponents(args: {
  summary: string;
  selected: AnyRecord;
  request: SeriesRequestInput;
  qualityProfile: AnyRecord;
  rootFolder: AnyRecord;
  formFields: DiscordComponentField[];
  disabled: boolean;
}): DiscordComponentSpec {
  const poster = seriesPoster(args.selected);
  const monitor = sonarrMonitorOptions.find((option) => option.id === args.request.monitorMode)?.label ?? args.request.monitorMode;
  return {
    container: { accentColor: args.disabled ? "#9a6700" : "#1a7f37" },
    blocks: [
      {
        type: "section",
        texts: [
          `**${seriesLabel(args.selected)}**`,
          args.summary,
          `Quality: ${args.qualityProfile.name}\nRoot: ${args.rootFolder.path}\nMonitor: ${monitor}\nSeason folders: ${args.request.seasonFolder ? "yes" : "no"}\nSearch now: ${args.request.searchNow ? "yes" : "no"}`,
        ],
        accessory: poster ? { type: "thumbnail", url: poster.url } : undefined,
      },
      {
        type: "form",
        fields: args.formFields,
      },
      {
        type: "actions",
        buttons: [
          {
            label: args.disabled ? "Requests disabled" : "Request series",
            style: args.disabled ? "secondary" : "success",
            disabled: args.disabled,
            callbackData: `Request Sonarr series TVDB ${args.request.tvdbId}`,
            callbackDataKind: "command",
          },
        ],
      },
    ],
  };
}

export async function sonarrRequestOptions() {
  const app = getApp("sonarr");
  const [qualityProfiles, rootFolders, tags] = await Promise.all([
    arrQualityProfiles(app),
    arrRootFolders(app),
    arrTags(app),
  ]);
  const summary = `${qualityProfiles.length} Sonarr quality profiles and ${rootFolders.length} root folders available.`;
  return toSummary({
    summary,
    view: componentView("Sonarr Request Options", summary, [
      {
        id: "sonarr-options",
        title: "Options",
        tone: rootFolders.length > 0 && qualityProfiles.length > 0 ? "ok" : "warning",
        metrics: [
          { label: "Quality Profiles", value: qualityProfiles.length },
          { label: "Root Folders", value: rootFolders.length },
          { label: "Tags", value: tags.length },
        ],
        items: [
          ...qualityProfileOptions(qualityProfiles).slice(0, 5).map((profile) => ({ label: "Quality", value: profile.label })),
          ...rootFolderOptions(rootFolders).slice(0, 5).map((folder) => ({ label: "Root", value: folder.path })),
        ],
      },
    ]),
    requestDraft: seriesRequestDraft({ qualityProfiles, rootFolders, tags }),
  });
}

export async function searchSeries(query: string, limit = 10) {
  const app = getApp("sonarr");
  const [results, qualityProfiles, rootFolders, tags] = await Promise.all([
    sonarrSeriesLookup(app, query),
    arrQualityProfiles(app),
    arrRootFolders(app),
    arrTags(app),
  ]);
  const candidates = results.slice(0, limit);
  const summary = `${candidates.length} Sonarr series candidates returned for "${query}".`;
  const defaultQualityProfile = qualityProfiles[0];
  const defaultRootFolder = rootFolders[0];
  return toSummary({
    summary,
    view: withViewState(componentView("Series Search", summary, [
      {
        id: "series-results",
        title: "Results",
        tone: candidates.length > 0 ? "info" : "warning",
        media: candidates.length === 1 ? seriesPoster(candidates[0]) : undefined,
        metrics: [{ label: "Candidates", value: candidates.length, tone: candidates.length > 0 ? "info" : "warning" }],
        items: candidates.map((candidate) => ({
          label: candidate.title,
          value: candidate.year ?? "unknown year",
          detail: candidate.overview,
          tone: candidate.isExisting ? "ok" : "info",
          media: seriesPoster(candidate),
        })),
        actions: candidates.length === 1 && defaultQualityProfile && defaultRootFolder
          ? [
              {
                id: "preview-series-request",
                label: "Preview request",
                kind: "preview",
                payload: {
                  tool: "preview_series_request",
                  tvdbId: candidates[0].tvdbId,
                  qualityProfileId: defaultQualityProfile.id,
                  rootFolderPath: defaultRootFolder.path,
                  monitorMode: "all",
                  seasonFolder: true,
                  searchNow: true,
                  tagIds: [],
                },
              },
            ]
          : undefined,
      },
    ]), panelState({ empty: candidates.length === 0, emptyLabel: "No series candidates found" })),
    components: discordSeriesSearchComponents(query, summary, candidates),
    candidates: candidates.map(seriesCandidate),
    requestDraft: seriesRequestDraft({ candidates, qualityProfiles, rootFolders, tags }),
  });
}

async function validateSeriesRequest(input: SeriesRequestInput) {
  const app = getApp("sonarr");
  const tagIds = input.tagIds ?? [];
  const monitorMode = input.monitorMode ?? "all";
  if (!sonarrMonitorOptions.some((option) => option.id === monitorMode)) {
    throw new Error(`Sonarr monitor mode is not available: ${monitorMode}`);
  }

  const [lookup, qualityProfiles, rootFolders, tags, existingSeries] = await Promise.all([
    sonarrSeriesLookup(app, `tvdb:${input.tvdbId}`),
    arrQualityProfiles(app),
    arrRootFolders(app),
    arrTags(app),
    sonarrSeries(app),
  ]);
  const selected = lookup.find((candidate) => Number(candidate.tvdbId) === input.tvdbId);
  if (!selected) throw new Error(`Sonarr could not resolve TVDB ID ${input.tvdbId}`);

  const qualityProfile = qualityProfiles.find((profile) => Number(profile.id) === input.qualityProfileId);
  if (!qualityProfile) throw new Error(`Quality profile ${input.qualityProfileId} is not available in Sonarr`);

  const rootFolder = rootFolders.find((folder) => folder.path === input.rootFolderPath);
  if (!rootFolder) throw new Error(`Root folder is not available in Sonarr: ${input.rootFolderPath}`);

  const unknownTags = tagIds.filter((tagId) => !tags.some((tag) => Number(tag.id) === tagId));
  if (unknownTags.length > 0) throw new Error(`Sonarr tag IDs are not available: ${unknownTags.join(", ")}`);

  const existing = existingSeries.find((series) => Number(series.tvdbId) === input.tvdbId);
  const request: SeriesRequestInput = {
    tvdbId: input.tvdbId,
    qualityProfileId: input.qualityProfileId,
    rootFolderPath: input.rootFolderPath,
    monitorMode,
    seasonFolder: input.seasonFolder ?? true,
    searchNow: input.searchNow ?? true,
    tagIds,
  };
  return { app, selected, qualityProfiles, rootFolders, tags, qualityProfile, rootFolder, existing, request };
}

function sonarrAddPayload(selected: AnyRecord, request: SeriesRequestInput) {
  return {
    ...selected,
    qualityProfileId: request.qualityProfileId,
    rootFolderPath: request.rootFolderPath,
    monitored: request.monitorMode !== "none",
    seasonFolder: request.seasonFolder ?? true,
    tags: request.tagIds ?? [],
    addOptions: {
      monitor: request.monitorMode ?? "all",
      searchForMissingEpisodes: request.searchNow ?? true,
      searchForCutoffUnmetEpisodes: false,
    },
  };
}

function seasonEpisodeCount(season: AnyRecord) {
  const value = Number(season?.statistics?.episodeCount ?? season?.statistics?.totalEpisodeCount ?? season?.episodeCount);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function expectedEpisodeCountForMonitor(series: AnyRecord, monitorMode?: string) {
  const seasons = Array.isArray(series?.seasons)
    ? series.seasons.filter((season: AnyRecord) => Number(season?.seasonNumber) > 0)
    : [];
  if (seasons.length === 0) return undefined;

  if (monitorMode === "firstSeason") {
    const firstSeason = seasons.reduce<AnyRecord | undefined>((best, season) =>
      !best || Number(season.seasonNumber) < Number(best.seasonNumber) ? season : best, undefined);
    return firstSeason ? seasonEpisodeCount(firstSeason) : undefined;
  }

  if (monitorMode === "latestSeason") {
    const latestSeason = seasons.reduce<AnyRecord | undefined>((best, season) =>
      !best || Number(season.seasonNumber) > Number(best.seasonNumber) ? season : best, undefined);
    return latestSeason ? seasonEpisodeCount(latestSeason) : undefined;
  }

  if (monitorMode === "all") {
    const counts = seasons.map(seasonEpisodeCount);
    return counts.every((count) => count !== undefined)
      ? counts.reduce((sum, count) => sum + Number(count), 0)
      : undefined;
  }

  return undefined;
}

function normalizeMediaTitle(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mediaTitleTokens(value: unknown) {
  return normalizeMediaTitle(value)
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function seriesTitleKey(value: unknown) {
  const text = String(value ?? "")
    .replace(/\((\d{4})\)/g, " $1 ")
    .replace(/\b\d{4}\b/g, " ")
    .replace(/\bS\d{1,2}(?:E\d{1,3})?\b.*$/i, " ")
    .replace(/\b\d{1,2}x\d{1,3}\b.*$/i, " ");
  return normalizeMediaTitle(text);
}

function titleMatchesMovie(candidateTitle: unknown, movieTitle: unknown) {
  const candidate = normalizeMediaTitle(candidateTitle);
  const tokens = mediaTitleTokens(movieTitle);
  if (!candidate || tokens.length === 0) return false;
  return tokens.every((token) => candidate.includes(token));
}

function titleMatchesSeries(candidateTitle: unknown, seriesTitle: unknown) {
  const candidate = seriesTitleKey(candidateTitle);
  const selected = seriesTitleKey(seriesTitle);
  const tokens = mediaTitleTokens(seriesTitle).filter((token) => !/^\d{4}$/.test(token));
  if (!candidate || !selected || tokens.length === 0) return false;
  return candidate === selected || tokens.every((token) => candidate.split(/\s+/).includes(token));
}

function titleMatchesFollow(candidateTitle: unknown, track: RequestFollowInput) {
  return track.service === "sonarr"
    ? titleMatchesSeries(candidateTitle, track.title)
    : titleMatchesMovie(candidateTitle, track.title);
}

function episodeMarkers(value: unknown) {
  const text = String(value ?? "");
  const markers = new Set<string>();
  for (const match of text.matchAll(/\bS(\d{1,2})E(\d{1,3})\b/gi)) {
    markers.add(`s${match[1].padStart(2, "0")}e${match[2].padStart(2, "0")}`);
  }
  for (const match of text.matchAll(/\b(\d{1,2})x(\d{1,3})\b/gi)) {
    markers.add(`s${match[1].padStart(2, "0")}e${match[2].padStart(2, "0")}`);
  }
  return markers;
}

function uniqueEpisodeMarkers(items: AnyRecord[]) {
  const markers = new Set<string>();
  for (const item of items) {
    for (const marker of episodeMarkers(item.title)) markers.add(marker);
  }
  return markers;
}

function countedEpisodeTotal(items: AnyRecord[]) {
  const markers = uniqueEpisodeMarkers(items);
  return markers.size || items.length;
}

function followItems(result: AnyRecord, serviceName: string, track: RequestFollowInput): AnyRecord[] {
  const service = Array.isArray(result?.services)
    ? result.services.find((entry: AnyRecord) => entry?.service === serviceName)
    : undefined;
  const items = Array.isArray(service?.items) ? service.items : [];
  return String(track.title ?? "") ? items.filter((item: AnyRecord) => titleMatchesFollow(item?.title, track)) : [];
}

function firstFollowItem(result: AnyRecord, serviceName: string, track: RequestFollowInput) {
  return followItems(result, serviceName, track)[0];
}

function followStatusView(args: {
  title: string;
  noun: string;
  status: AnyRecord;
  track: RequestFollowInput;
}) {
  const complete = Boolean(args.status.complete);
  const failed = Boolean(args.status.failed);
  const tone = failed ? "error" : complete ? "ok" : "info";
  const metrics = [
    { label: "Status", value: args.status.label, tone },
    args.status.progress !== undefined ? { label: "Progress", value: `${args.status.progress}%`, tone: "info" as const } : undefined,
    args.status.eta ? { label: "ETA", value: args.status.eta, tone: "info" as const } : undefined,
  ].filter(Boolean) as ViewMetric[];
  const items = [
    args.status.episodeDetail ? { label: "Episodes", value: args.status.episodeDetail } : undefined,
    args.status.detail ? { label: "Detail", detail: args.status.detail } : undefined,
  ].filter(Boolean) as ViewItem[];
  return withViewState(componentView(`${args.noun} Request`, args.status.summary, [
    {
      id: "request-follow",
      title: args.title,
      tone,
      metrics,
      items,
    },
  ]), complete
    ? { kind: "success", detail: args.status.summary }
    : failed
      ? { kind: "error", label: args.status.label, detail: args.status.detail, errors: [args.status.summary] }
      : { kind: "loading", label: args.status.label, detail: args.status.detail });
}

export async function requestFollowStatus(input: RequestFollowInput) {
  const service = input.service === "sonarr" ? "sonarr" : "radarr";
  const title = String(input.title ?? "").trim();
  if (!title && service === "sonarr" && !input.tvdbId) throw new Error("Series follow status needs a title or TVDB id.");
  if (!title && service === "radarr" && !input.tmdbId) throw new Error("Movie follow status needs a title or TMDB id.");

  const track: RequestFollowInput = {
    ...input,
    service,
    title,
    expectedEpisodeCount: Number(input.expectedEpisodeCount) || undefined,
    polls: Number(input.polls ?? 0),
  };
  const serviceLabel = service === "sonarr" ? "Sonarr" : "Radarr";
  const noun = service === "sonarr" ? "Series" : "Movie";
  const displayTitle = title || (service === "sonarr" ? `TVDB ${track.tvdbId}` : `TMDB ${track.tmdbId}`);
  const pageSize = Math.min(Math.max(Number(input.pageSize ?? 100) || 100, 1), 200);
  const [sabQueue, arrQueue, arrHistory, sabHistory]: AnyRecord[] = await Promise.all([
    downloadQueue("sabnzbd", pageSize).catch((error) => ({ error })),
    downloadQueue(service, pageSize).catch((error) => ({ error })),
    recentActivity(service, pageSize).catch((error) => ({ error })),
    recentActivity("sabnzbd", pageSize).catch((error) => ({ error })),
  ]);

  const sabQueueItems = followItems(sabQueue, "sabnzbd", track);
  const arrQueueItems = followItems(arrQueue, service, track);
  const activeItems = [...arrQueueItems, ...sabQueueItems];
  const sabQueueItem = sabQueueItems[0];
  const arrQueueItem = arrQueueItems[0];
  const arrItems = followItems(arrHistory, service, track);
  const sabHistoryItem = firstFollowItem(sabHistory, "sabnzbd", track);
  const importedItems = arrItems.filter((item) => String(item?.eventType ?? "").toLowerCase() === "downloadfolderimported");
  const imported = importedItems[0];
  const failed = arrItems.find((item) => String(item?.eventType ?? "").toLowerCase().includes("fail"))
    ?? (sabHistoryItem && sabHistoryItem.successful === false ? sabHistoryItem : undefined);
  const grabbed = arrItems.find((item) => String(item?.eventType ?? "").toLowerCase() === "grabbed");
  const expectedEpisodeCount = track.expectedEpisodeCount;
  const activeEpisodeCount = service === "sonarr" ? countedEpisodeTotal(activeItems) : Math.max(arrQueueItems.length, sabQueueItems.length);
  const importedCount = service === "sonarr" ? countedEpisodeTotal(importedItems) : importedItems.length;
  const importedDetail = expectedEpisodeCount
    ? `Imported: ${Math.min(importedCount, expectedEpisodeCount)}/${expectedEpisodeCount}`
    : importedCount > 0 ? `Imported: ${importedCount} recent` : undefined;

  let status: AnyRecord;
  if (service === "sonarr" && expectedEpisodeCount && importedCount >= expectedEpisodeCount) {
    status = {
      complete: true,
      label: "Imported",
      summary: `${displayTitle} imported ${expectedEpisodeCount}/${expectedEpisodeCount} expected episodes into ${serviceLabel}.`,
      episodeDetail: `Imported: ${expectedEpisodeCount}/${expectedEpisodeCount}`,
      detail: importedItems[0]?.title,
    };
  } else if (service === "sonarr" && activeEpisodeCount > 1) {
    const progressValues = activeItems.map((item) => Number(item?.progress)).filter((value) => Number.isFinite(value));
    const averageProgress = progressValues.length > 0
      ? Math.round(progressValues.reduce((sum, value) => sum + value, 0) / progressValues.length)
      : undefined;
    status = {
      label: "Downloading",
      summary: `${displayTitle} has ${activeEpisodeCount} episode downloads active.`,
      episodeDetail: [`Queue: ${activeEpisodeCount} episodes`, importedDetail].filter(Boolean).join("\n"),
      detail: arrQueueItem?.title ?? sabQueueItem?.title,
      progress: averageProgress,
      eta: activeItems.map((item) => item?.eta).find(Boolean),
    };
  } else if (service === "sonarr" && importedCount > 0 && expectedEpisodeCount) {
    status = {
      label: "Importing",
      summary: `${displayTitle} has imported ${importedCount}/${expectedEpisodeCount} expected episodes.`,
      episodeDetail: importedDetail,
      detail: importedItems[0]?.title,
    };
  } else if (imported) {
    status = {
      complete: true,
      label: "Imported",
      summary: `${displayTitle} imported into ${serviceLabel}.`,
      detail: imported.title,
    };
  } else if (sabQueueItem) {
    status = {
      label: String(sabQueueItem.status ?? "Downloading"),
      summary: `${displayTitle} is active in SABnzbd.`,
      episodeDetail: service === "sonarr" ? importedDetail : undefined,
      detail: sabQueueItem.title,
      progress: sabQueueItem.progress,
      eta: sabQueueItem.eta,
    };
  } else if (arrQueueItem) {
    status = {
      label: String(arrQueueItem.status ?? arrQueueItem.trackedDownloadStatus ?? "Downloading"),
      summary: `${displayTitle} is active in ${serviceLabel}'s queue.`,
      episodeDetail: service === "sonarr" ? importedDetail : undefined,
      detail: arrQueueItem.title,
      progress: arrQueueItem.progress,
      eta: arrQueueItem.eta,
    };
  } else if (failed && !grabbed) {
    status = {
      failed: true,
      complete: true,
      label: "Failed",
      summary: `${displayTitle} hit a failed download state.`,
      detail: failed.title,
    };
  } else if (grabbed) {
    status = {
      label: "Grabbed",
      summary: `${displayTitle} was grabbed by ${serviceLabel}; waiting for download/import status.`,
      detail: grabbed.title,
    };
  } else if (sabHistoryItem) {
    status = {
      label: String(sabHistoryItem.eventType ?? "SAB history"),
      summary: `${displayTitle} has SABnzbd history; waiting for ${serviceLabel} import.`,
      detail: sabHistoryItem.title,
    };
  } else {
    status = {
      label: "Requested",
      summary: `${displayTitle} was requested in ${serviceLabel}; waiting for queue activity.`,
      detail: service === "sonarr"
        ? (track.tvdbId ? `TVDB: ${track.tvdbId}` : "Tracking by title")
        : (track.tmdbId ? `TMDB: ${track.tmdbId}` : "Tracking by title"),
    };
  }

  status.polls = track.polls;
  const summary = status.summary;
  return toSummary({
    summary,
    view: followStatusView({ title: displayTitle, noun, status, track }),
    followStatus: status,
    track,
    queue: {
      service: arrQueueItems.length,
      sabnzbd: sabQueueItems.length,
    },
    history: {
      service: arrItems.length,
      sabnzbd: sabHistoryItem ? 1 : 0,
      imported: importedCount,
    },
  });
}

export async function previewSeriesRequest(input: SeriesRequestInput) {
  const context = await validateSeriesRequest(input);
  const requestToolsEnabled = safetyStatus().requestToolsEnabled;
  const warnings = context.existing ? [`${context.selected.title} already exists in Sonarr`] : [];
  const defaults = defaultSeriesRequestValues({
    qualityProfiles: context.qualityProfiles,
    rootFolders: context.rootFolders,
    request: context.request,
  });
  const formFields = seriesRequestFormFields({
    qualityProfiles: context.qualityProfiles,
    rootFolders: context.rootFolders,
    defaults,
  });
  const monitor = sonarrMonitorOptions.find((option) => option.id === context.request.monitorMode)?.label ?? context.request.monitorMode;
  const summary = warnings.length > 0
    ? `Preview ready for ${context.selected.title}; ${warnings[0]}.`
    : `Preview ready to request ${context.selected.title} (${context.selected.year}) in Sonarr.`;
  return toSummary({
    summary,
    view: withViewState(componentView("Series Request Preview", summary, [
      {
        id: "series-request",
        title: context.selected.title,
        tone: warnings.length > 0 ? "warning" : "info",
        media: seriesPoster(context.selected),
        metrics: [
          { label: "Year", value: context.selected.year ?? "unknown" },
          { label: "Quality", value: context.qualityProfile.name },
          { label: "Monitor", value: monitor },
        ],
        items: [
          { label: "Root Folder", value: context.rootFolder.path },
          { label: "Season Folders", value: context.request.seasonFolder ? "yes" : "no" },
          { label: "Search Now", value: context.request.searchNow ? "yes" : "no" },
          { label: "Tags", value: context.request.tagIds?.length ?? 0 },
        ],
        actions: [
          {
            id: "request-series",
            label: requestToolsEnabled ? "Request series" : "Requests disabled",
            kind: "submit",
            disabled: warnings.length > 0 || !requestToolsEnabled,
            payload: {
              tool: "request_series",
              ...context.request,
            },
          },
        ],
      },
    ]), panelState({
      warnings: warnings.length > 0 || !requestToolsEnabled
        ? [...warnings, ...(!requestToolsEnabled ? ["Request tools are disabled"] : [])]
        : [],
      confirmActionId: "request-series",
      confirmLabel: "Confirm series request",
      confirmDetail: `Request ${context.selected.title} in Sonarr`,
    })),
    requestDraft: seriesRequestDraft({
      selected: context.selected,
      qualityProfiles: context.qualityProfiles,
      rootFolders: context.rootFolders,
      tags: context.tags,
      request: context.request,
    }),
    components: discordSeriesPreviewComponents({
      summary,
      selected: context.selected,
      request: context.request,
      qualityProfile: context.qualityProfile,
      rootFolder: context.rootFolder,
      formFields,
      disabled: warnings.length > 0 || !requestToolsEnabled,
    }),
    payloadPreview: sonarrAddPayload(context.selected, context.request),
    warnings,
  });
}

export async function requestSeries(input: SeriesRequestInput) {
  requireRequestToolsEnabled();
  const context = await validateSeriesRequest(input);
  if (context.existing) throw new Error(`${context.selected.title} already exists in Sonarr`);

  const result = await sonarrAddSeries(context.app, sonarrAddPayload(context.selected, context.request));
  const expectedEpisodeCount = expectedEpisodeCountForMonitor(result, context.request.monitorMode)
    ?? expectedEpisodeCountForMonitor(context.selected, context.request.monitorMode);
  const summary = `Requested ${result.title ?? context.selected.title} in Sonarr.`;
  return toSummary({
    summary,
    view: withViewState(componentView("Series Requested", summary, [
      {
        id: "series-requested",
        title: "Sonarr",
        tone: "ok",
        metrics: [
          { label: "Series", value: result.title ?? context.selected.title },
          { label: "Search", value: context.request.searchNow ? "started" : "not started" },
        ],
      },
    ]), panelState({ successDetail: summary })),
    series: {
      id: result.id,
      tvdbId: result.tvdbId,
      title: result.title,
      year: result.year,
      monitored: result.monitored,
    },
    expectedEpisodeCount,
    monitorMode: context.request.monitorMode,
  });
}

export async function prowlarrSearch(query: string, type = "search", limit = 25) {
  const result = await arrGet<unknown[]>(getApp("prowlarr"), "search", { query, type });
  return Array.isArray(result) ? result.slice(0, limit) : result;
}
