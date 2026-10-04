# Changelog — @nextoolsolutions/mcp-glpi

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow semver.

## [Unreleased]

## [3.4.0] - 2026-10-04

Fixes from a real session with Claude ("list my tickets" returned February tickets, people as
bare numbers, `format: "markdown"` ignored, a tool pointing at another outside its preset, an
invalid ID returning a listing, a 116k-character answer). Checked live on GLPI 11.0.7 (API v1
and v2), read-only.

### Added
- **`glpi_list_my_tickets`**: the connected user's tickets (`getFullSession` -> `glpiID`, or
  `users_id`) as requester, assigned technician or observer (`role`, default any), open by
  default, latest update first. Search with a nested OR group on options 4/5/66; actors come back
  as `{id, name}`, plus `status_name`, `type_name`, `my_roles`, `total` and `user`.
- `glpi_list_tickets`: `status` (`new`, `assigned`/`processing`, `planned`, `pending`, `solved`,
  `closed`, `open` = not solved nor closed), `sort` and `order`. Default order is now latest
  update first (`sort=date_mod&order=DESC`; it was id ascending). With a status filter the tool
  searches for the IDs and returns the full items (`getMultipleItems`) plus `total`.
- `glpi_v2_list_tickets`: the same `status` names (RSQL `status.id=in=(...)`, ANDed with
  `filter`); v2 ticket/change/problem listings sort by `date_mod:desc` by default.
- `glpi_list_changes` / `glpi_list_problems`: `sort` and `order`, latest update first by default.
- Names next to IDs (IDs kept): `user_name`/`type_name` on `glpi_list_ticket_users`,
  `group_name`/`type_name` on `glpi_list_ticket_groups`, `user_name` on followups,
  `user_name`/`tech_name`/`tech_group_name` on tasks, `user_name`/`validator_name`/`status_name`
  on validations, all of them on `glpi_list_timeline` (plus `solutiontype_name` and
  `user_name_approval`, empty in GLPI 11), and `recipient_name`, `category_name`, `entity_name`,
  `requesttype_name`, `location_name`, `status_name`, `type_name` on `glpi_get_ticket`. Resolved
  with GET /<itemtype>/<id>, 5-minute cache per credential (`src/names.ts`).
- `glpi_get_ticket`: `expand_dropdowns`.
- `glpi_search`: `sort`, `order`, `named_columns`; nested criteria groups (`{link, criteria: [...]}`)
  are encoded correctly (they were sent as `[object Object]`). Result: `{ data: rows, total }`.
- `glpi_list_timeline`: `order` (`desc` = latest first).
- Contract tests (`test/contracts.test.ts`): every tool named in a description, a parameter or a
  generated note exists and is in every preset of the tool naming it; notes name only the tool's
  own parameters; every tool advertising `format` returns markdown in text and
  `structuredContent`; every ID parameter rejects non-IDs without calling GLPI; GLPI errors reach
  validating clients.

### Changed
- **Presets are self-contained.** `tickets` adds `glpi_list_my_tickets`, `glpi_search`,
  `glpi_list_search_options` and the people reads (`glpi_get_user`, `glpi_search_user_by_email`,
  `glpi_list_users`, `glpi_get_group`, `glpi_list_groups`, `glpi_v2_get_user`, `glpi_v2_get_me`,
  `glpi_v2_get_group`); `itil` adds the people reads; `assets` adds `glpi_search` and
  `glpi_list_search_options`; `core` adds the new reads. Counts: core 92 -> 93, tickets 42 -> 53,
  itil 38 -> 46, assets 13 -> 15.
- Prompts are registered only when every tool they name is registered. `requester_history` uses
  `glpi_list_my_tickets` (with `users_id`) and `glpi_list_timeline`.
- **Item IDs are positive integers** (number or digit string; entity IDs may be 0) in every v1 and
  v2 tool (`src/ids.ts`). `"abc"` used to reach GLPI as `/ITILCategory/abc` and come back as the
  first page of the collection.
- `glpi_search_user_by_email` returns the user items (login, names), not search columns.
- `glpi_list_webhook_deliveries`: newest first, same row shape with or without filters.
- `glpi_list_timeline`: `range` pages the merged timeline (each part was paged separately).
- `glpi_get_ticket_stats` describes its criteria inline (entity, requester, technician, category).
- Default `instructions` mention `glpi_list_my_tickets` and that tool names depend on presets.
- Core `^1.2.0` (markdown in `structuredContent`, size budget, error results, formatting of v2 items).

### Fixed
- **`glpi_search` and `glpi_search_user_by_email` returned `{"data": {}}`** in the default
  `essential` mode: the itemtype whitelist stripped the search envelope and every column.
- `format: "markdown"` was ignored by clients that read `structuredContent` and on every v2
  single-item tool (and `fields` did nothing there either).
- v2 listings in `essential` mode lost `entity`, `category`, `team` and the requester objects (a v1
  whitelist was applied to v2 payloads).
