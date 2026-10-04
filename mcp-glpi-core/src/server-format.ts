/**
 * Installs payload formatting and pagination defaults on an MCP server.
 *
 * Like the write policy, this wraps `registerTool` once instead of touching
 * every call site. Read tools gain two parameters — `fields` (essential|all)
 * and `format` (json|markdown) — and their results are filtered, de-HTML'd and
 * paginated on the way out.
 *
 * `format: "markdown"` is carried by BOTH channels. Clients that support
 * structured results (Claude among them) hand `structuredContent` to the model
 * and ignore the text block, so a markdown rendering that lived only in the
 * text was silently dropped: the model kept receiving JSON. In markdown mode
 * `structuredContent` is `{ data: "<markdown>", format: "markdown", count?,
 * note? }`; in JSON mode (the default) it is the filtered object as before.
 *
 * Results are formatted whether the payload sits under `data` (every v1 tool)
 * or is the structured object itself (API v2 single-item tools); before 1.2.0
 * the second kind skipped this layer entirely, `fields` and `format` included.
 */

import {
  formatPayload,
  renderMarkdown,
  type FieldMode,
  type MarkdownView,
  type OutputFormat,
} from "./format.js";
import {
  LIST_TEXT_MAX_CHARS,
  MAX_RESPONSE_CHARS,
  nextPageNote,
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
  // API v1 only. API v2 payloads use other field names (and nest relations as
  // {id, name}): a v1 whitelist stripped the v2 entity, category, team and
  // requester objects, so v2 tools fall back to the generic blocklist.
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
};

/**
 * Tools whose `itemtype` / `asset_type` argument describes what comes back.
 *
 * Reading that argument everywhere was too eager: glpi_list_timeline takes
 * itemtype: "Ticket" but returns followups, tasks and validations, and the
 * Ticket whitelist quietly stripped them. Only tools listed here read the
 * itemtype from their arguments; every other tool uses the name map.
 *
 * glpi_search is not one of them: its rows are keyed by search option ID (or
 * name), never by field name, so an itemtype whitelist emptied every row.
 */
