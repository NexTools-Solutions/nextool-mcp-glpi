/**
 * HTTP entry: authentication, instance binding and isolation between instances.
 *
 * Two fake GLPI servers (classic apirest.php) hand out one session token per
 * user token and answer /Ticket with data naming the user, so any mix-up
 * between instances or credentials shows in the result.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { findKey, hashKey, parseRegistry, startHttpServer, type RunningHttpServer } from "../src/http.js";

interface FakeGlpi {
  server: Server;
  url: string;
  initSessions: string[];
  ticketCalls: string[];
  creates: string[];
}

async function fakeGlpi(label: string): Promise<FakeGlpi> {
  const sessions = new Map<string, string>(); // session token -> user token
  const fake: FakeGlpi = { server: undefined as unknown as Server, url: "", initSessions: [], ticketCalls: [], creates: [] };
  fake.server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path.endsWith("/initSession")) {
      const user = /user_token (.+)/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      fake.initSessions.push(user);
      const token = `${label}-session-${user}`;
      sessions.set(token, user);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ session_token: token }));
    }
    const user = sessions.get(String(req.headers["session-token"] ?? ""));
    if (!user) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(["ERROR_SESSION_TOKEN_INVALID", "invalid"]));
    }
    if (/\/Ticket\/?$/.test(path) && req.method === "POST") {
      fake.creates.push(user);
      res.writeHead(201, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id: 100 + fake.creates.length, message: "" }));
    }
    if (/\/Ticket\/?$/.test(path)) {
      fake.ticketCalls.push(user);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Range": "0-0/1" });
      return res.end(JSON.stringify([{ id: 1, name: `${label} ticket for ${user}`, status: 1 }]));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("[]");
  });
  await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
  const addr = fake.server.address();
  fake.url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  return fake;
}

let glpiA: FakeGlpi;
let glpiB: FakeGlpi;
let mcp: RunningHttpServer;
let base: string;
const audit: Record<string, unknown>[] = [];

before(async () => {
  glpiA = await fakeGlpi("A");
  glpiB = await fakeGlpi("B");
  const registry = parseRegistry(
    JSON.stringify({
      instances: {
        "inst-a": { env: { GLPI_URL: glpiA.url, GLPI_USER_TOKEN: "user-a" } },
        "inst-b": { env: { GLPI_URL: glpiB.url, GLPI_USER_TOKEN: "user-b" } },
        // Same GLPI as inst-a, different user: must never reuse inst-a's session.
        "inst-a2": { env: { GLPI_URL: glpiA.url, GLPI_USER_TOKEN: "user-a2" } },
      },
      keys: [
        { name: "key-a", sha256: hashKey("secret-a"), instances: ["inst-a"] },
        { name: "key-b", sha256: hashKey("secret-b"), instances: ["inst-b"] },
        { name: "key-a2", sha256: hashKey("secret-a2"), instances: ["inst-a2"] },
      ],
    }),
  );
  mcp = await startHttpServer({ registry, port: 0, audit: (e) => audit.push(e) });
  base = `http://127.0.0.1:${mcp.port}`;
});

after(async () => {
  await mcp.close();
  glpiA.server.close();
  glpiB.server.close();
});

async function connect(instance: string, key: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp/${instance}`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  // tools/list makes the SDK client validate every result against its outputSchema,
  // which is what a strict client does in real use.
  await client.listTools();
  return client;
}

async function ticketName(client: Client): Promise<string> {
  const r = (await client.callTool({ name: "glpi_list_tickets", arguments: { range: "0-0" } })) as {
    isError?: boolean;
    structuredContent?: { data?: { name?: string }[] };
    content: { text: string }[];
  };
  assert.ok(!r.isError, r.content?.[0]?.text);
  return r.structuredContent?.data?.[0]?.name ?? "";
}

const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
});
const post = (path: string, headers: Record<string, string>, body = initBody) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body,
  });

test("parseRegistry rejects a key for an unknown instance", () => {
  assert.throws(
    () => parseRegistry(JSON.stringify({ instances: {}, keys: [{ name: "k", sha256: "0".repeat(64), instances: ["x"] }] })),
    /unknown instance/,
  );
});

test("findKey matches only the right secret", () => {
  const registry = parseRegistry(
    JSON.stringify({ instances: {}, keys: [{ name: "k", sha256: hashKey("right"), instances: [] }] }),
  );
  assert.equal(findKey(registry, "right")?.name, "k");
  assert.equal(findKey(registry, "wrong"), undefined);
});

test("healthz answers without authentication", async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { status: string }).status, "ok");
});

test("no or wrong key: 401 with WWW-Authenticate, GLPI never called", async () => {
  const before = glpiA.initSessions.length;
  const none = await post("/mcp/inst-a", {});
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate") ?? "", /^Bearer/);
  const wrong = await post("/mcp/inst-a", { Authorization: "Bearer nope" });
  assert.equal(wrong.status, 401);
  assert.equal(glpiA.initSessions.length, before);
});

test("a key opens only its own instances (unknown ones look the same)", async () => {
  assert.equal((await post("/mcp/inst-b", { Authorization: "Bearer secret-a" })).status, 403);
  assert.equal((await post("/mcp/does-not-exist", { Authorization: "Bearer secret-a" })).status, 403);
});

test("parallel sessions on different instances never mix data or credentials", async () => {
  const [a, b, a2] = await Promise.all([
    connect("inst-a", "secret-a"),
    connect("inst-b", "secret-b"),
    connect("inst-a2", "secret-a2"),
  ]);
  const names = await Promise.all([ticketName(a), ticketName(b), ticketName(a2), ticketName(a), ticketName(b)]);
  assert.deepEqual(names, [
    "A ticket for user-a",
    "B ticket for user-b",
    "A ticket for user-a2",
    "A ticket for user-a",
    "B ticket for user-b",
  ]);
  assert.ok(glpiA.ticketCalls.every((u) => u === "user-a" || u === "user-a2"));
  assert.ok(glpiB.ticketCalls.every((u) => u === "user-b"));
  // One GLPI session per credential, not one shared session per URL.
  assert.deepEqual([...new Set(glpiA.initSessions)].sort(), ["user-a", "user-a2"]);
  await Promise.all([a.close(), b.close(), a2.close()]);
});

test("a session id only works with the key and instance that opened it", async () => {
  const a = await connect("inst-a", "secret-a");
  const sid = (a.transport as StreamableHTTPClientTransport).sessionId!;
  assert.ok(sid);
  const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const asB = await post("/mcp/inst-b", { Authorization: "Bearer secret-b", "mcp-session-id": sid }, list);
  assert.equal(asB.status, 404);
  const bOnA = await post("/mcp/inst-a", { Authorization: "Bearer secret-b", "mcp-session-id": sid }, list);
  assert.equal(bOnA.status, 403);
  await a.close();
});

test("a create retried on a new session is replayed, and passes strict output validation", async () => {
  const input = { input: { name: "Printer down", content: "3rd floor" } };
  const first = await connect("inst-a", "secret-a");
  const r1 = (await first.callTool({ name: "glpi_create_ticket", arguments: input })) as {
    isError?: boolean;
    structuredContent?: { data?: { id?: number }; replayed?: boolean };
  };
  await first.close();
  const second = await connect("inst-a", "secret-a");
  const r2 = (await second.callTool({ name: "glpi_create_ticket", arguments: input })) as typeof r1;
  await second.close();
  assert.ok(!r1.isError && !r2.isError);
  assert.equal(r2.structuredContent?.replayed, true);
  assert.equal(r2.structuredContent?.data?.id, r1.structuredContent?.data?.id);
  assert.equal(glpiA.creates.length, 1);
  // Same arguments on another instance is a different ticket, never a replay.
  const other = await connect("inst-a2", "secret-a2");
  const r3 = (await other.callTool({ name: "glpi_create_ticket", arguments: input })) as typeof r1;
  await other.close();
  assert.notEqual(r3.structuredContent?.replayed, true);
  assert.equal(glpiA.creates.length, 2);
});

test("audit records requests without arguments or credentials", () => {
  const calls = audit.filter((e) => e.event === "request" && (e.tools as string[]).includes("glpi_list_tickets"));
  assert.ok(calls.length >= 5);
  const text = JSON.stringify(audit);
  for (const secret of ["secret-a", "secret-b", "user-a", "user-b", "0-0"]) {
    assert.ok(!text.includes(`"${secret}"`), `audit leaked ${secret}`);
  }
});
