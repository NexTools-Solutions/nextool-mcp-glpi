/**
 * API v2 timeline writes: GLPI 11 creates followups and solutions only at
 * POST /{itemtype}/{id}/Timeline/{Followup|Solution} (there is no POST on
 * /Timeline itself, which answered 404). Issue NexTools-Solutions/mcp#4.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FetchImpl } from "@nextoolsolutions/mcp-glpi-core";

import { createGlpiServer, instanceFromConfig } from "../src/lib.js";

let seq = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function call(tool: string, args: Record<string, unknown>) {
  const seen: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    seen.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (/\/Timeline\/(Followup|Solution)$/.test(path) && method === "POST") return json({ id: 99, href: path + "/99" }, 201);
    return json({ status: "ERROR_ROUTE_NOT_FOUND" }, 404);
  };
  const instance = instanceFromConfig({
    id: `tw-${process.pid}-${++seq}`,
    v2: { url: "https://glpi.example.com", accessTokenProvider: async () => ({ token: "tok" }), cacheKey: `tw-${seq}` },
  });
  const { server } = createGlpiServer(instance, { fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "timeline-writes", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const res = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean };
  await client.close();
  return { res, writes: seen.filter((s) => s.method === "POST") };
}

describe("API v2 timeline writes", () => {
  it("glpi_v2_add_followup posts to /Timeline/Followup without a type field", async () => {
    const { res, writes } = await call("glpi_v2_add_followup", { itemtype: "Ticket", itemId: 22833, input: { content: "Update" } });
    assert.equal(res.isError, undefined);
    assert.equal(writes.length, 1);
    assert.match(writes[0].path, /\/Assistance\/Ticket\/22833\/Timeline\/Followup$/);
    assert.deepEqual(writes[0].body, { content: "Update" });
  });

  it("glpi_v2_add_solution posts to /Timeline/Solution without a type field", async () => {
    const { res, writes } = await call("glpi_v2_add_solution", { itemtype: "Change", itemId: 5, input: { content: "Done" } });
    assert.equal(res.isError, undefined);
    assert.equal(writes.length, 1);
    assert.match(writes[0].path, /\/Assistance\/Change\/5\/Timeline\/Solution$/);
    assert.deepEqual(writes[0].body, { content: "Done" });
  });
});
