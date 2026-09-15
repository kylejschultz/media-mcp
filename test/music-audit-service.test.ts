import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import sharp from "sharp";
import { MusicAuditService, scanMusicLibrary, type MusicAuditConfig, type MusicAuditSnapshot } from "../src/music-audit.js";
import { createMediaMcpServer } from "../src/server.js";

async function fixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "music-audit-service-"));
  const root = path.join(temp, "music");
  const cacheDir = path.join(temp, "cache");
  const mountInfoPath = path.join(temp, "mountinfo");
  await mkdir(root);
  await writeFile(mountInfoPath, `2 1 0:2 / ${root.replaceAll(" ", "\\040")} ro,nosuid - bind /host/music ro\n`);
  const config: MusicAuditConfig = { enabled: true, artworkPreviewEnabled: false, root, cacheDir, lowResolutionThreshold: 600, concurrency: 4, cooldownSeconds: 300, maxFiles: 100_000, maxImageBytes: 32 * 1024 * 1024 };
  return { temp, root, cacheDir, mountInfoPath, config };
}

function assertScalarViewMetrics(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(assertScalarViewMetrics);
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.metrics)) {
    for (const metric of record.metrics as Array<{ value: unknown }>) assert.ok(typeof metric.value === "string" || typeof metric.value === "number");
  }
  Object.values(record).forEach(assertScalarViewMetrics);
}

function snapshot(config: MusicAuditConfig, scanId: string, startedAt: string, albums = 1): MusicAuditSnapshot {
  const album = {
    id: "alb_0123456789abcdef01234567",
    keySource: "metadata" as const,
    album: "Album",
    albumArtist: "Artist",
    directories: ["Artist/Album"],
    genres: ["Rock"],
    tracks: [{ path: "Artist/Album/01.flac", directory: "Artist/Album", genres: ["Rock"], embeddedArt: [] }],
    sidecars: [],
    issueIds: ["iss_0123456789abcdef01234567"],
  };
  return {
    schemaVersion: 1,
    scanId,
    status: "completed",
    startedAt,
    completedAt: new Date().toISOString(),
    root: config.root,
    thresholds: { lowResolutionPx: 600 },
    progress: { phase: "completed", discoveredAudio: albums, discoveredImages: 0, processedAudio: albums, processedImages: 0, failedMetadata: 0, failedImages: 0 },
    summary: { tracks: albums, albums, issues: albums, candidates: 0, byType: { art_missing: albums } },
    albums: albums ? [album] : [],
    issues: albums ? [{ id: album.issueIds[0]!, albumId: album.id, type: "art_missing", severity: "issue", summary: "No artwork" }] : [],
    warnings: [],
    errors: [],
  };
}

function sha256(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

function syncSafe(value: number) {
  return Buffer.from([(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f]);
}

function id3Track({ album, albumArtist, genre, title = "Track" }: { album: string; albumArtist: string; genre: string; title?: string }) {
  const frame = (id: string, value: string) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(value)]);
    const header = Buffer.alloc(10);
    header.write(id, 0, "ascii");
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  };
  const body = Buffer.concat([frame("TIT2", title), frame("TALB", album), frame("TPE2", albumArtist), frame("TCON", genre)]);
  return Buffer.concat([Buffer.from("ID3\x03\x00\x00", "binary"), syncSafe(body.length), body]);
}

function id3WithPictures(pictures: Buffer[]) {
  const frames = pictures.map((picture) => {
    const body = Buffer.concat([Buffer.from([0]), Buffer.from("image/png\0"), Buffer.from([3, 0]), picture]);
    const header = Buffer.alloc(10);
    header.write("APIC", 0, "ascii");
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  });
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from("ID3\x03\x00\x00", "binary"), syncSafe(body.length), body]);
}

async function artworkFixture() {
  const files = await fixture();
  files.config.artworkPreviewEnabled = true;
  const directory = path.join(files.root, "Artist", "Album");
  await mkdir(directory, { recursive: true });
  const first = await sharp({ create: { width: 800, height: 600, channels: 4, background: "#ff000080" } }).png().toBuffer();
  const second = await sharp({ create: { width: 200, height: 300, channels: 3, background: "#0066ff" } }).png().toBuffer();
  await writeFile(path.join(directory, "cover.png"), first);
  await writeFile(path.join(directory, "back.png"), second);
  await writeFile(path.join(directory, "01.mp3"), id3WithPictures([first, second]));
  const completed = snapshot(files.config, "artwork-scan", "2026-01-01T00:00:00.000Z");
  completed.albums[0]!.tracks = [{
    path: "Artist/Album/01.mp3",
    directory: "Artist/Album",
    genres: ["Rock"],
    embeddedArt: [
      { source: "embedded", readable: true, sha256: sha256(first), width: 800, height: 600, mime: "image/png" },
      { source: "embedded", readable: true, sha256: sha256(second), width: 200, height: 300, mime: "image/png" },
    ],
  }];
  completed.albums[0]!.sidecars = [
    { source: "sidecar", filename: "Artist/Album/cover.png", readable: true, sha256: sha256(first), width: 800, height: 600 },
    { source: "sidecar", filename: "Artist/Album/back.png", readable: true, sha256: sha256(second), width: 200, height: 300 },
  ];
  await mkdir(files.cacheDir);
  await writeFile(path.join(files.cacheDir, "snapshot.json"), JSON.stringify(completed));
  return { ...files, completed, first, second, directory };
}

