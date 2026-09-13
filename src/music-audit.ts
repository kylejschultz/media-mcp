import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { disableTypes, imageSize, types as imageTypes } from "image-size";
import { parseFile } from "music-metadata";
import { toSummary } from "./results.js";
import { mediaView, viewState, withViewState } from "./views.js";

export const MUSIC_AUDIT_SCHEMA_VERSION = 1;
const AUDIO_EXTENSIONS = new Set([".aac", ".aif", ".aiff", ".ape", ".flac", ".m4a", ".m4b", ".mp3", ".mp4", ".mpc", ".oga", ".ogg", ".opus", ".wav", ".wma"]);
const IMAGE_EXTENSIONS = new Set([".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const BROAD_GENRES = new Set(["alternative", "blues", "classical", "country", "dance", "electronic", "folk", "hip hop", "jazz", "metal", "pop", "r&b", "rap", "reggae", "rock", "soundtrack"]);
const SUPPORTED_IMAGE_TYPES = new Set(["bmp", "gif", "jpg", "png", "webp"]);
// Disable ICNS/JXL/HEIF and every unsupported parser to mitigate image-size's published infinite-loop advisories.
disableTypes(imageTypes.filter((type) => !SUPPORTED_IMAGE_TYPES.has(type)));

export type MusicAuditConfig = {
  enabled: boolean;
  root: string;
  cacheDir: string;
  lowResolutionThreshold: number;
  concurrency: number;
  cooldownSeconds: number;
  maxFiles: number;
  maxImageBytes: number;
};

export const MUSIC_AUDIT_ISSUE_TYPES = [
  "art_missing",
  "art_embedded_only",
  "art_sidecar_only",
  "art_low_resolution",
  "art_unreadable",
  "art_embedded_inconsistent",
  "art_multiple_sidecars",
  "genre_missing",
  "genre_inconsistent_within_album",
  "art_embedded_sidecar_mismatch_candidate",
  "genre_broad_only_candidate",
] as const;
export type MusicAuditIssueType = (typeof MUSIC_AUDIT_ISSUE_TYPES)[number];

export type ArtworkAudit = {
  source: "embedded" | "sidecar";
  filename?: string;
  mime?: string;
  width?: number;
  height?: number;
  sha256?: string;
  readable: boolean;
  error?: string;
};

export type AuditedTrack = {
  path: string;
  directory: string;
  title?: string;
  track?: { no?: number; of?: number; disk?: number };
  album?: string;
  albumArtist?: string;
  artist?: string;
  year?: number;
  genres: string[];
  musicBrainzReleaseId?: string;
  embeddedArt: ArtworkAudit[];
  metadataError?: string;
};

export type MusicAuditIssue = {
  id: string;
  albumId: string;
  type: MusicAuditIssueType;
  severity: "issue" | "candidate";
  summary: string;
  paths?: string[];
};

export type AuditedAlbum = {
  id: string;
  keySource: "musicbrainz" | "metadata" | "directory";
  musicBrainzReleaseId?: string;
  album?: string;
  albumArtist?: string;
  year?: number;
  directories: string[];
  genres: string[];
  tracks: AuditedTrack[];
  sidecars: ArtworkAudit[];
  issueIds: string[];
};

export type MusicAuditSnapshot = {
  schemaVersion: number;
  scanId: string;
  status: "completed";
  startedAt: string;
  completedAt: string;
  root: string;
  thresholds: { lowResolutionPx: number };
  progress: MusicAuditProgress;
  summary: {
    tracks: number;
    albums: number;
    issues: number;
    candidates: number;
    byType: Partial<Record<MusicAuditIssueType, number>>;
  };
  albums: AuditedAlbum[];
  issues: MusicAuditIssue[];
  warnings: string[];
  errors: string[];
};

export type MusicAuditProgress = {
  phase: "discovering" | "sidecars" | "tracks" | "aggregating" | "completed";
  discoveredAudio?: number;
  discoveredImages?: number;
  processedAudio: number;
  processedImages: number;
  failedMetadata: number;
  failedImages: number;
};

type ScanState = {
  schemaVersion: number;
  scanId?: string;
  status: "idle" | "running" | "completed" | "failed" | "interrupted";
  startedAt?: string;
  completedAt?: string;
  summary?: MusicAuditSnapshot["summary"];
  progress?: MusicAuditProgress;
  warnings: string[];
  errors: string[];
};

type SidecarsByDirectory = Map<string, ArtworkAudit[]>;
type AuditDeps = {
  mountInfoPath?: string;
  scanner?: (config: MusicAuditConfig, scanId: string, startedAt: string, onProgress?: (progress: MusicAuditProgress) => void) => Promise<MusicAuditSnapshot>;
};

function envInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function musicAuditConfig(env: NodeJS.ProcessEnv = process.env): MusicAuditConfig {
  const enabledRaw = (env.MUSIC_AUDIT_ENABLED ?? "false").toLowerCase();
  if (enabledRaw !== "true" && enabledRaw !== "false") throw new Error("MUSIC_AUDIT_ENABLED must be true or false");
  const root = path.resolve(env.MUSIC_AUDIT_ROOT ?? "/music-library");
  const cacheDir = path.resolve(env.MUSIC_AUDIT_CACHE_DIR ?? "/config/music-audit");
  return {
    enabled: enabledRaw === "true",
    root,
    cacheDir,
    lowResolutionThreshold: envInteger(env, "MUSIC_AUDIT_LOW_RESOLUTION_PX", 600, 100, 10_000),
    concurrency: envInteger(env, "MUSIC_AUDIT_CONCURRENCY", 4, 1, 16),
    cooldownSeconds: envInteger(env, "MUSIC_AUDIT_COOLDOWN_SECONDS", 300, 0, 86_400),
    maxFiles: envInteger(env, "MUSIC_AUDIT_MAX_FILES", 100_000, 1, 1_000_000),
    maxImageBytes: envInteger(env, "MUSIC_AUDIT_MAX_IMAGE_BYTES", 32 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
  };
}

function unescapeMountPath(value: string) {
  return value.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\012/g, "\n").replace(/\\134/g, "\\");
}

export function readOnlyMountFor(root: string, mountInfo: string) {
  const resolved = path.resolve(root);
  const mounts = mountInfo.split("\n").flatMap((line) => {
    const separator = line.indexOf(" - ");
    if (separator < 0) return [];
    const before = line.slice(0, separator).split(" ");
    const after = line.slice(separator + 3).split(" ");
    if (before.length < 6 || after.length < 3) return [];
    return [{ mountPoint: unescapeMountPath(before[4]!), options: new Set(before[5]!.split(",")) }];
  });
  const ancestors = mounts.filter(({ mountPoint }) => resolved === mountPoint || resolved.startsWith(`${mountPoint.replace(/\/$/, "")}/`));
  ancestors.sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  const mount = ancestors[0];
  const writableDescendantMounts = mounts
    .filter(({ mountPoint, options }) => mountPoint.startsWith(`${resolved.replace(/\/$/, "")}/`) && !options.has("ro"))
    .map(({ mountPoint }) => mountPoint)
    .sort();
  const rootReadOnly = mount?.options.has("ro") ?? false;
  return mount ? {
    verified: rootReadOnly && writableDescendantMounts.length === 0,
    rootReadOnly,
    mountPoint: mount.mountPoint,
    options: [...mount.options].sort(),
    writableDescendantMounts,
  } : { verified: false, rootReadOnly: false, writableDescendantMounts };
}

function normalized(value?: string) {
  return value?.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ") || undefined;
}

function albumKey(track: AuditedTrack) {
  if (track.musicBrainzReleaseId) return { source: "musicbrainz" as const, key: `mb:${normalized(track.musicBrainzReleaseId)}` };
  if (track.album && track.albumArtist) return { source: "metadata" as const, key: `meta:${normalized(track.albumArtist)}|${normalized(track.album)}|${track.year ?? ""}` };
  return { source: "directory" as const, key: `dir:${normalized(track.directory) ?? "."}` };
}

function opaqueId(prefix: string, value: string) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function issue(albumId: string, type: MusicAuditIssueType, summary: string, paths?: string[]): MusicAuditIssue {
  const severity = type.endsWith("_candidate") ? "candidate" : "issue";
  return { id: opaqueId("iss", `${albumId}|${type}|${summary}`), albumId, type, severity, summary, ...(paths?.length ? { paths: [...new Set(paths)].sort() } : {}) };
}

export function aggregateMusicAudit(tracks: AuditedTrack[], sidecarsByDirectory: SidecarsByDirectory, lowResolutionThreshold: number) {
  const groups = new Map<string, { source: AuditedAlbum["keySource"]; tracks: AuditedTrack[] }>();
  for (const track of tracks) {
    const grouping = albumKey(track);
    const group = groups.get(grouping.key) ?? { source: grouping.source, tracks: [] };
    group.tracks.push(track);
    groups.set(grouping.key, group);
  }

  const albums: AuditedAlbum[] = [];
  const issues: MusicAuditIssue[] = [];
  for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    group.tracks.sort((a, b) => a.path.localeCompare(b.path));
    const first = group.tracks[0]!;
    const albumId = opaqueId("alb", key);
    const directories = [...new Set(group.tracks.map((track) => track.directory))].sort();
    const sidecars = directories.flatMap((directory) => sidecarsByDirectory.get(directory) ?? []).sort((a, b) => (a.filename ?? "").localeCompare(b.filename ?? ""));
    const metadataReadableTracks = group.tracks.filter((track) => !track.metadataError);
    const embedded = metadataReadableTracks.flatMap((track) => track.embeddedArt);
    const hashedEmbedded = embedded.filter((art) => art.sha256);
    const hashedSidecars = sidecars.filter((art) => art.sha256);
    const albumIssues: MusicAuditIssue[] = [];
    const add = (type: MusicAuditIssueType, summary: string, paths?: string[]) => albumIssues.push(issue(albumId, type, summary, paths));

    if (metadataReadableTracks.length === group.tracks.length && embedded.length === 0 && sidecars.length === 0) add("art_missing", "No embedded or sidecar artwork found", group.tracks.map((track) => track.path));
    else if (embedded.length > 0 && sidecars.length === 0) add("art_embedded_only", "Artwork exists only in embedded tags");
    else if (metadataReadableTracks.length === group.tracks.length && embedded.length === 0 && sidecars.length > 0) add("art_sidecar_only", "Artwork exists only as sidecar files");
    if ([...embedded, ...sidecars].some((art) => !art.readable)) add("art_unreadable", "One or more artwork files could not be read", sidecars.filter((art) => !art.readable).map((art) => art.filename!).filter(Boolean));
    const lowResolution = [...embedded, ...sidecars].filter((art) => art.readable && art.width !== undefined && art.height !== undefined && Math.min(art.width, art.height) < lowResolutionThreshold);
    if (lowResolution.length > 0) add("art_low_resolution", `${lowResolution.length} artwork image(s) are below ${lowResolutionThreshold}px`);
    if (new Set(hashedEmbedded.map((art) => art.sha256)).size > 1) add("art_embedded_inconsistent", "Multiple distinct embedded artwork byte hashes were found within the album");
    if (sidecars.length > 1) add("art_multiple_sidecars", `${sidecars.length} sidecar artwork files found`, sidecars.map((art) => art.filename!).filter(Boolean));
    if (hashedEmbedded.length > 0 && hashedSidecars.length > 0) {
      const embeddedHashes = new Set(hashedEmbedded.map((art) => art.sha256));
      if (hashedSidecars.every((art) => !embeddedHashes.has(art.sha256))) add("art_embedded_sidecar_mismatch_candidate", "Embedded and sidecar artwork bytes differ; review may be useful");
    }

    const missingGenres = metadataReadableTracks.filter((track) => track.genres.length === 0);
    if (missingGenres.length > 0) add("genre_missing", `${missingGenres.length} track(s) have no genre`, missingGenres.map((track) => track.path));
    const genreSets = new Set(metadataReadableTracks.filter((track) => track.genres.length > 0).map((track) => track.genres.map((genre) => normalized(genre)).filter(Boolean).sort().join("|")));
    if (genreSets.size > 1) add("genre_inconsistent_within_album", "Track genre values differ within the album");
    const allGenres = [...new Set(group.tracks.flatMap((track) => track.genres))];
    if (allGenres.length > 0 && allGenres.every((genre) => BROAD_GENRES.has(normalized(genre)!))) add("genre_broad_only_candidate", "Only broad genre labels are present; review may be useful");

    issues.push(...albumIssues);
    albums.push({
      id: albumId,
      keySource: group.source,
      musicBrainzReleaseId: first.musicBrainzReleaseId,
      album: first.album,
      albumArtist: first.albumArtist,
      year: first.year,
      directories,
      genres: allGenres.sort(),
      tracks: group.tracks,
      sidecars,
      issueIds: albumIssues.map((item) => item.id),
    });
  }
  return { albums, issues };
}

async function artwork(data: Uint8Array, source: ArtworkAudit["source"], maxImageBytes: number, details: { filename?: string; mime?: string } = {}): Promise<ArtworkAudit> {
  if (data.byteLength > maxImageBytes) return { source, ...details, readable: false, error: `Artwork exceeds ${maxImageBytes} byte limit` };
  const sha256 = createHash("sha256").update(data).digest("hex");
  try {
    const dimensions = imageSize(data);
    return { source, ...details, width: dimensions.width, height: dimensions.height, sha256, readable: true };
  } catch (error) {
    return { source, ...details, sha256, readable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function walk(root: string, maxFiles: number) {
  const audio: string[] = [];
  const images: string[] = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(absolute);
      else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(extension)) audio.push(absolute);
        else if (IMAGE_EXTENSIONS.has(extension)) images.push(absolute);
        if (audio.length + images.length > maxFiles) throw new Error(`Music audit file limit exceeded (${maxFiles})`);
      }
    }
  }
  return { audio: audio.sort(), images: images.sort() };
}

