# Changelog — @nextoolsolutions/mcp-glpi-core

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow semver.

## [Unreleased]

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
