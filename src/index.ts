#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { configuredApps } from "./config.js";
import { calendar, history, prowlarrSearch, queue, systemStatus, wantedMissing } from "./media.js";
import { errorText, jsonText } from "./http.js";

const appName = z.enum(["sonarr", "radarr", "lidarr", "prowlarr", "sabnzbd"]);
const libraryApp = z.enum(["sonarr", "radarr", "lidarr"]);
const queueApp = z.enum(["sonarr", "radarr", "lidarr", "sabnzbd"]);

const server = new McpServer({
  name: "media-mcp",
  version: "0.1.0",
});

server.registerTool(
  "media_configured_apps",
  {
    title: "Configured Media Apps",
    description: "List media apps and whether their URL/API key env vars are present.",
  },
  async () => jsonText(configuredApps()),
);

server.registerTool(
  "media_system_status",
  {
    title: "Media System Status",
    description: "Fetch version/status information from one configured app or all configured apps.",
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
      start: z.string().describe("Inclusive ISO date, for example 2026-06-21"),
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

await server.connect(new StdioServerTransport());
