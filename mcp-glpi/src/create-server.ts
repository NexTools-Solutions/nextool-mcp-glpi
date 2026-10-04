/**
 * Builds a complete GLPI MCP server for one instance: safety layers, the tool
 * families its credentials enable, resources and prompts.
 *
 * Used once by the stdio entry (index.ts) and once per session by the HTTP
 * entry (http.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  MIN_REASON_LENGTH,
  describePolicy,
  installIdempotency,
  installPayloadFormatting,
  installWritePolicy,
  type FetchImpl,
  type IdempotencyStore,
} from "@nextoolsolutions/mcp-glpi-core";
import type { InstanceConfig } from "./instance.js";
import { registerResources } from "./resources.js";
import { buildPrompts, registerPrompts } from "./prompts.js";
import { installToolFilter, parseGlobList } from "./tool-filter.js";
import { toolsetMatcher } from "./toolsets.js";
import { registerV1Tools } from "./tools-v1.js";
import { registerV2Tools } from "./tools-v2.js";

export const SERVER_VERSION = "3.3.0";

export interface CreatedServer {
  server: McpServer;
  /** One line for the log: policy, families and tool count. */
  summary: string;
}

export interface CreateServerOptions {
  /**
   * Create-idempotency store. The HTTP entry shares one per instance across
   * sessions, so a retry that arrives on a new session is still recognised.
   */
  idempotencyStore?: IdempotencyStore;
  /**
   * fetch for every GLPI request of this server (overrides `instance.fetchImpl`).
   * Always called with `redirect: "manual"`; a 3xx becomes GlpiRedirectError.
   */
  fetchImpl?: FetchImpl;
  /**
   * Overrides of the identity sent in `initialize` (serverInfo): a host embedding this server can
   * present its own title, description, website and icons. `version` stays the package version.
   */
  serverInfo?: Partial<Pick<Implementation, "name" | "title" | "description" | "websiteUrl" | "icons">>;
  /** Text sent as `instructions` in `initialize` (guidance for the model). Default: DEFAULT_INSTRUCTIONS. */
  instructions?: string;
}

/** Guidance for the model: what the tools cover and how to use them well. */
export const DEFAULT_INSTRUCTIONS =
  "Tools to work with a GLPI service desk (GLPI 10 and 11). glpi_* use the REST API v1, glpi_v2_* the GLPI 11 API v2. " +
  "Typical flow: find tickets with glpi_list_tickets or glpi_search, open one with glpi_get_ticket, read its history with " +
  "glpi_list_timeline (or followups/tasks/solutions), then act: add followups, tasks or solutions, update fields, assign users or groups. " +
  "Also available, depending on the enabled presets: problems and changes, assets, knowledge base, users, groups, entities, documents, " +
  "rules and webhooks. Every action runs with the GLPI permissions of the connected user. Tools are annotated: read-only tools never " +
  "change data; confirm with the user before any write. Deletes are disabled unless the server allows them and then require a reason. " +
  "Use IDs returned by list/search tools; do not guess them. Ask the user before changing many records at once.";

export function createGlpiServer(instance: InstanceConfig, opts: CreateServerOptions = {}): CreatedServer {
  const fetchImpl = opts.fetchImpl ?? instance.fetchImpl;
  const v1 = fetchImpl ? { ...instance.v1, fetchImpl } : instance.v1;
  const v2 = fetchImpl ? { ...instance.v2, fetchImpl } : instance.v2;

  const server = new McpServer(
    {
    name: "mcp-glpi",
    title: "NexTool MCP for GLPI",
    websiteUrl: "https://github.com/NexTools-Solutions/nextool-mcp-glpi",
    description:
      "NexTool MCP server that connects AI assistants to GLPI — REST API v1 (glpi_*: tickets, changes, problems, unified timeline, " +
      "validations, assets and reservations, webhooks, users, groups, entities, documents, " +
      "knowledge base, rules and search) and GLPI 11 API v2 (glpi_v2_*), each enabled by its own " +
      "credentials. Read tools return trimmed payloads; writes and deletes are gated by policy.",
    ...opts.serverInfo,
    version: SERVER_VERSION,
    },
    { instructions: opts.instructions ?? DEFAULT_INSTRUCTIONS },
  );

  // Write policy — annotations + read-only / delete gating for every tool below.
  // Must run before the first registerTool call.
  installWritePolicy(server, {
    policy: instance.policy,
    reasonSchema: z
      .string()
      .min(MIN_REASON_LENGTH)
      .describe("Why this item is being deleted (audit trail, required)"),
  });

  // Payload formatting — adds `fields` and `format` to read tools, filters
  // internal GLPI bookkeeping out of results and applies pagination defaults.
  installPayloadFormatting(server, {
    fieldsSchema: z
      .enum(["essential", "all"])
      .optional()
      .describe("Field set: 'essential' (default, trims internal GLPI fields) or 'all'"),
    formatSchema: z
      .enum(["json", "markdown"])
      .optional()
      .describe("Text rendering: 'json' (default) or 'markdown' table for long listings"),
    // Aggregates, not GLPI items: their payload must not be run through the
    // whitelist of the itemtype they happen to take as an argument.
    skipFormatting: ["glpi_count_items", "glpi_get_ticket_stats", "glpi_list_search_options"],
    // Keys this layer adds to the result, declared so validating clients accept it.
    outputExtras: {
      count: z.number().int().optional().describe("Items in this page"),
      note: z.string().optional().describe("Pagination hint: how to fetch the next page"),
    },
  });

  // Create idempotency — a retried create must not open a second ticket. Keyed
  // by instance id, not URL: two clients of the same GLPI never get each
  // other's replayed result.
  installIdempotency(server, {
    instance: instance.id,
    store: opts.idempotencyStore,
    replayedSchema: z.boolean().optional().describe("True when an identical recent create was returned instead of repeated"),
  });

  // Tool selection — installed last so a dropped tool never reaches the layers above.
  const filter = installToolFilter(server, {
    include: parseGlobList(instance.toolsInclude),
    exclude: parseGlobList(instance.toolsExclude),
    inToolsets: instance.toolsets?.length ? toolsetMatcher(instance.toolsets) : undefined,
  });

  if (instance.enableV1) registerV1Tools(server, v1);
  if (instance.enableV2) registerV2Tools(server, v2);

  // Catalogues an agent needs before composing a ticket (entities, categories,
  // request types) plus the numeric code maps, which the API cannot return.
  if (instance.enableV1) {
    registerResources(server, v1);
    registerPrompts(
      server,
      buildPrompts({
        ticketId: z.string().describe("Item ID"),
        optionalText: z.string().optional().describe("Optional extra context"),
        requiredText: z.string().describe("Value"),
      }),
    );
  }

  const families = [instance.enableV1 && "v1", instance.enableV2 && "v2"].filter(Boolean).join(" + ");
  const toolsets = instance.toolsets?.length ? ` | toolsets: ${instance.toolsets.join(",")}` : "";
  const filtered = filter.dropped() ? ` (${filter.dropped()} filtered out)` : "";
  const summary =
    `write policy: ${describePolicy(instance.policy)} | families: ${families}${toolsets}` +
    ` | tools: ${filter.registered()}${filtered}`;
  return { server, summary };
}
