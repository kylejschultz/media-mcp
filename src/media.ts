import { apps, type AppConfig, type AppName, configuredApps, getApp } from "./config.js";
import {
  arrCommand,
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
  navidromeMusicFolders,
  navidromePing,
  navidromeScanStatus as navidromeScanStatusRaw,
  navidromeSearch3,
  radarrAddMovie,
  radarrMovieLookup,
  radarrMovies,
  radarrUpdateMovie,
  sabVersion,
  sonarrAddSeries,
  sonarrSeries,
  sonarrSeriesLookup,
  sonarrUpdateSeries,
  slskdDownloads,
  slskdServer,
  slskdShares,
  slskdUploads,
  subwaveDj,
  subwaveHealth,
  subwaveListenM3u,
  subwaveListenPls,
  subwaveNowPlaying as subwaveNowPlayingRaw,
  subwavePlaylists,
  subwaveRecent as subwaveRecentRaw,
  subwaveScheduleConfig,
  subwaveSearch as subwaveSearchRaw,
  subwaveSession,
  subwaveSettings,
  subwaveState,
  subwaveStats,
  subwaveUpdateSchedule as subwaveUpdateScheduleRaw,
  subwaveUpsertShow as subwaveUpsertShowRaw,
} from "./adapters.js";
import { arrGet, jellyfinGet, sabGet } from "./http.js";
import { bytes, completedAfterFailure, firstString, itemTitle } from "./format.js";
import { toSummary, withStatus } from "./results.js";
import { requireRequestToolsEnabled, safetyStatus } from "./safety.js";
import { expectedServiceIssue, getStackFlow, getStackModel, type StackFlowName } from "./stack-model.js";
import { diskApps, libraryApps, queueApps, type AnyRecord, type LibraryAppName, type QueueAppName } from "./types.js";
import {
  mediaView,
  countTone,
  healthTone,
  viewState,
  serviceLabel,
  withViewState,
  type RequestDraftField,
  type ViewItem,
  type ViewMetric,
} from "./views.js";

function configuredTargets(appName?: AppName) {
  return appName
    ? [getApp(appName)]
    : apps.filter((app) =>
        Boolean(
          app.url
          && (!app.keyEnv || app.apiKey)
          && (!app.credentialsRequired || (app.username && app.password)),
        ),
      );
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

function adminConfigured(app: AppConfig) {
  return Boolean(app.username && app.password);
}

function normalizeSubwaveTrack(track?: AnyRecord) {
  if (!track) return undefined;
  return {
    id: firstString(track.id, track.subsonic_id),
    title: firstString(track.title) ?? "unknown track",
    artist: firstString(track.artist),
    album: firstString(track.album),
    genre: firstString(track.genre),
    year: track.year,
    duration: track.duration,
    bpm: track.bpm,
    musicalKey: track.musicalKey,
    moods: track.moods,
    energy: track.energy,
    source: track.source,
    requestedBy: track.requestedBy,
    startedAt: track.startedAt,
    queuedAt: track.queuedAt,
  };
}

const fallbackSubwaveMoods = [
  "calm",
  "celebratory",
  "curious",
  "driving",
  "energetic",
  "evening",
  "festival",
  "focus",
  "night",
  "reflective",
  "romantic",
  "sunny",
  "upbeat",
  "warm",
  "weird",
  "workout",
];

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function subwaveShowRows(settings: AnyRecord): AnyRecord[] {
  return Array.isArray(settings.shows) ? settings.shows : [];
}

function subwaveShowIds(settings: AnyRecord) {
  return new Set(subwaveShowRows(settings).map((show) => firstString(show.id)).filter((id): id is string => Boolean(id)));
}

function subwaveAllowedMoods(settings: AnyRecord) {
  const moodCandidates = [
    ...asStringArray(settings.allowedMoods),
    ...asStringArray(settings.moods),
    ...asStringArray(settings.showMoods),
    ...subwaveShowRows(settings).flatMap((show) => asStringArray(show.moods)),
    ...((Array.isArray(settings.personas) ? settings.personas : [])
      .map((persona: AnyRecord) => firstString(persona.mood))
      .filter((mood: string | undefined): mood is string => Boolean(mood))),
  ];
  return new Set((moodCandidates.length > 0 ? moodCandidates : fallbackSubwaveMoods).map((mood) => mood.trim()).filter(Boolean));
}

function summarizeSubwaveShows(settings: AnyRecord) {
  return subwaveShowRows(settings).map((show) => ({
    id: firstString(show.id),
    name: firstString(show.name) ?? firstString(show.id) ?? "show",
  }));
}

function validateSubwaveShow(show: AnyRecord, settings: AnyRecord) {
  const id = firstString(show.id);
  const name = firstString(show.name);
  if (!id) throw new Error("Subwave show id is required.");
  if (!name) throw new Error("Subwave show name is required.");

  const allowedMoods = subwaveAllowedMoods(settings);
  const moods = asStringArray(show.moods);
  const invalidMoods = moods.filter((mood) => !allowedMoods.has(mood));
  if (invalidMoods.length > 0) {
    throw new Error(`Invalid Subwave show moods for ${id}: ${invalidMoods.join(", ")}. Allowed moods: ${[...allowedMoods].sort().join(", ")}`);
  }
}

function normalizeSubwaveSchedule(schedule: unknown, settings: AnyRecord) {
  const rows = Array.isArray(schedule)
    ? schedule
    : schedule && typeof schedule === "object"
      ? Array.from({ length: 7 }, (_, index) => (schedule as AnyRecord)[String(index)] ?? (schedule as AnyRecord)[index])
      : [];

  if (rows.length !== 7) {
    throw new Error(`Subwave schedule must have exactly 7 days; received ${rows.length}.`);
  }

  const showIds = subwaveShowIds(settings);
  const invalidSlots: Array<{ day: number; hour: number; showId: unknown }> = [];
  const normalized: Record<string, string[]> = {};

  rows.forEach((day, dayIndex) => {
    if (!Array.isArray(day) || day.length !== 24) {
      throw new Error(`Subwave schedule day ${dayIndex} must have exactly 24 hourly slots; received ${Array.isArray(day) ? day.length : typeof day}.`);
    }

    normalized[String(dayIndex)] = day.map((showId, hourIndex) => {
      if (typeof showId !== "string" || !showIds.has(showId)) {
        invalidSlots.push({ day: dayIndex, hour: hourIndex, showId });
      }
      return String(showId);
    });
  });

  if (invalidSlots.length > 0) {
    const preview = invalidSlots.slice(0, 8).map((slot) => `${slot.day}:${slot.hour}=${String(slot.showId)}`).join(", ");
    throw new Error(`Subwave schedule contains ${invalidSlots.length} invalid slots: ${preview}`);
  }

  return normalized;
}

function scheduleAt(settings: AnyRecord, day: number, hour: number) {
  const schedule = settings.schedule;
  if (!schedule) return undefined;
  if (Array.isArray(schedule)) return Array.isArray(schedule[day]) ? schedule[day][hour] : undefined;
  return Array.isArray(schedule[String(day)]) ? schedule[String(day)][hour] : undefined;
}

function diffSubwaveSchedule(before: AnyRecord, after: AnyRecord, intended?: Record<string, string[]>) {
  const differences: Array<{ day: number; hour: number; before?: unknown; after?: unknown }> = [];
  const droppedSlots: Array<{ day: number; hour: number; intended: string; actual?: unknown }> = [];

  for (let day = 0; day < 7; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const beforeValue = scheduleAt(before, day, hour);
      const afterValue = scheduleAt(after, day, hour);
      if (beforeValue !== afterValue) differences.push({ day, hour, before: beforeValue, after: afterValue });
      const intendedValue = intended?.[String(day)]?.[hour];
      if (intendedValue !== undefined && afterValue !== intendedValue) {
        droppedSlots.push({ day, hour, intended: intendedValue, actual: afterValue });
      }
    }
  }

  return { differences, droppedSlots };
}

