import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { configuredApps } from "./config.js";
import {
  beetsFlaskStatus,
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
  navidromeScanStatus,
  navidromeSearch,
  navidromeStatus,
  prowlarrSearch,
  previewMovieRequest,
  previewSeriesRequest,
  radarrRequestOptions,
  recentActivity,
  requestFollowStatus,
  requestMovie,
  requestSeries,
  requestSeriesSeason,
  searchMovie,
  searchSeries,
  setMovieMonitoring,
  setSeriesSeasonMonitoring,
  serviceHealth,
  serviceStatus,
  sonarrRequestOptions,
  slskdStatus,
  subwaveNowPlaying,
  subwaveRecentTracks,
  subwaveSearchTracks,
  subwaveStateSummary,
  subwaveStatus,
  subwaveStreams,
  subwaveUpdateWeeklySchedule,
  subwaveUpsertShow,
  systemStatus,
  wantedMissingNormalized,
} from "./media.js";
import { errorText, jsonText } from "./http.js";
import { MUSIC_AUDIT_ISSUE_TYPES, musicAudit } from "./music-audit.js";
import { serverVersion } from "./version.js";

const appName = z.enum(["sonarr", "radarr", "lidarr", "prowlarr", "sabnzbd", "jellyfin", "beets-flask", "slskd", "navidrome", "subwave"]);
const statusApp = appName;
const libraryApp = z.enum(["sonarr", "radarr", "lidarr"]);
const queueApp = z.enum(["sonarr", "radarr", "lidarr", "sabnzbd"]);
const stackFlow = z.enum(["tv", "movies", "music"]);
const movieRequestInput = {
  tmdbId: z.number().int().positive(),
  qualityProfileId: z.number().int().positive(),
  rootFolderPath: z.string().min(1),
  monitored: z.boolean().default(true),
  searchNow: z.boolean().default(true),
  tagIds: z.array(z.number().int().positive()).default([]),
};
const movieMonitoringInput = {
  tmdbId: z.number().int().positive(),
  monitored: z.boolean().default(true),
  searchNow: z.boolean().default(false),
};
const seriesRequestInput = {
  tvdbId: z.number().int().positive(),
  qualityProfileId: z.number().int().positive(),
  rootFolderPath: z.string().min(1),
  monitorMode: z.enum(["all", "future", "missing", "existing", "firstSeason", "latestSeason", "none"]).default("all"),
  seasonFolder: z.boolean().default(true),
  searchNow: z.boolean().default(true),
  tagIds: z.array(z.number().int().positive()).default([]),
};
const seriesSeasonMonitoringInput = {
  tvdbId: z.number().int().positive(),
  seasonNumber: z.number().int().min(0),
  monitored: z.boolean().default(true),
  searchNow: z.boolean().default(false),
};
const seriesSeasonRequestInput = {
  ...seriesRequestInput,
  seasonNumber: z.number().int().min(0),
  monitored: z.boolean().default(true),
};
const requestFollowInput = {
  service: z.enum(["sonarr", "radarr"]),
  title: z.string().optional(),
  tmdbId: z.number().int().positive().optional(),
  tvdbId: z.number().int().positive().optional(),
  year: z.number().int().positive().optional(),
  expectedEpisodeCount: z.number().int().positive().optional(),
  monitorMode: z.string().optional(),
  requestedAt: z.string().optional(),
  polls: z.number().int().min(0).default(0),
  pageSize: z.number().int().min(1).max(200).default(100),
};
const subwaveShowInput = {
  show: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }).passthrough(),
};
const subwaveScheduleInput = {
  schedule: z.any(),
};
const musicAuditIssueType = z.enum(MUSIC_AUDIT_ISSUE_TYPES);

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
    version: serverVersion,
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
        "Return queue/import warnings and unresolved failed recent history items across media services.",
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
    "radarr_request_options",
    {
      title: "Radarr Request Options",
      description: "Return Radarr quality profiles, root folders, tags, and a neutral movie request draft payload.",
    },
    tool(() => radarrRequestOptions()),
  );

  server.registerTool(
    "search_movie",
    {
      title: "Search Movie",
      description: "Search Radarr movie candidates and return selectable options plus a request draft payload.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(25).default(10),
      },
    },
    tool(({ query, limit }) => searchMovie(query, limit)),
  );

  server.registerTool(
    "preview_movie_request",
    {
      title: "Preview Movie Request",
      description: "Validate a Radarr movie request and return a form-friendly preview without writing.",
      inputSchema: movieRequestInput,
    },
    tool((args) => previewMovieRequest(args)),
  );

  server.registerTool(
    "request_movie",
    {
      title: "Request Movie",
      description: "Add an exact selected movie to Radarr. Requires ALLOW_REQUESTS=true.",
      inputSchema: movieRequestInput,
    },
    tool((args) => requestMovie(args)),
  );

  server.registerTool(
    "set_movie_monitoring",
    {
      title: "Set Movie Monitoring",
      description: "Update monitoring for an existing Radarr movie and optionally start a movie search. Requires ALLOW_REQUESTS=true.",
      inputSchema: movieMonitoringInput,
    },
    tool((args) => setMovieMonitoring(args)),
  );

  server.registerTool(
    "sonarr_request_options",
    {
      title: "Sonarr Request Options",
      description: "Return Sonarr quality profiles, root folders, tags, and a neutral series request draft payload.",
    },
    tool(() => sonarrRequestOptions()),
  );

  server.registerTool(
    "search_series",
    {
      title: "Search Series",
      description: "Search Sonarr series candidates and return selectable options plus a request draft payload.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(25).default(10),
      },
    },
    tool(({ query, limit }) => searchSeries(query, limit)),
  );

  server.registerTool(
    "preview_series_request",
    {
      title: "Preview Series Request",
      description: "Validate a Sonarr series request and return a form-friendly preview without writing.",
      inputSchema: seriesRequestInput,
    },
    tool((args) => previewSeriesRequest(args)),
  );

  server.registerTool(
    "request_series",
    {
      title: "Request Series",
      description: "Add an exact selected series to Sonarr. Requires ALLOW_REQUESTS=true.",
      inputSchema: seriesRequestInput,
    },
    tool((args) => requestSeries(args)),
  );

  server.registerTool(
    "set_series_season_monitoring",
    {
      title: "Set Series Season Monitoring",
      description: "Update monitoring for exactly one existing Sonarr season and optionally start a season search. Requires ALLOW_REQUESTS=true.",
      inputSchema: seriesSeasonMonitoringInput,
    },
    tool((args) => setSeriesSeasonMonitoring(args)),
  );

  server.registerTool(
    "request_series_season",
    {
      title: "Request Series Season",
      description: "Add or update a Sonarr series for one specific season only, then optionally start a season search. Requires ALLOW_REQUESTS=true.",
      inputSchema: seriesSeasonRequestInput,
    },
    tool((args) => requestSeriesSeason(args)),
  );

  server.registerTool(
    "request_follow_status",
    {
      title: "Request Follow Status",
      description: "Return normalized request lifecycle status from queue/history for a Radarr movie or Sonarr series.",
      inputSchema: requestFollowInput,
    },
    tool((args) => requestFollowStatus(args)),
  );

  server.registerTool(
    "beets_flask_status",
    {
      title: "beets-flask Status",
      description: "Return read-only beets-flask music import pipeline status, queue/workers, inbox, and library stats.",
    },
    tool(() => beetsFlaskStatus()),
  );

  server.registerTool(
    "slskd_status",
    {
      title: "slskd Status",
      description: "Return read-only slskd Soulseek connection, transfer, and share status.",
    },
    tool(() => slskdStatus()),
  );

  server.registerTool(
    "navidrome_status",
    {
      title: "Navidrome Status",
      description: "Return read-only Navidrome Subsonic reachability, scan, and accessible music folder status.",
    },
    tool(() => navidromeStatus()),
  );

  server.registerTool(
    "navidrome_search",
    {
      title: "Navidrome Search",
      description: "Search Navidrome through the Subsonic search3 API for artists, albums, and songs.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(25).default(12),
      },
    },
    tool(({ query, limit }) => navidromeSearch(query, limit)),
  );

  server.registerTool(
    "navidrome_scan_status",
    {
      title: "Navidrome Scan Status",
      description: "Return Navidrome Subsonic scan state, last scan time, and folder/item counts.",
    },
    tool(() => navidromeScanStatus()),
  );

  server.registerTool(
    "subwave_status",
    {
      title: "Subwave Status",
      description: "Return read-only Subwave station health, now-playing, queue, and admin-read availability.",
    },
    tool(() => subwaveStatus()),
  );

  server.registerTool(
    "subwave_now_playing",
    {
      title: "Subwave Now Playing",
      description: "Return current Subwave track, station context, DJ persona, listener count, and stream descriptor.",
    },
    tool(() => subwaveNowPlaying()),
  );

  server.registerTool(
    "subwave_state",
    {
      title: "Subwave State",
      description: "Return Subwave current queue, recent history, DJ log, and station state.",
      inputSchema: {
        pageSize: z.number().int().min(1).max(100).default(20),
      },
    },
    tool(({ pageSize }) => subwaveStateSummary(pageSize)),
  );

  server.registerTool(
    "subwave_streams",
    {
      title: "Subwave Streams",
      description: "Return Subwave stream descriptor and PLS/M3U tune-in files.",
    },
    tool(() => subwaveStreams()),
  );

  server.registerTool(
    "subwave_search",
    {
      title: "Subwave Search",
      description: "Search Subwave's admin library endpoint for queue-ready tracks. Requires Subwave admin credentials.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(25).default(12),
      },
    },
    tool(({ query, limit }) => subwaveSearchTracks(query, limit)),
  );

  server.registerTool(
    "subwave_recent",
    {
      title: "Subwave Recent Tracks",
      description: "Return recently added Subwave tracks and playlist summary. Requires Subwave admin credentials.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    tool(({ limit }) => subwaveRecentTracks(limit)),
  );

  server.registerTool(
    "subwave_upsert_show",
    {
      title: "Subwave Upsert Show",
      description: "Upsert one Subwave show through POST /api/shows using admin credentials. Requires ALLOW_REQUESTS=true.",
      inputSchema: subwaveShowInput,
    },
    tool(({ show }) => subwaveUpsertShow(show)),
  );

  server.registerTool(
    "subwave_update_schedule",
    {
      title: "Subwave Update Schedule",
      description: "Replace the Subwave weekly schedule through PUT /api/schedule after validating a 7 day x 24 hour grid. Requires ALLOW_REQUESTS=true.",
      inputSchema: subwaveScheduleInput,
    },
    tool(({ schedule }) => subwaveUpdateWeeklySchedule(schedule)),
  );

  server.registerTool(
    "music_audit_capabilities",
    {
      title: "Music Audit Capabilities",
      description: "Report read-only music audit configuration and safety readiness without enumerating the library.",
    },
    tool(() => musicAudit.capabilities()),
  );

  server.registerTool(
    "music_audit_start",
    {
      title: "Start Music Audit",
      description: "Start one read-only metadata and artwork audit against the fixed configured music root.",
    },
    tool(() => musicAudit.start()),
  );

  server.registerTool(
    "music_audit_status",
    {
      title: "Music Audit Status",
      description: "Return process-wide music audit scan state and the latest completed scan reference.",
    },
    tool(() => musicAudit.status()),
  );

  server.registerTool(
    "music_audit_summary",
    {
      title: "Music Audit Summary",
      description: "Return a compact summary of the latest completed music audit snapshot.",
    },
    tool(() => musicAudit.summary()),
  );

  server.registerTool(
    "music_audit_issues",
    {
      title: "Music Audit Issues",
      description: "Return bounded, filterable findings from the latest completed music audit snapshot.",
      inputSchema: {
        type: musicAuditIssueType.optional(),
        severity: z.enum(["issue", "candidate"]).optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    tool((args) => musicAudit.issues(args)),
  );

  server.registerTool(
    "music_album_audit_detail",
    {
      title: "Music Album Audit Detail",
      description: "Return tracks, artwork, and findings for one opaque scanner-generated album ID.",
      inputSchema: {
        albumId: z.string().regex(/^alb_[a-f0-9]{24}$/),
      },
    },
    tool(({ albumId }) => musicAudit.albumDetail(albumId)),
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
