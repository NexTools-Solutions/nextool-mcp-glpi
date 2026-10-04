/**
 * Named toolsets: presets of tool names selected with GLPI_TOOLSETS (or the
 * `toolsets` option of instanceFromConfig), e.g. GLPI_TOOLSETS=tickets,kb.
 *
 * Domain presets cover both API families (a v1 tool and its v2 counterpart sit
 * in the same preset); a family still registers only when its credentials are
 * set. A tool may belong to more than one preset. The test suite asserts that
 * every registered tool belongs to at least one preset other than `core`.
 *
 * `core` is the lean default for hosted use: every read tool of the domain
 * presets (no webhook/rule/session internals) plus the non-destructive ticket
 * operations (create/update ticket, followup, solution, task, validation,
 * actors).
 *
 * Self-contained presets (asserted by the test suite): a tool named in the
 * description or parameters of another tool is in every preset that holds
 * the tool naming it — a preset never sends the model after a tool it lacks.
 * Each domain preset therefore carries the reads it points to: generic search
 * and its option catalogue, and the user/group reads that turn IDs into names.
 */

import { classifyTool } from "@nextoolsolutions/mcp-glpi-core";
import { parseGlobList } from "./tool-filter.js";

export interface ToolsetDefinition {
  description: string;
  /** Exact tool names. */
  tools: readonly string[];
  /** Globs on tool names (same syntax as GLPI_TOOLS_INCLUDE). */
  globs?: readonly string[];
}

const TICKETS = [
  "glpi_list_tickets", "glpi_list_my_tickets", "glpi_get_ticket", "glpi_create_ticket", "glpi_update_ticket",
  "glpi_add_followup", "glpi_list_followups", "glpi_add_solution", "glpi_list_timeline",
  "glpi_list_ticket_validations", "glpi_create_ticket_validation", "glpi_update_ticket_validation",
  "glpi_delete_ticket_validation", "glpi_list_ticket_users", "glpi_add_ticket_user",
  "glpi_delete_ticket_user", "glpi_list_ticket_groups", "glpi_add_ticket_group",
  "glpi_delete_ticket_group", "glpi_list_ticket_tasks", "glpi_add_ticket_task",
  "glpi_get_ticket_stats", "glpi_list_itil_categories", "glpi_get_itil_category",
  "glpi_list_itil_followup_templates", "glpi_get_itil_followup_template",
  "glpi_v2_list_tickets", "glpi_v2_get_ticket", "glpi_v2_create_ticket", "glpi_v2_update_ticket",
  "glpi_v2_delete_ticket", "glpi_v2_list_timeline", "glpi_v2_add_followup", "glpi_v2_add_solution",
  "glpi_v2_add_task", "glpi_v2_add_validation", "glpi_v2_update_validation",
  "glpi_v2_list_team_members", "glpi_v2_add_team_member", "glpi_v2_remove_team_member",
  "glpi_v2_list_itil_categories", "glpi_v2_get_itil_category", "glpi_v2_list_request_types",
] as const;

const ITIL = [
  "glpi_list_changes", "glpi_get_change", "glpi_create_change", "glpi_update_change",
  "glpi_list_change_followups", "glpi_add_change_followup", "glpi_add_change_solution",
  "glpi_list_change_tasks",
  "glpi_list_problems", "glpi_get_problem", "glpi_create_problem", "glpi_update_problem",
  "glpi_list_problem_followups", "glpi_add_problem_followup", "glpi_add_problem_solution",
  "glpi_list_problem_tasks",
  "glpi_list_timeline", "glpi_list_itil_categories", "glpi_get_itil_category",
  "glpi_v2_list_changes", "glpi_v2_get_change", "glpi_v2_create_change", "glpi_v2_update_change",
  "glpi_v2_list_problems", "glpi_v2_get_problem", "glpi_v2_create_problem", "glpi_v2_update_problem",
  "glpi_v2_list_timeline", "glpi_v2_add_followup", "glpi_v2_add_solution", "glpi_v2_add_task",
  "glpi_v2_add_validation", "glpi_v2_update_validation", "glpi_v2_list_team_members",
  "glpi_v2_add_team_member", "glpi_v2_remove_team_member",
  "glpi_v2_list_itil_categories", "glpi_v2_get_itil_category",
] as const;

