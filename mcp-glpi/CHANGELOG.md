# Changelog — @nextoolsolutions/mcp-glpi

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow semver.

## [Unreleased]

## [3.3.0] - 2026-10-04

### Added
- `createGlpiServer(instance, { serverInfo, instructions })`: a host can override the identity sent in `initialize` (title, description, websiteUrl, icons; `version` stays the package version) and the `instructions` for the model.
- Default `instructions` (`DEFAULT_INSTRUCTIONS`, exported) describing what the tools cover and how to use them safely, and `websiteUrl` pointing at the public repository.

## [3.2.0] - 2026-10-04

### Added
- **Library API.** The package root (`exports["."]`, `dist/lib.js`) exports `createGlpiServer`,
  `SERVER_VERSION`, `instanceFromConfig`, `instanceFromEnv`, the `InstanceConfig` /
  `InstanceEnv` / `InstanceOptions` types, `TOOLSETS` / `TOOLSET_NAMES` / `parseToolsets`, the
  error classes and `IdempotencyStore`. Importing it starts no transport; the stdio and HTTP
  servers stay in the `mcp-glpi` and `mcp-glpi-http` bins.
- `instanceFromConfig({ id, v1, v2, policy, toolsets, toolsInclude, toolsExclude, fetchImpl })`
  builds an instance from a plain object, without `process.env`; invalid id/URL, unknown
  toolsets and a missing family throw.
- **Injectable fetch.** `fetchImpl` on `instanceFromConfig` and on `createGlpiServer` options
  reaches every GLPI request: v1 `initSession` and calls, v2 OAuth token and calls, assets and
  webhooks.
- **Named toolsets.** `GLPI_TOOLSETS` (and the `toolsets` option): `core`, `tickets`, `itil`,
  `assets`, `kb`, `documents`, `users`, `search`, `admin`, `v2`. Toolsets and include globs add
  up; exclude still wins; an unknown name fails at startup. `core` = reads of the everyday
  presets plus the non-destructive ticket operations. Tests assert every tool is in a preset.
- Server `title` "NexTool MCP for GLPI" in the MCP implementation info.

### Changed
- **Redirects are never followed** (via mcp-glpi-core 1.1.0): a 3xx from GLPI returns
  `redirect not followed: <status> -> <host>` and is not retried.
- **v2 client: no absolute URLs to other hosts.** `glpiV2Request` accepts relative paths; an
  absolute URL is accepted only on the `GLPI_V2_URL` origin, otherwise it is refused before any
  request (including the token request). Raw paths are normalised so they cannot change host.
- **MCP annotations** (via mcp-glpi-core 1.1.0): every tool now also carries `title`,
  `idempotentHint` (reads, `update_*`/`set_*`, deletes) and `openWorldHint: false`.
- Product name "NexTool MCP for GLPI" in `server.json` and README, with the notice "Not
  affiliated with Teclib'. GLPI is a registered trademark of Teclib'."; `server.json`
  description rewritten (it was cut at 100 characters); `GLPI_TOOLSETS` declared there.
- LICENSE (MIT) copyright holder: NexTool Solutions.
- Dependency on the core is now semver (`^1.1.0`) instead of `file:../mcp-glpi-core`; inside
  the repo the lockfile still links the sibling folder (see README, Development).
- `package.json` `main`/`types` point to the library entry; `CHANGELOG.md` ships in the package.

## [3.1.0] - 2026-10-04

### Added
- HTTP entry (`mcp-glpi-http`): Streamable HTTP at `/mcp/<instance>`, many instances from
  `MCP_INSTANCES_FILE`, mandatory `Authorization: Bearer` keys stored as SHA-256, per-credential
  GLPI session/OAuth/catalogue caches, per-instance idempotency, JSON audit line per request.

## [3.0.0] - 2026-10-04

### Changed
- The API v2 server (`mcp-glpi-v2`) merged into this package: `glpi_v2_*` tools, same names
  and schemas, enabled by `GLPI_V2_URL`. `GLPI_TOOLS_INCLUDE` / `GLPI_TOOLS_EXCLUDE` added.
