import type { AppName } from "./config.js";

export type AnyRecord = Record<string, any>;

export type ArrAppName = Extract<AppName, "sonarr" | "radarr" | "lidarr" | "prowlarr">;
export type LibraryAppName = Extract<AppName, "sonarr" | "radarr" | "lidarr">;
export type QueueAppName = Extract<AppName, "sonarr" | "radarr" | "lidarr" | "sabnzbd">;
export type JellyfinAppName = Extract<AppName, "jellyfin">;

export const libraryApps: LibraryAppName[] = ["sonarr", "radarr", "lidarr"];
export const queueApps: QueueAppName[] = ["sonarr", "radarr", "lidarr", "sabnzbd"];
export const diskApps: LibraryAppName[] = ["sonarr", "radarr", "lidarr"];
