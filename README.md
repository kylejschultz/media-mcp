# media-mcp

MCP server for the media stack: Sonarr, Radarr, Lidarr, Prowlarr, SABnzbd, Jellyfin, beets-flask, slskd, Navidrome, and Subwave.

The server is intentionally env-driven so API keys stay out of git.

## Setup

```bash
npm install
cp .env.example .env
npm run build
```

Fill in the `*_URL`, `*_API_KEY`, and service credential values in `.env` for local development.
Navidrome uses a dedicated Subsonic user via `NAVIDROME_USER` and `NAVIDROME_PASS`.
Subwave public reads need only `SUBWAVE_URL`; admin-read endpoints use `SUBWAVE_ADMIN_USER` and `SUBWAVE_ADMIN_PASS`.

If you run this alongside the existing media containers, use Docker so the MCP server can join `docker-network` and resolve `sonarr`, `radarr`, and `sabnzbd` by container name:

```bash
docker pull ghcr.io/kylejschultz/media-mcp:latest
docker compose up -d
```

Container deployments load `/config/.env`, so mount appdata to `/config`.

By default the binary still uses stdio for MCP clients that launch the process directly. Set `MEDIA_MCP_TRANSPORT=http` to run it as a persistent Streamable HTTP service:

```bash
MEDIA_MCP_TRANSPORT=http MEDIA_MCP_HTTP_PORT=3000 npm start
```

HTTP mode exposes:

- `GET /health` - container health check with configured app summary.
- `/mcp` - MCP Streamable HTTP endpoint for clients.

By default HTTP mode allows browser clients from any origin. To restrict that,
set `MEDIA_MCP_ALLOWED_ORIGINS` to a comma-separated list:

```bash
MEDIA_MCP_ALLOWED_ORIGINS=http://10.10.10.10:3000,http://localhost:6274
```

For local development, build and run from source:

```bash
npm install
npm run smoke
npm start
```

## Unraid Compose

Use this service inside the existing media-stack compose, on the same `docker-network` as the media apps:

```yaml
services:
  media-mcp:
    image: ghcr.io/kylejschultz/media-mcp:latest
    container_name: media-mcp
    environment:
      - TZ=America/Los_Angeles
      - MEDIA_MCP_TRANSPORT=http
      - MEDIA_MCP_HTTP_PORT=3000
      # Optional: enable only when this MCP endpoint is trusted/private.
      # - MUSIC_AUDIT_ENABLED=true
      # Artwork preview remains disabled by default; enable only on a trusted/private endpoint.
      # - MUSIC_AUDIT_ARTWORK_PREVIEW_ENABLED=false
      # - MUSIC_AUDIT_ROOT=/music-library
      # - MUSIC_AUDIT_CACHE_DIR=/config/music-audit
      # - MUSIC_AUDIT_LOW_RESOLUTION_PX=600
      # - MUSIC_AUDIT_CONCURRENCY=4
      # - MUSIC_AUDIT_COOLDOWN_SECONDS=300
      # - MUSIC_AUDIT_MAX_FILES=100000
      # - MUSIC_AUDIT_MAX_IMAGE_BYTES=33554432
      # Optional: restrict browser clients instead of allowing any origin.
      # - MEDIA_MCP_ALLOWED_ORIGINS=http://10.10.10.10:3000
    ports:
      - "3000:3000"
    volumes:
      - /mnt/user/appdata/media-stack/media-mcp:/config
      # Required only when MUSIC_AUDIT_ENABLED=true.
      # - /mnt/user/media-stack/music:/music-library:ro
    networks:
      - docker-network
    restart: unless-stopped

networks:
  docker-network:
    external: true
```