describe("music audit capabilities and lifecycle", () => {
  it("does not start unless enabled and positively read-only", async () => {
    const files = await fixture();
    const disabled = new MusicAuditService({ ...files.config, enabled: false }, { mountInfoPath: files.mountInfoPath });
    const capability = await disabled.capabilities() as any;
    assert.equal(capability.enabled, false);
    assert.equal(capability.root.readable, true);
    assert.equal(capability.readOnlyMount.verified, true);
    assert.equal(capability.cache.configured, true);
    assert.equal(capability.cache.writable, true);
    assert.equal(capability.cache.exists, false);
    assert.equal(capability.canStart, false);
    await assert.rejects(disabled.start(), /disabled/);

    await writeFile(files.mountInfoPath, `2 1 0:2 / ${files.root} rw - bind /host/music rw\n`);
    const writable = new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath });
    await assert.rejects(writable.start(), /positively verified read-only/);
  });

  it("reports and rejects an unusable cache without probing it with writes", async () => {
    const files = await fixture();
    await writeFile(files.cacheDir, "not a directory");
    const service = new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath });
    const capability = await service.capabilities() as any;
    assert.equal(capability.cache.configured, true);
    assert.equal(capability.cache.exists, true);
    assert.equal(capability.cache.writable, false);
    assert.equal(capability.canStart, false);
    assert.match(capability.cache.error, /not a directory/);
    assert.equal(await readFile(files.cacheDir, "utf8"), "not a directory");
    await assert.rejects(service.start(), /cache is not writable/);
  });

  it("rejects roots with intermediate symlink components and writable descendant mounts", async () => {
    const files = await fixture();
    const actualParent = path.join(files.temp, "actual");
    const actualRoot = path.join(actualParent, "music");
    const linkedParent = path.join(files.temp, "linked");
    await mkdir(actualRoot, { recursive: true });
    await symlink(actualParent, linkedParent);
    const configuredRoot = path.join(linkedParent, "music");
    await writeFile(files.mountInfoPath, `2 1 0:2 / ${configuredRoot} ro - bind /host/music ro\n`);
    const symlinked = new MusicAuditService({ ...files.config, root: configuredRoot }, { mountInfoPath: files.mountInfoPath });
    const symlinkCapability = await symlinked.capabilities() as any;
    assert.equal(symlinkCapability.root.canonicalMatchesConfigured, false);
    assert.equal(symlinkCapability.canStart, false);
    await assert.rejects(symlinked.start(), /symlinked path component|canonical path/);

    await writeFile(files.mountInfoPath, [
      `2 1 0:2 / ${files.root} ro - bind /host/music ro`,
      `3 2 0:3 / ${path.join(files.root, "imports")} rw - bind /host/imports rw`,
    ].join("\n"));
    const descendant = new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath });
    const descendantCapability = await descendant.capabilities() as any;
    assert.deepEqual(descendantCapability.readOnlyMount.writableDescendantMounts, [path.join(files.root, "imports")]);
    assert.equal(descendantCapability.readOnlyMount.verified, false);
    await assert.rejects(descendant.start(), /writable descendant mount/);
  });

  it("enforces a post-completion cooldown", async () => {
    const files = await fixture();
    await mkdir(files.cacheDir);
    await writeFile(path.join(files.cacheDir, "snapshot.json"), JSON.stringify(snapshot(files.config, "recent", new Date().toISOString())));
    let scannerCalls = 0;
    const service = new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath, scanner: async (config, scanId, startedAt) => { scannerCalls += 1; return snapshot(config, scanId, startedAt); } });
    await assert.rejects(service.start(), /cooldown is active until/);
    assert.equal(scannerCalls, 0);
  });

  it("shares one active scan per service, reports progress, and atomically publishes completion", async () => {
    const files = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let scannerCalls = 0;
    const service = new MusicAuditService(files.config, {
      mountInfoPath: files.mountInfoPath,
      scanner: async (config, scanId, startedAt, onProgress) => {
        scannerCalls += 1;
        onProgress?.({ phase: "tracks", discoveredAudio: 7000, discoveredImages: 500, processedAudio: 1234, processedImages: 500, failedMetadata: 2, failedImages: 3 });
        await gate;
        return snapshot(config, scanId, startedAt, 7000);
      },
    });
    const [first, second] = await Promise.all([service.start(), service.start()]) as any[];
    assert.equal(scannerCalls, 1);
    assert.equal(first.scan.scanId, second.scan.scanId);
    assert.equal(second.scan.status, "running");
    const running = await service.status() as any;
    assert.deepEqual(running.scan.progress, { phase: "tracks", discoveredAudio: 7000, discoveredImages: 500, processedAudio: 1234, processedImages: 500, failedMetadata: 2, failedImages: 3 });
    release();
    await service.waitForScan();

    const persisted = JSON.parse(await readFile(path.join(files.cacheDir, "snapshot.json"), "utf8"));
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.scanId, first.scan.scanId);
    const completedStatus = await service.status() as any;
    assert.equal(completedStatus.scan.progress.phase, "completed");
    assert.equal(completedStatus.scan.progress.processedAudio, 7000);
    assert.equal((await readdir(files.cacheDir)).some((name) => name.endsWith(".tmp")), false);
  });

  it("marks a persisted running scan interrupted and keeps the completed snapshot", async () => {
    const files = await fixture();
    await mkdir(files.cacheDir);
    const completed = snapshot(files.config, "completed-scan", "2026-01-01T00:00:00.000Z");
    await writeFile(path.join(files.cacheDir, "snapshot.json"), JSON.stringify(completed));
    await writeFile(path.join(files.cacheDir, "scan-state.json"), JSON.stringify({ schemaVersion: 1, scanId: "lost-scan", status: "running", startedAt: "2026-01-02T00:00:00.000Z", warnings: [], errors: [] }));
    const service = new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath });
    const status = await service.status() as any;
    const summary = await service.summary() as any;
    assert.equal(status.scan.status, "interrupted");
    assert.equal(status.latestCompletedScanId, "completed-scan");
    assert.equal(summary.scanId, "completed-scan");
    const state = JSON.parse(await readFile(path.join(files.cacheDir, "scan-state.json"), "utf8"));
    assert.equal(state.status, "interrupted");
  });

  it("ignores malformed and wrong-root cached snapshots", async () => {
    const files = await fixture();
    await mkdir(files.cacheDir);
    await writeFile(path.join(files.cacheDir, "snapshot.json"), "{not json");
    const malformed = await new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath }).summary() as any;
    assert.equal(malformed.snapshot, null);

    await writeFile(path.join(files.cacheDir, "snapshot.json"), JSON.stringify({ ...snapshot(files.config, "wrong-root", "2026-01-01T00:00:00.000Z"), root: "/different-root" }));
    const mismatched = await new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath }).summary() as any;
    assert.equal(mismatched.snapshot, null);
  });

  it("preserves the previous completed snapshot when a later scan fails", async () => {
    const files = await fixture();
    await mkdir(files.cacheDir);
    const completed = snapshot(files.config, "completed-scan", "2026-01-01T00:00:00.000Z");
    await writeFile(path.join(files.cacheDir, "snapshot.json"), JSON.stringify(completed));
    const service = new MusicAuditService({ ...files.config, cooldownSeconds: 0 }, { mountInfoPath: files.mountInfoPath, scanner: async () => { throw new Error("injected failure"); } });
    await service.start();
    await service.waitForScan();
    const status = await service.status() as any;
    const summary = await service.summary() as any;
    assert.equal(status.scan.status, "failed");
    assert.equal(summary.scanId, "completed-scan");
    assert.equal(JSON.parse(await readFile(path.join(files.cacheDir, "snapshot.json"), "utf8")).scanId, "completed-scan");
  });
});

