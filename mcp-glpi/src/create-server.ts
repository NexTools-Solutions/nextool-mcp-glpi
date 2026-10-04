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
import { buildInstructions } from "./instructions.js";
import { MARKDOWN_VIEWS } from "./markdown-views.js";
import { installToolFilter, isToolSelected, parseGlobList, type ToolFilterOptions } from "./tool-filter.js";
import { toolsetMatcher } from "./toolsets.js";
import { registerV1Tools } from "./tools-v1.js";
import { registerV2Tools } from "./tools-v2.js";

export const SERVER_VERSION = "3.5.1";

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
  /**
   * Text sent as `instructions` in `initialize` (guidance for the model). Default: built from the tools
   * this server registers (`buildInstructions`), so it never names a tool the preset left out.
   */
  instructions?: string;
}

/** Every tool name a family registers, collected once by registering against a recorder. */
const familyTools: { v1?: string[]; v2?: string[] } = {};

function toolNamesOf(family: "v1" | "v2"): string[] {
  const cached = familyTools[family];
  if (cached) return cached;
  const names: string[] = [];
  const recorder = { registerTool: (name: string) => void names.push(name) } as unknown as McpServer;
  if (family === "v1") registerV1Tools(recorder, { baseUrl: "", userToken: "" });
  else registerV2Tools(recorder, { baseUrl: "", clientId: "", clientSecret: "", username: "", password: "", scope: "api" });
  familyTools[family] = names;
  return names;
}

/**
 * Guidance for the model with every tool of both families registered. A server
 * with a preset gets the same text cut down to its tools (see buildInstructions).
 */
export const DEFAULT_INSTRUCTIONS = buildInstructions([...toolNamesOf("v1"), ...toolNamesOf("v2")], { v1: true, v2: true });

export function createGlpiServer(instance: InstanceConfig, opts: CreateServerOptions = {}): CreatedServer {
  const fetchImpl = opts.fetchImpl ?? instance.fetchImpl;
  const v1 = fetchImpl ? { ...instance.v1, fetchImpl } : instance.v1;
  const v2 = fetchImpl ? { ...instance.v2, fetchImpl } : instance.v2;

  // Tool selection, decided up front so the instructions name only registered tools.
  const filterOptions: ToolFilterOptions = {
    include: parseGlobList(instance.toolsInclude),
    exclude: parseGlobList(instance.toolsExclude),
    inToolsets: instance.toolsets?.length ? toolsetMatcher(instance.toolsets) : undefined,
  };
  const selected = [
    ...(instance.enableV1 ? toolNamesOf("v1") : []),
    ...(instance.enableV2 ? toolNamesOf("v2") : []),
  ].filter((name) => isToolSelected(name, filterOptions));
  const instructions =
    opts.instructions ?? buildInstructions(selected, { v1: instance.enableV1, v2: instance.enableV2 });

  const server = new McpServer(
    {
    name: "mcp-glpi",
    title: "NexTool MCP for GLPI",
    websiteUrl: "https://github.com/NexTools-Solutions/nextool-mcp-glpi",
    description:
      "MCP server for GLPI by NexTool Solutions: connects AI assistants to the GLPI service desk / ITSM (GLPI 10 and 11, REST API v1 tools glpi_* and GLPI 11 API v2 tools glpi_v2_*). GLPI tickets (search, create, update, follow-ups, tasks, solutions, approvals/validations, timeline, statistics), GLPI problems and changes (ITIL), GLPI assets and inventory (computers, monitors, printers, network equipment, peripherals, phones, software, racks) and reservations, GLPI knowledge base, users, groups, entities, locations, ITIL categories, follow-up templates, documents, rules and webhooks, and GLPI search. Read tools return trimmed payloads; writes and deletes are gated by policy.",
    ...opts.serverInfo,
    version: SERVER_VERSION,
    },
    { instructions },
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
      .describe(
        "Output format: 'json' (default) or 'markdown' (a table for listings, key/value lines for one item; " +
          "returned in both the text and the structured result)",
      ),
    // Aggregates, not GLPI items: their payload must not be run through the
    // whitelist of the itemtype they happen to take as an argument.
    skipFormatting: ["glpi_count_items", "glpi_get_ticket_stats", "glpi_list_search_options"],
    // Compact tables for listings in markdown (the JSON result keeps every field).
    markdownViews: MARKDOWN_VIEWS,
    // Keys this layer adds to the result, declared so validating clients accept it.
    outputExtras: {
      count: z.number().int().optional().describe("Items in this page"),
      note: z.string().optional().describe("Pagination hint: how to fetch the next page"),
      format: z.enum(["json", "markdown"]).optional().describe("'markdown' when data holds the markdown rendering"),
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
  const filter = installToolFilter(server, filterOptions);

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
      filter.has,
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
