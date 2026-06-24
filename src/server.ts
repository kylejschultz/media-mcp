import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { configuredApps } from "./config.js";
import {
  calendar,
  diskSpace,
  downloadQueue,
  importIssues,
  indexerStatus,
  jellyfinActiveSessions,
  jellyfinInfo,
  jellyfinLibraryCounts,
  jellyfinRecentActivity,
  jellyfinScheduledTasks,
  libraryCounts,
  mediaStackOverview,
  mediaStackFlow,
  mediaStackModel,
  missingSummary,
  prowlarrSearch,
  recentActivity,
  serviceHealth,
  serviceStatus,
  systemStatus,
  wantedMissingNormalized,
} from "./media.js";
import { errorText, jsonText } from "./http.js";

const appName = z.enum(["sonarr", "radarr", "lidarr", "prowlarr", "sabnzbd", "jellyfin"]);
const statusApp = appName;
const libraryApp = z.enum(["sonarr", "radarr", "lidarr"]);
const queueApp = z.enum(["sonarr", "radarr", "lidarr", "sabnzbd"]);
const stackFlow = z.enum(["tv", "movies", "music"]);

type ToolHandler = (args: any) => Promise<unknown> | unknown;

function tool(handler: ToolHandler) {
  return async (args: any) => {
    try {
      return jsonText(await handler(args ?? {}));
    } catch (error) {
      return errorText(error);
    }
  };
}

export function createMediaMcpServer() {
  const server = new McpServer({
    name: "media-mcp",
    version: "0.1.8",
  });

  server.registerTool(
    "media_stack_overview",
    {
      title: "Media Stack Overview",
      description:
        "Return a compact dashboard of service status, health, queues, missing media, disk space, indexers, library counts, and import issues.",
    },
    tool(() => mediaStackOverview()),
  );

  server.registerTool(
    "media_stack_model",
    {
      title: "Media Stack Model",
      description: "Return the generated stack model derived from the Media Stack Overview Notion page.",
    },
    tool(() => mediaStackModel()),
  );

  server.registerTool(
    "media_stack_flow",
    {
      title: "Media Stack Flow",
      description: "Return generated file-flow knowledge for TV, movies, music, or all media types.",
      inputSchema: {
        mediaType: stackFlow.optional(),
      },
    },
    tool(({ mediaType }) => mediaStackFlow(mediaType)),
  );

  server.registerTool(
    "service_status",
    {
      title: "Service Status",
      description:
        "Check reachability, auth, version, and warning summary for one service or all configured services.",
      inputSchema: {
        service: statusApp.optional(),
      },
    },
    tool(({ service }) => serviceStatus(service)),
  );

  server.registerTool(
    "service_health",
    {
      title: "Service Health",
      description: "Return health issues from configured media services.",
      inputSchema: {
        service: statusApp.optional(),
      },
    },
    tool(({ service }) => serviceHealth(service)),
  );

  server.registerTool(
    "disk_space",
    {
      title: "Disk Space",
      description: "Return service-visible disk space from media library Arr applications; Prowlarr is skipped.",
    },
    tool(() => diskSpace()),
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
    tool(({ service, pageSize }) => downloadQueue(service, pageSize)),
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
    tool(({ service, pageSize }) => recentActivity(service, pageSize)),
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
    tool(({ pageSize }) => missingSummary(pageSize)),
  );

  server.registerTool(
    "indexer_status",
    {
      title: "Indexer Status",
      description:
        "Return Prowlarr indexer configuration, failure status, and health issues without credentials.",
    },
    tool(() => indexerStatus()),
  );

  server.registerTool(
    "get_library_counts",
    {
      title: "Library Counts",
      description:
        "Return Sonarr series, Radarr movie, Lidarr artist, and Lidarr album counts.",
    },
    tool(() => libraryCounts()),
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
    tool(({ pageSize }) => importIssues(pageSize)),
  );

  server.registerTool(
    "media_configured_apps",
    {
      title: "Configured Media Apps",
      description:
        "List media apps and whether their URL/API key env vars are present.",
    },
    tool(() => configuredApps()),
  );

  server.registerTool(
    "media_system_status",
    {
      title: "Media System Status",
      description:
        "Fetch version/status information from one configured app or all configured apps.",
      inputSchema: {
        app: statusApp.optional(),
      },
    },
    tool(({ app }) => systemStatus(app)),
  );

  server.registerTool(
    "media_queue",
    {
      title: "Media Queue",
      description: "Show normalized queue for Sonarr, Radarr, Lidarr, or SABnzbd.",
      inputSchema: {
        app: queueApp,
        pageSize: z.number().int().min(1).max(100).default(20),
      },
    },
    tool(({ app, pageSize }) => downloadQueue(app, pageSize)),
  );

  server.registerTool(
    "media_history",
    {
      title: "Media History",
      description: "Show normalized recent history/activity for one configured app.",
      inputSchema: {
        app: appName,
        pageSize: z.number().int().min(1).max(100).default(20),
      },
    },
    tool(({ app, pageSize }) => recentActivity(app, pageSize)),
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
    tool(({ app, start, end }) => calendar(app, start, end)),
  );

  server.registerTool(
    "media_wanted_missing",
    {
      title: "Wanted Missing Media",
      description: "List normalized missing wanted media from Sonarr, Radarr, or Lidarr.",
      inputSchema: {
        app: libraryApp,
        pageSize: z.number().int().min(1).max(100).default(20),
      },
    },
    tool(({ app, pageSize }) => wantedMissingNormalized(app, pageSize)),
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
    tool(({ query, type, limit }) => prowlarrSearch(query, type, limit)),
  );

  server.registerTool(
    "jellyfin_system_info",
    {
      title: "Jellyfin System Info",
      description: "Return Jellyfin server version and basic system information.",
    },
    tool(() => jellyfinInfo()),
  );

  server.registerTool(
    "jellyfin_library_counts",
    {
      title: "Jellyfin Library Counts",
      description: "Return read-only Jellyfin item counts for major library types.",
    },
    tool(() => jellyfinLibraryCounts()),
  );

  server.registerTool(
    "jellyfin_active_sessions",
    {
      title: "Jellyfin Active Sessions",
      description: "Return active Jellyfin sessions with user/client/playback summary.",
    },
    tool(() => jellyfinActiveSessions()),
  );

  server.registerTool(
    "jellyfin_recent_activity",
    {
      title: "Jellyfin Recent Activity",
      description: "Return recent Jellyfin activity log entries.",
      inputSchema: {
        pageSize: z.number().int().min(1).max(100).default(20),
      },
    },
    tool(({ pageSize }) => jellyfinRecentActivity(pageSize)),
  );

  server.registerTool(
    "jellyfin_scheduled_tasks",
    {
      title: "Jellyfin Scheduled Tasks",
      description: "Return Jellyfin scheduled task state and last execution summaries.",
    },
    tool(() => jellyfinScheduledTasks()),
  );

  return server;
}
