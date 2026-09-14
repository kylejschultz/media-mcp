import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getApp } from "./config.js";
import { beetsRemediationPost } from "./http.js";
import { MusicAuditService, musicAudit } from "./music-audit.js";
import { requireBeetsFlaskWriteEnabled } from "./safety.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const manifestId = z.string().regex(/^mrm_[a-f0-9]{24}$/);
const transactionId = z.string().regex(/^[a-f0-9]{32}$/);
const relativePath = z.string().min(1).max(1024).refine(
  (value) => !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "Expected a canonical relative path",
);
const releaseId = z.string().uuid();

const track = z.object({
  path: relativePath,
  expected_file_sha256: sha256,
  expected_embedded_sha256: z.array(sha256).max(8),
}).strict();

const sidecar = z.object({ path: relativePath, expected_sha256: sha256 }).strict();

const caaArt = z.object({
  source: z.literal("caa"),
  url: z.string().regex(/^https:\/\/coverartarchive\.org\/release\/[a-f0-9-]{36}\/[0-9]+\.(jpg|png)$/i),
  expected_sha256: sha256,
}).strict();

const localArt = z.object({ source: z.literal("sidecar"), path: relativePath, expected_sha256: sha256 }).strict();

const album = z.object({
  album_id: z.string().regex(/^alb_[a-f0-9]{24}$/),
  album_path: relativePath,
  musicbrainz_release_id: releaseId,
  tracks: z.array(track).min(1).max(50),
  sidecar,
  genres: z.array(z.string().min(1).max(100)).min(1).max(2),
  art: z.discriminatedUnion("source", [caaArt, localArt]),
}).strict();

export const musicRemediationManifestSchema = z.object({
  schema: z.literal("music-remediation-manifest.v1"),
  snapshot_id: z.string().uuid(),
  albums: z.array(album).min(1).max(10),
}).strict().superRefine((manifest, context) => {
  const albumIds = new Set<string>();
  const trackPaths = new Set<string>();
  let trackCount = 0;
  for (const [albumIndex, entry] of manifest.albums.entries()) {
    if (albumIds.has(entry.album_id)) context.addIssue({ code: "custom", path: ["albums", albumIndex, "album_id"], message: "Album IDs must be unique" });
    albumIds.add(entry.album_id);
    const expectedAlbumId = `alb_${createHash("sha256").update(`mb:${entry.musicbrainz_release_id.toLowerCase()}`).digest("hex").slice(0, 24)}`;
    if (entry.album_id !== expectedAlbumId) context.addIssue({ code: "custom", path: ["albums", albumIndex, "album_id"], message: "Album ID must match the MusicBrainz release" });
    if (entry.art.source === "caa") {
      if (entry.art.url.split("/")[4]?.toLowerCase() !== entry.musicbrainz_release_id.toLowerCase()) context.addIssue({ code: "custom", path: ["albums", albumIndex, "art", "url"], message: "CAA URL release must match musicbrainz_release_id" });
    } else if (entry.art.path !== entry.sidecar.path || entry.art.expected_sha256 !== entry.sidecar.expected_sha256) {
      context.addIssue({ code: "custom", path: ["albums", albumIndex, "art"], message: "Local art must match the reviewed sidecar" });
    }
    for (const [trackIndex, item] of entry.tracks.entries()) {
      trackCount += 1;
      if (!item.path.startsWith(`${entry.album_path}/`)) context.addIssue({ code: "custom", path: ["albums", albumIndex, "tracks", trackIndex, "path"], message: "Track must be below album_path" });
      if (!/\.(flac|mp3|m4a)$/i.test(item.path)) context.addIssue({ code: "custom", path: ["albums", albumIndex, "tracks", trackIndex, "path"], message: "Only FLAC, MP3, and M4A tracks are supported" });
      if (trackPaths.has(item.path)) context.addIssue({ code: "custom", path: ["albums", albumIndex, "tracks", trackIndex, "path"], message: "Track paths must be unique" });
      trackPaths.add(item.path);
    }
    if (!entry.sidecar.path.startsWith(`${entry.album_path}/`) || !/\.(jpe?g|png)$/i.test(entry.sidecar.path)) context.addIssue({ code: "custom", path: ["albums", albumIndex, "sidecar", "path"], message: "Sidecar must be a JPEG or PNG below album_path" });
  }
  if (trackCount > 250) context.addIssue({ code: "custom", path: ["albums"], message: "Manifest may contain at most 250 tracks" });
});
export type MusicRemediationManifest = z.infer<typeof musicRemediationManifestSchema>;

