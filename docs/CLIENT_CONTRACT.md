# Media MCP Client Contract

`media-mcp` is the backend/core for media-stack orchestration. Clients call MCP
tools and render neutral JSON payloads. Platform-specific UI state belongs in
the client.

## Server Responsibilities

- Durable media operations across Sonarr, Radarr, Lidarr, Prowlarr, SABnzbd,
  Jellyfin, beets-flask, slskd, Navidrome, and Subwave.
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

Dashboard/status tools should keep this envelope stable even when one
downstream service fails. In that case, the tool should return whatever data it
can, put non-fatal service errors in `warnings`, and set `view.state.kind` to
`partial_failure`.

Empty but successful tools should use `view.state.kind = "empty"` with a useful
empty label. Successful tools with renderable data should use `success`.

## Tool Families

- Status and health tools return `services[]` plus the common envelope.
- Queue tools return `services[]`, per-service `items[]`, and warnings for
  failed downstream queue lookups.
- Navidrome tools use the Subsonic API and return normalized search, scan, and
  library visibility data without exposing credentials.
- `music_genre_distribution` returns bounded `items[]` from the latest completed
  audit snapshot. Each item preserves one exact raw genre string alongside its
  conservative normalized key, counts, and up to five representative albums;
  clients must not assume comma- or semicolon-delimited tags were split. Empty
  and whitespace-only values are omitted and count as missing genres.
- `music_album_artwork_preview` accepts only `albumId`, `source` (`embedded` or
  `sidecar`), and a nonnegative `index`. Success returns exactly two MCP content
  parts: a concise JSON text envelope followed by an `image/jpeg` image part.
  The JSON contains the scan ID, human-readable album artist/title, hashes,
  original/preview dimensions, preview byte count, summary, warnings, errors,
  and `checkedAt`; it never contains base64. Clients
  must not expect original image bytes or caller-selected paths, URLs, sizes, or
  filenames. The tool is disabled unless both music audit and the separate
  artwork-preview gate are enabled on a trusted/private endpoint.
- Subwave tools return live station state, now-playing, streams, queue/history,
  and admin-read search/recent data when admin credentials are configured.
- Missing media tools return `services[]` with per-service `total` and sample
  items.
- Import issue tools return `queueIssues`, `failedHistory`,
  `resolvedFailedHistory`, and the common envelope.
- Overview tools compose the lower-level contracts and should stay
  client-neutral; they must not require a Discord panel to interpret the result.

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

## Music remediation manifests and transactions

Clients never submit library paths or complete manifests. First call
`music_remediation_art_digest` for reviewed CAA art; it returns decoded
SHA-256/dimensions but no image bytes. Then call `music_remediation_prepare`
with 1-10 latest-snapshot opaque album IDs, one/two approved genres, and either
the exact CAA URL plus reviewed SHA-256 or the snapshot's reviewed sidecar hash.

Media-mcp derives `music-remediation-manifest.v1` from the current snapshot,
positively verified read-only root, exact current whole-file hashes, embedded
hashes, MBID, and exactly one JPEG/PNG sidecar. It stores a canonical signed
envelope under `/config/music-remediation` and returns only its opaque
`manifestId`, digest, snapshot ID, and counts. Preview/apply accept that ID,
reload the file, verify its HMAC/digest with constant-time comparisons, require
the same latest snapshot, rehash current files, and send the signed envelope to
the overlay.

CAA manifests require `expected_sha256`; preview and apply download through the
same bounded CAA/Internet Archive policy and reject changed bytes. Apply also
requires a caller-generated 32-hex `operationId`, which becomes the transaction
ID for idempotent retry and timeout recovery. Replacement is journaled and
recoverable per file; it is not album- or batch-atomic. Before each live
replacement, its original is written to a same-directory temporary, fsynced,
SHA-256 verified, atomically committed, parent-fsynced, and recorded as
committed in the durable journal.

Rollback accepts only an `applied` transaction whose live files and beets DB
still exactly match its post-state. It refuses repeated rollback and later
edits. Before restoring any file it durably records `rolling_back`; the
explicit recovery path then idempotently resumes a mix of exact post/original
files and database rows using only committed, hash-reverified backups.
`music_remediation_status` returns one bounded transaction summary by operation
ID without paths; `music_remediation_recover` distinctly handles interrupted
`applying` restoration and `rolling_back` resumption. Failed applies that
restore cleanly become `failed_restored` and can be finalized.

