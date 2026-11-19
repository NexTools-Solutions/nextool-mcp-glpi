/**
 * API v2 with a host-supplied access token (accessTokenProvider) instead of the
 * OAuth2 password grant: the token endpoint is never called, the token is cached
 * per cacheKey, and a 401 forces a new one.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FetchImpl } from "@nextoolsolutions/mcp-glpi-core";

import { createGlpiServer, instanceFromConfig, type AccessTokenProvider } from "../src/lib.js";

let seq = 0;
const uniq = (label: string) => `${label}-${process.pid}-${++seq}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A GLPI that accepts only the tokens in `accepted` and answers /session with the token it saw. */
function glpi(accepted: Set<string>): { fetch: FetchImpl; paths: string[]; bearers: string[] } {
  const paths: string[] = [];
  const bearers: string[] = [];
  const fetch: FetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    paths.push(path);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    const bearer = auth.replace(/^Bearer /, "");
    bearers.push(bearer);
    if (path.endsWith("/api.php/token")) return json({ error: "password grant must not be used" }, 500);
    if (!accepted.has(bearer)) return json({ status: "ERROR_UNAUTHENTICATED" }, 401);
    if (path.endsWith("/Administration/User/Me")) return json({ id: 7, username: bearer });
    return json({ status: "ERROR", title: `unexpected ${path}` }, 500);
  };
  return { fetch, paths, bearers };
}

async function callGetMe(fetchImpl: FetchImpl, provider: AccessTokenProvider, cacheKey: string) {
  const instance = instanceFromConfig({
    id: uniq("tp"),
    v2: { url: "https://glpi.example.com", accessTokenProvider: provider, cacheKey },
  });
  const { server } = createGlpiServer(instance, { fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "token-provider", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const res = (await client.callTool({ name: "glpi_v2_get_me", arguments: {} })) as {
    isError?: boolean; structuredContent?: Record<string, unknown>;
  };
  await client.close();
  return res;
}

describe("API v2 with an access token provider", () => {
  it("uses the provider's token, never the password grant, and caches it", async () => {
    const g = glpi(new Set(["tok-a"]));
    let calls = 0;
    const provider: AccessTokenProvider = async () => ({ token: "tok-a", expiresAt: Date.now() + 3_600_000, n: ++calls } as { token: string; expiresAt: number });
    const key = uniq("user");
    const first = await callGetMe(g.fetch, provider, key);
    const second = await callGetMe(g.fetch, provider, key);
    assert.equal(first.structuredContent?.username, "tok-a");
    assert.equal(second.structuredContent?.username, "tok-a");
    assert.equal(calls, 1);
    assert.equal(g.paths.some((p) => p.endsWith("/api.php/token")), false);
  });

  it("forces a new token after GLPI answers 401", async () => {
    const g = glpi(new Set(["tok-new"]));
    const forces: boolean[] = [];
    const provider: AccessTokenProvider = async ({ force }) => {
      forces.push(force);
      return { token: force ? "tok-new" : "tok-old", expiresAt: Date.now() + 3_600_000 };
    };
    const res = await callGetMe(g.fetch, provider, uniq("user"));
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent?.username, "tok-new");
    assert.deepEqual(forces, [false, true]);
  });

  it("keeps the tokens of two users apart", async () => {
    const g = glpi(new Set(["tok-ana", "tok-bia"]));
    const ana = await callGetMe(g.fetch, async () => ({ token: "tok-ana", expiresAt: Date.now() + 3_600_000 }), uniq("ana"));
    const bia = await callGetMe(g.fetch, async () => ({ token: "tok-bia", expiresAt: Date.now() + 3_600_000 }), uniq("bia"));
    assert.equal(ana.structuredContent?.username, "tok-ana");
    assert.equal(bia.structuredContent?.username, "tok-bia");
  });

  it("fails cleanly when the provider returns no token", async () => {
    const g = glpi(new Set());
    const res = await callGetMe(g.fetch, async () => ({ token: "" }), uniq("user"));
    assert.equal(res.isError, true);
  });

  it("requires cacheKey with the provider, and either a provider or the password grant", () => {
    const provider: AccessTokenProvider = async () => ({ token: "t" });
    assert.throws(() => instanceFromConfig({ id: uniq("x"), v2: { url: "https://glpi.example.com", accessTokenProvider: provider } }), /cacheKey/);
    assert.throws(() => instanceFromConfig({ id: uniq("x"), v2: { url: "https://glpi.example.com", clientId: "c" } }), /accessTokenProvider/);
  });
});