export const GENERIC_ITEMTYPE_TOOLS = new Set([
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

/**
 * Listings that ARE the detail: the history of a ticket has no per-entry get
 * tool, so cutting its texts would hide the conversation. The size budget
 * still applies to them.
 */
export const FULL_TEXT_LISTS = new Set([
  "glpi_list_timeline",
  "glpi_list_followups",
  "glpi_list_change_followups",
  "glpi_list_problem_followups",
  "glpi_list_ticket_tasks",
  "glpi_list_change_tasks",
  "glpi_list_problem_tasks",
  "glpi_list_ticket_validations",
  "glpi_v2_list_timeline",
]);

/** Cuts string fields longer than `max` (and `max` itself in nested objects of a row). */
export function cutLongTexts(rows: unknown[], max: number): { rows: unknown[]; cut: number } {
  let cut = 0;
  const clip = (v: unknown, depth: number): unknown => {
    if (typeof v === "string" && v.length > max) {
      cut++;
      return `${v.slice(0, max - 1)}…`;
    }
    if (depth < 2 && Array.isArray(v)) return v.map((x) => clip(x, depth + 1));
    if (depth < 2 && typeof v === "object" && v !== null) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clip(x, depth + 1)]));
    }
    return v;
  };
  return { rows: rows.map((r) => clip(r, 0)), cut };
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
   * (e.g. z.number().int().optional()), `note` (z.string().optional()) and
   * `format` (z.enum(["json","markdown"]).optional(), set in markdown mode). They
   * are added to each read tool's outputSchema; without them a client that
   * validates results (the MCP SDK client does, after tools/list) rejects every
   * formatted listing because the declared output has no such keys.
   */
  outputExtras?: Record<string, unknown>;
  /**
   * Conversational markdown views per tool name (see `columnView`). In
   * `format: "markdown"` with the default `fields: "essential"`, the rows of a
   * listing are projected onto the view's columns before the table is drawn;
   * `fields: "all"` draws every column, and the JSON result is never projected.
   */
  markdownViews?: Record<string, MarkdownView>;
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
    markdownViews = {},
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
    const hasStart = shape !== undefined && "start" in shape;

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
      if (!sc) return result;
      // v1 tools wrap the payload as { data }; v2 single-item tools return the item itself.
      const wrapped = "data" in sc;
      const payload = wrapped ? sc.data : sc;

      const itemtype = genericItemtypeTools.has(name)
        ? ((typeof args.itemtype === "string" && args.itemtype) ||
            (typeof args.asset_type === "string" && args.asset_type) ||
            itemtypeMap[name])
        : itemtypeMap[name];

      let data = formatPayload(itemtype, payload, mode);
      const notes: string[] = [];

      // Listings carry summaries: long texts are cut (the get tool, or fields=all, has them whole).
      if (Array.isArray(data) && mode !== "all" && !FULL_TEXT_LISTS.has(name)) {
        const cut = cutLongTexts(data, LIST_TEXT_MAX_CHARS);
        data = cut.rows;
        if (cut.cut > 0) {
          notes.push(`Texts longer than ${LIST_TEXT_MAX_CHARS} characters are cut in listings; open one item, or use fields=all, for the full text.`);
        }
      }

      const siblings = wrapped ? Object.entries(sc).filter(([k]) => !["data", "count", "note"].includes(k)) : [];
      const total = typeof sc.total === "number" ? sc.total : undefined;

      const view = mode !== "all" ? markdownViews[name] : undefined;
      const build = (d: unknown, note: string | undefined) => {
        const count = Array.isArray(d) ? d.length : undefined;
        if (output === "markdown") {
          const shown =
            view && Array.isArray(d)
              ? d.map((r) => (typeof r === "object" && r !== null && !Array.isArray(r) ? view(r as Record<string, unknown>) : r))
              : d;
          const markdown = [
            renderMarkdown(shown),
            ...siblings.map(([k, v]) => `\n**${k}**: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`),
            note ? `\n_${note}_` : "",
          ]
            .join("")
            .trim();
          const structured: Record<string, unknown> = { data: markdown, format: "markdown" };
          if (count !== undefined) structured.count = count;
          if (note) structured.note = note;
          return { text: markdown, structured };
        }
        const structured: Record<string, unknown> = wrapped
          ? { ...sc, data: d }
          : typeof d === "object" && d !== null && !Array.isArray(d)
            ? { ...(d as Record<string, unknown>) }
            : { data: d };
        if (count !== undefined) structured.count = count;
        if (note) structured.note = note;
        return { text: JSON.stringify(structured, null, 2), structured };
      };

      const noteFor = (returned: number, fetched: number) => {
        const page = pageInfo
          ? nextPageNote({
              page: pageInfo,
              start: typeof args.start === "number" ? args.start : undefined,
              returned,
              fetched,
              total,
              params: { range: hasRange, start: hasStart, limit: hasLimit },
            })
          : undefined;
        const all = [...notes, ...(page ? [page] : [])];
        return all.length ? all.join(" ") : undefined;
      };

      // Size budget: drop items from the end until the answer fits; the note says how to go on.
      let out = build(data, noteFor(Array.isArray(data) ? data.length : 0, Array.isArray(data) ? data.length : 0));
      if (out.text.length > MAX_RESPONSE_CHARS) {
        if (Array.isArray(data)) {
          const rows = data;
          let lo = 1;
          let hi = rows.length;
          // Largest prefix that fits (binary search; at least one item).
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (build(rows.slice(0, mid), noteFor(mid, rows.length)).text.length <= MAX_RESPONSE_CHARS) lo = mid;
            else hi = mid - 1;
          }
          out = build(rows.slice(0, lo), noteFor(lo, rows.length));
        } else if (typeof data === "object" && data !== null) {
          // One big item (e.g. a huge description): cut its longest texts.
          const cut = cutLongTexts([data], Math.max(2000, Math.floor(MAX_RESPONSE_CHARS / 4))).rows[0];
          notes.push(`Response size limit (${MAX_RESPONSE_CHARS} characters): long texts were cut.`);
          out = build(cut, noteFor(0, 0));
        }
      }

      return { ...result, content: [{ type: "text" as const, text: out.text }], structuredContent: out.structured };
    };

    return original(name, formattedConfig, formattedHandler);
  };
}
