/**
 * What a conversation with the model sees (3.5.0, findings of a real test with Claude):
 *
 *   13. glpi_search keys its rows by search option NAME by default (named_columns=false
 *       keeps the numeric IDs); glpi_list_my_tickets, which reads columns by number, is
 *       not affected.
 *   14. v1 labels (status, type, actor role, validation, priority) follow the language
 *       of the GLPI session, like the API v2 does; English when it cannot be read.
 *   15. Listings in format: "markdown" use a compact column set per kind of listing;
 *       the JSON result keeps every field.
 *   16. GLPI administration with writes (users/groups, entities, rules, webhooks) only
 *       in the `admin` preset.
 *   +   The `instructions` name only tools the server registered.
 *
 * GLPI is stubbed through `fetchImpl`; the server is driven by a real MCP client.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FetchImpl } from "@nextoolsolutions/mcp-glpi-core";

import {
  ADMIN_WRITE_TOOLS,
  DEFAULT_INSTRUCTIONS,
  EVERYDAY_TOOLSETS,
  LABELS,
  TOOLSETS,
  TOOLSET_NAMES,
  createGlpiServer,
  instanceFromConfig,
  labelsFor,
} from "../src/lib.js";

let seq = 0;
const uniq = (label: string) => `${label}-${process.pid}-${++seq}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Opts = Parameters<typeof instanceFromConfig>[0];

const V1 = { url: "https://glpi.example.com", userToken: "u" };
const V2 = { url: "https://glpi.example.com", clientId: "c", clientSecret: "s", username: "n", password: "p" };

interface Stub {
  language?: string | null;
  failSession?: boolean;
  calls: string[];
}

/** A small GLPI: tickets 10 and 11, users 7/8/9, category 3, search options in pt_BR. */
function glpi(stub: Stub): FetchImpl {
  return async (url) => {
    const u = new URL(url);
    const path = u.pathname;
    stub.calls.push(path + u.search);
    if (path.endsWith("/initSession")) return json({ session_token: "s" });
    if (path.endsWith("/api.php/token")) return json({ access_token: "t", expires_in: 3600 });
    if (path.endsWith("/getFullSession")) {
      if (stub.failSession) return json(["ERROR", "nope"], 500);
      return json({ session: { glpiID: 7, glpifriendlyname: "Jane Doe", ...(stub.language ? { glpilanguage: stub.language } : {}) } });
    }
    if (path.includes("/listSearchOptions/")) {
      return json({ common: "Características", "1": { name: "Título" }, "2": { name: "ID" }, "12": { name: "Status" } });
    }
    if (path.includes("/search/Ticket")) {
      const q = decodeURIComponent(u.search);
      // Actor lookup of glpi_list_tickets: criteria on option 2 (id).
      if (/criteria\[0\]\[field\]=2/.test(q)) {
        return json({
          totalcount: 2,
          data: [
            { "2": 10, "4": "7", "5": ["8", "9"] },
            { "2": 11, "4": "requester@example.com", "5": null },
          ],
        });
      }
      return json({ totalcount: 1, data: [{ "1": "Printer down", "2": 10, "12": 5, "14": 1, "3": 4, "4": "7", "5": "8", "19": "2026-10-04 10:00:00" }] });
    }
    if (/\/Ticket\/10\/TicketValidation$/.test(path)) return json([{ id: 1, users_id: 7, users_id_validate: 8, status: 2 }]);
    if (/\/Ticket\/10\/Ticket_User$/.test(path)) return json([{ id: 1, users_id: 7, type: 1 }, { id: 2, users_id: 8, type: 2 }]);
    if (/\/Ticket\/10\/ITILFollowup$/.test(path)) {
      return json([{ id: 5, users_id: 7, content: "Restarted the spooler", date: "2026-10-04 09:00:00", is_private: 0 }]);
    }
    if (/\/Ticket\/10\/(TicketTask|ITILSolution)$/.test(path)) return json([]);
    if (/\/Ticket\/?$/.test(path)) {
      return json([
        { id: 10, name: "Printer down", status: 5, type: 1, priority: 4, itilcategories_id: 3, users_id_lastupdater: 368, date_mod: "2026-10-04 10:00:00", entities_id: 0 },
        { id: 11, name: "VPN", status: 1, type: 2, priority: 3, itilcategories_id: 0, users_id_lastupdater: 368, date_mod: "2026-10-03 10:00:00", entities_id: 0 },
      ]);
    }
    if (/\/Ticket\/10$/.test(path)) return json({ id: 10, name: "Printer down", status: 5, type: 1, priority: 4, urgency: 3, impact: 3 });
    if (/\/User\/(\d+)$/.test(path)) {
      const id = Number(path.split("/").pop());
      return json({ id, firstname: ["", "", "", "", "", "", "", "Jane", "Bob", "Ann"][id] ?? "X", realname: "Doe" });
    }
    if (/\/ITILCategory\/3$/.test(path)) return json({ id: 3, completename: "Hardware > Printers" });
    return json([]);
  };
}

