import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

process.env.RADARR_URL = "http://radarr.test";
process.env.RADARR_API_KEY = "test-api-key";
process.env.SONARR_URL = "http://sonarr.test";
process.env.SONARR_API_KEY = "test-api-key";
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
  seasons: [{ seasonNumber: 1, monitored: true }],
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

  if (method === "POST" && url.pathname === "/api/v3/movie") {
    return jsonResponse({ id: 999, ...call.body });
  }
  if (method === "POST" && url.pathname === "/api/v3/series") {
    return jsonResponse({ id: 888, ...call.body });
  }

  switch (url.pathname) {
    case "/api/v3/movie/lookup":
      return jsonResponse(url.searchParams.get("term") === "tmdb:123" ? [movie] : [movie, { ...movie, tmdbId: 456, title: "Other Movie" }]);
    case "/api/v3/series/lookup":
      return jsonResponse(url.searchParams.get("term") === "tvdb:321" ? [series] : [series, { ...series, tvdbId: 654, title: "Other Series" }]);
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
    case "/api/v3/queue":
      return jsonResponse({ totalRecords: queueRecords.length, records: queueRecords });
    case "/api/v3/history":
      return jsonResponse({ totalRecords: historyRecords.length, records: historyRecords });
    default:
      return jsonResponse({ error: `Unhandled test URL: ${url}` }, 404);
  }
};

const media = await import("../src/media.js");

function fieldById(result: any, id: string) {
  const field = result.requestDraft.formFields.find((candidate: any) => candidate.id === id);
  assert.ok(field, `expected form field ${id}`);
  return field;
}

describe("Radarr request draft contract", () => {
  it("returns generic formFields for movie search options", async () => {
    const result = await media.searchMovie("test movie", 10) as any;

    assert.equal(result.requestDraft.schema, "media-mcp.requestDraft.v1");
    assert.equal(result.requestDraft.kind, "movie");
    assert.equal(result.requestDraft.service, "radarr");
    assert.equal(result.requestDraft.writeGate.env, "ALLOW_REQUESTS");
    assert.equal(result.requestDraft.writeGate.enabled, false);

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
  });

  it("keeps submit disabled while request tools are disabled", async () => {
    const result = await media.previewMovieRequest({
      tmdbId: 123,
      qualityProfileId: 1,
      rootFolderPath: "/movies",
      monitored: true,
      searchNow: true,
    }) as any;

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
    assert.match(result.followStatus.episodeDetail, /Imported: 2\/2/);
    assert.equal(result.history.imported, 2);
    assert.equal(result.view.state.kind, "success");
  });
});

describe("Sonarr request draft contract", () => {
  it("returns generic formFields for series search options", async () => {
    const result = await media.searchSeries("test series", 10) as any;

    assert.equal(result.requestDraft.schema, "media-mcp.requestDraft.v1");
    assert.equal(result.requestDraft.kind, "series");
    assert.equal(result.requestDraft.service, "sonarr");
    assert.equal(result.requestDraft.writeGate.env, "ALLOW_REQUESTS");
    assert.equal(result.requestDraft.writeGate.enabled, false);

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
