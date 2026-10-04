/**
 * A GLPI instance as the server sees it: credentials for each API family,
 * write policy and tool selection.
 *
 * Over stdio there is one instance, read from the process environment. Over
 * HTTP each client is bound to one instance per session, read from the
 * instances file (see http.ts) — the same variable names, so an instance
 * entry is just the .env that used to sit next to a checkout.
 *
 * As a library, `instanceFromConfig` builds the same thing from a plain object,
 * without reading `process.env`.
 */

import { createHash } from "node:crypto";
import { loadWritePolicy, type FetchImpl, type WritePolicy } from "@nextoolsolutions/mcp-glpi-core";
import type { GlpiConfig } from "./glpi-client.js";
import type { GlpiV2Config } from "./glpi-v2-client.js";
import { parseToolsets } from "./toolsets.js";

export type InstanceEnv = Record<string, string | undefined>;

export interface InstanceConfig {
  /** Stable id: idempotency keys and logs use it, so two instances never share state. */
  id: string;
  v1: GlpiConfig;
  v2: GlpiV2Config;
  enableV1: boolean;
  enableV2: boolean;
  policy: WritePolicy;
  /** Named presets (see toolsets.ts); validated. Empty/absent = no preset. */
  toolsets?: string[];
  /** Comma-separated globs (GLPI_TOOLS_INCLUDE syntax). */
  toolsInclude?: string;
  /** Comma-separated globs (GLPI_TOOLS_EXCLUDE syntax); always wins. */
  toolsExclude?: string;
  /** fetch for every GLPI request of this instance (default: global fetch, redirects refused). */
  fetchImpl?: FetchImpl;
}

export function instanceFromEnv(id: string, env: InstanceEnv): InstanceConfig {
  const v1: GlpiConfig = {
    baseUrl: (env.GLPI_URL ?? "").replace(/\/$/, ""),
    userToken: env.GLPI_USER_TOKEN ?? "",
    appToken: env.GLPI_APP_TOKEN || undefined,
  };
  const v2: GlpiV2Config = {
    baseUrl: (env.GLPI_V2_URL ?? "").replace(/\/$/, ""),
    clientId: env.GLPI_V2_CLIENT_ID ?? "",
    clientSecret: env.GLPI_V2_CLIENT_SECRET ?? "",
    username: env.GLPI_V2_USERNAME ?? "",
    password: env.GLPI_V2_PASSWORD ?? "",
    scope: env.GLPI_V2_SCOPE || "api",
    apiVersion: env.GLPI_V2_API_VERSION || undefined,
  };
  // A family is on when its URL is set. With neither, the v1 family still
  // registers (as before the merge) and every call reports the missing variables.
  const enableV2 = Boolean(v2.baseUrl);
  const enableV1 = Boolean(v1.baseUrl) || !enableV2;
  return {
    id,
    v1,
    v2,
    enableV1,
    enableV2,
    policy: loadWritePolicy(env as NodeJS.ProcessEnv),
    toolsets: toolsetsOf(id, env.GLPI_TOOLSETS),
    toolsInclude: env.GLPI_TOOLS_INCLUDE,
    toolsExclude: env.GLPI_TOOLS_EXCLUDE,
  };
}

