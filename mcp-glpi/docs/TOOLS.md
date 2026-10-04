# MCP GLPI — Tools Reference

**Version:** 3.5.0 | **Tools:** 111 (60 read / 42 write / 9 destructive) | **Resources:** 4 | **Prompts:** 4
**Last updated:** 2026-10-04 — generated from the running server (`tools/list`), not by hand.

Every tool is prefixed with `glpi_`. The **Kind** column is the MCP annotation the server
publishes (`readOnlyHint` / `destructiveHint`) and also what the write policy enforces.

---

## Safety

| Env var | Default | Effect |
|---------|---------|--------|
| `GLPI_READ_ONLY` | `false` | `true` blocks every write and destructive tool before it reaches GLPI |
| `GLPI_ALLOW_DELETE` | `false` | Destructive tools are refused unless this is `true` |
| `GLPI_REQUIRE_DELETE_REASON` | `true` | Destructive tools require `reason` (≥10 chars) |
| `GLPI_IDEMPOTENCY_WINDOW` | `120` | Seconds in which an identical `create_`/`add_` call is replayed instead of repeated (`0` disables) |

Labels of GLPI codes (`status_name`, `type_name`, `priority_name`, `urgency_name`, `impact_name`, the actor
`type_name`, the validation `status_name`) follow the language of the GLPI session (`glpilanguage`): GLPI's own
texts in pt_BR, pt_PT, es_ES, fr_FR, it_IT, de_DE, English otherwise — the same labels the API v2 returns.

Instances pointing at a production GLPI that nobody should change through an assistant should run
with `GLPI_READ_ONLY=true`.

## Payload and pagination

Read tools take two extra parameters:

| Parameter | Values | Default | Effect |
|-----------|--------|---------|--------|
| `fields` | `essential`, `all` | `essential` | `essential` drops GLPI's internal bookkeeping (SLA/OLA counters, delay stats, HAL links) and flattens TinyMCE richtext to plain text. `all` returns the raw payload |
| `format` | `json`, `markdown` | `json` | `markdown` renders listings as a table and one item as `key: value` lines, in the text block and in `structuredContent` (`{data: "<markdown>", format: "markdown"}`). Ticket, problem, change, asset, user, KB, followup/task and timeline listings use a compact column set (tickets: id, title, status, category, requester, technician, priority, updated; timeline: one line per entry with type, id, date, author, summary); `fields: "all"` draws every column. The JSON result keeps every field |

| Env var | Default | Effect |
|---------|---------|--------|
| `GLPI_DEFAULT_PAGE_SIZE` | `25` | Applied when no `range`/`limit` is given |
| `GLPI_MAX_PAGE_SIZE` | `100` | Hard ceiling per call; the payload carries a note when it truncates |
| `GLPI_MAX_RESPONSE_CHARS` | `50000` | Character budget of one answer; a longer listing is trimmed and the note gives the next page |
| `GLPI_LIST_TEXT_MAX_CHARS` | `300` | Texts longer than this are cut in listings (not in ticket history listings) |

## Resources

| URI | Contents |
|-----|----------|
| `glpi://entities` | Entity tree (id, name, completename, level) |
| `glpi://itil-categories` | Ticket/change/problem categories |
| `glpi://request-types` | Request sources (Helpdesk, Email, Phone…) |
| `glpi://code-maps` | Status, priority/urgency/impact, ticket type, actor type and validation status codes |

Live catalogues are cached in-process (`GLPI_RESOURCE_CACHE_TTL`, default 300000 ms).

## Prompts

| Name | Purpose |
|------|---------|
| `triage_ticket` | Read a ticket and propose category, urgency/impact and assignment |
| `investigate_recurrence` | Find comparable past tickets and judge whether a Problem is warranted |
| `requester_history` | What a technician should know before calling this person back |
| `asset_context` | Hardware profile of an asset plus its ticket history |

---

## Tools

