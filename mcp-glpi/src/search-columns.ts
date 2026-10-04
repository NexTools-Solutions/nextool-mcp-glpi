/**
 * Search option names for glpi_search results (API v1).
 *
 * GET /search/:itemtype keys each column by search option ID ("1", "12",
 * "80"), which reads as noise. With `named_columns` the keys become the option
 * names from GET /listSearchOptions/:itemtype (in the GLPI user's language),
 * cached per credential and itemtype for a few minutes.
 */

import { listSearchOptions, v1CredentialKey, type GlpiConfig } from "./glpi-client.js";

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { names: Map<string, string>; expires: number }>();

async function optionNames(config: GlpiConfig, itemtype: string): Promise<Map<string, string>> {
  const key = `${v1CredentialKey(config)}|${itemtype}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.names;
  const raw = (await listSearchOptions(config, itemtype)) as Record<string, unknown> | undefined;
  const names = new Map<string, string>();
  for (const [id, opt] of Object.entries(raw ?? {})) {
    const name = (opt as { name?: unknown } | null)?.name;
    if (/^\d+$/.test(id) && typeof name === "string" && name.trim()) names.set(id, name.trim());
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, { names, expires: Date.now() + TTL_MS });
  return names;
}

/**
 * Re-keys search rows by option name. Two options with the same name keep
 * both, the later one as "Name [id]"; an unknown ID keeps its numeric key.
 */
export async function namedSearchRows(
  config: GlpiConfig,
  itemtype: string,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return rows;
  const names = await optionNames(config, itemtype);
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      const name = names.get(k);
      const key = name && !(name in out) ? name : name ? `${name} [${k}]` : k;
      out[key] = v;
    }
    return out;
  });
}
