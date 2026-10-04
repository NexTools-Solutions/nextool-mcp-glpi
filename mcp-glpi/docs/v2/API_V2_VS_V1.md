# GLPI API v2 vs v1 — Comparison Guide

This document compares the two GLPI REST API versions to help you understand the differences and choose the right MCP for your use case.

---

## Overview

| Aspect | API v1 (apirest.php / api.php/v1) | API v2 (api.php/v2) |
|--------|----------------------------------|---------------------|
| **GLPI versions** | 9.5, 10.x, 11.x | 11.0+ only |
| **MCP package** | mcp-glpi | mcp-glpi-v2 |
| **Tools count** | 89 | 55 |
| **Maturity** | Stable, widely deployed | Newer, GLPI 11 native |
| **Status** | Maintained (legacy support) | Actively developed |

---

## Authentication

### v1 — Session Tokens

The v1 API uses session-based authentication. You initiate a session and get a token that must be sent with every request.

```
POST /apirest.php/initSession
Headers:
  Authorization: user_token <user_token>
  App-Token: <app_token>           (optional)

Response:
  { "session_token": "abc123..." }
```

Every subsequent request must include:
```
Session-Token: abc123...
App-Token: <app_token>
```

**Drawbacks:** Session tokens expire, require explicit `killSession`, and do not follow standard auth flows.

### v2 — OAuth2 Password Grant

The v2 API uses standard OAuth2 with token caching and automatic renewal.

```
POST /api.php/token
Content-Type: application/x-www-form-urlencoded

grant_type=password
&client_id=<client_id>
&client_secret=<client_secret>
&username=<username>
&password=<password>
&scope=api

Response:
  {
    "token_type": "Bearer",
    "expires_in": 3600,
    "access_token": "eyJ..."
  }
```

Every subsequent request uses:
```
Authorization: Bearer eyJ...
```

**Advantages:** Standard protocol, automatic expiry handling, no explicit session management.

---

## API Paths

### v1

The v1 API uses a flat path structure under `/apirest.php/` (classic) or `/api.php/v1/` (GLPI 11):

```
GET  /apirest.php/Ticket/123
GET  /apirest.php/User/5
GET  /apirest.php/KnowbaseItem/10
POST /apirest.php/Ticket
```

### v2

The v2 API organizes endpoints into controllers with a hierarchical structure:

```
GET  /api.php/v2/Assistance/Ticket/123
GET  /api.php/v2/Administration/User/5
GET  /api.php/v2/Knowledgebase/Article/10
POST /api.php/v2/Assistance/Ticket
```

**Controller mapping:**

| v1 path | v2 controller | v2 path |
|---------|--------------|---------|
| `/Ticket` | Assistance | `/Assistance/Ticket` |
| `/Change` | Assistance | `/Assistance/Change` |
| `/Problem` | Assistance | `/Assistance/Problem` |
| `/User` | Administration | `/Administration/User` |
| `/Group` | Administration | `/Administration/Group` |
| `/Entity` | Administration | `/Administration/Entity` |
| `/KnowbaseItem` | Knowledgebase | `/Knowledgebase/Article` |
| `/KnowbaseItemCategory` | Knowledgebase | `/Knowledgebase/Category` |
| `/Document` | Management | `/Management/Document` |
| `/ITILCategory` | Dropdowns | `/Dropdowns/ITILCategory` |
| `/Location` | Dropdowns | `/Dropdowns/Location` |
| `/RequestType` | Dropdowns | `/Dropdowns/RequestType` |

---

## HTTP Methods — PUT vs PATCH

### v1 — Uses PUT

```
PUT /apirest.php/Ticket/123
Content-Type: application/json

{ "input": { "status": 5 } }
```

In v1, `PUT` is used for updates. The body requires an `input` wrapper.

### v2 — Uses PATCH

```
PATCH /api.php/v2/Assistance/Ticket/123
Content-Type: application/json

{ "status": 5 }
```

In v2, `PATCH` is used for partial updates. The body is sent directly without a wrapper.

---

## Request/Response Body Format

### v1 — Wrapped in `input`

Create and update operations require an `input` wrapper:

```json
// POST /apirest.php/Ticket
{
  "input": {
    "name": "Server down",
    "content": "Web server is not responding",
    "urgency": 4
  }
}
```

### v2 — Direct body

Create and update operations send fields directly:

```json
// POST /api.php/v2/Assistance/Ticket
{
  "name": "Server down",
  "content": "Web server is not responding",
  "urgency": 4
}
```

> **Note:** The MCP tools abstract this difference. When using `glpi_v2_create_ticket`, you pass an `input` object in the tool parameters, and the MCP handles sending it in the correct format to the API.

---

## Timeline — Unified vs Separate Endpoints

### v1 — Separate endpoints

Each timeline entry type has its own endpoint:

```
GET  /apirest.php/Ticket/123/ITILFollowup        # list followups
POST /apirest.php/Ticket/123/ITILFollowup         # add followup
GET  /apirest.php/Ticket/123/ITILSolution         # list solutions
POST /apirest.php/Ticket/123/ITILSolution         # add solution
GET  /apirest.php/Ticket/123/TicketTask           # list tasks
POST /apirest.php/Ticket/123/TicketTask           # add task
GET  /apirest.php/Ticket/123/TicketValidation     # list validations
POST /apirest.php/Ticket/123/TicketValidation     # add validation
```

### v2 — Unified Timeline endpoint

All timeline entries are accessed through a single endpoint:

```
GET  /api.php/v2/Assistance/Ticket/123/Timeline           # list ALL entries
POST /api.php/v2/Assistance/Ticket/123/Timeline            # add followup/solution
POST /api.php/v2/Assistance/Ticket/123/Timeline/Task       # add task
POST /api.php/v2/Assistance/Ticket/123/Timeline/Validation # add validation
```

