import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { configuredApps } from "./config.js";
import {
  calendar,
  diskSpace,
  downloadQueue,
  history,
  importIssues,
  indexerStatus,
  libraryCounts,
  mediaStackOverview,
  missingSummary,
  prowlarrSearch,
  queue,
  recentActivity,
  serviceHealth,
  serviceStatus,
  systemStatus,
  wantedMissing,
} from "./media.js";
import { errorText, jsonText } from "./http.js";

const appName = z.enum(["sonarr", "radarr", "lidarr", "prowlarr", "sabnzbd"]);
const libraryApp = z.enum(["sonarr", "radarr", "lidarr"]);
const queueApp = z.enum(["sonarr", "radarr", "lidarr", "sabnzbd"]);

export function createMediaMcpServer() {
  const server = new McpServer({
    name: "media-mcp",
    version: "0.1.5",
  });

  server.registerTool(
    "media_stack_overview",
    {
      title: "Media Stack Overview",
      description:
        "Return a compact dashboard of service status, health, queues, missing media, disk space, indexers, library counts, and import issues.",
    },
    async () => {
      try {
        return jsonText(await mediaStackOverview());
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "service_status",
    {
      title: "Service Status",
      description:
        "Check reachability, auth, version, and warning summary for one service or all configured services.",
      inputSchema: {
        service: appName.optional(),
      },
    },
    async ({ service }) => {
      try {
        return jsonText(await serviceStatus(service));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "service_health",
    {
      title: "Service Health",
      description: "Return health issues from configured media services.",
      inputSchema: {
        service: appName.optional(),
      },
    },
    async ({ service }) => {
      try {
        return jsonText(await serviceHealth(service));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "disk_space",
    {
      title: "Disk Space",
      description: "Return service-visible disk space from Arr applications.",
    },
    async () => {
      try {
        return jsonText(await diskSpace());
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "download_queue",
    {
      title: "Download Queue",
      description:
        "Return normalized queue items across Sonarr, Radarr, Lidarr, and SABnzbd.",
      inputSchema: {
        service: queueApp.optional(),
        pageSize: z.number().int().min(1).max(100).default(50),
      },
    },
    async ({ service, pageSize }) => {
      try {
        return jsonText(await downloadQueue(service, pageSize));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "recent_activity",
    {
      title: "Recent Activity",
      description:
        "Return normalized recent activity/history across configured services.",
      inputSchema: {
        service: appName.optional(),
        pageSize: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ service, pageSize }) => {
      try {
        return jsonText(await recentActivity(service, pageSize));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "get_missing_summary",
    {
      title: "Missing Summary",
      description:
        "Return missing wanted counts and samples for Sonarr, Radarr, and Lidarr.",
      inputSchema: {
        pageSize: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ pageSize }) => {
      try {
        return jsonText(await missingSummary(pageSize));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "indexer_status",
    {
      title: "Indexer Status",
      description:
        "Return Prowlarr indexer configuration, failure status, and health issues without credentials.",
    },
    async () => {
      try {
        return jsonText(await indexerStatus());
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "get_library_counts",
    {
      title: "Library Counts",
      description:
        "Return Sonarr series, Radarr movie, Lidarr artist, and Lidarr album counts.",
    },
    async () => {
      try {
        return jsonText(await libraryCounts());
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "get_import_issues",
    {
      title: "Import Issues",
      description:
        "Return queue/import warnings and failed recent history items across media services.",
      inputSchema: {
        pageSize: z.number().int().min(1).max(100).default(50),
      },
    },
    async ({ pageSize }) => {
      try {
        return jsonText(await importIssues(pageSize));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "media_configured_apps",
    {
      title: "Configured Media Apps",
      description:
        "List media apps and whether their URL/API key env vars are present.",
    },
    async () => jsonText(configuredApps()),
  );

  server.registerTool(
    "media_system_status",
    {
      title: "Media System Status",
      description:
        "Fetch version/status information from one configured app or all configured apps.",
      inputSchema: {
        app: appName.optional(),
      },
    },
    async ({ app }) => {
      try {
        return jsonText(await systemStatus(app));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "media_queue",
    {
      title: "Media Queue",
      description: "Show current queue for Sonarr, Radarr, Lidarr, or SABnzbd.",
      inputSchema: {
        app: queueApp,
        pageSize: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ app, pageSize }) => {
      try {
        return jsonText(await queue(app, pageSize));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "media_history",
    {
      title: "Media History",
      description: "Show recent history for an Arr app or SABnzbd.",
      inputSchema: {
        app: appName,
        pageSize: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ app, pageSize }) => {
      try {
        return jsonText(await history(app, pageSize));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "media_calendar",
    {
      title: "Media Calendar",
      description: "Show releases from the Sonarr, Radarr, or Lidarr calendar.",
      inputSchema: {
        app: libraryApp,
        start: z
          .string()
          .describe("Inclusive ISO date, for example 2026-06-21"),
        end: z.string().describe("Exclusive ISO date, for example 2026-06-28"),
      },
    },
    async ({ app, start, end }) => {
      try {
        return jsonText(await calendar(app, start, end));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "media_wanted_missing",
    {
      title: "Wanted Missing Media",
      description: "List missing wanted media from Sonarr, Radarr, or Lidarr.",
      inputSchema: {
        app: libraryApp,
        pageSize: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ app, pageSize }) => {
      try {
        return jsonText(await wantedMissing(app, pageSize));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "media_search",
    {
      title: "Prowlarr Search",
      description: "Search configured indexers through Prowlarr.",
      inputSchema: {
        query: z.string().min(1),
        type: z.string().default("search"),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    async ({ query, type, limit }) => {
      try {
        return jsonText(await prowlarrSearch(query, type, limit));
      } catch (error) {
        return errorText(error);
      }
    },
  );

  return server;
}