The HTTP transport currently has no built-in authentication. Enable the music
library audit only when the MCP endpoint is restricted to a trusted/private
network or authenticated upstream; otherwise leave `MUSIC_AUDIT_ENABLED` unset.
`MUSIC_AUDIT_ARTWORK_PREVIEW_ENABLED` is a separate opt-in gate and defaults to
`false`. Enable it only when that MCP endpoint is trusted/private. Preview calls
still accept no paths or URLs: they resolve an opaque album ID and indexed
snapshot artwork under the fixed read-only root, reject symlinks/escapes or
changed bytes, and return only a downscaled JPEG (never original artwork).

### Optional beets-flask remediation overlay

`Dockerfile.beets-flask-remediation` derives from the exact pinned upstream
image digest and only overlays an authenticated Quart blueprint. It does not
change the media-mcp image or its `/music-library:ro` audit mount. Build it with:

```bash
docker build -f Dockerfile.beets-flask-remediation --target test .
docker build -f Dockerfile.beets-flask-remediation --target runtime -t beets-flask-remediation .
```

The complete Compose example is
[`docs/docker-compose.remediation.example.yml`](docs/docker-compose.remediation.example.yml).
The overlay requires all of the following:

- `BEETS_REMEDIATION_ENABLED=true`; mutation routes additionally require
  `BEETS_REMEDIATION_WRITES_ENABLED=true` and maintenance mode
  `BEETS_REMEDIATION_MAINTENANCE=true`.
- A shared random bearer token and a separate shared manifest HMAC key, each at
  least 32 characters. Media-mcp uses `BEETS_FLASK_REMEDIATION_TOKEN`; both
  containers use `BEETS_REMEDIATION_MANIFEST_HMAC_KEY`.
- `BEETS_REMEDIATION_APPROVED_SCAN_ID` set to the one reviewed audit snapshot.
- `BEETS_REMEDIATION_GENRES_JSON` set to the explicit canonical JSON string
  array, for example `["Hip-Hop & Rap","Rock"]`.
- A writable library at `BEETS_REMEDIATION_LIBRARY_ROOT` and a private writable
  `BEETS_REMEDIATION_BACKUP_ROOT` outside the served library but on the same
  filesystem. The latter stores full originals, staging data, and durable
  journals until finalize. Successful apply and rollback re-read each changed
  item through the installed beets APIs and synchronize the album genre and
  `artpath` in the existing beets library database.

Media-mcp first resolves reviewed opaque album IDs against its latest snapshot,
verifies its `/music-library:ro` mount, hashes current track/sidecar files, and
stores a signed canonical manifest under `/config/music-remediation`. Preview
and apply accept only that opaque manifest ID; media-mcp reloads its file,
verifies the HMAC/digest and latest snapshot, and sends the signed envelope to
the overlay. CAA decisions require a separately reviewed `expected_sha256`;
`music_remediation_art_digest` obtains it without returning image bytes.

Preview is authenticated and never writes. Apply, rollback, recovery, and
finalize additionally require both MCP gates (`ALLOW_REQUESTS=true` and
`ALLOW_WRITE_BEETS_FLASK=true`) and the overlay's independent
`BEETS_REMEDIATION_WRITES_ENABLED=true` plus
`BEETS_REMEDIATION_MAINTENANCE=true`; bearer authentication alone never enables
a mutation. Keep the MCP endpoint private: these gates are safeguards, not user
authentication. Maintenance mode is an operator assertion. The overlay also checks the installed
beets-flask RQ queues and refuses mutations whenever queued, scheduled, or
started jobs exist or Redis state cannot be verified; it rechecks immediately
before filesystem replacement and database synchronization. Operators must
still stop external writers/watchdogs and keep them idle through the transaction,
then disable both overlay mutation gates afterward. The overlay cannot force
unrelated processes to honor its writer lock.
Finalize is intentionally separate and its public MCP input is only the opaque
transaction ID. Media-mcp reads the overlay's authenticated expected state,
loads a real distinct completed audit snapshot, rehashes every track and
sidecar through its verified read-only root, requires exact album/track/ordered
genre/embedded-art/sidecar equality, and HMAC-signs the canonical derived
attestation. The overlay verifies that signature in constant time and requires
exact journal equality before deleting backups; bearer-authenticated callers
cannot fabricate finalize state. A restart leaves any
applying/applied/rolling-back/rolled-back journal non-finalized and blocks
another apply until explicit recovery, rollback, or finalize. Replacement and
rollback are recoverable per file, not album- or batch-atomic. Rollback persists
`rolling_back` before restoring anything and its explicit recovery path resumes
mixed restored/applied files plus database restoration using only committed,
reverified backups. Each original is written to a same-directory temporary,
fsynced, hash-verified, atomically committed, and journaled before its
corresponding live replacement. v1 fails closed unless an audited album has
exactly one existing supported sidecar. Apply uses a caller-generated operation
ID so status can recover the transaction after a timeout. Interrupted
`finalizing` reconciliation runs at mutation-enabled startup or a finalize
retry; status does not perform backup deletion.