describe("music audit pagination and MCP contract", () => {
  it("filters and paginates issues and resolves opaque album detail", async () => {
    const files = await fixture();
    await mkdir(files.cacheDir);
    const completed = snapshot(files.config, "completed-scan", "2026-01-01T00:00:00.000Z");
    completed.issues.push({ id: "iss_abcdefabcdefabcdefabcdef", albumId: completed.albums[0]!.id, type: "genre_broad_only_candidate", severity: "candidate", summary: "Broad genre" });
    await writeFile(path.join(files.cacheDir, "snapshot.json"), JSON.stringify(completed));
    const service = new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath });
    const capabilities = await service.capabilities() as any;
    const status = await service.status() as any;
    const summary = await service.summary() as any;
    const issues = await service.issues({ severity: "candidate", offset: 0, limit: 1 }) as any;
    assert.equal(issues.total, 1);
    assert.equal(issues.items.length, 1);
    assert.equal(issues.items[0].severity, "candidate");
    const detail = await service.albumDetail(completed.albums[0]!.id) as any;
    assert.equal(detail.album.id, completed.albums[0]!.id);
    assert.equal(detail.issues.length, 2);
    for (const result of [capabilities, status, summary, issues, detail]) assertScalarViewMetrics(result.view);
    await assert.rejects(service.albumDetail("alb_ffffffffffffffffffffffff"), /not found/);
  });

  it("returns exact raw genre rows with deduplicated counts, normalization, search, and pagination", async () => {
    const files = await fixture();
    await mkdir(files.cacheDir);
    const completed = snapshot(files.config, "genre-scan", "2026-01-01T00:00:00.000Z");
    completed.albums = [
      {
        id: "alb_0123456789abcdef01234567",
        keySource: "metadata",
        album: "First Album",
        albumArtist: "First Artist",
        year: 2020,
        directories: ["First Artist/First Album"],
        genres: [],
        tracks: [
          { path: "First Artist/First Album/01.flac", directory: "First Artist/First Album", genres: ["Rock", "Rock", "  ＲＯＣＫ \t ", "Jazz; Blues", "Cafe\u0301"], embeddedArt: [] },
          { path: "First Artist/First Album/02.flac", directory: "First Artist/First Album", genres: ["Rock", "Café"], embeddedArt: [] },
        ],
        sidecars: [],
        issueIds: [],
      },
      {
        id: "alb_abcdefabcdefabcdefabcdef",
        keySource: "metadata",
        album: "Second Album",
        albumArtist: "Second Artist",
        year: 2021,
        directories: ["Second Artist/Second Album"],
        genres: [],
        tracks: [
          { path: "Second Artist/Second Album/01.flac", directory: "Second Artist/Second Album", genres: ["Rock", "Jazz; Blues"], embeddedArt: [] },
          { path: "Second Artist/Second Album/02.flac", directory: "Second Artist/Second Album", genres: ["", "  \t "], embeddedArt: [] },
        ],
        sidecars: [],
        issueIds: [],
      },
    ];
    completed.summary = { tracks: 4, albums: 2, issues: 0, candidates: 0, byType: {} };
    await writeFile(path.join(files.cacheDir, "snapshot.json"), JSON.stringify(completed));
    const service = new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath });

    const page = await service.genreDistribution({ offset: 1, limit: 1 }) as any;
    assert.equal(page.scanId, "genre-scan");
    assert.equal(page.total, 5);
    assert.equal(page.totalUniqueGenres, 5);
    assert.equal(page.totalTaggedTracks, 3);
    assert.equal(page.totalAlbumsRepresented, 2);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].rawGenre, "Jazz; Blues");
    assert.equal(page.items[0].trackCount, 2);
    assert.equal(page.items[0].albumCount, 2);
    assert.equal(page.items[0].representativeAlbums.length, 2);

    const rocks = await service.genreDistribution({ search: "ROCK" }) as any;
    assert.deepEqual(rocks.items.map((row: any) => row.rawGenre), ["Rock", "  ＲＯＣＫ \t "]);
    assert.ok(rocks.items.every((row: any) => row.normalizedKey === "rock"));
    assert.equal(rocks.items[0].trackCount, 3, "duplicate raw entries on one track count once");
    assert.equal(rocks.items[0].representativeAlbums[0].album, "First Album");

    const accents = await service.genreDistribution({ search: "café" }) as any;
    assert.equal(accents.total, 2);
    assert.deepEqual(new Set(accents.items.map((row: any) => row.rawGenre)), new Set(["Cafe\u0301", "Café"]));
    assert.ok(accents.items.every((row: any) => row.normalizedKey === "café"));

    const compounds = await service.genreDistribution({ search: "jazz" }) as any;
    assert.deepEqual(compounds.items.map((row: any) => row.rawGenre), ["Jazz; Blues"]);
    const bounded = await service.genreDistribution({ offset: -3, limit: 999 }) as any;
    assert.equal(bounded.offset, 0);
    assert.equal(bounded.limit, 200);
    assertScalarViewMetrics(page.view);
  });

  it("returns an empty genre distribution when no completed snapshot exists", async () => {
    const files = await fixture();
    const result = await new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath }).genreDistribution({}) as any;
    assert.equal(result.scanId, null);
    assert.deepEqual(result.items, []);
    assert.equal(result.total, 0);
    assert.equal(result.totalUniqueGenres, 0);
    assert.equal(result.totalTaggedTracks, 0);
    assert.equal(result.totalAlbumsRepresented, 0);
    assert.equal(result.offset, 0);
    assert.equal(result.limit, 50);
    assert.equal(result.view.schema, "media-mcp.view.v1");
    assert.equal(result.view.state.kind, "empty");
    assertScalarViewMetrics(result.view);
  });

  it("registers all nine read-only audit tools with bounded schemas", async () => {
    const server = createMediaMcpServer();
    const client = new Client({ name: "music-audit-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
    for (const name of ["music_audit_capabilities", "music_audit_start", "music_audit_status", "music_audit_summary", "music_audit_issues", "music_genre_distribution", "music_album_audit_verify", "music_album_audit_detail", "music_album_artwork_preview"]) assert.ok(tools.has(name), name);
    assert.equal((tools.get("music_audit_start")?.inputSchema as any)?.properties && Object.keys((tools.get("music_audit_start")?.inputSchema as any).properties).length, 0);
    assert.equal((tools.get("music_audit_issues")?.inputSchema as any).properties.limit.maximum, 100);
    assert.equal((tools.get("music_genre_distribution")?.inputSchema as any).properties.offset.default, 0);
    assert.equal((tools.get("music_genre_distribution")?.inputSchema as any).properties.limit.default, 50);
    assert.equal((tools.get("music_genre_distribution")?.inputSchema as any).properties.limit.maximum, 200);
    const verifySchema = tools.get("music_album_audit_verify")?.inputSchema as any;
    const verifyIds = verifySchema.properties.albumIds;
    assert.equal(verifySchema.additionalProperties, false);
    assert.equal(verifyIds.minItems, 1);
    assert.equal(verifyIds.maxItems, 25);
    assert.deepEqual(Object.keys((tools.get("music_album_artwork_preview")?.inputSchema as any).properties), ["albumId", "source", "index"]);
    assert.equal((tools.get("music_album_artwork_preview")?.inputSchema as any).properties.index.default, 0);
    const duplicate = await client.callTool({ name: "music_album_audit_verify", arguments: { albumIds: ["alb_0123456789abcdef01234567", "alb_0123456789abcdef01234567"] } }) as any;
    assert.equal(duplicate.isError, true);
    const extra = await client.callTool({ name: "music_album_audit_verify", arguments: { albumIds: ["alb_0123456789abcdef01234567"], path: "/tmp" } }) as any;
    assert.equal(extra.isError, true);
    await Promise.all([client.close(), server.close()]);
  });
});

