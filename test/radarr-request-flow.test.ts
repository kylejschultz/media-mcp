import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.RADARR_URL = "http://radarr.test";
process.env.RADARR_API_KEY = "test-api-key";
process.env.SONARR_URL = "http://sonarr.test";
process.env.SONARR_API_KEY = "test-api-key";
process.env.LIDARR_URL = "http://lidarr.test";
process.env.LIDARR_API_KEY = "test-api-key";
process.env.PROWLARR_URL = "http://prowlarr.test";
process.env.PROWLARR_API_KEY = "test-api-key";
process.env.SABNZBD_URL = "http://sabnzbd.test";
process.env.SABNZBD_API_KEY = "test-api-key";
process.env.ALLOW_REQUESTS = "";

type FetchCall = {
  method: string;
  path: string;
  term?: string | null;
  body?: unknown;
};

const movie = {
  tmdbId: 123,
  title: "Test Movie",
  year: 2026,
  titleSlug: "test-movie-2026",
  overview: "A deterministic movie fixture.",
  runtime: 120,
  certification: "PG-13",
  genres: ["Action", "Adventure"],
  remotePoster: "https://image.test/poster.jpg",
};

const series = {
  tvdbId: 321,
  title: "Test Series",
  year: 2026,
  titleSlug: "test-series-2026",
  overview: "A deterministic series fixture.",
  status: "continuing",
  network: "Test Network",
  genres: ["Drama", "Sci-Fi"],
  remotePoster: "https://image.test/series.jpg",
  seasons: [
    { seasonNumber: 1, monitored: true, statistics: { episodeCount: 3 } },
    { seasonNumber: 2, monitored: false, statistics: { episodeCount: 2 } },
    { seasonNumber: 3, monitored: true, statistics: { episodeCount: 4 } },
  ],
};

const qualityProfiles = [
  { id: 1, name: "HD-1080p" },
  { id: 2, name: "UHD-2160p" },
];

const rootFolders = [
  { path: "/movies", freeSpace: 1_000_000_000 },
  { path: "/movies-4k", freeSpace: 2_000_000_000 },
];

