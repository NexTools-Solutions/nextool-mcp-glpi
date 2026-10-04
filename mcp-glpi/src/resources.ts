/**
 * MCP resources for GLPI.
 *
 * Neither GLPI server used the protocol's `resources` primitive, so every
 * "which entity is that?" / "what does status 5 mean?" question cost a tool
 * round-trip before the real call. These expose the stable catalogues an agent
 * needs to compose a ticket: entities, categories, request types, plus the
 * status/priority/urgency code maps that are not queryable at all.
 *
 * Live catalogues are cached in-process; the code maps are constants.
 */

import type { GlpiConfig } from "./glpi-client.js";
import { credentialKey } from "./instance.js";
import { listEntities, listITILCategories, listRequestTypes } from "./glpi-client.js";

const CACHE_TTL_MS = Math.max(
  10_000,
  parseInt(process.env.GLPI_RESOURCE_CACHE_TTL ?? "300000", 10),
);

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await load();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Catalogues depend on what the credential can see: one cache entry per credential. */
function catalogueKey(config: GlpiConfig): string {
  return credentialKey("res", config.baseUrl, config.userToken, config.appToken);
}

/** Clears the resource cache (used by tests). */
export function clearResourceCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Static code maps
// ---------------------------------------------------------------------------

export const TICKET_STATUS_MAP = {
  1: "New",
  2: "Processing (assigned)",
  3: "Processing (planned)",
  4: "Pending",
  5: "Solved",
  6: "Closed",
} as const;

export const PRIORITY_MAP = {
  1: "Very low",
  2: "Low",
  3: "Medium",
  4: "High",
  5: "Very high",
  6: "Major",
} as const;

export const TICKET_TYPE_MAP = { 1: "Incident", 2: "Request" } as const;

export const ACTOR_TYPE_MAP = { 1: "Requester", 2: "Assigned", 3: "Observer" } as const;

/** CommonITILValidation: NONE=1, WAITING=2, ACCEPTED=3, REFUSED=4 (the map before 3.4.0 was shifted). */
export const VALIDATION_STATUS_MAP = {
  1: "None",
  2: "Waiting",
  3: "Accepted",
  4: "Refused",
} as const;

/** Keeps only the fields an agent needs to pick an option from a catalogue. */
function slim(rows: unknown, fields: string[]): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => {
    if (typeof r !== "object" || r === null) return r;
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = (r as Record<string, unknown>)[f];
      if (v !== undefined && v !== null && v !== "") out[f] = v;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export interface ResourceDefinition {
  name: string;
  uri: string;
  title: string;
  description: string;
  load(config: GlpiConfig): Promise<unknown>;
}

export const RESOURCES: ResourceDefinition[] = [
  {
    name: "glpi-entities",
    uri: "glpi://entities",
    title: "GLPI entities",
    description:
      "Entity tree of this instance (id, name, completename, level). Use to resolve entities_id " +
      "before creating or filtering items.",
    load: async (config) =>
      cached(`${catalogueKey(config)}:entities`, async () =>
        slim(await listEntities(config, { range: "0-499" }), [
          "id",
          "name",
          "completename",
          "level",
          "entities_id",
        ]),
      ),
  },
  {
    name: "glpi-itil-categories",
    uri: "glpi://itil-categories",
    title: "ITIL categories",
    description:
      "Ticket/change/problem categories (id, name, completename). Use to resolve " +
      "itilcategories_id without a search round-trip.",
    load: async (config) =>
      cached(`${catalogueKey(config)}:itil-categories`, async () =>
        slim(await listITILCategories(config, { range: "0-499" }), [
          "id",
          "name",
          "completename",
          "entities_id",
          "is_helpdeskvisible",
        ]),
      ),
  },
  {
    name: "glpi-request-types",
    uri: "glpi://request-types",
    title: "Request types",
    description: "Request sources (Helpdesk, Email, Phone…) for requesttypes_id.",
    load: async (config) =>
      cached(`${catalogueKey(config)}:request-types`, async () =>
        slim(await listRequestTypes(config, { range: "0-99" }), ["id", "name"]),
      ),
  },
  {
    name: "glpi-code-maps",
    uri: "glpi://code-maps",
    title: "GLPI code maps",
    description:
      "Numeric codes GLPI returns and expects: ticket status, priority/urgency/impact, " +
      "ticket type, actor type and validation status. Not queryable through the API.",
    load: async () => ({
      ticket_status: TICKET_STATUS_MAP,
      priority: PRIORITY_MAP,
      urgency: PRIORITY_MAP,
      impact: PRIORITY_MAP,
      ticket_type: TICKET_TYPE_MAP,
      actor_type: ACTOR_TYPE_MAP,
      validation_status: VALIDATION_STATUS_MAP,
    }),
  },
];

/** Structural type of the registerResource bits used here. */
interface ResourceCapableServer {
  registerResource(
    name: string,
    uri: string,
    metadata: Record<string, unknown>,
    read: (uri: URL) => Promise<{ contents: { uri: string; mimeType: string; text: string }[] }>,
  ): unknown;
}

/** Registers every resource on the server. */
export function registerResources(server: object, config: GlpiConfig): void {
  const target = server as ResourceCapableServer;

  for (const def of RESOURCES) {
    target.registerResource(
      def.name,
      def.uri,
      { title: def.title, description: def.description, mimeType: "application/json" },
      async (uri: URL) => {
        let text: string;
        try {
          text = JSON.stringify(await def.load(config), null, 2);
        } catch (e) {
          text = JSON.stringify({ error: e instanceof Error ? e.message : String(e) }, null, 2);
        }
        return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
      },
    );
  }
}

/** Exposed for the smoke tests: reads a resource the same way the server does. */
export async function readResource(config: GlpiConfig, uri: string): Promise<unknown> {
  const def = RESOURCES.find((r) => r.uri === uri);
  if (!def) throw new Error(`Unknown resource: ${uri}`);
  return def.load(config);
}
