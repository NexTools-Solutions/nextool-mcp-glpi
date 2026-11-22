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

import { createGlpiServer, instanceFromConfig } from "../src/lib.js";

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
    if (u.pathname.endsWith("/Assistance/Ticket") && method === "GET") return json(TICKETS);
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

async function connect(opts: { v1Compat?: boolean; withV1?: boolean }, fetchImpl: FetchImpl) {
  const n = ++seq;
  const instance = instanceFromConfig({
    id: `compat-${process.pid}-${n}`,
    v2: { url: "https://glpi.example.com", accessTokenProvider: async () => ({ token: "tok" }), cacheKey: `compat-${n}` },
    ...(opts.withV1 ? { v1: { url: "https://glpi.example.com", userToken: "u" } } : {}),
    v1Compat: opts.v1Compat,
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
});
