/**
 * HTTP client for the GLPI REST API.
 * Supports: (1) Classic API apirest.php and (2) API v1 (api.php/v1).
 * Authentication: user_token (Remote access key) + optional App-Token.
 *
 * Features:
 *   - Automatic retry with exponential backoff (429 / 5xx)
 *   - Configurable timeout (default 30 s)
 *   - Typed GlpiApiError for structured error handling
 *   - ID sanitization with encodeURIComponent
 *   - Node 16 fallback when globalThis.fetch is unavailable
 *   - Injectable fetch (`config.fetchImpl`); redirects are never followed
 *
 * Environment tunables:
 *   GLPI_MAX_RETRIES — max retry attempts (default 3)
 *   GLPI_TIMEOUT     — request timeout in ms  (default 30000)
 */

import {
  GlpiHttpError,
  MAX_RETRIES,
  backoffDelay,
  fetchFn,
  fetchWithTimeout,
  isRetryable,
  sanitizeId as id,
  sleep,
  trimSlash,
  withQs,
  type FetchImpl,
  type RequestInitLike,
} from "@nextoolsolutions/mcp-glpi-core";
import { credentialKey } from "./instance.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GlpiConfig = {
  baseUrl: string;
  userToken: string;
  appToken?: string;
  /**
   * fetch used for every request of this credential (default: global fetch).
   * Always called with `redirect: "manual"`; a 3xx becomes GlpiRedirectError.
   */
  fetchImpl?: FetchImpl;
};

export class GlpiApiError extends GlpiHttpError {
  constructor(message: string, status: number, method: string, path: string) {
    super(message, status, method, path, "GlpiApiError");
  }
}

// ---------------------------------------------------------------------------
// Core request helpers
// ---------------------------------------------------------------------------

const API_PREFIX_CLASSIC = "/apirest.php";

/** true if baseUrl is the v1 API (api.php/v1) */
function isV1Api(config: GlpiConfig): boolean {
  return config.baseUrl.includes("api.php/v1");
}

function getApiBase(config: GlpiConfig): string {
  const base = trimSlash(config.baseUrl);
  return isV1Api(config) ? base : base + API_PREFIX_CLASSIC;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

// One GLPI session per credential (URL + tokens): the HTTP entry serves many
// instances from one process, and two users of the same GLPI must not share a session.
const sessionTokens = new Map<string, string>();

function sessionKey(config: GlpiConfig): string {
  return credentialKey("v1", trimSlash(config.baseUrl), config.userToken, config.appToken);
}

/** Cache key of one v1 credential: per-user caches (names, session user) must never be shared. */
export function v1CredentialKey(config: GlpiConfig): string {
  return sessionKey(config);
}

async function initSession(config: GlpiConfig): Promise<string> {
  const baseUrl = trimSlash(config.baseUrl);
  const isV1 = isV1Api(config);
  const initPath = isV1 ? "/initSession" : API_PREFIX_CLASSIC + "/initSession";
  const url = baseUrl + initPath;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `user_token ${config.userToken}`,
  };
  if (config.appToken) headers["App-Token"] = config.appToken;
  const res = await fetchFn(
    url,
    { method: isV1 ? "POST" : "GET", headers, body: isV1 ? "{}" : undefined },
    config.fetchImpl,
  );
  const text = await res.text();
  if (!res.ok) throw new GlpiApiError(`GLPI initSession failed: ${res.status}`, res.status, isV1 ? "POST" : "GET", "/initSession");
  const data = JSON.parse(text) as { session_token?: string };
  if (!data.session_token) throw new GlpiApiError("GLPI initSession: session_token not returned", 0, "GET", "/initSession");
  return data.session_token;
}

async function getSessionToken(config: GlpiConfig): Promise<string> {
  const key = sessionKey(config);
  const cached = sessionTokens.get(key);
  if (cached) return cached;
  const token = await initSession(config);
  sessionTokens.set(key, token);
  return token;
}

// ---------------------------------------------------------------------------
// Core API request with retry + timeout
// ---------------------------------------------------------------------------

export async function glpiRequest<T = unknown>(
  config: GlpiConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const sessionToken = await getSessionToken(config);
  const url = getApiBase(config) + (path.startsWith("/") ? path : `/${path}`);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Session-Token": sessionToken,
  };
  if (config.appToken) headers["App-Token"] = config.appToken;

  const init: RequestInitLike = {
    method,
    headers,
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url, init, config.fetchImpl);

      const text = await res.text();

      // Session expired — clear cache and throw (caller can retry)
      if (res.status === 401) {
        sessionTokens.delete(sessionKey(config));
        throw new GlpiApiError(
          "GLPI session expired or invalid (401). Retry the operation.",
          401, method, path,
        );
      }

      if (!res.ok) {
        // Try to extract a clean error message from GLPI JSON response
        let errorMsg: string;
        try {
          const parsed = JSON.parse(text) as [string, string] | { message?: string };
          if (Array.isArray(parsed)) {
            errorMsg = parsed[1] ?? parsed[0] ?? text;
          } else {
            errorMsg = parsed.message ?? text;
          }
        } catch {
          errorMsg = text;
        }

        const err = new GlpiApiError(
          `GLPI ${method} ${path}: ${res.status} – ${errorMsg}`,
          res.status, method, path,
        );
        if (attempt < MAX_RETRIES && isRetryable(res.status)) {
          lastError = err;
          await sleep(backoffDelay(attempt));
          continue;
        }
        throw err;
      }

      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    } catch (e) {
      // Typed GLPI answers (incl. a refused redirect) are final; only network errors retry.
      if (e instanceof GlpiHttpError) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt));
        continue;
      }
    }
  }

  throw lastError ?? new Error("GLPI request failed");
}

