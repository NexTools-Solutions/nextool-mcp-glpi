/**
 * Ticket listings that answer the questions people actually ask: "my tickets",
 * "what is open", "what changed today" (API v1).
 *
 * Plain getAllItems (GET /Ticket) sorts by ID ascending and cannot filter on
 * several statuses or on actors, so "list my tickets" used to return the oldest
 * tickets of the whole instance. Verified on GLPI 11.0.7:
 *   - GET /Ticket?sort=<column>&order=DESC sorts getAllItems;
 *   - GET /search/Ticket with criteria on option 12 accepts the status codes
 *     and the special values "notold" (not solved nor closed), "old", "process";
 *   - nested criteria groups (criteria[0][criteria][j]...) express "requester OR
 *     assigned OR observer";
 *   - actor options 4 (requester), 5 (assigned technician), 66 (observer)
 *     return user IDs (an array when there are several).
 */

import { search, searchItems, type GlpiConfig } from "./glpi-client.js";
import { sessionInfo, sessionLabels } from "./labels.js";
import { addLabels, addNames, itilLabelSpecs, resolveNames, TICKET_NAMES, type NameSpec } from "./names.js";

// ---------------------------------------------------------------------------
// Status filter
// ---------------------------------------------------------------------------

/** Names accepted by the `status` parameter. */
export const TICKET_STATUS_FILTERS = [
  "open",
  "new",
  "assigned",
  "processing",
  "planned",
  "pending",
  "solved",
  "closed",
] as const;
export type TicketStatusFilter = (typeof TICKET_STATUS_FILTERS)[number];

/** Status name -> GLPI code; "open" -> the search special value "notold" (codes 1-4). */
export const STATUS_CODES: Record<Exclude<TicketStatusFilter, "open">, number> = {
  new: 1,
  assigned: 2,
  processing: 2,
  planned: 3,
  pending: 4,
  solved: 5,
  closed: 6,
};

/** Search option of Ticket.status. */
const STATUS_OPTION = 12;

/** "open,solved" or ["open","solved"] -> validated, de-duplicated names. */
export function normalizeStatuses(value: string | readonly string[] | undefined): TicketStatusFilter[] {
  const raw = typeof value === "string" ? value.split(",") : (value ?? []);
  const names = [...new Set(raw.map((s) => s.trim().toLowerCase()).filter(Boolean))];
  const bad = names.filter((n) => !(TICKET_STATUS_FILTERS as readonly string[]).includes(n));
  if (bad.length) throw new Error(`unknown status: ${bad.join(", ")} (valid: ${TICKET_STATUS_FILTERS.join(", ")})`);
  return names as TicketStatusFilter[];
}

/** Codes 1-6 matched by a set of status names. */
export function statusCodes(statuses: readonly TicketStatusFilter[]): number[] {
  const codes = new Set<number>();
  for (const s of statuses) {
    if (s === "open") [1, 2, 3, 4].forEach((c) => codes.add(c));
    else codes.add(STATUS_CODES[s]);
  }
  return [...codes].sort((a, b) => a - b);
}