const tags = [{ id: 7, label: "discord" }];
const fetchCalls: FetchCall[] = [];
let existingMovies: unknown[] = [];
let existingSeries: unknown[] = [];
let queueRecords: unknown[] = [];
let historyRecords: unknown[] = [];
let missingRecords: unknown[] = [];
const failedRequests = new Set<string>();

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchCalls.length = 0;
  existingMovies = [];
  existingSeries = [];
  queueRecords = [];
  historyRecords = [];
  missingRecords = [];
  failedRequests.clear();
  process.env.ALLOW_REQUESTS = "";
});

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const call: FetchCall = {
    method,
    path: url.pathname,
    term: url.searchParams.get("term"),
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
  fetchCalls.push(call);
  const sabMode = url.searchParams.get("mode");
  const requestKeys = [
    `${url.host}${url.pathname}`,
    `${url.host}${url.pathname}:${sabMode ?? ""}`,
    url.pathname,
    `${url.pathname}:${sabMode ?? ""}`,
  ];
  if (requestKeys.some((key) => failedRequests.has(key))) {
    return jsonResponse({ error: `Injected failure for ${url.host}${url.pathname}` }, 500);
  }

  if (method === "POST" && url.pathname === "/api/v3/movie") {
    return jsonResponse({ id: 999, ...call.body });
  }
  if (method === "POST" && url.pathname === "/api/v3/series") {
    return jsonResponse({ id: 888, ...call.body });
  }
  if (method === "PUT" && url.pathname.match(/^\/api\/v3\/movie\/\d+$/)) {
    return jsonResponse(call.body);
  }
  if (method === "PUT" && url.pathname.match(/^\/api\/v3\/series\/\d+$/)) {
    return jsonResponse(call.body);
  }
  if (method === "POST" && url.pathname === "/api/v3/command") {
    return jsonResponse({ id: 777, ...(call.body as Record<string, unknown>) });
  }

  if (url.pathname === "/api") {
    switch (sabMode) {
      case "version":
        return jsonResponse({ version: "4.2.0" });
      case "queue":
        return jsonResponse({
          queue: {
            noofslots: "1",
            speed: "1 MB/s",
            mbleft: "500",
            slots: queueRecords.length > 0
              ? [{ filename: "Sab Queue Item", status: "Downloading", percentage: "25", timeleft: "00:10:00" }]
              : [],
          },
        });
      case "history":
        return jsonResponse({
          history: {
            slots: historyRecords.filter((record: any) => record.service === "sabnzbd"),
          },
        });
      default:
        return jsonResponse({ error: `Unhandled SAB mode: ${sabMode}` }, 404);
    }
  }

  switch (url.pathname) {
    case "/api/v1/system/status":
      return jsonResponse({ version: "1.2.3", branch: "main" });
    case "/api/v3/movie/lookup":
      return jsonResponse(url.searchParams.get("term") === "tmdb:123" ? [movie] : [movie, { ...movie, tmdbId: 456, title: "Other Movie" }]);
    case "/api/v3/series/lookup":
      return jsonResponse(url.searchParams.get("term") === "tvdb:321" ? [series] : [series, { ...series, tvdbId: 654, title: "Other Series" }]);
    case "/api/v3/system/status":
      return jsonResponse({ version: "1.2.3", branch: "main" });
    case "/api/v1/health":
    case "/api/v3/health":
      return jsonResponse([]);
    case "/api/v3/qualityprofile":
      return jsonResponse(qualityProfiles);
    case "/api/v3/rootfolder":
      return jsonResponse(rootFolders);
    case "/api/v3/tag":
      return jsonResponse(tags);
    case "/api/v3/movie":
      return jsonResponse(existingMovies);
    case "/api/v3/series":
      return jsonResponse(existingSeries);
    case "/api/v1/qualityprofile":
      return jsonResponse(qualityProfiles);
    case "/api/v1/rootfolder":
      return jsonResponse(rootFolders);
    case "/api/v1/tag":
      return jsonResponse(tags);
    case "/api/v1/artist":
      return jsonResponse([{ id: 1, artistName: "Test Artist" }]);
    case "/api/v1/album":
      return jsonResponse([{ id: 1, title: "Test Album" }]);
    case "/api/v1/indexer":
      return jsonResponse([{ id: 1, name: "Test Indexer", enable: true, protocol: "torrent", priority: 25, tags: [] }]);
    case "/api/v1/indexerstatus":
      return jsonResponse([]);
    case "/api/v1/diskspace":
    case "/api/v3/diskspace":
      return jsonResponse([{ path: "/media", label: "Media", freeSpace: 500_000_000, totalSpace: 1_000_000_000 }]);
    case "/api/v1/wanted/missing":
    case "/api/v3/wanted/missing":
      return jsonResponse({ totalRecords: missingRecords.length, records: missingRecords });
    case "/api/v1/queue":
    case "/api/v3/queue":
      return jsonResponse({ totalRecords: queueRecords.length, records: queueRecords });
    case "/api/v1/history":
    case "/api/v3/history":
      return jsonResponse({ totalRecords: historyRecords.length, records: historyRecords });
    default:
      return jsonResponse({ error: `Unhandled test URL: ${url}` }, 404);
  }
};

const media = await import("../src/media.js");
const { createMediaMcpServer } = await import("../src/server.js");

