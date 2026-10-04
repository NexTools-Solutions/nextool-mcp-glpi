/**
 * Human-readable names next to GLPI IDs (API v1).
 *
 * GLPI's sub-items (Ticket_User, Group_Ticket, followups, tasks, solutions,
 * validations) carry bare foreign keys: `users_id: 7` tells an agent nothing,
 * and the GLPI 11 solution columns `user_name` / `solutiontype_name` arrive
 * empty. `expand_dropdowns=true` is no answer either: it REPLACES the ID with
 * the login ("admin.jdoe"), losing the ID the next call needs.
 *
 * So the IDs stay and a `<x>_name` key is added beside each one, resolved with
 * GET /<itemtype>/<id> through a short per-credential cache (two users of the
 * same GLPI may see different things, so nothing is shared between them).
 * A lookup the user has no right to (403) or that fails leaves the name null.
 */

import { glpiRequest, v1CredentialKey, type GlpiConfig } from "./glpi-client.js";

/** How long a resolved name is reused. Short: a renamed user shows up within minutes. */
export const NAME_CACHE_TTL_MS = 5 * 60_000;
/** Distinct lookups per call; beyond this the remaining names are left null. */
export const MAX_NAME_LOOKUPS = 60;
const CONCURRENCY = 8;
const MAX_CACHE_ENTRIES = 5000;

const cache = new Map<string, { value: string | null; expires: number }>();

/** "John Doe" for a user (first + real name), else the login; completename/name for the rest. */
export function displayName(itemtype: string, item: Record<string, unknown> | undefined | null): string | null {
  if (!item || typeof item !== "object") return null;
  if (itemtype === "User") {
    const full = [item.firstname, item.realname].filter((v) => typeof v === "string" && v.trim()).join(" ").trim();
    if (full) return full;
  }
  for (const k of ["completename", "name"]) {
    const v = item[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function toId(v: unknown, allowZero: boolean): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n)) return undefined;
  if (n < 0 || (n === 0 && !allowZero)) return undefined;
  return n;
}

/** Resolves names for IDs of one itemtype; unknown or forbidden ones map to null. */
export async function resolveNames(
  config: GlpiConfig,
  itemtype: string,
  ids: number[],
): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  const now = Date.now();
  const cred = v1CredentialKey(config);
  const missing: number[] = [];
  for (const i of [...new Set(ids)]) {
    const hit = cache.get(`${cred}|${itemtype}|${i}`);
    if (hit && hit.expires > now) out.set(i, hit.value);
    else missing.push(i);
  }

  const todo = missing.slice(0, MAX_NAME_LOOKUPS);
  for (const i of missing.slice(MAX_NAME_LOOKUPS)) out.set(i, null);

  for (let k = 0; k < todo.length; k += CONCURRENCY) {
    await Promise.all(
      todo.slice(k, k + CONCURRENCY).map(async (i) => {
        let value: string | null = null;
        try {
          const item = await glpiRequest<Record<string, unknown>>(config, "GET", `/${itemtype}/${i}`);
          value = displayName(itemtype, item);
        } catch {
          value = null;
        }
        out.set(i, value);
        if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
        cache.set(`${cred}|${itemtype}|${i}`, { value, expires: Date.now() + NAME_CACHE_TTL_MS });
      }),
    );
  }
  return out;
}

/** One `<field>` → `<as>` resolution. */
export interface NameSpec {
  field: string;
  itemtype: string;
  as: string;
  /** Entity 0 is the root entity, a real one; for users/groups 0 means "nobody". */
  allowZero?: boolean;
}

/**
 * Adds the `as` key to each row whose `field` holds an ID, resolving all
 * distinct IDs of an itemtype in one batch. Rows whose field is empty, 0 or
 * already a name (expand_dropdowns) are left alone. Rows are copied, not mutated.
 */
export async function addNames<T extends Record<string, unknown>>(
  config: GlpiConfig,
  rows: T[],
  specsFor: NameSpec[] | ((row: T) => NameSpec[]),
): Promise<T[]> {
  const specsOf = typeof specsFor === "function" ? specsFor : () => specsFor;
  const wanted = new Map<string, Set<number>>();
  for (const row of rows) {
    for (const spec of specsOf(row)) {
      const i = toId(row[spec.field], spec.allowZero === true);
      if (i === undefined) continue;
      if (!wanted.has(spec.itemtype)) wanted.set(spec.itemtype, new Set());
      wanted.get(spec.itemtype)!.add(i);
    }
  }

  const resolved = new Map<string, Map<number, string | null>>();
  await Promise.all(
    [...wanted].map(async ([itemtype, ids]) => {
      resolved.set(itemtype, await resolveNames(config, itemtype, [...ids]));
    }),
  );

  return rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const spec of specsOf(row)) {
      const i = toId(row[spec.field], spec.allowZero === true);
      if (i === undefined) continue;
      copy[spec.as] = resolved.get(spec.itemtype)?.get(i) ?? null;
    }
    return copy as T;
  });
}