/** One search criterion (or an OR group) on Ticket.status. */
export function statusCriterion(statuses: readonly TicketStatusFilter[]): Record<string, unknown> {
  const codes = statusCodes(statuses);
  const isOpenSet = codes.length === 4 && codes.every((c, i) => c === i + 1);
  if (isOpenSet) return { field: STATUS_OPTION, searchtype: "equals", value: "notold" };
  if (codes.length === 1) return { field: STATUS_OPTION, searchtype: "equals", value: codes[0] };
  return {
    criteria: codes.map((c, i) => ({
      ...(i > 0 ? { link: "OR" } : {}),
      field: STATUS_OPTION,
      searchtype: "equals",
      value: c,
    })),
  };
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export const TICKET_SORT_FIELDS = ["date_mod", "date", "id", "priority", "status", "name", "solvedate", "closedate"] as const;
export type TicketSortField = (typeof TICKET_SORT_FIELDS)[number];

/** Column name (getAllItems `sort`) -> Ticket search option ID (search `sort`). */
const SORT_OPTION: Record<TicketSortField, number> = {
  date_mod: 19,
  date: 15,
  id: 2,
  priority: 3,
  status: 12,
  name: 1,
  solvedate: 17,
  closedate: 16,
};

export const DEFAULT_TICKET_SORT: TicketSortField = "date_mod";

export function sortOrder(order: string | undefined): "ASC" | "DESC" {
  return order?.toLowerCase() === "asc" ? "ASC" : "DESC";
}

// ---------------------------------------------------------------------------
// glpi_list_tickets
// ---------------------------------------------------------------------------

export interface TicketListParams {
  range?: string;
  expand_dropdowns?: boolean;
  sort?: TicketSortField;
  order?: "asc" | "desc";
  status?: string | readonly string[];
}

/**
 * Tickets in the requested order (default: most recently updated first).
 * Without a status filter: getAllItems with sort/order. With one: a search on
 * the status for the IDs, then the full items — same row shape, plus `total`.
 */
export async function listTicketsSorted(
  config: GlpiConfig,
  params: TicketListParams,
  listAll: (p: { range?: string; expand_dropdowns?: boolean; sort?: string; order?: "ASC" | "DESC" }) => Promise<unknown>,
): Promise<{ rows: Record<string, unknown>[]; total?: number }> {
  const sort = params.sort ?? DEFAULT_TICKET_SORT;
  const order = sortOrder(params.order);
  const statuses = normalizeStatuses(params.status);

  if (statuses.length === 0) {
    const res = await listAll({ range: params.range, expand_dropdowns: params.expand_dropdowns, sort, order });
    return { rows: Array.isArray(res) ? (res as Record<string, unknown>[]) : [] };
  }

  return searchItems(config, "Ticket", {
    criteria: [statusCriterion(statuses)],
    range: params.range,
    sort: SORT_OPTION[sort],
    order,
    expand_dropdowns: params.expand_dropdowns,
  });
}

// ---------------------------------------------------------------------------
// glpi_get_ticket names
// ---------------------------------------------------------------------------

/**
 * Adds recipient/last updater/category/entity/request type/location names and the
 * status/type/priority/urgency/impact labels (in the GLPI user's language).
 */
export async function nameTicket(config: GlpiConfig, ticket: Record<string, unknown>): Promise<Record<string, unknown>> {
  const [[row], labels] = await Promise.all([addNames(config, [ticket], TICKET_NAMES), sessionLabels(config)]);
  return addLabels([row], labels, itilLabelSpecs("Ticket"))[0];
}

// ---------------------------------------------------------------------------
// glpi_list_tickets names
// ---------------------------------------------------------------------------

/** Names on a ticket listing: the category beside its ID. */
const TICKET_LIST_NAMES: NameSpec[] = [{ field: "itilcategories_id", itemtype: "ITILCategory", as: "category_name" }];

/** IDs per actor search on one request: keeps the query string well under URL limits. */
const ACTOR_CHUNK = 50;

/**
 * Requesters and assigned technicians of a page of tickets, in one search per
 * 50 tickets (criteria "id = a OR id = b ..." with options 4 and 5 displayed)
 * instead of one Ticket_User listing per ticket. A failed search leaves the
 * people out; the ticket rows themselves are not affected.
 */
async function ticketActors(
  config: GlpiConfig,
  ids: number[],
): Promise<Map<number, { requesters: Person[]; assigned: Person[] }>> {
  const out = new Map<number, { requesters: Person[]; assigned: Person[] }>();
  const raw: Record<string, unknown>[] = [];
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += ACTOR_CHUNK) chunks.push(ids.slice(i, i + ACTOR_CHUNK));
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const res = await search(config, "Ticket", {
          criteria: chunk.map((tid, i) => ({ ...(i > 0 ? { link: "OR" } : {}), field: 2, searchtype: "equals", value: tid })),
          forcedisplay: [2, 4, 5],
          range: `0-${chunk.length - 1}`,
        });
        raw.push(...(res?.data ?? []));
      } catch {
        // People are an extra: without them the listing still answers.
      }
    }),
  );
  const names = await resolveNames(config, "User", [...new Set(raw.flatMap((r) => [...userIds(r["4"]), ...userIds(r["5"])]))]);
  for (const r of raw) {
    const tid = Number(r["2"]);
    if (Number.isInteger(tid)) out.set(tid, { requesters: people(r["4"], names), assigned: people(r["5"], names) });
  }
  return out;
}

/**
 * Ticket listing rows with what a person reads: status/type/priority labels in
 * the GLPI user's language, the category name, and the requesters and assigned
 * technicians as {id, name}. IDs stay; names are added beside them.
 */
export async function nameTicketRows(config: GlpiConfig, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isInteger(n) && n > 0);
  const [named, labels, actors] = await Promise.all([
    addNames(config, rows, TICKET_LIST_NAMES),
    sessionLabels(config),
    ticketActors(config, ids),
  ]);
  return addLabels(named, labels, itilLabelSpecs("Ticket")).map((r) => {
    const a = actors.get(Number(r.id));
    return a ? { ...r, requesters: a.requesters, assigned: a.assigned } : r;
  });
}

// ---------------------------------------------------------------------------
// glpi_list_my_tickets
// ---------------------------------------------------------------------------

export const MY_TICKET_ROLES = ["any", "requester", "assigned", "observer"] as const;
export type MyTicketRole = (typeof MY_TICKET_ROLES)[number];

/** Actor search options on Ticket. */
const ROLE_OPTION: Record<Exclude<MyTicketRole, "any">, number> = {
  requester: 4,
  assigned: 5,
  observer: 66,
};

/** Columns asked of the search: id, title, status, type, priority, dates, category, entity, actors, groups. */
const MY_TICKET_COLUMNS = [2, 1, 12, 14, 3, 15, 19, 7, 80, 4, 5, 66, 71, 8];

export interface SessionUser {
  id: number;
  name: string | null;
}