async function withMcpClient<T>(fn: (client: Client) => Promise<T>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMediaMcpServer();
  const client = new Client({
    name: "media-mcp-contract-test",
    version: "0.1.0",
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((entry) => entry.type === "text")?.text;
  assert.equal(result.isError, undefined, text);
  assert.ok(text, `expected text content from ${name}`);
  const parsed = JSON.parse(text);
  assertServerNeutralContract(parsed, name);
  return parsed;
}

async function callToolError(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
  assert.equal(result.isError, true, `expected ${name} to return MCP tool error`);
  return text;
}

function fieldById(result: any, id: string) {
  const field = result.requestDraft.formFields.find((candidate: any) => candidate.id === id);
  assert.ok(field, `expected form field ${id}`);
  return field;
}

const platformSpecificKeys = new Set([
  "callbackData",
  "callbackDataKind",
  "channelData",
  "components",
  "messageId",
  "modal",
]);

function assertServerNeutralContract(value: unknown, path = "result") {
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      assert.equal(value.startsWith("media-panel:"), false, `${path} must not contain panel callback state`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertServerNeutralContract(entry, `${path}[${index}]`));
    return;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    assert.equal(platformSpecificKeys.has(key), false, `${path}.${key} is client/platform-specific`);
    assertServerNeutralContract(entry, `${path}.${key}`);
  }
}

function assertSummaryEnvelope(result: any, title: string) {
  assert.equal(typeof result.summary, "string", `${title} summary`);
  assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T/, `${title} checkedAt`);
  assert.ok(Array.isArray(result.warnings), `${title} warnings`);
  assert.ok(Array.isArray(result.errors), `${title} errors`);
  assert.equal(result.view.schema, "media-mcp.view.v1", `${title} view schema`);
  assert.equal(typeof result.view.title, "string", `${title} view title`);
  assert.equal(typeof result.view.summary, "string", `${title} view summary`);
  assert.ok(Array.isArray(result.view.cards), `${title} view cards`);
  assertServerNeutralContract(result, title);
}

describe("Radarr request draft contract", () => {
  it("returns generic formFields for movie search options", async () => {
    const result = await media.searchMovie("test movie", 10) as any;

    assertServerNeutralContract(result);
    assert.equal(result.requestDraft.schema, "media-mcp.requestDraft.v1");
    assert.equal(result.requestDraft.kind, "movie");
    assert.equal(result.requestDraft.service, "radarr");
    assert.equal(result.requestDraft.writeGate.env, "ALLOW_REQUESTS");
    assert.equal(result.requestDraft.writeGate.enabled, false);
    assert.equal("components" in result, false);

    const quality = fieldById(result, "qualityProfileId");
    assert.equal(quality.type, "select");
    assert.equal(quality.required, true);
    assert.equal(quality.value, 1);
    assert.deepEqual(quality.options.map((option: any) => option.value), ["1", "2"]);

    const root = fieldById(result, "rootFolderPath");
    assert.equal(root.type, "select");
    assert.equal(root.required, true);
    assert.equal(root.value, "/movies");
    assert.deepEqual(root.options.map((option: any) => option.value), ["/movies", "/movies-4k"]);

    assert.equal(fieldById(result, "monitored").type, "checkbox");
    assert.equal(fieldById(result, "monitored").value, true);
    assert.equal(fieldById(result, "searchNow").type, "checkbox");
    assert.equal(fieldById(result, "searchNow").value, true);
  });

  it("preserves selected options when preview booleans change", async () => {
    const result = await media.previewMovieRequest({
      tmdbId: 123,
      qualityProfileId: 2,
      rootFolderPath: "/movies-4k",
      monitored: false,
      searchNow: false,
      tagIds: [7],
    }) as any;

    assertServerNeutralContract(result);
    assert.equal(result.requestDraft.selectedCandidate.tmdbId, 123);
    assert.equal(result.requestDraft.defaults.qualityProfileId, 2);
    assert.equal(result.requestDraft.defaults.rootFolderPath, "/movies-4k");
    assert.equal(result.requestDraft.defaults.monitored, false);
    assert.equal(result.requestDraft.defaults.searchNow, false);
    assert.deepEqual(result.requestDraft.defaults.tagIds, [7]);
    assert.equal(fieldById(result, "qualityProfileId").value, 2);
    assert.equal(fieldById(result, "rootFolderPath").value, "/movies-4k");
    assert.equal(fieldById(result, "monitored").value, false);
    assert.equal(fieldById(result, "searchNow").value, false);
    assert.equal(result.payloadPreview.monitored, false);
    assert.equal(result.payloadPreview.addOptions.searchForMovie, false);
    assert.equal("components" in result, false);
  });

  it("keeps submit disabled while request tools are disabled", async () => {
    const result = await media.previewMovieRequest({
      tmdbId: 123,
      qualityProfileId: 1,
      rootFolderPath: "/movies",
      monitored: true,
      searchNow: true,
    }) as any;

    assertServerNeutralContract(result);
    const action = result.view.cards[0].actions[0];
    assert.equal(action.id, "request-movie");
    assert.equal(action.disabled, true);
    assert.equal(result.requestDraft.writeGate.enabled, false);
    assert.match(result.summary, /Preview ready/);
    assert.ok(result.view.state.warnings.includes("Request tools are disabled"));
  });

  it("refuses request writes before posting when ALLOW_REQUESTS is false", async () => {
    await assert.rejects(
      media.requestMovie({
        tmdbId: 123,
        qualityProfileId: 1,
        rootFolderPath: "/movies",
        monitored: true,
        searchNow: true,
      }),
      /Request tools are disabled/,
    );

    assert.equal(fetchCalls.some((call) => call.method === "POST"), false);
  });
});

