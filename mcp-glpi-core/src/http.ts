/**
 * Shared HTTP primitives for the GLPI MCP servers.
 *
 * Holds the transport (injectable fetch, Node polyfill, timeout, redirect
 * refusal), the retry helpers and the URL helpers used by both API clients.
 *
 * The retry *loop* itself stays in each client: v1 clears the session token and
 * throws on 401, while v2 clears the OAuth token and retries. Only the
 * primitives are shared here.
 *
 * Redirects: every request goes out with `redirect: "manual"` and a 3xx answer
 * becomes a GlpiRedirectError. A followed redirect would carry the session or
 * OAuth headers to whatever host the Location names, so it is never followed.
 *
 * Environment tunables:
 *   GLPI_MAX_RETRIES — max retry attempts (default 3)
 *   GLPI_TIMEOUT     — request timeout in ms (default 30000)
 */

import http from "node:http";
import https from "node:https";
import { GlpiRedirectError } from "./errors.js";

export const MAX_RETRIES = Math.max(0, parseInt(process.env.GLPI_MAX_RETRIES ?? "3", 10));
export const TIMEOUT_MS = Math.max(1000, parseInt(process.env.GLPI_TIMEOUT ?? "30000", 10));
export const BACKOFF_BASE = 1_000; // 1 s

/**
 * A `fetch` implementation the caller can inject (same call shape as the
 * global `fetch`). The hosted service uses it to validate the resolved IP of
 * every GLPI request; tests use it to stub GLPI. It always receives
 * `redirect: "manual"`.
 */
export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

/** Minimal Response-like interface covering both native fetch and the polyfill. */
export interface SimpleResponse {
  ok: boolean;
  status: number;
  statusText: string;
  /** Location header of a 3xx answer, when there is one. */
  location?: string | null;
  text(): Promise<string>;
}

export interface RequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Node 16 polyfill using the http/https modules (never follows redirects). */
export function nodeFetch(url: string, opts: RequestInitLike): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method ?? "GET",
        headers: opts.headers,
        timeout: TIMEOUT_MS,
      },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            location: typeof res.headers.location === "string" ? res.headers.location : null,
            text: () => Promise.resolve(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out after ${TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Host named by a redirect, resolved against the request URL; never the path. */
function redirectHost(location: string | null | undefined, requestUrl: string): string {
  if (!location) return "(no Location header)";
  try {
    return new URL(location, requestUrl).host || "(unknown host)";
  } catch {
    return "(invalid Location header)";
  }
}

/** Path of the request URL without query string, for error fields. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/**
 * Throws GlpiRedirectError on a 3xx (or an opaque redirect from a browser-like
 * fetch). Exported for clients and tests.
 */
export function assertNotRedirect(res: SimpleResponse & { type?: string }, method: string, url: string): void {
  const isRedirect = (res.status >= 300 && res.status < 400) || res.type === "opaqueredirect";
  if (isRedirect) {
    throw new GlpiRedirectError(res.status, method, pathOf(url), redirectHost(res.location, url));
  }
}

/**
 * One HTTP exchange with GLPI: the injected fetch, else the global fetch (Node
 * 18+), else the polyfill. Redirects are refused (see the module comment).
 */
export async function fetchFn(url: string, opts: RequestInitLike, fetchImpl?: FetchImpl): Promise<SimpleResponse> {
  const impl: FetchImpl | undefined =
    fetchImpl ?? (typeof globalThis.fetch === "function" ? (u, i) => globalThis.fetch(u, i) : undefined);
  const method = opts.method ?? "GET";
  if (!impl) {
    const res = await nodeFetch(url, opts);
    assertNotRedirect(res, method, url);
    return res;
  }
  const r = await impl(url, { ...opts, redirect: "manual" } as RequestInit);
  const res: SimpleResponse & { type?: string } = {
    ok: r.ok,
    status: r.status,
    statusText: r.statusText,
    location: r.headers?.get?.("location") ?? null,
    type: r.type,
    text: () => r.text(),
  };
  try {
    assertNotRedirect(res, method, url);
  } catch (err) {
    // Release the connection: the 3xx body is never read.
    await r.body?.cancel().catch(() => undefined);
    throw err;
  }
  return res;
}

/**
 * Runs `fetchFn` with an AbortController-based timeout when available.
 * Mutates nothing on the caller's init object beyond `signal`.
 */
export async function fetchWithTimeout(url: string, init: RequestInitLike, fetchImpl?: FetchImpl): Promise<SimpleResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (typeof AbortController !== "undefined") {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    init.signal = controller.signal;
  }
  try {
    return await fetchFn(url, init, fetchImpl);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function trimSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 429 and 5xx are worth retrying; 4xx are not. */
export function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Delay for a given attempt (0-based), exponential backoff. */
export function backoffDelay(attempt: number): number {
  return BACKOFF_BASE * 2 ** attempt;
}

/**
 * Sanitise an ID for use in URL paths (prevents path traversal). An empty ID
 * throws: `/ITILCategory/` + "" is the collection URL, and a get would return
 * the listing as if it were the item.
 */
export function sanitizeId(v: string | number): string {
  const s = String(v ?? "").trim();
  if (s === "" || s === "undefined" || s === "null") throw new Error("missing ID: refusing to build a collection URL");
  return encodeURIComponent(s);
}

export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

export function withQs(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const q = qs(params);
  return q ? `${path}?${q}` : path;
}