async function connect(opts: Opts, fetchImpl: FetchImpl = glpi({ calls: [] })) {
  const { server } = createGlpiServer(instanceFromConfig(opts), { fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "conversation", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

type Result = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, unknown> };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}

// ---------------------------------------------------------------------------
// 13. glpi_search column names
// ---------------------------------------------------------------------------

describe("glpi_search columns (finding 13)", () => {
  it("keys rows by search option name by default; named_columns=false keeps the IDs", async () => {
    const client = await connect({ id: uniq("s"), v1: { ...V1, userToken: uniq("u") } });
    const named = await call(client, "glpi_search", { itemtype: "Ticket" });
    const row = (named.structuredContent.data as Record<string, unknown>[])[0];
    assert.equal(row["Título"], "Printer down");
    assert.equal(row.ID, 10);
    assert.equal(row.Status, 5);
    assert.ok(!("1" in row), "numeric keys are gone by default");

    const raw = await call(client, "glpi_search", { itemtype: "Ticket", named_columns: false });
    assert.equal((raw.structuredContent.data as Record<string, unknown>[])[0]["1"], "Printer down");

    // glpi_list_my_tickets reads the search by column number and must not change.
    const mine = await call(client, "glpi_list_my_tickets", {});
    const t = (mine.structuredContent.data as Record<string, unknown>[])[0];
    assert.equal(t.id, 10);
    assert.equal(t.name, "Printer down");
    assert.deepEqual(t.requesters, [{ id: 7, name: "Jane Doe" }]);
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// 14. Labels in the session language
// ---------------------------------------------------------------------------

describe("labels follow the GLPI session language (finding 14)", () => {
  it("the tables hold GLPI's own texts (pt_BR as the API v2 returns them)", () => {
    assert.equal(LABELS.pt_BR.ticket_status[1], "Novo");
    assert.equal(LABELS.pt_BR.ticket_status[2], "Em atendimento (atribuído)");
    assert.equal(LABELS.pt_BR.ticket_status[6], "Fechado");
    assert.equal(LABELS.fr_FR.ticket_status[5], "Résolu");
    assert.equal(LABELS.es_ES.ticket_status[1], "Nuevo");
    for (const [lang, table] of Object.entries(LABELS)) {
      for (const [kind, map] of Object.entries(table)) {
        assert.deepEqual(Object.keys(map), Object.keys(LABELS.en[kind as keyof typeof table]), `${lang}.${kind} codes`);
      }
    }
  });

  it("picks the table by language, then by family, then English", () => {
    assert.equal(labelsFor("pt_BR"), LABELS.pt_BR);
    assert.equal(labelsFor("pt_PT"), LABELS.pt_PT);
    assert.equal(labelsFor("es_MX"), LABELS.es_ES);
    assert.equal(labelsFor("fr_CA"), LABELS.fr_FR);
    assert.equal(labelsFor("ja_JP"), LABELS.en);
    assert.equal(labelsFor(null), LABELS.en);
  });

  for (const [language, status, type, priority, role, validation] of [
    ["pt_BR", "Solucionado", LABELS.pt_BR.ticket_type[1], LABELS.pt_BR.priority[4], "Requerente", LABELS.pt_BR.validation_status[2]],
    ["fr_FR", "Résolu", LABELS.fr_FR.ticket_type[1], LABELS.fr_FR.priority[4], "Demandeur", LABELS.fr_FR.validation_status[2]],
    [null, "Solved", "Incident", "High", "Requester", "Waiting for approval"],
  ] as const) {
    it(`v1 tools label codes in ${language ?? "English (no language in the session)"}`, async () => {
      const client = await connect({ id: uniq("l"), v1: { ...V1, userToken: uniq("u") } }, glpi({ language, calls: [] }));
      const ticket = (await call(client, "glpi_get_ticket", { ticketId: 10 })).structuredContent.data as Record<string, unknown>;
      assert.equal(ticket.status_name, status);
      assert.equal(ticket.type_name, type);
      assert.equal(ticket.priority_name, priority);

      const listed = (await call(client, "glpi_list_tickets", {})).structuredContent.data as Record<string, unknown>[];
      assert.equal(listed[0].status_name, status);

      const mine = (await call(client, "glpi_list_my_tickets", {})).structuredContent.data as Record<string, unknown>[];
      assert.equal(mine[0].status_name, status);

      const users = (await call(client, "glpi_list_ticket_users", { ticketId: 10 })).structuredContent.data as Record<string, unknown>[];
      assert.equal(users[0].type_name, role);

      const validations = (await call(client, "glpi_list_ticket_validations", { ticketId: 10 })).structuredContent.data as Record<string, unknown>[];
      assert.equal(validations[0].status_name, validation);
      await client.close();
    });
  }

  it("falls back to English when the session cannot be read, and the tool still answers", async () => {
    const stub: Stub = { failSession: true, calls: [] };
    const client = await connect({ id: uniq("f"), v1: { ...V1, userToken: uniq("u") } }, glpi(stub));
    const r = await call(client, "glpi_get_ticket", { ticketId: 10 });
    assert.notEqual(r.isError, true);
    assert.equal((r.structuredContent.data as Record<string, unknown>).status_name, "Solved");
    await client.close();
  });

  it("reads the session once per credential (cached)", async () => {
    const stub: Stub = { language: "pt_BR", calls: [] };
    const client = await connect({ id: uniq("c"), v1: { ...V1, userToken: uniq("u") } }, glpi(stub));
    await call(client, "glpi_get_ticket", { ticketId: 10 });
    await call(client, "glpi_get_ticket", { ticketId: 10 });
    await call(client, "glpi_list_tickets", {});
    assert.equal(stub.calls.filter((c) => c.endsWith("/getFullSession")).length, 1);
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// 15. Compact markdown tables
// ---------------------------------------------------------------------------

describe("markdown listings use compact columns (finding 15)", () => {
  it("ticket listing: id, title, status, category, requester, technician, priority, updated", async () => {
    const client = await connect({ id: uniq("m"), v1: { ...V1, userToken: uniq("u") } }, glpi({ language: "pt_BR", calls: [] }));
    const md = (await call(client, "glpi_list_tickets", { format: "markdown" })).content[0].text;
    const [header, , first, second] = md.split("\n");
    assert.equal(header, "| id | title | status | category | requester | technician | priority | updated |");
    assert.equal(first, `| 10 | Printer down | Solucionado | Hardware > Printers | Jane Doe | Bob Doe, Ann Doe | ${LABELS.pt_BR.priority[4]} | 2026-10-04 10:00:00 |`);
    assert.match(second, /^\| 11 \| VPN \| Novo \|  \| requester@example\.com \|  \|/);
    assert.doesNotMatch(md, /users_id_lastupdater|368/);

    // JSON keeps every field, with the people as {id, name}.
    const json = (await call(client, "glpi_list_tickets", {})).structuredContent.data as Record<string, unknown>[];
    assert.equal(json[0].users_id_lastupdater, 368);
    assert.deepEqual(json[0].assigned, [{ id: 8, name: "Bob Doe" }, { id: 9, name: "Ann Doe" }]);
    assert.equal(json[0].category_name, "Hardware > Printers");

    // fields=all draws every column again.
    const all = (await call(client, "glpi_list_tickets", { format: "markdown", fields: "all" })).content[0].text;
    assert.match(all, /users_id_lastupdater/);
    await client.close();
  });

  it("timeline: one line per entry with type, id, date, author and summary", async () => {
    const client = await connect({ id: uniq("t"), v1: { ...V1, userToken: uniq("u") } });
    const md = (await call(client, "glpi_list_timeline", { itemtype: "Ticket", itemId: 10, format: "markdown" })).content[0].text;
    const lines = md.split("\n");
    assert.equal(lines[0], "| type | id | date | author | summary |");
    assert.ok(lines.some((l) => l === "| followup | 5 | 2026-10-04 09:00:00 | Jane Doe | Restarted the spooler |"), md);
    await client.close();
  });

  it("every listing with a view still renders (v1 and v2)", async () => {
    const client = await connect({ id: uniq("v"), v1: { ...V1, userToken: uniq("u") }, v2: V2 });
    for (const [name, args] of [
      ["glpi_list_problems", {}],
      ["glpi_list_changes", {}],
      ["glpi_list_users", {}],
      ["glpi_list_knowbase_items", {}],
      ["glpi_list_assets", { asset_type: "Computer" }],
      ["glpi_v2_list_tickets", {}],
      ["glpi_v2_list_users", {}],
    ] as const) {
      const r = await call(client, name, { ...args, format: "markdown" });
      assert.notEqual(r.isError, true, `${name}: ${r.content[0]?.text}`);
      assert.match(r.content[0].text, /^(\| id \||_No results\._)/, name);
    }
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// 16. Administration only in `admin`
// ---------------------------------------------------------------------------

describe("administration with writes only in the admin preset (finding 16)", () => {
  it("no everyday preset holds an admin write; admin holds them all, and every one exists", async () => {
    const client = await connect({ id: uniq("a"), v1: V1, v2: V2 });
    const all = new Set((await client.listTools()).tools.map((t) => t.name));
    await client.close();
    for (const t of ADMIN_WRITE_TOOLS) {
      assert.ok(all.has(t), `${t} is not a tool`);
      assert.ok(TOOLSETS.admin.tools.includes(t), `admin lacks ${t}`);
    }
    for (const preset of EVERYDAY_TOOLSETS) {
      const leaked = TOOLSETS[preset].tools.filter((t) => ADMIN_WRITE_TOOLS.includes(t));
      assert.deepEqual(leaked, [], `preset ${preset} holds admin writes`);
    }
    // Reads that help with a ticket stay in core.
    for (const t of ["glpi_get_user", "glpi_list_users", "glpi_list_entities", "glpi_v2_get_user"]) {
      assert.ok(TOOLSETS.core.tools.includes(t), `core should keep ${t}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Instructions built from the registered tools
// ---------------------------------------------------------------------------

const CITED = /\bglpi_[a-z0-9_]*[a-z0-9]\b/g;

function cited(text: string): string[] {
  // "glpi_v2_*" names the family, not a tool.
  return [...new Set(text.match(CITED) ?? [])].filter((n) => n !== "glpi_v2");
}

describe("instructions name only registered tools", () => {
  const cases: [string, Opts][] = [];
  for (const preset of [undefined, ...TOOLSET_NAMES]) {
    for (const [fam, creds] of [
      ["v1", { v1: V1 }],
      ["v2", { v2: V2 }],
      ["v1+v2", { v1: V1, v2: V2 }],
    ] as const) {
      cases.push([`${preset ?? "all"} / ${fam}`, { id: uniq("i"), ...creds, ...(preset ? { toolsets: [preset] } : {}) }]);
    }
  }
  cases.push(["core minus my tickets and search", { id: uniq("i"), v1: V1, toolsets: ["core"], toolsExclude: "glpi_list_my_tickets,glpi_search" }]);

  for (const [label, opts] of cases) {
    it(label, async () => {
      const client = await connect(opts);
      // A preset with no tool of the enabled family registers none (tools/list is then not served).
      const registered = new Set((await client.listTools().catch(() => ({ tools: [] as { name: string }[] }))).tools.map((t) => t.name));
      const text = client.getInstructions() ?? "";
      await client.close();
      const missing = cited(text).filter((n) => !registered.has(n));
      assert.deepEqual(missing, [], text);
      if (!opts.v2) assert.doesNotMatch(text, /glpi_v2/, "a v1-only server does not mention the v2 family");
    });
  }

  it("a full server still gets the full guidance; a host override wins", async () => {
    for (const t of ["glpi_list_my_tickets", "glpi_list_tickets", "glpi_search", "glpi_get_ticket", "glpi_list_timeline", "glpi_v2_get_ticket"]) {
      assert.match(DEFAULT_INSTRUCTIONS, new RegExp(`\\b${t}\\b`));
    }
    const full = await connect({ id: uniq("i"), v1: V1, v2: V2 });
    assert.equal(full.getInstructions(), DEFAULT_INSTRUCTIONS);
    await full.close();
    const { server } = createGlpiServer(instanceFromConfig({ id: uniq("i"), v1: V1 }), { instructions: "custom" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "x", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    assert.equal(client.getInstructions(), "custom");
    await client.close();
  });
});
