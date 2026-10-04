# NexTool MCP for GLPI

Connect Claude and other MCP clients to your GLPI. One MCP server for both GLPI APIs; each tool
family turns on with its own credentials:

| Family | API | Tools | Enabled by |
|--------|-----|-------|------------|
| `glpi_*` | classic REST (`apirest.php`) or `api.php/v1` — GLPI 9.5, 10 and 11 | 111 | `GLPI_URL` + `GLPI_USER_TOKEN` (+ `GLPI_APP_TOKEN`) |
| `glpi_v2_*` | High-level API v2 over OAuth2 — GLPI 11 | 55 | `GLPI_V2_URL` + `GLPI_V2_CLIENT_ID/SECRET` + `GLPI_V2_USERNAME/PASSWORD` |

Until 2.x the v2 family was a separate package (`mcp-glpi-v2`); since 3.0.0 it lives here, with
the same tool names and schemas. Both families share the write policy, payload formatting and
create idempotency below.

> Not affiliated with Teclib'. GLPI is a registered trademark of Teclib'.

**Tool selection.** `GLPI_TOOLSETS` picks named presets (`tickets,kb`; see
[Toolsets](#toolsets)); `GLPI_TOOLS_INCLUDE` / `GLPI_TOOLS_EXCLUDE` take comma-separated globs
on tool names (`glpi_*ticket*,glpi_search`, `*webhook*`). Toolsets and include globs add up;
exclude always wins; with neither toolsets nor include globs every tool registers. An unknown
toolset name fails at startup. Fewer tools, less context per session.

Several instances can share this one binary with different env files.

## Two ways to run

| Entry | Transport | Instances | Authentication |
|-------|-----------|-----------|----------------|
| `dist/index.js` (`mcp-glpi`) | stdio | one, from the environment | none (local process) |
| `dist/http.js` (`mcp-glpi-http`) | Streamable HTTP, `/mcp/<instance>` | many, from `MCP_INSTANCES_FILE` | `Authorization: Bearer <key>`, required |

The HTTP entry is the one meant to serve every NexTool environment from one place. A key
opens only the instances it was granted, a session stays bound to the key and instance that
opened it, GLPI sessions, OAuth tokens and catalogue caches are kept per credential, and
create idempotency is shared per instance across sessions. One JSON audit line per request
goes to stdout (key, instance, methods, tools; never arguments or credentials).
`GET /healthz` answers without authentication.

Keys live in the instances file as SHA-256 hashes only (mode 600; it is re-read when it changes):

```json
{
  "instances": {
    "acme": { "env": { "GLPI_URL": "https://glpi.acme.example", "GLPI_USER_TOKEN": "…", "GLPI_APP_TOKEN": "…" } }
  },
  "keys": [{ "name": "laptop", "sha256": "<sha256 hex of the key>", "instances": ["acme"] }]
}
```

```bash
KEY=$(openssl rand -hex 32)                       # give it to the client once
printf %s "$KEY" | sha256sum | cut -d' ' -f1      # goes into "sha256"
MCP_INSTANCES_FILE=instances.json MCP_HTTP_PORT=8787 npx mcp-glpi-http
```

A hosted, multi-tenant version with sign-in through the NexTool portal is available at
https://mcp.nextoolsolutions.com/mcp.

Other variables: `MCP_HTTP_HOST` (default 127.0.0.1), `MCP_ALLOWED_HOSTS` (Host header
allowlist), `MCP_SESSION_IDLE_MIN` (default 30). The file is re-read when it changes.

## What it exposes

- **111 API v1 tools** (60 read / 42 write / 9 destructive) over tickets, changes, problems, the
  unified timeline, validations, assets and reservations, webhooks, users, groups, entities,
  documents, the knowledge base, rules and search.
- **4 resources** (`glpi://entities`, `glpi://itil-categories`, `glpi://request-types`,
  `glpi://code-maps`) so catalogue lookups do not cost a tool call.
- **4 prompts** for triage, recurrence investigation, requester history and asset context. A prompt
  is offered only when every tool it names is registered (with `GLPI_TOOLSETS=kb` there is none).

- **55 API v2 tools** (`glpi_v2_*`): entities, ITIL with team members and timeline, users,
  groups, knowledge base, dropdowns, documents, rules, session and health check.

### Listing tickets

| Need | Tool | Defaults |
|------|------|----------|
| "My tickets" (the connected user's) | `glpi_list_my_tickets` | open only, latest update first, any role |
| Tickets of the whole instance | `glpi_list_tickets` | every status, latest update first |
| Arbitrary criteria | `glpi_search` | GLPI search order |

- `glpi_list_my_tickets`: `role` (`any` \| `requester` \| `assigned` \| `observer`), `status`,
  `sort`, `order`, `range`, `users_id` (another user; default the session user from
  `getFullSession`). Rows carry `requesters` / `assigned` / `observers` as `{id, name}`,
  `requester_groups`, `assigned_groups`, `status_name`, `type_name` and `my_roles`; the result
  also has `total` and `user`.
- `glpi_list_tickets`: new `status`, `sort` and `order` (the old `range` and `expand_dropdowns`
  keep working). With a status filter the result also has `total`.
- `status` takes one name or a list: `new`, `assigned` (= `processing`), `planned`, `pending`,
  `solved`, `closed`, and `open` (= new + assigned + planned + pending, GLPI's "not old").
- `sort`: `date_mod` (default), `date`, `id`, `priority`, `status`, `name`, `solvedate`,
  `closedate`; `order`: `desc` (default) or `asc`.
- `glpi_v2_list_tickets` takes the same `status` names and sorts by `date_mod:desc` by default.
  The v2 API cannot filter on the team (GLPI 11.0.7 ignores or rejects a `team` filter), so
  "my tickets" is a v1 tool.
- `glpi_list_changes` / `glpi_list_problems` (and the v2 ones) also default to latest update first.

### Names next to IDs

Sub-items keep their IDs and gain names: `glpi_list_ticket_users` (`user_name`, `type_name`),
`glpi_list_ticket_groups` (`group_name`, `type_name`), followups (`user_name`), tasks
(`user_name`, `tech_name`, `tech_group_name`), validations (`user_name`, `validator_name`,
`status_name`), `glpi_list_timeline` (all of these, plus `solutiontype_name` and
`user_name_approval` on solutions) and `glpi_get_ticket` (`recipient_name`, `category_name`,
`entity_name`, `requesttype_name`, `location_name`, `status_name`, `type_name`). Names are read
with GET /<itemtype>/<id> through a 5-minute cache per credential; a name the user cannot read
stays `null`. `glpi_search` takes `named_columns: true` to key rows by search option name.

Full reference: [`docs/TOOLS.md`](docs/TOOLS.md) (v1) and [`docs/v2/TOOLS.md`](docs/v2/TOOLS.md) (v2);
OAuth2 setup in [`docs/v2/SETUP.md`](docs/v2/SETUP.md).

## Toolsets

Named presets for `GLPI_TOOLSETS` (or the `toolsets` option of `instanceFromConfig`). Domain
presets hold both families; a family still needs its credentials to register. A tool can be in
more than one preset, and every tool is in at least one besides `core` (asserted by the tests).
`core` is the lean default for hosted use: every read tool of the everyday presets (no webhook,
rule or session internals) plus the non-destructive ticket operations.

Presets are self-contained (asserted by the tests): a tool named in another tool's description
or parameters is in every preset that holds the tool naming it. That is why `tickets` carries
`glpi_search` / `glpi_list_search_options` and the user/group reads that put names on people,
and `assets` carries the generic search its list tool points to.

| Preset | Tools (v1 + v2) | What |
|--------|-----------------|------|
| `core` | 93 (59 + 34) | reads of tickets/itil/assets/kb/documents/users/search + entity and people reads, plus create/update ticket, followup, solution, task, validation, actors |
| `tickets` | 53 (33 + 20) | ticket lifecycle incl. my tickets, plus search and user/group reads |
| `itil` | 46 (24 + 22) | problems and changes, shared timeline and categories, user/group reads |
| `assets` | 15 (14 + 1) | assets, reservations, locations, generic search |
| `kb` | 16 (10 + 6) | knowledge base |
| `documents` | 12 (8 + 4) | documents and document links |
| `users` | 15 (7 + 8) | users and groups |
| `search` | 3 (3 + 0) | generic search, counts, search options |
| `admin` | 42 (31 + 11) | entities, session/profile, rules, followup templates, webhooks |
| `v2` | 55 (0 + 55) | every `glpi_v2_*` tool |

Before 3.4.0: core 92, tickets 42, itil 38, assets 13 (the others are unchanged).

<details>
<summary>Tools in each preset</summary>

#### core (93: 59 v1 + 34 v2)
Lean default: every read tool of the everyday presets plus the non-destructive ticket operations

v1: `glpi_list_tickets`, `glpi_list_my_tickets`, `glpi_get_ticket`, `glpi_list_followups`, `glpi_list_timeline`, `glpi_list_ticket_validations`, `glpi_list_ticket_users`, `glpi_list_ticket_groups`, `glpi_list_ticket_tasks`, `glpi_get_ticket_stats`, `glpi_list_itil_categories`, `glpi_get_itil_category`, `glpi_list_itil_followup_templates`, `glpi_get_itil_followup_template`, `glpi_list_changes`, `glpi_get_change`, `glpi_list_change_followups`, `glpi_list_change_tasks`, `glpi_list_problems`, `glpi_get_problem`, `glpi_list_problem_followups`, `glpi_list_problem_tasks`, `glpi_list_assets`, `glpi_get_asset`, `glpi_get_asset_details`, `glpi_list_reservation_items`, `glpi_list_reservations`, `glpi_get_reservation`, `glpi_list_locations`, `glpi_get_location`, `glpi_list_knowbase_items`, `glpi_get_knowbase_item`, `glpi_list_knowbase_categories`, `glpi_get_knowbase_category`, `glpi_list_documents`, `glpi_get_document`, `glpi_list_document_items`, `glpi_get_document_item`, `glpi_get_user`, `glpi_search_user_by_email`, `glpi_list_users`, `glpi_list_groups`, `glpi_get_group`, `glpi_search`, `glpi_count_items`, `glpi_list_search_options`, `glpi_list_entities`, `glpi_get_entity`, `glpi_get_my_entities`, `glpi_get_my_profiles`, `glpi_create_ticket`, `glpi_update_ticket`, `glpi_add_followup`, `glpi_add_solution`, `glpi_create_ticket_validation`, `glpi_update_ticket_validation`, `glpi_add_ticket_user`, `glpi_add_ticket_group`, `glpi_add_ticket_task`

v2: `glpi_v2_list_tickets`, `glpi_v2_get_ticket`, `glpi_v2_list_timeline`, `glpi_v2_list_team_members`, `glpi_v2_list_itil_categories`, `glpi_v2_get_itil_category`, `glpi_v2_list_request_types`, `glpi_v2_list_changes`, `glpi_v2_get_change`, `glpi_v2_list_problems`, `glpi_v2_get_problem`, `glpi_v2_list_locations`, `glpi_v2_list_kb_articles`, `glpi_v2_get_kb_article`, `glpi_v2_list_kb_categories`, `glpi_v2_get_kb_category`, `glpi_v2_list_documents`, `glpi_v2_get_document`, `glpi_v2_download_document`, `glpi_v2_list_users`, `glpi_v2_get_user`, `glpi_v2_get_me`, `glpi_v2_list_groups`, `glpi_v2_get_group`, `glpi_v2_list_entities`, `glpi_v2_get_entity`, `glpi_v2_create_ticket`, `glpi_v2_update_ticket`, `glpi_v2_add_followup`, `glpi_v2_add_solution`, `glpi_v2_add_task`, `glpi_v2_add_validation`, `glpi_v2_update_validation`, `glpi_v2_add_team_member`

#### tickets (53: 33 v1 + 20 v2)
Ticket lifecycle (my tickets, followups, solutions, tasks, validations, actors, timeline) plus the search and user/group reads it points to

v1: `glpi_list_tickets`, `glpi_list_my_tickets`, `glpi_get_ticket`, `glpi_create_ticket`, `glpi_update_ticket`, `glpi_add_followup`, `glpi_list_followups`, `glpi_add_solution`, `glpi_list_timeline`, `glpi_list_ticket_validations`, `glpi_create_ticket_validation`, `glpi_update_ticket_validation`, `glpi_delete_ticket_validation`, `glpi_list_ticket_users`, `glpi_add_ticket_user`, `glpi_delete_ticket_user`, `glpi_list_ticket_groups`, `glpi_add_ticket_group`, `glpi_delete_ticket_group`, `glpi_list_ticket_tasks`, `glpi_add_ticket_task`, `glpi_get_ticket_stats`, `glpi_list_itil_categories`, `glpi_get_itil_category`, `glpi_list_itil_followup_templates`, `glpi_get_itil_followup_template`, `glpi_search`, `glpi_list_search_options`, `glpi_get_user`, `glpi_search_user_by_email`, `glpi_list_users`, `glpi_get_group`, `glpi_list_groups`

v2: `glpi_v2_list_tickets`, `glpi_v2_get_ticket`, `glpi_v2_create_ticket`, `glpi_v2_update_ticket`, `glpi_v2_delete_ticket`, `glpi_v2_list_timeline`, `glpi_v2_add_followup`, `glpi_v2_add_solution`, `glpi_v2_add_task`, `glpi_v2_add_validation`, `glpi_v2_update_validation`, `glpi_v2_list_team_members`, `glpi_v2_add_team_member`, `glpi_v2_remove_team_member`, `glpi_v2_list_itil_categories`, `glpi_v2_get_itil_category`, `glpi_v2_list_request_types`, `glpi_v2_get_user`, `glpi_v2_get_me`, `glpi_v2_get_group`

#### itil (46: 24 v1 + 22 v2)
Problems and changes (plus the shared ITIL timeline and categories, and the user/group reads)

v1: `glpi_list_changes`, `glpi_get_change`, `glpi_create_change`, `glpi_update_change`, `glpi_list_change_followups`, `glpi_add_change_followup`, `glpi_add_change_solution`, `glpi_list_change_tasks`, `glpi_list_problems`, `glpi_get_problem`, `glpi_create_problem`, `glpi_update_problem`, `glpi_list_problem_followups`, `glpi_add_problem_followup`, `glpi_add_problem_solution`, `glpi_list_problem_tasks`, `glpi_list_timeline`, `glpi_list_itil_categories`, `glpi_get_itil_category`, `glpi_get_user`, `glpi_search_user_by_email`, `glpi_list_users`, `glpi_get_group`, `glpi_list_groups`

v2: `glpi_v2_list_changes`, `glpi_v2_get_change`, `glpi_v2_create_change`, `glpi_v2_update_change`, `glpi_v2_list_problems`, `glpi_v2_get_problem`, `glpi_v2_create_problem`, `glpi_v2_update_problem`, `glpi_v2_list_timeline`, `glpi_v2_add_followup`, `glpi_v2_add_solution`, `glpi_v2_add_task`, `glpi_v2_add_validation`, `glpi_v2_update_validation`, `glpi_v2_list_team_members`, `glpi_v2_add_team_member`, `glpi_v2_remove_team_member`, `glpi_v2_list_itil_categories`, `glpi_v2_get_itil_category`, `glpi_v2_get_user`, `glpi_v2_get_me`, `glpi_v2_get_group`

#### assets (15: 14 v1 + 1 v2)
Assets, reservations and locations (plus generic search)

v1: `glpi_list_assets`, `glpi_get_asset`, `glpi_get_asset_details`, `glpi_create_asset`, `glpi_update_asset`, `glpi_list_reservation_items`, `glpi_list_reservations`, `glpi_get_reservation`, `glpi_create_reservation`, `glpi_update_reservation`, `glpi_list_locations`, `glpi_get_location`, `glpi_search`, `glpi_list_search_options`

v2: `glpi_v2_list_locations`

#### kb (16: 10 v1 + 6 v2)
Knowledge base articles and categories

v1: `glpi_list_knowbase_items`, `glpi_get_knowbase_item`, `glpi_create_knowbase_item`, `glpi_update_knowbase_item`, `glpi_delete_knowbase_item`, `glpi_list_knowbase_categories`, `glpi_get_knowbase_category`, `glpi_create_knowbase_category`, `glpi_update_knowbase_category`, `glpi_delete_knowbase_category`

v2: `glpi_v2_list_kb_articles`, `glpi_v2_get_kb_article`, `glpi_v2_create_kb_article`, `glpi_v2_update_kb_article`, `glpi_v2_list_kb_categories`, `glpi_v2_get_kb_category`

#### documents (12: 8 v1 + 4 v2)
Documents and their links to items

v1: `glpi_list_documents`, `glpi_get_document`, `glpi_create_document`, `glpi_delete_document`, `glpi_list_document_items`, `glpi_get_document_item`, `glpi_create_document_item`, `glpi_delete_document_item`

v2: `glpi_v2_list_documents`, `glpi_v2_get_document`, `glpi_v2_create_document`, `glpi_v2_download_document`

#### users (15: 7 v1 + 8 v2)
Users and groups

v1: `glpi_get_user`, `glpi_search_user_by_email`, `glpi_list_users`, `glpi_create_user`, `glpi_update_user`, `glpi_list_groups`, `glpi_get_group`

v2: `glpi_v2_list_users`, `glpi_v2_get_user`, `glpi_v2_get_me`, `glpi_v2_create_user`, `glpi_v2_update_user`, `glpi_v2_list_groups`, `glpi_v2_get_group`, `glpi_v2_create_group`

#### search (3: 3 v1 + 0 v2)
Generic search, counts and search options

v1: `glpi_search`, `glpi_count_items`, `glpi_list_search_options`

#### admin (42: 31 v1 + 11 v2)
Entities, session/profile context, business rules, followup templates, webhooks

v1: `glpi_list_entities`, `glpi_get_entity`, `glpi_get_my_entities`, `glpi_get_my_profiles`, `glpi_create_entity`, `glpi_update_entity`, `glpi_delete_entity`, `glpi_change_active_entities`, `glpi_get_full_session`, `glpi_list_rules`, `glpi_get_rule_ticket`, `glpi_list_rule_ticket_criteria`, `glpi_list_rule_ticket_actions`, `glpi_list_rule_criteria`, `glpi_list_rule_actions`, `glpi_create_rule_ticket`, `glpi_create_rule_criteria`, `glpi_create_rule_action`, `glpi_update_rule_action`, `glpi_list_itil_followup_templates`, `glpi_get_itil_followup_template`, `glpi_create_itil_followup_template`, `glpi_update_itil_followup_template`, `glpi_list_webhooks`, `glpi_get_webhook`, `glpi_create_webhook`, `glpi_update_webhook`, `glpi_set_webhook_active`, `glpi_delete_webhook`, `glpi_list_webhook_deliveries`, `glpi_retry_webhook_delivery`

v2: `glpi_v2_list_entities`, `glpi_v2_get_entity`, `glpi_v2_create_entity`, `glpi_v2_update_entity`, `glpi_v2_delete_entity`, `glpi_v2_list_rule_collections`, `glpi_v2_list_rules`, `glpi_v2_get_rule`, `glpi_v2_create_rule`, `glpi_v2_get_session`, `glpi_v2_health_check`

#### v2 (55: 0 v1 + 55 v2)
Every GLPI 11 API v2 tool (glpi_v2_*)

</details>

## As a library

The package root exports the server factory; importing it never starts a transport (the stdio
and HTTP servers are the `mcp-glpi` and `mcp-glpi-http` bins).

```ts
import { createGlpiServer, instanceFromConfig } from "@nextoolsolutions/mcp-glpi";

const instance = instanceFromConfig({
  id: "acme",                                   // lowercase letters, digits, "-"
  v1: { url: "https://glpi.acme.com", userToken, appToken },
  v2: { url: "https://glpi.acme.com", clientId, clientSecret, username, password, scope: "api", apiVersion: "v2.2" },
  policy: { readOnly: true, allowDelete: false }, // defaults: false / false / requireDeleteReason true
  toolsets: ["core"],                           // or "tickets,kb"
  toolsInclude: ["glpi_search"],                // globs, add to toolsets
  toolsExclude: ["*delete*"],                   // globs, always win
  fetchImpl,                                    // optional, see below
});
const { server, summary } = createGlpiServer(instance, { fetchImpl, idempotencyStore });
await server.connect(transport);
```

`instanceFromConfig` never reads `process.env` and throws on an invalid id or URL, on unknown
toolsets and when neither `v1` nor `v2` is given. `instanceFromEnv(id, env)` builds the same
thing from `GLPI_*` variables. Also exported: `SERVER_VERSION`, the `InstanceConfig` /
`InstanceEnv` / `InstanceOptions` types, `TOOLSETS` / `TOOLSET_NAMES` / `parseToolsets`, the
error classes (`GlpiHttpError`, `GlpiApiError`, `GlpiV2ApiError`, `GlpiRedirectError`,
`GlpiPolicyError`) and `IdempotencyStore`.

**`fetchImpl`.** Same call shape as `fetch` (`(url, init) => Promise<Response>`), used for every
GLPI request: v1 session and calls, v2 token and calls, assets and webhooks. A host can inject
one that validates the resolved IP. It always receives `redirect: "manual"`.

## Safety defaults

- Destructive tools are **off** unless `GLPI_ALLOW_DELETE=true`, and require a written `reason`.
- `GLPI_READ_ONLY=true` blocks every write before it reaches GLPI — set on customer instances.
- Every tool publishes MCP annotations derived from its name: `title`, `readOnlyHint` (reads),
  `destructiveHint` (delete/purge/remove), `idempotentHint` (reads, `update_*`/`set_*`,
  deletes) and `openWorldHint: false`.
- Redirects are never followed: a 3xx from GLPI becomes `redirect not followed: <status> -> <host>`
  (`GlpiRedirectError`), so session and OAuth headers never reach another host.
- The v2 client only talks to the `GLPI_V2_URL` origin; an absolute URL to any other host is
  refused before a request goes out.
- Repeating a `create_`/`add_` call with identical arguments within 120s replays the first
  result (`replayed: true`) instead of creating a second record.

## Payload

Read tools default to `fields: "essential"`: GLPI's internal bookkeeping (SLA/OLA counters,
delay statistics, HAL links; API v2 durations) is dropped and TinyMCE richtext is flattened to
plain text. Pass `fields: "all"` for the raw payload.

`format: "markdown"` returns a table for listings and `key: value` lines for one item (long
texts never cut there). The markdown is in the text block **and** in `structuredContent`
(`{ data: "<markdown>", format: "markdown", count, note }`): clients that support structured
results (Claude among them) give the model `structuredContent`, so a text-only rendering was
ignored before 3.4.0. JSON stays the default.

Listings are bounded by count and by size:
- 25 items by default, at most 100 per call (`GLPI_DEFAULT_PAGE_SIZE`, `GLPI_MAX_PAGE_SIZE`;
  the ceiling was 200);
- texts longer than 300 characters are cut in listings (`GLPI_LIST_TEXT_MAX_CHARS`); open the
  item, or pass `fields: "all"`, for the full text. Ticket history listings (timeline,
  followups, tasks, validations) are not cut;
- one answer stays under 50,000 characters (`GLPI_MAX_RESPONSE_CHARS`): a longer listing is
  trimmed from the end.

The `note` says what happened and how to get the next page, naming only the tool's own
parameters (`Next page: range=68-135.` or `Next page: start=33 limit=33.`).

Item IDs are positive integers (a number or a string of digits; entity IDs may be 0). Anything
else (`"abc"`, `""`, `-1`, `1.5`) fails input validation before any request: an invalid ID used
to reach GLPI as `/ITILCategory/abc`, which answered with the first page of the collection.

Errors come back as `isError` with the GLPI message in the text and no `structuredContent`
(validating clients checked it against the output schema and replaced the message with a
schema error).

## Layout

- `src/lib.ts` — library entry (package root): `createGlpiServer`, `instanceFromConfig`, types
- `src/index.ts` — stdio entry (one instance from the environment)
- `src/http.ts` — HTTP entry: authentication, instance binding, sessions, audit
- `src/create-server.ts` — builds the server for one instance: safety layers, families, resources
- `src/instance.ts` — instance config from env or object (credentials, policy, tool selection) and credential cache keys
- `src/tools-v1.ts`, `src/tools-v2.ts` — tool registration per family
- `src/tool-filter.ts` — selection rule (toolsets + `GLPI_TOOLS_INCLUDE` / `GLPI_TOOLS_EXCLUDE`)
- `src/toolsets.ts` — named presets (`GLPI_TOOLSETS`)
- `src/glpi-client.ts` — API v1 client (tickets, ITIL, users, KB, rules, timeline)
- `src/glpi-v2-client.ts` — API v2 client (OAuth2 password grant with token cache)
- `src/assets-client.ts` — assets, reservations, counting
- `src/webhooks-client.ts` — webhooks and delivery queue (GLPI 10.0.7+)
- `src/ticket-lists.ts` — `glpi_list_tickets` sorting/status filter and `glpi_list_my_tickets`
- `src/names.ts` — names next to IDs (cached lookups) and the code maps
- `src/search-columns.ts` — search option names for `glpi_search` (`named_columns`)
- `src/ids.ts` — item ID schema
- `src/resources.ts`, `src/prompts.ts` — MCP resources and prompts
- `test/` — `npm test` (node --test, no extra dependency)

Shared infrastructure — HTTP transport with retry, write policy, payload formatting,
pagination and idempotency — lives in [`@nextoolsolutions/mcp-glpi-core`](../mcp-glpi-core),
declared as a semver dependency (`^1.2.0`).

## Development

Inside this repo the core resolves to the sibling folder: the lockfile links
`node_modules/@nextoolsolutions/mcp-glpi-core` to `../mcp-glpi-core`, and npm accepts the link
because the folder's version satisfies `^1.2.0`. So build the core first:

```bash
(cd ../mcp-glpi-core && npm ci && npm run build)   # the server loads the core's dist/
npm ci
npm test
npx tsc --noEmit
npx tsx src/index.ts     # needs GLPI_URL/GLPI_USER_TOKEN and/or the GLPI_V2_* variables
```

- After editing `mcp-glpi-core`, rebuild it (`npm run build` there).
- When the change needs a new core version, bump the core first, then the range here, then run
  `npm install` (it keeps the link and updates the lockfile).
- If the core folder's version does not satisfy the range, `npm ci` falls back to the npm
  registry. To link by hand: `npm install ../mcp-glpi-core --no-save` (or `npm link`).
- Release order: publish `@nextoolsolutions/mcp-glpi-core` first, then this package.
