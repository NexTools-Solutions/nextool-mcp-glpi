# mcp-glpi-v2 — Tools Reference

Complete reference for all 55 tools provided by mcp-glpi-v2. Tools are organized by category and listed with their registered name and description.

All list tools support common parameters: `filter` (RSQL), `start` (offset), `limit` (max items), `sort` (e.g. `name:asc`).

---

## Entities (5 tools)

API path: `/Administration/Entity`

| Tool | Description |
|------|-------------|
| `glpi_v2_list_entities` | List entities via /Administration/Entity. Supports RSQL filter, pagination and sorting. |
| `glpi_v2_get_entity` | Retrieve a single entity by ID. |
| `glpi_v2_create_entity` | Create a new entity. Fields: name (required), comment, entities_id (parent). |
| `glpi_v2_update_entity` | Update an existing entity by ID. |
| `glpi_v2_delete_entity` | Delete an entity by ID. Use force=true for permanent deletion. |

---

## Tickets (5 tools)

API path: `/Assistance/Ticket`

| Tool | Description |
|------|-------------|
| `glpi_v2_list_tickets` | List tickets via /Assistance/Ticket. Supports RSQL filter, pagination and sorting. |
| `glpi_v2_get_ticket` | Retrieve a single ticket by ID. |
| `glpi_v2_create_ticket` | Create a new ticket. Fields: name (required), content, type, priority, urgency, impact, etc. |
| `glpi_v2_update_ticket` | Update an existing ticket by ID. |
| `glpi_v2_delete_ticket` | Delete a ticket by ID. Use force=true for permanent deletion. |

---

## Changes (4 tools)

API path: `/Assistance/Change`

| Tool | Description |
|------|-------------|
| `glpi_v2_list_changes` | List change requests via /Assistance/Change. Supports RSQL filter, pagination and sorting. |
| `glpi_v2_get_change` | Retrieve a single change by ID. |
| `glpi_v2_create_change` | Create a new change request. |
| `glpi_v2_update_change` | Update an existing change by ID. |

---

## Problems (4 tools)

API path: `/Assistance/Problem`

| Tool | Description |
|------|-------------|
| `glpi_v2_list_problems` | List problems via /Assistance/Problem. Supports RSQL filter, pagination and sorting. |
| `glpi_v2_get_problem` | Retrieve a single problem by ID. |
| `glpi_v2_create_problem` | Create a new problem. |
| `glpi_v2_update_problem` | Update an existing problem by ID. |

---

## Timeline (6 tools)

API path: `/Assistance/{Ticket|Change|Problem}/{id}/Timeline`

All timeline tools accept `itemtype` (`Ticket`, `Change`, or `Problem`) and `itemId`.

| Tool | Description |
|------|-------------|
| `glpi_v2_list_timeline` | List all timeline entries (followups, solutions, tasks, validations) for an ITIL item. |
| `glpi_v2_add_followup` | Add a followup to a Ticket, Change or Problem. |
| `glpi_v2_add_solution` | Add a solution to a Ticket, Change or Problem. |
| `glpi_v2_add_task` | Add a task to a Ticket, Change or Problem. |
| `glpi_v2_add_validation` | Request validation for a Ticket, Change or Problem. |
| `glpi_v2_update_validation` | Approve or refuse a validation request. |

---

## Team Members (3 tools)

API path: `/Assistance/{Ticket|Change|Problem}/{id}/TeamMember`

All team member tools accept `itemtype` (`Ticket`, `Change`, or `Problem`) and `itemId`.

| Tool | Description |
|------|-------------|
| `glpi_v2_list_team_members` | List all team members (requester, assigned, observer, etc.) of an ITIL item. |
| `glpi_v2_add_team_member` | Add a user, group or supplier as a team member to an ITIL item. Member types: 1=requester, 2=assigned, 3=observer. |
| `glpi_v2_remove_team_member` | Remove a team member from an ITIL item. |

---

## Users (5 tools)

API path: `/Administration/User`

| Tool | Description |
|------|-------------|
| `glpi_v2_list_users` | List users via /Administration/User. Supports RSQL filter, pagination and sorting. |
| `glpi_v2_get_user` | Retrieve a single user by ID. |
| `glpi_v2_get_me` | Retrieve the currently authenticated user's profile. |
| `glpi_v2_create_user` | Create a new user. |
| `glpi_v2_update_user` | Update an existing user by ID. |

