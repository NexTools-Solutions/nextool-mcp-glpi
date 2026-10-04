/**
 * Payload formatting for the GLPI MCP servers.
 *
 * GLPI returns everything it has: a single ticket carries 45 fields, roughly
 * twenty of which are SLA/OLA bookkeeping and delay statistics no agent ever
 * reads, and richtext fields arrive as double-escaped TinyMCE HTML
 * (`&#60;div class="elementToProof"&#62;Teste&#60;/div&#62;`). Returning that raw
 * burns context on every call.
 *
 * `essential` mode keeps the fields that describe the item; `all` returns the
 * untouched payload for the cases where a rare field is genuinely needed.
 */

export type FieldMode = "essential" | "all";
export type OutputFormat = "json" | "markdown";

// ---------------------------------------------------------------------------
// HTML handling
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * Turns a TinyMCE richtext field into plain text.
 *
 * Entities are decoded twice on purpose: GLPI stores the markup escaped, so a
 * first pass turns `&#60;div&#62;` into real tags that the tag stripper can
 * remove, and a second pass decodes the entities that were inside the text.
 */
export function stripHtml(value: string): string {
  if (!value) return value;
  let s = decodeEntities(value);
  s = s
    .replace(/<\s*(br|BR)\s*\/?\s*>/g, "\n")
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*li\s*>/gi, "- ")
    .replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  return s
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}

/** Fields whose content is richtext and should be flattened to plain text. */
export const RICHTEXT_FIELDS = new Set([
  "content",
  "solution",
  "comment",
  "comments",
  "answer",
  "description",
  "begin",
  "long_text",
]);

// ---------------------------------------------------------------------------
// Field selection
// ---------------------------------------------------------------------------

/**
 * Per-itemtype whitelists. Derived from real payloads: what is dropped for
 * Ticket is the SLA/OLA block, the *_delay_stat counters and the HAL `links`.
 */