function sanitizedError(error: unknown, root: string) {
  return (error instanceof Error ? error.message : String(error)).replaceAll(root, "<music-root>");
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, callback: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await callback(items[index]!);
    }
  }));
  return results;
}

export async function scanMusicLibrary(config: MusicAuditConfig, scanId: string, startedAt: string, onProgress: (progress: MusicAuditProgress) => void = () => {}): Promise<MusicAuditSnapshot> {
  const progress: MusicAuditProgress = { phase: "discovering", processedAudio: 0, processedImages: 0, failedMetadata: 0, failedImages: 0 };
  const report = () => onProgress({ ...progress });
  report();
  const files = await walk(config.root, config.maxFiles);
  Object.assign(progress, { phase: "sidecars" as const, discoveredAudio: files.audio.length, discoveredImages: files.images.length });
  report();
  const warnings: string[] = [];
  const sidecarRows = await mapConcurrent(files.images, config.concurrency, async (absolute) => {
    const relative = path.relative(config.root, absolute).split(path.sep).join("/");
    try {
      const imageStat = await stat(absolute);
      const art = imageStat.size > config.maxImageBytes
        ? { source: "sidecar" as const, filename: relative, readable: false, error: `Artwork exceeds ${config.maxImageBytes} byte limit` }
        : await artwork(await readFile(absolute), "sidecar", config.maxImageBytes, { filename: relative });
      progress.processedImages += 1;
      if (!art.readable) {
        progress.failedImages += 1;
        warnings.push(`Could not inspect ${relative}: ${art.error ?? "unknown image error"}`);
      }
      report();
      return { directory: path.posix.dirname(relative), art };
    } catch (error) {
      progress.processedImages += 1;
      progress.failedImages += 1;
      const message = sanitizedError(error, config.root);
      warnings.push(`Could not inspect ${relative}: ${message}`);
      report();
      return { directory: path.posix.dirname(relative), art: { source: "sidecar" as const, filename: relative, readable: false, error: message } };
    }
  });
  const sidecarsByDirectory: SidecarsByDirectory = new Map();
  for (const row of sidecarRows) sidecarsByDirectory.set(row.directory, [...(sidecarsByDirectory.get(row.directory) ?? []), row.art]);

  progress.phase = "tracks";
  report();
  const tracks = await mapConcurrent(files.audio, config.concurrency, async (absolute): Promise<AuditedTrack> => {
    const relative = path.relative(config.root, absolute).split(path.sep).join("/");
    const directory = path.posix.dirname(relative);
    try {
      const metadata = await parseFile(absolute, { duration: false, skipCovers: false });
      const embeddedArt = await Promise.all((metadata.common.picture ?? []).map((picture) => artwork(picture.data, "embedded", config.maxImageBytes, { mime: picture.format })));
      progress.processedAudio += 1;
      const failedEmbedded = embeddedArt.filter((art) => !art.readable).length;
      progress.failedImages += failedEmbedded;
      if (failedEmbedded > 0) warnings.push(`Could not inspect ${failedEmbedded} embedded image(s) in ${relative}`);
      report();
      return {
        path: relative,
        directory,
        title: metadata.common.title,
        track: { no: metadata.common.track.no ?? undefined, of: metadata.common.track.of ?? undefined, disk: metadata.common.disk.no ?? undefined },
        album: metadata.common.album,
        albumArtist: metadata.common.albumartist,
        artist: metadata.common.artist,
        year: metadata.common.year,
        genres: metadata.common.genre ?? [],
        musicBrainzReleaseId: metadata.common.musicbrainz_albumid,
        embeddedArt,
      };
    } catch (error) {
      const message = sanitizedError(error, config.root);
      warnings.push(`Could not parse ${relative}: ${message}`);
      progress.processedAudio += 1;
      progress.failedMetadata += 1;
      report();
      return { path: relative, directory, genres: [], embeddedArt: [], metadataError: message };
    }
  });
  progress.phase = "aggregating";
  report();
  const { albums, issues } = aggregateMusicAudit(tracks, sidecarsByDirectory, config.lowResolutionThreshold);
  const byType: Partial<Record<MusicAuditIssueType, number>> = {};
  for (const item of issues) byType[item.type] = (byType[item.type] ?? 0) + 1;
  progress.phase = "completed";
  report();
  return {
    schemaVersion: MUSIC_AUDIT_SCHEMA_VERSION,
    scanId,
    status: "completed",
    startedAt,
    completedAt: new Date().toISOString(),
    root: config.root,
    thresholds: { lowResolutionPx: config.lowResolutionThreshold },
    progress: { ...progress },
    summary: {
      tracks: tracks.length,
      albums: albums.length,
      issues: issues.filter((item) => item.severity === "issue").length,
      candidates: issues.filter((item) => item.severity === "candidate").length,
      byType,
    },
    albums,
    issues,
    warnings: warnings.length > 100 ? [...warnings.slice(0, 99), `${warnings.length - 99} additional metadata warnings omitted`] : warnings,
    errors: [],
  };
}

