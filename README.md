# NexTool MCP for GLPI

Open-source [Model Context Protocol](https://modelcontextprotocol.io) server that connects AI assistants
(Claude, ChatGPT, Cursor, VS Code, Windsurf…) to your **GLPI** service desk: tickets, ITIL objects, assets,
knowledge base, users, rules and webhooks — GLPI 10 and 11, REST API v1 and GLPI 11 API v2 in one server.

> Not affiliated with Teclib'. GLPI is a registered trademark of Teclib'.

| Package | What it is |
|---|---|
| [`@nextoolsolutions/mcp-glpi`](mcp-glpi) | The MCP server (stdio and HTTP) and a library to embed it |
| [`@nextoolsolutions/mcp-glpi-core`](mcp-glpi-core) | Shared transport, write policy, idempotency and payload formatting |

## Quick start (local, stdio)

```bash
GLPI_URL=https://glpi.example.com GLPI_USER_TOKEN=… GLPI_APP_TOKEN=… npx -y @nextoolsolutions/mcp-glpi
```

Claude Code: `claude mcp add glpi --env GLPI_URL=… --env GLPI_USER_TOKEN=… -- npx -y @nextoolsolutions/mcp-glpi`.
See [mcp-glpi/README.md](mcp-glpi/README.md) for every option: tool presets (`GLPI_TOOLSETS`), read-only mode,
delete policy, GLPI 11 OAuth (API v2) and the HTTP server.

## Hosted version

Prefer not to run anything? **NexTool MCP** hosted at `https://mcp.nextoolsolutions.com/mcp` adds sign-in through
the [NexTool portal](https://app.nextoolsolutions.com), connectors for Claude and ChatGPT, and protections for
public GLPI instances. Your GLPI must be reachable from the internet.

## Safety

- Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
- Deletes are refused unless `GLPI_ALLOW_DELETE=true`, and then require a written `reason`.
- `GLPI_READ_ONLY=true` blocks every write before it reaches GLPI.
- Identical create calls within a short window are replayed, not repeated.

## Development

```bash
cd mcp-glpi-core && npm ci && npm run build && npm test
cd ../mcp-glpi && npm ci && npm run build && npm test
```

This repository is a mirror published from NexTool's internal monorepo; issues and pull requests are welcome here.

## License

MIT © NexTool Solutions
