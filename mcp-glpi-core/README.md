# @nextoolsolutions/mcp-glpi-core

Shared infrastructure for NexTool MCP for GLPI (`@nextoolsolutions/mcp-glpi`, API v1 and v2
families). It started as the byte-identical code the old `mcp-glpi` and `mcp-glpi-v2` servers
both carried.

> Not affiliated with Teclib'. GLPI is a registered trademark of Teclib'.

| Module | What it holds |
|--------|---------------|
| `http.ts` | Injectable fetch (`FetchImpl`), polyfill, timeout, redirect refusal, retry/backoff helpers, URL helpers, ID sanitisation |
| `errors.ts` | `GlpiHttpError` base class, `GlpiRedirectError`, `GlpiPolicyError` |
| `result.ts` | `toolResult` / `jsonResult` / `errorResult` / `makeWrap` |
| `policy.ts` | Write policy: read-only mode, delete gating, tool classification by name |
| `server-policy.ts` | Installs the policy and MCP annotations (title, read-only, destructive, idempotent, closed world) by wrapping `registerTool` |
| `format.ts` | HTML stripping, per-itemtype field whitelists (API v1), markdown rendering |
| `pagination.ts` | Range/limit defaults and ceiling, size budget constants, next-page notes |
| `server-format.ts` | Installs payload formatting, pagination and the size budget on read tools; markdown goes in the text and in `structuredContent` |
| `idempotency.ts` | Create idempotency key and store |
| `server-idempotency.ts` | Installs the create guard, including in-flight collapsing |

## Design note

The three `install*` functions wrap `server.registerTool` once, right after the server is
constructed, instead of editing 144 call sites. Every tool registered afterwards — present or
future — is covered, and misclassification fails the test suite rather than leaking a write.
They compose in any order.

## Transport guarantees

- `fetchFn(url, init, fetchImpl?)` / `fetchWithTimeout(...)` use the injected `fetchImpl`, else
  the global `fetch`, else a Node `http`/`https` polyfill.
- Requests always go out with `redirect: "manual"`. A 3xx throws `GlpiRedirectError`
  (`redirect not followed: <status> -> <host>`); the Location path and query never reach the
  message. Clients treat it as final (no retry).

## Read tool output (1.2.0)

- `format: "markdown"` is returned in the text block and in `structuredContent`
  (`{ data: "<markdown>", format: "markdown", count, note }`), for wrapped (`{ data }`) and
  unwrapped (API v2 item) payloads alike.
- Listings: at most `GLPI_MAX_PAGE_SIZE` (100) items, texts cut at `GLPI_LIST_TEXT_MAX_CHARS`
  (300) except in `FULL_TEXT_LISTS`, answer trimmed to `GLPI_MAX_RESPONSE_CHARS` (50000). The
  `note` names only the tool's own pagination parameters.
- `errorResult` carries no `structuredContent`, so validating clients show the error message.
- Markdown views (1.3.0): `installPayloadFormatting({ markdownViews })` maps a tool name to a row
  projection (`columnView([{ label, from }])`, `from` = a key, candidate keys or a function). In
  `format: "markdown"` with `fields: "essential"` the listing table shows only those columns; the
  JSON result and `fields: "all"` keep every field. The `Ticket` whitelist keeps `requesters` and
  `assigned` (people resolved by the server).
- Nested richtext in markdown (1.3.1): `flattenRichtext` turns HTML into text in richtext fields at
  any depth (the API v2 timeline's `item.content`, validation comments) before a markdown table or
  item is drawn; the JSON result and `fields: "all"` keep the HTML.

## Consuming it

`@nextoolsolutions/mcp-glpi` declares it as `^1.3.1`. Inside the repo its lockfile links the
sibling folder, so build here first — `tsx` does not transpile TypeScript inside
`node_modules`, the server loads the compiled `dist/`:

```bash
cd mcp-glpi-core && npm ci && npm run build    # after every change
```

Publish this package before any `mcp-glpi` release that needs a new core version.

## Tests

```bash
npm test    # node --test via tsx, no extra dependency
```
