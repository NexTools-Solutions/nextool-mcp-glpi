import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  jsonResult,
  makeWrap,
} from "@nextoolsolutions/mcp-glpi-core";
import type { GlpiConfig } from "./glpi-client.js";
import {
  ITIL_ITEM_NAMES,
  SOLUTION_NAMES,
  FOLLOWUP_NAMES,
  TASK_NAMES,
  VALIDATION_NAMES,
  addCodeName,
  addNames,
  nameFollowups,
  nameItilRows,
  nameTasks,
  nameValidations,
} from "./names.js";
import { sessionLabels } from "./labels.js";
import {
  MY_TICKET_ROLES,
  TICKET_SORT_FIELDS,
  TICKET_STATUS_FILTERS,
  listMyTickets,
  listTicketsSorted,
  nameTicket,
  nameTicketRows,
} from "./ticket-lists.js";
import { namedSearchRows } from "./search-columns.js";
import { itemIdSchema } from "./ids.js";
import {
  // Existing (Phase 0) — 48 tools
  listTickets,
  getTicket,
  createTicket,
  updateTicket,
  search,
  addFollowup,
  listFollowups,
  addSolution,
  listTicketValidations,
  createTicketValidation,
  updateTicketValidation,
  deleteTicketValidation,
  getUser,
  searchUserByEmail,
  listDocuments,
  getDocument,
  createDocument,
  deleteDocument,
  listDocumentItems,
  getDocumentItem,
  createDocumentItem,
  deleteDocumentItem,
  listKnowbaseItems,
  getKnowbaseItem,
  createKnowbaseItem,
  updateKnowbaseItem,
  deleteKnowbaseItem,
  listKnowbaseCategories,
  getKnowbaseCategory,
  createKnowbaseCategory,
  updateKnowbaseCategory,
  deleteKnowbaseCategory,
  listEntities,
  getEntity,
  createEntity,
  updateEntity,
  deleteEntity,
  getRuleTicket,
  listRuleTicketCriteria,
  listRuleTicketAction,
  listRuleCriteria,
  listRuleAction,
  updateRuleAction,
  listITILFollowupTemplates,
  getITILFollowupTemplate,
  createITILFollowupTemplate,
  updateITILFollowupTemplate,
  listChanges,
  getChange,
  createChange,
  updateChange,
  listChangeFollowups,
  listProblems,
  getProblem,
  createProblem,
  updateProblem,
  listProblemFollowups,
  // Phase 2 — Session & Context (+3)
  listSearchOptions,
  changeActiveEntities,
  getFullSession,
  // Phase 2 — Ticket Users/Groups (+6)
  listTicketUsers,
  addTicketUser,
  deleteTicketUser,
  listTicketGroups,
  addTicketGroup,
  deleteTicketGroup,
  // Phase 2 — Tasks (+4)
  listTicketTasks,
  addTicketTask,
  listChangeTasks,
  listProblemTasks,
  // Phase 2 — Categories & Groups (+4)
  listITILCategories,
  getITILCategory,
  listGroups,
  getGroup,
  // Phase 3 — Users CRUD (+3)
  listUsers,
  createUser,
  updateUser,
  // Phase 3 — Rules CRUD (+4)
  listRules,
  createRuleTicket,
  createRuleCriteria,
  createRuleAction,
  // Phase 3 — Cross-ITIL Followups/Solutions (+4)
  addChangeFollowup,
  addProblemFollowup,
  addChangeSolution,
  addProblemSolution,
  // Phase 3 — Session info (+2)
  getMyEntities,
  getMyProfiles,
  // Phase 3 — Locations (+2)
  listLocations,
  listTimeline,
  getLocation,
} from "./glpi-client.js";
import {
  ASSET_TYPES,
  DETAIL_SECTIONS,
  countItems,
  createAsset,
  createReservation,
  getAsset,
  getAssetDetails,
  getReservation,
  listAssets,
  listReservationItems,
  listReservations,
  ticketStats,
  updateAsset,
  updateReservation,
} from "./assets-client.js";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listWebhookDeliveries,
  listWebhooks,
  retryWebhookDelivery,
  setWebhookActive,
  updateWebhook,
} from "./webhooks-client.js";

/**
 * GLPI REST API v1 tools (apirest.php or api.php/v1): the `glpi_*` family.
 * Registered on a server whose write policy, payload formatting and create
 * idempotency are already installed (see index.ts).
 */