### Tickets (5)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_list_tickets` | read | List GLPI tickets of the whole instance (every ticket the connected user may see), most recently updated first by default. Filter by status (e.g. status: 'open' = not solved nor closed) and choose the sort column and direction. Each row carries status_name, type_name, priority_name (in the GLPI user's language), category_name, and requesters and assigned technicians as {id, name}. For the connected user's OWN tickets ("my tickets") use glpi_list_my_tickets instead. |
| `glpi_list_my_tickets` | read | "My tickets": tickets of the connected GLPI user (or of users_id) where they are requester, assigned technician or observer. Defaults: open tickets only (not solved nor closed), most recently updated first. Each row names the people: requesters, assigned and observers as {id, name}, plus status_name and my_roles. Use this for "meus chamados", "my open tickets", "tickets assigned to me". |
| `glpi_get_ticket` | read | Retrieve a single ticket by ID. IDs come with names beside them (recipient_name, category_name, entity_name; status_name, type_name, priority_name in the GLPI user's language). Requesters, technicians and observers are not ticket fields: list them with glpi_list_ticket_users (and groups with glpi_list_ticket_groups). |
| `glpi_create_ticket` | write | Create a new ticket. Common fields: name (title), content (description), entities_id, users_id_requester, itilcategories_id, type (1=Incident, 2=Request), urgency, impact, priority. |
| `glpi_update_ticket` | write | Update an existing ticket by ID. |

### Ticket actors (6)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_list_ticket_users` | read | List all users linked to a ticket (requesters, observers, assigned), with each person's name (user_name) beside users_id and type_name (in the GLPI user's language). type: 1=Requester, 2=Assigned, 3=Observer. |
| `glpi_add_ticket_user` | write | Add a user to a ticket as requester, observer, or assigned. type: 1=Requester, 2=Assigned, 3=Observer. |
| `glpi_delete_ticket_user` | destructive | Remove a user-ticket link by Ticket_User ID (get the ID from glpi_list_ticket_users). |
| `glpi_list_ticket_groups` | read | List all groups linked to a ticket (requester, observer, assigned), with each group's name (group_name) beside groups_id and type_name (in the GLPI user's language). type: 1=Requester, 2=Assigned, 3=Observer. |
| `glpi_add_ticket_group` | write | Add a group to a ticket as requester, observer, or assigned. type: 1=Requester, 2=Assigned, 3=Observer. |
| `glpi_delete_ticket_group` | destructive | Remove a group-ticket link by Group_Ticket ID (get the ID from glpi_list_ticket_groups). |

### Followups, solutions, tasks (13)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_list_change_followups` | read | List followups (comments) of a change, with the author's name (user_name). |
| `glpi_list_problem_followups` | read | List followups (comments) of a problem, with the author's name (user_name). |
| `glpi_add_followup` | write | Add a comment/followup to a ticket. |
| `glpi_list_followups` | read | List followups (comments) of a ticket, oldest first, with the author's name (user_name). |
| `glpi_add_solution` | write | Add a solution to a ticket (status changes to Solved). |
| `glpi_list_ticket_tasks` | read | List tasks (to-do items) for a ticket, with author, technician and group names (user_name, tech_name, tech_group_name). |
| `glpi_add_ticket_task` | write | Add a task to a ticket. Fields: tickets_id, content (required). Optional: is_private (0/1), state (0=Info, 1=To do, 2=Done), actiontime (seconds), users_id_tech (assigned technician). |
| `glpi_list_change_tasks` | read | List tasks for a change, with author, technician and group names. |
| `glpi_list_problem_tasks` | read | List tasks for a problem, with author, technician and group names. |
| `glpi_add_change_followup` | write | Add a comment/followup to a change. |
| `glpi_add_problem_followup` | write | Add a comment/followup to a problem. |
| `glpi_add_change_solution` | write | Add a solution to a change (status changes to Solved). |
| `glpi_add_problem_solution` | write | Add a solution to a problem (status changes to Solved). |

### Timeline (1)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_list_timeline` | read | Followups, tasks, solutions and validations of a ticket, change or problem, merged into one chronological list (oldest first; order 'desc' for the latest first), with the people's names (user_name, tech_name, validator_name) and the solution type name. Replaces calling the four list tools separately and interleaving them by hand. |

### Validations (4)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_list_ticket_validations` | read | List approval/validation requests for a ticket, with requester and approver names (user_name, validator_name) and status_name in the GLPI user's language (status: 1 = not subject to approval, 2 = waiting, 3 = granted, 4 = refused). |
| `glpi_create_ticket_validation` | write | Create an approval request assigning a validator (users_id_validate). |
| `glpi_update_ticket_validation` | write | Approve/refuse a validation (status: accepted/refused) or change the approver. |
| `glpi_delete_ticket_validation` | destructive | Remove a validation request by ID. |

### Changes (4)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_list_changes` | read | List change management items, most recently updated first by default, with status_name and priority_name (in the GLPI user's language) and category_name. |
| `glpi_get_change` | read | Retrieve a change by ID, with names beside the IDs and status/priority labels in the GLPI user's language. |
| `glpi_create_change` | write | Create a new change. Common fields: name, content, entities_id, users_id_requester. |
| `glpi_update_change` | write | Update an existing change by ID. |

### Problems (4)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_list_problems` | read | List problem management items, most recently updated first by default, with status_name and priority_name (in the GLPI user's language) and category_name. |
| `glpi_get_problem` | read | Retrieve a problem by ID, with names beside the IDs and status/priority labels in the GLPI user's language. |
| `glpi_create_problem` | write | Create a new problem. Common fields: name, content, entities_id, users_id_requester. |
| `glpi_update_problem` | write | Update an existing problem by ID. |

