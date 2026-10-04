/**
 * HTTP client for the GLPI 11 REST API v2 (High-level API).
 *
 * Features:
 *   - OAuth2 Password grant with token TTL cache
 *   - Automatic retry with exponential backoff (401/429/5xx)
 *   - Configurable timeout (default 30 s)
 *   - Typed error class (GlpiV2ApiError)
 *   - ID sanitisation via encodeURIComponent
 *   - Support for all v2 controllers (/Assistance, /Administration, etc.)
 *   - Injectable fetch (`config.fetchImpl`); redirects are never followed
 *   - Requests only reach the host of GLPI_V2_URL (no absolute URLs elsewhere)
 *
 * Environment tunables:
 *   GLPI_MAX_RETRIES — max retry attempts (default 3)
 *   GLPI_TIMEOUT     — request timeout in ms  (default 30000)
 */

import {
  BACKOFF_BASE,
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

export type GlpiV2Config = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  scope?: string;
  /** API version in path (e.g. "v2" or "v2.2"). Default "v2" uses latest minor. */
  apiVersion?: string;
  /**
   * fetch used for the token and every request (default: global fetch).
   * Always called with `redirect: "manual"`; a 3xx becomes GlpiRedirectError.
   */
  fetchImpl?: FetchImpl;
};

export class GlpiV2ApiError extends GlpiHttpError {
  constructor(message: string, status: number, method: string, path: string) {
    super(message, status, method, path, "GlpiV2ApiError");
  }
}

/** ITIL item types supported by the v2 API. */
export type ITILItemtype = "Ticket" | "Change" | "Problem";

// ---------------------------------------------------------------------------
// Token cache with TTL
// ---------------------------------------------------------------------------

// One OAuth token per credential (URL + client + user): the HTTP entry serves
// many instances from one process.
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

function tokenKey(config: GlpiV2Config): string {
  return credentialKey("v2", trimSlash(config.baseUrl), config.clientId, config.clientSecret, config.username, config.password, config.scope);
}

/** Cache key of a v2 credential (URL + client + user): per-credential caches outside this module use it. */
export function v2CredentialKey(config: GlpiV2Config): string {
  return tokenKey(config);
}

function validToken(config: GlpiV2Config): string | null {
  const entry = accessTokens.get(tokenKey(config));
  return entry && Date.now() < entry.expiresAt ? entry.token : null;
}

function clearToken(config: GlpiV2Config): void {
  accessTokens.delete(tokenKey(config));
}

// ---------------------------------------------------------------------------
// API base resolution
// ---------------------------------------------------------------------------

function getApiVersion(config: GlpiV2Config): string {
  return config.apiVersion?.replace(/^\/?|\/?$/g, "") || "v2";
}

function getApiBase(config: GlpiV2Config): { base: string; prefix: string } {
  const base = trimSlash(config.baseUrl);
  const match = base.match(/^(.*?)(\/api\.php\/v[\d.]+)\/?$/);
  if (match) {
    return { base: match[1], prefix: match[2].replace(/\/$/, "") };
  }
  const version = getApiVersion(config);
  return { base, prefix: `/api.php/${version}` };
}

// ---------------------------------------------------------------------------
// OAuth2 token
// ---------------------------------------------------------------------------

export async function getAccessToken(config: GlpiV2Config): Promise<string> {
  const valid = validToken(config);
  if (valid) return valid;

  const { base } = getApiBase(config);
  const url = `${base}/api.php/token`;
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    username: config.username,
    password: config.password,
    scope: config.scope ?? "api",
  }).toString();

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "GLPI-MCP-V2/2.0 (mcp-server)",
    Accept: "application/json",
  };

  const res = await fetchFn(url, { method: "POST", headers, body }, config.fetchImpl);
  const text = await res.text();
  if (!res.ok) {
    throw new GlpiV2ApiError(
      `OAuth2 token: ${res.status} ${res.statusText} – ${text}`,
      res.status, "POST", "/api.php/token",
    );
  }

  const data = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new GlpiV2ApiError("OAuth2 token: access_token not returned", 0, "POST", "/api.php/token");
  }

  // Use expires_in (seconds) with a 60 s safety margin
  const ttlMs = data.expires_in ? (data.expires_in - 60) * 1000 : 3600 * 1000;
  accessTokens.set(tokenKey(config), { token: data.access_token, expiresAt: Date.now() + Math.max(ttlMs, 10_000) });
  return data.access_token;
}