describe("MCP-only request workflows", () => {
  it("runs movie search, preview, blocked write, allowed write, and follow status through MCP tools", async () => {
    await withMcpClient(async (client) => {
      const search = await callToolJson(client, "search_movie", { query: "test movie", limit: 10 });
      assert.equal(search.requestDraft.schema, "media-mcp.requestDraft.v1");
      assert.equal(search.requestDraft.kind, "movie");
      assert.equal(search.candidates[0].tmdbId, 123);
      assert.equal("components" in search, false);

      const preview = await callToolJson(client, "preview_movie_request", {
        tmdbId: 123,
        qualityProfileId: 1,
        rootFolderPath: "/movies",
        monitored: true,
        searchNow: true,
      });
      assert.equal(preview.view.schema, "media-mcp.view.v1");
      assert.equal(preview.view.cards[0].actions[0].payload.tool, "request_movie");
      assert.equal(preview.requestDraft.writeGate.enabled, false);
      assert.equal("components" in preview, false);

      const blocked = await callToolError(client, "request_movie", {
        tmdbId: 123,
        qualityProfileId: 1,
        rootFolderPath: "/movies",
        monitored: true,
        searchNow: true,
      });
      assert.match(blocked, /Request tools are disabled/);
      assert.equal(fetchCalls.some((call) => call.method === "POST"), false);

      process.env.ALLOW_REQUESTS = "true";
      const requested = await callToolJson(client, "request_movie", {
        tmdbId: 123,
        qualityProfileId: 1,
        rootFolderPath: "/movies",
        monitored: true,
        searchNow: false,
      });
      assert.equal(requested.movie.tmdbId, 123);
      assert.equal(requested.view.state.kind, "success");
      assert.equal(fetchCalls.some((call) => call.method === "POST" && call.path === "/api/v3/movie"), true);

      historyRecords = [
        {
          sourceTitle: "Test Movie.2026.1080p.WEB-DL",
          eventType: "downloadFolderImported",
          date: "2026-06-29T07:00:00Z",
        },
      ];
      const follow = await callToolJson(client, "request_follow_status", {
        service: "radarr",
        title: "Test Movie",
        tmdbId: 123,
      });
      assert.equal(follow.followStatus.complete, true);
      assert.equal(follow.followStatus.label, "Imported");
      assert.equal(follow.view.state.kind, "success");
    });
  });
});