### Search and counting (5)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_search` | read | Search GLPI items with criteria. itemtype: Ticket, User, Change, Problem, Computer, etc. Each criterion is {field, searchtype, value, link}: field = search option ID, searchtype = contains \| equals \| notequals \| lessthan \| morethan \| under, link = AND \| OR (omit on the first). Rows come keyed by the search option names in the GLPI user's language ('Título', 'ID', 'Status'...); named_columns=false keys them by option ID ('1', '2'...) instead. Use glpi_list_search_options to discover the option IDs for criteria, forcedisplay and sort. |
| `glpi_search_user_by_email` | read | Find users by exact email address (returns the user items: id, login, real name, first name...). |
| `glpi_list_search_options` | read | List available search fields for an itemtype. Critical for building search criteria with glpi_search. Returns field IDs, names, and types. |
| `glpi_count_items` | read | Count matching items without transferring them — answers 'how many' in one cheap call. Use glpi_list_search_options to discover criteria field IDs. |
| `glpi_get_ticket_stats` | read | Ticket counts per status (New, Processing, Pending, Solved, Closed) plus the total, without listing the tickets. Optional criteria narrow the scope, e.g. one entity: [{field: 80, searchtype: 'equals', value: <entity id>}] (Ticket search option IDs: 80 = entity, 4 = requester, 5 = technician, 7 = category; same criteria shape as glpi_search). |

### Assets and reservations (10)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_list_assets` | read | List assets of a given type (Computer, Monitor, Printer, NetworkEquipment, Peripheral, Phone, Software, Rack, Enclosure), with location_name, state_name and user_name beside the IDs. Use glpi_search for filtered queries. |
| `glpi_get_asset` | read | Retrieve a single asset by type and ID. For hardware detail use glpi_get_asset_details. |
| `glpi_get_asset_details` | read | Enriched asset view in one request: operating system, processors, memory and disks by default. Ask for sections ['softwares'] or ['networkports'] explicitly — on an inventoried host those are the bulk of the payload. Dropdown IDs come resolved to names. |
| `glpi_create_asset` | write | Create an asset. Common fields: name, entities_id, serial, otherserial, locations_id, states_id, manufacturers_id, users_id, comment. |
| `glpi_update_asset` | write | Update an existing asset by type and ID. |
| `glpi_list_reservation_items` | read | List items flagged as reservable (the catalogue reservations point at). |
| `glpi_list_reservations` | read | List reservations (bookings) of reservable items. |
| `glpi_get_reservation` | read | Retrieve a reservation by ID. |
| `glpi_create_reservation` | write | Book a reservable item. begin/end use 'YYYY-MM-DD HH:MM:SS'. reservationitems_id comes from glpi_list_reservation_items (not the asset ID). |
| `glpi_update_reservation` | write | Update an existing reservation by ID. |

### Webhooks (8)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_list_webhooks` | read | List configured webhooks (event, itemtype, target URL, active flag). Requires GLPI 10.0.7 or newer. |
| `glpi_get_webhook` | read | Retrieve a webhook definition by ID, including its payload template. |
| `glpi_create_webhook` | write | Create a webhook. Common fields: name, url, itemtype (e.g. Ticket), event (new, update, delete), is_active, payload, http_method, use_cra_challenge. |
| `glpi_update_webhook` | write | Update a webhook definition by ID. |
| `glpi_set_webhook_active` | write | Turn a webhook on or off without touching the rest of its definition. |
| `glpi_delete_webhook` | destructive | Delete a webhook. Set purge to remove it permanently instead of trashing it. |
| `glpi_list_webhook_deliveries` | read | Delivery queue (QueuedWebhook): what was sent, when, and what is still pending, newest first. Filter by webhook name, or only_failed to see what has been retried. |
| `glpi_retry_webhook_delivery` | write | Queue a failed delivery for another attempt by resetting its send time and retry counter. The GLPI cron does the actual sending — there is no immediate-send endpoint. |

### Users and groups (6)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_get_user` | read | Retrieve a user by ID. |
| `glpi_list_users` | read | List all users with optional pagination and dropdown expansion. |
| `glpi_create_user` | write | Create a new GLPI user. Required: name (login). Common: realname, firstname, password, email (via _useremails array). |
| `glpi_update_user` | write | Update an existing user by ID. |
| `glpi_list_groups` | read | List GLPI groups with optional pagination. |
| `glpi_get_group` | read | Retrieve a group by ID. |