Finalize accepts only `transactionId` from the MCP caller. Media-mcp obtains
the exact expected state from a bounded authenticated internal overlay route,
loads the latest completed audit snapshot, requires a different scan ID,
rehashes full files through the verified read-only audit root, and derives all
album IDs, track sets, ordered genres, embedded hashes, and sidecar path/hash.
It signs that canonical attestation with the shared manifest HMAC key. The
overlay checks the HMAC in constant time and requires exact journal-state
equality before deletion, so a bearer-authenticated direct caller cannot supply
a fabricated scan or state. It persists `finalizing` before backup deletion and
reconciles interrupted finalize at mutation-enabled startup or on finalize
retry while re-verifying file/metadata/database state; status does not perform
that mutation.

Mutations require both MCP write gates and the overlay's independent,
false-by-default `BEETS_REMEDIATION_WRITES_ENABLED` and
`BEETS_REMEDIATION_MAINTENANCE` assertions; bearer authentication is not a
write gate. The overlay fails closed unless its installed beets-flask RQ queues
have no queued, scheduled, or started jobs, and repeats that check before live
replacement and DB synchronization. Operators must separately stop unrelated
writers/watchdogs because they do not honor the overlay lock. v1 requires
exactly one existing supported sidecar and
fails closed otherwise. Directory-FD/`O_NOFOLLOW` operations and immediate
parent identity rechecks reduce races, but the trusted-library-owner assumption
remains: no hostile actor may have concurrent rename/write access to validated
parent directories during the final syscall window.

## Request Lifecycle

Core movie flow:

1. `search_movie`
2. choose `candidates[]` or `requestDraft.candidateOptions[]`
3. `preview_movie_request`
4. `request_movie` only when the user confirms and `writeGate.enabled` is true
5. `request_follow_status`

Existing movie monitoring flow:

1. resolve an existing movie by `tmdbId`
2. `set_movie_monitoring` with `monitored` and optional `searchNow`
3. use the returned `lifecycle` envelope and optionally poll
   `request_follow_status`

Core series flow:

1. `search_series`
2. choose `candidates[]` or `requestDraft.candidateOptions[]`
3. `preview_series_request`
4. `request_series` only when the user confirms and `writeGate.enabled` is true
5. `request_follow_status`

Specific season flow:

1. resolve a series by `tvdbId`
2. use `set_series_season_monitoring` for an existing series, or
   `request_series_season` when the series may need to be added
3. pass `seasonNumber`, `monitored`, and optional `searchNow`
4. use returned `expectedEpisodeCount` with `request_follow_status`

Specific season writes are scoped. Updating or requesting season `N` must not
change monitoring on other existing seasons. When `request_series_season` adds a
missing series, only the requested season is monitored.

When writes are disabled, preview tools still return `payloadPreview` so clients
can present a dry-run result.

## `media-mcp.lifecycle.v1`

Lifecycle tools return a `lifecycle` object for write-side state changes that do
not fit the preview request draft model.

Common fields:

- `schema`: always `media-mcp.lifecycle.v1`.
- `service`: `radarr` or `sonarr`.
- `mediaType`: `movie` or `series`.
- `action`: stable action name such as `set_monitoring` or
  `set_season_monitoring`.
- `target`: identifiers and display title for the movie, series, or season.
- `monitored`: final monitored state requested by the caller.
- `searchStarted`: whether the tool posted an Arr search command.
- `expectedEpisodeCount`: present when a season target has usable episode stats.

## `media-mcp.followStatus.v1`

`request_follow_status` returns a `followStatus` object for polling a requested
movie or series after the write tool returns.

Stable follow phases:

- `requested`: request was accepted, but no queue/history activity is visible.
- `grabbed`: Arr history shows the release was grabbed.
- `queued`: the item is active in the Arr queue.
- `downloading`: the item is active in SABnzbd or multiple Sonarr episode
  downloads are active.
- `importing`: download/history activity exists, but expected imports are not
  complete yet.
- `imported`: import completed.
- `failed`: unresolved failure found.

Common fields:

- `schema`: always `media-mcp.followStatus.v1`.
- `phase`: one of the stable phases above.
- `service`: `radarr` or `sonarr`.
- `mediaType`: `movie` or `series`.
- `title`: display title used for tracking.
- `complete`, `failed`, and `terminal`: booleans for client control flow.
- `expectedEpisodeCount`, `activeCount`, and `importedCount`: count hints,
  especially useful for Sonarr multi-episode requests.
- `queueCount` and `historyCount`: source counts split by Arr service and
  SABnzbd.
- `nextPollRecommended`: false for terminal phases.
- `pollDelaySeconds`: additive polling hint for clients that want backoff.

## Contract Tests

`npm test` includes MCP-only workflow coverage using an in-memory MCP client and
server. The tests assert that request tools expose neutral contracts and do not
return top-level `components`.