async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function inspectCache(cacheDir: string) {
  let candidate = cacheDir;
  let exists = true;
  while (true) {
    try {
      const candidateStat = await stat(candidate);
      if (!candidateStat.isDirectory()) return { path: cacheDir, configured: true, exists, writable: false, checkedPath: candidate, error: "Cache path or nearest existing parent is not a directory" };
      await access(candidate, fsConstants.W_OK | fsConstants.X_OK);
      return { path: cacheDir, configured: true, exists, writable: true, checkedPath: candidate };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { path: cacheDir, configured: true, exists, writable: false, checkedPath: candidate, error: error instanceof Error ? error.message : String(error) };
      exists = false;
      const parent = path.dirname(candidate);
      if (parent === candidate) return { path: cacheDir, configured: true, exists: false, writable: false, checkedPath: candidate, error: "No existing cache parent found" };
      candidate = parent;
    }
  }
}

function response<T extends Record<string, unknown>>(summary: string, raw: T, warnings: string[] = [], errors: string[] = []) {
  const result = toSummary({ summary, ...raw, warnings, errors });
  const metrics = Object.entries((raw.summaryData as Record<string, unknown> | undefined) ?? {})
    .filter((entry): entry is [string, string | number] => typeof entry[1] === "string" || typeof entry[1] === "number")
    .map(([label, value]) => ({ label, value }));
  const cards = [{ id: "music-audit", title: "Music audit", metrics }];
  return { ...result, view: withViewState(mediaView("Music metadata audit", summary, cards), viewState({ warnings, errors, empty: raw.empty === true })) };
}