export const ESSENTIAL_FIELDS: Record<string, string[]> = {
  Ticket: [
    "id", "entities_id", "name", "content", "status", "type", "urgency", "impact",
    "priority", "itilcategories_id", "requesttypes_id", "locations_id",
    "users_id_recipient", "users_id_lastupdater", "date", "date_creation", "date_mod",
    "solvedate", "closedate", "time_to_resolve", "time_to_own", "global_validation",
  ],
  Change: [
    "id", "entities_id", "name", "content", "status", "urgency", "impact", "priority",
    "itilcategories_id", "users_id_recipient", "users_id_lastupdater", "date",
    "date_creation", "date_mod", "solvedate", "closedate", "global_validation",
    "impactcontent", "controlistcontent", "rolloutplancontent", "backoutplancontent",
  ],
  Problem: [
    "id", "entities_id", "name", "content", "status", "urgency", "impact", "priority",
    "itilcategories_id", "users_id_recipient", "users_id_lastupdater", "date",
    "date_creation", "date_mod", "solvedate", "closedate", "impactcontent", "causecontent",
  ],
  ITILFollowup: [
    "id", "itemtype", "items_id", "date", "users_id", "content", "is_private",
    "requesttypes_id", "date_creation", "date_mod",
  ],
  ITILSolution: [
    "id", "itemtype", "items_id", "solutiontypes_id", "content", "date_creation",
    "users_id", "status",
  ],
  TicketTask: [
    "id", "tickets_id", "date", "users_id", "users_id_tech", "groups_id_tech", "content",
    "is_private", "state", "actiontime", "begin", "end", "date_creation", "date_mod",
  ],
  User: [
    "id", "name", "realname", "firstname", "is_active", "phone", "phone2", "mobile",
    "locations_id", "usertitles_id", "usercategories_id", "language", "last_login",
    "date_creation", "date_mod", "entities_id", "profiles_id",
  ],
  Group: ["id", "entities_id", "name", "comment", "is_recursive", "date_creation", "date_mod"],
  Entity: [
    "id", "entities_id", "name", "completename", "comment", "level", "phonenumber",
    "email", "address", "date_creation", "date_mod",
  ],
  KnowbaseItem: [
    "id", "name", "answer", "is_faq", "view", "date_creation", "date_mod", "users_id",
    "knowbaseitemcategories_id",
  ],
  KnowbaseItemCategory: ["id", "name", "completename", "comment", "level", "knowbaseitemcategories_id"],
  Document: [
    "id", "entities_id", "name", "filename", "filepath", "mime", "documentcategories_id",
    "date_creation", "date_mod", "users_id", "sha1sum",
  ],
  Location: ["id", "entities_id", "name", "completename", "comment", "level", "building", "room"],
  ITILCategory: ["id", "entities_id", "name", "completename", "comment", "level", "is_helpdeskvisible"],
  Computer: [
    "id", "entities_id", "name", "serial", "otherserial", "states_id", "locations_id",
    "manufacturers_id", "computertypes_id", "computermodels_id", "users_id", "groups_id",
    "is_deleted", "date_creation", "date_mod", "comment", "uuid",
  ],
  Monitor: [
    "id", "entities_id", "name", "serial", "otherserial", "states_id", "locations_id",
    "manufacturers_id", "monitortypes_id", "monitormodels_id", "users_id", "size",
    "date_creation", "date_mod", "comment",
  ],
  Printer: [
    "id", "entities_id", "name", "serial", "otherserial", "states_id", "locations_id",
    "manufacturers_id", "printertypes_id", "printermodels_id", "users_id",
    "date_creation", "date_mod", "comment",
  ],
  NetworkEquipment: [
    "id", "entities_id", "name", "serial", "otherserial", "states_id", "locations_id",
    "manufacturers_id", "networkequipmenttypes_id", "networkequipmentmodels_id",
    "date_creation", "date_mod", "comment",
  ],
  Peripheral: [
    "id", "entities_id", "name", "serial", "otherserial", "states_id", "locations_id",
    "manufacturers_id", "peripheraltypes_id", "peripheralmodels_id", "users_id",
    "date_creation", "date_mod", "comment",
  ],
  Phone: [
    "id", "entities_id", "name", "serial", "otherserial", "states_id", "locations_id",
    "manufacturers_id", "phonetypes_id", "phonemodels_id", "users_id",
    "date_creation", "date_mod", "comment",
  ],
  Software: [
    "id", "entities_id", "name", "manufacturers_id", "softwarecategories_id",
    "is_helpdesk_visible", "is_valid", "date_creation", "date_mod", "comment",
  ],
  Webhook: [
    "id", "entities_id", "name", "url", "itemtype", "event", "is_active", "http_method",
    "use_default_payload", "webhookcategories_id", "comment", "date_creation", "date_mod",
  ],
  // `body` and `headers` are the bulk of a queued delivery; reach for them with
  // fields:"all" when actually debugging a payload.
  QueuedWebhook: [
    "id", "entities_id", "name", "webhooks_id", "itemtype", "items_id", "url", "http_method",
    "create_time", "send_time", "sent_time", "sent_try", "last_status_code",
  ],
  Reservation: [
    "id", "reservationitems_id", "begin", "end", "users_id", "comment", "group",
    "date_creation", "date_mod",
  ],
  ReservationItem: [
    "id", "itemtype", "items_id", "entities_id", "is_active", "comment", "date_creation",
  ],
};

/** Dropped from any itemtype without an explicit whitelist. */
const ALWAYS_DROP: RegExp[] = [
  /^links$/,
  /_delay_stat$/,
  /^sla/,
  /^ola/,
  /^slalevels_/,
  /^olalevels_/,
  /_waiting_duration$/,
  /^waiting_duration$/,
  /^begin_waiting_date$/,
  /^internal_time_to_/,
  /^validation_percent$/,
  // API v2 statistics (resolution_duration, take_into_account_duration, ...) and
  // internal OLA dates; v2 payloads have no per-itemtype whitelist.
  /_duration$/,
  /^internal_/,
];

function isDropped(key: string): boolean {
  return ALWAYS_DROP.some((re) => re.test(key));
}