// ---------------------------------------------------------------------------
// URL resolution — only the configured GLPI host
// ---------------------------------------------------------------------------

/** "https:", "mailto:", "//host": anything that is not a path on the GLPI host. */
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i;

/**
 * Builds the request URL from a path relative to the API (or to the GLPI root
 * when `raw`). An absolute URL is accepted only when it points at the same
 * origin as GLPI_V2_URL; anything else would let a caller send the OAuth
 * bearer token to another host (SSRF), so it is refused before any request.
 */
export function resolveV2Url(config: GlpiV2Config, method: string, path: string, raw = false): string {
  const { base, prefix } = getApiBase(config);
  let allowed: URL;
  try {
    allowed = new URL(base);
  } catch {
    throw new GlpiV2ApiError("GLPI v2: GLPI_V2_URL is missing or not a valid URL", 0, method, "");
  }

  if (ABSOLUTE_URL.test(path)) {
    let target: URL;
    try {
      target = new URL(path, allowed);
    } catch {
      throw new GlpiV2ApiError("GLPI v2: invalid absolute URL refused", 0, method, "(absolute URL)");
    }
    if (target.origin !== allowed.origin) {
      throw new GlpiV2ApiError(
        `GLPI v2: absolute URL refused, host ${target.host || "(none)"} is not the GLPI_V2_URL host ${allowed.host}`,
        0, method, "(absolute URL)",
      );
    }
    return target.toString();
  }

  const relative = path.startsWith("/") ? path : `/${path}`;
  const url = `${base}${raw ? "" : prefix}${relative}`;
  // Defence in depth: whatever the path holds, the result must stay on the GLPI host.
  if (new URL(url).origin !== allowed.origin) {
    throw new GlpiV2ApiError("GLPI v2: path resolves outside the GLPI_V2_URL host, refused", 0, method, "(invalid path)");
  }
  return url;
}

// ---------------------------------------------------------------------------
// Core request with retry + timeout
// ---------------------------------------------------------------------------

