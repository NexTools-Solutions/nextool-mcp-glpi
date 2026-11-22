import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonResult, type makeWrap } from "@nextoolsolutions/mcp-glpi-core";
import type { GlpiV2Config, ITILItemtype } from "./glpi-v2-client.js";
import {
  listTickets, getTicket, createTicket, updateTicket,
  listTimeline, addFollowup, addSolution, addTask, getSession,
} from "./glpi-v2-client.js";
import { itemIdSchema } from "./ids.js";

const idSchema = () => itemIdSchema();
import { MY_TICKET_ROLES, TICKET_SORT_FIELDS, TICKET_STATUS_FILTERS, normalizeStatuses } from "./ticket-lists.js";

/**
 * v1 tool names served by the API v2 (`v1Compat`).
 *
 * Some clients freeze the tool list they saw when the server was reviewed. The
 * ChatGPT app directory does: its NexTool app knows only the v1 names
 * (glpi_list_my_tickets, glpi_add_solution…). A connection that has only API v2
 * credentials (e.g. one created from GLPI by the NexTool MCP Connect module)
 * registers only glpi_v2_*, so every call from such a client failed with
 * "tool not found". With v1Compat, the everyday ticket tools are registered
 * under their v1 names and v1 input schemas, and run on the v2 API.
 * Covered: tickets (list, my tickets, get, create, update), followups,
 * solution, tasks, timeline, ticket people and the session. Everything else
 * stays v2-only.
 */

type Wrap = ReturnType<typeof makeWrap>;
export interface V1CompatDeps {
  wrap: Wrap;
  labelItil: (itemtype: ITILItemtype, result: unknown) => Promise<unknown>;
  withStatusFilter: (filter: string | undefined, status: string | readonly string[] | undefined) => string | undefined;
}

type Row = Record<string, unknown>;
type Member = { role?: string; type?: string; id?: number; name?: string; display_name?: string };

/** v1 sort column -> v2 sort property. */
const SORT_V2: Record<(typeof TICKET_SORT_FIELDS)[number], string> = {
  date_mod: "date_mod",
  date: "date",
  id: "id",
  priority: "priority",
  status: "status.id",
  name: "name",
  solvedate: "date_solve",
  closedate: "date_close",
};
const ROLE_TYPE: Record<string, number> = { requester: 1, assigned: 2, observer: 3 };
/** Pages fetched for "my tickets" (the v2 API cannot filter on the team): 10 x 100 tickets. */
const MY_TICKETS_PAGES = 10;
const PAGE = 100;

/** "0-49" -> {start 0, limit 50}; anything else -> undefined. */
function parseRange(range: string | undefined): { start: number; limit: number } | undefined {
  const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(range ?? "");
  if (!m) return undefined;
  const start = Number(m[1]);
  return { start, limit: Math.max(1, Number(m[2]) - start + 1) };
}

function sortParam(sort: string | undefined, order: string | undefined): string {
  const col = SORT_V2[(sort ?? "date_mod") as keyof typeof SORT_V2] ?? "date_mod";
  return `${col}:${order === "asc" ? "asc" : "desc"}`;
}

function members(t: Row, role: string): { id: number | undefined; name: string | undefined; type: string | undefined }[] {
  const team = Array.isArray(t.team) ? (t.team as Member[]) : [];
  return team
    .filter((m) => m.role === role)
    .map((m) => ({ id: m.id, name: m.display_name?.replace(/\s*\(\d+\)$/, "") ?? m.name, type: m.type }));
}

