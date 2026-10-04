/**
 * Conversational markdown views: the columns a person scans for in each kind of
 * listing, used when a tool is called with `format: "markdown"`.
 *
 * A raw GLPI ticket row has 22 columns, bare IDs among them
 * (`users_id_lastupdater: 368`); as a table in a chat that is noise. These
 * views pick the few columns that answer "what is this, where is it, who has
 * it", reading the names the server resolved beside the IDs. The JSON result
 * (`structuredContent` in JSON mode) is untouched, and `fields: "all"` draws
 * every column again (see installPayloadFormatting `markdownViews`).
 *
 * Column labels are English like the rest of the server's own vocabulary; the
 * VALUES (status, type, priority labels, names) are in the GLPI user's language.
 * API v2 priorities read `priority_name`, which the v2 tools add beside the code
 * in the language of the status labels the API returns (3.5.1).
 */

import { columnView, type MarkdownColumn, type MarkdownView } from "@nextoolsolutions/mcp-glpi-core";

type Row = Record<string, unknown>;

/** `{id, name}` / `{display_name}` -> its label; a list of them -> "a, b". */
function label(v: unknown): unknown {
  if (Array.isArray(v)) {
    const parts = v.map(label).filter((x) => x !== undefined && x !== null && x !== "");
    return parts.length ? parts.join(", ") : undefined;
  }
  if (v && typeof v === "object") {
    const o = v as Row;
    const full = [o.firstname, o.realname].filter((x) => typeof x === "string" && x.trim()).join(" ");
    return o.completename ?? (full || undefined) ?? o.display_name ?? o.name ?? undefined;
  }
  return v;
}

/** v2 `team` members holding a role ("requester", "assigned", "observer"). */
function team(role: string): (row: Row) => unknown {
  return (row) => label(Array.isArray(row.team) ? (row.team as Row[]).filter((m) => m?.role === role) : []);
}