// ---------------------------------------------------------------------------
// Ticket
// ---------------------------------------------------------------------------

/** Sort parameters of getAllItems: a column of the itemtype's table and a direction. */
export interface SortParams {
  sort?: string;
  order?: "ASC" | "DESC";
}

/** List tickets. range e.g. "0-49"; sort is a column name (date_mod, date, id, priority...). */
export async function listTickets(
  config: GlpiConfig,
  params?: { range?: string; expand_dropdowns?: boolean } & SortParams,
) {
  return glpiRequest<unknown[]>(
    config,
    "GET",
    withQs("/Ticket/", {
      range: params?.range,
      expand_dropdowns: params?.expand_dropdowns,
      sort: params?.sort,
      order: params?.order,
    }),
  );
}

/** Get a ticket by ID */
export async function getTicket(config: GlpiConfig, ticketId: number | string, params?: { expand_dropdowns?: boolean }) {
  return glpiRequest<Record<string, unknown>>(
    config,
    "GET",
    withQs(`/Ticket/${id(ticketId)}`, { expand_dropdowns: params?.expand_dropdowns }),
  );
}

/**
 * Several items of one itemtype in one request (GET /getMultipleItems), in the
 * order of `ids`. Used after a search to return full items instead of search
 * columns.
 */
export async function getMultipleItems(
  config: GlpiConfig,
  itemtype: string,
  ids: (number | string)[],
  params?: { expand_dropdowns?: boolean },
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const q = new URLSearchParams();
  ids.forEach((itemId, i) => {
    q.set(`items[${i}][itemtype]`, itemtype);
    q.set(`items[${i}][items_id]`, String(itemId));
  });
  if (params?.expand_dropdowns) q.set("expand_dropdowns", "true");
  const res = await glpiRequest<unknown>(config, "GET", `/getMultipleItems?${q.toString()}`);
  const rows = (Array.isArray(res) ? res : []).filter(
    (r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r),
  );
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  return ids.map((i) => byId.get(String(i))).filter((r): r is Record<string, unknown> => r !== undefined);
}

/** Create a ticket. input: { name, content, entities_id, _users_id_requester, ... } */
export async function createTicket(config: GlpiConfig, input: Record<string, unknown>) {
  const payload = { ...input };
  if (payload.users_id_requester !== undefined && payload._users_id_requester === undefined) {
    payload._users_id_requester = payload.users_id_requester;
  }
  return glpiRequest<{ id: number }>(config, "POST", "/Ticket/", { input: payload });
}