describe("TV/movie lifecycle controls", () => {
  it("updates existing movie monitoring and optionally starts a Radarr search", async () => {
    existingMovies = [{ id: 999, ...movie, monitored: false }];
    process.env.ALLOW_REQUESTS = "true";

    await withMcpClient(async (client) => {
      const result = await callToolJson(client, "set_movie_monitoring", {
        tmdbId: 123,
        monitored: true,
        searchNow: true,
      });

      assert.equal(result.lifecycle.schema, "media-mcp.lifecycle.v1");
      assert.equal(result.lifecycle.service, "radarr");
      assert.equal(result.lifecycle.mediaType, "movie");
      assert.equal(result.lifecycle.monitored, true);
      assert.equal(result.lifecycle.searchStarted, true);
      assert.equal(result.lifecycle.commandId, 777);
      assert.equal(result.view.schema, "media-mcp.view.v1");
      assert.equal(result.view.state.kind, "success");

      const update = fetchCalls.find((call) => call.method === "PUT" && call.path === "/api/v3/movie/999");
      assert.ok(update);
      assert.equal((update.body as any).monitored, true);

      const command = fetchCalls.find((call) => call.method === "POST" && call.path === "/api/v3/command");
      assert.deepEqual(command?.body, { name: "MoviesSearch", movieIds: [999] });
    });
  });

  it("updates exactly one existing Sonarr season without changing neighboring seasons", async () => {
    existingSeries = [{
      id: 555,
      ...series,
      seasons: [
        { seasonNumber: 1, monitored: false, statistics: { episodeCount: 3 } },
        { seasonNumber: 2, monitored: false, statistics: { episodeCount: 2 } },
        { seasonNumber: 3, monitored: true, statistics: { episodeCount: 4 } },
      ],
    }];
    process.env.ALLOW_REQUESTS = "true";

    await withMcpClient(async (client) => {
      const result = await callToolJson(client, "set_series_season_monitoring", {
        tvdbId: 321,
        seasonNumber: 2,
        monitored: true,
        searchNow: true,
      });

      assert.equal(result.lifecycle.schema, "media-mcp.lifecycle.v1");
      assert.equal(result.lifecycle.service, "sonarr");
      assert.equal(result.lifecycle.scope, "season");
      assert.equal(result.lifecycle.target.seasonNumber, 2);
      assert.equal(result.lifecycle.monitored, true);
      assert.equal(result.lifecycle.searchStarted, true);
      assert.equal(result.lifecycle.expectedEpisodeCount, 2);
      assert.equal(result.season.expectedEpisodeCount, 2);
      assert.equal(result.view.state.kind, "success");

      const update = fetchCalls.find((call) => call.method === "PUT" && call.path === "/api/v3/series/555");
      assert.ok(update);
      const updatedSeasons = (update.body as any).seasons;
      assert.deepEqual(updatedSeasons.map((season: any) => [season.seasonNumber, season.monitored]), [
        [1, false],
        [2, true],
        [3, true],
      ]);

      const command = fetchCalls.find((call) => call.method === "POST" && call.path === "/api/v3/command");
      assert.deepEqual(command?.body, { name: "SeasonSearch", seriesId: 555, seasonNumber: 2 });
    });
  });

  it("requests a missing Sonarr series with only the requested season monitored", async () => {
    process.env.ALLOW_REQUESTS = "true";

    await withMcpClient(async (client) => {
      const result = await callToolJson(client, "request_series_season", {
        tvdbId: 321,
        seasonNumber: 2,
        qualityProfileId: 1,
        rootFolderPath: "/movies",
        monitored: true,
        searchNow: true,
      });

      assert.equal(result.lifecycle.service, "sonarr");
      assert.equal(result.lifecycle.target.seasonNumber, 2);
      assert.equal(result.lifecycle.searchStarted, true);
      assert.equal(result.expectedEpisodeCount, 2);
      assert.equal(result.view.state.kind, "success");

      const add = fetchCalls.find((call) => call.method === "POST" && call.path === "/api/v3/series");
      assert.ok(add);
      const addedSeasons = (add.body as any).seasons;
      assert.deepEqual(addedSeasons.map((season: any) => [season.seasonNumber, season.monitored]), [
        [1, false],
        [2, true],
        [3, false],
      ]);
      assert.equal((add.body as any).addOptions.monitor, "none");
      assert.equal((add.body as any).addOptions.searchForMissingEpisodes, false);

      const command = fetchCalls.find((call) => call.method === "POST" && call.path === "/api/v3/command");
      assert.deepEqual(command?.body, { name: "SeasonSearch", seriesId: 888, seasonNumber: 2 });
    });
  });

  it("routes request_series_season through existing series lifecycle instead of adding duplicates", async () => {
    existingSeries = [{ id: 555, ...series }];
    process.env.ALLOW_REQUESTS = "true";

    await withMcpClient(async (client) => {
      const result = await callToolJson(client, "request_series_season", {
        tvdbId: 321,
        seasonNumber: 2,
        qualityProfileId: 1,
        rootFolderPath: "/movies",
        searchNow: false,
      });

      assert.equal(result.lifecycle.target.seriesId, 555);
      assert.equal(fetchCalls.some((call) => call.method === "POST" && call.path === "/api/v3/series"), false);
      assert.equal(fetchCalls.some((call) => call.method === "PUT" && call.path === "/api/v3/series/555"), true);
    });
  });
});