function trim(text: unknown, max = 300): unknown {
  if (typeof text !== "string") return text;
  const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

/** A v2 ticket (already labelled) as a v1-style row: names beside ids, people by role. */
function v1Row(t: Row, me?: number): Row {
  const status = t.status as { id?: number; name?: string } | undefined;
  const category = t.category as { name?: string } | null | undefined;
  const entity = t.entity as { name?: string } | null | undefined;
  const row: Row = {
    id: t.id,
    name: t.name,
    content: trim(t.content),
    status: status?.id,
    status_name: status?.name,
    type: t.type,
    type_name: t.type_name,
    priority: t.priority,
    priority_name: t.priority_name,
    urgency: t.urgency,
    urgency_name: t.urgency_name,
    impact: t.impact,
    impact_name: t.impact_name,
    date: t.date,
    date_mod: t.date_mod,
    solvedate: t.date_solve,
    closedate: t.date_close,
    category_name: category?.name ?? null,
    entity_name: entity?.name ?? null,
    requesters: members(t, "requester"),
    assigned: members(t, "assigned"),
    observers: members(t, "observer"),
  };
  if (me !== undefined) {
    const team = Array.isArray(t.team) ? (t.team as Member[]) : [];
    row.my_roles = team.filter((m) => m.type === "User" && m.id === me).map((m) => m.role);
  }
  return row;
}

/** One timeline entry of the v2 API as a flat v1-style row. */
function timelineRow(e: Row): Row {
  const item = (e.item ?? {}) as Row;
  const user = item.user as { id?: number; name?: string } | null | undefined;
  const tech = item.user_tech as { id?: number; name?: string } | null | undefined;
  return {
    type: String(e.type ?? "").toLowerCase(),
    ...item,
    user_name: user?.name ?? null,
    ...(tech ? { tech_name: tech.name ?? null } : {}),
  };
}

/** v1 ticket input keys -> v2 property names (dropdowns accept the id as a number). */
const INPUT_V2: Record<string, string> = {
  entities_id: "entity",
  itilcategories_id: "category",
  locations_id: "location",
  requesttypes_id: "request_type",
  users_id_recipient: "user_recipient",
};
/** Actor keys of the v1 input: the v2 sets people through the team endpoint, which this layer does not call. */
const ACTOR_KEY = /^_?(users_id|groups_id|suppliers_id)_(requester|assign|observer)/;

function ticketInput(input: Record<string, unknown>): { data: Record<string, unknown>; ignored: string[] } {
  const data: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (ACTOR_KEY.test(k)) ignored.push(k);
    else data[INPUT_V2[k] ?? k] = v;
  }
  return { data, ignored };
}

