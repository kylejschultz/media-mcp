# media-mcp

MCP server for the media stack: Sonarr, Radarr, Lidarr, Prowlarr, and SABnzbd.

The server is intentionally env-driven so API keys stay out of git.

## Setup

```bash
npm install
cp .env.example .env
npm run build
```

Fill in the `*_URL` and `*_API_KEY` values in `.env`.

If you run this alongside the existing media containers, use Docker so the MCP server can join `docker-network` and resolve `sonarr`, `radarr`, and `sabnzbd` by container name:

```bash
docker pull ghcr.io/kylejschultz/media-mcp:latest
docker compose up -d
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
    env_file:
      - /mnt/user/appdata/media-stack/media-mcp/.env
    networks:
      - docker-network
    stdin_open: true
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
      "args": ["compose", "-f", "/Volumes/dockerDisk/media-mcp/docker-compose.yml", "run", "--rm", "-T", "media-mcp"]
    }
  }
}
```

## Tools

- `media_configured_apps` - list configured apps and missing env vars.
- `media_system_status` - fetch app version/status.
- `media_queue` - show download/processing queue for Sonarr, Radarr, Lidarr, or SABnzbd.
- `media_history` - show recent history/events.
- `media_calendar` - show Sonarr/Radarr/Lidarr upcoming releases.
- `media_search` - search indexers through Prowlarr.
- `media_wanted_missing` - list missing wanted items for Sonarr/Radarr/Lidarr.

## Notes

SABnzbd has a different API shape from the Arr apps, so its queue/history tools normalize the output separately.