export const musicRemediationEnvelopeSchema = z.object({
  schema: z.literal("music-remediation-stored-manifest.v1"),
  manifest_id: manifestId,
  digest: sha256,
  signature: sha256,
  manifest: musicRemediationManifestSchema,
}).strict();
export type MusicRemediationEnvelope = z.infer<typeof musicRemediationEnvelopeSchema>;

const reviewedCaa = z.object({ source: z.literal("caa"), url: caaArt.shape.url, expected_sha256: sha256 }).strict();
const reviewedSidecar = z.object({ source: z.literal("sidecar"), expected_sha256: sha256 }).strict();
export const musicRemediationPreparationSchema = z.object({
  albums: z.array(z.object({
    albumId: z.string().regex(/^alb_[a-f0-9]{24}$/),
    genres: z.array(z.string().min(1).max(100)).min(1).max(2),
    art: z.discriminatedUnion("source", [reviewedCaa, reviewedSidecar]),
  }).strict()).min(1).max(10),
}).strict();
export type MusicRemediationPreparation = z.infer<typeof musicRemediationPreparationSchema>;

const finalizeTrack = z.object({ path: relativePath, file_sha256: sha256, embedded_sha256: z.array(sha256).max(8), genres: z.array(z.string().min(1).max(100)).max(16) }).strict();
const finalizeAlbum = z.object({ album_id: z.string().regex(/^alb_[a-f0-9]{24}$/), tracks: z.array(finalizeTrack).min(1).max(50), sidecar: z.object({ path: relativePath, sha256 }).strict() }).strict();
const finalizeStateSchema = z.object({
  ok: z.literal(true).optional(),
  schema: z.literal("beets-flask-remediation.finalize-state.v1"),
  transaction_id: transactionId,
  status: z.enum(["applied", "rolled_back", "failed_restored", "finalizing", "finalized"]),
  manifest_snapshot_id: z.string().uuid(),
  expected_state: z.array(finalizeAlbum).min(1).max(10),
}).strict();
const finalizeAttestationSchema = z.object({
  schema: z.literal("music-remediation-finalize-attestation.v1"),
  transaction_id: transactionId,
  manifest_snapshot_id: z.string().uuid(),
  post_audit_scan_id: z.string().uuid(),
  albums: z.array(finalizeAlbum).min(1).max(10),
}).strict();

function token() {
  const value = process.env.BEETS_FLASK_REMEDIATION_TOKEN;
  if (!value) throw new Error("beets-flask remediation is missing BEETS_FLASK_REMEDIATION_TOKEN");
  return value;
}

function manifestKey() {
  const value = process.env.BEETS_REMEDIATION_MANIFEST_HMAC_KEY;
  if (!value || value.length < 32) throw new Error("music remediation is missing a 32-character BEETS_REMEDIATION_MANIFEST_HMAC_KEY");
  return value;
}