export function registerV1Tools(server: McpServer, config: GlpiConfig): void {
  // ---------------------------------------------------------------------------
  // Result helpers (shared — see @nextoolsolutions/mcp-glpi-core)
  // ---------------------------------------------------------------------------

  const wrap = makeWrap(() =>
    !config.baseUrl || !config.userToken
      ? "GLPI_URL and GLPI_USER_TOKEN must be set. Set the environment variables and restart."
      : null,
  );

  /** Applies a name resolver to a sub-item listing (anything that is not an array becomes []). */
  async function nameRows(
    result: unknown,
    namer: (c: GlpiConfig, rows: Record<string, unknown>[]) => Promise<Record<string, unknown>[]>,
  ): Promise<Record<string, unknown>[]> {
    return Array.isArray(result) ? namer(config, result as Record<string, unknown>[]) : [];
  }

  // ---------------------------------------------------------------------------
  // Shorthand schemas
  // ---------------------------------------------------------------------------

  const idSchema = itemIdSchema();
  /** Entity IDs: 0 is the root entity. */
  const entityIdSchema = itemIdSchema("Entity ID", { allowZero: true });
  const rangeSchema = z.string().optional().describe("Pagination range, e.g. 0-49");
  const expandSchema = z.boolean().optional().describe("Expand dropdown IDs to names");
  const outData = () => z.object({ data: z.unknown() });
  const outRows = () =>
    z.object({
      data: z.unknown(),
      total: z.number().optional().describe("Total matching items in GLPI (all pages)"),
    });

  /** Ticket status names accepted by the list tools ("open" = not solved nor closed). */
  const statusEnum = z.enum(TICKET_STATUS_FILTERS);
  const statusSchema = z
    .union([statusEnum, z.array(statusEnum)])
    .optional();
  const ticketSortSchema = z
    .enum(TICKET_SORT_FIELDS)
    .optional()
    .describe("Sort column (default date_mod = last update)");
  const orderSchema = z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc = most recent first)");
  /** Sort columns of changes and problems (getAllItems column names). */
  const itilSortSchema = z
    .enum(["date_mod", "date", "id", "priority", "status", "name"])
    .optional()
    .describe("Sort column (default date_mod = last update)");


  // ===========================================================================
  // TICKETS (4 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_tickets",
    {
      title: "List tickets",
      description:
        "List GLPI tickets of the whole instance (every ticket the connected user may see), most recently " +
        "updated first by default. Filter by status (e.g. status: 'open' = not solved nor closed) and choose " +
        "the sort column and direction. Each row carries status_name, type_name, priority_name (in the GLPI " +
        "user's language), category_name, and requesters and assigned technicians as {id, name}. For the " +
        "connected user's OWN tickets (\"my tickets\") use glpi_list_my_tickets instead.",
      inputSchema: z.object({
        range: rangeSchema,
        expand_dropdowns: expandSchema,
        status: statusSchema.describe(
          "Only tickets in these statuses: new, assigned (= processing), planned, pending, solved, closed, " +
            "or open (= new + assigned + planned + pending). One name or a list. Default: every status.",
        ),
        sort: ticketSortSchema,
        order: orderSchema,
      }),
      outputSchema: outRows(),
    },
    wrap(async ({ range, expand_dropdowns, status, sort, order }) => {
      const { rows, total } = await listTicketsSorted(config, { range, expand_dropdowns, status, sort, order }, (p) =>
        listTickets(config, p),
      );
      const named = await nameTicketRows(config, rows);
      return jsonResult(total === undefined ? { data: named } : { data: named, total });
    }),
  );

  server.registerTool(
    "glpi_list_my_tickets",
    {
      title: "List my tickets",
      description:
        "\"My tickets\": tickets of the connected GLPI user (or of users_id) where they are requester, " +
        "assigned technician or observer. Defaults: open tickets only (not solved nor closed), most recently " +
        "updated first. Each row names the people: requesters, assigned and observers as {id, name}, plus " +
        "status_name and my_roles. Use this for \"meus chamados\", \"my open tickets\", \"tickets assigned to me\".",
      inputSchema: z.object({
        role: z
          .enum(MY_TICKET_ROLES)
          .optional()
          .describe("Which link to the user: requester, assigned (technician), observer, or any (default)"),
        status: statusSchema.describe(
          "Statuses to include (default open = not solved nor closed): new, assigned (= processing), planned, " +
            "pending, solved, closed, open. One name or a list.",
        ),
        sort: ticketSortSchema,
        order: orderSchema,
        range: rangeSchema,
        users_id: idSchema.optional().describe("Another user's ID (default: the connected user)"),
      }),
      outputSchema: z.object({
        data: z.unknown(),
        total: z.number().optional().describe("Total matching tickets (all pages)"),
        user: z.object({ id: z.number(), name: z.string().nullable() }).optional().describe("Whose tickets these are"),
        role: z.string().optional(),
        status: z.array(z.string()).optional(),
      }),
    },
    wrap(async ({ role, status, sort, order, range, users_id }) => {
      const r = await listMyTickets(config, { role, status, sort, order, range, users_id });
      return jsonResult({ data: r.rows, total: r.total, user: r.user, role: r.role, status: r.status });
    }),
  );

  server.registerTool(
    "glpi_get_ticket",
    {
      title: "Get ticket",
      description:
        "Retrieve a single ticket by ID. IDs come with names beside them (recipient_name, category_name, " +
        "entity_name; status_name, type_name, priority_name in the GLPI user's language). Requesters, technicians and observers are not ticket " +
        "fields: list them with glpi_list_ticket_users (and groups with glpi_list_ticket_groups).",
      inputSchema: z.object({
        ticketId: idSchema,
        expand_dropdowns: expandSchema.describe(
          "Replace dropdown IDs with their names in place (loses the IDs; by default names are added beside them)",
        ),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId, expand_dropdowns }) => {
      const ticket = await getTicket(config, ticketId, { expand_dropdowns });
      if (!ticket || typeof ticket !== "object") return jsonResult({ data: {} });
      return jsonResult({ data: expand_dropdowns ? ticket : await nameTicket(config, ticket) });
    }),
  );

  server.registerTool(
    "glpi_create_ticket",
    {
      title: "Create ticket",
      description:
        "Create a new ticket. Common fields: name (title), content (description), " +
        "entities_id, users_id_requester, itilcategories_id, type (1=Incident, 2=Request), " +
        "urgency, impact, priority.",
      inputSchema: z.object({
        input: z.record(z.unknown()).describe("Ticket fields"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ input }) => jsonResult({ data: (await createTicket(config, input as Record<string, unknown>)) ?? { id: 0 } })),
  );

  server.registerTool(
    "glpi_update_ticket",
    {
      title: "Update ticket",
      description: "Update an existing ticket by ID.",
      inputSchema: z.object({
        ticketId: idSchema,
        input: z.record(z.unknown()).describe("Fields to update"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId, input }) => jsonResult({ data: (await updateTicket(config, ticketId, input as Record<string, unknown>)) ?? {} })),
  );

  // ===========================================================================
  // CHANGES (5 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_changes",
    {
      title: "List changes",
      description:
        "List change management items, most recently updated first by default, with status_name and " +
        "priority_name (in the GLPI user's language) and category_name.",
      inputSchema: z.object({ range: rangeSchema, expand_dropdowns: expandSchema, sort: itilSortSchema, order: orderSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range, expand_dropdowns, sort, order }) => {
      const result = await listChanges(config, {
        range,
        expand_dropdowns,
        sort: sort ?? "date_mod",
        order: order === "asc" ? "ASC" : "DESC",
      });
      const rows = Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
      return jsonResult({ data: await nameItilRows(config, rows, "Change") });
    }),
  );

  server.registerTool(
    "glpi_get_change",
    {
      title: "Get change",
      description: "Retrieve a change by ID, with names beside the IDs and status/priority labels in the GLPI user's language.",
      inputSchema: z.object({ changeId: idSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ changeId, expand_dropdowns }) => {
      const item = await getChange(config, changeId, { expand_dropdowns });
      if (!item || typeof item !== "object") return jsonResult({ data: {} });
      if (expand_dropdowns) return jsonResult({ data: item });
      const [named] = await nameItilRows(config, [item as Record<string, unknown>], "Change", ITIL_ITEM_NAMES);
      return jsonResult({ data: named });
    }),
  );

  server.registerTool(
    "glpi_create_change",
    {
      title: "Create change",
      description: "Create a new change. Common fields: name, content, entities_id, users_id_requester.",
      inputSchema: z.object({ input: z.record(z.unknown()).describe("Change fields") }),
      outputSchema: outData(),
    },
    wrap(async ({ input }) => jsonResult({ data: (await createChange(config, input as Record<string, unknown>)) ?? { id: 0 } })),
  );

  server.registerTool(
    "glpi_update_change",
    {
      title: "Update change",
      description: "Update an existing change by ID.",
      inputSchema: z.object({ changeId: idSchema, input: z.record(z.unknown()).describe("Fields to update") }),
      outputSchema: outData(),
    },
    wrap(async ({ changeId, input }) => jsonResult({ data: (await updateChange(config, changeId, input as Record<string, unknown>)) ?? {} })),
  );

  server.registerTool(
    "glpi_list_change_followups",
    {
      title: "List change followups",
      description: "List followups (comments) of a change, with the author's name (user_name).",
      inputSchema: z.object({ changeId: idSchema, range: rangeSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ changeId, range, expand_dropdowns }) =>
      jsonResult({ data: await nameRows(await listChangeFollowups(config, changeId, { range, expand_dropdowns }), nameFollowups) }),
    ),
  );

  // ===========================================================================
  // PROBLEMS (5 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_problems",
    {
      title: "List problems",
      description:
        "List problem management items, most recently updated first by default, with status_name and " +
        "priority_name (in the GLPI user's language) and category_name.",
      inputSchema: z.object({ range: rangeSchema, expand_dropdowns: expandSchema, sort: itilSortSchema, order: orderSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range, expand_dropdowns, sort, order }) => {
      const result = await listProblems(config, {
        range,
        expand_dropdowns,
        sort: sort ?? "date_mod",
        order: order === "asc" ? "ASC" : "DESC",
      });
      const rows = Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
      return jsonResult({ data: await nameItilRows(config, rows, "Problem") });
    }),
  );

  server.registerTool(
    "glpi_get_problem",
    {
      title: "Get problem",
      description: "Retrieve a problem by ID, with names beside the IDs and status/priority labels in the GLPI user's language.",
      inputSchema: z.object({ problemId: idSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ problemId, expand_dropdowns }) => {
      const item = await getProblem(config, problemId, { expand_dropdowns });
      if (!item || typeof item !== "object") return jsonResult({ data: {} });
      if (expand_dropdowns) return jsonResult({ data: item });
      const [named] = await nameItilRows(config, [item as Record<string, unknown>], "Problem", ITIL_ITEM_NAMES);
      return jsonResult({ data: named });
    }),
  );

  server.registerTool(
    "glpi_create_problem",
    {
      title: "Create problem",
      description: "Create a new problem. Common fields: name, content, entities_id, users_id_requester.",
      inputSchema: z.object({ input: z.record(z.unknown()).describe("Problem fields") }),
      outputSchema: outData(),
    },
    wrap(async ({ input }) => jsonResult({ data: (await createProblem(config, input as Record<string, unknown>)) ?? { id: 0 } })),
  );

  server.registerTool(
    "glpi_update_problem",
    {
      title: "Update problem",
      description: "Update an existing problem by ID.",
      inputSchema: z.object({ problemId: idSchema, input: z.record(z.unknown()).describe("Fields to update") }),
      outputSchema: outData(),
    },
    wrap(async ({ problemId, input }) => jsonResult({ data: (await updateProblem(config, problemId, input as Record<string, unknown>)) ?? {} })),
  );

  server.registerTool(
    "glpi_list_problem_followups",
    {
      title: "List problem followups",
      description: "List followups (comments) of a problem, with the author's name (user_name).",
      inputSchema: z.object({ problemId: idSchema, range: rangeSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ problemId, range, expand_dropdowns }) =>
      jsonResult({ data: await nameRows(await listProblemFollowups(config, problemId, { range, expand_dropdowns }), nameFollowups) }),
    ),
  );

  // ===========================================================================
  // SEARCH (1 tool)
  // ===========================================================================

  server.registerTool(
    "glpi_search",
    {
      title: "Search items",
      description:
        "Search GLPI items with criteria. itemtype: Ticket, User, Change, Problem, Computer, etc. " +
        "Each criterion is {field, searchtype, value, link}: field = search option ID, searchtype = " +
        "contains | equals | notequals | lessthan | morethan | under, link = AND | OR (omit on the first). " +
        "Rows come keyed by the search option names in the GLPI user's language ('Título', 'ID', 'Status'...); " +
        "named_columns=false keys them by option ID ('1', '2'...) instead. Use glpi_list_search_options to " +
        "discover the option IDs for criteria, forcedisplay and sort.",
      inputSchema: z.object({
        itemtype: z.string().describe("Item type, e.g. Ticket, User, Change, Problem"),
        range: rangeSchema,
        criteria: z
          .array(z.record(z.unknown()))
          .optional()
          .describe(
            "Array of {field, searchtype, value, link}; a group is {link, criteria: [...]} (e.g. requester OR technician)",
          ),
        forcedisplay: z.array(z.number()).optional().describe("Search option IDs to add as columns"),
        sort: z.number().int().optional().describe("Search option ID to sort by (e.g. 19 = last update on Ticket)"),
        order: z.enum(["asc", "desc"]).optional().describe("Sort direction (default asc)"),
        named_columns: z
          .boolean()
          .optional()
          .describe("Key each row by search option name (default true); false = by numeric option ID"),
      }),
      outputSchema: outRows(),
    },
    wrap(async (params) => {
      const res = await search(config, params.itemtype, {
        range: params.range,
        criteria: params.criteria as Record<string, unknown>[] | undefined,
        forcedisplay: params.forcedisplay,
        sort: params.sort,
        order: params.order === "desc" ? "DESC" : params.order === "asc" ? "ASC" : undefined,
      });
      const rows = Array.isArray(res?.data) ? res.data : [];
      const total = typeof res?.totalcount === "number" ? res.totalcount : rows.length;
      const data = params.named_columns === false ? rows : await namedSearchRows(config, params.itemtype, rows);
      return jsonResult({ data, total });
    }),
  );

  // ===========================================================================
  // FOLLOWUPS (2 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_add_followup",
    {
      title: "Add followup to ticket",
      description: "Add a comment/followup to a ticket.",
      inputSchema: z.object({
        ticketId: idSchema,
        content: z.string().describe("Followup text content"),
        is_private: z.number().optional().describe("1 for private, 0 for public (default: 0)"),
        users_id: z.number().int().positive().optional().describe("Author user ID (default: session user)"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId, content, is_private, users_id }) =>
      jsonResult({ data: await addFollowup(config, { itemtype: "Ticket", items_id: ticketId, content, is_private, users_id }) }),
    ),
  );

  server.registerTool(
    "glpi_list_followups",
    {
      title: "List ticket followups",
      description: "List followups (comments) of a ticket, oldest first, with the author's name (user_name).",
      inputSchema: z.object({ ticketId: idSchema, range: rangeSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId, range }) =>
      jsonResult({ data: await nameRows(await listFollowups(config, ticketId, { range }), nameFollowups) }),
    ),
  );

  // ===========================================================================
  // SOLUTION (1 tool)
  // ===========================================================================

  server.registerTool(
    "glpi_add_solution",
    {
      title: "Add solution to ticket",
      description: "Add a solution to a ticket (status changes to Solved).",
      inputSchema: z.object({
        ticketId: idSchema,
        content: z.string().describe("Solution text content"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId, content }) =>
      jsonResult({ data: await addSolution(config, { itemtype: "Ticket", items_id: ticketId, content }) }),
    ),
  );

  // ===========================================================================
  // TICKET VALIDATIONS (4 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_ticket_validations",
    {
      title: "List ticket validations",
      description:
        "List approval/validation requests for a ticket, with requester and approver names " +
        "(user_name, validator_name) and status_name in the GLPI user's language (status: 1 = not subject to " +
        "approval, 2 = waiting, 3 = granted, 4 = refused).",
      inputSchema: z.object({ ticketId: idSchema, range: rangeSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId, range }) =>
      jsonResult({ data: await nameRows(await listTicketValidations(config, ticketId, { range }), nameValidations) }),
    ),
  );

  server.registerTool(
    "glpi_create_ticket_validation",
    {
      title: "Create ticket validation",
      description: "Create an approval request assigning a validator (users_id_validate).",
      inputSchema: z.object({
        ticketId: idSchema,
        users_id_validate: idSchema.describe("Approver user ID"),
        comment_submission: z.string().optional().describe("Comment for the approval request"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId, users_id_validate, comment_submission }) =>
      jsonResult({ data: await createTicketValidation(config, { tickets_id: ticketId, users_id_validate, comment_submission }) }),
    ),
  );

  server.registerTool(
    "glpi_update_ticket_validation",
    {
      title: "Update ticket validation",
      description: "Approve/refuse a validation (status: accepted/refused) or change the approver.",
      inputSchema: z.object({
        validationId: idSchema,
        input: z.record(z.unknown()).describe("e.g. {status: 'accepted'} or {users_id_validate: 2}"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ validationId, input }) =>
      jsonResult({ data: await updateTicketValidation(config, validationId, input as Record<string, unknown>) }),
    ),
  );

  server.registerTool(
    "glpi_delete_ticket_validation",
    {
      title: "Delete ticket validation",
      description: "Remove a validation request by ID.",
      inputSchema: z.object({ validationId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ validationId }) => jsonResult({ data: await deleteTicketValidation(config, validationId) })),
  );

  // ===========================================================================
  // USERS (4 tools — existing + Phase 3)
  // ===========================================================================

  server.registerTool(
    "glpi_get_user",
    {
      title: "Get user",
      description: "Retrieve a user by ID.",
      inputSchema: z.object({ userId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ userId }) => jsonResult({ data: (await getUser(config, userId)) ?? {} })),
  );

  server.registerTool(
    "glpi_search_user_by_email",
    {
      title: "Search user by email",
      description: "Find users by exact email address (returns the user items: id, login, real name, first name...).",
      inputSchema: z.object({ email: z.string().describe("Email address"), range: rangeSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ email, range }) => jsonResult({ data: (await searchUserByEmail(config, email, { range })) ?? [] })),
  );

  server.registerTool(
    "glpi_list_users",
    {
      title: "List users",
      description: "List all users with optional pagination and dropdown expansion.",
      inputSchema: z.object({ range: rangeSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range, expand_dropdowns }) => {
      const result = await listUsers(config, { range, expand_dropdowns });
      return jsonResult({ data: Array.isArray(result) ? result : [] });
    }),
  );

  server.registerTool(
    "glpi_create_user",
    {
      title: "Create user",
      description: "Create a new GLPI user. Required: name (login). Common: realname, firstname, password, email (via _useremails array).",
      inputSchema: z.object({ input: z.record(z.unknown()).describe("User fields") }),
      outputSchema: outData(),
    },
    wrap(async ({ input }) => jsonResult({ data: (await createUser(config, input as Record<string, unknown>)) ?? { id: 0 } })),
  );

  server.registerTool(
    "glpi_update_user",
    {
      title: "Update user",
      description: "Update an existing user by ID.",
      inputSchema: z.object({ userId: idSchema, input: z.record(z.unknown()).describe("Fields to update") }),
      outputSchema: outData(),
    },
    wrap(async ({ userId, input }) => jsonResult({ data: (await updateUser(config, userId, input as Record<string, unknown>)) ?? {} })),
  );

  // ===========================================================================
  // DOCUMENTS (4 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_documents",
    {
      title: "List documents",
      description: "List documents with optional pagination.",
      inputSchema: z.object({ range: rangeSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range }) => jsonResult({ data: (await listDocuments(config, { range })) ?? [] })),
  );

  server.registerTool(
    "glpi_get_document",
    {
      title: "Get document",
      description: "Retrieve a document by ID.",
      inputSchema: z.object({ documentId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ documentId }) => jsonResult({ data: (await getDocument(config, documentId)) ?? {} })),
  );

  server.registerTool(
    "glpi_create_document",
    {
      title: "Create document",
      description: "Create a document (metadata). Fields: name, entities_id, comment, etc.",
      inputSchema: z.object({ input: z.record(z.unknown()).describe("Document fields") }),
      outputSchema: outData(),
    },
    wrap(async ({ input }) => jsonResult({ data: await createDocument(config, input as Record<string, unknown>) })),
  );

  server.registerTool(
    "glpi_delete_document",
    {
      title: "Delete document",
      description: "Permanently delete a document by ID.",
      inputSchema: z.object({ documentId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ documentId }) => jsonResult({ data: await deleteDocument(config, documentId) })),
  );

  // ===========================================================================
  // DOCUMENT_ITEM (4 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_document_items",
    {
      title: "List document-item links",
      description: "List links between documents and other items.",
      inputSchema: z.object({ range: rangeSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range }) => jsonResult({ data: (await listDocumentItems(config, { range })) ?? [] })),
  );

  server.registerTool(
    "glpi_get_document_item",
    {
      title: "Get document-item link",
      description: "Retrieve a Document_Item link by ID.",
      inputSchema: z.object({ documentItemId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ documentItemId }) => jsonResult({ data: (await getDocumentItem(config, documentItemId)) ?? {} })),
  );

  server.registerTool(
    "glpi_create_document_item",
    {
      title: "Link document to item",
      description: "Create a link between a document and an item (Ticket, KnowbaseItem, etc.).",
      inputSchema: z.object({
        documents_id: idSchema.describe("Document ID"),
        itemtype: z.string().describe("Target item type, e.g. Ticket, KnowbaseItem"),
        items_id: idSchema.describe("Target item ID"),
      }),
      outputSchema: outData(),
    },
    wrap(async (params) =>
      jsonResult({ data: await createDocumentItem(config, { documents_id: params.documents_id, itemtype: params.itemtype, items_id: params.items_id }) }),
    ),
  );

  server.registerTool(
    "glpi_delete_document_item",
    {
      title: "Delete document-item link",
      description: "Remove a Document_Item link by ID.",
      inputSchema: z.object({ documentItemId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ documentItemId }) => jsonResult({ data: await deleteDocumentItem(config, documentItemId) })),
  );

  // ===========================================================================
  // KNOWLEDGE BASE (5 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_knowbase_items",
    {
      title: "List knowledge base items",
      description: "List knowledge base articles with optional pagination.",
      inputSchema: z.object({ range: rangeSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range }) => jsonResult({ data: (await listKnowbaseItems(config, { range })) ?? [] })),
  );

  server.registerTool(
    "glpi_get_knowbase_item",
    {
      title: "Get knowledge base item",
      description: "Retrieve a knowledge base article by ID.",
      inputSchema: z.object({ knowbaseId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ knowbaseId }) => jsonResult({ data: (await getKnowbaseItem(config, knowbaseId)) ?? {} })),
  );

  server.registerTool(
    "glpi_create_knowbase_item",
    {
      title: "Create knowledge base item",
      description: "Create a new knowledge base article. Fields: name, answer (HTML content), knowbaseitemcategories_id, etc.",
      inputSchema: z.object({ input: z.record(z.unknown()).describe("Knowledge base item fields") }),
      outputSchema: outData(),
    },
    wrap(async ({ input }) => jsonResult({ data: await createKnowbaseItem(config, input as Record<string, unknown>) })),
  );

  server.registerTool(
    "glpi_update_knowbase_item",
    {
      title: "Update knowledge base item",
      description: "Update a knowledge base article by ID.",
      inputSchema: z.object({ knowbaseId: idSchema, input: z.record(z.unknown()).describe("Fields to update") }),
      outputSchema: outData(),
    },
    wrap(async ({ knowbaseId, input }) => jsonResult({ data: await updateKnowbaseItem(config, knowbaseId, input as Record<string, unknown>) })),
  );

  server.registerTool(
    "glpi_delete_knowbase_item",
    {
      title: "Delete knowledge base item",
      description: "Permanently delete a knowledge base article.",
      inputSchema: z.object({ knowbaseId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ knowbaseId }) => jsonResult({ data: await deleteKnowbaseItem(config, knowbaseId) })),
  );

  // ===========================================================================
  // KNOWLEDGE BASE CATEGORIES (5 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_knowbase_categories",
    {
      title: "List knowledge base categories",
      description: "List knowledge base categories with optional pagination.",
      inputSchema: z.object({ range: rangeSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range }) => jsonResult({ data: (await listKnowbaseCategories(config, { range })) ?? [] })),
  );

  server.registerTool(
    "glpi_get_knowbase_category",
    {
      title: "Get knowledge base category",
      description: "Retrieve a knowledge base category by ID.",
      inputSchema: z.object({ categoryId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ categoryId }) => jsonResult({ data: (await getKnowbaseCategory(config, categoryId)) ?? {} })),
  );

  server.registerTool(
    "glpi_create_knowbase_category",
    {
      title: "Create knowledge base category",
      description: "Create a new knowledge base category.",
      inputSchema: z.object({ input: z.record(z.unknown()).describe("Category fields (name, knowbaseitemcategories_id for parent, comment)") }),
      outputSchema: outData(),
    },
    wrap(async ({ input }) => jsonResult({ data: await createKnowbaseCategory(config, input as Record<string, unknown>) })),
  );

  server.registerTool(
    "glpi_update_knowbase_category",
    {
      title: "Update knowledge base category",
      description: "Update a knowledge base category by ID.",
      inputSchema: z.object({ categoryId: idSchema, input: z.record(z.unknown()).describe("Fields to update") }),
      outputSchema: outData(),
    },
    wrap(async ({ categoryId, input }) => jsonResult({ data: await updateKnowbaseCategory(config, categoryId, input as Record<string, unknown>) })),
  );

  server.registerTool(
    "glpi_delete_knowbase_category",
    {
      title: "Delete knowledge base category",
      description: "Permanently delete a knowledge base category.",
      inputSchema: z.object({ categoryId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ categoryId }) => jsonResult({ data: await deleteKnowbaseCategory(config, categoryId) })),
  );

  // ===========================================================================
  // ENTITIES (5 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_entities",
    {
      title: "List entities",
      description: "List GLPI entities (organizational units) with optional pagination.",
      inputSchema: z.object({ range: rangeSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range, expand_dropdowns }) => {
      const result = await listEntities(config, { range, expand_dropdowns });
      return jsonResult({ data: Array.isArray(result) ? result : [] });
    }),
  );

  server.registerTool(
    "glpi_get_entity",
    {
      title: "Get entity",
      description: "Retrieve an entity by ID.",
      inputSchema: z.object({ entityId: entityIdSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ entityId }) => jsonResult({ data: (await getEntity(config, entityId)) ?? {} })),
  );

  server.registerTool(
    "glpi_create_entity",
    {
      title: "Create entity",
      description: "Create a new entity. Fields: name (required), entities_id (parent, 0=Root), comment, address, etc.",
      inputSchema: z.object({ input: z.record(z.unknown()).describe("Entity fields") }),
      outputSchema: outData(),
    },
    wrap(async ({ input }) => jsonResult({ data: await createEntity(config, input as Record<string, unknown>) })),
  );

  server.registerTool(
    "glpi_update_entity",
    {
      title: "Update entity",
      description: "Update an existing entity by ID.",
      inputSchema: z.object({ entityId: entityIdSchema, input: z.record(z.unknown()).describe("Fields to update") }),
      outputSchema: outData(),
    },
    wrap(async ({ entityId, input }) => jsonResult({ data: await updateEntity(config, entityId, input as Record<string, unknown>) })),
  );

  server.registerTool(
    "glpi_delete_entity",
    {
      title: "Delete entity",
      description: "Permanently delete an entity by ID. WARNING: irreversible action.",
      inputSchema: z.object({ entityId: entityIdSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ entityId }) => jsonResult({ data: await deleteEntity(config, entityId) })),
  );

  // ===========================================================================
  // RULES (6 tools — existing + Phase 3)
  // ===========================================================================

  server.registerTool(
    "glpi_get_rule_ticket",
    {
      title: "Get ticket rule",
      description: "Retrieve a ticket business rule (RuleTicket) by ID.",
      inputSchema: z.object({ ruleId: idSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ ruleId, expand_dropdowns }) => jsonResult({ data: (await getRuleTicket(config, ruleId, { expand_dropdowns })) ?? {} })),
  );

  server.registerTool(
    "glpi_list_rule_ticket_criteria",
    {
      title: "List ticket rule criteria",
      description: "List criteria (conditions) of a specific ticket rule (sub-items of RuleTicket).",
      inputSchema: z.object({ ruleId: idSchema, range: rangeSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ ruleId, range, expand_dropdowns }) =>
      jsonResult({ data: (await listRuleTicketCriteria(config, ruleId, { range, expand_dropdowns })) ?? [] }),
    ),
  );

  server.registerTool(
    "glpi_list_rule_ticket_actions",
    {
      title: "List ticket rule actions",
      description: "List actions of a specific ticket rule (sub-items of RuleTicket).",
      inputSchema: z.object({ ruleId: idSchema, range: rangeSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ ruleId, range, expand_dropdowns }) =>
      jsonResult({ data: (await listRuleTicketAction(config, ruleId, { range, expand_dropdowns })) ?? [] }),
    ),
  );

  server.registerTool(
    "glpi_list_rule_criteria",
    {
      title: "List rule criteria (global)",
      description:
        "List rule criteria via GET /RuleCriteria. Optionally filter by rules_id " +
        "(works for any rule type: RuleTicket, RuleChange, RuleMailCollector).",
      inputSchema: z.object({
        rules_id: idSchema.optional().describe("Rule ID to filter by"),
        range: rangeSchema,
        expand_dropdowns: expandSchema,
      }),
      outputSchema: outData(),
    },
    wrap(async ({ rules_id, range, expand_dropdowns }) => {
      const result = await listRuleCriteria(config, { range, expand_dropdowns, rules_id });
      return jsonResult({ data: Array.isArray(result) ? result : [] });
    }),
  );

  server.registerTool(
    "glpi_list_rule_actions",
    {
      title: "List rule actions (global)",
      description:
        "List rule actions via GET /RuleAction. Optionally filter by rules_id " +
        "(works for any rule type: RuleTicket, RuleChange, RuleMailCollector).",
      inputSchema: z.object({
        rules_id: idSchema.optional().describe("Rule ID to filter by"),
        range: rangeSchema,
        expand_dropdowns: expandSchema,
      }),
      outputSchema: outData(),
    },
    wrap(async ({ rules_id, range, expand_dropdowns }) => {
      const result = await listRuleAction(config, { range, expand_dropdowns, rules_id });
      return jsonResult({ data: Array.isArray(result) ? result : [] });
    }),
  );

  server.registerTool(
    "glpi_update_rule_action",
    {
      title: "Update rule action",
      description: "Update a rule action by ID. Fields: action_type, field, value.",
      inputSchema: z.object({
        actionId: idSchema,
        input: z.record(z.unknown()).describe("Fields to update (action_type, field, value)"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ actionId, input }) => jsonResult({ data: await updateRuleAction(config, actionId, input as Record<string, unknown>) })),
  );

  server.registerTool(
    "glpi_list_rules",
    {
      title: "List ticket rules",
      description: "List all ticket business rules (RuleTicket) with optional pagination.",
      inputSchema: z.object({ range: rangeSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range, expand_dropdowns }) => {
      const result = await listRules(config, { range, expand_dropdowns });
      return jsonResult({ data: Array.isArray(result) ? result : [] });
    }),
  );

  server.registerTool(
    "glpi_create_rule_ticket",
    {
      title: "Create ticket rule",
      description: "Create a new ticket business rule. Fields: name, match (AND/OR), is_active, sub_type, ranking, etc.",
      inputSchema: z.object({ input: z.record(z.unknown()).describe("Rule fields") }),
      outputSchema: outData(),
    },
    wrap(async ({ input }) => jsonResult({ data: (await createRuleTicket(config, input as Record<string, unknown>)) ?? { id: 0 } })),
  );

  server.registerTool(
    "glpi_create_rule_criteria",
    {
      title: "Create rule criteria",
      description: "Create a new criteria for a rule. Fields: rules_id, criteria (field name), condition, pattern.",
      inputSchema: z.object({ input: z.record(z.unknown()).describe("Criteria fields (rules_id, criteria, condition, pattern)") }),
      outputSchema: outData(),
    },
    wrap(async ({ input }) => jsonResult({ data: (await createRuleCriteria(config, input as Record<string, unknown>)) ?? { id: 0 } })),
  );

  server.registerTool(
    "glpi_create_rule_action",
    {
      title: "Create rule action",
      description: "Create a new action for a rule. Fields: rules_id, action_type (assign/regex_result/append_regex_result), field, value.",
      inputSchema: z.object({ input: z.record(z.unknown()).describe("Action fields (rules_id, action_type, field, value)") }),
      outputSchema: outData(),
    },
    wrap(async ({ input }) => jsonResult({ data: (await createRuleAction(config, input as Record<string, unknown>)) ?? { id: 0 } })),
  );

  // ===========================================================================
  // ITIL FOLLOWUP TEMPLATES (4 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_itil_followup_templates",
    {
      title: "List followup templates",
      description: "List ITIL followup templates (predefined followup texts).",
      inputSchema: z.object({ range: rangeSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range, expand_dropdowns }) => {
      const result = await listITILFollowupTemplates(config, { range, expand_dropdowns });
      return jsonResult({ data: Array.isArray(result) ? result : [] });
    }),
  );

  server.registerTool(
    "glpi_get_itil_followup_template",
    {
      title: "Get followup template",
      description: "Retrieve a followup template by ID.",
      inputSchema: z.object({ templateId: idSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ templateId, expand_dropdowns }) =>
      jsonResult({ data: (await getITILFollowupTemplate(config, templateId, { expand_dropdowns })) ?? {} }),
    ),
  );

  server.registerTool(
    "glpi_create_itil_followup_template",
    {
      title: "Create followup template",
      description: "Create a new followup template. Fields: name, content, comment, itemtype (Ticket/Change/Problem).",
      inputSchema: z.object({ input: z.record(z.unknown()).describe("Template fields") }),
      outputSchema: outData(),
    },
    wrap(async ({ input }) => jsonResult({ data: await createITILFollowupTemplate(config, input as Record<string, unknown>) })),
  );

  server.registerTool(
    "glpi_update_itil_followup_template",
    {
      title: "Update followup template",
      description: "Update a followup template by ID.",
      inputSchema: z.object({ templateId: idSchema, input: z.record(z.unknown()).describe("Fields to update") }),
      outputSchema: outData(),
    },
    wrap(async ({ templateId, input }) =>
      jsonResult({ data: await updateITILFollowupTemplate(config, templateId, input as Record<string, unknown>) }),
    ),
  );

  // ===========================================================================
  // PHASE 2 — Session & Context (3 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_search_options",
    {
      title: "List search options",
      description:
        "List available search fields for an itemtype. Critical for building search criteria " +
        "with glpi_search. Returns field IDs, names, and types.",
      inputSchema: z.object({
        itemtype: z.string().describe("Item type, e.g. Ticket, User, Change, Problem, ITILCategory"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ itemtype }) => jsonResult({ data: (await listSearchOptions(config, itemtype)) ?? {} })),
  );

  server.registerTool(
    "glpi_change_active_entities",
    {
      title: "Change active entity",
      description:
        "Change the active entity for the current session. Essential for multi-entity GLPI instances. " +
        "Use is_recursive=true to include sub-entities.",
      inputSchema: z.object({
        entityId: entityIdSchema.describe("Entity ID to switch to"),
        is_recursive: z.boolean().optional().describe("Include sub-entities (default: false)"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ entityId, is_recursive }) =>
      jsonResult({ data: (await changeActiveEntities(config, entityId, is_recursive)) ?? { ok: true } }),
    ),
  );

  server.registerTool(
    "glpi_get_full_session",
    {
      title: "Get full session info",
      description:
        "Get the full session info including active entity, profile, and user details. " +
        "Useful for debugging and verifying the current session context.",
      inputSchema: z.object({}),
      outputSchema: outData(),
    },
    wrap(async () => jsonResult({ data: (await getFullSession(config)) ?? {} })),
  );

  // ===========================================================================
  // PHASE 2 — Ticket Users (3 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_ticket_users",
    {
      title: "List ticket users",
      description:
        "List all users linked to a ticket (requesters, observers, assigned), with each person's name " +
        "(user_name) beside users_id and type_name (in the GLPI user's language). type: 1=Requester, 2=Assigned, 3=Observer.",
      inputSchema: z.object({ ticketId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId }) => {
      const result = await listTicketUsers(config, ticketId);
      const rows = Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
      const [named, labels] = await Promise.all([
        addNames(config, rows, [{ field: "users_id", itemtype: "User", as: "user_name" }]),
        sessionLabels(config),
      ]);
      return jsonResult({ data: addCodeName(named, "type", "type_name", labels.actor_type) });
    }),
  );

  server.registerTool(
    "glpi_add_ticket_user",
    {
      title: "Add user to ticket",
      description:
        "Add a user to a ticket as requester, observer, or assigned. " +
        "type: 1=Requester, 2=Assigned, 3=Observer.",
      inputSchema: z.object({
        tickets_id: idSchema.describe("Ticket ID"),
        users_id: idSchema.describe("User ID"),
        type: z.number().min(1).max(3).describe("1=Requester, 2=Assigned, 3=Observer"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ tickets_id, users_id, type }) =>
      jsonResult({ data: await addTicketUser(config, { tickets_id, users_id, type }) }),
    ),
  );

  server.registerTool(
    "glpi_delete_ticket_user",
    {
      title: "Remove user from ticket",
      description: "Remove a user-ticket link by Ticket_User ID (get the ID from glpi_list_ticket_users).",
      inputSchema: z.object({ ticketUserId: idSchema.describe("Ticket_User link ID") }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketUserId }) => jsonResult({ data: await deleteTicketUser(config, ticketUserId) })),
  );

  // ===========================================================================
  // PHASE 2 — Ticket Groups (3 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_ticket_groups",
    {
      title: "List ticket groups",
      description:
        "List all groups linked to a ticket (requester, observer, assigned), with each group's name " +
        "(group_name) beside groups_id and type_name (in the GLPI user's language). type: 1=Requester, 2=Assigned, 3=Observer.",
      inputSchema: z.object({ ticketId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId }) => {
      const result = await listTicketGroups(config, ticketId);
      const rows = Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
      const [named, labels] = await Promise.all([
        addNames(config, rows, [{ field: "groups_id", itemtype: "Group", as: "group_name" }]),
        sessionLabels(config),
      ]);
      return jsonResult({ data: addCodeName(named, "type", "type_name", labels.actor_type) });
    }),
  );

  server.registerTool(
    "glpi_add_ticket_group",
    {
      title: "Add group to ticket",
      description:
        "Add a group to a ticket as requester, observer, or assigned. " +
        "type: 1=Requester, 2=Assigned, 3=Observer.",
      inputSchema: z.object({
        tickets_id: idSchema.describe("Ticket ID"),
        groups_id: idSchema.describe("Group ID"),
        type: z.number().min(1).max(3).describe("1=Requester, 2=Assigned, 3=Observer"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ tickets_id, groups_id, type }) =>
      jsonResult({ data: await addTicketGroup(config, { tickets_id, groups_id, type }) }),
    ),
  );

  server.registerTool(
    "glpi_delete_ticket_group",
    {
      title: "Remove group from ticket",
      description: "Remove a group-ticket link by Group_Ticket ID (get the ID from glpi_list_ticket_groups).",
      inputSchema: z.object({ groupTicketId: idSchema.describe("Group_Ticket link ID") }),
      outputSchema: outData(),
    },
    wrap(async ({ groupTicketId }) => jsonResult({ data: await deleteTicketGroup(config, groupTicketId) })),
  );

  // ===========================================================================
  // PHASE 2 — ITIL Tasks (4 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_ticket_tasks",
    {
      title: "List ticket tasks",
      description: "List tasks (to-do items) for a ticket, with author, technician and group names (user_name, tech_name, tech_group_name).",
      inputSchema: z.object({ ticketId: idSchema, range: rangeSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ ticketId, range }) =>
      jsonResult({ data: await nameRows(await listTicketTasks(config, ticketId, { range }), nameTasks) }),
    ),
  );

  server.registerTool(
    "glpi_add_ticket_task",
    {
      title: "Add task to ticket",
      description:
        "Add a task to a ticket. Fields: tickets_id, content (required). " +
        "Optional: is_private (0/1), state (0=Info, 1=To do, 2=Done), " +
        "actiontime (seconds), users_id_tech (assigned technician).",
      inputSchema: z.object({
        tickets_id: idSchema.describe("Ticket ID"),
        content: z.string().describe("Task content"),
        is_private: z.number().optional().describe("1=private, 0=public"),
        state: z.number().optional().describe("0=Info, 1=To do, 2=Done"),
        actiontime: z.number().optional().describe("Duration in seconds"),
        users_id_tech: z.number().int().positive().optional().describe("Assigned technician user ID"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ tickets_id, content, is_private, state, actiontime, users_id_tech }) =>
      jsonResult({ data: await addTicketTask(config, { tickets_id, content, is_private, state, actiontime, users_id_tech }) }),
    ),
  );

  server.registerTool(
    "glpi_list_change_tasks",
    {
      title: "List change tasks",
      description: "List tasks for a change, with author, technician and group names.",
      inputSchema: z.object({ changeId: idSchema, range: rangeSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ changeId, range }) =>
      jsonResult({ data: await nameRows(await listChangeTasks(config, changeId, { range }), nameTasks) }),
    ),
  );

  server.registerTool(
    "glpi_list_problem_tasks",
    {
      title: "List problem tasks",
      description: "List tasks for a problem, with author, technician and group names.",
      inputSchema: z.object({ problemId: idSchema, range: rangeSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ problemId, range }) =>
      jsonResult({ data: await nameRows(await listProblemTasks(config, problemId, { range }), nameTasks) }),
    ),
  );

  // ===========================================================================
  // PHASE 2 — ITIL Categories (2 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_itil_categories",
    {
      title: "List ITIL categories",
      description: "List ITIL categories (ticket/change/problem classification).",
      inputSchema: z.object({ range: rangeSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range, expand_dropdowns }) => {
      const result = await listITILCategories(config, { range, expand_dropdowns });
      return jsonResult({ data: Array.isArray(result) ? result : [] });
    }),
  );

  server.registerTool(
    "glpi_get_itil_category",
    {
      title: "Get ITIL category",
      description: "Retrieve an ITIL category by ID.",
      inputSchema: z.object({ categoryId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ categoryId }) => jsonResult({ data: (await getITILCategory(config, categoryId)) ?? {} })),
  );

  // ===========================================================================
  // PHASE 2 — Groups (2 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_groups",
    {
      title: "List groups",
      description: "List GLPI groups with optional pagination.",
      inputSchema: z.object({ range: rangeSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range, expand_dropdowns }) => {
      const result = await listGroups(config, { range, expand_dropdowns });
      return jsonResult({ data: Array.isArray(result) ? result : [] });
    }),
  );

  server.registerTool(
    "glpi_get_group",
    {
      title: "Get group",
      description: "Retrieve a group by ID.",
      inputSchema: z.object({ groupId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ groupId }) => jsonResult({ data: (await getGroup(config, groupId)) ?? {} })),
  );

  // ===========================================================================
  // PHASE 3 — Cross-ITIL Followups (2 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_add_change_followup",
    {
      title: "Add followup to change",
      description: "Add a comment/followup to a change.",
      inputSchema: z.object({
        changeId: idSchema.describe("Change ID"),
        content: z.string().describe("Followup text content"),
        is_private: z.number().optional().describe("1=private, 0=public"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ changeId, content, is_private }) =>
      jsonResult({ data: await addChangeFollowup(config, { items_id: changeId, content, is_private }) }),
    ),
  );

  server.registerTool(
    "glpi_add_problem_followup",
    {
      title: "Add followup to problem",
      description: "Add a comment/followup to a problem.",
      inputSchema: z.object({
        problemId: idSchema.describe("Problem ID"),
        content: z.string().describe("Followup text content"),
        is_private: z.number().optional().describe("1=private, 0=public"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ problemId, content, is_private }) =>
      jsonResult({ data: await addProblemFollowup(config, { items_id: problemId, content, is_private }) }),
    ),
  );

  // ===========================================================================
  // PHASE 3 — Cross-ITIL Solutions (2 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_add_change_solution",
    {
      title: "Add solution to change",
      description: "Add a solution to a change (status changes to Solved).",
      inputSchema: z.object({
        changeId: idSchema.describe("Change ID"),
        content: z.string().describe("Solution text content"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ changeId, content }) =>
      jsonResult({ data: await addChangeSolution(config, { items_id: changeId, content }) }),
    ),
  );

  server.registerTool(
    "glpi_add_problem_solution",
    {
      title: "Add solution to problem",
      description: "Add a solution to a problem (status changes to Solved).",
      inputSchema: z.object({
        problemId: idSchema.describe("Problem ID"),
        content: z.string().describe("Solution text content"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ problemId, content }) =>
      jsonResult({ data: await addProblemSolution(config, { items_id: problemId, content }) }),
    ),
  );

  // ===========================================================================
  // PHASE 3 — Session Info (2 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_get_my_entities",
    {
      title: "Get my entities",
      description: "Get the list of entities available to the current user.",
      inputSchema: z.object({}),
      outputSchema: outData(),
    },
    wrap(async () => jsonResult({ data: (await getMyEntities(config)) ?? [] })),
  );

  server.registerTool(
    "glpi_get_my_profiles",
    {
      title: "Get my profiles",
      description: "Get the list of profiles available to the current user.",
      inputSchema: z.object({}),
      outputSchema: outData(),
    },
    wrap(async () => jsonResult({ data: (await getMyProfiles(config)) ?? [] })),
  );

  // ===========================================================================
  // PHASE 3 — Locations (2 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_locations",
    {
      title: "List locations",
      description: "List GLPI locations with optional pagination.",
      inputSchema: z.object({ range: rangeSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range, expand_dropdowns }) => {
      const result = await listLocations(config, { range, expand_dropdowns });
      return jsonResult({ data: Array.isArray(result) ? result : [] });
    }),
  );

  server.registerTool(
    "glpi_get_location",
    {
      title: "Get location",
      description: "Retrieve a location by ID.",
      inputSchema: z.object({ locationId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ locationId }) => jsonResult({ data: (await getLocation(config, locationId)) ?? {} })),
  );

  // ===========================================================================
  // ASSETS / INVENTORY (5 tools)
  // ===========================================================================

  /** Names a person reads on an asset listing. */
  const ASSET_LIST_NAMES = [
    { field: "locations_id", itemtype: "Location", as: "location_name" },
    { field: "states_id", itemtype: "State", as: "state_name" },
    { field: "users_id", itemtype: "User", as: "user_name" },
  ];

  const assetTypeSchema = z
    .enum(ASSET_TYPES)
    .describe("Asset itemtype, e.g. Computer, Monitor, Printer, NetworkEquipment, Software");

  server.registerTool(
    "glpi_list_assets",
    {
      title: "List assets",
      description:
        "List assets of a given type (Computer, Monitor, Printer, NetworkEquipment, " +
        "Peripheral, Phone, Software, Rack, Enclosure), with location_name, state_name and user_name beside " +
        "the IDs. Use glpi_search for filtered queries.",
      inputSchema: z.object({
        asset_type: assetTypeSchema,
        range: rangeSchema,
        expand_dropdowns: expandSchema,
      }),
      outputSchema: outData(),
    },
    wrap(async ({ asset_type, range, expand_dropdowns }) => {
      const result = await listAssets(config, asset_type, { range, expand_dropdowns });
      const rows = Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
      return jsonResult({ data: expand_dropdowns ? rows : await addNames(config, rows, ASSET_LIST_NAMES) });
    }),
  );

  server.registerTool(
    "glpi_get_asset",
    {
      title: "Get asset",
      description: "Retrieve a single asset by type and ID. For hardware detail use glpi_get_asset_details.",
      inputSchema: z.object({
        asset_type: assetTypeSchema,
        assetId: idSchema,
        expand_dropdowns: expandSchema,
      }),
      outputSchema: outData(),
    },
    wrap(async ({ asset_type, assetId, expand_dropdowns }) =>
      jsonResult({ data: (await getAsset(config, asset_type, assetId, { expand_dropdowns })) ?? {} }),
    ),
  );

  server.registerTool(
    "glpi_get_asset_details",
    {
      title: "Get asset details",
      description:
        "Enriched asset view in one request: operating system, processors, memory and disks by " +
        "default. Ask for sections ['softwares'] or ['networkports'] explicitly — on an " +
        "inventoried host those are the bulk of the payload. Dropdown IDs come resolved to names.",
      inputSchema: z.object({
        asset_type: assetTypeSchema,
        assetId: idSchema,
        sections: z
          .array(z.enum(DETAIL_SECTIONS))
          .optional()
          .describe("Sections to expand (default: devices, disks, softwares, networkports)"),
        max_items_per_section: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Rows kept per expanded section (default 25); the rest is reported as a count"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ asset_type, assetId, sections, max_items_per_section }) =>
      jsonResult({
        data: (await getAssetDetails(config, asset_type, assetId, sections, max_items_per_section)) ?? {},
      }),
    ),
  );

  server.registerTool(
    "glpi_create_asset",
    {
      title: "Create asset",
      description:
        "Create an asset. Common fields: name, entities_id, serial, otherserial, " +
        "locations_id, states_id, manufacturers_id, users_id, comment.",
      inputSchema: z.object({
        asset_type: assetTypeSchema,
        input: z.record(z.unknown()).describe("Asset fields"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ asset_type, input }) =>
      jsonResult({ data: (await createAsset(config, asset_type, input as Record<string, unknown>)) ?? { id: 0 } }),
    ),
  );

  server.registerTool(
    "glpi_update_asset",
    {
      title: "Update asset",
      description: "Update an existing asset by type and ID.",
      inputSchema: z.object({
        asset_type: assetTypeSchema,
        assetId: idSchema,
        input: z.record(z.unknown()).describe("Fields to update"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ asset_type, assetId, input }) =>
      jsonResult({
        data: (await updateAsset(config, asset_type, assetId, input as Record<string, unknown>)) ?? {},
      }),
    ),
  );

  // ===========================================================================
  // RESERVATIONS (5 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_list_reservation_items",
    {
      title: "List reservable items",
      description: "List items flagged as reservable (the catalogue reservations point at).",
      inputSchema: z.object({ range: rangeSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range }) => {
      const result = await listReservationItems(config, { range });
      return jsonResult({ data: Array.isArray(result) ? result : [] });
    }),
  );

  server.registerTool(
    "glpi_list_reservations",
    {
      title: "List reservations",
      description: "List reservations (bookings) of reservable items.",
      inputSchema: z.object({ range: rangeSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range }) => {
      const result = await listReservations(config, { range });
      return jsonResult({ data: Array.isArray(result) ? result : [] });
    }),
  );

  server.registerTool(
    "glpi_get_reservation",
    {
      title: "Get reservation",
      description: "Retrieve a reservation by ID.",
      inputSchema: z.object({ reservationId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ reservationId }) =>
      jsonResult({ data: (await getReservation(config, reservationId)) ?? {} }),
    ),
  );

  server.registerTool(
    "glpi_create_reservation",
    {
      title: "Create reservation",
      description:
        "Book a reservable item. begin/end use 'YYYY-MM-DD HH:MM:SS'. " +
        "reservationitems_id comes from glpi_list_reservation_items (not the asset ID).",
      inputSchema: z.object({
        reservationitems_id: idSchema.describe("ReservationItem ID (see glpi_list_reservation_items)"),
        begin: z.string().describe("Start, 'YYYY-MM-DD HH:MM:SS'"),
        end: z.string().describe("End, 'YYYY-MM-DD HH:MM:SS'"),
        users_id: idSchema.optional().describe("User the booking is for"),
        comment: z.string().optional(),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ reservationitems_id, begin, end, users_id, comment }) =>
      jsonResult({
        data: (await createReservation(config, { reservationitems_id, begin, end, users_id, comment })) ?? { id: 0 },
      }),
    ),
  );

  server.registerTool(
    "glpi_update_reservation",
    {
      title: "Update reservation",
      description: "Update an existing reservation by ID.",
      inputSchema: z.object({
        reservationId: idSchema,
        input: z.record(z.unknown()).describe("Fields to update (begin, end, comment, users_id)"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ reservationId, input }) =>
      jsonResult({ data: (await updateReservation(config, reservationId, input as Record<string, unknown>)) ?? {} }),
    ),
  );

  // ===========================================================================
  // COUNTING (2 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_count_items",
    {
      title: "Count items",
      description:
        "Count matching items without transferring them — answers 'how many' in one cheap call. " +
        "Use glpi_list_search_options to discover criteria field IDs.",
      inputSchema: z.object({
        itemtype: z.string().describe("Item type, e.g. Ticket, Computer, User"),
        criteria: z
          .array(z.record(z.unknown()))
          .optional()
          .describe("Array of {field, searchtype, value, link} — same shape as glpi_search"),
      }),
      outputSchema: z.object({ data: z.object({ itemtype: z.string(), total: z.number() }) }),
    },
    wrap(async ({ itemtype, criteria }) =>
      jsonResult({ data: await countItems(config, itemtype, criteria as Record<string, unknown>[] | undefined) }),
    ),
  );

  server.registerTool(
    "glpi_get_ticket_stats",
    {
      title: "Get ticket stats",
      description:
        "Ticket counts per status (New, Processing, Pending, Solved, Closed) plus the total, " +
        "without listing the tickets. Optional criteria narrow the scope, e.g. one entity: " +
        "[{field: 80, searchtype: 'equals', value: <entity id>}] (Ticket search option IDs: 80 = entity, " +
        "4 = requester, 5 = technician, 7 = category; same criteria shape as glpi_search).",
      inputSchema: z.object({
        criteria: z
          .array(z.record(z.unknown()))
          .optional()
          .describe("Optional criteria to narrow the scope: array of {field, searchtype, value, link}"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ criteria }) =>
      jsonResult({ data: await ticketStats(config, (criteria as Record<string, unknown>[]) ?? []) }),
    ),
  );

  // ===========================================================================
  // TIMELINE (1 tool)
  // ===========================================================================

  server.registerTool(
    "glpi_list_timeline",
    {
      title: "List timeline",
      description:
        "Followups, tasks, solutions and validations of a ticket, change or problem, merged " +
        "into one chronological list (oldest first; order 'desc' for the latest first), with the " +
        "people's names (user_name, tech_name, validator_name) and the solution type name. " +
        "Replaces calling the four list tools separately and interleaving them by hand.",
      inputSchema: z.object({
        itemtype: z.enum(["Ticket", "Change", "Problem"]).describe("ITIL item type"),
        itemId: idSchema,
        range: rangeSchema.describe("Pagination range over the merged timeline, e.g. 0-24"),
        order: z.enum(["asc", "desc"]).optional().describe("asc (default) = oldest first, desc = latest first"),
      }),
      outputSchema: outData(),
    },
    wrap(async ({ itemtype, itemId, range, order }) => {
      const entries = await listTimeline(config, itemtype, itemId, { range, order });
      const named = await addNames(config, entries, (e) =>
        e.type === "task" ? TASK_NAMES : e.type === "solution" ? SOLUTION_NAMES : e.type === "validation" ? VALIDATION_NAMES : FOLLOWUP_NAMES,
      );
      const labels = await sessionLabels(config);
      const labelled = named.map((e) =>
        e.type === "validation" && labels.validation_status[Number(e.status)] !== undefined
          ? { ...e, status_name: labels.validation_status[Number(e.status)] }
          : e,
      );
      return jsonResult({ data: labelled });
    }),
  );

  // ===========================================================================
  // WEBHOOKS (8 tools) — GLPI 10.0.7+ / 11
  // ===========================================================================

  server.registerTool(
    "glpi_list_webhooks",
    {
      title: "List webhooks",
      description:
        "List configured webhooks (event, itemtype, target URL, active flag). " +
        "Requires GLPI 10.0.7 or newer.",
      inputSchema: z.object({ range: rangeSchema, expand_dropdowns: expandSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ range, expand_dropdowns }) => {
      const result = await listWebhooks(config, { range, expand_dropdowns });
      return jsonResult({ data: Array.isArray(result) ? result : [] });
    }),
  );

  server.registerTool(
    "glpi_get_webhook",
    {
      title: "Get webhook",
      description: "Retrieve a webhook definition by ID, including its payload template.",
      inputSchema: z.object({ webhookId: idSchema }),
      outputSchema: outData(),
    },
    wrap(async ({ webhookId }) => jsonResult({ data: (await getWebhook(config, webhookId)) ?? {} })),
  );

  server.registerTool(
    "glpi_create_webhook",
    {
      title: "Create webhook",
      description:
        "Create a webhook. Common fields: name, url, itemtype (e.g. Ticket), event " +
        "(new, update, delete), is_active, payload, http_method, use_cra_challenge.",
      inputSchema: z.object({ input: z.record(z.unknown()).describe("Webhook fields") }),
      outputSchema: outData(),
    },
    wrap(async ({ input }) =>
      jsonResult({ data: (await createWebhook(config, input as Record<string, unknown>)) ?? { id: 0 } }),
    ),
  );

  server.registerTool(
    "glpi_update_webhook",
    {
      title: "Update webhook",
      description: "Update a webhook definition by ID.",
      inputSchema: z.object({ webhookId: idSchema, input: z.record(z.unknown()) }),
      outputSchema: outData(),
    },
    wrap(async ({ webhookId, input }) =>
      jsonResult({ data: (await updateWebhook(config, webhookId, input as Record<string, unknown>)) ?? {} }),
    ),
  );

  server.registerTool(
    "glpi_set_webhook_active",
    {
      title: "Enable or disable webhook",
      description: "Turn a webhook on or off without touching the rest of its definition.",
      inputSchema: z.object({ webhookId: idSchema, active: z.boolean() }),
      outputSchema: outData(),
    },
    wrap(async ({ webhookId, active }) =>
      jsonResult({ data: (await setWebhookActive(config, webhookId, active)) ?? {} }),
    ),
  );

  server.registerTool(
    "glpi_delete_webhook",
    {
      title: "Delete webhook",
      description: "Delete a webhook. Set purge to remove it permanently instead of trashing it.",
      inputSchema: z.object({ webhookId: idSchema, purge: z.boolean().optional() }),
      outputSchema: outData(),
    },
    wrap(async ({ webhookId, purge }) =>
      jsonResult({ data: (await deleteWebhook(config, webhookId, purge)) ?? {} }),
    ),
  );

  server.registerTool(
    "glpi_list_webhook_deliveries",
    {
      title: "List webhook deliveries",
      description:
        "Delivery queue (QueuedWebhook): what was sent, when, and what is still pending, newest first. " +
        "Filter by webhook name, or only_failed to see what has been retried.",
      inputSchema: z.object({
        webhook_name: z
          .string()
          .optional()
          .describe("Restrict to webhooks whose name contains this text"),
        only_failed: z
          .boolean()
          .optional()
          .describe("Only deliveries that failed: retried at least once (sent_try > 1) or last HTTP status >= 300"),
        range: rangeSchema,
      }),
      outputSchema: outData(),
    },
    wrap(async ({ webhook_name, only_failed, range }) =>
      jsonResult({ data: (await listWebhookDeliveries(config, { webhook_name, only_failed, range })) ?? [] }),
    ),
  );

  server.registerTool(
    "glpi_retry_webhook_delivery",
    {
      title: "Retry webhook delivery",
      description:
        "Queue a failed delivery for another attempt by resetting its send time and retry " +
        "counter. The GLPI cron does the actual sending — there is no immediate-send endpoint.",
      inputSchema: z.object({ deliveryId: idSchema.describe("QueuedWebhook ID") }),
      outputSchema: outData(),
    },
    wrap(async ({ deliveryId }) =>
      jsonResult({ data: (await retryWebhookDelivery(config, deliveryId)) ?? {} }),
    ),
  );
}
