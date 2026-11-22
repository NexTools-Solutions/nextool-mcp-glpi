/**
 * Item ID parameters.
 *
 * IDs used to be `string | number`: `categoryId: "abc"` went out as
 * GET /ITILCategory/abc and GLPI answered with the first page of the whole
 * collection, which the tool returned as if it were the item. An ID is now a
 * positive integer — a number, or a string made only of digits — and anything
 * else is rejected by input validation before any request is made.
 *
 * Assistants write IDs the way people do: "#123", " 123 ", "123.0". Those are
 * unambiguous, so they are normalised before validation instead of refused
 * (3.8.0). What still fails gets one message that says what an ID looks like
 * and where to find it, instead of zod's "Invalid input".
 */

import { z } from "zod";

export interface ItemIdOptions {
  /** Entity 0 (the root entity) is a real ID; everywhere else 0 means "none". */
  allowZero?: boolean;
}

/** "#123", " 123 ", "0123" and "123.0" become "123"; anything else is returned untouched. */
export function normalizeItemId(value: unknown): unknown {
  if (typeof value === "string") {
    const m = /^\s*#?\s*0*(\d+)(?:\.0+)?\s*$/.exec(value);
    return m ? m[1] : value;
  }
  return value;
}

export function itemIdSchema(description = "Item ID", opts: ItemIdOptions = {}) {
  const expected = opts.allowZero ? "a non-negative integer ID" : "a positive integer ID";
  const message =
    `must be ${expected}: the numeric GLPI ID alone, e.g. 123 (not a name, a title or a URL). ` +
    "When the ID is unknown, find it first with a list or search tool.";
  const number = opts.allowZero ? z.number().int(message).nonnegative(message) : z.number().int(message).positive(message);
  const digits = z.string().regex(opts.allowZero ? /^\d+$/ : /^0*[1-9]\d*$/, message);
  return z.preprocess(normalizeItemId, z.union([number, digits], { errorMap: () => ({ message }) })).describe(description);
}
