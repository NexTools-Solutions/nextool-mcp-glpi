/**
 * Item ID parameters.
 *
 * IDs used to be `string | number`: `categoryId: "abc"` went out as
 * GET /ITILCategory/abc and GLPI answered with the first page of the whole
 * collection, which the tool returned as if it were the item. An ID is now a
 * positive integer — a number, or a string made only of digits — and anything
 * else is rejected by input validation before any request is made.
 */

import { z } from "zod";

export interface ItemIdOptions {
  /** Entity 0 (the root entity) is a real ID; everywhere else 0 means "none". */
  allowZero?: boolean;
}

export function itemIdSchema(description = "Item ID", opts: ItemIdOptions = {}) {
  const number = opts.allowZero ? z.number().int().nonnegative() : z.number().int().positive();
  const digits = z
    .string()
    .regex(opts.allowZero ? /^\d+$/ : /^0*[1-9]\d*$/, opts.allowZero ? "must be a non-negative integer ID" : "must be a positive integer ID");
  return z.union([number, digits]).describe(description);
}
