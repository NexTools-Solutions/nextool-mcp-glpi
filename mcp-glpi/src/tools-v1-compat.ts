import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonResult, type makeWrap } from "@nextoolsolutions/mcp-glpi-core";
import type { GlpiV2Config, ITILItemtype } from "./glpi-v2-client.js";
import {
  listTickets, getTicket, createTicket, updateTicket,
  listChanges, getChange, listProblems, getProblem,
  listTimeline, addFollowup, addSolution, addTask, addValidation, addTeamMember, getSession,
  listUsers, getUser, listGroups, getGroup, listEntities, getEntity,
  listITILCategories, getITILCategory, listLocations, getLocation,
  listDocuments, getDocument, listKBArticles, getKBArticle, listKBCategories, getKBCategory,
  countCollection,
} from "./glpi-v2-client.js";
import { TICKET_STATUS } from "./assets-client.js";
import { itemIdSchema } from "./ids.js";
import { MY_TICKET_ROLES, TICKET_SORT_FIELDS, TICKET_STATUS_FILTERS, normalizeStatuses } from "./ticket-lists.js";

const idSchema = () => itemIdSchema();

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
 *
 * Covered (the `core` preset of the v1 family): tickets (list, my tickets, get,
 * create, update, counts per status), followups, solution, tasks, validations,
 * timeline, ticket people, changes and problems (read), users, groups,
 * entities, ITIL categories, locations, documents, knowledge base and the
 * session. Rows keep the v1 names where the tool built them before (tickets,
 * timeline); the plain catalogue reads return the v2 item as it is.
 *
 * Not possible on the v2 API (generic search with criteria, assets,
 * reservations, document links, followup templates): those names are
 * registered too and answer with one sentence saying so and naming the closest
 * tool, which a model can act on; "tool not found" cannot.
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
  // A solution carries its own `type` (the solution type): kept apart so it does not replace the entry type.
  const { type: solutionType, ...rest } = item;
  return {
    ...rest,
    type: String(e.type ?? "").toLowerCase(),
    ...(e.type === "Solution" ? { solution_type: solutionType ?? null } : solutionType !== undefined ? { item_type: solutionType } : {}),
    date: item.date ?? item.date_creation ?? item.submission_date ?? null,
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
/** Actor keys of the v1 input (`_users_id_assign`, `_groups_id_observer`…): the v2 sets people through the team endpoint. */
const ACTOR_KEY = /^_?(users|groups)_id_(requester|assign|observer)$/;
const ACTOR_ROLE: Record<string, string> = { requester: "requester", assign: "assigned", observer: "observer" };

interface Actor {
  type: "User" | "Group";
  id: number;
  role: string;
  key: string;
}

function ticketInput(input: Record<string, unknown>): { data: Record<string, unknown>; actors: Actor[] } {
  const data: Record<string, unknown> = {};
  const actors: Actor[] = [];
  for (const [k, v] of Object.entries(input)) {
    const m = ACTOR_KEY.exec(k);
    if (!m) {
      data[INPUT_V2[k] ?? k] = v;
      continue;
    }
    for (const one of Array.isArray(v) ? v : [v]) {
      const id = Number(one);
      if (Number.isInteger(id) && id > 0) actors.push({ type: m[1] === "users" ? "User" : "Group", id, role: ACTOR_ROLE[m[2]], key: k });
    }
  }
  return { data, actors };
}

/** v1 itemtype -> v2 collection, for the counts. */
const COUNT_PATH: Record<string, string> = {
  Ticket: "/Assistance/Ticket",
  Change: "/Assistance/Change",
  Problem: "/Assistance/Problem",
  User: "/Administration/User",
  Group: "/Administration/Group",
  Entity: "/Administration/Entity",
  KnowbaseItem: "/Knowledgebase/Article",
  Document: "/Management/Document",
  Location: "/Dropdowns/Location",
  ITILCategory: "/Dropdowns/ITILCategory",
};
/** Item types whose listing carries the trash flag: counts leave deleted items out, as the v1 search does. */
const HAS_TRASH = new Set(["Ticket", "Change", "Problem", "User", "Document"]);

const V2_ONLY = "This connection reaches GLPI through API v2, where this is not available.";
/** v1 tools with no v2 counterpart: the sentence a model gets instead of "tool not found". */
const UNSUPPORTED: Record<string, string> = {
  glpi_search: `${V2_ONLY} Generic search with criteria does not exist there. Use glpi_list_tickets (status filter), glpi_list_my_tickets, glpi_list_changes, glpi_list_problems, glpi_list_users or glpi_list_knowbase_items instead.`,
  glpi_list_search_options: `${V2_ONLY} Search options belong to the generic search, which API v2 does not have.`,
  glpi_search_user_by_email: `${V2_ONLY} Use glpi_list_users and look the person up by name.`,
  glpi_list_assets: `${V2_ONLY} Assets are not reachable through this connection.`,
  glpi_get_asset: `${V2_ONLY} Assets are not reachable through this connection.`,
  glpi_get_asset_details: `${V2_ONLY} Assets are not reachable through this connection.`,
  glpi_list_reservation_items: `${V2_ONLY} Reservations are not reachable through this connection.`,
  glpi_list_reservations: `${V2_ONLY} Reservations are not reachable through this connection.`,
  glpi_get_reservation: `${V2_ONLY} Reservations are not reachable through this connection.`,
  glpi_list_document_items: `${V2_ONLY} Use glpi_list_documents and glpi_get_document.`,
  glpi_get_document_item: `${V2_ONLY} Use glpi_list_documents and glpi_get_document.`,
  glpi_list_itil_followup_templates: `${V2_ONLY} Followup templates are not reachable through this connection.`,
  glpi_get_itil_followup_template: `${V2_ONLY} Followup templates are not reachable through this connection.`,
  glpi_update_ticket_validation: `${V2_ONLY} Answering an approval needs the ticket ID, which this tool does not take; the approver answers it in GLPI.`,
};

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

  /** Adds people to a ticket through the team endpoint; returns the ones GLPI refused. */
  async function setActors(ticketId: number | string, actors: Actor[]): Promise<{ field: string; id: number; error: string }[]> {
    const failed: { field: string; id: number; error: string }[] = [];
    for (const a of actors) {
      try {
        await addTeamMember(config, "Ticket", ticketId, { type: a.type, id: a.id, role: a.role });
      } catch (e) {
        failed.push({ field: a.key, id: a.id, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      }
    }
    return failed;
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
        scan_note: z.string().optional(),
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
        ...(capped ? { scan_note: `Only the ${MY_TICKETS_PAGES * PAGE} most recent tickets in these statuses were scanned.` } : {}),
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
        "type (1=Incident, 2=Request), urgency, impact, priority. People: _users_id_requester, _users_id_assign, " +
        "_users_id_observer, _groups_id_assign (one ID or a list); without a requester the connected user becomes " +
        "the requester. People are added right after the ticket is created; any that GLPI refused are listed in " +
        "actors_not_set.",
      inputSchema: z.object({ input: z.record(z.unknown()).describe("Ticket fields") }),
      outputSchema: outData(),
    },
    wrap(async ({ input }) => {
      const { data, actors } = ticketInput(input as Record<string, unknown>);
      const created = ((await createTicket(config, data)) ?? {}) as Row;
      const ticketId = Number(created.id);
      if (!Number.isInteger(ticketId) || ticketId <= 0) return jsonResult({ data: created });
      if (!actors.some((a) => a.role === "requester")) {
        const me = (await sessionUser().catch(() => undefined))?.id;
        if (me !== undefined) actors.unshift({ type: "User", id: me, role: "requester", key: "_users_id_requester" });
      }
      const failed = await setActors(ticketId, actors);
      return jsonResult({ data: failed.length ? { ...created, actors_not_set: failed } : created });
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
      const { data, actors } = ticketInput(input as Record<string, unknown>);
      const updated = Object.keys(data).length ? await updateTicket(config, ticketId, data) : undefined;
      const failed = await setActors(ticketId, actors);
      // Read again when people changed (or nothing else did): the answer shows the ticket as it is now.
      const current = updated && !actors.length ? updated : await getTicket(config, ticketId);
      const out = v1Row((await labelItil("Ticket", current ?? {})) as Row);
      return jsonResult({ data: failed.length ? { ...out, actors_not_set: failed } : out });
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

  // ===========================================================================
  // Ticket people and approvals
  // ===========================================================================

  server.registerTool(
    "glpi_list_ticket_groups",
    {
      title: "List ticket groups",
      description: "List the groups linked to a ticket, with names. type: 1=Requester, 2=Assigned, 3=Observer.",
      inputSchema: z.object({ ticketId: idSchema() }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId }) => {
      const t = (await getTicket(config, ticketId)) as Row | null;
      const team = Array.isArray(t?.team) ? (t!.team as Member[]) : [];
      return jsonResult({
        data: team
          .filter((m) => m.type === "Group")
          .map((m) => ({ groups_id: m.id, group_name: m.name, type: ROLE_TYPE[m.role ?? ""] ?? null, type_name: m.role })),
      });
    }),
  );

  const TYPE_ROLE: Record<number, string> = { 1: "requester", 2: "assigned", 3: "observer" };
  const actorTypeSchema = () => z.number().describe("1=Requester, 2=Assigned, 3=Observer");

  server.registerTool(
    "glpi_add_ticket_user",
    {
      title: "Add user to ticket",
      description: "Link a user to a ticket as requester, assigned technician or observer.",
      inputSchema: z.object({
        tickets_id: idSchema().describe("Ticket ID"),
        users_id: idSchema().describe("User ID"),
        type: actorTypeSchema(),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ tickets_id, users_id, type }) => {
      const role = TYPE_ROLE[type as number];
      if (!role) throw new Error("type must be 1 (requester), 2 (assigned) or 3 (observer).");
      await addTeamMember(config, "Ticket", tickets_id, { type: "User", id: Number(users_id), role });
      return jsonResult({ data: { tickets_id: Number(tickets_id), users_id: Number(users_id), type, type_name: role } });
    }),
  );

  server.registerTool(
    "glpi_add_ticket_group",
    {
      title: "Add group to ticket",
      description: "Link a group to a ticket as requester, assigned or observer group.",
      inputSchema: z.object({
        tickets_id: idSchema().describe("Ticket ID"),
        groups_id: idSchema().describe("Group ID"),
        type: actorTypeSchema(),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ tickets_id, groups_id, type }) => {
      const role = TYPE_ROLE[type as number];
      if (!role) throw new Error("type must be 1 (requester), 2 (assigned) or 3 (observer).");
      await addTeamMember(config, "Ticket", tickets_id, { type: "Group", id: Number(groups_id), role });
      return jsonResult({ data: { tickets_id: Number(tickets_id), groups_id: Number(groups_id), type, type_name: role } });
    }),
  );

  server.registerTool(
    "glpi_list_ticket_validations",
    {
      title: "List ticket validations",
      description: "List the approval requests of a ticket, with the approver, the comments and the status.",
      inputSchema: z.object({ ticketId: idSchema(), range: rangeSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId, range }) =>
      jsonResult({ data: page((await timeline("Ticket", ticketId)).filter((e) => e.type === "validation"), range) }),
    ),
  );

  server.registerTool(
    "glpi_create_ticket_validation",
    {
      title: "Create ticket validation",
      description: "Ask a user to approve a ticket.",
      inputSchema: z.object({
        ticketId: idSchema(),
        users_id_validate: idSchema().describe("ID of the user who must approve"),
        comment_submission: z.string().optional().describe("Comment sent with the request"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId, users_id_validate, comment_submission }) =>
      jsonResult({
        data: await addValidation(config, "Ticket", ticketId, {
          requested_approver_type: "User",
          requested_approver_id: Number(users_id_validate),
          ...(comment_submission !== undefined ? { submission_comment: comment_submission } : {}),
        }),
      }),
    ),
  );

  // ===========================================================================
  // Changes and problems (read)
  // ===========================================================================

  const itilSortSchema = () =>
    z.enum(["date_mod", "date", "id", "priority", "status", "name"]).optional().describe("Sort column (default date_mod = last update)");

  for (const it of [
    { itemtype: "Change" as const, plural: "changes", one: "change", idKey: "changeId", list: listChanges, get: getChange },
    { itemtype: "Problem" as const, plural: "problems", one: "problem", idKey: "problemId", list: listProblems, get: getProblem },
  ]) {
    server.registerTool(
      `glpi_list_${it.plural}`,
      {
        title: `List ${it.plural}`,
        description: `List GLPI ${it.plural}, most recently updated first by default, with status_name and priority_name.`,
        inputSchema: z.object({ range: rangeSchema, expand_dropdowns: expandSchema, sort: itilSortSchema(), order: orderSchema() }),
        outputSchema: outData(),
      },
      wrap(async ({ range, sort, order }) => {
        const r = parseRange(range as string | undefined) ?? { start: 0, limit: 25 };
        const raw = await it.list(config, {
          start: r.start,
          limit: Math.min(r.limit, PAGE),
          sort: sortParam(sort as string | undefined, order as string | undefined),
        });
        const rows = (await labelItil(it.itemtype, raw)) as Row[];
        return jsonResult({ data: (Array.isArray(rows) ? rows : []).filter((t) => !t.is_deleted).map((t) => v1Row(t)) });
      }),
    );

    server.registerTool(
      `glpi_get_${it.one}`,
      {
        title: `Get ${it.one}`,
        description: `Retrieve a single ${it.one} by ID, with status_name, priority_name and the people.`,
        inputSchema: z.object({ [it.idKey]: idSchema(), expand_dropdowns: expandSchema }),
        outputSchema: outData(),
      },
      wrap(async (args) => {
        const t = (await labelItil(it.itemtype, await it.get(config, (args as Row)[it.idKey] as number | string))) as Row | null;
        if (!t || typeof t !== "object") return jsonResult({ data: {} });
        return jsonResult({ data: { ...v1Row(t), content: t.content } });
      }),
    );

    for (const [suffix, type, what] of [["followups", "followup", "followups (comments)"], ["tasks", "task", "tasks"]] as const) {
      server.registerTool(
        `glpi_list_${it.one}_${suffix}`,
        {
          title: `List ${it.one} ${suffix}`,
          description: `List the ${what} of a ${it.one}, oldest first, with the author's name (user_name).`,
          inputSchema: z.object({ [it.idKey]: idSchema(), range: rangeSchema }),
          outputSchema: outData(),
        },
        wrap(async (args) => {
          const a = args as Row;
          const rows = await timeline(it.itemtype, a[it.idKey] as number | string);
          return jsonResult({ data: page(rows.filter((e) => e.type === type), a.range as string | undefined) });
        }),
      );
    }
  }

  // ===========================================================================
  // Catalogue reads: the v2 item as it is
  // ===========================================================================

  type ListFn = (cfg: GlpiV2Config, p?: { filter?: string; start?: number; limit?: number; sort?: string }) => Promise<unknown>;
  type GetFn = (cfg: GlpiV2Config, id: number | string) => Promise<unknown>;

  const lists: [name: string, title: string, description: string, fn: ListFn][] = [
    ["glpi_list_users", "List users", "List GLPI users (id, username, first and last name, e-mails).", listUsers],
    ["glpi_list_groups", "List groups", "List GLPI groups.", listGroups],
    ["glpi_list_entities", "List entities", "List the GLPI entities the connected user may see.", listEntities],
    ["glpi_list_itil_categories", "List ITIL categories", "List the ticket categories (ITIL categories).", listITILCategories],
    ["glpi_list_locations", "List locations", "List GLPI locations.", listLocations],
    ["glpi_list_documents", "List documents", "List GLPI documents (name, file name, type).", listDocuments],
    ["glpi_list_knowbase_items", "List knowledge base articles", "List knowledge base articles (id, title, summary). Open one with glpi_get_knowbase_item.", listKBArticles],
    ["glpi_list_knowbase_categories", "List knowledge base categories", "List the knowledge base categories.", listKBCategories],
  ];
  for (const [name, title, description, fn] of lists) {
    server.registerTool(
      name,
      { title, description, inputSchema: z.object({ range: rangeSchema, expand_dropdowns: expandSchema }), outputSchema: outData() },
      wrap(async ({ range }) => {
        const r = parseRange(range) ?? { start: 0, limit: 25 };
        const rows = await fn(config, { start: r.start, limit: Math.min(r.limit, PAGE) });
        return jsonResult({ data: Array.isArray(rows) ? rows : [] });
      }),
    );
  }

  const gets: [name: string, title: string, description: string, idKey: string, fn: GetFn, zero?: boolean][] = [
    ["glpi_get_user", "Get user", "Retrieve a GLPI user by ID.", "userId", getUser],
    ["glpi_get_group", "Get group", "Retrieve a GLPI group by ID.", "groupId", getGroup],
    ["glpi_get_entity", "Get entity", "Retrieve a GLPI entity by ID.", "entityId", getEntity, true],
    ["glpi_get_itil_category", "Get ITIL category", "Retrieve a ticket category by ID.", "categoryId", getITILCategory],
    ["glpi_get_location", "Get location", "Retrieve a GLPI location by ID.", "locationId", getLocation],
    ["glpi_get_document", "Get document", "Retrieve the record of a GLPI document by ID (not the file).", "documentId", getDocument],
    ["glpi_get_knowbase_item", "Get knowledge base article", "Retrieve a knowledge base article by ID, with its full text.", "knowbaseId", getKBArticle],
    ["glpi_get_knowbase_category", "Get knowledge base category", "Retrieve a knowledge base category by ID.", "categoryId", getKBCategory],
  ];
  for (const [name, title, description, idKey, fn, zero] of gets) {
    server.registerTool(
      name,
      { title, description, inputSchema: z.object({ [idKey]: itemIdSchema("Item ID", { allowZero: zero }) }), outputSchema: outData() },
      wrap(async (args) => jsonResult({ data: (await fn(config, (args as Row)[idKey] as number | string)) ?? {} })),
    );
  }

  // ===========================================================================
  // Session: profiles and entities of the connected user
  // ===========================================================================

  type SessionEntity = { id?: number; name?: string; is_recursive?: unknown };
  // GLPI sends `entities` as a list or as an object keyed by ID, depending on the profile.
  type SessionProfile = { name?: string; entities?: SessionEntity[] | Record<string, SessionEntity> };
  async function sessionProfiles(): Promise<{ id: number; name: string | null; entities: Row[] }[]> {
    const s = (await getSession(config)) as Row | null;
    const profiles = (s?.profiles ?? {}) as Record<string, SessionProfile>;
    return Object.entries(profiles).map(([id, p]) => ({
      id: Number(id),
      name: p?.name ?? null,
      entities: Object.values(p?.entities ?? {}).map((e) => ({ id: e?.id, name: e?.name, is_recursive: Boolean(Number(e?.is_recursive)) })),
    }));
  }

  server.registerTool(
    "glpi_get_my_profiles",
    {
      title: "Get my profiles",
      description: "Profiles of the connected GLPI user, each with the entities it applies to.",
      inputSchema: z.object({}),
      outputSchema: outData(),
    },
    wrap(async () => jsonResult({ data: await sessionProfiles() })),
  );

  server.registerTool(
    "glpi_get_my_entities",
    {
      title: "Get my entities",
      description: "Entities the connected GLPI user has a profile on.",
      inputSchema: z.object({}),
      outputSchema: outData(),
    },
    wrap(async () => {
      const seen = new Map<unknown, Row>();
      for (const p of await sessionProfiles()) for (const e of p.entities) if (!seen.has(e.id)) seen.set(e.id, e);
      return jsonResult({ data: [...seen.values()] });
    }),
  );

  // ===========================================================================
  // Counts (the total GLPI sends in Content-Range)
  // ===========================================================================

  const criteriaSchema = () =>
    z.array(z.record(z.unknown())).optional().describe("Not supported on this connection (GLPI API v2): leave empty");
  const NO_CRITERIA =
    `${V2_ONLY} Counting with search criteria is not possible. Count without criteria, use glpi_get_ticket_stats for ` +
    "tickets per status, or glpi_list_tickets / glpi_list_my_tickets with a status filter.";

  async function count(itemtype: string, filter?: string): Promise<number> {
    const base = HAS_TRASH.has(itemtype) ? "is_deleted==false" : undefined;
    const rsql = [base, filter].filter(Boolean).join(";") || undefined;
    const total = await countCollection(config, COUNT_PATH[itemtype], rsql);
    if (total === undefined) throw new Error("GLPI did not report the total for this listing (no Content-Range header).");
    return total;
  }

  server.registerTool(
    "glpi_count_items",
    {
      title: "Count items",
      description:
        "Count the items of a type without transferring them. Types: " + Object.keys(COUNT_PATH).join(", ") +
        ". Deleted (trashed) items are left out. For tickets per status use glpi_get_ticket_stats.",
      inputSchema: z.object({ itemtype: z.string().describe("Item type, e.g. Ticket, User"), criteria: criteriaSchema() }),
      outputSchema: z.object({ data: z.object({ itemtype: z.string(), total: z.number() }) }),
    },
    wrap(async ({ itemtype, criteria }) => {
      if (criteria?.length) throw new Error(NO_CRITERIA);
      if (!COUNT_PATH[itemtype]) {
        throw new Error(`${V2_ONLY} Countable types here: ${Object.keys(COUNT_PATH).join(", ")}.`);
      }
      return jsonResult({ data: { itemtype, total: await count(itemtype) } });
    }),
  );

  server.registerTool(
    "glpi_get_ticket_stats",
    {
      title: "Get ticket stats",
      description:
        "Ticket counts per built-in status (New, Processing assigned/planned, Pending, Solved, Closed), " +
        "other_status_count for codes outside 1–6, and the total, without listing the tickets. Counts cover every " +
        "ticket the connected user may see (deleted ones left out). Report other statuses separately and check " +
        "counts_consistent before reporting an exact breakdown.",
      inputSchema: z.object({ criteria: criteriaSchema() }),
      outputSchema: outData(),
    },
    wrap(async ({ criteria }) => {
      if (criteria?.length) throw new Error(NO_CRITERIA);
      const codes = Object.keys(TICKET_STATUS);
      const [total, other, ...per] = await Promise.all([
        count("Ticket"),
        count("Ticket", `status.id=out=(${codes.join(",")})`),
        ...codes.map((code) => count("Ticket", `status.id==${code}`)),
      ]);
      const by_status = codes.map((code, i) => ({ status: TICKET_STATUS[Number(code)], code: Number(code), count: per[i] }));
      const counts_consistent = total === other + per.reduce((sum, n) => sum + n, 0);
      const notes: string[] = [];
      if (other > 0) notes.push("other_status_count includes status codes outside GLPI's built-in statuses 1–6; do not assign them a built-in status.");
      if (!counts_consistent) notes.push("Counts were read separately and do not reconcile; tickets may have changed during collection. Retry before reporting an exact breakdown.");
      return jsonResult({
        data: { total, by_status, other_status_count: other, counts_consistent, ...(notes.length ? { note: notes.join(" ") } : {}) },
      });
    }),
  );

  // ===========================================================================
  // v1 tools with no v2 counterpart: one actionable sentence
  // ===========================================================================

  for (const [name, message] of Object.entries(UNSUPPORTED)) {
    server.registerTool(
      name,
      {
        title: "Not available on this connection",
        description: `Not available on this connection (GLPI API v2). ${message}`,
        inputSchema: z.object({}).passthrough(),
        outputSchema: outData(),
      },
      wrap(async () => {
        throw new Error(message);
      }),
    );
  }
}

/** Every name registerV1CompatTools registers (collected once against a recorder). */
let compatNames: string[] | undefined;
export function v1CompatToolNames(): string[] {
  if (compatNames) return compatNames;
  const names: string[] = [];
  const recorder = { registerTool: (name: string) => void names.push(name) } as unknown as McpServer;
  const passthrough = ((fn: unknown) => fn) as unknown as Wrap;
  registerV1CompatTools(
    recorder,
    { baseUrl: "", clientId: "", clientSecret: "", username: "", password: "", scope: "api" },
    { wrap: passthrough, labelItil: async (_t, r) => r, withStatusFilter: (f) => f },
  );
  compatNames = names;
  return names;
}