function toolsetsOf(id: string, value: string | readonly string[] | undefined): string[] | undefined {
  try {
    const names = parseToolsets(value);
    return names.length > 0 ? names : undefined;
  } catch (err) {
    throw new Error(`instance "${id}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Library entry: instance from a plain object
// ---------------------------------------------------------------------------

/** API v1 credentials (REST apirest.php or api.php/v1). */
export interface V1Credentials {
  /** GLPI URL, e.g. https://glpi.example.com or https://glpi.example.com/api.php/v1 */
  url: string;
  userToken: string;
  appToken?: string;
}

/** API v2 credentials (GLPI 11, OAuth2 password grant). */
export interface V2Credentials {
  /** GLPI URL, e.g. https://glpi.example.com (or …/api.php/v2.2) */
  url: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  /** OAuth2 scope (default "api"). */
  scope?: string;
  /** API version path, e.g. "v2.2" (default "v2"). */
  apiVersion?: string;
}

export interface InstanceOptions {
  /** Stable id: idempotency keys and logs use it. Lowercase letters, digits and "-". */
  id: string;
  /** Enables the glpi_* family. */
  v1?: V1Credentials;
  /** Enables the glpi_v2_* family. */
  v2?: V2Credentials;
  /** Write policy; defaults: readOnly false, allowDelete false, requireDeleteReason true. */
  policy?: Partial<WritePolicy>;
  /** Named presets, e.g. ["core"] or "tickets,kb". */
  toolsets?: string | readonly string[];
  /** Include globs, e.g. ["glpi_search"] or "glpi_*ticket*,glpi_search". */
  toolsInclude?: string | readonly string[];
  /** Exclude globs; always win. */
  toolsExclude?: string | readonly string[];
  /** fetch for every GLPI request (the hosted service injects an IP-validating one). */
  fetchImpl?: FetchImpl;
}

const INSTANCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function httpUrl(id: string, family: string, value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`instance "${id}": ${family}.url is not a valid URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`instance "${id}": ${family}.url must be http(s)`);
  }
  return value.replace(/\/$/, "");
}

function globList(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const joined = typeof value === "string" ? value : value.join(",");
  return joined.trim() ? joined : undefined;
}

/**
 * Builds an InstanceConfig from a plain object. Never reads process.env, so a
 * host process can serve many instances with credentials it holds itself.
 * Throws on an invalid id or URL, on unknown toolsets, and when neither API
 * family is configured.
 */
export function instanceFromConfig(opts: InstanceOptions): InstanceConfig {
  const { id } = opts;
  if (!INSTANCE_ID.test(id ?? "")) throw new Error(`instance id "${id}": use lowercase letters, digits and -`);
  if (!opts.v1 && !opts.v2) throw new Error(`instance "${id}": configure v1 and/or v2 credentials`);

  const v1: GlpiConfig = opts.v1
    ? {
        baseUrl: httpUrl(id, "v1", opts.v1.url),
        userToken: opts.v1.userToken,
        appToken: opts.v1.appToken || undefined,
        fetchImpl: opts.fetchImpl,
      }
    : { baseUrl: "", userToken: "", fetchImpl: opts.fetchImpl };
  const v2: GlpiV2Config = opts.v2
    ? {
        baseUrl: httpUrl(id, "v2", opts.v2.url),
        clientId: opts.v2.clientId,
        clientSecret: opts.v2.clientSecret,
        username: opts.v2.username,
        password: opts.v2.password,
        scope: opts.v2.scope || "api",
        apiVersion: opts.v2.apiVersion || undefined,
        fetchImpl: opts.fetchImpl,
      }
    : { baseUrl: "", clientId: "", clientSecret: "", username: "", password: "", fetchImpl: opts.fetchImpl };

  return {
    id,
    v1,
    v2,
    enableV1: Boolean(opts.v1),
    enableV2: Boolean(opts.v2),
    policy: {
      readOnly: opts.policy?.readOnly ?? false,
      allowDelete: opts.policy?.allowDelete ?? false,
      requireDeleteReason: opts.policy?.requireDeleteReason ?? true,
    },
    toolsets: toolsetsOf(id, opts.toolsets),
    toolsInclude: globList(opts.toolsInclude),
    toolsExclude: globList(opts.toolsExclude),
    fetchImpl: opts.fetchImpl,
  };
}

/**
 * Key for per-credential caches (GLPI session, OAuth token, catalogues).
 * Hashed, so a credential never lands in a map key or a heap dump as text, and
 * two users of the same GLPI with different tokens never share a cache entry.
 */
export function credentialKey(...parts: (string | undefined)[]): string {
  return createHash("sha256").update(parts.map((p) => p ?? "").join("\u0000")).digest("hex").slice(0, 32);
}
