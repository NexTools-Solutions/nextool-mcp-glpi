import { test } from "node:test";
import assert from "node:assert/strict";
import { installToolFilter, isToolSelected, parseGlobList } from "../src/tool-filter.js";

test("parseGlobList ignores blanks and anchors the pattern", () => {
  const res = parseGlobList(" glpi_*ticket* , ,glpi_search ");
  assert.equal(res.length, 2);
  assert.ok(res[0].test("glpi_list_tickets"));
  assert.ok(!res[1].test("glpi_search_user_by_email"));
});

test("no lists selects everything", () => {
  assert.ok(isToolSelected("glpi_v2_get_me", { include: [], exclude: [] }));
});

test("exclude wins over include", () => {
  const options = { include: parseGlobList("glpi_*"), exclude: parseGlobList("*webhook*") };
  assert.ok(isToolSelected("glpi_list_tickets", options));
  assert.ok(!isToolSelected("glpi_delete_webhook", options));
});

test("installToolFilter skips the original registerTool and counts", () => {
  const seen: string[] = [];
  const server = { registerTool: (name: string) => seen.push(name) };
  const stats = installToolFilter(server, { include: parseGlobList("glpi_v2_*"), exclude: [] });
  server.registerTool("glpi_list_tickets");
  server.registerTool("glpi_v2_list_tickets");
  assert.deepEqual(seen, ["glpi_v2_list_tickets"]);
  assert.equal(stats.registered(), 1);
  assert.equal(stats.dropped(), 1);
});
