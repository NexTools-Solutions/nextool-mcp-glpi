#!/usr/bin/env node

/**
 * NexTool MCP for GLPI — stdio entry (one instance, credentials from the environment).
 * The HTTP entry, which serves many instances behind authentication, is http.ts.
 *
 * Two tool families, each switched on by its own credentials:
 *   - `glpi_*`    (110 tools) — REST API v1 (apirest.php or api.php/v1), GLPI 9.5/10/11:
 *     tickets, changes, problems, timeline, validations, tasks, assets, reservations,
 *     webhooks, users, groups, documents, knowledge base, entities, rules, search.
 *   - `glpi_v2_*` (55 tools)  — High-level API v2 (OAuth2), GLPI 11.
 * Both run through the same write policy, payload formatting and create idempotency.
 *
 * Environment variables — API v1 family (enabled when GLPI_URL is set):
 *   GLPI_URL                   — GLPI instance URL
 *   GLPI_USER_TOKEN            — API User Token
 *   GLPI_APP_TOKEN             — API Application Token (optional)
 *
 * Environment variables — API v2 family (enabled when GLPI_V2_URL is set):
 *   GLPI_V2_URL, GLPI_V2_CLIENT_ID, GLPI_V2_CLIENT_SECRET, GLPI_V2_USERNAME,
 *   GLPI_V2_PASSWORD           — OAuth2 password grant
 *   GLPI_V2_SCOPE              — OAuth2 scope (default: api)
 *   GLPI_V2_API_VERSION        — API version path (default: v2)
 *
 * Tool selection (optional; toolsets and include globs add up, exclude wins):
 *   GLPI_TOOLSETS              — named presets: core, tickets, itil, assets, kb, documents,
 *                                users, search, admin, v2 (e.g. "tickets,kb")
 *   GLPI_TOOLS_INCLUDE         — also register matching tools (e.g. "glpi_*ticket*,glpi_search")
 *   GLPI_TOOLS_EXCLUDE         — drop matching tools (e.g. "*webhook*,*rule*")
 *
 * Shared:
 *   GLPI_READ_ONLY             — block writes and deletes (default: false)
 *   GLPI_ALLOW_DELETE          — enable destructive tools (default: false)
 *   GLPI_REQUIRE_DELETE_REASON — require a reason on deletes (default: true)
 *   GLPI_DEFAULT_PAGE_SIZE     — items when no range is given (default: 25)
 *   GLPI_MAX_PAGE_SIZE         — ceiling per call (default: 200)
 *   GLPI_IDEMPOTENCY_WINDOW    — seconds a create is replayed (default: 120)
 *   GLPI_RESOURCE_CACHE_TTL    — resource cache TTL in ms (default: 300000)
 *   GLPI_MAX_RETRIES           — max retry attempts on 429/5xx (default: 3)
 *   GLPI_TIMEOUT               — request timeout in ms (default: 30000)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGlpiServer } from "./create-server.js";
import { instanceFromEnv } from "./instance.js";

const instance = instanceFromEnv("stdio", process.env);
const { server, summary } = createGlpiServer(instance);
process.stderr.write(`[mcp-glpi] ${summary}\n`);

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[mcp-glpi] Failed to start: ${msg}\n`);
  process.exit(1);
}