describe("targeted music album verification", () => {
  it("rescans only selected directories, observes live changes, recomputes findings, and preserves full-scan files", async () => {
    const files = await fixture();
    files.config.cooldownSeconds = 86_400;
    const selectedDirectory = path.join(files.root, "Selected Artist", "Selected Album");
    const unselectedDirectory = path.join(files.root, "Other Artist", "Other Album");
    await mkdir(selectedDirectory, { recursive: true });
    await mkdir(unselectedDirectory, { recursive: true });
    await writeFile(path.join(selectedDirectory, "01.mp3"), id3Track({ album: "Selected Album", albumArtist: "Selected Artist", genre: "Rock" }));
    await writeFile(path.join(unselectedDirectory, "01.mp3"), id3Track({ album: "Other Album", albumArtist: "Other Artist", genre: "Pop" }));
    const cover = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#123456" } }).png().toBuffer();
    await writeFile(path.join(selectedDirectory, "cover.png"), cover);
    const baseline = await scanMusicLibrary(files.config, "baseline-scan", "2026-09-15T00:00:00.000Z");
    const selected = baseline.albums.find((album) => album.album === "Selected Album")!;
    assert.ok(selected);
    await mkdir(files.cacheDir);
    await writeFile(path.join(files.cacheDir, "snapshot.json"), `${JSON.stringify(baseline)}\n`);
    const state = `${JSON.stringify({ schemaVersion: 1, scanId: "full-scan-in-progress", status: "running", startedAt: "2026-09-15T01:00:00.000Z", warnings: [], errors: [] })}\n`;
    await writeFile(path.join(files.cacheDir, "scan-state.json"), state);
    const snapshotBytes = await readFile(path.join(files.cacheDir, "snapshot.json"));
    const stateBytes = await readFile(path.join(files.cacheDir, "scan-state.json"));

    await writeFile(path.join(selectedDirectory, "01.mp3"), id3Track({ album: "Selected Album", albumArtist: "Selected Artist", genre: "Jazz" }));
    await unlink(path.join(selectedDirectory, "cover.png"));
    const outside = path.join(files.temp, "must-not-be-read.mp3");
    await writeFile(outside, id3Track({ album: "Outside", albumArtist: "Outside", genre: "Metal" }));
    await unlink(path.join(unselectedDirectory, "01.mp3"));
    await symlink(outside, path.join(unselectedDirectory, "01.mp3"));

    const service = new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath });
    const result = await service.verifyAlbums([selected.id]) as any;
    assert.equal(result.status, "completed");
    assert.equal(result.baselineScanId, "baseline-scan");
    assert.equal(result.progress.discoveredAudio, 1);
    assert.equal(result.progress.discoveredImages, 0);
    assert.equal(result.albums.length, 1);
    assert.deepEqual(result.albums[0].live.tracks[0].genres, ["Jazz"]);
    assert.equal(result.albums[0].changes.genresChanged, true);
    assert.equal(result.albums[0].changes.artworkChanged, true);
    assert.ok(result.albums[0].changes.findingsAdded.includes("art_missing"));
    assert.ok(result.albums[0].changes.findingsResolved.includes("art_sidecar_only"));
    assert.ok(result.albums[0].findings.some((finding: any) => finding.type === "art_missing"));
    assert.deepEqual(await readFile(path.join(files.cacheDir, "snapshot.json")), snapshotBytes);
    assert.deepEqual(await readFile(path.join(files.cacheDir, "scan-state.json")), stateBytes);
  });

  it("recurses through nested baseline directories and deduplicates overlapping roots", async () => {
    const files = await fixture();
    const directory = path.join(files.root, "Artist", "Album");
    const discDirectory = path.join(directory, "Disc 2");
    await mkdir(discDirectory, { recursive: true });
    await writeFile(path.join(directory, "01.mp3"), id3Track({ album: "Album", albumArtist: "Artist", genre: "Rock", title: "One" }));
    await writeFile(path.join(discDirectory, "02.mp3"), id3Track({ album: "Album", albumArtist: "Artist", genre: "Rock", title: "Two" }));
    const cover = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#654321" } }).png().toBuffer();
    await writeFile(path.join(directory, "cover.png"), cover);
    await writeFile(path.join(discDirectory, "cover.png"), cover);
    const baseline = await scanMusicLibrary(files.config, "nested-baseline", "2026-09-15T00:00:00.000Z");
    assert.deepEqual(baseline.albums[0]!.directories, ["Artist/Album", "Artist/Album/Disc 2"]);
    await mkdir(files.cacheDir);
    await writeFile(path.join(files.cacheDir, "snapshot.json"), JSON.stringify(baseline));

    const result = await new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath }).verifyAlbums([baseline.albums[0]!.id]) as any;
    assert.equal(result.status, "completed");
    assert.equal(result.progress.discoveredAudio, 2);
    assert.equal(result.progress.discoveredImages, 2);
    assert.equal(result.albums[0].live.tracks.length, 2);
    assert.equal(result.albums[0].live.sidecars.length, 2);
  });

  it("reports unexpected nested tracks and fails closed on nested symlinks", async () => {
    const files = await fixture();
    const directory = path.join(files.root, "Artist", "Album");
    const nested = path.join(directory, "Bonus");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "01.mp3"), id3Track({ album: "Album", albumArtist: "Artist", genre: "Rock", title: "One" }));
    const baseline = await scanMusicLibrary(files.config, "nested-drift-baseline", "2026-09-15T00:00:00.000Z");
    await mkdir(files.cacheDir);
    await writeFile(path.join(files.cacheDir, "snapshot.json"), JSON.stringify(baseline));
    const albumId = baseline.albums[0]!.id;
    const service = new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath });

    await mkdir(nested);
    const addedTrack = path.join(nested, "02.mp3");
    await writeFile(addedTrack, id3Track({ album: "Album", albumArtist: "Artist", genre: "Rock", title: "Two" }));
    const drift = await service.verifyAlbums([albumId]) as any;
    assert.equal(drift.status, "failed");
    const pathDrift = drift.albums[0].errors.find((error: any) => error.code === "path_drift" && error.paths);
    assert.deepEqual(pathDrift.paths, ["Artist/Album/Bonus/02.mp3"]);
    assert.equal(drift.progress.discoveredAudio, 2);

    await unlink(addedTrack);
    const outside = path.join(files.temp, "outside.mp3");
    await writeFile(outside, id3Track({ album: "Outside", albumArtist: "Outside", genre: "Metal" }));
    await symlink(outside, path.join(nested, "linked.mp3"));
    const unsafe = await service.verifyAlbums([albumId]) as any;
    assert.equal(unsafe.status, "failed");
    assert.equal(unsafe.failure.code, "symlink_or_path_escape");
    assert.deepEqual(unsafe.albums, []);
  });

  it("rejects selected and unselected album boundaries that overlap by containment", async () => {
    const files = await fixture();
    const parent = path.join(files.root, "Artist");
    const child = path.join(parent, "Other Album");
    await mkdir(child, { recursive: true });
    await writeFile(path.join(parent, "parent.mp3"), id3Track({ album: "Parent Album", albumArtist: "Artist", genre: "Rock" }));
    await writeFile(path.join(child, "01.mp3"), id3Track({ album: "Other Album", albumArtist: "Artist", genre: "Jazz" }));
    const baseline = await scanMusicLibrary(files.config, "overlap-baseline", "2026-09-15T00:00:00.000Z");
    await mkdir(files.cacheDir);
    await writeFile(path.join(files.cacheDir, "snapshot.json"), JSON.stringify(baseline));
    const parentAlbum = baseline.albums.find((album) => album.album === "Parent Album")!;
    await assert.rejects(new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath }).verifyAlbums([parentAlbum.id]), /sharing that boundary/);
  });

  it("fails closed for identity drift, missing data, and the targeted scan limit", async () => {
    const files = await fixture();
    const directory = path.join(files.root, "Artist", "Album");
    await mkdir(directory, { recursive: true });
    const trackPath = path.join(directory, "01.mp3");
    await writeFile(trackPath, id3Track({ album: "Album", albumArtist: "Artist", genre: "Rock" }));
    const baseline = await scanMusicLibrary(files.config, "baseline", "2026-09-15T00:00:00.000Z");
    await mkdir(files.cacheDir);
    await writeFile(path.join(files.cacheDir, "snapshot.json"), JSON.stringify(baseline));
    const albumId = baseline.albums[0]!.id;
    const service = new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath });

    await writeFile(trackPath, id3Track({ album: "Renamed Album", albumArtist: "Artist", genre: "Rock" }));
    const mismatch = await service.verifyAlbums([albumId]) as any;
    assert.equal(mismatch.status, "failed");
    assert.ok(mismatch.albums[0].errors.some((error: any) => error.code === "identity_mismatch"));

    await unlink(trackPath);
    const missing = await service.verifyAlbums([albumId]) as any;
    assert.equal(missing.status, "failed");
    assert.ok(missing.albums[0].errors.some((error: any) => error.code === "missing_data"));

    await writeFile(trackPath, id3Track({ album: "Album", albumArtist: "Artist", genre: "Rock" }));
    await writeFile(path.join(directory, "cover.png"), Buffer.alloc(1024));
    const limited = await new MusicAuditService({ ...files.config, maxFiles: 1 }, { mountInfoPath: files.mountInfoPath }).verifyAlbums([albumId]) as any;
    assert.equal(limited.status, "failed");
    assert.equal(limited.failure.code, "scan_limit");
    assert.deepEqual(limited.albums, []);
  });

  it("rejects invalid, duplicate, unknown, and more than 25 album IDs", async () => {
    const files = await fixture();
    await mkdir(files.cacheDir);
    const completed = snapshot(files.config, "baseline", "2026-09-15T00:00:00.000Z");
    await writeFile(path.join(files.cacheDir, "snapshot.json"), JSON.stringify(completed));
    const service = new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath });
    const albumId = completed.albums[0]!.id;
    await assert.rejects(service.verifyAlbums([]), /1 to 25/);
    await assert.rejects(service.verifyAlbums([albumId, albumId]), /unique/);
    await assert.rejects(service.verifyAlbums(["not-an-album-id"]), /opaque/);
    await assert.rejects(service.verifyAlbums(["alb_ffffffffffffffffffffffff"]), /not found/);
    const tooMany = Array.from({ length: 26 }, (_, index) => `alb_${index.toString(16).padStart(24, "0")}`);
    await assert.rejects(service.verifyAlbums(tooMany), /1 to 25/);
  });
});

