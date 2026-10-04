/**
 * Search option names for glpi_search results (API v1).
 *
 * GET /search/:itemtype keys each column by search option ID ("1", "12",
 * "80"), which reads as noise. With `named_columns` the keys become the option
 * names from GET /listSearchOptions/:itemtype (in the GLPI user's language),
 * cached per credential and itemtype for a few minutes.
 *
 * Enumerated columns (status, priority, urgency, impact, ticket type, approval
 * status) come from the search as bare codes (`"Status": 5`). In named mode
 * the value becomes the GLPI label in the session language ("Solucionado") and
 * the code moves to a sibling key "<name> (id)" (`"Status (id)": 5`), so the
 * row reads like the GLPI list and the code is still there for a follow-up
 * criterion. A column is labelled only when its option points at a known
 * (table, field) pair; named_columns=false returns the raw search untouched.
 */

import { listSearchOptions, v1CredentialKey, type GlpiConfig } from "./glpi-client.js";
import type { LabelKind, LabelTable } from "./labels.js";

const TTL_MS = 10 * 60_000;

interface SearchOption {
  name: string;
  table?: string;
  field?: string;
}

const cache = new Map<string, { options: Map<string, SearchOption>; expires: number }>();

async function searchOptions(config: GlpiConfig, itemtype: string): Promise<Map<string, SearchOption>> {
  const key = `${v1CredentialKey(config)}|${itemtype}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.options;
  const raw = (await listSearchOptions(config, itemtype)) as Record<string, unknown> | undefined;
  const options = new Map<string, SearchOption>();
  for (const [id, opt] of Object.entries(raw ?? {})) {
    const o = (opt ?? {}) as { name?: unknown; table?: unknown; field?: unknown };
    if (/^\d+$/.test(id) && typeof o.name === "string" && o.name.trim()) {
      options.set(id, {
        name: o.name.trim(),
        table: typeof o.table === "string" ? o.table : undefined,
        field: typeof o.field === "string" ? o.field : undefined,
      });
    }
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, { options, expires: Date.now() + TTL_MS });
  return options;
}

/** Status tables of the ITIL objects, by their database table. */
const STATUS_BY_TABLE: Record<string, LabelKind> = {
  glpi_tickets: "ticket_status",
  glpi_problems: "problem_status",
  glpi_changes: "change_status",
};
const ITIL_TABLES = new Set(Object.keys(STATUS_BY_TABLE));
/** Approval statuses: validations, the ITIL global_validation and solution approval share CommonITILValidation's codes. */
const VALIDATION_TABLES = new Set(["glpi_ticketvalidations", "glpi_changevalidations", "glpi_itilsolutions"]);

/** Label table a search option's values come from, if they are codes GLPI labels. */
export function optionLabelKind(table: string | undefined, field: string | undefined): LabelKind | undefined {
  if (!table || !field) return undefined;
  if (field === "status") {
    if (STATUS_BY_TABLE[table]) return STATUS_BY_TABLE[table];
    if (VALIDATION_TABLES.has(table)) return "validation_status";
    return undefined;
  }
  if (!ITIL_TABLES.has(table)) return undefined;
  if (field === "priority" || field === "urgency" || field === "impact") return field;
  if (field === "global_validation") return "validation_status";
  if (field === "type" && table === "glpi_tickets") return "ticket_type";
  return undefined;
}

/** Label of a code, or of several codes joined by GLPI's "$#$"; undefined when any part is unknown. */
function labelOf(value: unknown, map: Readonly<Record<number, string>>): string | undefined {
  if (typeof value === "number") return map[value];
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parts = value.split("$#$").map((p) => p.trim());
  if (!parts.every((p) => /^\d+$/.test(p) && map[Number(p)] !== undefined)) return undefined;
  return parts.map((p) => map[Number(p)]).join(", ");
}

/**
 * Re-keys search rows by option name. Two options with the same name keep
 * both, the later one as "Name [id]"; an unknown ID keeps its numeric key.
 * With `labels`, enumerated columns carry the label and "<name> (id)" the code.
 */
export async function namedSearchRows(
  config: GlpiConfig,
  itemtype: string,
  rows: Record<string, unknown>[],
  labels?: LabelTable,
): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return rows;
  const options = await searchOptions(config, itemtype);
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      const opt = options.get(k);
      const name = opt?.name;
      const key = name && !(name in out) ? name : name ? `${name} [${k}]` : k;
      const kind = labels && opt ? optionLabelKind(opt.table, opt.field) : undefined;
      const text = kind ? labelOf(v, labels![kind]) : undefined;
      if (text !== undefined) {
        out[key] = text;
        out[`${key} (id)`] = v;
      } else {
        out[key] = v;
      }
    }
    return out;
  });
}