export class MusicAuditService {
  private initialization?: Promise<void>;
  private snapshot?: MusicAuditSnapshot;
  private state: ScanState = { schemaVersion: MUSIC_AUDIT_SCHEMA_VERSION, status: "idle", warnings: [], errors: [] };
  private active?: Promise<void>;
  private startGate?: Promise<any>;
  readonly config: MusicAuditConfig;
  private readonly mountInfoPath: string;
  private readonly scanner: NonNullable<AuditDeps["scanner"]>;

  constructor(config = musicAuditConfig(), deps: AuditDeps = {}) {
    this.config = config;
    this.mountInfoPath = deps.mountInfoPath ?? "/proc/self/mountinfo";
    this.scanner = deps.scanner ?? scanMusicLibrary;
  }

  private get snapshotFile() { return path.join(this.config.cacheDir, "snapshot.json"); }
  private get stateFile() { return path.join(this.config.cacheDir, "scan-state.json"); }

  private initialize() {
    if (!this.initialization) this.initialization = (async () => {
      try {
        const parsed = JSON.parse(await readFile(this.snapshotFile, "utf8")) as MusicAuditSnapshot;
        if (parsed.schemaVersion === MUSIC_AUDIT_SCHEMA_VERSION && parsed.status === "completed" && parsed.root === this.config.root) this.snapshot = parsed;
      } catch {}
      try {
        const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as ScanState;
        if (parsed.schemaVersion === MUSIC_AUDIT_SCHEMA_VERSION) this.state = parsed;
        if (this.state.status === "running") {
          this.state = { ...this.state, status: "interrupted", completedAt: new Date().toISOString(), errors: [...this.state.errors, "Scan was interrupted by process restart"] };
          await atomicJson(this.stateFile, this.state);
        }
      } catch {}
    })();
    return this.initialization;
  }

