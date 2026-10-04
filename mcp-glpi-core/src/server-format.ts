/**
 * Installs payload formatting and pagination defaults on an MCP server.
 *
 * Like the write policy, this wraps `registerTool` once instead of touching
 * every call site. Read tools gain two parameters — `fields` (essential|all)
 * and `format` (json|markdown) — and their results are filtered, de-HTML'd and
 * paginated on the way out.
 *
 * `structuredContent` stays a parseable object in both formats; `format:
 * "markdown"` only changes the text rendering, which is what actually costs
 * context on long listings.
 */

import {
  formatPayload,
  renderMarkdown,
  type FieldMode,
  type OutputFormat,
} from "./format.js";
import {
  paginationNote,
  resolveLimit,
  resolveRange,
  type LimitResolution,
  type RangeResolution,
} from "./pagination.js";
import { classifyTool, type OperationKind } from "./policy.js";
import type { RegistrableServer, ToolConfigLike, ToolHandlerLike } from "./server-policy.js";

/**
 * Tool name to GLPI itemtype. Only read tools that return items need an entry;
 * anything missing falls back to the generic blocklist in format.ts, and tools
 * that take an explicit `itemtype` argument (glpi_search) use that instead.
 */
export const TOOL_ITEMTYPES: Record<string, string> = {
  // v1
  glpi_list_tickets: "Ticket",
  glpi_get_ticket: "Ticket",
  glpi_list_changes: "Change",
  glpi_get_change: "Change",
  glpi_list_problems: "Problem",
  glpi_get_problem: "Problem",
  glpi_list_followups: "ITILFollowup",
  glpi_list_change_followups: "ITILFollowup",
  glpi_list_problem_followups: "ITILFollowup",
  glpi_list_ticket_tasks: "TicketTask",
  glpi_list_change_tasks: "TicketTask",
  glpi_list_problem_tasks: "TicketTask",
  glpi_list_users: "User",
  glpi_get_user: "User",
  glpi_search_user_by_email: "User",
  glpi_list_groups: "Group",
  glpi_get_group: "Group",
  glpi_list_entities: "Entity",
  glpi_get_entity: "Entity",
  glpi_list_knowbase_items: "KnowbaseItem",
  glpi_get_knowbase_item: "KnowbaseItem",
  glpi_list_knowbase_categories: "KnowbaseItemCategory",
  glpi_get_knowbase_category: "KnowbaseItemCategory",
  glpi_list_documents: "Document",
  glpi_get_document: "Document",
  glpi_list_locations: "Location",
  glpi_get_location: "Location",
  glpi_list_itil_categories: "ITILCategory",
  glpi_get_itil_category: "ITILCategory",
  glpi_list_webhooks: "Webhook",
  glpi_get_webhook: "Webhook",
  glpi_list_webhook_deliveries: "QueuedWebhook",
  glpi_list_reservations: "Reservation",
  glpi_get_reservation: "Reservation",
  glpi_list_reservation_items: "ReservationItem",
  // v2
  glpi_v2_list_tickets: "Ticket",
  glpi_v2_get_ticket: "Ticket",
  glpi_v2_list_changes: "Change",
  glpi_v2_get_change: "Change",
  glpi_v2_list_problems: "Problem",
  glpi_v2_get_problem: "Problem",
  glpi_v2_list_users: "User",
  glpi_v2_get_user: "User",
  glpi_v2_list_groups: "Group",
  glpi_v2_get_group: "Group",
  glpi_v2_list_entities: "Entity",
  glpi_v2_get_entity: "Entity",
  glpi_v2_list_kb_articles: "KnowbaseItem",
  glpi_v2_get_kb_article: "KnowbaseItem",
  glpi_v2_list_kb_categories: "KnowbaseItemCategory",
  glpi_v2_list_documents: "Document",
  glpi_v2_get_document: "Document",
  glpi_v2_list_locations: "Location",
  glpi_v2_list_itil_categories: "ITILCategory",
};

/**
 * Tools whose `itemtype` / `asset_type` argument describes what comes back.
 *
 * Reading that argument everywhere was too eager: glpi_list_timeline takes
 * itemtype: "Ticket" but returns followups, tasks and validations, and the
 * Ticket whitelist quietly stripped them. Only tools listed here read the
 * itemtype from their arguments; every other tool uses the name map.
 */
export const GENERIC_ITEMTYPE_TOOLS = new Set([
  "glpi_search",
  "glpi_list_assets",
  "glpi_get_asset",
  "glpi_get_asset_details",
  "glpi_create_asset",
  "glpi_update_asset",
]);

export function inferItemtype(
  toolName: string,
  args: Record<string, unknown>,
  genericTools: Set<string> = GENERIC_ITEMTYPE_TOOLS,
): string | undefined {
  if (genericTools.has(toolName)) {
    const fromArgs = args.itemtype ?? args.asset_type;
    if (typeof fromArgs === "string" && fromArgs) return fromArgs;
  }
  return TOOL_ITEMTYPES[toolName];
}

interface ToolResultLike {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function isToolResult(v: unknown): v is ToolResultLike {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as ToolResultLike).content)
  );
}

interface SchemaWithShape {
  shape: Record<string, unknown>;
}

function shapeOf(inputSchema: unknown): Record<string, unknown> | undefined {
  if (typeof inputSchema !== "object" || inputSchema === null) return undefined;
  const shape = (inputSchema as SchemaWithShape).shape;
  return typeof shape === "object" && shape !== null ? shape : undefined;
}

