/**
 * Library entry of @nextoolsolutions/mcp-glpi (the package root import).
 *
 * Importing it never starts a transport: the stdio server is the `mcp-glpi`
 * bin (index.ts) and the HTTP server the `mcp-glpi-http` bin (http.ts).
 *
 *   import { createGlpiServer, instanceFromConfig } from "@nextoolsolutions/mcp-glpi";
 *
 *   const instance = instanceFromConfig({
 *     id: "acme",
 *     v1: { url: "https://glpi.acme.com", userToken, appToken },
 *     policy: { readOnly: true },
 *     toolsets: ["core"],
 *   });
 *   const { server } = createGlpiServer(instance, { fetchImpl });
 *   await server.connect(transport);
 */

export { createGlpiServer, DEFAULT_INSTRUCTIONS, SERVER_VERSION } from "./create-server.js";
export type { CreateServerOptions, CreatedServer } from "./create-server.js";
export { instanceFromConfig, instanceFromEnv } from "./instance.js";
export type {
  InstanceConfig,
  InstanceEnv,
  InstanceOptions,
  V1Credentials,
  V2Credentials,
} from "./instance.js";
export { TOOLSETS, TOOLSET_NAMES, parseToolsets } from "./toolsets.js";
export type { ToolsetDefinition } from "./toolsets.js";
export { GlpiApiError } from "./glpi-client.js";
export { GlpiV2ApiError } from "./glpi-v2-client.js";
export {
  GlpiHttpError,
  GlpiPolicyError,
  GlpiRedirectError,
  IdempotencyStore,
} from "@nextoolsolutions/mcp-glpi-core";
export type { FetchImpl, WritePolicy } from "@nextoolsolutions/mcp-glpi-core";