The writer rejects symlinks and hardlinks, uses directory-FD replacement with
`O_NOFOLLOW` where practical, and revalidates file plus parent inode/device
identities immediately before replacement. Residual review risk: a hostile
actor able to rename or swap a validated parent directory in the final syscall
window can still race pathname topology. The service UID must be the trusted
library owner, and no other user or process may have concurrent rename/write
access to those directories during maintenance.

CAA downloads follow only the release-bound Internet Archive handoff. The
current service uses an exact `archive.org/download/mbid-…` redirect followed by
an exact `dn<digits>.ca.archive.org/0/items/mbid-…` object handoff; any different
host/path, private DNS answer, query, fragment, port, credentials, or further
redirect is rejected.

If the GHCR package is private, log in on Unraid first:

```bash
docker login ghcr.io -u kylejschultz
```

## MCP Config

Example stdio config:

```json
{
  "mcpServers": {
    "media": {
      "command": "docker",
      "args": [
        "compose",
        "-f",
        "/Volumes/dockerDisk/media-mcp/docker-compose.yml",
        "run",
        "--rm",
        "-T",
        "media-mcp"
      ]
    }
  }
}
```

Example Streamable HTTP config:

```json
{
  "mcpServers": {
    "media": {
      "url": "http://10.10.10.10:3000/mcp"
    }
  }
}
```

## HTTP Smoke Test

After the container starts on Unraid:

```bash
curl http://10.10.10.10:3000/health
MEDIA_MCP_SMOKE_URL=http://10.10.10.10:3000/mcp npm run smoke:http
```

The HTTP smoke test performs a real MCP initialize and `tools/list` request over
Streamable HTTP. It does not call the media APIs, so it is safe to run before the
service API keys are fully wired.

## Component Views

The primary diagnostic tools include a `view` field alongside the existing raw
JSON. `view` uses schema `media-mcp.view.v1` and is shaped for card/component
renderers:

- `title` and `summary` for the overall view.
- `cards[]` for grouped status areas.
- `metrics[]` for compact counts and ratios.
- `items[]` for short rows with optional details.
- `tone` values of `ok`, `info`, `warning`, or `error`.
- `checkedAt`, `warnings`, and `errors` are included on normalized summary
  responses so clients can show freshness and callouts consistently.

This field is additive. Clients can ignore it and keep reading the existing
`summary`, `services`, and raw data fields.

## Client Rendering Contract

Clients should call MCP tools directly and render from the returned neutral
payloads. The server does not emit Discord component IDs, modal routes, message
edit instructions, resident panel state, or ready-to-render platform components.

