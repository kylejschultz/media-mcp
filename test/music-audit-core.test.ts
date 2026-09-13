import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  aggregateMusicAudit,
  musicAuditConfig,
  readOnlyMountFor,
  scanMusicLibrary,
  type AuditedTrack,
  type ArtworkAudit,
} from "../src/music-audit.js";

describe("music audit configuration and safety", () => {
  it("uses documented defaults and validates bounded knobs", () => {
    assert.deepEqual(musicAuditConfig({}), {
      enabled: false,
      artworkPreviewEnabled: false,
      root: "/music-library",
      cacheDir: "/config/music-audit",
      lowResolutionThreshold: 600,
      concurrency: 4,
      cooldownSeconds: 300,
      maxFiles: 100_000,
      maxImageBytes: 32 * 1024 * 1024,
    });
    assert.throws(() => musicAuditConfig({ MUSIC_AUDIT_ENABLED: "yes" }), /must be true or false/);
    assert.throws(() => musicAuditConfig({ MUSIC_AUDIT_CONCURRENCY: "17" }), /1 to 16/);
    assert.throws(() => musicAuditConfig({ MUSIC_AUDIT_LOW_RESOLUTION_PX: "99" }), /100 to 10000/);
    assert.throws(() => musicAuditConfig({ MUSIC_AUDIT_COOLDOWN_SECONDS: "86401" }), /0 to 86400/);
    assert.throws(() => musicAuditConfig({ MUSIC_AUDIT_MAX_FILES: "0" }), /1 to 1000000/);
    assert.throws(() => musicAuditConfig({ MUSIC_AUDIT_MAX_IMAGE_BYTES: "100" }), /1024 to 1073741824/);
  });

  it("uses the most specific mount and requires explicit ro", () => {
    const mountInfo = [
      "1 0 0:1 / / rw,relatime - overlay overlay rw",
      "2 1 0:2 / /music-library ro,nosuid - bind /host/music ro",
      "3 2 0:3 / /music-library/writable rw - bind /host/writable rw",
    ].join("\n");
    assert.deepEqual(readOnlyMountFor("/music-library/Artist", mountInfo), {
      verified: true,
      rootReadOnly: true,
      mountPoint: "/music-library",
      options: ["nosuid", "ro"],
      writableDescendantMounts: [],
    });
    assert.equal(readOnlyMountFor("/music-library/writable/Album", mountInfo).verified, false);
    assert.deepEqual(readOnlyMountFor("/music-library", mountInfo).writableDescendantMounts, ["/music-library/writable"]);
    assert.equal(readOnlyMountFor("/music-library", mountInfo).verified, false);
    assert.equal(readOnlyMountFor("/not-mounted", "").verified, false);
    assert.equal(readOnlyMountFor("/music-library", "2 1 0:2 / /music-library rw - bind /host/music ro").verified, false);
  });
});

describe("music audit grouping and objective findings", () => {
  const embedded = (sha256: string, size = 1200): ArtworkAudit => ({ source: "embedded", readable: true, sha256, width: size, height: size, mime: "image/jpeg" });
  const track = (overrides: Partial<AuditedTrack>): AuditedTrack => ({
    path: "Artist/Album/01.flac",
    directory: "Artist/Album",
    album: "Album",
    albumArtist: "Artist",
    year: 2026,
    genres: ["Rock"],
    embeddedArt: [embedded("a")],
    ...overrides,
  });

  it("prefers MusicBrainz grouping, then metadata, then directory", () => {
    const tracks = [
      track({ path: "Disc 1/01.flac", directory: "Disc 1", musicBrainzReleaseId: "release-1" }),
      track({ path: "Disc 2/02.flac", directory: "Disc 2", musicBrainzReleaseId: "RELEASE-1" }),
      track({ path: "Else/01.flac", directory: "Else", album: undefined, albumArtist: undefined, embeddedArt: [], genres: [] }),
    ];
    const result = aggregateMusicAudit(tracks, new Map(), 600);
    assert.equal(result.albums.length, 2);
    assert.equal(result.albums.find((album) => album.keySource === "musicbrainz")?.tracks.length, 2);
    assert.equal(result.albums.find((album) => album.keySource === "directory")?.directories[0], "Else");
    assert.ok(result.albums.every((album) => /^alb_[a-f0-9]{24}$/.test(album.id)));
  });

  it("reports objective issues separately from review candidates", () => {
    const tracks = [
      track({ embeddedArt: [embedded("embedded-a", 400)], genres: ["Rock"] }),
      track({ path: "Artist/Album/02.flac", embeddedArt: [embedded("embedded-b")], genres: ["Pop"] }),
    ];
    const sidecars = new Map([["Artist/Album", [
      { source: "sidecar" as const, filename: "Artist/Album/cover.jpg", readable: true, sha256: "sidecar", width: 1200, height: 1200 },
      { source: "sidecar" as const, filename: "Artist/Album/folder.jpg", readable: false, error: "bad image" },
    ]]]);
    const result = aggregateMusicAudit(tracks, sidecars, 600);
    const types = new Set(result.issues.map((item) => item.type));
    for (const expected of ["art_low_resolution", "art_unreadable", "art_embedded_inconsistent", "art_multiple_sidecars", "genre_inconsistent_within_album", "art_embedded_sidecar_mismatch_candidate", "genre_broad_only_candidate"]) assert.ok(types.has(expected as any), expected);
    assert.equal(result.issues.find((item) => item.type === "art_embedded_sidecar_mismatch_candidate")?.severity, "candidate");
    assert.equal(result.issues.find((item) => item.type === "art_unreadable")?.severity, "issue");
  });

  it("treats blank genre strings as missing without changing nonblank raw values", () => {
    const result = aggregateMusicAudit([
      track({ genres: ["", " \t ", "Jazz; Blues"] }),
      track({ path: "Artist/Album/02.flac", genres: ["  "] }),
    ], new Map(), 600);
    assert.deepEqual(result.albums[0]!.genres, ["Jazz; Blues"]);
    assert.deepEqual(result.albums[0]!.tracks[0]!.genres, ["Jazz; Blues"]);
    assert.deepEqual(result.albums[0]!.tracks[1]!.genres, []);
    assert.equal(result.issues.find((item) => item.type === "genre_missing")?.summary, "1 track(s) have no genre");
  });
});

