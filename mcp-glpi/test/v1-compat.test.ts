/**
 * v1Compat: an instance with only API v2 credentials also serves the everyday
 * ticket tools under their v1 names (clients that froze a v1 tool list, like
 * the ChatGPT app directory). Issue NexTools-Solutions/nextool-mcp#1.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FetchImpl } from "@nextoolsolutions/mcp-glpi-core";

import { createGlpiServer, instanceFromConfig, v1CompatToolNames } from "../src/lib.js";

let seq = 0;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const member = (role: string, id: number, name: string, type = "User") => ({ role, id, name, display_name: `${name} (${id})`, type });
const TICKETS = [
  { id: 1, name: "Outlook", priority: 4, urgency: 4, impact: 3, type: 1, status: { id: 2, name: "Em atendimento" }, is_deleted: false,
    team: [member("requester", 9, "Mariana"), member("assigned", 124, "Rafael")] },
  { id: 2, name: "ERP", priority: 4, urgency: 4, impact: 4, type: 1, status: { id: 2, name: "Em atendimento" }, is_deleted: false,
    team: [member("requester", 124, "Rafael"), member("assigned", 7, "Jean")] },
  { id: 3, name: "Impressora", priority: 3, urgency: 3, impact: 3, type: 1, status: { id: 1, name: "Novo" }, is_deleted: false,
    team: [member("assigned", 7, "Jean"), member("assigned", 427, "Suporte N1", "Group")] },
  { id: 4, name: "Excluído", priority: 4, urgency: 4, impact: 4, type: 1, status: { id: 2, name: "Em atendimento" }, is_deleted: true,
    team: [member("assigned", 124, "Rafael")] },
];

function glpi() {
  const calls: { method: string; path: string; query: string; body: unknown }[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    calls.push({ method, path: u.pathname, query: u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (/\/session$/i.test(u.pathname)) return json({ user_id: 124, name: "demo.rafael.souza", friendly_name: "Rafael Souza" });
    if (u.pathname.endsWith("/Assistance/Ticket") && method === "GET") {
      // Counts: a one-row page whose Content-Range carries the total of the filter.
      if (u.searchParams.get("limit") === "1") {
        const filter = u.searchParams.get("filter") ?? "";
        const total = /status\.id==2/.test(filter) ? 2 : /status\.id==1/.test(filter) ? 1 : /status\.id=out=/.test(filter) ? 1 : /status\.id==/.test(filter) ? 0 : 4;
        return new Response(JSON.stringify(TICKETS.slice(0, 1)), {
          status: 206,
          headers: { "Content-Type": "application/json", "Content-Range": `0-0/${total}` },
        });
      }
      return json(TICKETS);
    }
    if (u.pathname.endsWith("/Assistance/Ticket") && method === "POST") return json({ id: 77, href: "/Assistance/Ticket/77" }, 201);
    if (/\/Assistance\/Ticket\/77\/TeamMember$/.test(u.pathname) && method === "POST") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return body.type === "Group" ? json({ status: "ERROR_RIGHT_MISSING", title: "no" }, 403) : new Response("", { status: 201 });
    }
    if (/\/Assistance\/Ticket\/1$/.test(u.pathname) && method === "GET") return json(TICKETS[0]);
    if (/\/Timeline\/Solution$/.test(u.pathname) && method === "POST") return json({ id: 50 }, 201);
    if (/\/Assistance\/Ticket\/1\/Timeline$/.test(u.pathname)) {
      return json([
        { type: "Followup", item: { id: 10, content: "Olá", user: { id: 124, name: "demo.rafael.souza" } } },
        { type: "Task", item: { id: 11, content: "Checar", user: { id: 124, name: "demo.rafael.souza" } } },
      ]);
    }
    return json({ status: "ERROR", title: `unexpected ${method} ${u.pathname}` }, 404);
  };
  return { fetchImpl, calls };
}

async function connect(opts: { v1Compat?: boolean; withV1?: boolean; onlyV1?: boolean; toolsets?: string[] }, fetchImpl: FetchImpl) {
  const n = ++seq;
  const instance = instanceFromConfig({
    id: `compat-${process.pid}-${n}`,
    ...(opts.onlyV1
      ? {}
      : { v2: { url: "https://glpi.example.com", accessTokenProvider: async () => ({ token: "tok" }), cacheKey: `compat-${n}` } }),
    ...(opts.withV1 || opts.onlyV1 ? { v1: { url: "https://glpi.example.com", userToken: "u" } } : {}),
    v1Compat: opts.v1Compat,
    toolsets: opts.toolsets,
  });
  const { server } = createGlpiServer(instance, { fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "v1-compat", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("v1Compat", () => {
  it("is off by default: a v2-only instance has no v1 names", async () => {
    const client = await connect({}, glpi().fetchImpl);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes("glpi_list_my_tickets"));
    await client.close();
  });

  it("is ignored when the instance also has v1 (no duplicate tools)", async () => {
    const client = await connect({ v1Compat: true, withV1: true }, glpi().fetchImpl);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.equal(names.filter((n) => n === "glpi_list_my_tickets").length, 1);
    await client.close();
  });

  it("registers the everyday v1 ticket tools next to glpi_v2_*", async () => {
    const client = await connect({ v1Compat: true }, glpi().fetchImpl);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["glpi_list_my_tickets", "glpi_list_tickets", "glpi_get_ticket", "glpi_add_followup",
      "glpi_add_solution", "glpi_list_timeline", "glpi_add_ticket_task", "glpi_get_full_session", "glpi_v2_get_ticket"]) {
      assert.ok(names.includes(n), n);
    }
    await client.close();
  });

  it("glpi_list_my_tickets keeps the session user's tickets by role, skips deleted ones, filters open by default", async () => {
    const g = glpi();
    const client = await connect({ v1Compat: true }, g.fetchImpl);
    const any = (await client.callTool({ name: "glpi_list_my_tickets", arguments: {} })) as { structuredContent: Record<string, unknown> };
    const rows = any.structuredContent.data as { id: number; my_roles: string[]; assigned: { name: string }[] }[];
    assert.deepEqual(rows.map((r) => r.id), [1, 2]);
    assert.deepEqual(rows[0].my_roles, ["assigned"]);
    assert.equal(rows[0].assigned[0].name, "Rafael");
    assert.deepEqual(any.structuredContent.user, { id: 124, name: "Rafael Souza" });
    const list = g.calls.find((c) => c.path.endsWith("/Assistance/Ticket"))!;
    assert.match(decodeURIComponent(list.query), /filter=status\.id=in=\(1,2,3,4\)/);
    assert.match(decodeURIComponent(list.query), /sort=date_mod:desc/);

    const assigned = (await client.callTool({ name: "glpi_list_my_tickets", arguments: { role: "assigned" } })) as { structuredContent: Record<string, unknown> };
    assert.deepEqual((assigned.structuredContent.data as { id: number }[]).map((r) => r.id), [1]);
    await client.close();
  });

  it("glpi_add_solution posts to /Timeline/Solution with the content only", async () => {
    const g = glpi();
    const client = await connect({ v1Compat: true }, g.fetchImpl);
    const res = (await client.callTool({ name: "glpi_add_solution", arguments: { ticketId: 1, content: "Resolvido" } })) as { isError?: boolean };
    assert.equal(res.isError, undefined);
    const post = g.calls.find((c) => c.method === "POST")!;
    assert.match(post.path, /\/Assistance\/Ticket\/1\/Timeline\/Solution$/);
    assert.deepEqual(post.body, { content: "Resolvido" });
    await client.close();
  });

  it("glpi_list_followups returns only the followups, with user_name", async () => {
    const client = await connect({ v1Compat: true }, glpi().fetchImpl);
    const res = (await client.callTool({ name: "glpi_list_followups", arguments: { ticketId: 1 } })) as { structuredContent: { data: Record<string, unknown>[] } };
    assert.deepEqual(res.structuredContent.data.map((e) => [e.id, e.user_name]), [[10, "demo.rafael.souza"]]);
    await client.close();
  });

  it("covers every v1 tool of the core preset, and nothing registered collides with glpi_v2_*", async () => {
    const compat = await connect({ v1Compat: true, toolsets: ["core"] }, glpi().fetchImpl);
    const names = (await compat.listTools()).tools.map((t) => t.name);
    await compat.close();
    const v1 = await connect({ onlyV1: true, toolsets: ["core"] }, glpi().fetchImpl);
    const core = (await v1.listTools()).tools.map((t) => t.name);
    await v1.close();
    assert.ok(core.length > 50);
    assert.deepEqual(core.filter((n) => !names.includes(n)), []);
    assert.equal(new Set(names).size, names.length);
    for (const n of v1CompatToolNames()) assert.ok(!n.startsWith("glpi_v2_"), n);
  });

  it("a v1 tool with no v2 counterpart answers with an actionable sentence, not 'tool not found'", async () => {
    const client = await connect({ v1Compat: true }, glpi().fetchImpl);
    const res = (await client.callTool({ name: "glpi_search", arguments: { itemtype: "Ticket", criteria: [] } })) as {
      isError?: boolean; content: { text: string }[];
    };
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /API v2/);
    assert.match(res.content[0].text, /glpi_list_tickets/);
    await client.close();
  });

  it("glpi_get_ticket_stats and glpi_count_items read the totals from Content-Range, deleted items left out", async () => {
    const g = glpi();
    const client = await connect({ v1Compat: true }, g.fetchImpl);
    const stats = (await client.callTool({ name: "glpi_get_ticket_stats", arguments: {} })) as { structuredContent: { data: Record<string, unknown> } };
    const data = stats.structuredContent.data as { total: number; by_status: { code: number; count: number }[]; other_status_count: number; counts_consistent: boolean };
    assert.equal(data.total, 4);
    assert.deepEqual(data.by_status.filter((r) => r.count > 0).map((r) => [r.code, r.count]), [[1, 1], [2, 2]]);
    assert.equal(data.other_status_count, 1);
    assert.equal(data.counts_consistent, true);
    for (const c of g.calls.filter((c) => c.path.endsWith("/Assistance/Ticket"))) assert.match(decodeURIComponent(c.query), /is_deleted==false/);

    const count = (await client.callTool({ name: "glpi_count_items", arguments: { itemtype: "Ticket" } })) as { structuredContent: { data: unknown } };
    assert.deepEqual(count.structuredContent.data, { itemtype: "Ticket", total: 4 });
    const withCriteria = (await client.callTool({
      name: "glpi_count_items", arguments: { itemtype: "Ticket", criteria: [{ field: 12, searchtype: "equals", value: 1 }] },
    })) as { isError?: boolean; content: { text: string }[] };
    assert.equal(withCriteria.isError, true);
    assert.match(withCriteria.content[0].text, /glpi_get_ticket_stats/);
    await client.close();
  });

  it("glpi_create_ticket maps v1 field names, sets people through the team and reports the ones GLPI refused", async () => {
    const g = glpi();
    const client = await connect({ v1Compat: true }, g.fetchImpl);
    const res = (await client.callTool({
      name: "glpi_create_ticket",
      arguments: { input: { name: "Novo", itilcategories_id: 5, _users_id_observer: 9, _groups_id_assign: [3] } },
    })) as { structuredContent: { data: { id: number; actors_not_set?: { field: string; id: number }[] } } };
    const posts = g.calls.filter((c) => c.method === "POST");
    assert.deepEqual(posts[0].body, { name: "Novo", category: 5 });
    assert.deepEqual(posts.slice(1).map((c) => c.body), [
      { type: "User", id: 124, role: "requester" }, // nobody was named: the connected user
      { type: "User", id: 9, role: "observer" },
      { type: "Group", id: 3, role: "assigned" },
    ]);
    assert.equal(res.structuredContent.data.id, 77);
    assert.deepEqual(res.structuredContent.data.actors_not_set?.map((a) => [a.field, a.id]), [["_groups_id_assign", 3]]);
    await client.close();
  });

  it("IDs written the way people write them are accepted; a wrong one says what an ID is", async () => {
    const g = glpi();
    const client = await connect({ v1Compat: true }, g.fetchImpl);
    for (const ticketId of ["#1", " 1 ", "1.0", "01"]) {
      const res = (await client.callTool({ name: "glpi_get_ticket", arguments: { ticketId } })) as { isError?: boolean };
      assert.equal(res.isError, undefined, JSON.stringify(ticketId));
    }
    for (const ticketId of ["abc", "Ticket 1", 0, -1, 1.5]) {
      const res = (await client.callTool({ name: "glpi_get_ticket", arguments: { ticketId } }).catch((e: Error) => ({
        isError: true, content: [{ text: e.message }],
      }))) as { isError?: boolean; content: { text: string }[] };
      assert.equal(res.isError, true, JSON.stringify(ticketId));
      assert.match(res.content[0].text, /numeric GLPI ID alone, e\.g\. 123/, JSON.stringify(ticketId));
    }
    await client.close();
  });
});
