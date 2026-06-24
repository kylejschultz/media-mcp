import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";

const envFiles = [
  process.env.MEDIA_MCP_ENV_FILE,
  "/config/.env",
  ".env",
].filter((path): path is string => Boolean(path));

for (const path of envFiles) {
  if (existsSync(path)) {
    loadEnv({ path, override: false, quiet: true });
    break;
  }
}

export type AppName = "sonarr" | "radarr" | "lidarr" | "prowlarr" | "sabnzbd" | "jellyfin" | "beets-flask" | "slskd";

export type AppConfig = {
  name: AppName;
  label: string;
  kind: "arr" | "sabnzbd" | "jellyfin" | "beets-flask" | "slskd";
  apiVersion?: "v1" | "v3";
  url?: string;
  apiKey?: string;
  keyEnv?: string;
};

const disabledApps = new Set(
  (process.env.DISABLED_APPS ?? "")
    .split(",")
    .map((value: string) => value.trim().toLowerCase())
    .filter(Boolean),
);

const appDefs: Array<Omit<AppConfig, "url" | "apiKey" | "keyEnv"> & { urlEnv: string; keyEnv?: string }> = [
  { name: "sonarr", label: "Sonarr", kind: "arr", apiVersion: "v3", urlEnv: "SONARR_URL", keyEnv: "SONARR_API_KEY" },
  { name: "radarr", label: "Radarr", kind: "arr", apiVersion: "v3", urlEnv: "RADARR_URL", keyEnv: "RADARR_API_KEY" },
  { name: "lidarr", label: "Lidarr", kind: "arr", apiVersion: "v1", urlEnv: "LIDARR_URL", keyEnv: "LIDARR_API_KEY" },
  { name: "prowlarr", label: "Prowlarr", kind: "arr", apiVersion: "v1", urlEnv: "PROWLARR_URL", keyEnv: "PROWLARR_API_KEY" },
  { name: "sabnzbd", label: "SABnzbd", kind: "sabnzbd", urlEnv: "SABNZBD_URL", keyEnv: "SABNZBD_API_KEY" },
  { name: "jellyfin", label: "Jellyfin", kind: "jellyfin", urlEnv: "JELLYFIN_URL", keyEnv: "JELLYFIN_API_KEY" },
  { name: "beets-flask", label: "beets-flask", kind: "beets-flask", urlEnv: "BEETS_FLASK_URL" },
  { name: "slskd", label: "slskd", kind: "slskd", urlEnv: "SLSKD_URL", keyEnv: "SLSKD_API_KEY" },
];

export const apps: AppConfig[] = appDefs
  .filter((app) => !disabledApps.has(app.name))
  .map(({ urlEnv, keyEnv, ...app }) => ({
    ...app,
    keyEnv,
    url: process.env[urlEnv],
    apiKey: keyEnv ? process.env[keyEnv] : undefined,
  }));

export function getApp(name: AppName): AppConfig {
  const app = apps.find((candidate) => candidate.name === name);
  if (!app) {
    throw new Error(`App is disabled or unknown: ${name}`);
  }
  if (!app.url || (app.keyEnv && !app.apiKey)) {
    const missing = [
      !app.url ? `${app.name.toUpperCase().replaceAll("-", "_")}_URL` : undefined,
      app.keyEnv && !app.apiKey ? app.keyEnv : undefined,
    ].filter(Boolean);
    throw new Error(`${app.label} is missing ${missing.join(" or ")}`);
  }
  return app;
}

export function configuredApps() {
  return apps.map((app) => ({
    name: app.name,
    label: app.label,
    kind: app.kind,
    configured: Boolean(app.url && (!app.keyEnv || app.apiKey)),
    missing: [
      !app.url ? `${app.name.toUpperCase().replaceAll("-", "_")}_URL` : undefined,
      app.keyEnv && !app.apiKey ? app.keyEnv : undefined,
    ].filter(Boolean),
  }));
}
