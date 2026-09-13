import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MusicAuditService, type MusicAuditConfig, type MusicAuditSnapshot } from "../src/music-audit.js";
import { createMediaMcpServer } from "../src/server.js";

async function fixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "music-audit-service-"));
  const root = path.join(temp, "music");
  const cacheDir = path.join(temp, "cache");
  const mountInfoPath = path.join(temp, "mountinfo");
  await mkdir(root);
  await writeFile(mountInfoPath, `2 1 0:2 / ${root.replaceAll(" ", "\\040")} ro,nosuid - bind /host/music ro\n`);
  const config: MusicAuditConfig = { enabled: true, root, cacheDir, lowResolutionThreshold: 600, concurrency: 4, cooldownSeconds: 300, maxFiles: 100_000, maxImageBytes: 32 * 1024 * 1024 };
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

  it("registers all six read-only audit tools with bounded schemas", async () => {
    const server = createMediaMcpServer();
    const client = new Client({ name: "music-audit-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
    for (const name of ["music_audit_capabilities", "music_audit_start", "music_audit_status", "music_audit_summary", "music_audit_issues", "music_album_audit_detail"]) assert.ok(tools.has(name), name);
    assert.equal((tools.get("music_audit_start")?.inputSchema as any)?.properties && Object.keys((tools.get("music_audit_start")?.inputSchema as any).properties).length, 0);
    assert.equal((tools.get("music_audit_issues")?.inputSchema as any).properties.limit.maximum, 100);
    await Promise.all([client.close(), server.close()]);
  });
});
