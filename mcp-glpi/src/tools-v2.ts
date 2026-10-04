import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  jsonResult,
  makeWrap,
} from "@nextoolsolutions/mcp-glpi-core";
import type { GlpiV2Config } from "./glpi-v2-client.js";
import { itemIdSchema } from "./ids.js";
import { TICKET_STATUS_FILTERS, normalizeStatuses, statusCodes } from "./ticket-lists.js";
import {
  // Entity
  listEntities, getEntity, createEntity, updateEntity, deleteEntity,
  // Ticket
  listTickets, getTicket, createTicket, updateTicket, deleteTicket,
  // Change
  listChanges, getChange, createChange, updateChange,
  // Problem
  listProblems, getProblem, createProblem, updateProblem,
  // Timeline
  listTimeline, addFollowup, addSolution, addTask, addValidation, updateValidation,
  // Team Members
  listTeamMembers, addTeamMember, removeTeamMember,
  // Users
  listUsers, getUser, getMe, createUser, updateUser,
  // Groups
  listGroups, getGroup, createGroup,
  // Knowledgebase
  listKBArticles, getKBArticle, createKBArticle, updateKBArticle, listKBCategories, getKBCategory,
  // Dropdowns
  listITILCategories, getITILCategory, listLocations, listRequestTypes,
  // Documents
  listDocuments, getDocument, createDocument, downloadDocument,
  // Rules
  listRuleCollections, listRules, getRule, createRule,
  // Session & Status
  getSession, healthCheck,
} from "./glpi-v2-client.js";

/**
 * GLPI 11 High-level API v2 tools (OAuth2): the `glpi_v2_*` family.
 * Registered on a server whose write policy, payload formatting and create
 * idempotency are already installed (see index.ts).
 */
