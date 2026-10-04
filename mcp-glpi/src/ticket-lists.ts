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

import {
  getFullSession,
  search,
  searchItems,
  v1CredentialKey,
  type GlpiConfig,
} from "./glpi-client.js";
import {
  addCodeName,
  addNames,
  resolveNames,
  TICKET_NAMES,
  TICKET_STATUS_NAMES,
  TICKET_TYPE_NAMES,
} from "./names.js";

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

/** Adds recipient/last updater/category/entity/request type/location names and status/type labels. */
export async function nameTicket(config: GlpiConfig, ticket: Record<string, unknown>): Promise<Record<string, unknown>> {
  let [row] = await addNames(config, [ticket], TICKET_NAMES);
  [row] = addCodeName([row], "status", "status_name", TICKET_STATUS_NAMES);
  [row] = addCodeName([row], "type", "type_name", TICKET_TYPE_NAMES);
  return row;
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

const SESSION_USER_TTL_MS = 5 * 60_000;
const sessionUsers = new Map<string, { user: SessionUser; expires: number }>();

export interface SessionUser {
  id: number;
  name: string | null;
}

/** The connected user (getFullSession -> glpiID), cached per credential for a few minutes. */
export async function sessionUser(config: GlpiConfig): Promise<SessionUser> {
  const key = v1CredentialKey(config);
  const hit = sessionUsers.get(key);
  if (hit && hit.expires > Date.now()) return hit.user;
  const res = (await getFullSession(config)) as { session?: Record<string, unknown> } | undefined;
  const s = res?.session ?? {};
  const userId = Number(s.glpiID);
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("GLPI session has no user (glpiID missing)");
  const friendly = [s.glpifriendlyname, s.glpiname].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  const user = { id: userId, name: friendly ?? null };
  sessionUsers.set(key, { user, expires: Date.now() + SESSION_USER_TTL_MS });
  return user;
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
  const names = await resolveNames(config, "User", [...new Set([user.id, ...allIds])]);
  const people = (v: unknown): Person[] => {
    const ids = userIds(v);
    // An anonymous requester (email only) has no user ID: keep what GLPI shows.
    const loose = asList(v).filter((x) => !(typeof x === "number" || (typeof x === "string" && /^\d+$/.test(x))));
    return [...ids.map((i) => ({ id: i, name: names.get(i) ?? null })), ...loose.map((x) => ({ id: null, name: String(x) }))];
  };

  const rows: MyTicketRow[] = raw.map((r) => {
    const requesters = people(r["4"]);
    const assigned = people(r["5"]);
    const observers = people(r["66"]);
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
      status_name: TICKET_STATUS_NAMES[Number(status)],
      type,
      type_name: TICKET_TYPE_NAMES[Number(type)],
      priority: r["3"],
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
