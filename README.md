# media-mcp

MCP server for the media stack: Sonarr, Radarr, Lidarr, Prowlarr, SABnzbd, and Jellyfin.

The server is intentionally env-driven so API keys stay out of git.

## Setup

```bash
npm install
cp .env.example .env
npm run build
```

Fill in the `*_URL` and `*_API_KEY` values in `.env` for local development.

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
      # Optional: restrict browser clients instead of allowing any origin.
      # - MEDIA_MCP_ALLOWED_ORIGINS=http://10.10.10.10:3000
    ports:
      - "3000:3000"
    volumes:
      - /mnt/user/appdata/media-stack/media-mcp:/config
    networks:
      - docker-network
    restart: unless-stopped

networks:
  docker-network:
    external: true
```

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
- `jellyfin_system_info` - show Jellyfin server version and basic system information.
- `jellyfin_library_counts` - show Jellyfin media item counts.
- `jellyfin_active_sessions` - show active Jellyfin sessions and playback summary.
- `jellyfin_recent_activity` - show bounded Jellyfin activity log entries.
- `jellyfin_scheduled_tasks` - show Jellyfin scheduled task state and last run summaries.

## Notes

SABnzbd has a different API shape from the Arr apps, so its queue/history tools normalize the output separately.
Jellyfin support is read-only and uses `JELLYFIN_URL` plus `JELLYFIN_API_KEY` with Jellyfin's MediaBrowser token auth.
beets-flask support is read-only and uses `BEETS_FLASK_URL`. slskd support is read-only and uses `SLSKD_URL` plus `SLSKD_API_KEY`.
The default runtime is read-only. Search and preview tools are safe by default;
request/write tools refuse to run unless `ALLOW_REQUESTS=true`.
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