describe("Dashboard contract hardening", () => {
  it("returns neutral envelopes for core dashboard tools", async () => {
    queueRecords = [
      {
        title: "Test Movie.2026.1080p.WEB-DL",
        status: "downloading",
        size: 1000,
        sizeleft: 500,
      },
    ];
    missingRecords = [
      {
        movie: { title: "Missing Movie" },
        title: "Missing Episode",
        airDateUtc: "2026-07-01T00:00:00Z",
        monitored: true,
      },
    ];

    const status = await media.serviceStatus() as any;
    assertSummaryEnvelope(status, "serviceStatus");
    assert.equal(status.view.state.kind, "partial_failure");
    assert.ok(status.missing.length > 0);
    assert.ok(status.services.some((service: any) => service.service === "sabnzbd"));

    const health = await media.serviceHealth() as any;
    assertSummaryEnvelope(health, "serviceHealth");
    assert.equal(health.view.state.kind, "success");

    const queue = await media.downloadQueue(undefined, 10) as any;
    assertSummaryEnvelope(queue, "downloadQueue");
    assert.equal(queue.view.state.kind, "success");
    assert.ok(queue.services.reduce((sum: number, service: any) => sum + Number(service.total ?? 0), 0) > 0);

    const missing = await media.missingSummary(5) as any;
    assertSummaryEnvelope(missing, "missingSummary");
    assert.equal(missing.view.state.kind, "success");
    assert.ok(missing.services.every((service: any) => typeof service.total === "number"));

    const issues = await media.importIssues(10) as any;
    assertSummaryEnvelope(issues, "importIssues");
    assert.ok(["success", "empty"].includes(issues.view.state.kind));
  });

  it("marks dashboard views as partial failures when downstream services fail", async () => {
    queueRecords = [
      {
        title: "Blocked Download",
        status: "warning",
        trackedDownloadStatus: "warning",
        statusMessages: [{ title: "Import blocked", messages: ["No writable path"] }],
      },
    ];
    failedRequests.add("lidarr.test/api/v1/queue");

    const queue = await media.downloadQueue(undefined, 10) as any;
    assertSummaryEnvelope(queue, "downloadQueue partial");
    assert.equal(queue.view.state.kind, "partial_failure");
    assert.ok(queue.warnings.some((warning: string) => warning.startsWith("lidarr:")));
  });

  it("keeps composed media stack overview client-neutral", async () => {
    const overview = await media.mediaStackOverview() as any;

    assertSummaryEnvelope(overview, "mediaStackOverview");
    assert.ok(["success", "partial_failure", "empty"].includes(overview.view.state.kind));
    assert.ok(overview.view.cards.some((card: any) => card.id === "services"));
    assert.ok(overview.view.cards.some((card: any) => card.id === "activity"));
    assert.equal(overview.safety.requestToolsEnabled, false);
  });
});