  async capabilities() {
    let readable = false;
    let canonicalPath: string | undefined;
    let canonicalMatchesConfigured = false;
    let rootError: string | undefined;
    try {
      const rootLinkStat = await lstat(this.config.root);
      if (rootLinkStat.isSymbolicLink()) throw new Error("Configured music root must not be a symlink");
      canonicalPath = await realpath(this.config.root);
      canonicalMatchesConfigured = canonicalPath === this.config.root;
      if (!canonicalMatchesConfigured) throw new Error("Configured music root contains a symlinked path component");
      const rootStat = await stat(this.config.root);
      if (!rootStat.isDirectory()) throw new Error("Configured music root is not a directory");
      await access(this.config.root, fsConstants.R_OK);
      readable = true;
    } catch (error) {
      rootError = error instanceof Error ? error.message : String(error);
    }
    let mount: ReturnType<typeof readOnlyMountFor> = { verified: false, rootReadOnly: false, writableDescendantMounts: [] };
    let mountError: string | undefined;
    try { mount = readOnlyMountFor(this.config.root, await readFile(this.mountInfoPath, "utf8")); }
    catch (error) { mountError = error instanceof Error ? error.message : String(error); }
    const cache = await inspectCache(this.config.cacheDir);
    const warnings = [rootError && `Music root unavailable: ${rootError}`, mountError && `Mount information unavailable: ${mountError}`, !mount.verified && "Configured music root is not positively verified read-only", !cache.writable && `Music audit cache is not writable: ${cache.error ?? cache.checkedPath}`].filter((value): value is string => Boolean(value));
    return response(this.config.enabled ? "Music audit capability is configured" : "Music audit is disabled", {
      enabled: this.config.enabled,
      root: { path: this.config.root, canonicalPath, canonicalMatchesConfigured, readable },
      cache: { ...cache, snapshotSchemaVersion: MUSIC_AUDIT_SCHEMA_VERSION },
      support: { metadata: true, embeddedArtwork: true, sidecarArtwork: true, exactArtworkSha256: true, writesLibrary: false },
      thresholds: { lowResolutionPx: this.config.lowResolutionThreshold, concurrency: this.config.concurrency, cooldownSeconds: this.config.cooldownSeconds, maxFiles: this.config.maxFiles, maxImageBytes: this.config.maxImageBytes },
      readOnlyMount: mount,
      canStart: this.config.enabled && readable && canonicalMatchesConfigured && mount.verified && cache.writable,
    }, warnings);
  }