describe("bounded music artwork previews", () => {
  it("fails closed when disabled and advertises preview readiness", async () => {
    const files = await fixture();
    const disabled = new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath });
    const capability = await disabled.capabilities() as any;
    assert.equal(capability.artworkPreview.enabled, false);
    assert.equal(capability.canPreview, false);
    await assert.rejects(disabled.artworkPreview({ albumId: "alb_0123456789abcdef01234567", source: "sidecar" }), /preview is disabled/);
  });

  it("selects indexed sidecar and distinct embedded variants from the snapshot", async () => {
    const files = await artworkFixture();
    files.config.maxImageBytes = Math.max(files.first.byteLength, files.second.byteLength);
    assert.ok((await stat(path.join(files.directory, "01.mp3"))).size > files.config.maxImageBytes, "audio fixture exceeds the artwork byte limit");
    const service = new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath });
    const sidecar = await service.artworkPreview({ albumId: files.completed.albums[0]!.id, source: "sidecar", index: 1 });
    assert.deepEqual(sidecar.metadata.original, { sha256: sha256(files.second), width: 200, height: 300 });
    assert.ok(sidecar.metadata.preview.width <= 512 && sidecar.metadata.preview.height <= 512);
    assert.ok(sidecar.data.byteLength <= 1024 * 1024);
    assert.equal((await sharp(sidecar.data).metadata()).format, "jpeg");

    const embedded = await service.artworkPreview({ albumId: files.completed.albums[0]!.id, source: "embedded", index: 1 });
    assert.deepEqual(embedded.metadata.original, { sha256: sha256(files.second), width: 200, height: 300 });
    assert.equal(embedded.metadata.scanId, "artwork-scan");
    assert.equal(embedded.metadata.albumArtist, "Artist");
    assert.equal(embedded.metadata.albumTitle, "Album");
    await assert.rejects(service.artworkPreview({ albumId: files.completed.albums[0]!.id, source: "sidecar", index: 2 }), /out of range/);
  });

  it("rejects symlinks, escapes, changed hashes, and oversized sidecars", async () => {
    const symlinkFiles = await artworkFixture();
    const outside = path.join(symlinkFiles.temp, "outside.png");
    await writeFile(outside, symlinkFiles.first);
    await symlink(outside, path.join(symlinkFiles.directory, "linked.png"));
    symlinkFiles.completed.albums[0]!.sidecars = [{ source: "sidecar", filename: "Artist/Album/linked.png", readable: true, sha256: sha256(symlinkFiles.first), width: 800, height: 600 }];
    await writeFile(path.join(symlinkFiles.cacheDir, "snapshot.json"), JSON.stringify(symlinkFiles.completed));
    const symlinkService = new MusicAuditService(symlinkFiles.config, { mountInfoPath: symlinkFiles.mountInfoPath });
    await assert.rejects(symlinkService.artworkPreview({ albumId: symlinkFiles.completed.albums[0]!.id, source: "sidecar" }), /symlink/);

    const escapeFiles = await artworkFixture();
    escapeFiles.completed.albums[0]!.sidecars = [{ source: "sidecar", filename: "../../outside.png", readable: true, sha256: sha256(escapeFiles.first), width: 800, height: 600 }];
    await writeFile(path.join(escapeFiles.cacheDir, "snapshot.json"), JSON.stringify(escapeFiles.completed));
    await assert.rejects(new MusicAuditService(escapeFiles.config, { mountInfoPath: escapeFiles.mountInfoPath }).artworkPreview({ albumId: escapeFiles.completed.albums[0]!.id, source: "sidecar" }), /escapes/);

    const changedFiles = await artworkFixture();
    await writeFile(path.join(changedFiles.directory, "cover.png"), changedFiles.second);
    await assert.rejects(new MusicAuditService(changedFiles.config, { mountInfoPath: changedFiles.mountInfoPath }).artworkPreview({ albumId: changedFiles.completed.albums[0]!.id, source: "sidecar" }), /changed since/);

    const embeddedChangedFiles = await artworkFixture();
    await writeFile(path.join(embeddedChangedFiles.directory, "01.mp3"), id3WithPictures([embeddedChangedFiles.second, embeddedChangedFiles.first]));
    await assert.rejects(new MusicAuditService(embeddedChangedFiles.config, { mountInfoPath: embeddedChangedFiles.mountInfoPath }).artworkPreview({ albumId: embeddedChangedFiles.completed.albums[0]!.id, source: "embedded", index: 0 }), /changed since/);

    const oversizedFiles = await artworkFixture();
    oversizedFiles.config.maxImageBytes = 1024;
    await writeFile(path.join(oversizedFiles.directory, "cover.png"), Buffer.alloc(1025));
    await assert.rejects(new MusicAuditService(oversizedFiles.config, { mountInfoPath: oversizedFiles.mountInfoPath }).artworkPreview({ albumId: oversizedFiles.completed.albums[0]!.id, source: "sidecar" }), /exceeds 1024/);
  });

  it("limits process-wide concurrent preview generation to two", async () => {
    const files = await artworkFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    let bothEntered!: () => void;
    const ready = new Promise<void>((resolve) => { bothEntered = resolve; });
    const service = new MusicAuditService(files.config, {
      mountInfoPath: files.mountInfoPath,
      previewer: async () => {
        entered += 1;
        if (entered === 2) bothEntered();
        await gate;
        return { data: Buffer.from("jpeg"), originalWidth: 1, originalHeight: 1, width: 1, height: 1 };
      },
    });
    const first = service.artworkPreview({ albumId: files.completed.albums[0]!.id, source: "sidecar", index: 0 });
    const second = service.artworkPreview({ albumId: files.completed.albums[0]!.id, source: "sidecar", index: 1 });
    await ready;
    await assert.rejects(service.artworkPreview({ albumId: files.completed.albums[0]!.id, source: "sidecar", index: 0 }), /concurrency limit/);
    release();
    await Promise.all([first, second]);
  });

  it("returns MCP image content without putting base64 in metadata JSON and rejects invalid IDs", async () => {
    const files = await artworkFixture();
    const server = createMediaMcpServer(new MusicAuditService(files.config, { mountInfoPath: files.mountInfoPath }));
    const client = new Client({ name: "artwork-preview-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "music_album_artwork_preview", arguments: { albumId: files.completed.albums[0]!.id, source: "sidecar", index: 0 } }) as any;
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[1].type, "image");
    assert.equal(result.content[1].mimeType, "image/jpeg");
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.albumId, files.completed.albums[0]!.id);
    assert.equal(result.content[0].text.includes(result.content[1].data), false);
    assert.ok(envelope.preview.width <= 512 && envelope.preview.height <= 512);
    assert.ok(Buffer.from(result.content[1].data, "base64").byteLength <= 1024 * 1024);
    const invalid = await client.callTool({ name: "music_album_artwork_preview", arguments: { albumId: "../../etc/passwd", source: "sidecar" } }) as any;
    assert.equal(invalid.isError, true);
    await Promise.all([client.close(), server.close()]);
  });
});
