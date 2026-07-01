# Architecture Boundary Audit

Last reviewed: 2026-06-29

## Boundary

`media-mcp` is the backend/core media orchestration layer. It should stay useful
through direct MCP tool calls, Streamable HTTP MCP clients, automation jobs, and
future UI clients without requiring Discord.

The Discord panel plugin is an optional client. It owns Discord presentation and
interaction state.

## Belongs In `media-mcp`

- Normalized service reads for Sonarr, Radarr, Lidarr, Prowlarr, SABnzbd,
  Jellyfin, beets-flask, and slskd.
- Search, request options, request preview, gated request writes, and request
  follow-up workflows.
- Stack-specific orchestration logic, such as Sonarr episode follow-up counts,
  SABnzbd/Arr queue-history correlation, import issue classification, and
  expected health warnings.
- Safety gates, especially `ALLOW_REQUESTS`.
- Client-neutral contracts:
  - `summary`, `checkedAt`, `warnings`, and `errors`
  - `media-mcp.view.v1`
  - `media-mcp.requestDraft.v1`
  - `payloadPreview`
  - `followStatus`

## Belongs In The Discord Panel Plugin

- Discord component IDs, callback payloads, select values, modal routing, and
  button layout.
- Resident panel message state, message edits, refresh timers, and repair logic.
- Discord-specific formatting, colors, labels, emoji, pagination, and error
  display.
- Any local state needed to resume interactions from callback payloads.
- Translation from `view`, `requestDraft`, `payloadPreview`, and `followStatus`
  into Discord Components v2.

## Current Findings

- No active server code emits Discord callback IDs, modal routes, resident panel
  state, message edits, or ready-to-render Discord components.
- The useful server contracts are client-neutral. `view.actions` payloads name
  MCP tools and arguments, not platform callbacks.
- The old Discord component experiment is documented as history in the README;
  it is not part of the current runtime contract.
- The main drift was naming: the server helper was called `componentView`, which
  made a neutral view contract sound like a platform component contract.

## Changes From This Audit

- Renamed the internal view helper/type from `componentView`/`ComponentView` to
  `mediaView`/`MediaView`.
- Renamed option label truncation from `truncateComponentText` to
  `truncateOptionText`.
- Added recursive contract assertions to request-flow tests so MCP results fail
  if they contain platform keys such as `components`, `callbackData`,
  `callbackDataKind`, `modal`, `messageId`, or `channelData`.

## Cleanup Plan

1. Keep `media-mcp` server contracts additive and client-neutral.
2. Move any future platform-specific rendering or interaction state into the
   Discord plugin or another client.
3. Expand recursive contract guards to new workflow tests as new tools gain
   request-like flows.
4. Keep plugin and server releases separate unless both contracts intentionally
   change together.
5. Revisit Lidarr/music request support only after the movie and TV contracts
   stay stable through direct MCP usage.
