# Changelog

Releases are tagged `v<mcp-glpi version>`. Details per package:
[mcp-glpi/CHANGELOG.md](mcp-glpi/CHANGELOG.md) and [mcp-glpi-core/CHANGELOG.md](mcp-glpi-core/CHANGELOG.md).

## [Unreleased]

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
