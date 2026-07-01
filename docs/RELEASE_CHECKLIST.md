# Release Checklist

Use this before tagging, publishing, or deploying `media-mcp`.

## Core Verification

- Run `npm run check`.
- Run `npm test`.
- Run `npm run build`.
- Run a local smoke check with configured env: `npm run smoke`.
- For HTTP deployments, run:

```bash
MEDIA_MCP_SMOKE_URL=http://localhost:3000/mcp npm run smoke:http
```

## Contract Guardrails

- Request/search/preview tools must remain usable through MCP alone.
- Server results must not contain Discord callback IDs, modal routes, resident
  panel state, or top-level platform `components`.
- `view` and `requestDraft` changes must remain additive unless the release is
  explicitly a breaking contract release.
- Write tools must remain gated by `ALLOW_REQUESTS`.
- Preview tools must remain safe when writes are disabled.

Suggested boundary search:

```bash
rg -n "DiscordComponent|callbackData|callbackDataKind|media-panel:|components:" src README.md
```

Expected result: no matches except historical docs that explicitly describe a
removed experiment.

The request-flow tests also run recursive contract assertions against MCP tool
results so platform-specific keys fail fast during `npm test`.

## Deployment Notes

- Confirm `MEDIA_MCP_TRANSPORT=http` for container deployments.
- Confirm `/health` responds before wiring clients.
- Confirm `/mcp` responds to `tools/list` through `npm run smoke:http`.
- Keep client-specific panel/plugin releases separate from server releases
  unless both contracts intentionally change together.