function normalizeNavidromeSearch(response: AnyRecord) {
  const result = response.searchResult3 ?? {};
  const artists: AnyRecord[] = Array.isArray(result.artist) ? result.artist : [];
  const albums: AnyRecord[] = Array.isArray(result.album) ? result.album : [];
  const songs: AnyRecord[] = Array.isArray(result.song) ? result.song : [];
  return {
    artists: artists.map((artist) => ({
      id: artist.id,
      name: firstString(artist.name) ?? "artist",
      albumCount: artist.albumCount,
      coverArt: artist.coverArt,
    })),
    albums: albums.map((album) => ({
      id: album.id,
      name: firstString(album.name, album.title) ?? "album",
      artist: firstString(album.artist),
      songCount: album.songCount,
      year: album.year,
      coverArt: album.coverArt,
    })),
    songs: songs.map((song) => ({
      id: song.id,
      title: firstString(song.title) ?? "song",
      artist: firstString(song.artist),
      album: firstString(song.album),
      track: song.track,
      year: song.year,
      genre: song.genre,
      duration: song.duration,
      coverArt: song.coverArt,
    })),
  };
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
      if (app.kind === "navidrome") {
        const [ping, scan] = await Promise.all([
          withStatus(app, "ping", () => navidromePing(app)),
          withStatus(app, "getScanStatus", () => navidromeScanStatusRaw(app)),
        ]);
        return ping.ok
          ? {
              app: app.name,
              label: app.label,
              ok: true,
              version: ping.data.version,
              scan: scan.ok ? scan.data.scanStatus : undefined,
              warnings: scan.ok ? [] : [scan.error],
            }
          : ping;
      }
      if (app.kind === "subwave") {
        const result = await withStatus(app, "api/health", () => subwaveHealth(app));
        return result.ok
          ? { app: app.name, label: app.label, ok: true, status: result.data.status, adminConfigured: adminConfigured(app) }
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
      if (app.kind === "navidrome") {
        const [ping, scan, folders] = await Promise.all([
          withStatus(app, "ping", () => navidromePing(app)),
          withStatus(app, "getScanStatus", () => navidromeScanStatusRaw(app)),
          withStatus(app, "getMusicFolders", () => navidromeMusicFolders(app)),
        ]);
        const warnings = [ping, scan, folders].filter((result) => !result.ok).map((result) => result.error);
        return {
          service: app.name,
          label: app.label,
          configured: true,
          reachable: ping.ok,
          authenticated: ping.ok,
          version: ping.ok ? ping.data.version : undefined,
          health: warnings.length === 0 ? "ok" : "warning",
          latencyMs: ping.latencyMs,
          warnings,
          details: {
            scanning: scan.ok ? scan.data.scanStatus?.scanning : undefined,
            lastScan: scan.ok ? scan.data.scanStatus?.lastScan : undefined,
            folderCount: scan.ok ? scan.data.scanStatus?.folderCount : undefined,
            musicFolders: folders.ok ? folders.data.musicFolders?.musicFolder?.length ?? 0 : undefined,
          },
        };
      }
      if (app.kind === "subwave") {
        const [health, nowPlaying] = await Promise.all([
          withStatus(app, "api/health", () => subwaveHealth(app)),
          withStatus(app, "api/now-playing", () => subwaveNowPlayingRaw(app)),
        ]);
        const warnings = [health, nowPlaying].filter((result) => !result.ok).map((result) => result.error);
        return {
          service: app.name,
          label: app.label,
          configured: true,
          reachable: health.ok,
          authenticated: health.ok,
          version: undefined,
          health: warnings.length === 0 && health.ok && health.data.status === "on-air" ? "ok" : "warning",
          latencyMs: health.latencyMs,
          warnings,
          details: nowPlaying.ok
            ? {
                status: health.ok ? health.data.status : undefined,
                streamOnline: nowPlaying.data.streamOnline,
                listeners: nowPlaying.data.listeners,
                current: normalizeSubwaveTrack(nowPlaying.data.nowPlaying),
                dj: nowPlaying.data.dj,
              }
            : undefined,
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
    view: withViewState(mediaView("Service Status", summary, [
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
    ]), viewState({ warnings })),
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
      if (app.kind === "navidrome") {
        const [ping, scan] = await Promise.all([
          withStatus(app, "ping", () => navidromePing(app)),
          withStatus(app, "getScanStatus", () => navidromeScanStatusRaw(app)),
        ]);
        const issues = [
          ...(ping.ok ? [] : [{ severity: "error", message: ping.error }]),
          ...(scan.ok ? [] : [{ severity: "warning", message: scan.error }]),
        ];
        return {
          service: app.name,
          ok: issues.length === 0,
          health: issues.length === 0 ? "ok" : ping.ok ? "warning" : "error",
          issues,
          scan: scan.ok ? scan.data.scanStatus : undefined,
        };
      }
      if (app.kind === "subwave") {
        const [health, state] = await Promise.all([
          withStatus(app, "api/health", () => subwaveHealth(app)),
          withStatus(app, "api/state", () => subwaveState(app)),
        ]);
        const issues = [
          ...(health.ok ? [] : [{ severity: "error", message: health.error }]),
          ...(state.ok ? [] : [{ severity: "warning", message: state.error }]),
          ...(health.ok && health.data.status !== "on-air" ? [{ severity: "warning", message: `Subwave status is ${health.data.status}` }] : []),
        ];
        return {
          service: app.name,
          ok: issues.length === 0,
          health: issues.length === 0 ? "ok" : health.ok ? "warning" : "error",
          issues,
          current: state.ok ? normalizeSubwaveTrack(state.data.current) : undefined,
          queueLength: state.ok && Array.isArray(state.data.upcoming) ? state.data.upcoming.length : undefined,
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
    view: withViewState(mediaView("Service Health", summary, [
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
    ]), viewState({ warnings })),
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
    view: withViewState(mediaView("Disk Space", summary, [
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
    ]), viewState({ empty: services.every((service) => service.paths.length === 0), emptyLabel: "No disk paths reported", warnings })),
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
    view: withViewState(mediaView("Download Queue", summary, [
      {
        id: "queue",
        title: "Queue",
        tone: countTone(total),
        metrics: total > 0 ? [{ label: "Items", value: total, tone: countTone(total) }] : [],
        items: [...queueItems, ...queueWarnings],
      },
    ]), viewState({ empty: total === 0, emptyLabel: "No active queue items", warnings })),
    services,
    warnings,
  });
}

export async function history(appName: AppName, pageSize = 20) {
  const app = getApp(appName);
  if (app.kind === "sabnzbd") return sabGet(app, "history", { limit: pageSize });
  if (app.kind === "jellyfin") return jellyfinActivity(pageSize);
  if (app.kind === "navidrome") return navidromeScanStatusRaw(app);
  if (app.kind === "subwave") return subwaveState(app);
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

function normalizeNavidromeActivity(app: AppConfig, response: AnyRecord) {
  const scan = response.scanStatus ?? {};
  return [{
    service: app.name,
    title: scan.scanning ? "Scan in progress" : "Last library scan",
    eventType: scan.scanType ?? "scan",
    date: scan.lastScan,
    successful: scan.scanning === false,
    count: scan.count,
    folderCount: scan.folderCount,
  }];
}

function normalizeSubwaveActivity(app: AppConfig, response: AnyRecord, pageSize = 20) {
  const historyItems: AnyRecord[] = Array.isArray(response.history) ? response.history : [];
  const djLog: AnyRecord[] = Array.isArray(response.djLog) ? response.djLog : [];
  return [
    ...historyItems.slice(0, pageSize).map((item) => ({
      service: app.name,
      title: firstString(item.title) ?? "track",
      artist: firstString(item.artist),
      eventType: "played",
      date: firstString(item.endedAt, item.startedAt),
      successful: true,
    })),
    ...djLog.slice(0, Math.max(0, pageSize - historyItems.length)).map((item) => ({
      service: app.name,
      title: firstString(item.text) ?? "DJ log",
      eventType: firstString(item.kind) ?? "dj-log",
      date: item.t,
      successful: true,
    })),
  ].slice(0, pageSize);
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
            : app.kind === "navidrome"
              ? normalizeNavidromeActivity(app, result.data as AnyRecord)
              : app.kind === "subwave"
                ? normalizeSubwaveActivity(app, result.data as AnyRecord, pageSize)
                : normalizeArrHistory(app, result.data as AnyRecord);
      return { service: app.name, ok: true, items };
    }),
  );
  const total = services.reduce((sum, service) => sum + service.items.length, 0);
  const warnings = services.flatMap((service) => service.warnings?.map((warning: string) => `${service.service}: ${warning}`) ?? []);
  const summary = `${total} recent activity items returned across ${services.length} services.`;
  return toSummary({
    summary,
    view: withViewState(mediaView("Recent Activity", summary, [
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
    ]), viewState({ empty: total === 0, emptyLabel: "No recent activity", warnings })),
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
    view: withViewState(mediaView("Wanted Missing", summary, [
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
    ]), viewState({ empty: result.ok && total === 0, emptyLabel: `No missing wanted items for ${app.label}`, warnings })),
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
    view: withViewState(mediaView("Missing Media", summary, [
      {
        id: "missing",
        title: "Wanted Missing",
        tone: countTone(total),
        metrics: [{ label: "Missing", value: total, tone: countTone(total) }],
        items: [],
      },
      ...missingCards,
      ...missingWarnings,
    ]), viewState({ empty: total === 0, emptyLabel: "No missing wanted media", warnings })),
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
    view: mediaView("Jellyfin System", summary, [
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
    view: mediaView("Jellyfin Libraries", summary, [
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
    view: mediaView("Jellyfin Sessions", summary, [
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
    view: mediaView("Jellyfin Activity", summary, [
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
    view: mediaView("Jellyfin Tasks", summary, [
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
    view: mediaView("beets-flask", summary, [
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
    view: mediaView("slskd", summary, [
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

export async function navidromeStatus() {
  const app = getApp("navidrome");
  const [ping, scan, folders] = await Promise.all([
    withStatus(app, "ping", () => navidromePing(app)),
    withStatus(app, "getScanStatus", () => navidromeScanStatusRaw(app)),
    withStatus(app, "getMusicFolders", () => navidromeMusicFolders(app)),
  ]);
  const warnings = [ping, scan, folders].filter((result) => !result.ok).map((result) => `${result.operation}: ${result.error}`);
  const scanStatus = scan.ok ? scan.data.scanStatus : undefined;
  const musicFolders = folders.ok ? folders.data.musicFolders?.musicFolder ?? [] : [];
  const summary = warnings.length === 0
    ? `Navidrome is reachable; scan is ${scanStatus?.scanning ? "running" : "idle"} with ${musicFolders.length} accessible music folder.`
    : `Navidrome reported ${warnings.length} warnings.`;
  return toSummary({
    summary,
    view: withViewState(mediaView("Navidrome", summary, [
      {
        id: "library",
        title: "Library",
        tone: warnings.length > 0 ? "warning" : scanStatus?.scanning ? "info" : "ok",
        metrics: [
          { label: "Music Folders", value: musicFolders.length },
          { label: "Scanned Items", value: scanStatus?.count ?? "unknown" },
          { label: "Folder Count", value: scanStatus?.folderCount ?? "unknown" },
        ],
        items: [
          {
            label: "Scan",
            value: scanStatus?.scanning ? "running" : "idle",
            detail: scanStatus?.lastScan,
            tone: scanStatus?.scanning ? "info" : "ok",
          },
        ],
      },
    ]), viewState({ warnings })),
    ok: warnings.length === 0,
    version: ping.ok ? ping.data.version : undefined,
    scanStatus,
    musicFolders,
    warnings,
  });
}

export async function navidromeSearch(query: string, limit = 12) {
  const app = getApp("navidrome");
  const result = await withStatus(app, "search3", () => navidromeSearch3(app, query, limit));
  const normalized = result.ok ? normalizeNavidromeSearch(result.data) : { artists: [], albums: [], songs: [] };
  const total = normalized.artists.length + normalized.albums.length + normalized.songs.length;
  const warnings = result.ok ? [] : [result.error];
  const summary = result.ok ? `${total} Navidrome results for "${query}".` : `Navidrome search failed: ${result.error}`;
  return toSummary({
    summary,
    view: withViewState(mediaView("Navidrome Search", summary, [
      {
        id: "results",
        title: "Results",
        tone: warnings.length > 0 ? "warning" : total > 0 ? "info" : "ok",
        metrics: [
          { label: "Artists", value: normalized.artists.length },
          { label: "Albums", value: normalized.albums.length },
          { label: "Songs", value: normalized.songs.length },
        ],
        items: [
          ...normalized.songs.slice(0, 8).map((song) => ({ label: song.title, value: song.artist, detail: song.album, tone: "info" as const })),
          ...normalized.albums.slice(0, 4).map((album) => ({ label: album.name, value: album.artist, detail: "album", tone: "info" as const })),
        ],
      },
    ]), viewState({ empty: total === 0, emptyLabel: "No Navidrome results", warnings })),
    query,
    ...normalized,
    warnings,
  });
}

export async function navidromeScanStatus() {
  const app = getApp("navidrome");
  const result = await withStatus(app, "getScanStatus", () => navidromeScanStatusRaw(app));
  const scanStatus = result.ok ? result.data.scanStatus : undefined;
  const warnings = result.ok ? [] : [result.error];
  const summary = result.ok
    ? `Navidrome scan is ${scanStatus?.scanning ? "running" : "idle"}; last scan ${scanStatus?.lastScan ?? "unknown"}.`
    : `Navidrome scan status failed: ${result.error}`;
  return toSummary({
    summary,
    view: withViewState(mediaView("Navidrome Scan", summary, [
      {
        id: "scan",
        title: "Scan Status",
        tone: warnings.length > 0 ? "warning" : scanStatus?.scanning ? "info" : "ok",
        metrics: [
          { label: "Scanned Items", value: scanStatus?.count ?? "unknown" },
          { label: "Folder Count", value: scanStatus?.folderCount ?? "unknown" },
        ],
        items: [{
          label: "Last Scan",
          value: scanStatus?.scanType ?? "unknown",
          detail: scanStatus?.lastScan,
          tone: scanStatus?.scanning ? "info" : "ok",
        }],
      },
    ]), viewState({ warnings })),
    scanStatus,
    warnings,
  });
}

export async function subwaveStatus() {
  const app = getApp("subwave");
  const [health, nowPlaying, state, stats] = await Promise.all([
    withStatus(app, "api/health", () => subwaveHealth(app)),
    withStatus(app, "api/now-playing", () => subwaveNowPlayingRaw(app)),
    withStatus(app, "api/state", () => subwaveState(app)),
    adminConfigured(app)
      ? withStatus(app, "api/stats", () => subwaveStats(app))
      : Promise.resolve({ ok: false as const, app: app.name, operation: "api/stats", error: "Subwave admin credentials are not configured", latencyMs: 0 }),
  ]);
  const current = nowPlaying.ok ? normalizeSubwaveTrack(nowPlaying.data.nowPlaying) : undefined;
  const warnings = [health, nowPlaying, state].filter((result) => !result.ok).map((result) => `${result.operation}: ${result.error}`);
  const summary = warnings.length === 0
    ? `Subwave is ${health.ok ? health.data.status : "reachable"}; ${current?.title ?? "no track"} is currently playing.`
    : `Subwave reported ${warnings.length} warnings.`;
  return toSummary({
    summary,
    view: withViewState(mediaView("Subwave", summary, [
      {
        id: "station",
        title: "Station",
        tone: warnings.length > 0 ? "warning" : nowPlaying.ok && nowPlaying.data.streamOnline ? "ok" : "warning",
        metrics: [
          { label: "Listeners", value: nowPlaying.ok ? nowPlaying.data.listeners ?? 0 : "unknown" },
          { label: "Queue", value: state.ok && Array.isArray(state.data.upcoming) ? state.data.upcoming.length : "unknown" },
          { label: "Admin Reads", value: adminConfigured(app) ? "configured" : "missing", tone: adminConfigured(app) ? "ok" : "info" },
        ],
        items: [{
          label: current?.title ?? "No current track",
          value: current?.artist,
          detail: nowPlaying.ok ? nowPlaying.data.dj?.name ?? nowPlaying.data.activeShow?.name : undefined,
          tone: "info",
        }],
      },
    ]), viewState({ warnings })),
    ok: warnings.length === 0,
    health: health.ok ? health.data : undefined,
    nowPlaying: nowPlaying.ok ? nowPlaying.data : undefined,
    state: state.ok ? state.data : undefined,
    stats: stats.ok ? stats.data : undefined,
    adminConfigured: adminConfigured(app),
    warnings,
  });
}

export async function subwaveNowPlaying() {
  const app = getApp("subwave");
  const result = await withStatus(app, "api/now-playing", () => subwaveNowPlayingRaw(app));
  const current = result.ok ? normalizeSubwaveTrack(result.data.nowPlaying) : undefined;
  const warnings = result.ok ? [] : [result.error];
  const summary = result.ok
    ? `${current?.title ?? "Nothing"} by ${current?.artist ?? "unknown artist"} is currently playing.`
    : `Subwave now-playing failed: ${result.error}`;
  return toSummary({
    summary,
    view: withViewState(mediaView("Subwave Now Playing", summary, [
      {
        id: "now-playing",
        title: "Now Playing",
        tone: warnings.length > 0 ? "warning" : "info",
        metrics: [
          { label: "Listeners", value: result.ok ? result.data.listeners ?? 0 : "unknown" },
          { label: "Stream", value: result.ok && result.data.streamOnline ? "online" : "unknown", tone: result.ok && result.data.streamOnline ? "ok" : "warning" },
        ],
        items: current ? [{
          label: current.title,
          value: current.artist,
          detail: current.album,
          tone: "info",
        }] : [],
      },
    ]), viewState({ empty: result.ok && !current, emptyLabel: "No current Subwave track", warnings })),
    current,
    context: result.ok ? result.data.context : undefined,
    dj: result.ok ? result.data.dj : undefined,
    activeShow: result.ok ? result.data.activeShow : undefined,
    stream: result.ok ? result.data.stream : undefined,
    listeners: result.ok ? result.data.listeners : undefined,
    warnings,
  });
}

export async function subwaveStateSummary(pageSize = 20) {
  const app = getApp("subwave");
  const result = await withStatus(app, "api/state", () => subwaveState(app));
  const history = result.ok && Array.isArray(result.data.history) ? result.data.history : [];
  const upcoming = result.ok && Array.isArray(result.data.upcoming) ? result.data.upcoming : [];
  const warnings = result.ok ? [] : [result.error];
  const summary = result.ok
    ? `Subwave has ${upcoming.length} upcoming tracks and ${history.length} history rows.`
    : `Subwave state failed: ${result.error}`;
  return toSummary({
    summary,
    view: withViewState(mediaView("Subwave State", summary, [
      {
        id: "queue",
        title: "Queue",
        tone: warnings.length > 0 ? "warning" : upcoming.length > 0 ? "info" : "ok",
        metrics: [
          { label: "Upcoming", value: upcoming.length },
          { label: "History", value: history.length },
        ],
        items: upcoming.slice(0, pageSize).map((item) => ({
          label: firstString(item.title) ?? "track",
          value: firstString(item.artist),
          detail: item.requestedBy,
          tone: "info" as const,
        })),
      },
    ]), viewState({ warnings })),
    current: result.ok ? normalizeSubwaveTrack(result.data.current) : undefined,
    upcoming: upcoming.slice(0, pageSize).map(normalizeSubwaveTrack),
    history: history.slice(0, pageSize).map(normalizeSubwaveTrack),
    djLog: result.ok && Array.isArray(result.data.djLog) ? result.data.djLog.slice(0, pageSize) : [],
    timezone: result.ok ? result.data.timezone : undefined,
    warnings,
  });
}

export async function subwaveStreams() {
  const app = getApp("subwave");
  const [nowPlaying, pls, m3u] = await Promise.all([
    withStatus(app, "api/now-playing", () => subwaveNowPlayingRaw(app)),
    withStatus(app, "listen.pls", () => subwaveListenPls(app)),
    withStatus(app, "listen.m3u", () => subwaveListenM3u(app)),
  ]);
  const warnings = [nowPlaying, pls, m3u].filter((result) => !result.ok).map((result) => `${result.operation}: ${result.error}`);
  const summary = warnings.length === 0 ? "Subwave stream playlists are reachable." : `Subwave stream lookup reported ${warnings.length} warnings.`;
  return toSummary({
    summary,
    view: withViewState(mediaView("Subwave Streams", summary, [
      {
        id: "streams",
        title: "Streams",
        tone: warnings.length > 0 ? "warning" : "ok",
        metrics: [
          { label: "PLS", value: pls.ok ? "ok" : "error", tone: pls.ok ? "ok" : "warning" },
          { label: "M3U", value: m3u.ok ? "ok" : "error", tone: m3u.ok ? "ok" : "warning" },
        ],
        items: [{
          label: nowPlaying.ok ? nowPlaying.data.stream?.mount ?? "stream" : "stream",
          value: nowPlaying.ok ? nowPlaying.data.stream?.format : undefined,
          detail: nowPlaying.ok ? `${nowPlaying.data.stream?.bitrate ?? "unknown"} kbps` : undefined,
          tone: nowPlaying.ok && nowPlaying.data.streamOnline ? "ok" : "warning",
        }],
      },
    ]), viewState({ warnings })),
    stream: nowPlaying.ok ? nowPlaying.data.stream : undefined,
    streamOnline: nowPlaying.ok ? nowPlaying.data.streamOnline : undefined,
    playlists: {
      pls: pls.ok ? pls.data : undefined,
      m3u: m3u.ok ? m3u.data : undefined,
    },
    warnings,
  });
}

export async function subwaveSearchTracks(query: string, limit = 12) {
  const app = getApp("subwave");
  const result = await withStatus(app, "api/dj/search", () => subwaveSearchRaw(app, query));
  const tracks: AnyRecord[] = result.ok && Array.isArray(result.data.results) ? result.data.results.slice(0, limit) : [];
  const warnings = result.ok ? [] : [result.error];
  const summary = result.ok ? `${tracks.length} Subwave library results for "${query}".` : `Subwave search failed: ${result.error}`;
  return toSummary({
    summary,
    view: withViewState(mediaView("Subwave Search", summary, [
      {
        id: "results",
        title: "Results",
        tone: warnings.length > 0 ? "warning" : tracks.length > 0 ? "info" : "ok",
        metrics: [{ label: "Tracks", value: tracks.length }],
        items: tracks.map((track) => ({
          label: firstString(track.title) ?? "track",
          value: firstString(track.artist),
          detail: firstString(track.album),
          tone: "info" as const,
        })),
      },
    ]), viewState({ empty: result.ok && tracks.length === 0, emptyLabel: "No Subwave results", warnings })),
    query,
    tracks,
    warnings,
  });
}

export async function subwaveRecentTracks(limit = 20) {
  const app = getApp("subwave");
  const [recent, playlists] = await Promise.all([
    withStatus(app, "api/dj/recent", () => subwaveRecentRaw(app, limit)),
    withStatus(app, "api/dj/playlists", () => subwavePlaylists(app)),
  ]);
  const tracks: AnyRecord[] = recent.ok && Array.isArray(recent.data.results) ? recent.data.results : [];
  const playlistRows: AnyRecord[] = playlists.ok && Array.isArray(playlists.data.results) ? playlists.data.results : [];
  const warnings = [recent, playlists].filter((result) => !result.ok).map((result) => `${result.operation}: ${result.error}`);
  const summary = recent.ok ? `${tracks.length} recently added Subwave tracks returned.` : `Subwave recent lookup failed: ${recent.error}`;
  return toSummary({
    summary,
    view: withViewState(mediaView("Subwave Recent", summary, [
      {
        id: "recent",
        title: "Recently Added",
        tone: warnings.length > 0 ? "warning" : tracks.length > 0 ? "info" : "ok",
        metrics: [
          { label: "Tracks", value: tracks.length },
          { label: "Playlists", value: playlistRows.length },
        ],
        items: tracks.slice(0, limit).map((track) => ({
          label: firstString(track.title) ?? "track",
          value: firstString(track.artist),
          detail: firstString(track.album),
          tone: "info" as const,
        })),
      },
    ]), viewState({ empty: tracks.length === 0, emptyLabel: "No recent Subwave tracks", warnings })),
    tracks,
    playlists: playlistRows,
    warnings,
  });
}

export async function subwaveUpsertShow(show: AnyRecord) {
  requireRequestToolsEnabled();

  const app = getApp("subwave");
  const settings = await subwaveSettings(app);
  validateSubwaveShow(show, settings);

  const writeResult = await subwaveUpsertShowRaw(app, show);
  const after = await subwaveScheduleConfig(app);
  const showNames = summarizeSubwaveShows(after);
  const upserted = subwaveShowRows(after).find((candidate) => firstString(candidate.id) === firstString(show.id));
  const warnings = upserted ? [] : [`Subwave settings read-back did not include show ${firstString(show.id) ?? "unknown"}.`];
  const summary = warnings.length === 0
    ? `Upserted Subwave show ${firstString(upserted?.name, show.name) ?? firstString(show.id) ?? "show"}; ${showNames.length} shows are configured.`
    : `Subwave show write completed with ${warnings.length} warning.`;

  return toSummary({
    summary,
    view: withViewState(mediaView("Subwave Show Upsert", summary, [
      {
        id: "shows",
        title: "Shows",
        tone: warnings.length > 0 ? "warning" : "ok",
        metrics: [{ label: "Shows", value: showNames.length }],
        items: showNames.map((row) => ({
          label: row.name,
          value: row.id,
          tone: row.id === firstString(show.id) ? "ok" as const : "info" as const,
        })),
      },
    ]), viewState({ warnings })),
    show: upserted,
    showNames,
    writeResult,
    warnings,
  });
}

export async function subwaveUpdateWeeklySchedule(schedule: unknown) {
  requireRequestToolsEnabled();

  const app = getApp("subwave");
  const before = await subwaveScheduleConfig(app);
  const normalizedSchedule = normalizeSubwaveSchedule(schedule, before);

  const writeResult = await subwaveUpdateScheduleRaw(app, normalizedSchedule);
  const after = await subwaveScheduleConfig(app);
  const { differences, droppedSlots } = diffSubwaveSchedule(before, after, normalizedSchedule);
  const showNames = summarizeSubwaveShows(after);
  const warnings = droppedSlots.map((slot) => `Dropped ${slot.day}:${slot.hour} intended ${slot.intended}; read back ${String(slot.actual)}`);
  const summary = warnings.length === 0
    ? `Updated Subwave weekly schedule with ${differences.length} changed slots; ${showNames.length} shows are configured.`
    : `Subwave schedule write completed with ${droppedSlots.length} dropped or mismatched slots.`;

  return toSummary({
    summary,
    view: withViewState(mediaView("Subwave Schedule Update", summary, [
      {
        id: "schedule",
        title: "Schedule",
        tone: warnings.length > 0 ? "warning" : "ok",
        metrics: [
          { label: "Changed Slots", value: differences.length },
          { label: "Dropped Slots", value: droppedSlots.length, tone: droppedSlots.length > 0 ? "warning" : "ok" },
          { label: "Shows", value: showNames.length },
        ],
        items: differences.slice(0, 24).map((slot) => ({
          label: `${slot.day}:${String(slot.hour).padStart(2, "0")}`,
          value: String(slot.after ?? ""),
          detail: slot.before === undefined ? undefined : `was ${String(slot.before)}`,
          tone: "info" as const,
        })),
      },
    ]), viewState({ warnings })),
    showNames,
    scheduleDifferences: differences,
    droppedSlots,
    writeResult,
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
    view: withViewState(mediaView("Library Counts", summary, [
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
    ]), viewState({ warnings })),
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
    view: withViewState(mediaView("Import Issues", summary, [
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
    ]), viewState({
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
    view: withViewState(mediaView("Indexer Status", summary, [
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
    ]), viewState({
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
    view: withViewState(mediaView("Media Stack", summary, [
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
    ]), viewState({ warnings })),
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
    view: mediaView("Stack Model", summary, [
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
    view: mediaView("Media Flow", summary, [
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
}): RequestDraftField[] {
  return [
    {
      id: "qualityProfileId",
      label: "Quality Profile",
      type: "select",
      required: true,
      value: args.defaults.qualityProfileId,
      placeholder: "Choose quality",
      options: qualityProfileOptions(args.qualityProfiles).map((profile) => ({
        label: truncateOptionText(profile.label, 100),
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
        label: truncateOptionText(folder.label, 100),
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

function truncateOptionText(value: unknown, maxLength: number) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
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
    view: mediaView("Radarr Request Options", summary, [
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
    view: withViewState(mediaView("Movie Search", summary, [
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
    ]), viewState({ empty: candidates.length === 0, emptyLabel: "No movie candidates found" })),
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
  const summary = warnings.length > 0
    ? `Preview ready for ${context.selected.title}; ${warnings[0]}.`
    : `Preview ready to request ${context.selected.title} (${context.selected.year}) in Radarr.`;
  return toSummary({
    summary,
    view: withViewState(mediaView("Movie Request Preview", summary, [
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
    ]), viewState({
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
    view: withViewState(mediaView("Movie Requested", summary, [
      {
        id: "movie-requested",
        title: "Radarr",
        tone: "ok",
        metrics: [
          { label: "Movie", value: result.title ?? context.selected.title },
          { label: "Search", value: context.request.searchNow ? "started" : "not started" },
        ],
      },
    ]), viewState({ successDetail: summary })),
    movie: {
      id: result.id,
      tmdbId: result.tmdbId,
      title: result.title,
      year: result.year,
      monitored: result.monitored,
    },
  });
}

function lifecycleView(args: {
  title: string;
  summary: string;
  targetLabel: string;
  monitored: boolean;
  searchStarted: boolean;
  detail?: string;
}) {
  return withViewState(mediaView(args.title, args.summary, [
    {
      id: "lifecycle",
      title: args.targetLabel,
      tone: "ok",
      metrics: [
        { label: "Monitored", value: args.monitored ? "yes" : "no", tone: args.monitored ? "ok" : "warning" },
        { label: "Search", value: args.searchStarted ? "started" : "not started", tone: args.searchStarted ? "info" : "ok" },
      ],
      items: args.detail ? [{ label: "Scope", value: args.detail }] : undefined,
    },
  ]), viewState({ successDetail: args.summary }));
}

function movieLifecyclePayload(args: {
  tmdbId: number;
  movieId: number;
  title?: string;
  monitored: boolean;
  searchStarted: boolean;
  command?: AnyRecord;
}) {
  return {
    schema: "media-mcp.lifecycle.v1",
    service: "radarr",
    mediaType: "movie",
    action: "set_monitoring",
    target: {
      tmdbId: args.tmdbId,
      movieId: args.movieId,
      title: args.title,
    },
    monitored: args.monitored,
    searchStarted: args.searchStarted,
    commandId: args.command?.id,
  };
}

export async function setMovieMonitoring(input: MovieMonitoringInput) {
  requireRequestToolsEnabled();
  const app = getApp("radarr");
  const monitored = input.monitored ?? true;
  const searchNow = input.searchNow ?? false;
  const movies = await radarrMovies(app);
  const existing = movies.find((candidate) => Number(candidate.tmdbId) === input.tmdbId);
  if (!existing) throw new Error(`TMDB ID ${input.tmdbId} is not in Radarr; request the movie first.`);

  const movieId = Number(existing.id);
  if (!Number.isFinite(movieId) || movieId <= 0) throw new Error(`Radarr movie for TMDB ID ${input.tmdbId} has no usable id.`);

  const updated = await radarrUpdateMovie(app, movieId, { ...existing, monitored });
  const command = searchNow ? await arrCommand(app, { name: "MoviesSearch", movieIds: [movieId] }) : undefined;
  const title = String(updated.title ?? existing.title ?? `TMDB ${input.tmdbId}`);
  const summary = `Updated ${title} monitoring in Radarr${searchNow ? " and started a movie search" : ""}.`;
  const lifecycle = movieLifecyclePayload({
    tmdbId: input.tmdbId,
    movieId,
    title,
    monitored,
    searchStarted: Boolean(command),
    command,
  });
  return toSummary({
    summary,
    view: lifecycleView({
      title: "Movie Monitoring Updated",
      summary,
      targetLabel: title,
      monitored,
      searchStarted: Boolean(command),
    }),
    lifecycle,
    movie: {
      id: updated.id ?? movieId,
      tmdbId: updated.tmdbId ?? input.tmdbId,
      title,
      monitored: updated.monitored ?? monitored,
    },
    command,
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

type MovieMonitoringInput = {
  tmdbId: number;
  monitored?: boolean;
  searchNow?: boolean;
};

type SeriesSeasonMonitoringInput = {
  tvdbId: number;
  seasonNumber: number;
  monitored?: boolean;
  searchNow?: boolean;
};

type SeriesSeasonRequestInput = SeriesRequestInput & {
  seasonNumber: number;
  monitored?: boolean;
};

type RequestFollowInput = {
  service: "sonarr" | "radarr";
  title?: string;
  tmdbId?: number;
  tvdbId?: number;
  year?: number;
  expectedEpisodeCount?: number;
  monitorMode?: string;
  requestedAt?: string;
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
}): RequestDraftField[] {
  return [
    {
      id: "qualityProfileId",
      label: "Quality Profile",
      type: "select",
      required: true,
      value: args.defaults.qualityProfileId,
      placeholder: "Choose quality",
      options: qualityProfileOptions(args.qualityProfiles).map((profile) => ({
        label: truncateOptionText(profile.label, 100),
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
        label: truncateOptionText(folder.label, 100),
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
    view: mediaView("Sonarr Request Options", summary, [
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
    view: withViewState(mediaView("Series Search", summary, [
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
    ]), viewState({ empty: candidates.length === 0, emptyLabel: "No series candidates found" })),
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

function findSeason(series: AnyRecord, seasonNumber: number) {
  return Array.isArray(series?.seasons)
    ? series.seasons.find((season: AnyRecord) => Number(season?.seasonNumber) === seasonNumber)
    : undefined;
}

function seasonScopedSeriesPayload(series: AnyRecord, seasonNumber: number, monitored: boolean) {
  const seasons = Array.isArray(series?.seasons) ? series.seasons : [];
  const selected = seasons.find((season: AnyRecord) => Number(season?.seasonNumber) === seasonNumber);
  if (!selected) throw new Error(`${series.title ?? "Series"} does not have season ${seasonNumber} in Sonarr.`);

  const updatedSeasons = seasons.map((season: AnyRecord) =>
    Number(season?.seasonNumber) === seasonNumber ? { ...season, monitored } : { ...season });
  return {
    ...series,
    monitored: updatedSeasons.some((season: AnyRecord) => Boolean(season.monitored)),
    seasons: updatedSeasons,
  };
}

function seasonOnlySeriesPayload(series: AnyRecord, seasonNumber: number, monitored: boolean) {
  const seasons = Array.isArray(series?.seasons) ? series.seasons : [];
  const selected = seasons.find((season: AnyRecord) => Number(season?.seasonNumber) === seasonNumber);
  if (!selected) throw new Error(`${series.title ?? "Series"} does not have season ${seasonNumber} in Sonarr.`);

  const updatedSeasons = seasons.map((season: AnyRecord) => ({
    ...season,
    monitored: Number(season?.seasonNumber) === seasonNumber ? monitored : false,
  }));
  return {
    ...series,
    monitored,
    seasons: updatedSeasons,
  };
}

function seasonLifecyclePayload(args: {
  tvdbId: number;
  seriesId: number;
  title?: string;
  seasonNumber: number;
  monitored: boolean;
  searchStarted: boolean;
  expectedEpisodeCount?: number;
  command?: AnyRecord;
}) {
  return {
    schema: "media-mcp.lifecycle.v1",
    service: "sonarr",
    mediaType: "series",
    action: "set_season_monitoring",
    scope: "season",
    target: {
      tvdbId: args.tvdbId,
      seriesId: args.seriesId,
      title: args.title,
      seasonNumber: args.seasonNumber,
    },
    monitored: args.monitored,
    searchStarted: args.searchStarted,
    expectedEpisodeCount: args.expectedEpisodeCount,
    commandId: args.command?.id,
  };
}

async function updateExistingSeriesSeason(input: SeriesSeasonMonitoringInput) {
  const app = getApp("sonarr");
  const monitored = input.monitored ?? true;
  const searchNow = input.searchNow ?? false;
  const allSeries = await sonarrSeries(app);
  const existing = allSeries.find((candidate) => Number(candidate.tvdbId) === input.tvdbId);
  if (!existing) throw new Error(`TVDB ID ${input.tvdbId} is not in Sonarr; request the series first.`);

  const seriesId = Number(existing.id);
  if (!Number.isFinite(seriesId) || seriesId <= 0) throw new Error(`Sonarr series for TVDB ID ${input.tvdbId} has no usable id.`);

  const selectedSeason = findSeason(existing, input.seasonNumber);
  const payload = seasonScopedSeriesPayload(existing, input.seasonNumber, monitored);
  const updated = await sonarrUpdateSeries(app, seriesId, payload);
  const command = searchNow ? await arrCommand(app, { name: "SeasonSearch", seriesId, seasonNumber: input.seasonNumber }) : undefined;
  const title = String(updated.title ?? existing.title ?? `TVDB ${input.tvdbId}`);
  const expectedEpisodeCount = seasonEpisodeCount(selectedSeason);
  const summary = `Updated ${title} season ${input.seasonNumber} monitoring in Sonarr${searchNow ? " and started a season search" : ""}.`;
  const lifecycle = seasonLifecyclePayload({
    tvdbId: input.tvdbId,
    seriesId,
    title,
    seasonNumber: input.seasonNumber,
    monitored,
    searchStarted: Boolean(command),
    expectedEpisodeCount,
    command,
  });
  return {
    summary,
    view: lifecycleView({
      title: "Season Monitoring Updated",
      summary,
      targetLabel: `${title} season ${input.seasonNumber}`,
      monitored,
      searchStarted: Boolean(command),
      detail: "Only the requested season was changed",
    }),
    lifecycle,
    series: {
      id: updated.id ?? seriesId,
      tvdbId: updated.tvdbId ?? input.tvdbId,
      title,
      monitored: updated.monitored ?? payload.monitored,
    },
    season: {
      seasonNumber: input.seasonNumber,
      monitored,
      expectedEpisodeCount,
    },
    expectedEpisodeCount,
    command,
  };
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

function timestampMs(value: unknown) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function itemAtOrAfter(item: AnyRecord, sinceMs?: number) {
  if (sinceMs === undefined) return true;
  const itemMs = timestampMs(item.date ?? item.completed ?? item.time);
  return itemMs !== undefined && itemMs >= sinceMs;
}

function followItemsSince(result: AnyRecord, serviceName: string, track: RequestFollowInput, sinceMs?: number) {
  return followItems(result, serviceName, track).filter((item) => itemAtOrAfter(item, sinceMs));
}

function firstFollowItemSince(result: AnyRecord, serviceName: string, track: RequestFollowInput, sinceMs?: number) {
  return followItemsSince(result, serviceName, track, sinceMs)[0];
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
  return withViewState(mediaView(`${args.noun} Request`, args.status.summary, [
    {
      id: "request-follow",
      title: args.title,
      tone,
      metrics,
      items,
    },
  ]), failed
    ? { kind: "error", label: args.status.label, detail: args.status.detail, errors: [args.status.summary] }
    : complete
      ? { kind: "success", detail: args.status.summary }
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
    requestedAt: input.requestedAt,
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

  const requestedAtMs = timestampMs(track.requestedAt);
  const sabQueueItems = followItems(sabQueue, "sabnzbd", track);
  const arrQueueItems = followItems(arrQueue, service, track);
  const activeItems = [...arrQueueItems, ...sabQueueItems];
  const sabQueueItem = sabQueueItems[0];
  const arrQueueItem = arrQueueItems[0];
  const arrItems = followItemsSince(arrHistory, service, track, requestedAtMs);
  const sabHistoryItem = firstFollowItemSince(sabHistory, "sabnzbd", track, requestedAtMs);
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
      phase: "imported",
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
      phase: "downloading",
      label: "Downloading",
      summary: `${displayTitle} has ${activeEpisodeCount} episode downloads active.`,
      episodeDetail: [`Queue: ${activeEpisodeCount} episodes`, importedDetail].filter(Boolean).join("\n"),
      detail: arrQueueItem?.title ?? sabQueueItem?.title,
      progress: averageProgress,
      eta: activeItems.map((item) => item?.eta).find(Boolean),
    };
  } else if (service === "sonarr" && importedCount > 0 && expectedEpisodeCount) {
    status = {
      phase: "importing",
      label: "Importing",
      summary: `${displayTitle} has imported ${importedCount}/${expectedEpisodeCount} expected episodes.`,
      episodeDetail: importedDetail,
      detail: importedItems[0]?.title,
    };
  } else if (imported) {
    status = {
      phase: "imported",
      complete: true,
      label: "Imported",
      summary: `${displayTitle} imported into ${serviceLabel}.`,
      detail: imported.title,
    };
  } else if (sabQueueItem) {
    status = {
      phase: "downloading",
      label: String(sabQueueItem.status ?? "Downloading"),
      summary: `${displayTitle} is active in SABnzbd.`,
      episodeDetail: service === "sonarr" ? importedDetail : undefined,
      detail: sabQueueItem.title,
      progress: sabQueueItem.progress,
      eta: sabQueueItem.eta,
    };
  } else if (arrQueueItem) {
    status = {
      phase: "queued",
      label: String(arrQueueItem.status ?? arrQueueItem.trackedDownloadStatus ?? "Downloading"),
      summary: `${displayTitle} is active in ${serviceLabel}'s queue.`,
      episodeDetail: service === "sonarr" ? importedDetail : undefined,
      detail: arrQueueItem.title,
      progress: arrQueueItem.progress,
      eta: arrQueueItem.eta,
    };
  } else if (failed && !grabbed) {
    status = {
      phase: "failed",
      failed: true,
      complete: true,
      label: "Failed",
      summary: `${displayTitle} hit a failed download state.`,
      detail: failed.title,
    };
  } else if (grabbed) {
    status = {
      phase: "grabbed",
      label: "Grabbed",
      summary: `${displayTitle} was grabbed by ${serviceLabel}; waiting for download/import status.`,
      detail: grabbed.title,
    };
  } else if (sabHistoryItem) {
    status = {
      phase: "importing",
      label: String(sabHistoryItem.eventType ?? "SAB history"),
      summary: `${displayTitle} has SABnzbd history; waiting for ${serviceLabel} import.`,
      detail: sabHistoryItem.title,
    };
  } else {
    status = {
      phase: "requested",
      label: "Requested",
      summary: `${displayTitle} was requested in ${serviceLabel}; waiting for queue activity.`,
      detail: service === "sonarr"
        ? (track.tvdbId ? `TVDB: ${track.tvdbId}` : "Tracking by title")
        : (track.tmdbId ? `TMDB: ${track.tmdbId}` : "Tracking by title"),
    };
  }

  const terminal = Boolean(status.complete || status.failed);
  const polls = Number(track.polls ?? 0);
  Object.assign(status, {
    schema: "media-mcp.followStatus.v1",
    service,
    mediaType: service === "sonarr" ? "series" : "movie",
    title: displayTitle,
    complete: Boolean(status.complete),
    failed: Boolean(status.failed),
    terminal,
    expectedEpisodeCount,
    activeCount: activeEpisodeCount,
    importedCount,
    queueCount: {
      service: arrQueueItems.length,
      sabnzbd: sabQueueItems.length,
      total: activeItems.length,
    },
    historyCount: {
      service: arrItems.length,
      sabnzbd: sabHistoryItem ? 1 : 0,
      imported: importedCount,
    },
    requestedAt: track.requestedAt,
    polls,
    nextPollRecommended: !terminal,
    pollDelaySeconds: terminal ? undefined : Math.min(60, 5 + polls * 5),
  });
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
  const monitor = sonarrMonitorOptions.find((option) => option.id === context.request.monitorMode)?.label ?? context.request.monitorMode;
  const summary = warnings.length > 0
    ? `Preview ready for ${context.selected.title}; ${warnings[0]}.`
    : `Preview ready to request ${context.selected.title} (${context.selected.year}) in Sonarr.`;
  return toSummary({
    summary,
    view: withViewState(mediaView("Series Request Preview", summary, [
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
    ]), viewState({
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
    view: withViewState(mediaView("Series Requested", summary, [
      {
        id: "series-requested",
        title: "Sonarr",
        tone: "ok",
        metrics: [
          { label: "Series", value: result.title ?? context.selected.title },
          { label: "Search", value: context.request.searchNow ? "started" : "not started" },
        ],
      },
    ]), viewState({ successDetail: summary })),
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

export async function setSeriesSeasonMonitoring(input: SeriesSeasonMonitoringInput) {
  requireRequestToolsEnabled();
  return toSummary(await updateExistingSeriesSeason(input));
}

export async function requestSeriesSeason(input: SeriesSeasonRequestInput) {
  requireRequestToolsEnabled();
  const monitored = input.monitored ?? true;
  const searchNow = input.searchNow ?? true;
  const context = await validateSeriesRequest({
    ...input,
    monitorMode: "none",
    searchNow: false,
  });

  if (context.existing) {
    return toSummary(await updateExistingSeriesSeason({
      tvdbId: input.tvdbId,
      seasonNumber: input.seasonNumber,
      monitored,
      searchNow,
    }));
  }

  const selectedSeason = findSeason(context.selected, input.seasonNumber);
  const addPayload = seasonOnlySeriesPayload(
    sonarrAddPayload(context.selected, { ...context.request, monitorMode: "none", searchNow: false }),
    input.seasonNumber,
    monitored,
  );
  const result = await sonarrAddSeries(context.app, addPayload);
  const seriesId = Number(result.id);
  const command = searchNow && Number.isFinite(seriesId) && seriesId > 0
    ? await arrCommand(context.app, { name: "SeasonSearch", seriesId, seasonNumber: input.seasonNumber })
    : undefined;
  const title = String(result.title ?? context.selected.title ?? `TVDB ${input.tvdbId}`);
  const expectedEpisodeCount = seasonEpisodeCount(selectedSeason);
  const summary = `Requested ${title} season ${input.seasonNumber} in Sonarr${command ? " and started a season search" : ""}.`;
  const lifecycle = seasonLifecyclePayload({
    tvdbId: input.tvdbId,
    seriesId,
    title,
    seasonNumber: input.seasonNumber,
    monitored,
    searchStarted: Boolean(command),
    expectedEpisodeCount,
    command,
  });
  return toSummary({
    summary,
    view: lifecycleView({
      title: "Season Requested",
      summary,
      targetLabel: `${title} season ${input.seasonNumber}`,
      monitored,
      searchStarted: Boolean(command),
      detail: "Only the requested season was monitored",
    }),
    lifecycle,
    series: {
      id: result.id,
      tvdbId: result.tvdbId ?? input.tvdbId,
      title,
      monitored: result.monitored ?? monitored,
    },
    season: {
      seasonNumber: input.seasonNumber,
      monitored,
      expectedEpisodeCount,
    },
    expectedEpisodeCount,
    command,
  });
}

export async function prowlarrSearch(query: string, type = "search", limit = 25) {
  const result = await arrGet<unknown[]>(getApp("prowlarr"), "search", { query, type });
  return Array.isArray(result) ? result.slice(0, limit) : result;
}