export async function glpiV2Request<T = unknown>(
  config: GlpiV2Config,
  method: string,
  path: string,
  body?: unknown,
  opts?: { raw?: boolean },
): Promise<T> {
  const url = resolveV2Url(config, method, path, opts?.raw === true);

  const hasBody = body !== undefined && body !== null;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "GLPI-MCP-V2/2.0 (mcp-server)",
  };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // (Re)acquire token — handles expiry / 401 retry
    const token = await getAccessToken(config);
    headers["Authorization"] = `Bearer ${token}`;

    const bodyStr =
      method === "GET" || method === "HEAD"
        ? undefined
        : hasBody ? JSON.stringify(body) : undefined;
    if (bodyStr !== undefined) headers["Content-Type"] = "application/json";

    const init: RequestInitLike = { method, headers, body: bodyStr };

    try {
      const res = await fetchWithTimeout(url, init, config.fetchImpl);

      const text = await res.text();

      // 401 → clear token and retry once
      if (res.status === 401) {
        clearToken(config);
        if (attempt < MAX_RETRIES) {
          lastError = new GlpiV2ApiError(
            `GLPI v2 ${method} ${path}: 401 Unauthorized – ${text}`,
            401, method, path,
          );
          await sleep(BACKOFF_BASE);
          continue;
        }
      }

      if (!res.ok) {
        const err = new GlpiV2ApiError(
          `GLPI v2 ${method} ${path}: ${res.status} ${res.statusText}${text ? ` – ${text}` : ""}`,
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

  throw lastError ?? new Error("GLPI v2 request failed");
}

// ===========================================================================
// Entity — /Administration/Entity
// ===========================================================================

export function listEntities(
  cfg: GlpiV2Config,
  p?: { filter?: string; start?: number; limit?: number; sort?: string },
) {
  return glpiV2Request<unknown>(
    cfg, "GET",
    withQs("/Administration/Entity", {
      filter: p?.filter, start: p?.start, limit: p?.limit, sort: p?.sort,
    }),
  );
}

export function getEntity(cfg: GlpiV2Config, entityId: number | string) {
  return glpiV2Request<Record<string, unknown>>(cfg, "GET", `/Administration/Entity/${id(entityId)}`);
}

export function createEntity(cfg: GlpiV2Config, data: Record<string, unknown>) {
  const body: Record<string, unknown> = { name: data.name, comment: data.comment ?? "" };
  const parentId = data.entities_id ?? (data.parent as { id?: number } | undefined)?.id;
  if (parentId !== undefined && parentId !== null) body.parent = { id: Number(parentId) };
  return glpiV2Request<unknown>(cfg, "POST", "/Administration/Entity", body);
}

export function updateEntity(cfg: GlpiV2Config, entityId: number | string, data: Record<string, unknown>) {
  const body: Record<string, unknown> = {};
  if (data.name !== undefined) body.name = data.name;
  if (data.comment !== undefined) body.comment = data.comment;
  const parentId = data.entities_id ?? (data.parent as { id?: number } | undefined)?.id;
  if (parentId !== undefined && parentId !== null) body.parent = { id: Number(parentId) };
  return glpiV2Request<unknown>(cfg, "PATCH", `/Administration/Entity/${id(entityId)}`, body);
}

export function deleteEntity(cfg: GlpiV2Config, entityId: number | string, force?: boolean) {
  const q = force ? "?force=true" : "";
  return glpiV2Request<unknown>(cfg, "DELETE", `/Administration/Entity/${id(entityId)}${q}`);
}

// ===========================================================================
// Ticket — /Assistance/Ticket
// ===========================================================================

export function listTickets(
  cfg: GlpiV2Config,
  p?: { filter?: string; start?: number; limit?: number; sort?: string },
) {
  return glpiV2Request<unknown>(
    cfg, "GET",
    withQs("/Assistance/Ticket", {
      filter: p?.filter, start: p?.start, limit: p?.limit, sort: p?.sort,
    }),
  );
}

export function getTicket(cfg: GlpiV2Config, ticketId: number | string) {
  return glpiV2Request<Record<string, unknown>>(cfg, "GET", `/Assistance/Ticket/${id(ticketId)}`);
}

export function createTicket(cfg: GlpiV2Config, data: Record<string, unknown>) {
  return glpiV2Request<unknown>(cfg, "POST", "/Assistance/Ticket", data);
}

export function updateTicket(cfg: GlpiV2Config, ticketId: number | string, data: Record<string, unknown>) {
  return glpiV2Request<unknown>(cfg, "PATCH", `/Assistance/Ticket/${id(ticketId)}`, data);
}

export function deleteTicket(cfg: GlpiV2Config, ticketId: number | string, force?: boolean) {
  const q = force ? "?force=true" : "";
  return glpiV2Request<unknown>(cfg, "DELETE", `/Assistance/Ticket/${id(ticketId)}${q}`);
}

// ===========================================================================
// Change — /Assistance/Change
// ===========================================================================

export function listChanges(
  cfg: GlpiV2Config,
  p?: { filter?: string; start?: number; limit?: number; sort?: string },
) {
  return glpiV2Request<unknown>(
    cfg, "GET",
    withQs("/Assistance/Change", {
      filter: p?.filter, start: p?.start, limit: p?.limit, sort: p?.sort,
    }),
  );
}

export function getChange(cfg: GlpiV2Config, changeId: number | string) {
  return glpiV2Request<Record<string, unknown>>(cfg, "GET", `/Assistance/Change/${id(changeId)}`);
}

export function createChange(cfg: GlpiV2Config, data: Record<string, unknown>) {
  return glpiV2Request<unknown>(cfg, "POST", "/Assistance/Change", data);
}

export function updateChange(cfg: GlpiV2Config, changeId: number | string, data: Record<string, unknown>) {
  return glpiV2Request<unknown>(cfg, "PATCH", `/Assistance/Change/${id(changeId)}`, data);
}

// ===========================================================================
// Problem — /Assistance/Problem
// ===========================================================================

export function listProblems(
  cfg: GlpiV2Config,
  p?: { filter?: string; start?: number; limit?: number; sort?: string },
) {
  return glpiV2Request<unknown>(
    cfg, "GET",
    withQs("/Assistance/Problem", {
      filter: p?.filter, start: p?.start, limit: p?.limit, sort: p?.sort,
    }),
  );
}

export function getProblem(cfg: GlpiV2Config, problemId: number | string) {
  return glpiV2Request<Record<string, unknown>>(cfg, "GET", `/Assistance/Problem/${id(problemId)}`);
}

export function createProblem(cfg: GlpiV2Config, data: Record<string, unknown>) {
  return glpiV2Request<unknown>(cfg, "POST", "/Assistance/Problem", data);
}

export function updateProblem(cfg: GlpiV2Config, problemId: number | string, data: Record<string, unknown>) {
  return glpiV2Request<unknown>(cfg, "PATCH", `/Assistance/Problem/${id(problemId)}`, data);
}

// ===========================================================================
// Timeline — /Assistance/{itemtype}/{id}/Timeline
// ===========================================================================

export function listTimeline(cfg: GlpiV2Config, itemtype: ITILItemtype, itemId: number | string) {
  return glpiV2Request<unknown>(cfg, "GET", `/Assistance/${itemtype}/${id(itemId)}/Timeline`);
}

export function addFollowup(
  cfg: GlpiV2Config, itemtype: ITILItemtype, itemId: number | string,
  data: Record<string, unknown>,
) {
  return glpiV2Request<unknown>(
    cfg, "POST", `/Assistance/${itemtype}/${id(itemId)}/Timeline`,
    { ...data, type: "ITILFollowup" },
  );
}

export function addSolution(
  cfg: GlpiV2Config, itemtype: ITILItemtype, itemId: number | string,
  data: Record<string, unknown>,
) {
  return glpiV2Request<unknown>(
    cfg, "POST", `/Assistance/${itemtype}/${id(itemId)}/Timeline`,
    { ...data, type: "ITILSolution" },
  );
}

export function addTask(
  cfg: GlpiV2Config, itemtype: ITILItemtype, itemId: number | string,
  data: Record<string, unknown>,
) {
  return glpiV2Request<unknown>(
    cfg, "POST", `/Assistance/${itemtype}/${id(itemId)}/Timeline/Task`, data,
  );
}

export function addValidation(
  cfg: GlpiV2Config, itemtype: ITILItemtype, itemId: number | string,
  data: Record<string, unknown>,
) {
  return glpiV2Request<unknown>(
    cfg, "POST", `/Assistance/${itemtype}/${id(itemId)}/Timeline/Validation`, data,
  );
}

export function updateValidation(
  cfg: GlpiV2Config, itemtype: ITILItemtype, itemId: number | string,
  validationId: number | string, data: Record<string, unknown>,
) {
  return glpiV2Request<unknown>(
    cfg, "PATCH",
    `/Assistance/${itemtype}/${id(itemId)}/Timeline/Validation/${id(validationId)}`,
    data,
  );
}

// ===========================================================================
// Team Members — /Assistance/{itemtype}/{id}/TeamMember
// ===========================================================================

export function listTeamMembers(cfg: GlpiV2Config, itemtype: ITILItemtype, itemId: number | string) {
  return glpiV2Request<unknown>(cfg, "GET", `/Assistance/${itemtype}/${id(itemId)}/TeamMember`);
}

export function addTeamMember(
  cfg: GlpiV2Config, itemtype: ITILItemtype, itemId: number | string,
  data: Record<string, unknown>,
) {
  return glpiV2Request<unknown>(
    cfg, "POST", `/Assistance/${itemtype}/${id(itemId)}/TeamMember`, data,
  );
}

export function removeTeamMember(
  cfg: GlpiV2Config, itemtype: ITILItemtype, itemId: number | string,
  memberId: number | string,
) {
  return glpiV2Request<unknown>(
    cfg, "DELETE", `/Assistance/${itemtype}/${id(itemId)}/TeamMember/${id(memberId)}`,
  );
}

// ===========================================================================
// Users — /Administration/User
// ===========================================================================

export function listUsers(
  cfg: GlpiV2Config,
  p?: { filter?: string; start?: number; limit?: number; sort?: string },
) {
  return glpiV2Request<unknown>(
    cfg, "GET",
    withQs("/Administration/User", {
      filter: p?.filter, start: p?.start, limit: p?.limit, sort: p?.sort,
    }),
  );
}

export function getUser(cfg: GlpiV2Config, userId: number | string) {
  return glpiV2Request<Record<string, unknown>>(cfg, "GET", `/Administration/User/${id(userId)}`);
}

/**
 * The connected user. GET /Administration/User/Me needs the OAuth "user" scope;
 * with the default "api" scope GLPI 11.0.7 answers 403 ERROR_RIGHT_MISSING, so
 * the user is then read through the session (user_id) instead.
 */
export async function getMe(cfg: GlpiV2Config): Promise<Record<string, unknown>> {
  try {
    return await glpiV2Request<Record<string, unknown>>(cfg, "GET", "/Administration/User/Me");
  } catch (e) {
    if (!(e instanceof GlpiV2ApiError) || e.status !== 403) throw e;
    const session = await getSession(cfg);
    const userId = Number(session?.user_id);
    if (!Number.isInteger(userId) || userId <= 0) throw e;
    const user = await glpiV2Request<unknown>(cfg, "GET", `/Administration/User/${userId}`);
    const item = Array.isArray(user) ? user[0] : user;
    return { ...(typeof item === "object" && item !== null ? (item as Record<string, unknown>) : { id: userId }), source: "session" };
  }
}

export function createUser(cfg: GlpiV2Config, data: Record<string, unknown>) {
  return glpiV2Request<unknown>(cfg, "POST", "/Administration/User", data);
}

export function updateUser(cfg: GlpiV2Config, userId: number | string, data: Record<string, unknown>) {
  return glpiV2Request<unknown>(cfg, "PATCH", `/Administration/User/${id(userId)}`, data);
}

// ===========================================================================
// Groups — /Administration/Group
// ===========================================================================

export function listGroups(
  cfg: GlpiV2Config,
  p?: { filter?: string; start?: number; limit?: number; sort?: string },
) {
  return glpiV2Request<unknown>(
    cfg, "GET",
    withQs("/Administration/Group", {
      filter: p?.filter, start: p?.start, limit: p?.limit, sort: p?.sort,
    }),
  );
}

export function getGroup(cfg: GlpiV2Config, groupId: number | string) {
  return glpiV2Request<Record<string, unknown>>(cfg, "GET", `/Administration/Group/${id(groupId)}`);
}

export function createGroup(cfg: GlpiV2Config, data: Record<string, unknown>) {
  return glpiV2Request<unknown>(cfg, "POST", "/Administration/Group", data);
}

// ===========================================================================
// Knowledgebase — /Knowledgebase/Article & /Knowledgebase/Category
// ===========================================================================

export function listKBArticles(
  cfg: GlpiV2Config,
  p?: { filter?: string; start?: number; limit?: number; sort?: string },
) {
  return glpiV2Request<unknown>(
    cfg, "GET",
    withQs("/Knowledgebase/Article", {
      filter: p?.filter, start: p?.start, limit: p?.limit, sort: p?.sort,
    }),
  );
}

export function getKBArticle(cfg: GlpiV2Config, articleId: number | string) {
  return glpiV2Request<Record<string, unknown>>(cfg, "GET", `/Knowledgebase/Article/${id(articleId)}`);
}

export function createKBArticle(cfg: GlpiV2Config, data: Record<string, unknown>) {
  return glpiV2Request<unknown>(cfg, "POST", "/Knowledgebase/Article", data);
}

export function updateKBArticle(cfg: GlpiV2Config, articleId: number | string, data: Record<string, unknown>) {
  return glpiV2Request<unknown>(cfg, "PATCH", `/Knowledgebase/Article/${id(articleId)}`, data);
}

export function listKBCategories(
  cfg: GlpiV2Config,
  p?: { filter?: string; start?: number; limit?: number; sort?: string },
) {
  return glpiV2Request<unknown>(
    cfg, "GET",
    withQs("/Knowledgebase/Category", {
      filter: p?.filter, start: p?.start, limit: p?.limit, sort: p?.sort,
    }),
  );
}

export function getKBCategory(cfg: GlpiV2Config, categoryId: number | string) {
  return glpiV2Request<Record<string, unknown>>(cfg, "GET", `/Knowledgebase/Category/${id(categoryId)}`);
}

// ===========================================================================
// Dropdowns — /Dropdowns/*
// ===========================================================================

export function listITILCategories(
  cfg: GlpiV2Config,
  p?: { filter?: string; start?: number; limit?: number; sort?: string },
) {
  return glpiV2Request<unknown>(
    cfg, "GET",
    withQs("/Dropdowns/ITILCategory", {
      filter: p?.filter, start: p?.start, limit: p?.limit, sort: p?.sort,
    }),
  );
}

export function getITILCategory(cfg: GlpiV2Config, categoryId: number | string) {
  return glpiV2Request<Record<string, unknown>>(cfg, "GET", `/Dropdowns/ITILCategory/${id(categoryId)}`);
}

export function listLocations(
  cfg: GlpiV2Config,
  p?: { filter?: string; start?: number; limit?: number; sort?: string },
) {
  return glpiV2Request<unknown>(
    cfg, "GET",
    withQs("/Dropdowns/Location", {
      filter: p?.filter, start: p?.start, limit: p?.limit, sort: p?.sort,
    }),
  );
}

export function listRequestTypes(
  cfg: GlpiV2Config,
  p?: { filter?: string; start?: number; limit?: number; sort?: string },
) {
  return glpiV2Request<unknown>(
    cfg, "GET",
    withQs("/Dropdowns/RequestType", {
      filter: p?.filter, start: p?.start, limit: p?.limit, sort: p?.sort,
    }),
  );
}

// ===========================================================================
// Documents — /Management/Document
// ===========================================================================

export function listDocuments(
  cfg: GlpiV2Config,
  p?: { filter?: string; start?: number; limit?: number; sort?: string },
) {
  return glpiV2Request<unknown>(
    cfg, "GET",
    withQs("/Management/Document", {
      filter: p?.filter, start: p?.start, limit: p?.limit, sort: p?.sort,
    }),
  );
}

export function getDocument(cfg: GlpiV2Config, docId: number | string) {
  return glpiV2Request<Record<string, unknown>>(cfg, "GET", `/Management/Document/${id(docId)}`);
}

export function createDocument(cfg: GlpiV2Config, data: Record<string, unknown>) {
  return glpiV2Request<unknown>(cfg, "POST", "/Management/Document", data);
}

export function downloadDocument(cfg: GlpiV2Config, docId: number | string) {
  return glpiV2Request<unknown>(cfg, "GET", `/Management/Document/${id(docId)}/Download`);
}

// ===========================================================================
// Rules — /Rule/Collection
// ===========================================================================

export function listRuleCollections(cfg: GlpiV2Config) {
  return glpiV2Request<unknown>(cfg, "GET", "/Rule/Collection");
}

export function listRules(
  cfg: GlpiV2Config,
  collection: string,
  p?: { filter?: string; start?: number; limit?: number; sort?: string },
) {
  return glpiV2Request<unknown>(
    cfg, "GET",
    withQs(`/Rule/Collection/${id(collection)}/Rule`, {
      filter: p?.filter, start: p?.start, limit: p?.limit, sort: p?.sort,
    }),
  );
}

export function getRule(cfg: GlpiV2Config, collection: string, ruleId: number | string) {
  return glpiV2Request<Record<string, unknown>>(
    cfg, "GET", `/Rule/Collection/${id(collection)}/Rule/${id(ruleId)}`,
  );
}

export function createRule(cfg: GlpiV2Config, collection: string, data: Record<string, unknown>) {
  return glpiV2Request<unknown>(
    cfg, "POST", `/Rule/Collection/${id(collection)}/Rule`, data,
  );
}

// ===========================================================================
// Session & Status
// ===========================================================================

/**
 * Session of the OAuth user. It lives under the API prefix (/api.php/v2.x/session);
 * before 3.4.0 it was requested at the GLPI root and always answered 404.
 */
export function getSession(cfg: GlpiV2Config) {
  return glpiV2Request<Record<string, unknown>>(cfg, "GET", "/session");
}

/**
 * GET /api.php/v2.x/status (was requested at the GLPI root: 404). That endpoint
 * needs the OAuth "status" scope; with the usual "api" scope GLPI answers 403,
 * and the check falls back to the session endpoint, which proves the API is up
 * and the credentials work.
 */
export async function healthCheck(cfg: GlpiV2Config): Promise<Record<string, unknown>> {
  try {
    const status = await glpiV2Request<unknown>(cfg, "GET", "/status");
    return typeof status === "object" && status !== null && !Array.isArray(status)
      ? (status as Record<string, unknown>)
      : { services: status };
  } catch (e) {
    if (!(e instanceof GlpiV2ApiError) || e.status !== 403) throw e;
    const session = await getSession(cfg);
    return {
      checked: "session",
      current_time: session?.current_time,
      note: "GET /status needs the OAuth 'status' scope; the API answered on /session instead.",
    };
  }
}
