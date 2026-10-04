/**
 * Webhook endpoints of the GLPI REST API.
 *
 * Webhooks exist from GLPI 10.0.7 and are a first-class itemtype in 11. Older
 * instances answer ERROR_RESOURCE_NOT_FOUND_NOR_COMMONDBTM for /Webhook, so the
 * tools stay registered (the catalogue is static) and the error is translated
 * into something a human can act on — the glpi-10-nextools instance in this
 * workspace is exactly that case.
 */

import { sanitizeId, withQs } from "@nextoolsolutions/mcp-glpi-core";
import { glpiRequest, search, type GlpiConfig } from "./glpi-client.js";

const UNSUPPORTED_MARKER = "ERROR_RESOURCE_NOT_FOUND_NOR_COMMONDBTM";

const UNSUPPORTED_MESSAGE =
  "This GLPI instance does not expose the Webhook itemtype. Webhooks require GLPI 10.0.7 " +
  "or newer (they are standard in GLPI 11). Check the instance version before retrying.";

/** Translates the "itemtype does not exist" error into an actionable message. */
async function webhookRequest<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(UNSUPPORTED_MARKER)) throw new Error(UNSUPPORTED_MESSAGE);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Webhook CRUD
// ---------------------------------------------------------------------------

export async function listWebhooks(
  config: GlpiConfig,
  params?: { range?: string; expand_dropdowns?: boolean },
) {
  return webhookRequest(() =>
    glpiRequest<unknown[]>(
      config,
      "GET",
      withQs("/Webhook/", { range: params?.range, expand_dropdowns: params?.expand_dropdowns }),
    ),
  );
}

export async function getWebhook(config: GlpiConfig, webhookId: number | string) {
  return webhookRequest(() =>
    glpiRequest<Record<string, unknown>>(config, "GET", `/Webhook/${sanitizeId(webhookId)}`),
  );
}

export async function createWebhook(config: GlpiConfig, input: Record<string, unknown>) {
  return webhookRequest(() => glpiRequest<unknown>(config, "POST", "/Webhook", { input }));
}

export async function updateWebhook(
  config: GlpiConfig,
  webhookId: number | string,
  input: Record<string, unknown>,
) {
  return webhookRequest(() =>
    glpiRequest<unknown>(config, "PUT", `/Webhook/${sanitizeId(webhookId)}`, { input }),
  );
}

export async function deleteWebhook(
  config: GlpiConfig,
  webhookId: number | string,
  purge = false,
) {
  return webhookRequest(() =>
    glpiRequest<unknown>(
      config,
      "DELETE",
      withQs(`/Webhook/${sanitizeId(webhookId)}`, { force_purge: purge || undefined }),
    ),
  );
}

/** Enables or disables a webhook without touching the rest of its definition. */
export async function setWebhookActive(
  config: GlpiConfig,
  webhookId: number | string,
  active: boolean,
) {
  return updateWebhook(config, webhookId, { is_active: active ? 1 : 0 });
}

// ---------------------------------------------------------------------------
// Delivery queue
// ---------------------------------------------------------------------------

/**
 * Search option IDs on QueuedWebhook, read from the live instance
 * (glpi_list_search_options). There is no search option for the webhook
 * foreign key — only the joined webhook name — so the filter matches on name.
 */
const QUEUED_FIELD_WEBHOOK_NAME = 22;
const QUEUED_FIELD_SENT_TRY = 15;

/**
 * Delivery history. `only_failed` uses the retry counter: GLPI increments
 * sent_try on each failed attempt, so anything above zero has failed at least
 * once.
 */
export async function listWebhookDeliveries(
  config: GlpiConfig,
  params?: { webhook_name?: string; only_failed?: boolean; range?: string },
) {
  const criteria: Record<string, unknown>[] = [];
  if (params?.webhook_name) {
    criteria.push({
      field: QUEUED_FIELD_WEBHOOK_NAME,
      searchtype: "contains",
      value: params.webhook_name,
    });
  }
  if (params?.only_failed) {
    criteria.push({
      link: criteria.length ? "AND" : undefined,
      field: QUEUED_FIELD_SENT_TRY,
      searchtype: "morethan",
      value: "0",
    });
  }

  if (criteria.length === 0) {
    return webhookRequest(() =>
      glpiRequest<unknown[]>(config, "GET", withQs("/QueuedWebhook/", { range: params?.range })),
    );
  }

  return webhookRequest(() =>
    search(config, "QueuedWebhook", { range: params?.range, criteria }),
  );
}

export async function getWebhookDelivery(config: GlpiConfig, deliveryId: number | string) {
  return webhookRequest(() =>
    glpiRequest<Record<string, unknown>>(
      config,
      "GET",
      `/QueuedWebhook/${sanitizeId(deliveryId)}`,
    ),
  );
}

/**
 * Queues a failed delivery for another attempt by clearing its send date — the
 * GLPI cron picks up entries whose send_time has come. There is no dedicated
 * retry endpoint in the REST API.
 */
export async function retryWebhookDelivery(config: GlpiConfig, deliveryId: number | string) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(
    now.getSeconds(),
  ).padStart(2, "0")}`;

  return webhookRequest(() =>
    glpiRequest<unknown>(config, "PUT", `/QueuedWebhook/${sanitizeId(deliveryId)}`, {
      input: { send_time: stamp, sent_try: 0 },
    }),
  );
}

export { UNSUPPORTED_MESSAGE };
