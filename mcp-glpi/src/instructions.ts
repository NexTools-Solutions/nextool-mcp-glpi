/**
 * The `instructions` text sent in `initialize`, built from the tools actually
 * registered.
 *
 * Up to 3.4.0 the text was fixed and named glpi_list_my_tickets, glpi_search,
 * glpi_list_timeline... even under a preset (or a GLPI_TOOLS_EXCLUDE) that
 * left them out, sending the model after tools it did not have. Now each
 * sentence names only tools that are present, and the areas listed at the end
 * are the ones some registered tool covers.
 */

export interface InstructionFamilies {
  v1: boolean;
  v2: boolean;
}

/** "a", "a or b", "a, b or c". */
function either(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

const TICKET_WRITES = [
  "glpi_add_followup", "glpi_add_solution", "glpi_add_ticket_task", "glpi_update_ticket", "glpi_add_ticket_user",
  "glpi_add_ticket_group", "glpi_v2_add_followup", "glpi_v2_add_solution", "glpi_v2_add_task", "glpi_v2_update_ticket",
  "glpi_v2_add_team_member",
];

/** Areas named (in words, never tool names) when one of their tools is registered. */
const AREAS: [label: string, test: RegExp][] = [
  ["problems and changes", /^glpi_(v2_)?(list|get)_(problem|change)s?$/],
  ["assets and reservations", /^glpi_(list|get)_(asset|reservation)/],
  ["knowledge base", /^glpi_(v2_)?(list|get)_(knowbase|kb)_/],
  ["users and groups", /^glpi_(v2_)?(list|get)_(user|group)s?$/],
  ["entities", /^glpi_(v2_)?(list|get)_entit/],
  ["documents", /^glpi_(v2_)?(list|get)_document/],
  ["business rules", /^glpi_(v2_)?(list|get)_rule/],
  ["webhooks", /^glpi_(list|get)_webhook/],
];

/**
 * Builds the guidance text for a server whose registered tools are `tools`.
 * Every tool name in the result is one of `tools`.
 */
export function buildInstructions(tools: Iterable<string>, families: InstructionFamilies): string {
  const has = new Set(tools);
  const present = (...names: string[]) => names.filter((n) => has.has(n));
  const parts: string[] = [];

  const api =
    families.v1 && families.v2
      ? "glpi_* tools use the REST API v1, glpi_v2_* the GLPI 11 API v2."
      : families.v2
        ? "The glpi_v2_* tools use the GLPI 11 API v2."
        : "The glpi_* tools use the GLPI REST API v1.";
  parts.push(`Tools to work with a GLPI service desk (GLPI 10 and 11). ${api}`);

  const flow: string[] = [];
  if (has.has("glpi_list_my_tickets")) flow.push("for the connected user's own tickets (\"my tickets\") use glpi_list_my_tickets");
  const find = present("glpi_list_tickets", "glpi_v2_list_tickets", "glpi_search");
  if (find.length) flow.push(`find tickets with ${either(find)} (listings come most recent first)`);
  const open = present("glpi_get_ticket", "glpi_v2_get_ticket");
  if (open.length) flow.push(`open one with ${either(open)}`);
  const history = present("glpi_list_timeline", "glpi_v2_list_timeline");
  if (history.length) flow.push(`read its history with ${either(history)}`);
  if (present(...TICKET_WRITES).length) flow.push("then act: add followups, tasks or solutions, update fields, assign people");
  if (flow.length) parts.push(`Typical flow: ${flow.join("; ")}.`);

  const names = [...has];
  const areas = AREAS.filter(([, re]) => names.some((n) => re.test(n))).map(([label]) => label);
  if (areas.length) parts.push(`Also covered by the tools of this server: ${areas.join(", ")}.`);

  parts.push(
    "Every action runs with the GLPI permissions of the connected user. Tools are annotated: read-only tools never " +
      "change data; confirm with the user before any write. Deletes are disabled unless the server allows them and then " +
      "require a reason. Use IDs returned by list/search tools; do not guess them. Ask the user before changing many " +
      "records at once. Listings accept format: \"markdown\" for a compact table to show in the conversation.",
  );
  return parts.join(" ");
}