  start(): Promise<any> {
    if (this.startGate) return this.startGate;
    this.startGate = this.startUnlocked().finally(() => { this.startGate = undefined; });
    return this.startGate;
  }

  private async startUnlocked() {
    await this.initialize();
    if (this.active) return response("A music audit scan is already running", { scan: this.state });
    const capabilities = await this.capabilities();
    if (!this.config.enabled) throw new Error("Music audit is disabled; set MUSIC_AUDIT_ENABLED=true");
    if (!(capabilities.root as { readable: boolean }).readable) throw new Error("Configured music root is not readable or contains a symlinked path component");
    if (!(capabilities.root as { canonicalMatchesConfigured: boolean }).canonicalMatchesConfigured) throw new Error("Configured music root must match its canonical path");
    if (!(capabilities.readOnlyMount as { verified: boolean }).verified) throw new Error("Configured music root is not positively verified read-only or contains a writable descendant mount");
    if (!(capabilities.cache as { writable: boolean }).writable) throw new Error("Configured music audit cache is not writable");
    const latestCompletedAt = this.snapshot?.completedAt;
    if (latestCompletedAt && this.config.cooldownSeconds > 0) {
      const retryAt = new Date(new Date(latestCompletedAt).getTime() + this.config.cooldownSeconds * 1000);
      if (retryAt.getTime() > Date.now()) throw new Error(`Music audit cooldown is active until ${retryAt.toISOString()}`);
    }
    const scanId = randomUUID();
    const startedAt = new Date().toISOString();
    const progress: MusicAuditProgress = { phase: "discovering", processedAudio: 0, processedImages: 0, failedMetadata: 0, failedImages: 0 };
    this.state = { schemaVersion: MUSIC_AUDIT_SCHEMA_VERSION, scanId, status: "running", startedAt, progress, warnings: [], errors: [] };
    await atomicJson(this.stateFile, this.state);
    this.active = this.scanner(this.config, scanId, startedAt, (nextProgress) => {
      if (this.state.status === "running" && this.state.scanId === scanId) this.state = { ...this.state, progress: nextProgress };
    }).then(async (snapshot) => {
      await atomicJson(this.snapshotFile, snapshot);
      this.snapshot = snapshot;
      this.state = { schemaVersion: MUSIC_AUDIT_SCHEMA_VERSION, scanId, status: "completed", startedAt, completedAt: snapshot.completedAt, summary: snapshot.summary, progress: snapshot.progress, warnings: snapshot.warnings, errors: snapshot.errors };
      await atomicJson(this.stateFile, this.state);
    }).catch(async (error) => {
      this.state = { ...this.state, status: "failed", completedAt: new Date().toISOString(), errors: [error instanceof Error ? error.message : String(error)] };
      await atomicJson(this.stateFile, this.state);
    }).finally(() => { this.active = undefined; });
    return response("Music audit scan started", { scan: this.state });
  }