/** The connected user (getFullSession -> glpiID), cached per credential for a few minutes. */
export async function sessionUser(config: GlpiConfig): Promise<SessionUser> {
  const info = await sessionInfo(config);
  if (info.userId === null) throw new Error("GLPI session has no user (glpiID missing)");
  return { id: info.userId, name: info.userName };
}

export interface MyTicketParams {
  role?: MyTicketRole;
  status?: string | readonly string[];
  sort?: TicketSortField;
  order?: "asc" | "desc";
  range?: string;
  users_id?: number | string;
}

export interface Person {
  id: number | null;
  name: string | null;
}

export interface MyTicketRow {
  id: unknown;
  name: unknown;
  status: unknown;
  status_name?: string;
  type: unknown;
  type_name?: string;
  priority: unknown;
  priority_name?: string;
  date: unknown;
  date_mod: unknown;
  category: unknown;
  entity: unknown;
  requesters: Person[];
  assigned: Person[];
  observers: Person[];
  requester_groups: unknown[];
  assigned_groups: unknown[];
  my_roles: string[];
}

function asList(v: unknown): unknown[] {
  if (v === null || v === undefined || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

function userIds(v: unknown): number[] {
  return asList(v)
    .map((x) => (typeof x === "number" ? x : typeof x === "string" && /^\d+$/.test(x) ? Number(x) : NaN))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Actor search column -> people; an anonymous requester (email only) has no user ID: keep what GLPI shows. */
function people(v: unknown, names: Map<number, string | null>): Person[] {
  const ids = userIds(v);
  const loose = asList(v).filter((x) => !(typeof x === "number" || (typeof x === "string" && /^\d+$/.test(x))));
  return [...ids.map((i) => ({ id: i, name: names.get(i) ?? null })), ...loose.map((x) => ({ id: null, name: String(x) }))];
}

/**
 * Tickets where the user (default: the connected one) is requester, assigned
 * technician or observer — by default the open ones, most recently updated
 * first. Actors come back as {id, name}.
 */
export async function listMyTickets(
  config: GlpiConfig,
  params: MyTicketParams,
): Promise<{ user: SessionUser; role: MyTicketRole; status: string[]; total: number; rows: MyTicketRow[] }> {
  const role = params.role ?? "any";
  const statuses = normalizeStatuses(params.status ?? ["open"]);
  const sort = params.sort ?? DEFAULT_TICKET_SORT;
  const order = sortOrder(params.order);

  let user: SessionUser;
  if (params.users_id !== undefined && params.users_id !== null && String(params.users_id) !== "") {
    const uid = Number(params.users_id);
    if (!Number.isInteger(uid) || uid <= 0) throw new Error("users_id must be a positive user ID");
    const names = await resolveNames(config, "User", [uid]);
    user = { id: uid, name: names.get(uid) ?? null };
  } else {
    user = await sessionUser(config);
  }

  const roles = role === "any" ? (["requester", "assigned", "observer"] as const) : ([role] as const);
  const actorCriteria = roles.map((r, i) => ({
    ...(i > 0 ? { link: "OR" } : {}),
    field: ROLE_OPTION[r],
    searchtype: "equals",
    value: user.id,
  }));
  const criteria: Record<string, unknown>[] = [actorCriteria.length === 1 ? actorCriteria[0] : { criteria: actorCriteria }];
  if (statuses.length) criteria.push({ link: "AND", ...statusCriterion(statuses) });

  const res = await search(config, "Ticket", {
    criteria,
    forcedisplay: MY_TICKET_COLUMNS,
    range: params.range,
    sort: SORT_OPTION[sort],
    order,
  });
  const raw = res?.data ?? [];

  const allIds = raw.flatMap((r) => [...userIds(r["4"]), ...userIds(r["5"]), ...userIds(r["66"])]);
  const [names, labels] = await Promise.all([
    resolveNames(config, "User", [...new Set([user.id, ...allIds])]),
    sessionLabels(config),
  ]);

  const rows: MyTicketRow[] = raw.map((r) => {
    const requesters = people(r["4"], names);
    const assigned = people(r["5"], names);
    const observers = people(r["66"], names);
    const my_roles = [
      requesters.some((p) => p.id === user.id) && "requester",
      assigned.some((p) => p.id === user.id) && "assigned",
      observers.some((p) => p.id === user.id) && "observer",
    ].filter(Boolean) as string[];
    const status = r["12"];
    const type = r["14"];
    return {
      id: r["2"],
      name: r["1"],
      status,
      status_name: labels.ticket_status[Number(status)],
      type,
      type_name: labels.ticket_type[Number(type)],
      priority: r["3"],
      priority_name: labels.priority[Number(r["3"])],
      date: r["15"],
      date_mod: r["19"],
      category: r["7"] ?? null,
      entity: r["80"] ?? null,
      requesters,
      assigned,
      observers,
      requester_groups: asList(r["71"]),
      assigned_groups: asList(r["8"]),
      my_roles,
    };
  });

  return {
    user: { id: user.id, name: user.name ?? names.get(user.id) ?? null },
    role,
    status: statuses,
    total: typeof res?.totalcount === "number" ? res.totalcount : rows.length,
    rows,
  };
}
