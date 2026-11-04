import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ticketStats } from "../src/assets-client.js";

let seq = 0;
function fixture(counts: Record<string, number>, total: number) {
  const queries: URLSearchParams[] = [];
  const config = {
    baseUrl: "https://stats.example.test", userToken: `stats-${++seq}`,
    fetchImpl: async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/initSession")) return Response.json({ session_token: "test" });
      assert.ok(u.pathname.endsWith("/search/Ticket"));
      queries.push(u.searchParams);
      const pairs = [...u.searchParams];
      const other = pairs.some(([k, v]) => k.endsWith("[link]") && v === "AND NOT");
      assert.ok(!pairs.some(([k,v]) => k.endsWith("[searchtype]") && v === "notequals"), "GLPI ignores notequals for status");
      const statusField = pairs.find(([k, v]) => /^criteria\[\d+\]\[field\]$/.test(k) && v === "12");
      const code = statusField ? u.searchParams.get(statusField[0].replace("[field]", "[value]")) : null;
      return Response.json({ totalcount: other ? (counts.other ?? 0) : code ? (counts[code] ?? 0) : total, data: [] });
    },
  };
  return { config, queries };
}

describe("ticket statistics include nonstandard statuses", () => {
  it("accounts for the 37 status-10 tickets observed in the reviewer environment", async () => {
    const { config } = fixture({ 1:3719, 2:655, 3:133, 4:119, 5:1015, 6:431, other:37 }, 6109);
    const result = await ticketStats(config);
    assert.equal(result.other_status_count, 37);
    assert.equal(result.counts_consistent, true);
    assert.equal(result.total, result.by_status.reduce((sum, row) => sum + row.count, 0) + result.other_status_count);
    assert.match(result.note!, /outside GLPI/);
  });
  it("warns when separate reads no longer reconcile", async () => {
    const { config } = fixture({ 1:2 }, 3);
    const result = await ticketStats(config);
    assert.equal(result.counts_consistent, false);
    assert.equal(result.other_status_count, 0);
    assert.match(result.note!, /Retry/);
  });
  it("groups an OR scope before adding each status restriction", async () => {
    const { config, queries } = fixture({ 1:1 }, 1);
    await ticketStats(config, [{ field:4,searchtype:"equals",value:7 },{ link:"OR",field:5,searchtype:"equals",value:7 }]);
    for (const q of queries.slice(1)) {
      assert.equal(q.get("criteria[0][criteria][0][field]"), "4");
      assert.equal(q.get("criteria[0][criteria][1][link]"), "OR");
      assert.ok(["AND", "AND NOT"].includes(q.get("criteria[1][link]")!));
      assert.equal(q.get("criteria[1][field]"), "12");
    }
    assert.equal(queries.at(-1)!.get("criteria[6][link]"), "AND NOT");
  });
});