  async status() {
    await this.initialize();
    return response(`Music audit scan status: ${this.state.status}`, { scan: this.state, latestCompletedScanId: this.snapshot?.scanId, summaryData: this.state.summary }, this.state.warnings, this.state.errors);
  }

  async summary() {
    await this.initialize();
    if (!this.snapshot) return response("No completed music audit snapshot is available", { snapshot: null, empty: true });
    return response(`Audited ${this.snapshot.summary.albums} albums and ${this.snapshot.summary.tracks} tracks`, {
      scanId: this.snapshot.scanId,
      startedAt: this.snapshot.startedAt,
      completedAt: this.snapshot.completedAt,
      thresholds: this.snapshot.thresholds,
      summaryData: this.snapshot.summary,
    }, this.snapshot.warnings, this.snapshot.errors);
  }

  async issues(args: { type?: MusicAuditIssueType; severity?: "issue" | "candidate"; offset?: number; limit?: number }) {
    await this.initialize();
    if (!this.snapshot) return response("No completed music audit snapshot is available", { items: [], total: 0, offset: 0, limit: args.limit ?? 25, empty: true });
    const offset = Math.max(0, Math.trunc(args.offset ?? 0));
    const limit = Math.min(100, Math.max(1, Math.trunc(args.limit ?? 25)));
    const filtered = this.snapshot.issues.filter((item) => (!args.type || item.type === args.type) && (!args.severity || item.severity === args.severity));
    return response(`Found ${filtered.length} matching music audit findings`, { scanId: this.snapshot.scanId, items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit, empty: filtered.length === 0 }, this.snapshot.warnings, this.snapshot.errors);
  }