// ---------------------------------------------------------------------------
// Code maps (not queryable through the API; same values as glpi://code-maps)
// ---------------------------------------------------------------------------

export const TICKET_STATUS_NAMES: Record<number, string> = {
  1: "New",
  2: "Processing (assigned)",
  3: "Processing (planned)",
  4: "Pending",
  5: "Solved",
  6: "Closed",
};

export const TICKET_TYPE_NAMES: Record<number, string> = { 1: "Incident", 2: "Request" };

export const ACTOR_TYPE_NAMES: Record<number, string> = { 1: "Requester", 2: "Assigned", 3: "Observer" };

/** CommonITILValidation: NONE=1, WAITING=2, ACCEPTED=3, REFUSED=4. */
export const VALIDATION_STATUS_NAMES: Record<number, string> = {
  1: "None",
  2: "Waiting",
  3: "Accepted",
  4: "Refused",
};

/** Adds `<as>` = map[row[field]] when the code is known. */
export function addCodeName<T extends Record<string, unknown>>(
  rows: T[],
  field: string,
  as: string,
  map: Record<number, string>,
): T[] {
  return rows.map((row) => {
    const code = Number(row[field]);
    return map[code] !== undefined ? ({ ...row, [as]: map[code] } as T) : row;
  });
}

// ---------------------------------------------------------------------------
// Name specs per sub-item
// ---------------------------------------------------------------------------

export const FOLLOWUP_NAMES: NameSpec[] = [
  { field: "users_id", itemtype: "User", as: "user_name" },
  { field: "users_id_editor", itemtype: "User", as: "editor_name" },
];

export const TASK_NAMES: NameSpec[] = [
  { field: "users_id", itemtype: "User", as: "user_name" },
  { field: "users_id_tech", itemtype: "User", as: "tech_name" },
  { field: "groups_id_tech", itemtype: "Group", as: "tech_group_name" },
  { field: "users_id_editor", itemtype: "User", as: "editor_name" },
];

/** GLPI 11 has empty `user_name` / `solutiontype_name` columns on ITILSolution: they get filled. */
export const SOLUTION_NAMES: NameSpec[] = [
  { field: "users_id", itemtype: "User", as: "user_name" },
  { field: "users_id_approval", itemtype: "User", as: "user_name_approval" },
  { field: "users_id_editor", itemtype: "User", as: "editor_name" },
  { field: "solutiontypes_id", itemtype: "SolutionType", as: "solutiontype_name" },
];

export const VALIDATION_NAMES: NameSpec[] = [
  { field: "users_id", itemtype: "User", as: "user_name" },
  { field: "users_id_validate", itemtype: "User", as: "validator_name" },
];

export const TICKET_NAMES: NameSpec[] = [
  { field: "users_id_recipient", itemtype: "User", as: "recipient_name" },
  { field: "users_id_lastupdater", itemtype: "User", as: "lastupdater_name" },
  { field: "itilcategories_id", itemtype: "ITILCategory", as: "category_name" },
  { field: "entities_id", itemtype: "Entity", as: "entity_name", allowZero: true },
  { field: "requesttypes_id", itemtype: "RequestType", as: "requesttype_name" },
  { field: "locations_id", itemtype: "Location", as: "location_name" },
];

/** Followups, tasks, solutions and validations with their names (and the validation status label). */
export async function nameFollowups<T extends Record<string, unknown>>(config: GlpiConfig, rows: T[]): Promise<T[]> {
  return addNames(config, rows, FOLLOWUP_NAMES);
}

export async function nameTasks<T extends Record<string, unknown>>(config: GlpiConfig, rows: T[]): Promise<T[]> {
  return addNames(config, rows, TASK_NAMES);
}

export async function nameValidations<T extends Record<string, unknown>>(config: GlpiConfig, rows: T[]): Promise<T[]> {
  return addCodeName(await addNames(config, rows, VALIDATION_NAMES), "status", "status_name", VALIDATION_STATUS_NAMES);
}