const ASSETS = [
  "glpi_list_assets", "glpi_get_asset", "glpi_get_asset_details", "glpi_create_asset",
  "glpi_update_asset", "glpi_list_reservation_items", "glpi_list_reservations",
  "glpi_get_reservation", "glpi_create_reservation", "glpi_update_reservation",
  "glpi_list_locations", "glpi_get_location",
  "glpi_v2_list_locations",
] as const;

const KB = [
  "glpi_list_knowbase_items", "glpi_get_knowbase_item", "glpi_create_knowbase_item",
  "glpi_update_knowbase_item", "glpi_delete_knowbase_item",
  "glpi_list_knowbase_categories", "glpi_get_knowbase_category", "glpi_create_knowbase_category",
  "glpi_update_knowbase_category", "glpi_delete_knowbase_category",
  "glpi_v2_list_kb_articles", "glpi_v2_get_kb_article", "glpi_v2_create_kb_article",
  "glpi_v2_update_kb_article", "glpi_v2_list_kb_categories", "glpi_v2_get_kb_category",
] as const;

const DOCUMENTS = [
  "glpi_list_documents", "glpi_get_document", "glpi_create_document", "glpi_delete_document",
  "glpi_list_document_items", "glpi_get_document_item", "glpi_create_document_item",
  "glpi_delete_document_item",
  "glpi_v2_list_documents", "glpi_v2_get_document", "glpi_v2_create_document",
  "glpi_v2_download_document",
] as const;

const USERS = [
  "glpi_get_user", "glpi_search_user_by_email", "glpi_list_users", "glpi_create_user",
  "glpi_update_user", "glpi_list_groups", "glpi_get_group",
  "glpi_v2_list_users", "glpi_v2_get_user", "glpi_v2_get_me", "glpi_v2_create_user",
  "glpi_v2_update_user", "glpi_v2_list_groups", "glpi_v2_get_group", "glpi_v2_create_group",
] as const;

const SEARCH = ["glpi_search", "glpi_count_items", "glpi_list_search_options"] as const;

/** Generic search and the option catalogue its criteria need. */
const SEARCH_READS = ["glpi_search", "glpi_list_search_options"] as const;

/** Reads that put a name on a person or a group (IDs in tickets, tasks, followups). */
const PEOPLE_READS = [
  "glpi_get_user", "glpi_search_user_by_email", "glpi_list_users", "glpi_get_group", "glpi_list_groups",
  "glpi_v2_get_user", "glpi_v2_get_me", "glpi_v2_get_group",
] as const;

/** Entity reads an agent needs to compose a ticket; also part of `admin`. */
const ENTITY_READS = [
  "glpi_list_entities", "glpi_get_entity", "glpi_get_my_entities", "glpi_get_my_profiles",
  "glpi_v2_list_entities", "glpi_v2_get_entity",
] as const;