describe("music audit filesystem traversal", () => {
  it("skips symlinked files and directories", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "music-audit-walk-"));
    const root = path.join(temp, "root");
    const outside = path.join(temp, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, "outside.mp3"), "not audio");
    await symlink(path.join(outside, "outside.mp3"), path.join(root, "linked.mp3"));
    await symlink(outside, path.join(root, "linked-directory"));
    const phases: string[] = [];
    const snapshot = await scanMusicLibrary({ enabled: true, artworkPreviewEnabled: false, root, cacheDir: path.join(temp, "cache"), lowResolutionThreshold: 600, concurrency: 2, cooldownSeconds: 300, maxFiles: 100_000, maxImageBytes: 32 * 1024 * 1024 }, "scan", new Date().toISOString(), (progress) => phases.push(progress.phase));
    assert.deepEqual(phases, ["discovering", "sidecars", "tracks", "aggregating", "completed"]);
    assert.deepEqual(snapshot.progress, { phase: "completed", discoveredAudio: 0, discoveredImages: 0, processedAudio: 0, processedImages: 0, failedMetadata: 0, failedImages: 0 });
    assert.equal(snapshot.summary.tracks, 0);
    assert.equal(snapshot.summary.albums, 0);
    assert.doesNotMatch(JSON.stringify(snapshot), /outside\.mp3/);
    await assert.rejects(readFile(path.join(temp, "cache", "snapshot.json")));
  });

  it("aborts discovery at the configured file limit and records oversized artwork without hashing it", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "music-audit-limits-"));
    await writeFile(path.join(temp, "one.mp3"), "not audio");
    await writeFile(path.join(temp, "two.mp3"), "not audio");
    const config = { enabled: true, artworkPreviewEnabled: false, root: temp, cacheDir: path.join(temp, "cache"), lowResolutionThreshold: 600, concurrency: 2, cooldownSeconds: 300, maxFiles: 1, maxImageBytes: 1024 };
    await assert.rejects(scanMusicLibrary(config, "limited", new Date().toISOString()), /file limit exceeded/);

    await writeFile(path.join(temp, "two.mp3"), "ignored");
    await writeFile(path.join(temp, "cover.jpg"), Buffer.alloc(1025));
    const snapshot = await scanMusicLibrary({ ...config, maxFiles: 3 }, "oversized", new Date().toISOString());
    assert.equal(snapshot.progress.failedImages, 1);
    assert.ok(snapshot.warnings.some((warning) => warning.includes("exceeds 1024 byte limit")));
    assert.doesNotMatch(snapshot.warnings.join("\n"), new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("turns a whitespace-only scanned genre into genre_missing", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "music-audit-blank-genre-"));
    const frameBody = Buffer.from([0, ...Buffer.from("   ")]);
    const frameHeader = Buffer.alloc(10);
    frameHeader.write("TCON", 0, "ascii");
    frameHeader.writeUInt32BE(frameBody.length, 4);
    const tagBody = Buffer.concat([frameHeader, frameBody]);
    const tagSize = Buffer.from([(tagBody.length >>> 21) & 0x7f, (tagBody.length >>> 14) & 0x7f, (tagBody.length >>> 7) & 0x7f, tagBody.length & 0x7f]);
    await writeFile(path.join(temp, "blank.mp3"), Buffer.concat([Buffer.from("ID3\x03\x00\x00", "binary"), tagSize, tagBody]));
    const result = await scanMusicLibrary({ enabled: true, artworkPreviewEnabled: false, root: temp, cacheDir: path.join(temp, "cache"), lowResolutionThreshold: 600, concurrency: 1, cooldownSeconds: 0, maxFiles: 10, maxImageBytes: 1024 * 1024 }, "blank", new Date().toISOString());
    assert.deepEqual(result.albums[0]!.tracks[0]!.genres, []);
    assert.equal(result.summary.byType.genre_missing, 1);
  });
});