export function registerV1CompatTools(server: McpServer, config: GlpiV2Config, deps: V1CompatDeps): void {
  const { wrap, labelItil, withStatusFilter } = deps;
  const rangeSchema = z.string().optional().describe("Pagination range, e.g. 0-49");
  const expandSchema = z.boolean().optional().describe("Expand dropdown IDs to names");
  const statusEnum = () => z.enum(TICKET_STATUS_FILTERS);
  const statusSchema = () => z.union([statusEnum(), z.array(statusEnum())]).optional();
  const ticketSortSchema = () =>
    z.enum(TICKET_SORT_FIELDS).optional().describe("Sort column (default date_mod = last update)");
  const orderSchema = () => z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc = most recent first)");
  const outData = () => z.object({ data: z.unknown() });
  const outRows = () => z.object({ data: z.unknown(), total: z.number().optional() });

  async function sessionUser(): Promise<{ id: number | undefined; name: string | null }> {
    const s = (await getSession(config)) as Row | null;
    return { id: typeof s?.user_id === "number" ? s.user_id : undefined, name: (s?.friendly_name as string) ?? (s?.name as string) ?? null };
  }

  async function timeline(itemtype: ITILItemtype, itemId: number | string): Promise<Row[]> {
    const raw = await listTimeline(config, itemtype, itemId);
    return (Array.isArray(raw) ? (raw as Row[]) : []).map(timelineRow);
  }

  function page<T>(rows: T[], range: string | undefined): T[] {
    const r = parseRange(range);
    return r ? rows.slice(r.start, r.start + r.limit) : rows;
  }

  server.registerTool(
    "glpi_list_tickets",
    {
      title: "List tickets",
      description:
        "List GLPI tickets the connected user may see, most recently updated first by default. Filter by status " +
        "(status: 'open' = not solved nor closed). Each row carries status_name, priority_name and the people " +
        "(requesters, assigned, observers) as {id, name}. For the user's OWN tickets use glpi_list_my_tickets.",
      inputSchema: z.object({
        range: rangeSchema,
        expand_dropdowns: expandSchema,
        status: statusSchema(),
        sort: ticketSortSchema(),
        order: orderSchema(),
      }),
      outputSchema: outRows(),
    },
    wrap(async ({ range, status, sort, order }) => {
      const r = parseRange(range) ?? { start: 0, limit: 50 };
      const raw = await listTickets(config, {
        start: r.start,
        limit: Math.min(r.limit, PAGE),
        sort: sortParam(sort, order),
        filter: withStatusFilter(undefined, status),
      });
      const rows = (await labelItil("Ticket", raw)) as Row[];
      return jsonResult({ data: (Array.isArray(rows) ? rows : []).filter((t) => !t.is_deleted).map((t) => v1Row(t)) });
    }),
  );

  server.registerTool(
    "glpi_list_my_tickets",
    {
      title: "List my tickets",
      description:
        "\"My tickets\": tickets of the connected GLPI user (or of users_id) where they are requester, assigned " +
        "technician or observer. Defaults: open tickets only (not solved nor closed), most recently updated first. " +
        "Each row names the people (requesters, assigned, observers as {id, name}), status_name, priority_name and " +
        "my_roles. Use this for \"meus chamados\", \"my open tickets\", \"tickets assigned to me\".",
      inputSchema: z.object({
        role: z.enum(MY_TICKET_ROLES).optional()
          .describe("Which link to the user: requester, assigned (technician), observer, or any (default)"),
        status: statusSchema().describe(
          "Statuses to include (default open = not solved nor closed): new, assigned (= processing), planned, " +
            "pending, solved, closed, open. One name or a list.",
        ),
        sort: ticketSortSchema(),
        order: orderSchema(),
        range: rangeSchema,
        users_id: idSchema().optional().describe("Another user's ID (default: the connected user)"),
      }),
      outputSchema: z.object({
        data: z.unknown(),
        total: z.number().optional(),
        user: z.object({ id: z.number(), name: z.string().nullable() }).optional(),
        role: z.string().optional(),
        status: z.array(z.string()).optional(),
        note: z.string().optional(),
      }),
    },
    wrap(async ({ role, status, sort, order, range, users_id }) => {
      const session = await sessionUser();
      const me = users_id !== undefined ? Number(users_id) : session.id;
      if (me === undefined) throw new Error("Could not identify the connected GLPI user (GET /Session has no user_id).");
      const statuses = normalizeStatuses(status ?? "open");
      const wanted = role && role !== "any" ? [role] : ["requester", "assigned", "observer"];
      const mine: Row[] = [];
      let capped = false;
      for (let p = 0; p < MY_TICKETS_PAGES; p++) {
        const raw = await listTickets(config, {
          start: p * PAGE,
          limit: PAGE,
          sort: sortParam(sort, order),
          filter: withStatusFilter(undefined, statuses),
        });
        const batch = Array.isArray(raw) ? (raw as Row[]) : [];
        for (const t of batch) {
          if (t.is_deleted) continue;
          const team = Array.isArray(t.team) ? (t.team as Member[]) : [];
          if (team.some((m) => m.type === "User" && m.id === me && wanted.includes(m.role ?? ""))) mine.push(t);
        }
        if (batch.length < PAGE) break;
        if (p === MY_TICKETS_PAGES - 1) capped = true;
      }
      const labelled = mine.length ? ((await labelItil("Ticket", mine)) as Row[]) : [];
      const rows = page(labelled.map((t) => v1Row(t, me)), range);
      return jsonResult({
        data: rows,
        total: labelled.length,
        user: { id: me, name: users_id !== undefined ? null : session.name },
        role: role ?? "any",
        status: statuses,
        ...(capped ? { note: `Only the ${MY_TICKETS_PAGES * PAGE} most recent tickets in these statuses were scanned.` } : {}),
      });
    }),
  );

  server.registerTool(
    "glpi_get_ticket",
    {
      title: "Get ticket",
      description:
        "Retrieve a single ticket by ID, with status_name, priority_name, category and entity names and the people " +
        "(requesters, assigned, observers).",
      inputSchema: z.object({ ticketId: idSchema(), expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId }) => {
      const t = (await labelItil("Ticket", await getTicket(config, ticketId))) as Row | null;
      if (!t || typeof t !== "object") return jsonResult({ data: {} });
      return jsonResult({ data: { ...v1Row(t), content: t.content } });
    }),
  );

  server.registerTool(
    "glpi_create_ticket",
    {
      title: "Create ticket",
      description:
        "Create a new ticket. Common fields: name (title), content (description), entities_id, itilcategories_id, " +
        "type (1=Incident, 2=Request), urgency, impact, priority. Requester/technician fields are not set by this " +
        "connection (the ticket gets the connected user as requester).",
      inputSchema: z.object({ input: z.record(z.unknown()).describe("Ticket fields") }),
      outputSchema: outData(),
    },
    wrap(async ({ input }) => {
      const { data, ignored } = ticketInput(input as Record<string, unknown>);
      const created = (await createTicket(config, data)) ?? { id: 0 };
      return jsonResult({ data: ignored.length ? { ...(created as Row), ignored_fields: ignored } : created });
    }),
  );

  server.registerTool(
    "glpi_update_ticket",
    {
      title: "Update ticket",
      description: "Update an existing ticket by ID (e.g. status, urgency, itilcategories_id, name, content).",
      inputSchema: z.object({ ticketId: idSchema(), input: z.record(z.unknown()).describe("Fields to update") }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId, input }) => {
      const { data, ignored } = ticketInput(input as Record<string, unknown>);
      const updated = (await updateTicket(config, ticketId, data)) ?? {};
      const out = (await labelItil("Ticket", updated)) as Row;
      return jsonResult({ data: ignored.length ? { ...v1Row(out), ignored_fields: ignored } : v1Row(out) });
    }),
  );

  server.registerTool(
    "glpi_add_followup",
    {
      title: "Add followup to ticket",
      description: "Add a comment/followup to a ticket.",
      inputSchema: z.object({
        ticketId: idSchema(),
        content: z.string().describe("Followup text content"),
        is_private: z.number().optional().describe("1 for private, 0 for public (default: 0)"),
        users_id: z.number().int().positive().optional().describe("Author user ID (default: session user)"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId, content, is_private }) =>
      jsonResult({ data: await addFollowup(config, "Ticket", ticketId, { content, is_private: Boolean(is_private) }) }),
    ),
  );

  server.registerTool(
    "glpi_list_followups",
    {
      title: "List ticket followups",
      description: "List followups (comments) of a ticket, oldest first, with the author's name (user_name).",
      inputSchema: z.object({ ticketId: idSchema(), range: rangeSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId, range }) =>
      jsonResult({ data: page((await timeline("Ticket", ticketId)).filter((e) => e.type === "followup"), range) }),
    ),
  );

  server.registerTool(
    "glpi_add_solution",
    {
      title: "Add solution to ticket",
      description: "Add a solution to a ticket (status changes to Solved).",
      inputSchema: z.object({ ticketId: idSchema(), content: z.string().describe("Solution text content") }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId, content }) => jsonResult({ data: await addSolution(config, "Ticket", ticketId, { content }) })),
  );

  server.registerTool(
    "glpi_list_ticket_tasks",
    {
      title: "List ticket tasks",
      description: "List tasks (to-do items) for a ticket, with author and technician names (user_name, tech_name).",
      inputSchema: z.object({ ticketId: idSchema(), range: rangeSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId, range }) =>
      jsonResult({ data: page((await timeline("Ticket", ticketId)).filter((e) => e.type === "task"), range) }),
    ),
  );

  server.registerTool(
    "glpi_add_ticket_task",
    {
      title: "Add task to ticket",
      description:
        "Add a task to a ticket. Fields: tickets_id, content (required). Optional: is_private (0/1), " +
        "state (0=Info, 1=To do, 2=Done), actiontime (seconds).",
      inputSchema: z.object({
        tickets_id: idSchema().describe("Ticket ID"),
        content: z.string().describe("Task content"),
        is_private: z.number().optional().describe("1=private, 0=public"),
        state: z.number().optional().describe("0=Info, 1=To do, 2=Done"),
        actiontime: z.number().optional().describe("Duration in seconds"),
        users_id_tech: z.number().int().positive().optional().describe("Assigned technician user ID"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ tickets_id, content, is_private, state, actiontime }) => {
      const input: Record<string, unknown> = { content };
      if (is_private !== undefined) input.is_private = Boolean(is_private);
      if (state !== undefined) input.state = state;
      if (actiontime !== undefined) input.duration = actiontime;
      return jsonResult({ data: await addTask(config, "Ticket", tickets_id, input) });
    }),
  );

  server.registerTool(
    "glpi_list_timeline",
    {
      title: "List timeline",
      description:
        "Followups, tasks, solutions and validations of a ticket, change or problem in one chronological list " +
        "(oldest first; order 'desc' for the latest first), with the people's names (user_name, tech_name).",
      inputSchema: z.object({
        itemtype: z.enum(["Ticket", "Change", "Problem"]).describe("ITIL item type"),
        itemId: idSchema(),
        range: rangeSchema.describe("Pagination range over the merged timeline, e.g. 0-24"),
        order: z.enum(["asc", "desc"]).optional().describe("asc (default) = oldest first, desc = latest first"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ itemtype, itemId, range, order }) => {
      const rows = await timeline(itemtype, itemId);
      return jsonResult({ data: page(order === "desc" ? rows.reverse() : rows, range) });
    }),
  );

  server.registerTool(
    "glpi_list_ticket_users",
    {
      title: "List ticket users",
      description:
        "List the people linked to a ticket (requesters, observers, assigned), with names. " +
        "type: 1=Requester, 2=Assigned, 3=Observer.",
      inputSchema: z.object({ ticketId: idSchema() }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId }) => {
      const t = (await getTicket(config, ticketId)) as Row | null;
      const team = Array.isArray(t?.team) ? (t!.team as Member[]) : [];
      return jsonResult({
        data: team.map((m) => ({
          ...(m.type === "Group" ? { groups_id: m.id, group_name: m.name } : { users_id: m.id, user_name: m.display_name ?? m.name }),
          member_type: m.type,
          type: ROLE_TYPE[m.role ?? ""] ?? null,
          type_name: m.role,
        })),
      });
    }),
  );

  server.registerTool(
    "glpi_get_full_session",
    {
      title: "Get full session info",
      description: "Get the session info: connected user, active entities and profile.",
      inputSchema: z.object({}),
      outputSchema: outData(),
    },
    wrap(async () => jsonResult({ data: (await getSession(config)) ?? {} })),
  );
}