  async genreDistribution(args: { search?: string; offset?: number; limit?: number }) {
    await this.initialize();
    const offset = Math.max(0, Math.trunc(args.offset ?? 0));
    const limit = Math.min(200, Math.max(1, Math.trunc(args.limit ?? 50)));
    if (!this.snapshot) return response("No completed music audit snapshot is available", {
      scanId: null,
      items: [],
      total: 0,
      totalUniqueGenres: 0,
      totalTaggedTracks: 0,
      totalAlbumsRepresented: 0,
      offset,
      limit,
      summaryData: { uniqueGenres: 0, taggedTracks: 0, albumsRepresented: 0 },
      empty: true,
    });

    const genres = new Map<string, {
      rawGenre: string;
      normalizedKey: string;
      trackCount: number;
      albumIds: Set<string>;
      representativeAlbums: Array<{ albumId: string; albumArtist?: string; album?: string; year?: number }>;
    }>();
    let totalTaggedTracks = 0;
    const representedAlbumIds = new Set<string>();
    for (const album of this.snapshot.albums) {
      let albumTagged = false;
      for (const track of album.tracks) {
        const trackGenres = new Set(track.genres);
        if (trackGenres.size > 0) {
          totalTaggedTracks += 1;
          albumTagged = true;
        }
        for (const rawGenre of trackGenres) {
          const row = genres.get(rawGenre) ?? { rawGenre, normalizedKey: normalized(rawGenre) ?? "", trackCount: 0, albumIds: new Set<string>(), representativeAlbums: [] };
          row.trackCount += 1;
          if (!row.albumIds.has(album.id)) {
            row.albumIds.add(album.id);
            if (row.representativeAlbums.length < 5) row.representativeAlbums.push({ albumId: album.id, albumArtist: album.albumArtist, album: album.album, year: album.year });
          }
          genres.set(rawGenre, row);
        }
      }
      if (albumTagged) representedAlbumIds.add(album.id);
    }

    const rawSearch = args.search?.toLocaleLowerCase();
    const normalizedSearch = normalized(args.search);
    const rows = [...genres.values()]
      .filter((row) => !args.search || row.rawGenre.toLocaleLowerCase().includes(rawSearch!) || row.normalizedKey.includes(normalizedSearch ?? ""))
      .map(({ albumIds, ...row }) => ({ ...row, albumCount: albumIds.size }))
      .sort((a, b) => b.trackCount - a.trackCount || a.rawGenre.localeCompare(b.rawGenre));
    const totalUniqueGenres = genres.size;
    const totalAlbumsRepresented = representedAlbumIds.size;
    return response(`Found ${rows.length} matching genre rows from ${totalUniqueGenres} unique raw genres`, {
      scanId: this.snapshot.scanId,
      items: rows.slice(offset, offset + limit),
      total: rows.length,
      totalUniqueGenres,
      totalTaggedTracks,
      totalAlbumsRepresented,
      offset,
      limit,
      summaryData: { uniqueGenres: totalUniqueGenres, taggedTracks: totalTaggedTracks, albumsRepresented: totalAlbumsRepresented, scanId: this.snapshot.scanId },
      empty: rows.length === 0,
    }, this.snapshot.warnings, this.snapshot.errors);
  }

  async albumDetail(albumId: string) {
    await this.initialize();
    if (!this.snapshot) throw new Error("No completed music audit snapshot is available");
    const album = this.snapshot.albums.find((candidate) => candidate.id === albumId);
    if (!album) throw new Error("Album audit ID was not found in the current snapshot");
    const albumIssues = this.snapshot.issues.filter((item) => item.albumId === albumId);
    return response(`${album.albumArtist ?? "Unknown artist"} — ${album.album ?? album.directories[0] ?? "Unknown album"}`, { scanId: this.snapshot.scanId, album, issues: albumIssues, summaryData: { tracks: album.tracks.length, findings: albumIssues.length } }, this.snapshot.warnings, this.snapshot.errors);
  }

  /** Test/controlled shutdown hook: waits for the current background scan. */
  async waitForScan() { await this.active; }
}

export const musicAudit = new MusicAuditService();