/** Update a ticket */
export async function updateTicket(config: GlpiConfig, ticketId: number | string, input: Record<string, unknown>) {
  return glpiRequest<unknown>(config, "PUT", `/Ticket/${id(ticketId)}`, { input });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Encodes search criteria as GLPI expects them in the query string, nested
 * groups included: {link: "AND", criteria: [{field: 4, ...}, {link: "OR", ...}]}
 * becomes criteria[i][criteria][j][field]=4 ... (before 3.4.0 a nested group
 * was sent as "[object Object]" and silently matched nothing).
 */
export function appendCriteria(q: URLSearchParams, prefix: string, criteria: Record<string, unknown>[]): void {
  criteria.forEach((c, i) => {
    for (const [k, v] of Object.entries(c)) {
      // An undefined entry (a `link` omitted on the first criterion) must be
      // dropped, not stringified — GLPI rejects "link=undefined".
      if (v === undefined || v === null) continue;
      if (k === "criteria" && Array.isArray(v)) {
        appendCriteria(q, `${prefix}[${i}][criteria]`, v as Record<string, unknown>[]);
      } else {
        q.set(`${prefix}[${i}][${k}]`, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
    }
  });
}

/** Raw answer of GET /search/:itemtype. */
export interface SearchResponse {
  totalcount?: number;
  count?: number;
  data?: Record<string, unknown>[];
  [k: string]: unknown;
}

/** Search with criteria. itemtype: Ticket, User, etc. sort = search option ID. */
export async function search(
  config: GlpiConfig,
  itemtype: string,
  params?: {
    range?: string;
    criteria?: Record<string, unknown>[];
    forcedisplay?: number[];
    sort?: number;
    order?: "ASC" | "DESC";
  },
): Promise<SearchResponse | undefined> {
  const q = new URLSearchParams();
  if (params?.range) q.set("range", params.range);
  if (params?.criteria?.length) appendCriteria(q, "criteria", params.criteria);
  if (params?.forcedisplay?.length) params.forcedisplay.forEach((f, i) => q.set(`forcedisplay[${i}]`, String(f)));
  if (params?.sort !== undefined) q.set("sort", String(params.sort));
  if (params?.order) q.set("order", params.order);
  const query = q.toString();
  return glpiRequest<SearchResponse>(config, "GET", `/search/${encodeURIComponent(itemtype)}` + (query ? `?${query}` : ""));
}

/**
 * Runs a search for the IDs (search option 2) in the requested order, then
 * fetches the full items with getMultipleItems — the result has the same shape
 * as a getAllItems listing, plus the search total.
 */
export async function searchItems(
  config: GlpiConfig,
  itemtype: string,
  params: {
    criteria?: Record<string, unknown>[];
    range?: string;
    sort?: number;
    order?: "ASC" | "DESC";
    expand_dropdowns?: boolean;
  },
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const res = await search(config, itemtype, {
    range: params.range,
    criteria: params.criteria,
    forcedisplay: [2],
    sort: params.sort,
    order: params.order,
  });
  const ids = (res?.data ?? []).map((r) => r["2"]).filter((v) => v !== undefined && v !== null) as (number | string)[];
  const rows = await getMultipleItems(config, itemtype, ids, { expand_dropdowns: params.expand_dropdowns });
  return { rows, total: typeof res?.totalcount === "number" ? res.totalcount : rows.length };
}

// ---------------------------------------------------------------------------
// ITILFollowup (comments)
// ---------------------------------------------------------------------------

/** Add a followup (comment) to an ITIL item */
export async function addFollowup(
  config: GlpiConfig,
  input: { itemtype: string; items_id: number | string; content: string; is_private?: number; users_id?: number },
) {
  return glpiRequest<unknown>(config, "POST", "/ITILFollowup", { input });
}

/** List followups for a ticket */
export async function listFollowups(config: GlpiConfig, ticketId: number | string, params?: { range?: string }) {
  return glpiRequest<unknown>(config, "GET", withQs(`/Ticket/${id(ticketId)}/ITILFollowup`, { range: params?.range }));
}

// ---------------------------------------------------------------------------
// Unified timeline
// ---------------------------------------------------------------------------

/** ITIL itemtypes that have a timeline. */
export type ITILItemtype = "Ticket" | "Change" | "Problem";

const TASK_ITEMTYPE: Record<ITILItemtype, string> = {
  Ticket: "TicketTask",
  Change: "ChangeTask",
  Problem: "ProblemTask",
};

export interface TimelineEntry {
  type: "followup" | "task" | "solution" | "validation";
  date: string | null;
  users_id?: unknown;
  content?: unknown;
  [k: string]: unknown;
}

/** Rows fetched per timeline part: a busy ticket has dozens of entries, not thousands. */
const TIMELINE_PART_RANGE = "0-999";

/**
 * Followups, tasks, solutions and validations of an ITIL item merged into one
 * chronological list — the v2 server has this, v1 forced four separate calls
 * and manual interleaving.
 *
 * Each part is fetched whole and `range` applies to the MERGED list: paging
 * each part separately (before 3.4.0) mixed time windows, so page 2 could hold
 * entries older than page 1. `order` "desc" puts the latest entry first.
 *
 * A sub-resource that the instance does not expose (validations exist only on
 * Ticket) is skipped rather than failing the whole timeline.
 */
export async function listTimeline(
  config: GlpiConfig,
  itemtype: ITILItemtype,
  itemId: number | string,
  params?: { range?: string; order?: "asc" | "desc" },
): Promise<TimelineEntry[]> {
  async function fetchPart(sub: string): Promise<Record<string, unknown>[]> {
    try {
      const r = await glpiRequest<unknown>(
        config,
        "GET",
        withQs(`/${id(itemtype)}/${id(itemId)}/${sub}`, { range: TIMELINE_PART_RANGE }),
      );
      return Array.isArray(r) ? (r as Record<string, unknown>[]) : [];
    } catch {
      return [];
    }
  }

  const [followups, tasks, solutions, validations] = await Promise.all([
    fetchPart("ITILFollowup"),
    fetchPart(TASK_ITEMTYPE[itemtype]),
    fetchPart("ITILSolution"),
    itemtype === "Ticket" ? fetchPart("TicketValidation") : Promise.resolve([]),
  ]);

  const entries: TimelineEntry[] = [
    ...followups.map((e) => ({ ...e, type: "followup" as const, date: dateOf(e) })),
    ...tasks.map((e) => ({ ...e, type: "task" as const, date: dateOf(e) })),
    ...solutions.map((e) => ({ ...e, type: "solution" as const, date: dateOf(e) })),
    ...validations.map((e) => ({ ...e, type: "validation" as const, date: dateOf(e) })),
  ];

  // Chronological, undated entries last (in both orders).
  const desc = params?.order === "desc";
  entries.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return desc ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
  });

  const m = /^(\d+)\s*-\s*(\d+)$/.exec(params?.range ?? "");
  return m ? entries.slice(Number(m[1]), Number(m[2]) + 1) : entries;
}

function dateOf(entry: Record<string, unknown>): string | null {
  for (const k of ["date", "date_creation", "date_mod", "submission_date"]) {
    const v = entry[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ITILSolution
// ---------------------------------------------------------------------------

/** Add a solution to an ITIL item */
export async function addSolution(
  config: GlpiConfig,
  input: { itemtype: string; items_id: number | string; content: string },
) {
  return glpiRequest<unknown>(config, "POST", "/ITILSolution", { input });
}

// ---------------------------------------------------------------------------
// TicketValidation (approval)
// ---------------------------------------------------------------------------

/** List ticket validations */
export async function listTicketValidations(config: GlpiConfig, ticketId: number | string, params?: { range?: string }) {
  return glpiRequest<unknown>(config, "GET", withQs(`/Ticket/${id(ticketId)}/TicketValidation`, { range: params?.range }));
}

/** Create a validation request */
export async function createTicketValidation(
  config: GlpiConfig,
  input: { tickets_id: number | string; users_id_validate: number | string; comment_submission?: string },
) {
  return glpiRequest<unknown>(config, "POST", "/TicketValidation", { input });
}

/** Update a validation (approve/refuse or change approver) */
export async function updateTicketValidation(
  config: GlpiConfig,
  validationId: number | string,
  input: Record<string, unknown>,
) {
  return glpiRequest<unknown>(config, "PUT", `/TicketValidation/${id(validationId)}`, { input });
}

/** Delete a validation */
export async function deleteTicketValidation(config: GlpiConfig, validationId: number | string) {
  return glpiRequest<unknown>(config, "DELETE", `/TicketValidation/${id(validationId)}`);
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

/** Get a user by ID */
export async function getUser(config: GlpiConfig, userId: number | string) {
  return glpiRequest<Record<string, unknown>>(config, "GET", `/User/${id(userId)}`);
}

/**
 * Search users by email (User search option 5 = email, anchored). Returns full
 * User items (login, real name, first name...), not search columns.
 */
export async function searchUserByEmail(config: GlpiConfig, email: string, params?: { range?: string }) {
  const criteria = [{ field: 5, searchtype: "contains", value: `^${email}$` }];
  const { rows } = await searchItems(config, "User", { range: params?.range ?? "0-4", criteria });
  return rows;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/** List documents */
export async function listDocuments(config: GlpiConfig, params?: { range?: string }) {
  return glpiRequest<unknown>(config, "GET", withQs("/Document", { range: params?.range }));
}

/** Get a document by ID */
export async function getDocument(config: GlpiConfig, documentId: number | string) {
  return glpiRequest<Record<string, unknown>>(config, "GET", `/Document/${id(documentId)}`);
}

/** Create a document (metadata) */
export async function createDocument(config: GlpiConfig, input: Record<string, unknown>) {
  return glpiRequest<unknown>(config, "POST", "/Document", { input });
}

/** Delete a document */
export async function deleteDocument(config: GlpiConfig, documentId: number | string) {
  return glpiRequest<unknown>(config, "DELETE", `/Document/${id(documentId)}`);
}

// ---------------------------------------------------------------------------
// Document_Item
// ---------------------------------------------------------------------------

/** List document-item links */
export async function listDocumentItems(config: GlpiConfig, params?: { range?: string }) {
  return glpiRequest<unknown>(config, "GET", withQs("/Document_Item", { range: params?.range }));
}

/** Get a Document_Item by ID */
export async function getDocumentItem(config: GlpiConfig, documentItemId: number | string) {
  return glpiRequest<Record<string, unknown>>(config, "GET", `/Document_Item/${id(documentItemId)}`);
}

/** Link document to item */
export async function createDocumentItem(
  config: GlpiConfig,
  input: { documents_id: number | string; itemtype: string; items_id: number | string },
) {
  return glpiRequest<unknown>(config, "POST", "/Document_Item", { input });
}

/** Remove a Document_Item link */
export async function deleteDocumentItem(config: GlpiConfig, documentItemId: number | string) {
  return glpiRequest<unknown>(config, "DELETE", `/Document_Item/${id(documentItemId)}`);
}

// ---------------------------------------------------------------------------
// KnowbaseItem
// ---------------------------------------------------------------------------

/** List knowledge base items */
export async function listKnowbaseItems(config: GlpiConfig, params?: { range?: string }) {
  return glpiRequest<unknown>(config, "GET", withQs("/KnowbaseItem", { range: params?.range }));
}

/** Get a knowledge base item by ID */
export async function getKnowbaseItem(config: GlpiConfig, knowbaseId: number | string) {
  return glpiRequest<Record<string, unknown>>(config, "GET", `/KnowbaseItem/${id(knowbaseId)}`);
}

/** Create a knowledge base item */
export async function createKnowbaseItem(config: GlpiConfig, input: Record<string, unknown>) {
  return glpiRequest<unknown>(config, "POST", "/KnowbaseItem", { input });
}

/** Update a knowledge base item */
export async function updateKnowbaseItem(config: GlpiConfig, knowbaseId: number | string, input: Record<string, unknown>) {
  return glpiRequest<unknown>(config, "PUT", `/KnowbaseItem/${id(knowbaseId)}`, { input });
}

/** Delete a knowledge base item */
export async function deleteKnowbaseItem(config: GlpiConfig, knowbaseId: number | string) {
  return glpiRequest<unknown>(config, "DELETE", `/KnowbaseItem/${id(knowbaseId)}`);
}

// ---------------------------------------------------------------------------
// KnowbaseItemCategory
// ---------------------------------------------------------------------------

/** List knowledge base categories */
export async function listKnowbaseCategories(config: GlpiConfig, params?: { range?: string }) {
  return glpiRequest<unknown>(config, "GET", withQs("/KnowbaseItemCategory", { range: params?.range }));
}

/** Get a knowledge base category by ID */
export async function getKnowbaseCategory(config: GlpiConfig, categoryId: number | string) {
  return glpiRequest<Record<string, unknown>>(config, "GET", `/KnowbaseItemCategory/${id(categoryId)}`);
}

/** Create a knowledge base category */
export async function createKnowbaseCategory(config: GlpiConfig, input: Record<string, unknown>) {
  return glpiRequest<unknown>(config, "POST", "/KnowbaseItemCategory", { input });
}

/** Update a knowledge base category */
export async function updateKnowbaseCategory(
  config: GlpiConfig,
  categoryId: number | string,
  input: Record<string, unknown>,
) {
  return glpiRequest<unknown>(config, "PUT", `/KnowbaseItemCategory/${id(categoryId)}`, { input });
}

/** Delete a knowledge base category */
export async function deleteKnowbaseCategory(config: GlpiConfig, categoryId: number | string) {
  return glpiRequest<unknown>(config, "DELETE", `/KnowbaseItemCategory/${id(categoryId)}`);
}

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

/** List entities */
export async function listEntities(config: GlpiConfig, params?: { range?: string; expand_dropdowns?: boolean }) {
  return glpiRequest<unknown[]>(config, "GET", withQs("/Entity", { range: params?.range, expand_dropdowns: params?.expand_dropdowns }));
}

/** Get an entity by ID */
export async function getEntity(config: GlpiConfig, entityId: number | string) {
  return glpiRequest<Record<string, unknown>>(config, "GET", `/Entity/${id(entityId)}`);
}

/** Create an entity */
export async function createEntity(config: GlpiConfig, input: Record<string, unknown>) {
  return glpiRequest<{ id: number; message?: string }>(config, "POST", "/Entity", { input });
}

/** Update an entity */
export async function updateEntity(config: GlpiConfig, entityId: number | string, input: Record<string, unknown>) {
  return glpiRequest<unknown>(config, "PUT", `/Entity/${id(entityId)}`, { input });
}

/** Delete an entity */
export async function deleteEntity(config: GlpiConfig, entityId: number | string) {
  return glpiRequest<unknown>(config, "DELETE", `/Entity/${id(entityId)}`);
}

// ---------------------------------------------------------------------------
// RuleTicket (ticket business rules)
// ---------------------------------------------------------------------------

/** Get a ticket rule by ID */
export async function getRuleTicket(
  config: GlpiConfig,
  ruleId: number | string,
  params?: { expand_dropdowns?: boolean },
) {
  return glpiRequest<Record<string, unknown>>(
    config, "GET",
    withQs(`/RuleTicket/${id(ruleId)}`, { expand_dropdowns: params?.expand_dropdowns }),
  );
}

/**
 * List criteria of a ticket rule (sub-items). The sub-itemtype is RuleCriteria:
 * "RuleTicketCriteria" (used before 3.4.0) is not a GLPI class and every call
 * answered 400 ERROR_RESOURCE_NOT_FOUND_NOR_COMMONDBTM.
 */
export async function listRuleTicketCriteria(
  config: GlpiConfig,
  ruleId: number | string,
  params?: { range?: string; expand_dropdowns?: boolean },
) {
  return glpiRequest<unknown>(
    config, "GET",
    withQs(`/RuleTicket/${id(ruleId)}/RuleCriteria`, { range: params?.range, expand_dropdowns: params?.expand_dropdowns }),
  );
}

/** List actions of a ticket rule (sub-items: RuleAction, see listRuleTicketCriteria). */
export async function listRuleTicketAction(
  config: GlpiConfig,
  ruleId: number | string,
  params?: { range?: string; expand_dropdowns?: boolean },
) {
  return glpiRequest<unknown>(
    config, "GET",
    withQs(`/RuleTicket/${id(ruleId)}/RuleAction`, { range: params?.range, expand_dropdowns: params?.expand_dropdowns }),
  );
}

/** List rule criteria (global). Optionally filter by rules_id client-side. */
export async function listRuleCriteria(
  config: GlpiConfig,
  params?: { range?: string; expand_dropdowns?: boolean; rules_id?: number | string },
) {
  const raw = await glpiRequest<unknown[]>(
    config, "GET",
    withQs("/RuleCriteria", { range: params?.range ?? "0-999", expand_dropdowns: params?.expand_dropdowns }),
  );
  const list = Array.isArray(raw) ? raw : [];
  const ruleId = params?.rules_id;
  if (ruleId === undefined || ruleId === null) return list;
  const numId = Number(ruleId);
  return list.filter((item) => Number((item as Record<string, unknown>)?.rules_id) === numId);
}

/** List rule actions (global). Optionally filter by rules_id client-side. */
export async function listRuleAction(
  config: GlpiConfig,
  params?: { range?: string; expand_dropdowns?: boolean; rules_id?: number | string },
) {
  const raw = await glpiRequest<unknown[]>(
    config, "GET",
    withQs("/RuleAction", { range: params?.range ?? "0-999", expand_dropdowns: params?.expand_dropdowns }),
  );
  const list = Array.isArray(raw) ? raw : [];
  const ruleId = params?.rules_id;
  if (ruleId === undefined || ruleId === null) return list;
  const numId = Number(ruleId);
  return list.filter((item) => Number((item as Record<string, unknown>)?.rules_id) === numId);
}

/** Update a rule action */
export async function updateRuleAction(
  config: GlpiConfig,
  actionId: number | string,
  input: Record<string, unknown>,
) {
  return glpiRequest<unknown>(config, "PUT", `/RuleAction/${id(actionId)}`, { input });
}

// ---------------------------------------------------------------------------
// ITILFollowupTemplate
// ---------------------------------------------------------------------------

/** List followup templates */
export async function listITILFollowupTemplates(
  config: GlpiConfig,
  params?: { range?: string; expand_dropdowns?: boolean },
) {
  return glpiRequest<unknown[]>(
    config, "GET",
    withQs("/ITILFollowupTemplate", { range: params?.range, expand_dropdowns: params?.expand_dropdowns }),
  );
}

/** Get a followup template by ID */
export async function getITILFollowupTemplate(
  config: GlpiConfig,
  templateId: number | string,
  params?: { expand_dropdowns?: boolean },
) {
  return glpiRequest<Record<string, unknown>>(
    config, "GET",
    withQs(`/ITILFollowupTemplate/${id(templateId)}`, { expand_dropdowns: params?.expand_dropdowns }),
  );
}

/** Create a followup template */
export async function createITILFollowupTemplate(config: GlpiConfig, input: Record<string, unknown>) {
  return glpiRequest<{ id: number }>(config, "POST", "/ITILFollowupTemplate", { input });
}

/** Update a followup template */
export async function updateITILFollowupTemplate(
  config: GlpiConfig,
  templateId: number | string,
  input: Record<string, unknown>,
) {
  return glpiRequest<unknown>(config, "PUT", `/ITILFollowupTemplate/${id(templateId)}`, { input });
}

// ---------------------------------------------------------------------------
// Change (change management)
// ---------------------------------------------------------------------------

/** List changes */
export async function listChanges(config: GlpiConfig, params?: { range?: string; expand_dropdowns?: boolean } & SortParams) {
  return glpiRequest<unknown[]>(
    config,
    "GET",
    withQs("/Change/", { range: params?.range, expand_dropdowns: params?.expand_dropdowns, sort: params?.sort, order: params?.order }),
  );
}

/** Get a change by ID */
export async function getChange(config: GlpiConfig, changeId: number | string, params?: { expand_dropdowns?: boolean }) {
  return glpiRequest<Record<string, unknown>>(
    config, "GET",
    withQs(`/Change/${id(changeId)}`, { expand_dropdowns: params?.expand_dropdowns }),
  );
}

/** Create a change */
export async function createChange(config: GlpiConfig, input: Record<string, unknown>) {
  const payload = { ...input };
  if (payload.users_id_requester !== undefined && payload._users_id_requester === undefined) {
    payload._users_id_requester = payload.users_id_requester;
  }
  return glpiRequest<{ id: number }>(config, "POST", "/Change/", { input: payload });
}

/** Update a change */
export async function updateChange(config: GlpiConfig, changeId: number | string, input: Record<string, unknown>) {
  return glpiRequest<unknown>(config, "PUT", `/Change/${id(changeId)}`, { input });
}

/** List followups for a change */
export async function listChangeFollowups(
  config: GlpiConfig,
  changeId: number | string,
  params?: { range?: string; expand_dropdowns?: boolean },
) {
  return glpiRequest<unknown>(
    config, "GET",
    withQs(`/Change/${id(changeId)}/ITILFollowup`, { range: params?.range, expand_dropdowns: params?.expand_dropdowns }),
  );
}

// ---------------------------------------------------------------------------
// Problem (problem management)
// ---------------------------------------------------------------------------

/** List problems */
export async function listProblems(config: GlpiConfig, params?: { range?: string; expand_dropdowns?: boolean } & SortParams) {
  return glpiRequest<unknown[]>(
    config,
    "GET",
    withQs("/Problem/", { range: params?.range, expand_dropdowns: params?.expand_dropdowns, sort: params?.sort, order: params?.order }),
  );
}

/** Get a problem by ID */
export async function getProblem(config: GlpiConfig, problemId: number | string, params?: { expand_dropdowns?: boolean }) {
  return glpiRequest<Record<string, unknown>>(
    config, "GET",
    withQs(`/Problem/${id(problemId)}`, { expand_dropdowns: params?.expand_dropdowns }),
  );
}

/** Create a problem */
export async function createProblem(config: GlpiConfig, input: Record<string, unknown>) {
  const payload = { ...input };
  if (payload.users_id_requester !== undefined && payload._users_id_requester === undefined) {
    payload._users_id_requester = payload.users_id_requester;
  }
  return glpiRequest<{ id: number }>(config, "POST", "/Problem/", { input: payload });
}

/** Update a problem */
export async function updateProblem(config: GlpiConfig, problemId: number | string, input: Record<string, unknown>) {
  return glpiRequest<unknown>(config, "PUT", `/Problem/${id(problemId)}`, { input });
}

/** List followups for a problem */
export async function listProblemFollowups(
  config: GlpiConfig,
  problemId: number | string,
  params?: { range?: string; expand_dropdowns?: boolean },
) {
  return glpiRequest<unknown>(
    config, "GET",
    withQs(`/Problem/${id(problemId)}/ITILFollowup`, { range: params?.range, expand_dropdowns: params?.expand_dropdowns }),
  );
}

// ===========================================================================
// PHASE 2 — High-priority tools (+17)
// ===========================================================================

// ---------------------------------------------------------------------------
// Session & Context
// ---------------------------------------------------------------------------

/** List available search options for an itemtype */
export async function listSearchOptions(config: GlpiConfig, itemtype: string) {
  return glpiRequest<unknown>(config, "GET", `/listSearchOptions/${encodeURIComponent(itemtype)}`);
}

/** Change the active entity for the session */
export async function changeActiveEntities(config: GlpiConfig, entityId: number | string, isRecursive?: boolean) {
  const body: Record<string, unknown> = { entities_id: entityId };
  if (isRecursive !== undefined) body.is_recursive = isRecursive;
  return glpiRequest<unknown>(config, "POST", "/changeActiveEntities", body);
}

/** Get the full session info (active entity, profile, etc.) */
export async function getFullSession(config: GlpiConfig) {
  return glpiRequest<unknown>(config, "GET", "/getFullSession");
}

// ---------------------------------------------------------------------------
// Ticket_User (ticket actors — users)
// ---------------------------------------------------------------------------

/** List users linked to a ticket */
export async function listTicketUsers(config: GlpiConfig, ticketId: number | string) {
  return glpiRequest<unknown[]>(config, "GET", `/Ticket/${id(ticketId)}/Ticket_User`);
}

/** Add a user to a ticket (requester, observer, or assigned) */
export async function addTicketUser(config: GlpiConfig, input: { tickets_id: number | string; users_id: number | string; type: number }) {
  return glpiRequest<unknown>(config, "POST", "/Ticket_User", { input });
}

/** Remove a user-ticket link by Ticket_User ID */
export async function deleteTicketUser(config: GlpiConfig, ticketUserId: number | string) {
  return glpiRequest<unknown>(config, "DELETE", `/Ticket_User/${id(ticketUserId)}`);
}

// ---------------------------------------------------------------------------
// Group_Ticket (ticket actors — groups)
// ---------------------------------------------------------------------------

/** List groups linked to a ticket */
export async function listTicketGroups(config: GlpiConfig, ticketId: number | string) {
  return glpiRequest<unknown[]>(config, "GET", `/Ticket/${id(ticketId)}/Group_Ticket`);
}

/** Add a group to a ticket (requester, observer, or assigned) */
export async function addTicketGroup(config: GlpiConfig, input: { tickets_id: number | string; groups_id: number | string; type: number }) {
  return glpiRequest<unknown>(config, "POST", "/Group_Ticket", { input });
}

/** Remove a group-ticket link by Group_Ticket ID */
export async function deleteTicketGroup(config: GlpiConfig, groupTicketId: number | string) {
  return glpiRequest<unknown>(config, "DELETE", `/Group_Ticket/${id(groupTicketId)}`);
}

// ---------------------------------------------------------------------------
// ITIL Tasks
// ---------------------------------------------------------------------------

/** List tasks for a ticket */
export async function listTicketTasks(config: GlpiConfig, ticketId: number | string, params?: { range?: string }) {
  return glpiRequest<unknown[]>(config, "GET", withQs(`/Ticket/${id(ticketId)}/TicketTask`, { range: params?.range }));
}

/** Add a task to a ticket */
export async function addTicketTask(
  config: GlpiConfig,
  input: { tickets_id: number | string; content: string; is_private?: number; state?: number; actiontime?: number; users_id_tech?: number },
) {
  return glpiRequest<unknown>(config, "POST", "/TicketTask", { input });
}

/** List tasks for a change */
export async function listChangeTasks(config: GlpiConfig, changeId: number | string, params?: { range?: string }) {
  return glpiRequest<unknown[]>(config, "GET", withQs(`/Change/${id(changeId)}/ChangeTask`, { range: params?.range }));
}

/** List tasks for a problem */
export async function listProblemTasks(config: GlpiConfig, problemId: number | string, params?: { range?: string }) {
  return glpiRequest<unknown[]>(config, "GET", withQs(`/Problem/${id(problemId)}/ProblemTask`, { range: params?.range }));
}

// ---------------------------------------------------------------------------
// ITILCategory
// ---------------------------------------------------------------------------

/** List ITIL categories */
export async function listITILCategories(config: GlpiConfig, params?: { range?: string; expand_dropdowns?: boolean }) {
  return glpiRequest<unknown[]>(
    config, "GET",
    withQs("/ITILCategory", { range: params?.range, expand_dropdowns: params?.expand_dropdowns }),
  );
}

/** Get an ITIL category by ID */
export async function getITILCategory(config: GlpiConfig, categoryId: number | string) {
  return glpiRequest<Record<string, unknown>>(config, "GET", `/ITILCategory/${id(categoryId)}`);
}

// ---------------------------------------------------------------------------
// RequestType
// ---------------------------------------------------------------------------

/** List request sources (Helpdesk, Email, Phone…) */
export async function listRequestTypes(config: GlpiConfig, params?: { range?: string }) {
  return glpiRequest<unknown[]>(config, "GET", withQs("/RequestType", { range: params?.range }));
}

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

/** List groups */
export async function listGroups(config: GlpiConfig, params?: { range?: string; expand_dropdowns?: boolean }) {
  return glpiRequest<unknown[]>(
    config, "GET",
    withQs("/Group", { range: params?.range, expand_dropdowns: params?.expand_dropdowns }),
  );
}

/** Get a group by ID */
export async function getGroup(config: GlpiConfig, groupId: number | string) {
  return glpiRequest<Record<string, unknown>>(config, "GET", `/Group/${id(groupId)}`);
}

// ===========================================================================
// PHASE 3 — Medium-priority tools (+15)
// ===========================================================================

// ---------------------------------------------------------------------------
// User CRUD
// ---------------------------------------------------------------------------

/** List users */
export async function listUsers(config: GlpiConfig, params?: { range?: string; expand_dropdowns?: boolean }) {
  return glpiRequest<unknown[]>(
    config, "GET",
    withQs("/User", { range: params?.range, expand_dropdowns: params?.expand_dropdowns }),
  );
}

/** Create a user */
export async function createUser(config: GlpiConfig, input: Record<string, unknown>) {
  return glpiRequest<{ id: number }>(config, "POST", "/User", { input });
}

/** Update a user */
export async function updateUser(config: GlpiConfig, userId: number | string, input: Record<string, unknown>) {
  return glpiRequest<unknown>(config, "PUT", `/User/${id(userId)}`, { input });
}

// ---------------------------------------------------------------------------
// Rules CRUD
// ---------------------------------------------------------------------------

/**
 * List ticket rules. GET /RuleTicket returns rows of EVERY rule type (asset
 * import, dictionaries, mail collector...: 15 ticket rules out of 177 on the
 * test instance), so the listing is narrowed to sub_type RuleTicket.
 */
export async function listRules(config: GlpiConfig, params?: { range?: string; expand_dropdowns?: boolean }) {
  return glpiRequest<unknown[]>(
    config, "GET",
    withQs("/RuleTicket", {
      range: params?.range,
      expand_dropdowns: params?.expand_dropdowns,
      "searchText[sub_type]": "^RuleTicket$",
    }),
  );
}

/** Create a ticket rule */
export async function createRuleTicket(config: GlpiConfig, input: Record<string, unknown>) {
  return glpiRequest<{ id: number }>(config, "POST", "/RuleTicket", { input });
}

/** Create a rule criteria */
export async function createRuleCriteria(config: GlpiConfig, input: Record<string, unknown>) {
  return glpiRequest<{ id: number }>(config, "POST", "/RuleCriteria", { input });
}

/** Create a rule action */
export async function createRuleAction(config: GlpiConfig, input: Record<string, unknown>) {
  return glpiRequest<{ id: number }>(config, "POST", "/RuleAction", { input });
}

// ---------------------------------------------------------------------------
// Cross-ITIL Followups and Solutions
// ---------------------------------------------------------------------------

/** Add a followup to a Change */
export async function addChangeFollowup(
  config: GlpiConfig,
  input: { items_id: number | string; content: string; is_private?: number },
) {
  return glpiRequest<unknown>(config, "POST", "/ITILFollowup", {
    input: { ...input, itemtype: "Change" },
  });
}

/** Add a followup to a Problem */
export async function addProblemFollowup(
  config: GlpiConfig,
  input: { items_id: number | string; content: string; is_private?: number },
) {
  return glpiRequest<unknown>(config, "POST", "/ITILFollowup", {
    input: { ...input, itemtype: "Problem" },
  });
}

/** Add a solution to a Change */
export async function addChangeSolution(
  config: GlpiConfig,
  input: { items_id: number | string; content: string },
) {
  return glpiRequest<unknown>(config, "POST", "/ITILSolution", {
    input: { ...input, itemtype: "Change" },
  });
}

/** Add a solution to a Problem */
export async function addProblemSolution(
  config: GlpiConfig,
  input: { items_id: number | string; content: string },
) {
  return glpiRequest<unknown>(config, "POST", "/ITILSolution", {
    input: { ...input, itemtype: "Problem" },
  });
}

// ---------------------------------------------------------------------------
// Session info
// ---------------------------------------------------------------------------

/** Get entities available to the current user */
export async function getMyEntities(config: GlpiConfig) {
  return glpiRequest<unknown>(config, "GET", "/getMyEntities");
}

/** Get profiles available to the current user */
export async function getMyProfiles(config: GlpiConfig) {
  return glpiRequest<unknown>(config, "GET", "/getMyProfiles");
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/** List locations */
export async function listLocations(config: GlpiConfig, params?: { range?: string; expand_dropdowns?: boolean }) {
  return glpiRequest<unknown[]>(
    config, "GET",
    withQs("/Location", { range: params?.range, expand_dropdowns: params?.expand_dropdowns }),
  );
}

/** Get a location by ID */
export async function getLocation(config: GlpiConfig, locationId: number | string) {
  return glpiRequest<Record<string, unknown>>(config, "GET", `/Location/${id(locationId)}`);
}
