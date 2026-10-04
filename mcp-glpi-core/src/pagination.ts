/**
 * Pagination defaults for the GLPI MCP servers.
 *
 * Every list tool took `range` (v1) or `limit` (v2) as optional, with no
 * default and no ceiling: a list call on a busy instance could pull thousands
 * of items into the context in one shot.
 *
 * Item counts alone did not bound the answer: 200 tickets with their HTML
 * descriptions came to 116k characters, past what an MCP client accepts from
 * one tool call. Listings are therefore bounded by size too (see
 * server-format.ts): long text fields are cut in listings and the response is
 * trimmed to a character budget, with a note saying how to get the rest.
 *
 * Environment tunables:
 *   GLPI_DEFAULT_PAGE_SIZE    — items returned when the caller gives no range (default 25)
 *   GLPI_MAX_PAGE_SIZE        — hard ceiling per call (default 100; 200 before 1.2.0)
 *   GLPI_MAX_RESPONSE_CHARS   — character budget of one tool answer (default 50000)
 *   GLPI_LIST_TEXT_MAX_CHARS  — text fields longer than this are cut in listings (default 300)
 */

export const DEFAULT_PAGE_SIZE = clampInt(process.env.GLPI_DEFAULT_PAGE_SIZE, 25, 1, 1000);
export const MAX_PAGE_SIZE = clampInt(process.env.GLPI_MAX_PAGE_SIZE, 100, 1, 10000);
export const MAX_RESPONSE_CHARS = clampInt(process.env.GLPI_MAX_RESPONSE_CHARS, 50000, 2000, 10_000_000);
export const LIST_TEXT_MAX_CHARS = clampInt(process.env.GLPI_LIST_TEXT_MAX_CHARS, 300, 40, 1_000_000);

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

/**
 * Note appended to a truncated payload so the agent knows to page. Generic
 * wording: it names no parameter (a tool may have `range`, or `start`/`limit`,
 * or neither). The formatting layer uses `nextPageNote`, which names the
 * parameters the tool really has.
 */
export function paginationNote(res: RangeResolution | LimitResolution, itemsReturned: number): string | undefined {
  const size = "range" in res ? res.range : String(res.limit);
  if (res.capped) {
    return `Result capped at ${MAX_PAGE_SIZE} items per call (requested more). Request the next page to see more.`;
  }
  if (res.defaulted && itemsReturned >= DEFAULT_PAGE_SIZE) {
    return `Showing the default first ${DEFAULT_PAGE_SIZE} items (${size}). Request the next page to see more.`;
  }
  return undefined;
}

export interface PageState {
  /** The page that was requested (after defaults and ceiling). */
  page: RangeResolution | LimitResolution;
  /** Offset of the page when the tool pages with start/limit. */
  start?: number;
  /** Items actually returned (after the size budget). */
  returned: number;
  /** Items the API sent before the size budget trimmed the list. */
  fetched: number;
  /** Total matching items, when the tool knows it. */
  total?: number;
  /** Parameters this tool accepts: only these may be named in the note. */
  params: { range: boolean; start: boolean; limit: boolean };
}

/**
 * Pagination note that names only the tool's own parameters, with the exact
 * values of the next page ("Next page: range=25-49"). Undefined when nothing
 * suggests more items exist.
 */
export function nextPageNote(s: PageState): string | undefined {
  const sizeCut = s.returned < s.fetched;
  const full = "range" in s.page ? s.fetched >= rangeSize(s.page.range) : s.fetched >= s.page.limit;
  const more = s.total !== undefined ? offsetOf(s) + s.returned < s.total : sizeCut || full;
  if (!more && !s.page.capped) return undefined;

  const parts: string[] = [];
  if (sizeCut) {
    parts.push(
      `Response size limit (${MAX_RESPONSE_CHARS} characters): returned ${s.returned} of the ${s.fetched} items fetched.`,
    );
  } else if (s.page.capped) {
    parts.push(`Result capped at ${MAX_PAGE_SIZE} items per call.`);
  } else if (s.page.defaulted) {
    parts.push(`Showing the default first ${s.returned} items.`);
  }
  if (s.total !== undefined) parts.push(`${s.total} match in total.`);

  const next = offsetOf(s) + s.returned;
  if ("range" in s.page && s.params.range) {
    const size = sizeCut ? Math.max(s.returned, 1) : rangeSize(s.page.range);
    parts.push(`Next page: range=${next}-${next + size - 1}.`);
  } else if (!("range" in s.page) && s.params.start) {
    const size = sizeCut ? Math.max(s.returned, 1) : s.page.limit;
    parts.push(`Next page: start=${next}${s.params.limit ? ` limit=${size}` : ""}.`);
  }
  return parts.join(" ");
}

function rangeSize(range: string): number {
  const m = /^(\d+)-(\d+)$/.exec(range);
  return m ? Number(m[2]) - Number(m[1]) + 1 : DEFAULT_PAGE_SIZE;
}

function offsetOf(s: PageState): number {
  if ("range" in s.page) {
    const m = /^(\d+)-/.exec(s.page.range);
    return m ? Number(m[1]) : 0;
  }
  return s.start ?? 0;
}
