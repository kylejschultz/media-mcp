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

export type AppName =
  | "sonarr"
  | "radarr"
  | "lidarr"
  | "prowlarr"
  | "sabnzbd"
  | "jellyfin"
  | "beets-flask"
  | "slskd"
  | "navidrome"
  | "subwave";

export type AppConfig = {
  name: AppName;
  label: string;
  kind: "arr" | "sabnzbd" | "jellyfin" | "beets-flask" | "slskd" | "navidrome" | "subwave";
  apiVersion?: "v1" | "v3";
  url?: string;
  apiKey?: string;
  keyEnv?: string;
  username?: string;
  password?: string;
  userEnv?: string;
  passwordEnv?: string;
  credentialsRequired?: boolean;
};

const disabledApps = new Set(
  (process.env.DISABLED_APPS ?? "")
    .split(",")
    .map((value: string) => value.trim().toLowerCase())
    .filter(Boolean),
);

const appDefs: Array<
  Omit<AppConfig, "url" | "apiKey" | "keyEnv" | "username" | "password" | "userEnv" | "passwordEnv"> & {
    urlEnv: string;
    keyEnv?: string;
    userEnv?: string;
    passwordEnv?: string;
  }
> = [
  { name: "sonarr", label: "Sonarr", kind: "arr", apiVersion: "v3", urlEnv: "SONARR_URL", keyEnv: "SONARR_API_KEY" },
  { name: "radarr", label: "Radarr", kind: "arr", apiVersion: "v3", urlEnv: "RADARR_URL", keyEnv: "RADARR_API_KEY" },
  { name: "lidarr", label: "Lidarr", kind: "arr", apiVersion: "v1", urlEnv: "LIDARR_URL", keyEnv: "LIDARR_API_KEY" },
  { name: "prowlarr", label: "Prowlarr", kind: "arr", apiVersion: "v1", urlEnv: "PROWLARR_URL", keyEnv: "PROWLARR_API_KEY" },
  { name: "sabnzbd", label: "SABnzbd", kind: "sabnzbd", urlEnv: "SABNZBD_URL", keyEnv: "SABNZBD_API_KEY" },
  { name: "jellyfin", label: "Jellyfin", kind: "jellyfin", urlEnv: "JELLYFIN_URL", keyEnv: "JELLYFIN_API_KEY" },
  { name: "beets-flask", label: "beets-flask", kind: "beets-flask", urlEnv: "BEETS_FLASK_URL" },
  { name: "slskd", label: "slskd", kind: "slskd", urlEnv: "SLSKD_URL", keyEnv: "SLSKD_API_KEY" },
  {
    name: "navidrome",
    label: "Navidrome",
    kind: "navidrome",
    urlEnv: "NAVIDROME_URL",
    userEnv: "NAVIDROME_USER",
    passwordEnv: "NAVIDROME_PASS",
    credentialsRequired: true,
  },
  {
    name: "subwave",
    label: "Subwave",
    kind: "subwave",
    urlEnv: "SUBWAVE_URL",
    userEnv: "SUBWAVE_ADMIN_USER",
    passwordEnv: "SUBWAVE_ADMIN_PASS",
  },
];

export const apps: AppConfig[] = appDefs
  .filter((app) => !disabledApps.has(app.name))
  .map(({ urlEnv, keyEnv, userEnv, passwordEnv, ...app }) => ({
    ...app,
    keyEnv,
    userEnv,
    passwordEnv,
    url: process.env[urlEnv],
    apiKey: keyEnv ? process.env[keyEnv] : undefined,
    username: userEnv ? process.env[userEnv] : undefined,
    password: passwordEnv ? process.env[passwordEnv] : undefined,
  }));

function missingConfig(app: AppConfig) {
  return [
    !app.url ? `${app.name.toUpperCase().replaceAll("-", "_")}_URL` : undefined,
    app.keyEnv && !app.apiKey ? app.keyEnv : undefined,
    app.credentialsRequired && app.userEnv && !app.username ? app.userEnv : undefined,
    app.credentialsRequired && app.passwordEnv && !app.password ? app.passwordEnv : undefined,
  ].filter(Boolean);
}

export function getApp(name: AppName): AppConfig {
  const app = apps.find((candidate) => candidate.name === name);
  if (!app) {
    throw new Error(`App is disabled or unknown: ${name}`);
  }
  const missing = missingConfig(app);
  if (missing.length > 0) {
    throw new Error(`${app.label} is missing ${missing.join(" or ")}`);
  }
  return app;
}

export function configuredApps() {
  return apps.map((app) => ({
    name: app.name,
    label: app.label,
    kind: app.kind,
    configured: missingConfig(app).length === 0,
    missing: missingConfig(app),
    optionalMissing: [
      !app.credentialsRequired && app.userEnv && !app.username ? app.userEnv : undefined,
      !app.credentialsRequired && app.passwordEnv && !app.password ? app.passwordEnv : undefined,
    ].filter(Boolean),
  }));
}