/**
 * Applies the whitelist (or the generic blocklist) and flattens richtext.
 *
 * Some keys survive any whitelist:
 *   - keys starting with `_`: the apirest relational expansions (`_devices`,
 *     `_disks`, `_softwares`, `_networkports`), only present when asked for;
 *   - keys ending with `_name` (`user_name`, `status_name`, ...): names the
 *     server resolved next to an ID, so people and dropdowns read as words;
 *   - purely numeric keys: the columns of a GLPI search result, keyed by
 *     search option ID (a whitelist of field names would drop every one).
 */
function alwaysKept(key: string): boolean {
  return key.startsWith("_") || key.endsWith("_name") || /^\d+$/.test(key);
}

export function pickFields(
  itemtype: string | undefined,
  obj: Record<string, unknown>,
  mode: FieldMode,
): Record<string, unknown> {
  if (mode === "all") return obj;

  const whitelist = itemtype ? ESSENTIAL_FIELDS[itemtype] : undefined;
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(obj)) {
    const keep = whitelist ? whitelist.includes(k) || alwaysKept(k) : !isDropped(k);
    if (!keep) continue;
    out[k] = typeof v === "string" && RICHTEXT_FIELDS.has(k) ? stripHtml(v) : v;
  }
  return out;
}

/**
 * Formats a whole payload. Objects and arrays of objects are filtered;
 * anything else is returned untouched.
 */
export function formatPayload(itemtype: string | undefined, data: unknown, mode: FieldMode): unknown {
  if (mode === "all") return data;
  if (Array.isArray(data)) {
    return data.map((row) =>
      typeof row === "object" && row !== null && !Array.isArray(row)
        ? pickFields(itemtype, row as Record<string, unknown>, mode)
        : row,
    );
  }
  if (typeof data === "object" && data !== null) {
    return pickFields(itemtype, data as Record<string, unknown>, mode);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

const MAX_CELL = 80;

/**
 * `{id, name}` (the shape API v2 uses for every relation, and the one the v1
 * tools use for resolved actors) reads as "name (id)"; arrays of them as a
 * comma list. Anything else stays JSON.
 */
function compactValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v !== "object" || v === null || isNamedRef(v))) {
      return value.map((v) => compactValue(v)).join(", ");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "object") {
    if (isNamedRef(value)) {
      const ref = value as Record<string, unknown>;
      const label = String(ref.display_name ?? ref.completename ?? ref.name ?? "");
      const role = typeof ref.role === "string" ? `${ref.role}: ` : "";
      return ref.id !== undefined && ref.id !== null && !label.includes(`(${String(ref.id)})`)
        ? `${role}${label} (${String(ref.id)})`
        : `${role}${label}`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function isNamedRef(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    ["name", "display_name", "completename"].some((k) => typeof o[k] === "string") &&
    Object.values(o).every((x) => typeof x !== "object" || x === null)
  );
}

function cell(value: unknown): string {
  let s = compactValue(value);
  s = s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s;
}

/**
 * Renders rows as a markdown table. Columns come from the union of the keys
 * present, in first-seen order, so a sparse row does not lose its data.
 * Long cells are cut at 80 characters: a table is for scanning a listing;
 * open the item (or ask for JSON) to read a long text in full.
 */
export function toMarkdownTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "_No results._";

  const cols: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
  }

  const header = `| ${cols.join(" | ")} |`;
  const divider = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${cols.map((c) => cell(r[c])).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

/**
 * A single item as `**key**: value` lines. Values are never cut (this is how
 * one ticket is read); a multi-line text starts on its own line, indented.
 */
function renderObject(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([k, v]) => {
      const s = compactValue(v).trim();
      return s.includes("\n") ? `**${k}**:\n${s.replace(/^/gm, "  ")}` : `**${k}**: ${s}`;
    })
    .join("\n");
}

/** Renders a payload as markdown; falls back to JSON for non-tabular shapes. */
export function renderMarkdown(data: unknown): string {
  if (Array.isArray(data)) {
    const rows = data.filter(
      (r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r),
    );
    if (rows.length === data.length) return toMarkdownTable(rows);
    return JSON.stringify(data, null, 2);
  }
  if (typeof data === "object" && data !== null) {
    return renderObject(data as Record<string, unknown>);
  }
  return String(data);
}
