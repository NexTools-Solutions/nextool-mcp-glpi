/**
 * Asset / inventory endpoints of the GLPI REST API.
 *
 * The server covered tickets, ITIL records, users and the knowledge base, but
 * nothing under Assets — half of what GLPI is for. This module adds the asset
 * itemtypes, the enriched hardware view, reservations, and counting without
 * pulling the records themselves.
 */

import { sanitizeId, withQs } from "@nextoolsolutions/mcp-glpi-core";
import { glpiRequest, search, type GlpiConfig } from "./glpi-client.js";

/** Asset itemtypes exposed by the generic asset tools. */
export const ASSET_TYPES = [
  "Computer",
  "Monitor",
  "Printer",
  "NetworkEquipment",
  "Peripheral",
  "Phone",
  "Software",
  "Rack",
  "Enclosure",
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];

export function isAssetType(v: string): v is AssetType {
  return (ASSET_TYPES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listAssets(
  config: GlpiConfig,
  assetType: AssetType,
  params?: { range?: string; expand_dropdowns?: boolean; only_id?: boolean },
) {
  return glpiRequest<unknown[]>(
    config,
    "GET",
    withQs(`/${sanitizeId(assetType)}/`, {
      range: params?.range,
      expand_dropdowns: params?.expand_dropdowns,
      only_id: params?.only_id,
    }),
  );
}

export async function getAsset(
  config: GlpiConfig,
  assetType: AssetType,
  assetId: number | string,
  params?: { expand_dropdowns?: boolean },
) {
  return glpiRequest<unknown>(
    config,
    "GET",
    withQs(`/${sanitizeId(assetType)}/${sanitizeId(assetId)}`, {
      expand_dropdowns: params?.expand_dropdowns,
    }),
  );
}

export async function createAsset(
  config: GlpiConfig,
  assetType: AssetType,
  input: Record<string, unknown>,
) {
  return glpiRequest<unknown>(config, "POST", `/${sanitizeId(assetType)}`, { input });
}

export async function updateAsset(
  config: GlpiConfig,
  assetType: AssetType,
  assetId: number | string,
  input: Record<string, unknown>,
) {
  return glpiRequest<unknown>(config, "PUT", `/${sanitizeId(assetType)}/${sanitizeId(assetId)}`, { input });
}

// ---------------------------------------------------------------------------
// Enriched hardware view
// ---------------------------------------------------------------------------

/**
 * Sections the enriched view can pull. These map to the apirest `with_*`
 * expansion flags, so the whole thing is a single request instead of one call
 * per related itemtype.
 */
export const DETAIL_SECTIONS = [
  "devices",
  "disks",
  "softwares",
  "networkports",
  "infocoms",
  "documents",
  "tickets",
  "problems",
  "changes",
  "notes",
  "logs",
] as const;

export type DetailSection = (typeof DETAIL_SECTIONS)[number];

/**
 * Sections used when the caller does not choose: the "what is this machine"
 * picture. Software inventory and network ports are big enough to deserve an
 * explicit ask — on a real inventoried host they are two thirds of the payload.
 */
export const DEFAULT_DETAIL_SECTIONS: DetailSection[] = ["devices", "disks"];

/** Noise carried by every expanded sub-item; useless in a hardware summary. */
const SECTION_NOISE = new Set([
  "links", "is_dynamic", "is_deleted", "is_recursive", "is_template", "entities_id",
  "date_mod", "date_creation", "date_creation_item", "is_deleted_item",
]);

/**
 * Drops noise and empty values from one expanded row. A foreign key of 0 means
 * "not set" in GLPI, so it carries no information here either.
 */
export function compactRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (SECTION_NOISE.has(k)) continue;
    if (v === null || v === "" || v === undefined) continue;
    if (v === 0 && k.endsWith("_id")) continue;
    out[k] = v;
  }
  return out;
}

/** Normalises the two shapes apirest uses for expansions into a flat array. */
export function toRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
  }
  if (typeof value === "object" && value !== null) {
    // { "<id>": {...}, ... } — the shape used for devices and network ports.
    return Object.values(value as Record<string, unknown>).filter(
      (r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r),
    );
  }
  return [];
}

/**
 * Compacts an expanded section.
 *
 * The raw expansion of a single inventoried computer runs to ~95 KB: every
 * sub-item carries its full row, including timestamps and HAL links. This keeps
 * the meaningful columns, caps how many rows come back, and reports what was
 * left out so the caller knows to query the sub-itemtype directly.
 */
export function summarizeSection(value: unknown, maxItems: number): unknown {
  // Devices and network ports nest one level deeper: { Item_DeviceX: {...} }.
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).every((k) => /^[A-Z]/.test(k))
  ) {
    const out: Record<string, unknown> = {};
    for (const [group, inner] of Object.entries(value as Record<string, unknown>)) {
      const rows = toRows(inner);
      if (rows.length === 0) continue;
      out[group] = summarizeRows(rows, maxItems);
    }
    return out;
  }

  const rows = toRows(value);
  return rows.length ? summarizeRows(rows, maxItems) : value;
}

