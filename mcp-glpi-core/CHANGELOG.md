# Changelog — @nextoolsolutions/mcp-glpi-core

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow semver.

## [Unreleased]

## [1.3.1] - 2026-10-04

### Fixed
- **Raw HTML in markdown tables for nested richtext.** `pickFields` flattens richtext only at the top
  level, so the API v2 timeline (`{type, item: {content: "<p>…</p>"}}`) reached the markdown summary
  as `<p>Olá <strong></strong>…`. In `format: "markdown"` (default `fields: "essential"`) the payload
  now goes through `flattenRichtext` before the view and the table: richtext fields are turned into
  text at any depth (up to 3 levels). The JSON result and `fields: "all"` keep the HTML as GLPI sent it.
- Table cells turn a run of line breaks into one space (a flattened paragraph left double spaces).

### Added
- `flattenRichtext(value, maxDepth = 3)` and `MARKDOWN_RICHTEXT_FIELDS` (`RICHTEXT_FIELDS` plus the
  validation comments `comment_submission`, `comment_validation`, `submission_comment`,
  `approval_comment`, which GLPI 11 stores as HTML).

## [1.3.0] - 2026-10-04

### Added
- `markdownViews` option of `installPayloadFormatting` and `columnView` / `MarkdownColumn` /
  `MarkdownView`: per-tool column projection for listings in `format: "markdown"` (only with the
  default `fields: "essential"`; the JSON result is never projected). The size budget measures the
  projected table, so more rows fit.

### Changed
- `ESSENTIAL_FIELDS.Ticket` keeps `requesters` and `assigned` (the `{id, name}` lists
  `mcp-glpi` 3.5.0 adds to ticket listings).

## [1.2.0] - 2026-10-04

### Added
- Size budget for every read tool (`installPayloadFormatting`): texts longer than
  `LIST_TEXT_MAX_CHARS` (300, `GLPI_LIST_TEXT_MAX_CHARS`) are cut in listings (except the ticket
  history listings in `FULL_TEXT_LISTS`, and with `fields: "all"`); an answer longer than
  `MAX_RESPONSE_CHARS` (50000, `GLPI_MAX_RESPONSE_CHARS`) is trimmed from the end of the list.
- `nextPageNote`: the pagination note names only the parameters the tool has (`range`, or
  `start`/`limit`) with the values of the next page, and uses `total` when the result carries it.
- `cutLongTexts`, `FULL_TEXT_LISTS`.

### Changed
- **`format: "markdown"` is carried in `structuredContent` too** (`{ data: "<markdown>",
  format: "markdown", count?, note? }`). Clients that support structured results hand that to
  the model, so a markdown text block alone was ignored. Sibling keys of `data` (e.g. `total`)
  are kept in the rendering. A single item renders as `key: value` lines without cutting texts;
  `{id, name}` references render as "name (id)".
- Results whose payload is the structured object itself (API v2 single items) are formatted
  too; before, `fields` and `format` were silently ignored on them.
- `TOOL_ITEMTYPES` holds API v1 tools only: v2 payloads use other field names and the v1
  whitelists stripped their relations (`entity`, `category`, `team`). v2 tools use the generic
  blocklist, which now also drops `*_duration` and `internal_*`.
- Whitelists keep keys ending in `_name` (names resolved by the server) and numeric keys (search
  columns). `glpi_search` is no longer a generic-itemtype tool.
- `MAX_PAGE_SIZE` default 200 -> 100. `paginationNote` no longer names a parameter.
- `errorResult` has no `structuredContent`: the MCP SDK client validates it against the output
  schema even on errors, which replaced every GLPI error message with a schema error.
- `sanitizeId` refuses an empty ID (it built the collection URL).

## [1.1.0] - 2026-10-04

### Added
- `FetchImpl` type and an optional `fetchImpl` argument on `fetchFn` / `fetchWithTimeout`:
  callers inject their own `fetch` (e.g. one that validates the resolved IP).
- `GlpiRedirectError` (extends `GlpiHttpError`, with `targetHost`) and `assertNotRedirect`.
- `titleFromToolName` and the `ToolAnnotationHints` type.

### Changed
- **Redirects are never followed.** Every request is sent with `redirect: "manual"`; a 3xx (or an
  opaque redirect) throws `redirect not followed: <status> -> <host>`. Only the host of the
  Location is reported, never its path or query. The Node polyfill now exposes `location`.
- **Annotations.** `annotationsFor(kind, toolName?)`: `openWorldHint` is now `false`;
  `idempotentHint` is `true` for reads, destructive tools and `update_*` / `set_*` writes.
  `destructiveHint` is `true` for deletes and for every write that is not additive
  (`update_*`, `set_*`, `change_*`, `retry_*`): the MCP spec defines `false` as "only additive
  updates", so only `create_*` / `add_*` stay non-destructive.
  `installWritePolicy` also sets `annotations.title` (the tool's `title`, or one derived from
  its name).
- LICENSE (MIT, NexTool Solutions) and CHANGELOG ship in the package.

## [1.0.0] - 2026-08-31

### Added
- Shared HTTP transport with retry/timeout, typed errors, tool-result helpers, write policy,
  payload formatting, pagination and create idempotency for the GLPI MCP servers.