See [`docs/CLIENT_CONTRACT.md`](docs/CLIENT_CONTRACT.md) for the durable client
contract, [`docs/ARCHITECTURE_BOUNDARY.md`](docs/ARCHITECTURE_BOUNDARY.md) for
the server/client responsibility audit, and
[`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) for release/deploy
verification.

- `summary`, `checkedAt`, `warnings`, and `errors` are common fallback fields.
- `view.cards[]` group visible content; `metrics[]`, `items[]`, `media`, and
  `actions[]` are renderer hints, not raw API contracts.
- `requestDraft` is the neutral request-building contract for movie and series
  flows. It contains candidate options, quality/root/tag choices, defaults,
  selected request values, generic form field descriptors, and write gate state.
- Write actions must stay behind the existing safety gate and should be reached
  through a preview or confirmation state.
- Platform-specific clients, such as the Discord panel plugin, own component
  IDs, callbacks, modal routing, message edits, display formatting, and local
  resident state.

### Core Request Flow

- Search movies with `search_movie`; select from `candidates` or
  `requestDraft.candidateOptions`.
- Search series with `search_series`; use the same `requestDraft` contract.
- Preview movie requests with `preview_movie_request`; render the returned
  `view`, `requestDraft`, `payloadPreview`, and warnings.
- Preview series requests with `preview_series_request`; preserve returned
  monitor options and expected episode metadata where useful for follow-up.
- Write movies with `request_movie` only after preview and only when
  `ALLOW_REQUESTS=true`.
- Write series with `request_series` only after preview and only when
  `ALLOW_REQUESTS=true`.
- Update existing movie monitoring with `set_movie_monitoring`; optionally
  start a Radarr movie search.
- Update one existing Sonarr season with `set_series_season_monitoring`;
  neighboring seasons are not modified.
- Request one Sonarr season with `request_series_season`. If the series already
  exists, the tool updates only that season; if it is missing, the tool adds the
  series with only the requested season monitored.
- Follow request lifecycle with `request_follow_status`. The MCP server owns
  queue/history polling, title matching, Sonarr episode aggregation, and counts
  such as `1/2 imported` when the expected episode count is known.

### Standard View States

Renderers may normalize actions into these states:

- `loading`: client has accepted an interaction and is waiting on the MCP tool.
- `success`: tool returned usable content.
- `empty`: tool succeeded but has no actionable rows or results.
- `partial_failure`: tool returned usable content plus warnings.
- `error`: tool failed or returned no renderable content.
- `confirm`: user must confirm before a write action runs.

`media-mcp.view.v1` includes an optional `state` field for these states. It is
additive; clients can ignore it and consume the raw result fields instead.

## Tools

- `media_stack_overview` - compact dashboard across status, health, queues, missing media, disk space, indexers, library counts, and import issues.
- `media_stack_model` - generated stack knowledge derived from the Media Stack Overview Notion page.
- `media_stack_flow` - generated file-flow knowledge for TV, movies, music, or all media types.
- `service_status` - normalized reachability/auth/version checks.
- `service_health` - health issues from configured services.
- `disk_space` - service-visible disk space from media library Arr applications; Prowlarr is skipped because it does not own media storage.
- `download_queue` - normalized queue items across Sonarr, Radarr, Lidarr, and SABnzbd.
- `recent_activity` - normalized recent history/activity.
- `get_missing_summary` - missing wanted counts and samples.
- `indexer_status` - Prowlarr indexer status without credentials.
- `get_library_counts` - Sonarr/Radarr/Lidarr library counts.
- `get_import_issues` - queue/import warnings and unresolved failed recent history; retry failures that later completed are reported separately as resolved.
- `media_configured_apps` - list configured apps and missing env vars.
- `media_system_status` - fetch app version/status.
- `media_queue` - show normalized download/processing queue for Sonarr, Radarr, Lidarr, or SABnzbd.
- `media_history` - show normalized recent history/events.
- `media_calendar` - show Sonarr/Radarr/Lidarr upcoming releases.
- `media_search` - search indexers through Prowlarr.
- `radarr_request_options` - list Radarr quality profiles, root folders, tags, and form-friendly request defaults.
- `search_movie` - search Radarr movie candidates and return selectable request draft options.
- `preview_movie_request` - validate a Radarr movie request without writing.
- `request_movie` - add an exact selected movie to Radarr when `ALLOW_REQUESTS=true`.
- `set_movie_monitoring` - update monitoring for an existing Radarr movie and optionally start a movie search.
- `sonarr_request_options` - list Sonarr quality profiles, root folders, tags, monitor modes, and form-friendly request defaults.
- `search_series` - search Sonarr series candidates and return selectable request draft options.
- `preview_series_request` - validate a Sonarr series request without writing.
- `request_series` - add an exact selected series to Sonarr when `ALLOW_REQUESTS=true`.
- `set_series_season_monitoring` - update exactly one existing Sonarr season and optionally start a season search.
- `request_series_season` - add or update a Sonarr series for one specific season only, then optionally start a season search.
- `request_follow_status` - return normalized request lifecycle status from queue/history for a Radarr movie or Sonarr series.
- `media_wanted_missing` - list normalized missing wanted items for Sonarr/Radarr/Lidarr.
- `beets_flask_status` - show read-only beets-flask queue, worker, inbox, and library status.
- `slskd_status` - show read-only slskd Soulseek connection, transfer, and share status.
- `navidrome_status` - show read-only Navidrome Subsonic reachability, scan, and music-folder status.
- `navidrome_search` - search Navidrome artists, albums, and songs through Subsonic `search3`.
- `navidrome_scan_status` - show Navidrome scan state, counts, and last scan time.
- `music_audit_capabilities` - report audit configuration, root readability, cache writability, and positively verified read-only mount status without enumerating library files or write-probing.
- `music_audit_start` - start one process-wide read-only scan against the fixed configured music root when its cache is writable; repeated starts return the active scan.
- `music_audit_status` - show current scan phase, discovered/processed/failure counts, and the latest completed snapshot reference.
- `music_audit_summary` - return compact counts from the latest completed snapshot.
- `music_audit_issues` - page and filter objective findings and clearly labeled review candidates.
- `music_genre_distribution` - page and search exact raw genre tags with conservative normalized keys, track/album counts, and up to five representative albums; compound tags are preserved rather than split.
- `music_album_audit_detail` - return metadata, artwork hashes/dimensions, and findings for an opaque album ID from the current snapshot.
- `music_album_artwork_preview` - return a bounded JPEG preview for one indexed embedded or sidecar snapshot variant when the separate preview gate is enabled; callers provide only an opaque album ID, source, and nonnegative index.
- `music_remediation_art_digest` - securely fetch/decode one exact CAA object and return its SHA-256 and dimensions without image bytes.
- `music_remediation_prepare` - derive, sign, and store a canonical manifest from latest-snapshot album IDs plus reviewed decisions.
- `music_remediation_preview` - load one opaque stored manifest ID and validate exact intended changes without writing.
- `music_remediation_apply` - apply one stored manifest using a caller-generated idempotency ID and return post-state hashes; replacement is recoverable per file, not batch-atomic.
- `music_remediation_rollback` - restore byte-identical originals for one opaque transaction ID; requires both write gates.
- `music_remediation_finalize` - accept only an opaque transaction ID, derive and sign exact state from a distinct completed audit, then delete the exact transaction backup; requires both write gates.
- `music_remediation_status` - return bounded authenticated status for an operation/transaction ID after a timeout without exposing paths or bytes.
- `music_remediation_recover` - explicitly restore an interrupted apply or resume a `rolling_back` transaction after exact journal/live-state checks; requires every mutation gate.
- `subwave_status` - show read-only Subwave station health, now-playing, queue, and admin-read availability.
- `subwave_now_playing` - show current Subwave track, station context, DJ persona, listeners, and stream descriptor.
- `subwave_state` - show Subwave current queue, recent history, DJ log, and station state.
- `subwave_streams` - show Subwave stream descriptor plus PLS/M3U tune-in files.
- `subwave_search` - search Subwave's admin library endpoint for queue-ready tracks.
- `subwave_recent` - show recently added Subwave tracks and playlist summary.
- `subwave_upsert_show` - upsert one Subwave show through the admin API after validating show moods.
- `subwave_update_schedule` - replace the 7 day x 24 hour Subwave weekly schedule after validating show ids.
- `jellyfin_system_info` - show Jellyfin server version and basic system information.
- `jellyfin_library_counts` - show Jellyfin media item counts.
- `jellyfin_active_sessions` - show active Jellyfin sessions and playback summary.
- `jellyfin_recent_activity` - show bounded Jellyfin activity log entries.
- `jellyfin_scheduled_tasks` - show Jellyfin scheduled task state and last run summaries.

## Notes

SABnzbd has a different API shape from the Arr apps, so its queue/history tools normalize the output separately.
Jellyfin support is read-only and uses `JELLYFIN_URL` plus `JELLYFIN_API_KEY` with Jellyfin's MediaBrowser token auth.
Ordinary beets-flask support is read-only and uses `BEETS_FLASK_URL`; the optional remediation tools use the separately pinned overlay and shared bearer token. slskd support is read-only and uses `SLSKD_URL` plus `SLSKD_API_KEY`.
Navidrome support is read-only in the current release and uses `NAVIDROME_URL`, `NAVIDROME_USER`, and `NAVIDROME_PASS` against the Subsonic API.
Subwave public station reads use `SUBWAVE_URL`. Admin-read and write tools such as `subwave_search`, `subwave_recent`, `subwave_upsert_show`, and `subwave_update_schedule` also require `SUBWAVE_ADMIN_USER` and `SUBWAVE_ADMIN_PASS`.
The default runtime is read-only. Search and preview tools are safe by default;
request/write tools refuse to run unless `ALLOW_REQUESTS=true`.
Service-specific write tools stay behind explicit gates such as
`ALLOW_WRITE_NAVIDROME`, `ALLOW_WRITE_SUBWAVE`, and `ALLOW_WRITE_BEETS_FLASK`.
The generated stack model is used to interpret expected stack-specific warnings,
such as Lidarr Completed Download Handling being disabled while beets-flask owns
music import/tagging.
Streamable HTTP blocks browser origins by default. Set
`MEDIA_MCP_ALLOWED_ORIGINS` to a comma-separated allowlist only for trusted
browser-based clients.

### 2026-06-24 - v0.2.0 Radarr Request Preview

- Refactored shared adapters, formatting helpers, result wrappers, and view helpers out of the main media orchestration module.
- Added `radarr_request_options`, `search_movie`, `preview_movie_request`, and gated `request_movie`.
- Added neutral `media-mcp.requestDraft.v1` payloads so clients can render search and preview results as form-like flows.
- Added `ALLOW_REQUESTS`; request/write tools stay disabled unless this is explicitly set to `true`.
- Hardened Streamable HTTP CORS defaults and redacted upstream response bodies before returning tool errors.

### 2026-06-24 - v0.2.1 Request View UX Hints

- Added media/action hints to `media-mcp.view.v1` cards and items.
- Included Radarr poster image URLs in movie search and request preview views.
- Included preview/request action payloads so clients can render form-like controls without scraping plain text.

### 2026-06-24 - v0.2.2 Version Metadata Fix

- Centralized server version metadata so MCP server info and HTTP health output match package releases.

### 2026-06-24 - v0.2.3 Request Component Experiment

- Added experimental ready-to-render Discord component specs to Radarr movie search and preview responses. These were later removed from the server contract; client-specific rendering now belongs in client plugins.
- The experiment shaped later client-side dropdown and preview rendering in the optional Discord panel plugin.

### 2026-06-24 - v0.2.4 Version Metadata Fix

- Updated server version metadata for the request component experiment release.
