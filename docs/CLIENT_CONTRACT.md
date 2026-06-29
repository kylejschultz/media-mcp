# Media MCP Client Contract

`media-mcp` is the backend/core for media-stack orchestration. Clients call MCP
tools and render neutral JSON payloads. Platform-specific UI state belongs in
the client.

## Server Responsibilities

- Durable media operations across Sonarr, Radarr, Lidarr, Prowlarr, SABnzbd,
  Jellyfin, beets-flask, and slskd.
- Normalized service contracts for status, health, queues, history, missing
  media, import issues, indexers, library counts, disk space, and searches.
- Request flows for search, options, preview, gated writes, and follow-up
  lifecycle status.
- Safety gates such as `ALLOW_REQUESTS` and preview-before-write validation.
- Client-neutral rendering hints through `view` and request-building hints
  through `requestDraft`.

## Client Responsibilities

- Component IDs, callbacks, modal routing, resident message state, timers,
  formatting, colors, pagination, and message edits.
- Translating `view`, `requestDraft`, `candidates`, `payloadPreview`, and
  `followStatus` into platform UI.
- Persisting any client-local state needed to resume interactions.

The server must not emit Discord component IDs, callback payloads, modal
routes, message edit instructions, or ready-to-render platform components.

## Common Summary Envelope

Most high-level tools return these fields:

- `summary`: human-readable one-line outcome.
- `checkedAt`: ISO timestamp added by summary helpers.
- `warnings`: non-fatal issues.
- `errors`: fatal or tool-level issues when available.
- `view`: optional `media-mcp.view.v1` renderer hints.

Clients should treat raw tool-specific data as authoritative. `view` is
additive.

## `media-mcp.view.v1`

`view` groups result data for clients that want card-like rendering without
scraping prose.

- `schema`: always `media-mcp.view.v1`.
- `title`: short display title.
- `summary`: display summary, usually matching the top-level `summary`.
- `state`: optional result state.
- `cards`: grouped content areas.

Supported state kinds:

- `loading`
- `success`
- `empty`
- `partial_failure`
- `error`
- `confirm`

Card fields:

- `id`: stable client-neutral identifier.
- `title`: group title.
- `tone`: `ok`, `info`, `warning`, or `error`.
- `media`: optional image reference.
- `metrics`: compact label/value/tone entries.
- `items`: short rows with optional detail, value, tone, and media.
- `actions`: optional client-neutral action hints. Payloads name MCP tools and
  arguments, not platform callback IDs.

## `media-mcp.requestDraft.v1`

Request drafts describe how a client can build a movie or series request.

- `schema`: always `media-mcp.requestDraft.v1`.
- `kind`: `movie` or `series`.
- `service`: `radarr` or `sonarr`.
- `candidateOptions`: normalized search candidates.
- `selectedCandidate`: normalized selected movie or series for previews.
- `qualityProfileOptions`: available quality profiles.
- `rootFolderOptions`: available root folders.
- `tagOptions`: available tags.
- `monitorOptions`: Sonarr-only monitor modes.
- `defaults`: default field values for a request.
- `formFields`: generic select/checkbox descriptors.
- `request`: exact normalized request payload for previewed items.
- `writeGate`: write safety state, currently backed by `ALLOW_REQUESTS`.

`formFields` are generic descriptors. Clients decide whether they become
Discord selects, web controls, CLI prompts, or something else.

## Request Lifecycle

Core movie flow:

1. `search_movie`
2. choose `candidates[]` or `requestDraft.candidateOptions[]`
3. `preview_movie_request`
4. `request_movie` only when the user confirms and `writeGate.enabled` is true
5. `request_follow_status`

Core series flow:

1. `search_series`
2. choose `candidates[]` or `requestDraft.candidateOptions[]`
3. `preview_series_request`
4. `request_series` only when the user confirms and `writeGate.enabled` is true
5. `request_follow_status`

When writes are disabled, preview tools still return `payloadPreview` so clients
can present a dry-run result.

## Contract Tests

`npm test` includes MCP-only workflow coverage using an in-memory MCP client and
server. The tests assert that request tools expose neutral contracts and do not
return top-level `components`.