/** First non-empty of the keys, passed through `label`; a foreign key of 0 means "none". */
function pick(...keys: string[]): (row: Row) => unknown {
  return (row) => {
    for (const k of keys) {
      if (k.endsWith("_id") && (row[k] === 0 || row[k] === "0")) continue;
      const v = label(row[k]);
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return undefined;
  };
}

function fullName(row: Row): unknown {
  const full = [row.firstname, row.realname].filter((x) => typeof x === "string" && x.trim()).join(" ");
  return full || undefined;
}

function yesNo(key: string): (row: Row) => unknown {
  return (row) => (row[key] === undefined || row[key] === null ? undefined : row[key] === true || Number(row[key]) === 1 ? "yes" : "no");
}

const col = (l: string, from: MarkdownColumn["from"]): MarkdownColumn => ({ label: l, from });

// ---------------------------------------------------------------------------
// API v1
// ---------------------------------------------------------------------------

const V1_TICKETS = columnView([
  col("id", "id"),
  col("title", "name"),
  col("status", ["status_name", "status"]),
  col("category", pick("category_name", "category", "itilcategories_id")),
  col("requester", pick("requesters")),
  col("technician", pick("assigned")),
  col("priority", ["priority_name", "priority"]),
  col("updated", "date_mod"),
]);

const V1_ITIL = columnView([
  col("id", "id"),
  col("title", "name"),
  col("status", ["status_name", "status"]),
  col("category", pick("category_name", "itilcategories_id")),
  col("priority", ["priority_name", "priority"]),
  col("updated", "date_mod"),
]);

const V1_ASSETS = columnView([
  col("id", "id"),
  col("name", "name"),
  col("serial", "serial"),
  col("inventory number", "otherserial"),
  col("status", pick("state_name", "states_id")),
  col("location", pick("location_name", "locations_id")),
  col("user", pick("user_name", "users_id")),
  col("updated", "date_mod"),
]);

const V1_USERS = columnView([
  col("id", "id"),
  col("login", "name"),
  col("name", fullName),
  col("active", yesNo("is_active")),
  col("last login", "last_login"),
]);

const V1_KB = columnView([
  col("id", "id"),
  col("title", "name"),
  col("FAQ", yesNo("is_faq")),
  col("views", "view"),
  col("updated", "date_mod"),
]);

/** Timeline: one line per entry, never the union of every entry type's columns. */
const V1_TIMELINE = columnView([
  col("type", "type"),
  col("id", "id"),
  col("date", "date"),
  col("author", pick("user_name", "users_id")),
  col("summary", (r) => {
    if (r.type === "validation") {
      const text = r.comment_validation || r.comment_submission;
      return [r.status_name ?? r.status, r.validator_name && `→ ${String(r.validator_name)}`, text].filter(Boolean).join(" · ");
    }
    return r.content;
  }),
]);

const V1_FOLLOWUPS = columnView([
  col("id", "id"),
  col("date", ["date", "date_creation"]),
  col("author", pick("user_name", "users_id")),
  col("private", yesNo("is_private")),
  col("summary", "content"),
]);

const V1_TASKS = columnView([
  col("id", "id"),
  col("date", ["date", "date_creation"]),
  col("author", pick("user_name", "users_id")),
  col("technician", pick("tech_name", "tech_group_name")),
  col("private", yesNo("is_private")),
  col("summary", "content"),
]);

/**
 * glpi_search: its columns depend on the query, so the row is kept whole; only
 * the "<name> (id)" codes beside a labelled column are left out of the table
 * (the JSON, and fields=all, keep them).
 */
const V1_SEARCH: MarkdownView = (row) =>
  Object.fromEntries(
    Object.entries(row).filter(([k]) => !(k.endsWith(" (id)") && k.slice(0, -5) in row)),
  );

// ---------------------------------------------------------------------------
// API v2 (relations are {id, name}; people of an ITIL item sit in `team`)
// ---------------------------------------------------------------------------

const V2_TICKETS = columnView([
  col("id", "id"),
  col("title", "name"),
  col("status", pick("status")),
  col("category", pick("category")),
  col("requester", team("requester")),
  col("technician", team("assigned")),
  col("priority", ["priority_name", "priority"]),
  col("updated", "date_mod"),
]);

const V2_ITIL = columnView([
  col("id", "id"),
  col("title", "name"),
  col("status", pick("status")),
  col("category", pick("category")),
  col("technician", team("assigned")),
  col("priority", ["priority_name", "priority"]),
  col("updated", "date_mod"),
]);

const V2_USERS = columnView([
  col("id", "id"),
  col("login", "username"),
  col("name", fullName),
  col("active", yesNo("is_active")),
  col("last login", "last_login"),
]);

const V2_KB = columnView([
  col("id", "id"),
  col("title", "name"),
  col("category", pick("categories")),
  col("FAQ", yesNo("is_faq")),
  col("views", "views"),
  col("updated", "date_mod"),
]);

const V2_TIMELINE = columnView([
  col("type", "type"),
  col("id", (r) => (r.item as Row | undefined)?.id),
  col("date", (r) => {
    const i = (r.item ?? {}) as Row;
    return i.date ?? i.date_creation ?? i.submission_date;
  }),
  col("author", (r) => {
    const i = (r.item ?? {}) as Row;
    return label(i.user ?? i.requester);
  }),
  col("summary", (r) => {
    const i = (r.item ?? {}) as Row;
    if (r.type === "Validation") {
      // v2 names: submission_comment / approval_comment, approver {id, name}.
      const text = i.approval_comment || i.submission_comment;
      const approver = label(i.approver);
      return [i.status_name ?? i.status, approver && `→ ${String(approver)}`, text].filter(Boolean).join(" · ");
    }
    if (r.type === "Task" && i.state_name) return [i.state_name, i.content].filter(Boolean).join(" · ");
    return i.content;
  }),
]);

export const MARKDOWN_VIEWS: Readonly<Record<string, MarkdownView>> = {
  glpi_search: V1_SEARCH,
  glpi_list_tickets: V1_TICKETS,
  glpi_list_my_tickets: V1_TICKETS,
  glpi_list_problems: V1_ITIL,
  glpi_list_changes: V1_ITIL,
  glpi_list_assets: V1_ASSETS,
  glpi_list_users: V1_USERS,
  glpi_search_user_by_email: V1_USERS,
  glpi_list_knowbase_items: V1_KB,
  glpi_list_timeline: V1_TIMELINE,
  glpi_list_followups: V1_FOLLOWUPS,
  glpi_list_change_followups: V1_FOLLOWUPS,
  glpi_list_problem_followups: V1_FOLLOWUPS,
  glpi_list_ticket_tasks: V1_TASKS,
  glpi_list_change_tasks: V1_TASKS,
  glpi_list_problem_tasks: V1_TASKS,
  glpi_v2_list_tickets: V2_TICKETS,
  glpi_v2_list_problems: V2_ITIL,
  glpi_v2_list_changes: V2_ITIL,
  glpi_v2_list_users: V2_USERS,
  glpi_v2_list_kb_articles: V2_KB,
  glpi_v2_list_timeline: V2_TIMELINE,
};