const ADMIN = [
  ...ENTITY_READS,
  "glpi_create_entity", "glpi_update_entity", "glpi_delete_entity", "glpi_change_active_entities",
  "glpi_get_full_session",
  "glpi_list_rules", "glpi_get_rule_ticket", "glpi_list_rule_ticket_criteria",
  "glpi_list_rule_ticket_actions", "glpi_list_rule_criteria", "glpi_list_rule_actions",
  "glpi_create_rule_ticket", "glpi_create_rule_criteria", "glpi_create_rule_action",
  "glpi_update_rule_action",
  "glpi_list_itil_followup_templates", "glpi_get_itil_followup_template",
  "glpi_create_itil_followup_template", "glpi_update_itil_followup_template",
  "glpi_list_webhooks", "glpi_get_webhook", "glpi_create_webhook", "glpi_update_webhook",
  "glpi_set_webhook_active", "glpi_delete_webhook", "glpi_list_webhook_deliveries",
  "glpi_retry_webhook_delivery",
  "glpi_v2_create_entity", "glpi_v2_update_entity", "glpi_v2_delete_entity",
  "glpi_v2_list_rule_collections", "glpi_v2_list_rules", "glpi_v2_get_rule", "glpi_v2_create_rule",
  "glpi_v2_get_session", "glpi_v2_health_check",
] as const;

function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/** core = reads of the everyday presets + non-destructive ticket operations. */
const CORE = unique([
  ...[...TICKETS, ...ITIL, ...ASSETS, ...KB, ...DOCUMENTS, ...USERS, ...SEARCH, ...PEOPLE_READS, ...ENTITY_READS].filter(
    (name) => classifyTool(name) === "read",
  ),
  ...TICKETS.filter((name) => classifyTool(name) === "write"),
]);

export const TOOLSETS: Readonly<Record<string, ToolsetDefinition>> = {
  core: {
    description: "Lean default: every read tool of the everyday presets plus the non-destructive ticket operations",
    tools: CORE,
  },
  tickets: {
    description:
      "Ticket lifecycle (my tickets, followups, solutions, tasks, validations, actors, timeline) plus the search and " +
      "user/group reads it points to",
    tools: unique([...TICKETS, ...SEARCH_READS, ...PEOPLE_READS]),
  },
  itil: {
    description: "Problems and changes (plus the shared ITIL timeline and categories, and the user/group reads)",
    tools: unique([...ITIL, ...PEOPLE_READS]),
  },
  assets: { description: "Assets, reservations and locations (plus generic search)", tools: unique([...ASSETS, ...SEARCH_READS]) },
  kb: { description: "Knowledge base articles and categories", tools: unique(KB) },
  documents: { description: "Documents and their links to items", tools: unique(DOCUMENTS) },
  users: { description: "Users and groups", tools: unique(USERS) },
  search: { description: "Generic search, counts and search options", tools: unique(SEARCH) },
  admin: {
    description: "Entities, session/profile context, business rules, followup templates, webhooks",
    tools: unique(ADMIN),
  },
  v2: { description: "Every GLPI 11 API v2 tool (glpi_v2_*)", tools: [], globs: ["glpi_v2_*"] },
};

export const TOOLSET_NAMES: readonly string[] = Object.keys(TOOLSETS);

/**
 * "tickets, kb" or ["tickets","kb"] -> validated, de-duplicated names.
 * Unknown names throw, so a typo fails at startup instead of silently
 * registering nothing.
 */
export function parseToolsets(value: string | readonly string[] | undefined): string[] {
  const raw = typeof value === "string" ? value.split(",") : (value ?? []);
  const names = unique(raw.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const unknown = names.filter((n) => !Object.prototype.hasOwnProperty.call(TOOLSETS, n));
  if (unknown.length > 0) {
    throw new Error(`unknown toolset(s): ${unknown.join(", ")} (valid: ${TOOLSET_NAMES.join(", ")})`);
  }
  return names;
}

/** Predicate: does `name` belong to any of the given (validated) toolsets? */
export function toolsetMatcher(toolsets: readonly string[]): (name: string) => boolean {
  const exact = new Set<string>();
  const globs: RegExp[] = [];
  for (const t of toolsets) {
    const def = TOOLSETS[t];
    if (!def) throw new Error(`unknown toolset: ${t}`);
    def.tools.forEach((n) => exact.add(n));
    globs.push(...parseGlobList((def.globs ?? []).join(",")));
  }
  return (name) => exact.has(name) || globs.some((re) => re.test(name));
}