export function summarizeRows(rows: Record<string, unknown>[], maxItems: number): unknown {
  const compacted = rows.map(compactRow);
  if (compacted.length <= maxItems) return compacted;
  return {
    total: compacted.length,
    showing: maxItems,
    note: `Only the first ${maxItems} of ${compacted.length} entries are shown. Raise max_items_per_section or query the sub-itemtype directly.`,
    items: compacted.slice(0, maxItems),
  };
}

/**
 * Enriched asset view: operating system, processors, memory, disks, installed
 * software and network ports, expanded in one request.
 */
export async function getAssetDetails(
  config: GlpiConfig,
  assetType: AssetType,
  assetId: number | string,
  sections: DetailSection[] = DEFAULT_DETAIL_SECTIONS,
  maxItemsPerSection = 25,
) {
  const flags: Record<string, string | boolean | number | undefined> = {
    expand_dropdowns: true,
  };
  for (const s of sections) flags[`with_${s}`] = true;

  const item = await glpiRequest<Record<string, unknown>>(
    config,
    "GET",
    withQs(`/${sanitizeId(assetType)}/${sanitizeId(assetId)}`, flags),
  );

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    out[k] = k.startsWith("_") ? summarizeSection(v, maxItemsPerSection) : v;
  }

  // The operating system is not one of the with_* flags; it is a related item.
  try {
    const os = await glpiRequest<unknown>(
      config,
      "GET",
      withQs(`/${sanitizeId(assetType)}/${sanitizeId(assetId)}/Item_OperatingSystem`, {
        expand_dropdowns: true,
      }),
    );
    const rows = toRows(os).map(compactRow);
    if (rows.length) out.operatingsystem = rows;
  } catch {
    // Itemtypes without an OS relation (Monitor, Peripheral) simply have none.
  }

  return out;
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

/** Items flagged as reservable. */
export async function listReservationItems(config: GlpiConfig, params?: { range?: string }) {
  return glpiRequest<unknown[]>(
    config,
    "GET",
    withQs("/ReservationItem/", { range: params?.range, expand_dropdowns: true }),
  );
}

export async function listReservations(config: GlpiConfig, params?: { range?: string }) {
  return glpiRequest<unknown[]>(
    config,
    "GET",
    withQs("/Reservation/", { range: params?.range, expand_dropdowns: true }),
  );
}

export async function getReservation(config: GlpiConfig, reservationId: number | string) {
  return glpiRequest<unknown>(config, "GET", `/Reservation/${sanitizeId(reservationId)}`);
}

export async function createReservation(
  config: GlpiConfig,
  input: {
    reservationitems_id: number | string;
    begin: string;
    end: string;
    users_id?: number | string;
    comment?: string;
  },
) {
  return glpiRequest<unknown>(config, "POST", "/Reservation", { input });
}

export async function updateReservation(
  config: GlpiConfig,
  reservationId: number | string,
  input: Record<string, unknown>,
) {
  return glpiRequest<unknown>(config, "PUT", `/Reservation/${sanitizeId(reservationId)}`, { input });
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

export interface CountResult {
  itemtype: string;
  total: number;
}

/**
 * Counts matching items without transferring them: the search endpoint reports
 * `totalcount` even when asked for a single row.
 */
export async function countItems(
  config: GlpiConfig,
  itemtype: string,
  criteria?: Record<string, unknown>[],
): Promise<CountResult> {
  const res = (await search(config, itemtype, { range: "0-0", criteria })) as
    | { totalcount?: number; count?: number }
    | undefined;

  return {
    itemtype,
    total: typeof res?.totalcount === "number" ? res.totalcount : (res?.count ?? 0),
  };
}

/** GLPI ticket status codes, in the order the UI presents them. */
export const TICKET_STATUS: Record<number, string> = {
  1: "New",
  2: "Processing (assigned)",
  3: "Processing (planned)",
  4: "Pending",
  5: "Solved",
  6: "Closed",
};

/** Search option ID of the status field on Ticket. */
const TICKET_STATUS_FIELD = 12;

export interface TicketStats {
  total: number;
  by_status: { status: string; code: number; count: number }[];
}

/**
 * Ticket counts per status, one count query per status plus one for the total.
 * Cheap compared to listing the tickets, and the only way to get an aggregate
 * out of the REST API.
 */
export async function ticketStats(
  config: GlpiConfig,
  extraCriteria: Record<string, unknown>[] = [],
): Promise<TicketStats> {
  const total = await countItems(config, "Ticket", extraCriteria.length ? extraCriteria : undefined);

  const by_status: TicketStats["by_status"] = [];
  for (const [code, label] of Object.entries(TICKET_STATUS)) {
    const criteria: Record<string, unknown>[] = [
      ...extraCriteria,
      {
        link: extraCriteria.length ? "AND" : undefined,
        field: TICKET_STATUS_FIELD,
        searchtype: "equals",
        value: code,
      },
    ];
    const r = await countItems(config, "Ticket", criteria);
    by_status.push({ status: label, code: Number(code), count: r.total });
  }

  return { total: total.total, by_status };
}