- `glpi_list_rule_ticket_criteria` / `glpi_list_rule_ticket_actions` always answered 400: the
  sub-itemtypes are `RuleCriteria` / `RuleAction`.
- `glpi_list_rules` listed every rule type (177 rules, 15 of them ticket rules, on the test
  instance); it now filters `sub_type` RuleTicket.
- `glpi_list_webhook_deliveries` with `only_failed`: `morethan` is not a searchtype of
  `sent_try`, so GLPI ignored it; failed now means retried (`sent_try > 1`) or last status >= 300.
- `glpi_v2_get_session` and `glpi_v2_health_check` called the GLPI root (`/session`, `/status`)
  and always got 404; they use the API prefix. Health check falls back to the session when
  `/status` lacks the OAuth `status` scope.
- `glpi_v2_get_me` answered 403 with the default `api` scope; it falls back to the session user.
- `glpi://code-maps` validation status was shifted (3 is Accepted, not Refused).

## [3.3.1] - 2026-10-04

### Changed
- Descriptions (server `initialize`, npm, MCP Registry) and npm keywords centered on GLPI (tickets, ITIL, assets, knowledge base, GLPI 10/11), so searches for GLPI find this server.

## [3.3.0] - 2026-10-04

### Added
- `createGlpiServer(instance, { serverInfo, instructions })`: a host can override the identity sent in `initialize` (title, description, websiteUrl, icons; `version` stays the package version) and the `instructions` for the model.
- Default `instructions` (`DEFAULT_INSTRUCTIONS`, exported) describing what the tools cover and how to use them safely, and `websiteUrl` pointing at the public repository.

## [3.2.0] - 2026-10-04

### Added
- **Library API.** The package root (`exports["."]`, `dist/lib.js`) exports `createGlpiServer`,
  `SERVER_VERSION`, `instanceFromConfig`, `instanceFromEnv`, the `InstanceConfig` /
  `InstanceEnv` / `InstanceOptions` types, `TOOLSETS` / `TOOLSET_NAMES` / `parseToolsets`, the
  error classes and `IdempotencyStore`. Importing it starts no transport; the stdio and HTTP
  servers stay in the `mcp-glpi` and `mcp-glpi-http` bins.
- `instanceFromConfig({ id, v1, v2, policy, toolsets, toolsInclude, toolsExclude, fetchImpl })`
  builds an instance from a plain object, without `process.env`; invalid id/URL, unknown
  toolsets and a missing family throw.
- **Injectable fetch.** `fetchImpl` on `instanceFromConfig` and on `createGlpiServer` options
  reaches every GLPI request: v1 `initSession` and calls, v2 OAuth token and calls, assets and
  webhooks.
- **Named toolsets.** `GLPI_TOOLSETS` (and the `toolsets` option): `core`, `tickets`, `itil`,
  `assets`, `kb`, `documents`, `users`, `search`, `admin`, `v2`. Toolsets and include globs add
  up; exclude still wins; an unknown name fails at startup. `core` = reads of the everyday
  presets plus the non-destructive ticket operations. Tests assert every tool is in a preset.
- Server `title` "NexTool MCP for GLPI" in the MCP implementation info.

### Changed
- **Redirects are never followed** (via mcp-glpi-core 1.1.0): a 3xx from GLPI returns
  `redirect not followed: <status> -> <host>` and is not retried.
- **v2 client: no absolute URLs to other hosts.** `glpiV2Request` accepts relative paths; an
  absolute URL is accepted only on the `GLPI_V2_URL` origin, otherwise it is refused before any
  request (including the token request). Raw paths are normalised so they cannot change host.
- **MCP annotations** (via mcp-glpi-core 1.1.0): every tool now also carries `title`,
  `idempotentHint` (reads, `update_*`/`set_*`, deletes) and `openWorldHint: false`.
- Product name "NexTool MCP for GLPI" in `server.json` and README, with the notice "Not
  affiliated with Teclib'. GLPI is a registered trademark of Teclib'."; `server.json`
  description rewritten (it was cut at 100 characters); `GLPI_TOOLSETS` declared there.
- LICENSE (MIT) copyright holder: NexTool Solutions.
- Dependency on the core is now semver (`^1.1.0`) instead of `file:../mcp-glpi-core`; inside
  the repo the lockfile still links the sibling folder (see README, Development).
- `package.json` `main`/`types` point to the library entry; `CHANGELOG.md` ships in the package.

## [3.1.0] - 2026-10-04

### Added
- HTTP entry (`mcp-glpi-http`): Streamable HTTP at `/mcp/<instance>`, many instances from
  `MCP_INSTANCES_FILE`, mandatory `Authorization: Bearer` keys stored as SHA-256, per-credential
  GLPI session/OAuth/catalogue caches, per-instance idempotency, JSON audit line per request.

## [3.0.0] - 2026-10-04

### Changed
- The API v2 server (`mcp-glpi-v2`) merged into this package: `glpi_v2_*` tools, same names
  and schemas, enabled by `GLPI_V2_URL`. `GLPI_TOOLS_INCLUDE` / `GLPI_TOOLS_EXCLUDE` added.
