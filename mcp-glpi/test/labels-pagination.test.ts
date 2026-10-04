/**
 * 3.5.1 — fixes from the live check of 3.5.0:
 *
 *   1. glpi_v2_list_timeline had no `limit`: the argument was dropped by the
 *      schema and every entry came back. It now pages with start/limit over the
 *      whole timeline (the API ignores both on /Timeline) and reports `total`.
 *   2. glpi_search (named columns) returned coded values ("Status": 5); coded
 *      columns now hold the GLPI label and "<name> (id)" the code.
 *   3. v2 priority (and urgency, impact, ticket type) came as numbers in the
 *      markdown; the v2 tools add `<field>_name` in the language of the status
 *      labels the API returns.
 *   4. v2 timeline: validation/solution status_name, task state_name, and the
 *      markdown validation row (author and summary were empty).
 *   5. v2 timeline markdown showed raw HTML (`<p>…</p>`) from item.content: core
 *      1.3.1 flattens nested richtext for markdown; JSON keeps the HTML.
 *
 * GLPI is stubbed through `fetchImpl`; the server is driven by a real MCP client.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FetchImpl } from "@nextoolsolutions/mcp-glpi-core";

import { LABELS, createGlpiServer, instanceFromConfig } from "../src/lib.js";

let seq = 0;
const uniq = (label: string) => `${label}-${process.pid}-${++seq}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Result = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, unknown> };
type Row = Record<string, unknown>;

async function connect(opts: Parameters<typeof instanceFromConfig>[0], fetchImpl: FetchImpl) {
  const { server } = createGlpiServer(instanceFromConfig(opts), { fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "patch-351", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}

// ---------------------------------------------------------------------------
// API v1: glpi_search labels
// ---------------------------------------------------------------------------

function v1Glpi(language: string | null, calls: string[] = []): FetchImpl {
  return async (url) => {
    const u = new URL(url);
    const path = u.pathname;
    calls.push(path + u.search);
    if (path.endsWith("/initSession")) return json({ session_token: "s" });
    if (path.endsWith("/getFullSession")) {
      return json({ session: { glpiID: 7, glpifriendlyname: "Jane Doe", ...(language ? { glpilanguage: language } : {}) } });
    }
    if (path.includes("/listSearchOptions/Ticket")) {
      return json({
        common: "Características",
        "1": { name: "Título", table: "glpi_tickets", field: "name" },
        "2": { name: "ID", table: "glpi_tickets", field: "id" },
        "3": { name: "Prioridade", table: "glpi_tickets", field: "priority" },
        "12": { name: "Status", table: "glpi_tickets", field: "status" },
        "14": { name: "Tipo", table: "glpi_tickets", field: "type" },
        "31": { name: "Tipo", table: "glpi_ticketsatisfactions", field: "type" },
        "55": { name: "Status de aprovação", table: "glpi_ticketvalidations", field: "status" },
      });
    }
    if (path.includes("/search/Ticket")) {
      const q = decodeURIComponent(u.search);
      if (/criteria\[0\]\[field\]=2/.test(q)) return json({ totalcount: 1, data: [{ "2": 10, "4": "7", "5": null }] });
      return json({
        totalcount: 1,
        data: [{ "1": "Printer down", "2": 10, "3": 4, "12": 5, "14": 1, "31": 1, "55": "2$#$3", "4": "7", "19": "2026-10-04 10:00:00" }],
      });
    }
    if (/\/User\/7$/.test(path)) return json({ id: 7, firstname: "Jane", realname: "Doe" });
    return json([]);
  };
}

describe("glpi_search labels coded columns (3.5.1)", () => {
  it("label in the session language, code under '<name> (id)'; other columns untouched", async () => {
    const client = await connect({ id: uniq("s"), v1: { url: "https://glpi.example.com", userToken: uniq("u") } }, v1Glpi("pt_BR"));
    const row = ((await call(client, "glpi_search", { itemtype: "Ticket" })).structuredContent.data as Row[])[0];
    assert.equal(row.Status, "Solucionado");
    assert.equal(row["Status (id)"], 5);
    assert.equal(row.Prioridade, LABELS.pt_BR.priority[4]);
    assert.equal(row["Prioridade (id)"], 4);
    assert.equal(row.Tipo, "Incidente");
    assert.equal(row["Tipo (id)"], 1);
    // Same name, another table (satisfaction type): not a ticket type, kept as is.
    assert.equal(row["Tipo [31]"], 1);
    assert.ok(!("Tipo [31] (id)" in row));
    // Multi-valued approval statuses ("$#$").
    assert.equal(row["Status de aprovação"], `${LABELS.pt_BR.validation_status[2]}, ${LABELS.pt_BR.validation_status[3]}`);
    assert.equal(row["Status de aprovação (id)"], "2$#$3");
    assert.equal(row["Título"], "Printer down");
    assert.equal(row.ID, 10);
    await client.close();
  });

  it("English without a session language; named_columns=false stays raw", async () => {
    const client = await connect({ id: uniq("s"), v1: { url: "https://glpi.example.com", userToken: uniq("u") } }, v1Glpi(null));
    const row = ((await call(client, "glpi_search", { itemtype: "Ticket" })).structuredContent.data as Row[])[0];
    assert.equal(row.Status, "Solved");
    const raw = ((await call(client, "glpi_search", { itemtype: "Ticket", named_columns: false })).structuredContent.data as Row[])[0];
    assert.equal(raw["12"], 5);
    assert.equal(raw["3"], 4);
    assert.ok(!Object.keys(raw).some((k) => k.endsWith("(id)")));
    await client.close();
  });

  it("markdown shows the labels without the (id) columns; glpi_list_my_tickets still reads numbers", async () => {
    const client = await connect({ id: uniq("s"), v1: { url: "https://glpi.example.com", userToken: uniq("u") } }, v1Glpi("pt_BR"));
    const md = (await call(client, "glpi_search", { itemtype: "Ticket", format: "markdown" })).content[0].text;
    assert.match(md, /\| Solucionado \|/);
    assert.doesNotMatch(md, /\(id\)/);
    const all = (await call(client, "glpi_search", { itemtype: "Ticket", format: "markdown", fields: "all" })).content[0].text;
    assert.match(all, /Status \(id\)/);

    const mine = (await call(client, "glpi_list_my_tickets", {})).structuredContent.data as Row[];
    assert.equal(mine[0].id, 10);
    assert.equal(mine[0].status, 5);
    assert.equal(mine[0].status_name, "Solucionado");
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// API v2: timeline paging and labels
// ---------------------------------------------------------------------------

const PT_STATUS = { id: 5, name: "Solucionado" };

function timeline(n: number): Row[] {
  const out: Row[] = [];
  for (let i = 1; i <= n; i++) {
    if (i === n) {
      out.push({
        type: "Validation",
        item: {
          id: 900, status: 2, submission_comment: "Please approve", approval_comment: null,
          submission_date: "2026-10-04T10:00:00-03:00", requester: { id: 59, name: "api.bot" }, approver: { id: 7, name: "admin" },
        },
      });
    } else if (i % 2 === 0) {
      out.push({ type: "Task", item: { id: i, state: 2, content: `task ${i}`, date: "2026-10-04T09:00:00-03:00", user: { id: 7, name: "admin" } } });
    } else {
      out.push({ type: "Followup", item: { id: i, content: `followup ${i}`, date: "2026-10-04T09:00:00-03:00", user: { id: 7, name: "admin" } } });
    }
  }
  return out;
}

interface V2Stub {
  status: { id: number; name: string };
  entries: number;
  calls: string[];
}

function v2Glpi(stub: V2Stub): FetchImpl {
  return async (url) => {
    const u = new URL(url);
    const path = u.pathname;
    stub.calls.push(path + u.search);
    if (path.endsWith("/api.php/token")) return json({ access_token: "t", expires_in: 3600 });
    if (/\/Assistance\/Ticket\/\d+\/Timeline$/.test(path)) return json(timeline(stub.entries));
    const ticket = { id: 10, name: "Printer down", status: stub.status, priority: 4, urgency: 3, impact: 2, type: 1, date_mod: "2026-10-04T10:00:00-03:00", team: [] };
    if (/\/Assistance\/Ticket\/10$/.test(path)) return json(ticket);
    if (/\/Assistance\/Ticket$/.test(path)) return json([ticket]);
    if (/\/Assistance\/Change$/.test(path)) return json([{ id: 3, name: "Upgrade", status: { id: 9, name: "Avaliação" }, priority: 5, urgency: 5, impact: 5, type: 1 }]);
    return json([]);
  };
}

function v2Creds() {
  return { url: "https://glpi.example.com", clientId: "c", clientSecret: "s", username: uniq("n"), password: "p" };
}

describe("glpi_v2_list_timeline honours limit and start (3.5.1)", () => {
  it("limit 3 of 6 entries: 3 back, total 6, note with the next start/limit", async () => {
    const stub: V2Stub = { status: PT_STATUS, entries: 6, calls: [] };
    const client = await connect({ id: uniq("t"), v2: v2Creds() }, v2Glpi(stub));
    const r = await call(client, "glpi_v2_list_timeline", { itemtype: "Ticket", itemId: 10, limit: 3 });
    const data = r.structuredContent.data as Row[];
    assert.equal(data.length, 3);
    assert.equal(r.structuredContent.total, 6);
    assert.equal(r.structuredContent.note, "6 match in total. Next page: start=3 limit=3.");

    const next = await call(client, "glpi_v2_list_timeline", { itemtype: "Ticket", itemId: 10, start: 3, limit: 3 });
    const rest = next.structuredContent.data as Row[];
    assert.deepEqual(rest.map((e) => (e.item as Row).id), [4, 5, 900]);
    assert.equal(next.structuredContent.note, undefined);
    await client.close();
  });

  it("without limit: the default page (25) and a note when the timeline is longer", async () => {
    const stub: V2Stub = { status: PT_STATUS, entries: 30, calls: [] };
    const client = await connect({ id: uniq("t"), v2: v2Creds() }, v2Glpi(stub));
    const r = await call(client, "glpi_v2_list_timeline", { itemtype: "Ticket", itemId: 10 });
    assert.equal((r.structuredContent.data as Row[]).length, 25);
    assert.equal(r.structuredContent.total, 30);
    assert.match(String(r.structuredContent.note), /Next page: start=25 limit=25\./);
    await client.close();
  });

  it("labels: validation status_name, task state_name, in the language of the status labels", async () => {
    const stub: V2Stub = { status: PT_STATUS, entries: 4, calls: [] };
    const client = await connect({ id: uniq("t"), v2: v2Creds() }, v2Glpi(stub));
    const data = (await call(client, "glpi_v2_list_timeline", { itemtype: "Ticket", itemId: 10 })).structuredContent.data as Row[];
    // No status in a timeline: one ticket is read to find the language (once per credential).
    assert.equal(stub.calls.filter((c) => c.endsWith("/Assistance/Ticket?limit=1")).length, 1);
    assert.equal((data[1].item as Row).state_name, LABELS.pt_BR.task_state[2]);
    assert.equal((data[3].item as Row).status_name, LABELS.pt_BR.validation_status[2]);

    const md = (await call(client, "glpi_v2_list_timeline", { itemtype: "Ticket", itemId: 10, format: "markdown" })).content[0].text;
    assert.ok(
      md.includes(`| Validation | 900 | 2026-10-04T10:00:00-03:00 | api.bot | ${LABELS.pt_BR.validation_status[2]} · → admin · Please approve |`),
      md,
    );
    assert.equal(stub.calls.filter((c) => c.endsWith("/Assistance/Ticket?limit=1")).length, 1, "language cached");
    await client.close();
  });
});

describe("v2 timeline markdown reads as text (3.5.1, core 1.3.1)", () => {
  it("item.content and validation comments without HTML in markdown; JSON keeps the HTML", async () => {
    const entries = [
      { type: "Followup", item: { id: 1, content: "<p>Olá <strong>Ana</strong>,</p>\n<p>tudo bem?</p>", date: "2026-10-04T09:00:00-03:00", user: { id: 7, name: "admin" } } },
      { type: "Validation", item: { id: 2, status: 2, submission_comment: "<p>Aprovar &amp; seguir</p>", submission_date: "2026-10-04T10:00:00-03:00", requester: { id: 59, name: "api.bot" }, approver: { id: 7, name: "admin" } } },
    ];
    const fetchImpl: FetchImpl = async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/api.php/token")) return json({ access_token: "t", expires_in: 3600 });
      if (path.endsWith("/Timeline")) return json(entries);
      if (/\/Assistance\/Ticket$/.test(path)) return json([{ id: 10, status: PT_STATUS }]);
      return json([]);
    };
    const client = await connect({ id: uniq("h"), v2: v2Creds() }, fetchImpl);
    const md = (await call(client, "glpi_v2_list_timeline", { itemtype: "Ticket", itemId: 10, format: "markdown" })).content[0].text;
    assert.ok(md.includes("| Followup | 1 | 2026-10-04T09:00:00-03:00 | admin | Olá Ana, tudo bem? |"), md);
    assert.ok(md.includes(`| ${LABELS.pt_BR.validation_status[2]} · → admin · Aprovar & seguir |`), md);
    assert.doesNotMatch(md, /<p>|<strong>|&amp;/);

    const data = (await call(client, "glpi_v2_list_timeline", { itemtype: "Ticket", itemId: 10 })).structuredContent.data as Row[];
    assert.equal((data[0].item as Row).content, entries[0].item.content);
    await client.close();
  });
});

describe("v2 ITIL codes carry labels (3.5.1)", () => {
  for (const [status, lang] of [
    [PT_STATUS, "pt_BR"],
    [{ id: 5, name: "Résolu" }, "fr_FR"],
    [{ id: 5, name: "解決済み" }, "en"],
  ] as const) {
    it(`status "${status.name}" -> ${lang} labels for priority, urgency, impact and type`, async () => {
      const stub: V2Stub = { status, entries: 0, calls: [] };
      const client = await connect({ id: uniq("l"), v2: v2Creds() }, v2Glpi(stub));
      const t = LABELS[lang];
      const ticket = (await call(client, "glpi_v2_get_ticket", { ticketId: 10 })).structuredContent;
      assert.equal(ticket.priority, 4);
      assert.equal(ticket.priority_name, t.priority[4]);
      assert.equal(ticket.urgency_name, t.urgency[3]);
      assert.equal(ticket.impact_name, t.impact[2]);
      assert.equal(ticket.type_name, t.ticket_type[1]);

      const md = (await call(client, "glpi_v2_list_tickets", { format: "markdown" })).content[0].text;
      const row = md.split("\n")[2];
      assert.ok(row.includes(`| ${t.priority[4]} |`), md);
      assert.doesNotMatch(row, /\| 4 \|/);
      // The status came with the item: no extra request to find the language.
      assert.equal(stub.calls.filter((c) => c.includes("limit=1")).length, 0);
      await client.close();
    });
  }

  it("changes: labels from the change status table, no ticket type", async () => {
    const stub: V2Stub = { status: PT_STATUS, entries: 0, calls: [] };
    const client = await connect({ id: uniq("c"), v2: v2Creds() }, v2Glpi(stub));
    const row = ((await call(client, "glpi_v2_list_changes", {})).structuredContent.data as Row[])[0];
    assert.equal(row.priority_name, LABELS.pt_BR.priority[5]);
    assert.equal(row.impact_name, LABELS.pt_BR.impact[5]);
    assert.ok(!("type_name" in row));
    await client.close();
  });
});
