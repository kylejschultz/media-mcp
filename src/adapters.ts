import type { AppConfig } from "./config.js";
import { arrGet, arrPost, beetsGet, jellyfinGet, sabGet, slskdGet } from "./http.js";
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

export async function sonarrSeries(app: AppConfig) {
  return arrGet<AnyRecord[]>(app, "series");
}

export async function sonarrSeriesLookup(app: AppConfig, term: string) {
  return arrGet<AnyRecord[]>(app, "series/lookup", { term });
}

export async function sonarrAddSeries(app: AppConfig, body: unknown) {
  return arrPost<AnyRecord>(app, "series", body);
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