### Entities (8)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_list_entities` | read | List GLPI entities (organizational units) with optional pagination. |
| `glpi_get_entity` | read | Retrieve an entity by ID. |
| `glpi_create_entity` | write | Create a new entity. Fields: name (required), entities_id (parent, 0=Root), comment, address, etc. |
| `glpi_update_entity` | write | Update an existing entity by ID. |
| `glpi_delete_entity` | destructive | Permanently delete an entity by ID. WARNING: irreversible action. |
| `glpi_change_active_entities` | write | Change the active entity for the current session. Essential for multi-entity GLPI instances. Use is_recursive=true to include sub-entities. |
| `glpi_get_my_entities` | read | Get the list of entities available to the current user. |
| `glpi_get_my_profiles` | read | Get the list of profiles available to the current user. |

### Documents (8)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_list_documents` | read | List documents with optional pagination. |
| `glpi_get_document` | read | Retrieve a document by ID. |
| `glpi_create_document` | write | Create a document (metadata). Fields: name, entities_id, comment, etc. |
| `glpi_delete_document` | destructive | Permanently delete a document by ID. |
| `glpi_list_document_items` | read | List links between documents and other items. |
| `glpi_get_document_item` | read | Retrieve a Document_Item link by ID. |
| `glpi_create_document_item` | write | Create a link between a document and an item (Ticket, KnowbaseItem, etc.). |
| `glpi_delete_document_item` | destructive | Remove a Document_Item link by ID. |

### Knowledge base (10)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_list_knowbase_items` | read | List knowledge base articles with optional pagination. |
| `glpi_get_knowbase_item` | read | Retrieve a knowledge base article by ID. |
| `glpi_create_knowbase_item` | write | Create a new knowledge base article. Fields: name, answer (HTML content), knowbaseitemcategories_id, etc. |
| `glpi_update_knowbase_item` | write | Update a knowledge base article by ID. |
| `glpi_delete_knowbase_item` | destructive | Permanently delete a knowledge base article. |
| `glpi_list_knowbase_categories` | read | List knowledge base categories with optional pagination. |
| `glpi_get_knowbase_category` | read | Retrieve a knowledge base category by ID. |
| `glpi_create_knowbase_category` | write | Create a new knowledge base category. |
| `glpi_update_knowbase_category` | write | Update a knowledge base category by ID. |
| `glpi_delete_knowbase_category` | destructive | Permanently delete a knowledge base category. |

### Rules (10)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_get_rule_ticket` | read | Retrieve a ticket business rule (RuleTicket) by ID. |
| `glpi_list_rule_ticket_criteria` | read | List criteria (conditions) of a specific ticket rule (sub-items of RuleTicket). |
| `glpi_list_rule_ticket_actions` | read | List actions of a specific ticket rule (sub-items of RuleTicket). |
| `glpi_list_rule_criteria` | read | List rule criteria via GET /RuleCriteria. Optionally filter by rules_id (works for any rule type: RuleTicket, RuleChange, RuleMailCollector). |
| `glpi_list_rule_actions` | read | List rule actions via GET /RuleAction. Optionally filter by rules_id (works for any rule type: RuleTicket, RuleChange, RuleMailCollector). |
| `glpi_update_rule_action` | write | Update a rule action by ID. Fields: action_type, field, value. |
| `glpi_list_rules` | read | List all ticket business rules (RuleTicket) with optional pagination. |
| `glpi_create_rule_ticket` | write | Create a new ticket business rule. Fields: name, match (AND/OR), is_active, sub_type, ranking, etc. |
| `glpi_create_rule_criteria` | write | Create a new criteria for a rule. Fields: rules_id, criteria (field name), condition, pattern. |
| `glpi_create_rule_action` | write | Create a new action for a rule. Fields: rules_id, action_type (assign/regex_result/append_regex_result), field, value. |

### Dropdowns and session (9)

| Tool | Kind | Description |
|------|------|-------------|
| `glpi_list_itil_followup_templates` | read | List ITIL followup templates (predefined followup texts). |
| `glpi_get_itil_followup_template` | read | Retrieve a followup template by ID. |
| `glpi_create_itil_followup_template` | write | Create a new followup template. Fields: name, content, comment, itemtype (Ticket/Change/Problem). |
| `glpi_update_itil_followup_template` | write | Update a followup template by ID. |
| `glpi_get_full_session` | read | Get the full session info including active entity, profile, and user details. Useful for debugging and verifying the current session context. |
| `glpi_list_itil_categories` | read | List ITIL categories (ticket/change/problem classification). |
| `glpi_get_itil_category` | read | Retrieve an ITIL category by ID. |
| `glpi_list_locations` | read | List GLPI locations with optional pagination. |
| `glpi_get_location` | read | Retrieve a location by ID. |
