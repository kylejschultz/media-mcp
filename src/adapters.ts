import type { AppConfig } from "./config.js";
import { arrGet, arrPost, arrPut, beetsGet, jellyfinGet, navidromeGet, sabGet, slskdGet, subwaveAdminGet, subwaveAdminPost, subwaveAdminPut, subwaveGet, subwaveText } from "./http.js";
import type { AnyRecord } from "./types.js";

export async function arrHealth(app: AppConfig) {
  return arrGet<AnyRecord[]>(app, "health");
}

export async function arrStatus(app: AppConfig) {
  return arrGet<AnyRecord>(app, "system/status");
}

export async function arrQualityProfiles(app: AppConfig) {
  return arrGet<AnyRecord[]>(app, "qualityprofile");
}

export async function arrRootFolders(app: AppConfig) {
  return arrGet<AnyRecord[]>(app, "rootfolder");
}

export async function arrTags(app: AppConfig) {
  return arrGet<AnyRecord[]>(app, "tag");
}

export async function radarrMovies(app: AppConfig) {
  return arrGet<AnyRecord[]>(app, "movie");
}

export async function radarrMovieLookup(app: AppConfig, term: string) {
  return arrGet<AnyRecord[]>(app, "movie/lookup", { term });
}

export async function radarrAddMovie(app: AppConfig, body: unknown) {
  return arrPost<AnyRecord>(app, "movie", body);
}

export async function radarrUpdateMovie(app: AppConfig, id: number, body: unknown) {
  return arrPut<AnyRecord>(app, `movie/${id}`, body);
}

export async function arrCommand(app: AppConfig, body: unknown) {
  return arrPost<AnyRecord>(app, "command", body);
}

export async function sonarrSeries(app: AppConfig) {
  return arrGet<AnyRecord[]>(app, "series");
}

export async function sonarrSeriesLookup(app: AppConfig, term: string) {
  return arrGet<AnyRecord[]>(app, "series/lookup", { term });
}

export async function sonarrAddSeries(app: AppConfig, body: unknown) {
  return arrPost<AnyRecord>(app, "series", body);
}

export async function sonarrUpdateSeries(app: AppConfig, id: number, body: unknown) {
  return arrPut<AnyRecord>(app, `series/${id}`, body);
}

export async function sabVersion(app: AppConfig) {
  return sabGet<{ version?: string }>(app, "version");
}

export async function jellyfinSystemInfo(app: AppConfig) {
  return jellyfinGet<AnyRecord>(app, "System/Info");
}

export async function beetsQueues(app: AppConfig) {
  return beetsGet<AnyRecord>(app, "api_v1/monitor/queues");
}

export async function beetsWorkers(app: AppConfig) {
  return beetsGet<AnyRecord>(app, "api_v1/monitor/workers");
}

export async function beetsJobs(app: AppConfig) {
  return beetsGet<AnyRecord[]>(app, "api_v1/monitor/jobs");
}

export async function beetsInboxTree(app: AppConfig) {
  return beetsGet<AnyRecord[]>(app, "api_v1/inbox/tree");
}

export async function beetsLibraryStats(app: AppConfig) {
  return beetsGet<AnyRecord>(app, "api_v1/library/stats");
}

export async function slskdServer(app: AppConfig) {
  return slskdGet<AnyRecord>(app, "api/v0/server");
}

export async function slskdDownloads(app: AppConfig) {
  return slskdGet<AnyRecord[]>(app, "api/v0/transfers/downloads");
}

export async function slskdUploads(app: AppConfig) {
  return slskdGet<AnyRecord[]>(app, "api/v0/transfers/uploads");
}

export async function slskdShares(app: AppConfig) {
  return slskdGet<AnyRecord>(app, "api/v0/shares");
}

export async function navidromePing(app: AppConfig) {
  return navidromeGet<AnyRecord>(app, "ping");
}

export async function navidromeScanStatus(app: AppConfig) {
  return navidromeGet<AnyRecord>(app, "getScanStatus");
}

export async function navidromeMusicFolders(app: AppConfig) {
  return navidromeGet<AnyRecord>(app, "getMusicFolders");
}

export async function navidromeSearch3(app: AppConfig, query: string, limit = 12) {
  return navidromeGet<AnyRecord>(app, "search3", {
    query,
    artistCount: limit,
    albumCount: limit,
    songCount: limit,
  });
}

export async function subwaveHealth(app: AppConfig) {
  return subwaveGet<AnyRecord>(app, "api/health");
}

export async function subwaveNowPlaying(app: AppConfig) {
  return subwaveGet<AnyRecord>(app, "api/now-playing");
}

export async function subwaveState(app: AppConfig) {
  return subwaveGet<AnyRecord>(app, "api/state");
}

export async function subwaveDj(app: AppConfig) {
  return subwaveGet<AnyRecord>(app, "api/dj");
}

export async function subwaveSchedule(app: AppConfig) {
  return subwaveGet<AnyRecord>(app, "api/schedule");
}

export async function subwaveSession(app: AppConfig) {
  return subwaveGet<AnyRecord>(app, "api/session");
}

export async function subwaveStats(app: AppConfig) {
  return subwaveAdminGet<AnyRecord>(app, "api/stats");
}

export async function subwaveSettings(app: AppConfig) {
  return subwaveAdminGet<AnyRecord>(app, "api/settings");
}

export async function subwaveUpsertShow(app: AppConfig, show: AnyRecord) {
  return subwaveAdminPost<AnyRecord>(app, "api/shows", { show });
}

export async function subwaveUpdateSchedule(app: AppConfig, schedule: AnyRecord) {
  return subwaveAdminPut<AnyRecord>(app, "api/schedule", { schedule });
}

export async function subwaveSearch(app: AppConfig, query: string) {
  return subwaveAdminGet<AnyRecord>(app, "api/dj/search", { q: query });
}

export async function subwaveRecent(app: AppConfig, limit = 20) {
  return subwaveAdminGet<AnyRecord>(app, "api/dj/recent", { limit });
}

export async function subwavePlaylists(app: AppConfig) {
  return subwaveAdminGet<AnyRecord>(app, "api/dj/playlists");
}

export async function subwaveListenPls(app: AppConfig) {
  return subwaveText(app, "listen.pls");
}

export async function subwaveListenM3u(app: AppConfig) {
  return subwaveText(app, "listen.m3u");
}