describe("Request follow status", () => {
  it("aggregates multiple Sonarr episode queue items", async () => {
    queueRecords = [
      {
        title: "Sugar.2024.S02E02.Downer.Town.2160p.WEB-DL",
        status: "downloading",
        size: 1000,
        sizeleft: 200,
        timeleft: "00:02:00",
      },
      {
        title: "Sugar.S02E01.Home.Away.from.Home.2160p.WEB-DL",
        status: "downloading",
        size: 1000,
        sizeleft: 1000,
      },
    ];

    const result = await media.requestFollowStatus({
      service: "sonarr",
      title: "Sugar",
      expectedEpisodeCount: 2,
      polls: 3,
    }) as any;

    assert.equal(result.followStatus.label, "Downloading");
    assert.equal(result.followStatus.schema, "media-mcp.followStatus.v1");
    assert.equal(result.followStatus.phase, "downloading");
    assert.equal(result.followStatus.terminal, false);
    assert.equal(result.followStatus.activeCount, 2);
    assert.equal(result.followStatus.expectedEpisodeCount, 2);
    assert.equal(result.followStatus.nextPollRecommended, true);
    assert.equal(result.followStatus.pollDelaySeconds, 20);
    assert.equal(result.followStatus.progress, 40);
    assert.match(result.followStatus.episodeDetail, /Queue: 2 episodes/);
    assert.match(result.followStatus.episodeDetail, /Imported: 0\/2/);
    assert.equal(result.queue.service, 2);
    assert.equal(result.followStatus.polls, 3);
  });

  it("completes Sonarr follow status when expected imports arrive", async () => {
    historyRecords = [
      {
        sourceTitle: "Sugar.2024.S02E02.Downer.Town.2160p.WEB-DL",
        eventType: "downloadFolderImported",
        date: "2026-06-27T07:42:07Z",
      },
      {
        sourceTitle: "Sugar.S02E01.Home.Away.from.Home.2160p.WEB-DL",
        eventType: "downloadFolderImported",
        date: "2026-06-27T07:44:20Z",
      },
    ];

    const result = await media.requestFollowStatus({
      service: "sonarr",
      title: "Sugar",
      expectedEpisodeCount: 2,
    }) as any;

    assert.equal(result.followStatus.complete, true);
    assert.equal(result.followStatus.label, "Imported");
    assert.equal(result.followStatus.phase, "imported");
    assert.equal(result.followStatus.terminal, true);
    assert.equal(result.followStatus.nextPollRecommended, false);
    assert.equal(result.followStatus.importedCount, 2);
    assert.match(result.followStatus.episodeDetail, /Imported: 2\/2/);
    assert.equal(result.history.imported, 2);
    assert.equal(result.view.state.kind, "success");
  });

  it("reports partial Sonarr imports as importing and keeps polling", async () => {
    historyRecords = [
      {
        sourceTitle: "Sugar.2024.S02E01.Home.Away.from.Home.2160p.WEB-DL",
        eventType: "downloadFolderImported",
        date: "2026-06-27T07:44:20Z",
      },
    ];

    const result = await media.requestFollowStatus({
      service: "sonarr",
      title: "Sugar",
      expectedEpisodeCount: 2,
    }) as any;

    assert.equal(result.followStatus.phase, "importing");
    assert.equal(result.followStatus.complete, false);
    assert.equal(result.followStatus.terminal, false);
    assert.equal(result.followStatus.importedCount, 1);
    assert.equal(result.followStatus.expectedEpisodeCount, 2);
    assert.equal(result.followStatus.nextPollRecommended, true);
    assert.equal(result.view.state.kind, "loading");
  });

  it("reports grabbed movie requests as non-terminal follow states", async () => {
    historyRecords = [
      {
        sourceTitle: "Test Movie.2026.1080p.WEB-DL",
        eventType: "grabbed",
        date: "2026-06-29T07:00:00Z",
      },
    ];

    const result = await media.requestFollowStatus({
      service: "radarr",
      title: "Test Movie",
      tmdbId: 123,
      polls: 2,
    }) as any;

    assert.equal(result.followStatus.phase, "grabbed");
    assert.equal(result.followStatus.mediaType, "movie");
    assert.equal(result.followStatus.terminal, false);
    assert.equal(result.followStatus.nextPollRecommended, true);
    assert.equal(result.followStatus.pollDelaySeconds, 15);
    assert.equal(result.view.state.kind, "loading");
  });

  it("reports unresolved failed movie requests as terminal errors", async () => {
    historyRecords = [
      {
        sourceTitle: "Test Movie.2026.1080p.WEB-DL",
        eventType: "downloadFailed",
        date: "2026-06-29T07:00:00Z",
      },
    ];

    const result = await media.requestFollowStatus({
      service: "radarr",
      title: "Test Movie",
      tmdbId: 123,
    }) as any;

    assert.equal(result.followStatus.phase, "failed");
    assert.equal(result.followStatus.failed, true);
    assert.equal(result.followStatus.terminal, true);
    assert.equal(result.followStatus.nextPollRecommended, false);
    assert.equal(result.view.state.kind, "error");
  });

  it("reports untouched requests as requested with timed polling hints", async () => {
    const result = await media.requestFollowStatus({
      service: "radarr",
      title: "Test Movie",
      tmdbId: 123,
      polls: 4,
    }) as any;

    assert.equal(result.followStatus.phase, "requested");
    assert.equal(result.followStatus.terminal, false);
    assert.equal(result.followStatus.nextPollRecommended, true);
    assert.equal(result.followStatus.pollDelaySeconds, 25);
    assert.equal(result.view.state.kind, "loading");
  });
});

