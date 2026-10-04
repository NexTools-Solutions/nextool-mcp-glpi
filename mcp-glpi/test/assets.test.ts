import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ASSET_TYPES,
  DEFAULT_DETAIL_SECTIONS,
  TICKET_STATUS,
  compactRow,
  isAssetType,
  summarizeRows,
  summarizeSection,
  toRows,
} from "../src/assets-client.js";

describe("asset types", () => {
  it("recognises the itemtypes it exposes", () => {
    assert.equal(isAssetType("Computer"), true);
    assert.equal(isAssetType("Ticket"), false);
    assert.ok(ASSET_TYPES.includes("NetworkEquipment"));
  });

  it("defaults to the hardware sections only", () => {
    // Software inventory and network ports are two thirds of the payload on a
    // real inventoried host, so they must be an explicit ask.
    assert.deepEqual(DEFAULT_DETAIL_SECTIONS, ["devices", "disks"]);
  });
});

describe("compactRow", () => {
  it("drops bookkeeping, empties and unset foreign keys", () => {
    const row = {
      id: 2,
      deviceprocessors_id: "AMD EPYC 9354P 32-Core Processor",
      nbcores: 4,
      frequency: 0,
      locations_id: 0,
      states_id: 0,
      serial: null,
      comment: "",
      is_dynamic: 1,
      is_deleted: 0,
      entities_id: 0,
      date_mod: "2026-03-05 06:55:59",
      links: [{ rel: "Entity" }],
    };
    assert.deepEqual(compactRow(row), {
      id: 2,
      deviceprocessors_id: "AMD EPYC 9354P 32-Core Processor",
      nbcores: 4,
      frequency: 0,
    });
  });

  it("keeps a zero that is not a foreign key", () => {
    // frequency 0 means "unknown clock", not "no relation".
    assert.deepEqual(compactRow({ frequency: 0 }), { frequency: 0 });
  });
});

describe("toRows", () => {
  it("handles both shapes apirest returns", () => {
    assert.deepEqual(toRows([{ id: 1 }]), [{ id: 1 }]);
    assert.deepEqual(toRows({ "252": { id: 252 }, "253": { id: 253 } }), [{ id: 252 }, { id: 253 }]);
    assert.deepEqual(toRows("nonsense"), []);
    assert.deepEqual(toRows(null), []);
  });
});

describe("summarizeRows", () => {
  it("returns the rows when they fit", () => {
    assert.deepEqual(summarizeRows([{ id: 1 }, { id: 2 }], 25), [{ id: 1 }, { id: 2 }]);
  });

  it("truncates and says how much was left out", () => {
    const rows = Array.from({ length: 44 }, (_, i) => ({ id: i }));
    const out = summarizeRows(rows, 25) as { total: number; showing: number; note: string; items: unknown[] };
    assert.equal(out.total, 44);
    assert.equal(out.showing, 25);
    assert.equal(out.items.length, 25);
    assert.match(out.note, /first 25 of 44/);
  });
});

describe("summarizeSection", () => {
  it("compacts the nested device shape group by group", () => {
    // Shape taken from a real GLPI 11 Computer expansion.
    const devices = {
      Item_DeviceProcessor: {
        "2": {
          id: 2,
          deviceprocessors_id: "AMD EPYC 9354P 32-Core Processor",
          nbcores: 4,
          locations_id: 0,
          states_id: 0,
          links: [],
        },
      },
      Item_DeviceMemory: {
        "2": { id: 2, devicememories_id: "RAM - DIMM", size: 15730, states_id: 0 },
      },
      Item_DeviceEmpty: {},
    };
    const out = summarizeSection(devices, 25) as Record<string, Record<string, unknown>[]>;
    assert.deepEqual(out.Item_DeviceProcessor, [
      { id: 2, deviceprocessors_id: "AMD EPYC 9354P 32-Core Processor", nbcores: 4 },
    ]);
    assert.deepEqual(out.Item_DeviceMemory, [{ id: 2, devicememories_id: "RAM - DIMM", size: 15730 }]);
    assert.ok(!("Item_DeviceEmpty" in out), "empty groups should be dropped");
  });

  it("compacts a flat array section", () => {
    const softwares = [
      { softwares_id: "7-zip", softwareversions_id: "16.02-31.el9", is_dynamic: 1, links: [] },
    ];
    assert.deepEqual(summarizeSection(softwares, 25), [
      { softwares_id: "7-zip", softwareversions_id: "16.02-31.el9" },
    ]);
  });

  it("leaves a section it cannot interpret alone", () => {
    assert.equal(summarizeSection("", 25), "");
    assert.deepEqual(summarizeSection([], 25), []);
  });
});

describe("ticket status map", () => {
  it("covers the six GLPI statuses", () => {
    assert.equal(Object.keys(TICKET_STATUS).length, 6);
    assert.equal(TICKET_STATUS[1], "New");
    assert.equal(TICKET_STATUS[6], "Closed");
  });
});
