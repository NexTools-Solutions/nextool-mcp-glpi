/**
 * Pagination defaults for the GLPI MCP servers.
 *
 * Every list tool took `range` (v1) or `limit` (v2) as optional, with no
 * default and no ceiling: a list call on a busy instance could pull thousands
 * of items into the context in one shot.
 *
 * Environment tunables:
 *   GLPI_DEFAULT_PAGE_SIZE — items returned when the caller gives no range (default 25)
 *   GLPI_MAX_PAGE_SIZE     — hard ceiling per call (default 200)
 */

export const DEFAULT_PAGE_SIZE = clampInt(process.env.GLPI_DEFAULT_PAGE_SIZE, 25, 1, 1000);
export const MAX_PAGE_SIZE = clampInt(process.env.GLPI_MAX_PAGE_SIZE, 200, 1, 10000);

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseInt(raw ?? "", 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export interface RangeResolution {
  /** The range string to send to GLPI, e.g. "0-24". */
  range: string;
  /** True when the caller's range was reduced to the ceiling. */
  capped: boolean;
  /** True when no range was given and the default was applied. */
  defaulted: boolean;
}

/**
 * Resolves a v1 `range` parameter ("start-end", inclusive on both ends).
 * An unparseable range falls back to the default rather than being passed on.
 */
export function resolveRange(
  range: string | undefined,
  defaultSize = DEFAULT_PAGE_SIZE,
  maxSize = MAX_PAGE_SIZE,
): RangeResolution {
  if (!range) {
    return { range: `0-${defaultSize - 1}`, capped: false, defaulted: true };
  }

  const m = /^(\d+)\s*-\s*(\d+)$/.exec(range.trim());
  if (!m) {
    return { range: `0-${defaultSize - 1}`, capped: false, defaulted: true };
  }

  const start = Number(m[1]);
  const end = Number(m[2]);
  if (end < start) {
    return { range: `${start}-${start + defaultSize - 1}`, capped: false, defaulted: true };
  }

  const requested = end - start + 1;
  if (requested > maxSize) {
    return { range: `${start}-${start + maxSize - 1}`, capped: true, defaulted: false };
  }
  return { range: `${start}-${end}`, capped: false, defaulted: false };
}

export interface LimitResolution {
  limit: number;
  capped: boolean;
  defaulted: boolean;
}

/** Resolves a v2 `limit` parameter. */
export function resolveLimit(
  limit: number | undefined,
  defaultSize = DEFAULT_PAGE_SIZE,
  maxSize = MAX_PAGE_SIZE,
): LimitResolution {
  if (limit === undefined || limit === null || Number.isNaN(limit)) {
    return { limit: defaultSize, capped: false, defaulted: true };
  }
  const n = Math.floor(limit);
  if (n < 1) return { limit: defaultSize, capped: false, defaulted: true };
  if (n > maxSize) return { limit: maxSize, capped: true, defaulted: false };
  return { limit: n, capped: false, defaulted: false };
}

/** Note appended to a truncated payload so the agent knows to page. */
export function paginationNote(res: RangeResolution | LimitResolution, itemsReturned: number): string | undefined {
  const size = "range" in res ? res.range : String(res.limit);
  if (res.capped) {
    return `Result capped at ${MAX_PAGE_SIZE} items per call (requested more). Page through with the range/start parameters.`;
  }
  if (res.defaulted && itemsReturned >= DEFAULT_PAGE_SIZE) {
    return `Showing the default first ${DEFAULT_PAGE_SIZE} items (${size}). Ask for a wider range to see more.`;
  }
  return undefined;
}
