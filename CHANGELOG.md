# Changelog

Releases are tagged `v<mcp-glpi version>`. Details per package:
[mcp-glpi/CHANGELOG.md](mcp-glpi/CHANGELOG.md) and [mcp-glpi-core/CHANGELOG.md](mcp-glpi-core/CHANGELOG.md).

## [Unreleased]

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