---

## Groups (3 tools)

API path: `/Administration/Group`

| Tool | Description |
|------|-------------|
| `glpi_v2_list_groups` | List groups via /Administration/Group. Supports RSQL filter, pagination and sorting. |
| `glpi_v2_get_group` | Retrieve a single group by ID. |
| `glpi_v2_create_group` | Create a new group. |

---

## Knowledgebase (6 tools)

API paths: `/Knowledgebase/Article`, `/Knowledgebase/Category`

| Tool | Description |
|------|-------------|
| `glpi_v2_list_kb_articles` | List knowledge base articles. Supports RSQL filter, pagination and sorting. |
| `glpi_v2_get_kb_article` | Retrieve a single knowledge base article by ID. |
| `glpi_v2_create_kb_article` | Create a new knowledge base article. |
| `glpi_v2_update_kb_article` | Update an existing knowledge base article by ID. |
| `glpi_v2_list_kb_categories` | List knowledge base categories. Supports RSQL filter, pagination and sorting. |
| `glpi_v2_get_kb_category` | Retrieve a single knowledge base category by ID. |

---

## Dropdowns (4 tools)

API path: `/Dropdowns/{type}`

| Tool | Description |
|------|-------------|
| `glpi_v2_list_itil_categories` | List ITIL categories (ticket classification). Supports RSQL filter, pagination and sorting. |
| `glpi_v2_get_itil_category` | Retrieve a single ITIL category by ID. |
| `glpi_v2_list_locations` | List locations dropdown. Supports RSQL filter, pagination and sorting. |
| `glpi_v2_list_request_types` | List request types dropdown. Supports RSQL filter, pagination and sorting. |

---

## Documents (4 tools)

API path: `/Management/Document`

| Tool | Description |
|------|-------------|
| `glpi_v2_list_documents` | List documents via /Management/Document. Supports RSQL filter, pagination and sorting. |
| `glpi_v2_get_document` | Retrieve document metadata by ID. |
| `glpi_v2_create_document` | Create a new document record (metadata only — file upload requires multipart). |
| `glpi_v2_download_document` | Download a document by ID. Returns the file content (may be base64 or raw text depending on type). |

---

## Rules (4 tools)

API path: `/Rule/Collection`

| Tool | Description |
|------|-------------|
| `glpi_v2_list_rule_collections` | List all available rule collections (e.g. RuleTicket, RuleMailCollector, etc.). |
| `glpi_v2_list_rules` | List rules within a specific collection. |
| `glpi_v2_get_rule` | Retrieve a single rule by collection and ID. |
| `glpi_v2_create_rule` | Create a new rule within a collection. |

---

## Session & Health (2 tools)

| Tool | Description |
|------|-------------|
| `glpi_v2_get_session` | Get current session information (active profile, entity, etc.). |
| `glpi_v2_health_check` | Check GLPI instance status and API availability. |

---

## Common Parameters

### List Parameters

All `list_*` tools accept these optional parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `filter` | string | RSQL filter expression (e.g. `name=like=Client`, `status==2`) |
| `start` | number | Offset for pagination (default: 0) |
| `limit` | number | Maximum items to return (default: 100) |
| `sort` | string | Sort expression (e.g. `name:asc`, `date_creation:desc`) |

### RSQL Filter Syntax

The v2 API uses RSQL for filtering. Common operators:

| Operator | Meaning | Example |
|----------|---------|---------|
| `==` | Equal | `status==2` |
| `!=` | Not equal | `status!=6` |
| `=like=` | Contains (like) | `name=like=server` |
| `=gt=` | Greater than | `id=gt=100` |
| `=lt=` | Less than | `priority=lt=3` |
| `=ge=` | Greater or equal | `date_creation=ge=2025-01-01` |
| `=le=` | Less or equal | `date_mod=le=2025-12-31` |
| `;` | AND | `status==2;priority=gt=3` |
| `,` | OR | `status==2,status==3` |

### ITIL Item Types

Timeline and Team Member tools accept `itemtype` which must be one of:
- `Ticket`
- `Change`
- `Problem`

### Team Member Types

When adding a team member, the `type` field determines their role:
- `1` — Requester
- `2` — Assigned
- `3` — Observer