The `type` field in the POST body differentiates entry types:
- `ITILFollowup` for followups
- `ITILSolution` for solutions

**Advantages of v2:**
- Single `list_timeline` call returns all entry types in chronological order.
- Easier to display a complete conversation view.
- Works the same for Tickets, Changes, and Problems.

---

## Team Members — Unified vs Separate Tables

### v1 — Separate relationship tables

Each team member type has its own endpoint per ITIL item type:

```
GET  /apirest.php/Ticket/123/Ticket_User           # users on ticket
POST /apirest.php/Ticket/123/Ticket_User            # add user
GET  /apirest.php/Ticket/123/Group_Ticket           # groups on ticket
POST /apirest.php/Ticket/123/Group_Ticket            # add group
GET  /apirest.php/Ticket/123/Supplier_Ticket        # suppliers on ticket
```

### v2 — Unified TeamMember endpoint

```
GET    /api.php/v2/Assistance/Ticket/123/TeamMember     # list all members
POST   /api.php/v2/Assistance/Ticket/123/TeamMember     # add member
DELETE /api.php/v2/Assistance/Ticket/123/TeamMember/456  # remove member
```

The member data specifies the type:
```json
{
  "itemtype": "User",
  "items_id": 5,
  "type": 2
}
```

Where `type`: 1=requester, 2=assigned, 3=observer.

**Advantages of v2:**
- Single endpoint for all member types (users, groups, suppliers).
- Consistent interface across Tickets, Changes, and Problems.
- Simpler to manage team composition.

---

## Filtering — GET Parameters vs RSQL

### v1 — GET parameters

```
GET /apirest.php/Ticket?searchText[name]=server&range=0-9&sort=1&order=DESC
```

For advanced filtering, v1 uses the `search` endpoint with criteria arrays:
```
GET /apirest.php/search/Ticket?criteria[0][field]=12&criteria[0][searchtype]=equals&criteria[0][value]=2
```

### v2 — RSQL syntax

```
GET /api.php/v2/Assistance/Ticket?filter=name=like=server&start=0&limit=10&sort=name:desc
```

RSQL operators:
| Operator | Meaning |
|----------|---------|
| `==` | Equals |
| `!=` | Not equals |
| `=like=` | Contains |
| `=gt=` | Greater than |
| `=lt=` | Less than |
| `=ge=` | Greater or equal |
| `=le=` | Less or equal |
| `;` | AND |
| `,` | OR |

**Example — compound filter:**
```
filter=status==2;priority=gt=3,urgency=gt=3
```
This means: status is 2 AND (priority > 3 OR urgency > 3).

**Advantages of v2:**
- More expressive filter syntax.
- No need for the separate `search` endpoint with complex criteria arrays.
- Standard RSQL syntax used in many REST APIs.

---

## Dropdowns Endpoint

### v1

Dropdowns are accessed as regular item types:
```
GET /apirest.php/ITILCategory
GET /apirest.php/Location
GET /apirest.php/RequestType
```

### v2

Dropdowns have a dedicated controller:
```
GET /api.php/v2/Dropdowns/ITILCategory
GET /api.php/v2/Dropdowns/Location
GET /api.php/v2/Dropdowns/RequestType
```

The dedicated controller makes it clearer that these are reference data, not primary items.

---

## Rules

### v1

Rules are accessed by their specific type:
```
GET /apirest.php/RuleTicket
GET /apirest.php/RuleTicket/5
GET /apirest.php/RuleTicket/5/RuleAction
GET /apirest.php/RuleTicket/5/RuleCriteria
```

### v2

Rules are organized under a Collection hierarchy:
```
GET /api.php/v2/Rule/Collection                           # list all collections
GET /api.php/v2/Rule/Collection/RuleTicket/Rule           # list rules in collection
GET /api.php/v2/Rule/Collection/RuleTicket/Rule/5         # get specific rule
POST /api.php/v2/Rule/Collection/RuleTicket/Rule          # create rule
```

**Advantages of v2:**
- Discoverable — you can list all rule collections first.
- Consistent pattern for all rule types.

---

## Feature Comparison Matrix

| Feature | v1 | v2 |
|---------|----|----|
| Session token auth | Yes | No |
| OAuth2 auth | No | Yes |
| Token auto-refresh | Manual | Automatic |
| Wrapped body (`input`) | Required | Not used |
| Unified timeline | No | Yes |
| Unified team members | No | Yes |
| RSQL filters | No | Yes |
| Advanced search criteria | Yes | Not needed (RSQL) |
| Dropdown controller | No | Yes |
| Rule collections | No | Yes |
| `GET /Me` endpoint | No | Yes |
| Document download | Yes | Yes |
| Bulk operations | Yes (`input` array) | Not yet |
| Delete items | Yes | Yes |
| GLPI 9.5 / 10.x | Yes | No |
| GLPI 11.x | Yes | Yes |

---

## Migration Checklist

If migrating from mcp-glpi (v1) to mcp-glpi-v2:

1. **GLPI version:** Ensure you are running GLPI 11.0+.
2. **Enable API v2:** Setup > General > API > High-level API.
3. **Create OAuth2 app:** Setup > OAuth Applications.
4. **Update environment:** Replace `GLPI_URL` + `GLPI_USER_TOKEN` with `GLPI_V2_URL` + OAuth2 credentials.
5. **Update tool names:** All tools are prefixed with `glpi_v2_` instead of `glpi_`.
6. **Update input format:** Remove `input` wrappers from direct API calls (the MCP tools handle this).
7. **Update filters:** Replace `searchText` / `criteria` with RSQL syntax.
8. **Test:** Use `glpi_v2_health_check` and `glpi_v2_get_me` to verify connectivity.