export function registerV2Tools(server: McpServer, config: GlpiV2Config): void {
  // ---------------------------------------------------------------------------
  // Result helpers (shared — see @nextoolsolutions/mcp-glpi-core)
  // ---------------------------------------------------------------------------

  const wrap = makeWrap(() =>
    !config.baseUrl || !config.clientId || !config.clientSecret || !config.username || !config.password
      ? "GLPI_V2_URL, GLPI_V2_CLIENT_ID, GLPI_V2_CLIENT_SECRET, GLPI_V2_USERNAME and GLPI_V2_PASSWORD are required."
      : null,
  );

  // ---------------------------------------------------------------------------
  // Reusable schemas
  // ---------------------------------------------------------------------------

  const listParamsSchema = z.object({
    filter: z.string().optional().describe("RSQL filter (e.g. name=like=Client)"),
    start: z.number().optional().describe("Offset (default 0)"),
    limit: z.number().optional().describe("Max items (default 100)"),
    sort: z.string().optional().describe("Sort (e.g. name:asc)"),
  });

  const itilItemtypeSchema = z.enum(["Ticket", "Change", "Problem"]).describe("ITIL item type");

  /** Default order of the ITIL listings: latest update first (the API default is id ascending). */
  const RECENT_FIRST = "date_mod:desc";
  const itilListSchema = listParamsSchema.extend({
    sort: z.string().optional().describe("Sort, e.g. date_mod:desc (default), date:desc, id:asc, priority:desc"),
  });
  const statusEnum = z.enum(TICKET_STATUS_FILTERS);

  /** RSQL on status.id for the status names; the caller's filter is kept and ANDed. */
  function withStatusFilter(filter: string | undefined, status: string | readonly string[] | undefined): string | undefined {
    const statuses = normalizeStatuses(status);
    if (statuses.length === 0) return filter;
    const codes = statusCodes(statuses);
    const rsql = codes.length === 1 ? `status.id==${codes[0]}` : `status.id=in=(${codes.join(",")})`;
    return filter ? `(${filter});${rsql}` : rsql;
  }


  // ===========================================================================
  // ENTITY (5 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_v2_list_entities",
    {
      title: "List entities",
      description: "List entities via /Administration/Entity. Supports RSQL filter, pagination and sorting.",
      inputSchema: listParamsSchema,
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async (p) => jsonResult(await listEntities(config, p))),
  );

  server.registerTool(
    "glpi_v2_get_entity",
    {
      title: "Get entity",
      description: "Retrieve a single entity by ID.",
      inputSchema: z.object({ entityId: itemIdSchema("Entity ID", { allowZero: true }) }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ entityId }) => jsonResult(await getEntity(config, entityId))),
  );

  server.registerTool(
    "glpi_v2_create_entity",
    {
      title: "Create entity",
      description: "Create a new entity. Fields: name (required), comment, entities_id (parent).",
      inputSchema: z.object({
        input: z.record(z.unknown()).describe('Entity data (e.g. { "name": "My Entity", "entities_id": 0 })'),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ input }) => jsonResult(await createEntity(config, input as Record<string, unknown>))),
  );

  server.registerTool(
    "glpi_v2_update_entity",
    {
      title: "Update entity",
      description: "Update an existing entity by ID.",
      inputSchema: z.object({
        entityId: itemIdSchema("Entity ID", { allowZero: true }),
        input: z.record(z.unknown()).describe("Fields to update"),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ entityId, input }) => jsonResult(await updateEntity(config, entityId, input as Record<string, unknown>))),
  );

  server.registerTool(
    "glpi_v2_delete_entity",
    {
      title: "Delete entity",
      description: "Delete an entity by ID. Use force=true for permanent deletion.",
      inputSchema: z.object({
        entityId: itemIdSchema("Entity ID", { allowZero: true }),
        force: z.boolean().optional().describe("Force permanent deletion"),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ entityId, force }) => {
      await deleteEntity(config, entityId, force);
      return jsonResult({ ok: true });
    }),
  );

  // ===========================================================================
  // TICKET (5 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_v2_list_tickets",
    {
      title: "List tickets",
      description:
        "List tickets via /Assistance/Ticket, most recently updated first by default. Filter by status " +
        "(status: 'open' = not solved nor closed) and/or an RSQL filter; each ticket carries its team " +
        "(requester, assigned, observer) with names. The v2 API cannot filter on the team, so this tool " +
        "cannot narrow to the connected user's own tickets; the v1 family can, when it is enabled.",
      inputSchema: itilListSchema.extend({
        status: z
          .union([statusEnum, z.array(statusEnum)])
          .optional()
          .describe(
            "Only tickets in these statuses: new, assigned (= processing), planned, pending, solved, closed, " +
              "or open (= new + assigned + planned + pending). One name or a list. Default: every status.",
          ),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ status, ...p }) =>
      jsonResult(await listTickets(config, { ...p, sort: p.sort ?? RECENT_FIRST, filter: withStatusFilter(p.filter, status) })),
    ),
  );

  server.registerTool(
    "glpi_v2_get_ticket",
    {
      title: "Get ticket",
      description: "Retrieve a single ticket by ID.",
      inputSchema: z.object({ ticketId: itemIdSchema("Ticket ID") }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ ticketId }) => jsonResult(await getTicket(config, ticketId))),
  );

  server.registerTool(
    "glpi_v2_create_ticket",
    {
      title: "Create ticket",
      description: "Create a new ticket. Fields: name (required), content, type, priority, urgency, impact, etc.",
      inputSchema: z.object({
        input: z.record(z.unknown()).describe('Ticket data (e.g. { "name": "Issue", "content": "Details" })'),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ input }) => jsonResult(await createTicket(config, input as Record<string, unknown>))),
  );

  server.registerTool(
    "glpi_v2_update_ticket",
    {
      title: "Update ticket",
      description: "Update an existing ticket by ID.",
      inputSchema: z.object({
        ticketId: itemIdSchema("Ticket ID"),
        input: z.record(z.unknown()).describe("Fields to update"),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ ticketId, input }) => jsonResult(await updateTicket(config, ticketId, input as Record<string, unknown>))),
  );

  server.registerTool(
    "glpi_v2_delete_ticket",
    {
      title: "Delete ticket",
      description: "Delete a ticket by ID. Use force=true for permanent deletion.",
      inputSchema: z.object({
        ticketId: itemIdSchema("Ticket ID"),
        force: z.boolean().optional().describe("Force permanent deletion"),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ ticketId, force }) => {
      await deleteTicket(config, ticketId, force);
      return jsonResult({ ok: true });
    }),
  );

  // ===========================================================================
  // CHANGE (4 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_v2_list_changes",
    {
      title: "List changes",
      description:
        "List change requests via /Assistance/Change, most recently updated first by default. Supports RSQL filter, pagination and sorting.",
      inputSchema: itilListSchema,
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async (p) => jsonResult(await listChanges(config, { ...p, sort: p.sort ?? RECENT_FIRST }))),
  );

  server.registerTool(
    "glpi_v2_get_change",
    {
      title: "Get change",
      description: "Retrieve a single change by ID.",
      inputSchema: z.object({ changeId: itemIdSchema("Change ID") }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ changeId }) => jsonResult(await getChange(config, changeId))),
  );

  server.registerTool(
    "glpi_v2_create_change",
    {
      title: "Create change",
      description: "Create a new change request.",
      inputSchema: z.object({
        input: z.record(z.unknown()).describe('Change data (e.g. { "name": "Server upgrade" })'),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ input }) => jsonResult(await createChange(config, input as Record<string, unknown>))),
  );

  server.registerTool(
    "glpi_v2_update_change",
    {
      title: "Update change",
      description: "Update an existing change by ID.",
      inputSchema: z.object({
        changeId: itemIdSchema("Change ID"),
        input: z.record(z.unknown()).describe("Fields to update"),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ changeId, input }) => jsonResult(await updateChange(config, changeId, input as Record<string, unknown>))),
  );

  // ===========================================================================
  // PROBLEM (4 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_v2_list_problems",
    {
      title: "List problems",
      description:
        "List problems via /Assistance/Problem, most recently updated first by default. Supports RSQL filter, pagination and sorting.",
      inputSchema: itilListSchema,
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async (p) => jsonResult(await listProblems(config, { ...p, sort: p.sort ?? RECENT_FIRST }))),
  );

  server.registerTool(
    "glpi_v2_get_problem",
    {
      title: "Get problem",
      description: "Retrieve a single problem by ID.",
      inputSchema: z.object({ problemId: itemIdSchema("Problem ID") }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ problemId }) => jsonResult(await getProblem(config, problemId))),
  );

  server.registerTool(
    "glpi_v2_create_problem",
    {
      title: "Create problem",
      description: "Create a new problem.",
      inputSchema: z.object({
        input: z.record(z.unknown()).describe('Problem data (e.g. { "name": "Network outage" })'),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ input }) => jsonResult(await createProblem(config, input as Record<string, unknown>))),
  );

  server.registerTool(
    "glpi_v2_update_problem",
    {
      title: "Update problem",
      description: "Update an existing problem by ID.",
      inputSchema: z.object({
        problemId: itemIdSchema("Problem ID"),
        input: z.record(z.unknown()).describe("Fields to update"),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ problemId, input }) => jsonResult(await updateProblem(config, problemId, input as Record<string, unknown>))),
  );

  // ===========================================================================
  // TIMELINE (6 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_v2_list_timeline",
    {
      title: "List timeline",
      description: "List all timeline entries (followups, solutions, tasks, validations) for an ITIL item.",
      inputSchema: z.object({
        itemtype: itilItemtypeSchema,
        itemId: itemIdSchema("Item ID"),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ itemtype, itemId }) => jsonResult(await listTimeline(config, itemtype, itemId))),
  );

  server.registerTool(
    "glpi_v2_add_followup",
    {
      title: "Add followup",
      description: "Add a followup to a Ticket, Change or Problem.",
      inputSchema: z.object({
        itemtype: itilItemtypeSchema,
        itemId: itemIdSchema("Item ID"),
        input: z.record(z.unknown()).describe('Followup data (e.g. { "content": "Update on this ticket" })'),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ itemtype, itemId, input }) =>
      jsonResult(await addFollowup(config, itemtype, itemId, input as Record<string, unknown>)),
    ),
  );

  server.registerTool(
    "glpi_v2_add_solution",
    {
      title: "Add solution",
      description: "Add a solution to a Ticket, Change or Problem.",
      inputSchema: z.object({
        itemtype: itilItemtypeSchema,
        itemId: itemIdSchema("Item ID"),
        input: z.record(z.unknown()).describe('Solution data (e.g. { "content": "Resolved by..." })'),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ itemtype, itemId, input }) =>
      jsonResult(await addSolution(config, itemtype, itemId, input as Record<string, unknown>)),
    ),
  );

  server.registerTool(
    "glpi_v2_add_task",
    {
      title: "Add task",
      description: "Add a task to a Ticket, Change or Problem.",
      inputSchema: z.object({
        itemtype: itilItemtypeSchema,
        itemId: itemIdSchema("Item ID"),
        input: z.record(z.unknown()).describe('Task data (e.g. { "content": "Investigate root cause", "state": 1 })'),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ itemtype, itemId, input }) =>
      jsonResult(await addTask(config, itemtype, itemId, input as Record<string, unknown>)),
    ),
  );

  server.registerTool(
    "glpi_v2_add_validation",
    {
      title: "Add validation request",
      description: "Request validation for a Ticket, Change or Problem.",
      inputSchema: z.object({
        itemtype: itilItemtypeSchema,
        itemId: itemIdSchema("Item ID"),
        input: z.record(z.unknown()).describe('Validation data (e.g. { "users_id_validate": 5, "comment_submission": "Please review" })'),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ itemtype, itemId, input }) =>
      jsonResult(await addValidation(config, itemtype, itemId, input as Record<string, unknown>)),
    ),
  );

  server.registerTool(
    "glpi_v2_update_validation",
    {
      title: "Update validation",
      description: "Approve or refuse a validation request.",
      inputSchema: z.object({
        itemtype: itilItemtypeSchema,
        itemId: itemIdSchema("Item ID"),
        validationId: itemIdSchema("Validation ID"),
        input: z.record(z.unknown()).describe('Validation update (e.g. { "status": 3, "comment_validation": "Approved" })'),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ itemtype, itemId, validationId, input }) =>
      jsonResult(await updateValidation(config, itemtype, itemId, validationId, input as Record<string, unknown>)),
    ),
  );

  // ===========================================================================
  // TEAM MEMBERS (3 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_v2_list_team_members",
    {
      title: "List team members",
      description: "List all team members (requester, assigned, observer, etc.) of an ITIL item.",
      inputSchema: z.object({
        itemtype: itilItemtypeSchema,
        itemId: itemIdSchema("Item ID"),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ itemtype, itemId }) => jsonResult(await listTeamMembers(config, itemtype, itemId))),
  );

  server.registerTool(
    "glpi_v2_add_team_member",
    {
      title: "Add team member",
      description: "Add a user, group or supplier as a team member to an ITIL item.",
      inputSchema: z.object({
        itemtype: itilItemtypeSchema,
        itemId: itemIdSchema("Item ID"),
        input: z.record(z.unknown()).describe(
          'Member data (e.g. { "itemtype": "User", "items_id": 5, "type": 1 } where type 1=requester, 2=assigned, 3=observer)',
        ),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ itemtype, itemId, input }) =>
      jsonResult(await addTeamMember(config, itemtype, itemId, input as Record<string, unknown>)),
    ),
  );

  server.registerTool(
    "glpi_v2_remove_team_member",
    {
      title: "Remove team member",
      description: "Remove a team member from an ITIL item.",
      inputSchema: z.object({
        itemtype: itilItemtypeSchema,
        itemId: itemIdSchema("Item ID"),
        memberId: itemIdSchema("Team member ID"),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ itemtype, itemId, memberId }) => {
      await removeTeamMember(config, itemtype, itemId, memberId);
      return jsonResult({ ok: true });
    }),
  );

  // ===========================================================================
  // USERS (5 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_v2_list_users",
    {
      title: "List users",
      description: "List users via /Administration/User. Supports RSQL filter, pagination and sorting.",
      inputSchema: listParamsSchema,
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async (p) => jsonResult(await listUsers(config, p))),
  );

  server.registerTool(
    "glpi_v2_get_user",
    {
      title: "Get user",
      description: "Retrieve a single user by ID.",
      inputSchema: z.object({ userId: itemIdSchema("User ID") }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ userId }) => jsonResult(await getUser(config, userId))),
  );

  server.registerTool(
    "glpi_v2_get_me",
    {
      title: "Get current user",
      description: "Retrieve the currently authenticated user's profile (who \"me\" is: id, login, names).",
      inputSchema: z.object({}),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async () => jsonResult(await getMe(config))),
  );

  server.registerTool(
    "glpi_v2_create_user",
    {
      title: "Create user",
      description: "Create a new user.",
      inputSchema: z.object({
        input: z.record(z.unknown()).describe('User data (e.g. { "name": "jdoe", "realname": "Doe", "firstname": "John" })'),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ input }) => jsonResult(await createUser(config, input as Record<string, unknown>))),
  );

  server.registerTool(
    "glpi_v2_update_user",
    {
      title: "Update user",
      description: "Update an existing user by ID.",
      inputSchema: z.object({
        userId: itemIdSchema("User ID"),
        input: z.record(z.unknown()).describe("Fields to update"),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ userId, input }) => jsonResult(await updateUser(config, userId, input as Record<string, unknown>))),
  );

  // ===========================================================================
  // GROUPS (3 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_v2_list_groups",
    {
      title: "List groups",
      description: "List groups via /Administration/Group. Supports RSQL filter, pagination and sorting.",
      inputSchema: listParamsSchema,
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async (p) => jsonResult(await listGroups(config, p))),
  );

  server.registerTool(
    "glpi_v2_get_group",
    {
      title: "Get group",
      description: "Retrieve a single group by ID.",
      inputSchema: z.object({ groupId: itemIdSchema("Group ID") }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ groupId }) => jsonResult(await getGroup(config, groupId))),
  );

  server.registerTool(
    "glpi_v2_create_group",
    {
      title: "Create group",
      description: "Create a new group.",
      inputSchema: z.object({
        input: z.record(z.unknown()).describe('Group data (e.g. { "name": "IT Support", "comment": "Level 1" })'),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ input }) => jsonResult(await createGroup(config, input as Record<string, unknown>))),
  );

  // ===========================================================================
  // KNOWLEDGEBASE (6 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_v2_list_kb_articles",
    {
      title: "List KB articles",
      description: "List knowledge base articles. Supports RSQL filter, pagination and sorting.",
      inputSchema: listParamsSchema,
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async (p) => jsonResult(await listKBArticles(config, p))),
  );

  server.registerTool(
    "glpi_v2_get_kb_article",
    {
      title: "Get KB article",
      description: "Retrieve a single knowledge base article by ID.",
      inputSchema: z.object({ articleId: itemIdSchema("Article ID") }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ articleId }) => jsonResult(await getKBArticle(config, articleId))),
  );

  server.registerTool(
    "glpi_v2_create_kb_article",
    {
      title: "Create KB article",
      description: "Create a new knowledge base article.",
      inputSchema: z.object({
        input: z.record(z.unknown()).describe('Article data (e.g. { "name": "How to...", "answer": "<p>Steps...</p>" })'),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ input }) => jsonResult(await createKBArticle(config, input as Record<string, unknown>))),
  );

  server.registerTool(
    "glpi_v2_update_kb_article",
    {
      title: "Update KB article",
      description: "Update an existing knowledge base article by ID.",
      inputSchema: z.object({
        articleId: itemIdSchema("Article ID"),
        input: z.record(z.unknown()).describe("Fields to update"),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ articleId, input }) =>
      jsonResult(await updateKBArticle(config, articleId, input as Record<string, unknown>)),
    ),
  );

  server.registerTool(
    "glpi_v2_list_kb_categories",
    {
      title: "List KB categories",
      description: "List knowledge base categories. Supports RSQL filter, pagination and sorting.",
      inputSchema: listParamsSchema,
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async (p) => jsonResult(await listKBCategories(config, p))),
  );

  server.registerTool(
    "glpi_v2_get_kb_category",
    {
      title: "Get KB category",
      description: "Retrieve a single knowledge base category by ID.",
      inputSchema: z.object({ categoryId: itemIdSchema("Category ID") }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ categoryId }) => jsonResult(await getKBCategory(config, categoryId))),
  );

  // ===========================================================================
  // DROPDOWNS (4 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_v2_list_itil_categories",
    {
      title: "List ITIL categories",
      description: "List ITIL categories (ticket classification). Supports RSQL filter, pagination and sorting.",
      inputSchema: listParamsSchema,
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async (p) => jsonResult(await listITILCategories(config, p))),
  );

  server.registerTool(
    "glpi_v2_get_itil_category",
    {
      title: "Get ITIL category",
      description: "Retrieve a single ITIL category by ID.",
      inputSchema: z.object({ categoryId: itemIdSchema("Category ID") }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ categoryId }) => jsonResult(await getITILCategory(config, categoryId))),
  );

  server.registerTool(
    "glpi_v2_list_locations",
    {
      title: "List locations",
      description: "List locations dropdown. Supports RSQL filter, pagination and sorting.",
      inputSchema: listParamsSchema,
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async (p) => jsonResult(await listLocations(config, p))),
  );

  server.registerTool(
    "glpi_v2_list_request_types",
    {
      title: "List request types",
      description: "List request types dropdown. Supports RSQL filter, pagination and sorting.",
      inputSchema: listParamsSchema,
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async (p) => jsonResult(await listRequestTypes(config, p))),
  );

  // ===========================================================================
  // DOCUMENTS (4 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_v2_list_documents",
    {
      title: "List documents",
      description: "List documents via /Management/Document. Supports RSQL filter, pagination and sorting.",
      inputSchema: listParamsSchema,
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async (p) => jsonResult(await listDocuments(config, p))),
  );

  server.registerTool(
    "glpi_v2_get_document",
    {
      title: "Get document",
      description: "Retrieve document metadata by ID.",
      inputSchema: z.object({ documentId: itemIdSchema("Document ID") }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ documentId }) => jsonResult(await getDocument(config, documentId))),
  );

  server.registerTool(
    "glpi_v2_create_document",
    {
      title: "Create document",
      description: "Create a new document record (metadata only — file upload requires multipart).",
      inputSchema: z.object({
        input: z.record(z.unknown()).describe('Document data (e.g. { "name": "Report Q1", "filename": "report.pdf" })'),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ input }) => jsonResult(await createDocument(config, input as Record<string, unknown>))),
  );

  server.registerTool(
    "glpi_v2_download_document",
    {
      title: "Download document",
      description: "Download a document by ID. Returns the file content (may be base64 or raw text depending on type).",
      inputSchema: z.object({ documentId: itemIdSchema("Document ID") }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ documentId }) => jsonResult(await downloadDocument(config, documentId))),
  );

  // ===========================================================================
  // RULES (4 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_v2_list_rule_collections",
    {
      title: "List rule collections",
      description: "List all available rule collections (e.g. RuleTicket, RuleMailCollector, etc.).",
      inputSchema: z.object({}),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async () => jsonResult(await listRuleCollections(config))),
  );

  server.registerTool(
    "glpi_v2_list_rules",
    {
      title: "List rules",
      description: "List rules within a specific collection.",
      inputSchema: z.object({
        collection: z.string().describe("Rule collection name (e.g. RuleTicket)"),
        filter: z.string().optional().describe("RSQL filter"),
        start: z.number().optional().describe("Offset"),
        limit: z.number().optional().describe("Max items"),
        sort: z.string().optional().describe("Sort"),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ collection, filter, start, limit, sort }) =>
      jsonResult(await listRules(config, collection, { filter, start, limit, sort })),
    ),
  );

  server.registerTool(
    "glpi_v2_get_rule",
    {
      title: "Get rule",
      description: "Retrieve a single rule by collection and ID.",
      inputSchema: z.object({
        collection: z.string().describe("Rule collection name"),
        ruleId: itemIdSchema("Rule ID"),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ collection, ruleId }) => jsonResult(await getRule(config, collection, ruleId))),
  );

  server.registerTool(
    "glpi_v2_create_rule",
    {
      title: "Create rule",
      description: "Create a new rule within a collection.",
      inputSchema: z.object({
        collection: z.string().describe("Rule collection name"),
        input: z.record(z.unknown()).describe("Rule data"),
      }),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async ({ collection, input }) =>
      jsonResult(await createRule(config, collection, input as Record<string, unknown>)),
    ),
  );

  // ===========================================================================
  // SESSION & STATUS (2 tools)
  // ===========================================================================

  server.registerTool(
    "glpi_v2_get_session",
    {
      title: "Get session",
      description: "Get current session information (active profile, entity, etc.).",
      inputSchema: z.object({}),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async () => jsonResult(await getSession(config))),
  );

  server.registerTool(
    "glpi_v2_health_check",
    {
      title: "Health check",
      description: "Check GLPI instance status and API availability.",
      inputSchema: z.object({}),
      outputSchema: z.object({}).passthrough(),
    },
    wrap(async () => {
      const result = await healthCheck(config);
      return jsonResult({ status: "ok", ...result });
    }),
  );
}
