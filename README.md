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
- `get_import_issues` - queue/import warnings and failed recent history.
- `media_configured_apps` - list configured apps and missing env vars.
- `media_system_status` - fetch app version/status.
- `media_queue` - show normalized download/processing queue for Sonarr, Radarr, Lidarr, or SABnzbd.
- `media_history` - show normalized recent history/events.
- `media_calendar` - show Sonarr/Radarr/Lidarr upcoming releases.
- `media_search` - search indexers through Prowlarr.
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
Phase 1 is intentionally read-only. The overview payload includes a safety card
showing that write/request/destructive tool tiers are disabled.
The generated stack model is used to interpret expected stack-specific warnings,
such as Lidarr Completed Download Handling being disabled while beets-flask owns
music import/tagging.
