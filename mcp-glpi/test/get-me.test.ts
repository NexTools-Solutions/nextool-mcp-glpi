/**
 * glpi_v2_get_me for a profile that may not read users, with the default "api"
 * scope: /Administration/User/Me and the user's own record both answer 403.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FetchImpl } from "@nextoolsolutions/mcp-glpi-core";

import { createGlpiServer, instanceFromConfig } from "../src/lib.js";

let seq = 0;
const uniq = (label: string) => `${label}-${process.pid}-${++seq}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** GET /session as GLPI 11 returns it (CoreController::getSession). */
const SESSION = {
  current_time: "2026-11-17T10:00:00+01:00", user_id: 7, use_mode: 0, friendly_name: "Doe Jane",
  name: "jane.doe", real_name: "Doe", first_name: "Jane", default_entity: 0, profiles: {}, active_entities: [], groups: [],
};
const RIGHT_MISSING = { status: "ERROR_RIGHT_MISSING", title: "You do not have the right to perform this action" };

function glpi(userRecord: () => Response): { fetch: FetchImpl; paths: string[] } {
  const paths: string[] = [];
  const fetch: FetchImpl = async (url) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path.endsWith("/api.php/token")) return json({ access_token: "t", expires_in: 3600 });
    if (path.endsWith("/Administration/User/Me")) return json(RIGHT_MISSING, 403);
    if (path.endsWith("/session")) return json(SESSION);
    if (/\/Administration\/User\/\d+$/.test(path)) return userRecord();
    return json({ status: "ERROR", title: `unexpected ${path}` }, 500);
  };
  return { fetch, paths };
}

async function getMe(fetchImpl: FetchImpl) {
  const instance = instanceFromConfig({
    id: uniq("me"),
    v2: { url: "https://glpi.example.com", clientId: "c", clientSecret: uniq("s"), username: "n", password: "p" },
  });
  const { server } = createGlpiServer(instance, { fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "get-me", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const res = (await client.callTool({ name: "glpi_v2_get_me", arguments: {} })) as {
    isError?: boolean; structuredContent?: Record<string, unknown>;
  };
  await client.close();
  return res;
}

describe("glpi_v2_get_me without the right to read users", () => {
  it("returns the identity given by the session when the user's record is refused", async () => {
    const g = glpi(() => json(RIGHT_MISSING, 403));
    const res = await getMe(g.fetch);
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent, {
      id: 7, username: "jane.doe", firstname: "Jane", realname: "Doe", friendly_name: "Doe Jane", source: "session",
    });
    // Only the token owner's record is ever asked for.
    assert.deepEqual(g.paths.filter((p) => /\/Administration\/User\/\d+$/.test(p)).map((p) => p.split("/").pop()), ["7"]);
  });

  it("still returns the full record when the profile may read it", async () => {
    const res = await getMe(glpi(() => json({ id: 7, username: "jane.doe", firstname: "Jane", realname: "Doe", phone: "1" })).fetch);
    assert.equal(res.structuredContent?.phone, "1");
    assert.equal(res.structuredContent?.source, "session");
  });

  it("does not hide another error on the user's record behind the session", async () => {
    const res = await getMe(glpi(() => json({ status: "ERROR_ITEM_NOT_FOUND", title: "Not found" }, 404)).fetch);
    assert.equal(res.isError, true);
  });
});