describe("Sonarr request draft contract", () => {
  it("returns generic formFields for series search options", async () => {
    const result = await media.searchSeries("test series", 10) as any;

    assertServerNeutralContract(result);
    assert.equal(result.requestDraft.schema, "media-mcp.requestDraft.v1");
    assert.equal(result.requestDraft.kind, "series");
    assert.equal(result.requestDraft.service, "sonarr");
    assert.equal(result.requestDraft.writeGate.env, "ALLOW_REQUESTS");
    assert.equal(result.requestDraft.writeGate.enabled, false);
    assert.equal("components" in result, false);

    const quality = fieldById(result, "qualityProfileId");
    assert.equal(quality.type, "select");
    assert.equal(quality.required, true);
    assert.equal(quality.value, 1);

    const root = fieldById(result, "rootFolderPath");
    assert.equal(root.type, "select");
    assert.equal(root.required, true);
    assert.equal(root.value, "/movies");

    const monitor = fieldById(result, "monitorMode");
    assert.equal(monitor.type, "select");
    assert.equal(monitor.value, "all");
    assert.ok(monitor.options.some((option: any) => option.value === "future"));

    assert.equal(fieldById(result, "seasonFolder").type, "checkbox");
    assert.equal(fieldById(result, "seasonFolder").value, true);
    assert.equal(fieldById(result, "searchNow").type, "checkbox");
    assert.equal(fieldById(result, "searchNow").value, true);
  });

  it("preserves selected series options in preview", async () => {
    const result = await media.previewSeriesRequest({
      tvdbId: 321,
      qualityProfileId: 2,
      rootFolderPath: "/movies-4k",
      monitorMode: "future",
      seasonFolder: false,
      searchNow: false,
      tagIds: [7],
    }) as any;

    assertServerNeutralContract(result);
    assert.equal(result.requestDraft.selectedCandidate.tvdbId, 321);
    assert.equal(result.requestDraft.defaults.qualityProfileId, 2);
    assert.equal(result.requestDraft.defaults.rootFolderPath, "/movies-4k");
    assert.equal(result.requestDraft.defaults.monitorMode, "future");
    assert.equal(result.requestDraft.defaults.seasonFolder, false);
    assert.equal(result.requestDraft.defaults.searchNow, false);
    assert.deepEqual(result.requestDraft.defaults.tagIds, [7]);
    assert.equal(fieldById(result, "qualityProfileId").value, 2);
    assert.equal(fieldById(result, "rootFolderPath").value, "/movies-4k");
    assert.equal(fieldById(result, "monitorMode").value, "future");
    assert.equal(fieldById(result, "seasonFolder").value, false);
    assert.equal(fieldById(result, "searchNow").value, false);
    assert.equal(result.payloadPreview.addOptions.monitor, "future");
    assert.equal(result.payloadPreview.seasonFolder, false);
    assert.equal(result.payloadPreview.addOptions.searchForMissingEpisodes, false);
    assert.equal("components" in result, false);
  });

  it("keeps series submit disabled while request tools are disabled", async () => {
    const result = await media.previewSeriesRequest({
      tvdbId: 321,
      qualityProfileId: 1,
      rootFolderPath: "/movies",
      monitorMode: "all",
      seasonFolder: true,
      searchNow: true,
    }) as any;

    assertServerNeutralContract(result);
    const action = result.view.cards[0].actions[0];
    assert.equal(action.id, "request-series");
    assert.equal(action.disabled, true);
    assert.equal(result.requestDraft.writeGate.enabled, false);
    assert.match(result.summary, /Preview ready/);
    assert.ok(result.view.state.warnings.includes("Request tools are disabled"));
  });

  it("refuses series request writes before posting when ALLOW_REQUESTS is false", async () => {
    await assert.rejects(
      media.requestSeries({
        tvdbId: 321,
        qualityProfileId: 1,
        rootFolderPath: "/movies",
        monitorMode: "all",
        seasonFolder: true,
        searchNow: true,
      }),
      /Request tools are disabled/,
    );

    assert.equal(fetchCalls.some((call) => call.method === "POST"), false);
  });
});