interface ExtendableSchema {
  extend(shape: Record<string, unknown>): unknown;
}

/** Adds keys to a zod object schema (or a raw shape); anything else is returned as is. */
export function extendSchema(inputSchema: unknown, extra: Record<string, unknown>): unknown {
  if (
    typeof inputSchema === "object" &&
    inputSchema !== null &&
    typeof (inputSchema as ExtendableSchema).extend === "function"
  ) {
    return (inputSchema as ExtendableSchema).extend(extra);
  }
  if (typeof inputSchema === "object" && inputSchema !== null) {
    return { ...(inputSchema as Record<string, unknown>), ...extra };
  }
  return inputSchema;
}

export interface FormattingOptions {
  /** Zod schema for `fields`, e.g. z.enum(["essential","all"]).optional(). */
  fieldsSchema: unknown;
  /** Zod schema for `format`, e.g. z.enum(["json","markdown"]).optional(). */
  formatSchema: unknown;
  /** Default field mode when the caller does not ask (default "essential"). */
  defaultFieldMode?: FieldMode;
  /** Extra tool-name to itemtype entries, merged over TOOL_ITEMTYPES. */
  itemtypes?: Record<string, string>;
  /** Overrides for tools whose name does not reflect what they do. */
  kindOverrides?: Record<string, OperationKind>;
  /**
   * Read tools whose result is not a GLPI item and must not be filtered —
   * aggregates such as counts and stats, whose payload would otherwise be run
   * through the whitelist of whatever `itemtype` argument they carry.
   */
  skipFormatting?: string[];
  /** Extra tools that take the itemtype of their result as an argument. */
  genericItemtypeTools?: string[];
  /**
   * Zod schemas for the keys this layer adds to `structuredContent` — `count`
   * (e.g. z.number().int().optional()) and `note` (z.string().optional()). They
   * are added to each read tool's outputSchema; without them a client that
   * validates results (the MCP SDK client does, after tools/list) rejects every
   * formatted listing because the declared output has no such keys.
   */
  outputExtras?: Record<string, unknown>;
}

/**
 * Wraps `server.registerTool`. Call once, before registering any tool.
 * Composes with `installWritePolicy` in either order.
 */
export function installPayloadFormatting(server: object, opts: FormattingOptions): void {
  const target = server as RegistrableServer;
  const {
    fieldsSchema,
    formatSchema,
    defaultFieldMode = "essential",
    itemtypes = {},
    kindOverrides = {},
    skipFormatting = [],
    genericItemtypeTools: extraGeneric = [],
    outputExtras,
  } = opts;
  const original = target.registerTool.bind(target);
  const itemtypeMap = { ...TOOL_ITEMTYPES, ...itemtypes };
  const skipped = new Set(skipFormatting);
  const genericItemtypeTools = new Set([...GENERIC_ITEMTYPE_TOOLS, ...extraGeneric]);

  target.registerTool = (name: string, config: ToolConfigLike, handler: ToolHandlerLike) => {
    const kind = kindOverrides[name] ?? classifyTool(name);
    if (kind !== "read" || skipped.has(name)) return original(name, config, handler);

    const shape = shapeOf(config.inputSchema);
    const hasRange = shape !== undefined && "range" in shape;
    const hasLimit = shape !== undefined && "limit" in shape;

    const formattedConfig: ToolConfigLike = {
      ...config,
      inputSchema: extendSchema(config.inputSchema, {
        fields: fieldsSchema,
        format: formatSchema,
      }),
      ...(config.outputSchema && outputExtras
        ? { outputSchema: extendSchema(config.outputSchema, outputExtras) }
        : {}),
    };

    const formattedHandler: ToolHandlerLike = async (args, extra) => {
      const mode: FieldMode = args.fields === "all" ? "all" : defaultFieldMode;
      const output: OutputFormat = args.format === "markdown" ? "markdown" : "json";

      // Pagination defaults, applied before the request goes out.
      let pageInfo: RangeResolution | LimitResolution | undefined;
      const callArgs: Record<string, unknown> = { ...args };
      if (hasRange) {
        const r = resolveRange(typeof args.range === "string" ? args.range : undefined);
        callArgs.range = r.range;
        pageInfo = r;
      } else if (hasLimit) {
        const l = resolveLimit(typeof args.limit === "number" ? args.limit : undefined);
        callArgs.limit = l.limit;
        pageInfo = l;
      }

      const result = await handler(callArgs, extra);
      if (!isToolResult(result) || result.isError) return result;

      const sc = result.structuredContent;
      if (!sc || !("data" in sc)) return result;

      const itemtype = genericItemtypeTools.has(name)
        ? ((typeof args.itemtype === "string" && args.itemtype) ||
            (typeof args.asset_type === "string" && args.asset_type) ||
            itemtypeMap[name])
        : itemtypeMap[name];

      const data = formatPayload(itemtype, sc.data, mode);
      const count = Array.isArray(data) ? data.length : undefined;
      const note = pageInfo ? paginationNote(pageInfo, count ?? 0) : undefined;

      const structured: Record<string, unknown> = { ...sc, data };
      if (count !== undefined) structured.count = count;
      if (note) structured.note = note;

      const text =
        output === "markdown"
          ? [renderMarkdown(data), note ? `\n_${note}_` : ""].join("").trim()
          : JSON.stringify(structured, null, 2);

      return { ...result, content: [{ type: "text" as const, text }], structuredContent: structured };
    };

    return original(name, formattedConfig, formattedHandler);
  };
}
