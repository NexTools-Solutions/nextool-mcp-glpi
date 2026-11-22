# Changelog

Releases are tagged `v<mcp-glpi version>`. Details per package:
[mcp-glpi/CHANGELOG.md](mcp-glpi/CHANGELOG.md) and [mcp-glpi-core/CHANGELOG.md](mcp-glpi-core/CHANGELOG.md).

## [Unreleased]

## [3.7.0] - 2026-11-22

### Added
- `v1Compat` (library option of `instanceFromConfig`): an instance with only API v2 credentials also serves the
  everyday ticket tools under their **v1 names and v1 input schemas**, running on the v2 API:
  `glpi_list_my_tickets`, `glpi_list_tickets`, `glpi_get_ticket`, `glpi_create_ticket`, `glpi_update_ticket`,
  `glpi_add_followup`, `glpi_list_followups`, `glpi_add_solution`, `glpi_list_ticket_tasks`, `glpi_add_ticket_task`,
  `glpi_list_timeline`, `glpi_list_ticket_users` and `glpi_get_full_session`. For clients that froze a v1 tool list
  (the ChatGPT app directory) talking to a v2-only connection. "My tickets" reads the team of each ticket, since the
  v2 API cannot filter on it (up to 1,000 tickets in the chosen statuses); requester/technician fields of a v1 create
  are reported as `ignored_fields` (the team endpoint needs rights a technician usually lacks). Off by default, and
  ignored when the instance also has v1 credentials.

## [3.6.1] - 2026-11-21

### Fixed
- `glpi_v2_add_followup` and `glpi_v2_add_solution` failed with 404 on GLPI 11: they posted to
  `/{itemtype}/{id}/Timeline` with a `type` field, and GLPI only creates these items at
  `/Timeline/Followup` and `/Timeline/Solution`. Both tools now use those routes (and no longer send `type`).

## [3.6.0] - 2026-11-18

### Added
- Library: the API v2 can use an access token supplied by the host (`accessTokenProvider` + `cacheKey`) instead of
  the OAuth2 password grant. The password grant is unchanged and still the default.

### Fixed
- `glpi_v2_get_me` works for profiles without the right to read users (falls back to the session identity).
- No tool input schema contains a `$ref` any more; a contract test forbids it.

## [3.5.7] - 2026-11-04

### Fixed
- `glpi_get_asset_details` description states when to use the tool, the required asset lookup, default and optional
  sections (only `devices` and `disks` by default), the large-result limitation and read-only behavior.
- The MCP server identity version now follows the package version.

## [3.5.6] - 2026-11-04

### Fixed
- Ticket statistics include nonstandard status counts, preserve OR scopes and flag inconsistent aggregate reads.


## [3.5.5] - 2026-10-05
- Clearer description for `glpi_get_asset_details` (flagged by the OpenAI plugin scan). First release published to npm
  through trusted publishing (OIDC), without a token.

## [3.5.4] - 2026-10-05
- `openWorldHint: true` on every tool (core 1.3.2): GLPI is an external system (flagged by the OpenAI plugin scan).

## [3.5.3] - 2026-10-05
- Every tool parameter now has a description (four were missing), enforced by a contract test.

## [3.5.2] - 2026-10-04
- MCP Registry name `com.nextoolsolutions/glpi` (domain-verified) with the hosted server as a remote
  (`https://mcp.nextoolsolutions.com/mcp`); the release workflow signs in to the registry by DNS
  (secret `MCP_PRIVATE_KEY`) instead of GitHub OIDC.
- Directory files: `glama.json` (Glama maintainers), `Dockerfile` (stdio server, starts and lists tools
  without GLPI credentials), Cursor plugin (`.cursor-plugin/plugin.json` + `mcp.json`) and an
  "Add to Cursor" link in the README. No change in tools or behaviour.

## [3.5.1] - 2026-10-04
- `glpi_v2_list_timeline` honours `start`/`limit` (the endpoint ignores them; the page is cut by the
  server) and returns `total`.
- `glpi_search` labels coded columns in the GLPI language and keeps the code under `"<name> (id)"`.
- API v2: `priority_name`, `urgency_name`, `impact_name`, `type_name` beside the codes (language taken
  from the status labels the API returns); timeline `status_name`/`state_name`; markdown tables use
  the labels.
- Markdown shows nested richtext as text (v2 timeline summaries had raw HTML). Core 1.3.1.

## [3.5.0] - 2026-10-04
- `glpi_search` returns column names (in the GLPI language) by default; `named_columns: false` for IDs.
- v1 labels (status, type, priority, actor role, validation) in the GLPI session language, with GLPI's
  own texts (pt_BR, pt_PT, es_ES, fr_FR, it_IT, de_DE; English fallback), matching the API v2.
- Compact markdown tables per kind of listing (tickets: id, title, status, category, requester,
  technician, priority, updated; timeline: one line per entry). JSON unchanged.
- User/group creation and changes moved out of the `users` preset: administration with writes only in `admin`.
- `instructions` name only the tools the server registered. Core 1.3.0.

## [3.4.0] - 2026-10-04
- `glpi_list_my_tickets` ("my tickets": requester, assigned or observer; open, latest first) and
  `status`/`sort`/`order` on `glpi_list_tickets` (latest update first by default; same `status` on v2).
- Names next to IDs on ticket actors, groups, followups, tasks, validations, timeline and ticket.
- `format: "markdown"` works on every read tool (also in `structuredContent`); size-bounded
  listings with pagination notes that name only real parameters; strict integer IDs.
- Self-contained presets (search and people reads in `tickets`), checked by tests.
- Fixes: `glpi_search` empty in essential mode, rule criteria/actions 400, rule list mixing types,
  v2 session/health 404, errors hidden from validating clients. Core 1.2.0.

## [3.3.1] - 2026-10-04
- Descriptions and npm keywords centered on GLPI (tickets, ITIL, assets, knowledge base, GLPI 10/11).

## [3.3.0] - 2026-10-04
- Configurable server identity (`serverInfo`) and model `instructions` in `initialize`; default instructions and website.

## [3.2.0] - 2026-10-04
- First open-source release: library API, tool presets (`GLPI_TOOLSETS`), MCP annotations on every tool,
  injectable `fetch` with redirects refused, core 1.1.0.