function approvedGenres() {
  const raw = process.env.BEETS_REMEDIATION_GENRES_JSON;
  if (!raw) throw new Error("music remediation is missing BEETS_REMEDIATION_GENRES_JSON");
  const values = JSON.parse(raw);
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) throw new Error("BEETS_REMEDIATION_GENRES_JSON must be a JSON string array");
  return new Set<string>(values);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function secureEqual(left: string, right: string) {
  return /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

async function post<T>(route: string, body: unknown) {
  const result = await beetsRemediationPost<T & { ok?: boolean; error?: string }>(getApp("beets-flask"), route, token(), body);
  if (result.ok === false) throw new Error(result.error || "beets-flask remediation failed closed");
  return result;
}

export class MusicRemediationService {
  constructor(
    private readonly audit: MusicAuditService = musicAudit,
    private readonly storeDir = path.resolve(process.env.MUSIC_REMEDIATION_CACHE_DIR ?? "/config/music-remediation"),
  ) {}

  artDigest(musicbrainzReleaseId: string, url: string) {
    return post<{ sha256: string; bytes: number; width: number; height: number; format: string }>("art-digest", { musicbrainz_release_id: musicbrainzReleaseId, url });
  }

  async prepare(input: MusicRemediationPreparation) {
    const decisions = musicRemediationPreparationSchema.parse(input);
    const allowedGenres = approvedGenres();
    if (decisions.albums.some((album) => album.genres.some((genre) => !allowedGenres.has(genre)))) throw new Error("Preparation includes a genre outside BEETS_REMEDIATION_GENRES_JSON");
    const snapshot = await this.audit.remediationSnapshot();
    const ids = decisions.albums.map((item) => item.albumId);
    if (new Set(ids).size !== ids.length) throw new Error("Preparation album IDs must be unique");
    const albums: MusicRemediationManifest["albums"] = [];
    let trackCount = 0;
    for (const decision of decisions.albums) {
      const audited = snapshot.albums.find((item) => item.id === decision.albumId);
      if (!audited) throw new Error(`Album ${decision.albumId} is not in the latest snapshot`);
      if (!audited.musicBrainzReleaseId || audited.directories.length !== 1) throw new Error(`Album ${decision.albumId} lacks one exact MusicBrainz release/directory`);
      if (audited.sidecars.length !== 1 || !audited.sidecars[0]?.filename || !audited.sidecars[0].sha256 || !/\.(jpe?g|png)$/i.test(audited.sidecars[0].filename)) throw new Error(`Album ${decision.albumId} must have exactly one supported hashed sidecar`);
      if (audited.tracks.length < 1 || audited.tracks.length > 50) throw new Error(`Album ${decision.albumId} has an unsupported track count`);
      trackCount += audited.tracks.length;
      if (trackCount > 250) throw new Error("Preparation exceeds 250 tracks");
      const sidecarHash = await this.audit.remediationFileSha256(audited.sidecars[0].filename);
      if (sidecarHash !== audited.sidecars[0].sha256) throw new Error(`Album ${decision.albumId} sidecar changed since the snapshot`);
      let art: MusicRemediationManifest["albums"][number]["art"];
      if (decision.art.source === "caa") {
        const digest = await this.artDigest(audited.musicBrainzReleaseId, decision.art.url);
        if (digest.sha256 !== decision.art.expected_sha256) throw new Error(`Album ${decision.albumId} CAA bytes do not match the reviewed hash`);
        art = { source: "caa", url: decision.art.url, expected_sha256: decision.art.expected_sha256 };
      } else {
        if (decision.art.expected_sha256 !== sidecarHash) throw new Error(`Album ${decision.albumId} reviewed sidecar hash is stale`);
        art = { source: "sidecar", path: audited.sidecars[0].filename, expected_sha256: sidecarHash };
      }
      const tracks = [];
      for (const auditedTrack of audited.tracks) {
        if (!/\.(flac|mp3|m4a)$/i.test(auditedTrack.path)) throw new Error(`Album ${decision.albumId} contains an unsupported track format`);
        const embedded = auditedTrack.embeddedArt.map((item) => item.sha256);
        if (embedded.some((item) => !item) || embedded.length > 8) throw new Error(`Album ${decision.albumId} lacks exact bounded embedded hashes`);
        tracks.push({
          path: auditedTrack.path,
          expected_file_sha256: await this.audit.remediationFileSha256(auditedTrack.path),
          expected_embedded_sha256: embedded as string[],
        });
      }
      albums.push({
        album_id: audited.id,
        album_path: audited.directories[0]!,
        musicbrainz_release_id: audited.musicBrainzReleaseId.toLowerCase(),
        tracks,
        sidecar: { path: audited.sidecars[0].filename, expected_sha256: sidecarHash },
        genres: decision.genres,
        art,
      });
    }
    const manifest = musicRemediationManifestSchema.parse({ schema: "music-remediation-manifest.v1", snapshot_id: snapshot.scanId, albums });
    const envelope = this.sign(manifest);
    await this.store(envelope);
    return {
      schema: "media-mcp.music-remediation-preparation.v1",
      manifestId: envelope.manifest_id,
      digest: envelope.digest,
      snapshotId: snapshot.scanId,
      albumCount: albums.length,
      trackCount,
      writesLibrary: false,
    };
  }

  async preview(id: string) {
    return post("preview", { manifest: await this.load(id) });
  }

  async apply(id: string, operationId: string) {
    requireBeetsFlaskWriteEnabled();
    transactionId.parse(operationId);
    return post("apply", { manifest: await this.load(id), operation_id: operationId });
  }

  rollback(id: string) {
    requireBeetsFlaskWriteEnabled();
    return post("rollback", { transaction_id: transactionId.parse(id) });
  }

  async finalize(id: string) {
    requireBeetsFlaskWriteEnabled();
    const txId = transactionId.parse(id);
    const expected = finalizeStateSchema.parse(await post("finalize-state", { transaction_id: txId }));
    if (expected.transaction_id !== txId) throw new Error("Overlay finalize state transaction does not match");
    if (expected.status === "finalized") return post("finalize", { transaction_id: txId, attestation: null, signature: null });
    if (expected.status === "finalizing") return post("finalize", { transaction_id: txId, attestation: null, signature: null });
    const snapshot = await this.audit.remediationSnapshot();
    if (snapshot.scanId === expected.manifest_snapshot_id) throw new Error("Post-audit scan ID must differ from the pre-write scan");
    const snapshotAlbums = new Map(snapshot.albums.map((item) => [item.id, item]));
    if (snapshotAlbums.size !== snapshot.albums.length) throw new Error("Post-audit snapshot contains duplicate album IDs");
    if (new Set(expected.expected_state.map((item) => item.album_id)).size !== expected.expected_state.length) throw new Error("Overlay finalize state contains duplicate album IDs");
    const albums = [];
    for (const expectedAlbum of expected.expected_state) {
      const audited = snapshotAlbums.get(expectedAlbum.album_id);
      if (!audited) throw new Error("Post-audit snapshot does not contain the exact transaction albums");
      const tracks = new Map(audited.tracks.map((item) => [item.path, item]));
      if (tracks.size !== audited.tracks.length || tracks.size !== expectedAlbum.tracks.length || expectedAlbum.tracks.some((item) => !tracks.has(item.path))) {
        throw new Error("Post-audit snapshot track set does not exactly match the transaction");
      }
      if (audited.sidecars.length !== 1 || audited.sidecars[0]?.filename !== expectedAlbum.sidecar.path || !audited.sidecars[0].sha256) {
        throw new Error("Post-audit snapshot sidecar does not exactly match the transaction");
      }
      const derivedTracks = [];
      for (const expectedTrack of expectedAlbum.tracks) {
        const auditedTrack = tracks.get(expectedTrack.path)!;
        const embedded = auditedTrack.embeddedArt.map((item) => item.sha256);
        if (embedded.some((item) => !item)) throw new Error("Post-audit snapshot lacks exact embedded artwork hashes");
        derivedTracks.push({
          path: auditedTrack.path,
          file_sha256: await this.audit.remediationFileSha256(auditedTrack.path),
          embedded_sha256: embedded as string[],
          genres: auditedTrack.genres,
        });
      }
      albums.push({
        album_id: audited.id,
        tracks: derivedTracks,
        sidecar: {
          path: audited.sidecars[0].filename,
          sha256: await this.audit.remediationFileSha256(audited.sidecars[0].filename),
        },
      });
    }
    const derived = finalizeAttestationSchema.parse({
      schema: "music-remediation-finalize-attestation.v1",
      transaction_id: txId,
      manifest_snapshot_id: expected.manifest_snapshot_id,
      post_audit_scan_id: snapshot.scanId,
      albums,
    });
    if (canonical(derived.albums) !== canonical(expected.expected_state)) throw new Error("Post-audit snapshot does not exactly match the transaction finalize state");
    const signature = createHmac("sha256", manifestKey()).update(canonical(derived)).digest("hex");
    return post("finalize", { transaction_id: txId, attestation: derived, signature });
  }

  transaction(id?: string, recover = false) {
    if (recover) requireBeetsFlaskWriteEnabled();
    return post(recover ? "recover" : "status", recover ? { transaction_id: transactionId.parse(id) } : id ? { transaction_id: transactionId.parse(id) } : {});
  }

  private sign(manifest: MusicRemediationManifest): MusicRemediationEnvelope {
    const bytes = canonical(manifest);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const signature = createHmac("sha256", manifestKey()).update(bytes).digest("hex");
    return { schema: "music-remediation-stored-manifest.v1", manifest_id: `mrm_${digest.slice(0, 24)}`, digest, signature, manifest };
  }

  private async store(envelope: MusicRemediationEnvelope) {
    await mkdir(this.storeDir, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.storeDir, `.${envelope.manifest_id}.${randomUUID()}.tmp`);
    const destination = path.join(this.storeDir, `${envelope.manifest_id}.json`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(envelope));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    const directory = await open(this.storeDir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async load(id: string) {
    manifestId.parse(id);
    const file = path.join(this.storeDir, `${id}.json`);
    const fileStat = await lstat(file);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("Stored remediation manifest is not a regular file");
    await access(file, fsConstants.R_OK);
    const envelope = musicRemediationEnvelopeSchema.parse(JSON.parse(await readFile(file, "utf8")));
    const bytes = canonical(envelope.manifest);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const signature = createHmac("sha256", manifestKey()).update(bytes).digest("hex");
    if (envelope.manifest_id !== id || envelope.manifest_id !== `mrm_${digest.slice(0, 24)}` || !secureEqual(envelope.digest, digest) || !secureEqual(envelope.signature, signature)) throw new Error("Stored remediation manifest signature or digest is invalid");
    const snapshot = await this.audit.remediationSnapshot();
    if (snapshot.scanId !== envelope.manifest.snapshot_id) throw new Error("Stored remediation manifest is not bound to the latest snapshot");
    for (const album of envelope.manifest.albums) {
      const audited = snapshot.albums.find((item) => item.id === album.album_id);
      if (!audited || audited.musicBrainzReleaseId?.toLowerCase() !== album.musicbrainz_release_id || audited.directories.length !== 1 || audited.directories[0] !== album.album_path) throw new Error("Stored remediation manifest no longer matches the current snapshot album identity");
      if (audited.sidecars.length !== 1 || audited.sidecars[0]?.filename !== album.sidecar.path || audited.sidecars[0].sha256 !== album.sidecar.expected_sha256) throw new Error("Stored remediation manifest no longer matches the current snapshot sidecar");
      const tracks = new Map(audited.tracks.map((item) => [item.path, item]));
      if (tracks.size !== album.tracks.length) throw new Error("Stored remediation manifest no longer matches the current snapshot track set");
      for (const item of album.tracks) {
        const auditedTrack = tracks.get(item.path);
        const embedded = auditedTrack?.embeddedArt.map((art) => art.sha256);
        if (!auditedTrack || embedded?.some((hash) => !hash) || JSON.stringify(embedded) !== JSON.stringify(item.expected_embedded_sha256)) throw new Error("Stored remediation manifest no longer matches the current snapshot track metadata");
        if (await this.audit.remediationFileSha256(item.path) !== item.expected_file_sha256) throw new Error("Stored remediation track bytes changed after preparation");
      }
      if (await this.audit.remediationFileSha256(album.sidecar.path) !== album.sidecar.expected_sha256) throw new Error("Stored remediation sidecar bytes changed after preparation");
    }
    return envelope;
  }
}
