# NexTool MCP for GLPI

Open-source [Model Context Protocol](https://modelcontextprotocol.io) server that connects AI assistants
(Claude, ChatGPT, Cursor, VS Code, Windsurf…) to your **GLPI** service desk: tickets, ITIL objects
(problems, changes), assets, knowledge base, users, rules and webhooks. It works with GLPI 10 and 11, and
supports both the REST API v1 and the GLPI 11 API v2 in one server.

> Not affiliated with Teclib'. GLPI is a registered trademark of Teclib'.

| Package | What it is |
|---|---|
| [`@nextoolsolutions/mcp-glpi`](mcp-glpi) | The MCP server (stdio and HTTP) and a library to embed it |
| [`@nextoolsolutions/mcp-glpi-core`](mcp-glpi-core) | Shared transport, write policy, idempotency and payload formatting |

**Two ways to use it:**

- **Hosted, early access:** nothing to install. Sign in with a NexTool account, then add one URL as a connector in Claude or ChatGPT. Request access at **https://nextoolsolutions.com/mcp**.
- **Local, open source (this repository):** runs on your machine with your GLPI credentials. It is free and also works with GLPI instances that are only reachable on your intranet.

---

## 1. Prepare GLPI (both ways)

1. **Enable the REST API**: *Setup → General → API*. Turn on "Enable REST API" and "Enable login with external token".
2. **API client** (optional but recommended): in the same screen, add an API client and copy its **App-Token**. If you restrict it by IP, allow the address the MCP connects from.
3. **User token**: *Administration → Users → (the user) → Remote access keys*. Copy the **API token**.
   Every action runs as this user and follows their GLPI profile and entities. Use a dedicated user with only the rights the assistant needs.
4. **GLPI 11 API v2 (optional):** create an OAuth client in GLPI 11 and note its client ID and secret. You also need a username and password, for the password grant.

## 2. Local install (open source)

> **npm release coming soon.** Until `@nextoolsolutions/mcp-glpi` is published, build from source (below). Once it is published, every `node …/dist/index.js` below becomes `npx -y @nextoolsolutions/mcp-glpi`.

```bash
git clone https://github.com/NexTools-Solutions/nextool-mcp-glpi.git
cd nextool-mcp-glpi/mcp-glpi-core && npm ci && npm run build
cd ../mcp-glpi && npm ci && npm run build
# the server entry point is now: <path>/nextool-mcp-glpi/mcp-glpi/dist/index.js   (Node.js 18+)
```

### Environment variables

| Variable | Meaning |
|---|---|
| `GLPI_URL` | GLPI base URL, e.g. `https://glpi.example.com` (REST API v1) |
| `GLPI_USER_TOKEN` | User API token (step 1.3) |
| `GLPI_APP_TOKEN` | App-Token of the API client (step 1.2), optional |
| `GLPI_V2_URL`, `GLPI_V2_CLIENT_ID`, `GLPI_V2_CLIENT_SECRET`, `GLPI_V2_USERNAME`, `GLPI_V2_PASSWORD` | GLPI 11 API v2 (OAuth). Optional; enables the `glpi_v2_*` tools |
| `GLPI_TOOLSETS` | Tool presets: `core` (recommended start), `tickets`, `itil`, `assets`, `kb`, `documents`, `users`, `search`, `admin`, `v2`. Combine with commas. Default: every tool |
| `GLPI_READ_ONLY` | `true` blocks every write before it reaches GLPI |
| `GLPI_ALLOW_DELETE` | `true` enables delete tools (default **off**); they then require a written `reason` |

All options are listed in [mcp-glpi/README.md](mcp-glpi/README.md).

### Claude Code

```bash
claude mcp add glpi \
  -e GLPI_URL=https://glpi.example.com -e GLPI_USER_TOKEN=xxx -e GLPI_APP_TOKEN=yyy -e GLPI_TOOLSETS=core \
  -- node /path/to/nextool-mcp-glpi/mcp-glpi/dist/index.js
```

### Claude Desktop

Edit `claude_desktop_config.json` (*Settings → Developer → Edit config*) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "glpi": {
      "command": "node",
      "args": ["/path/to/nextool-mcp-glpi/mcp-glpi/dist/index.js"],
      "env": {
        "GLPI_URL": "https://glpi.example.com",
        "GLPI_USER_TOKEN": "xxx",
        "GLPI_APP_TOKEN": "yyy",
        "GLPI_TOOLSETS": "core"
      }
    }
  }
}
```

### Cursor / Windsurf / VS Code

Use the same `command`/`args`/`env` block:
- **Cursor:** `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project).
- **Windsurf:** `~/.codeium/windsurf/mcp_config.json`.
- **VS Code:** `.vscode/mcp.json`. The top-level key there is `"servers"` instead of `"mcpServers"`, and each entry also takes `"type": "stdio"`.

### Shared HTTP server (optional)

To serve several users or GLPI instances from one machine, run `mcp-glpi/dist/http.js` (Streamable HTTP, Bearer keys stored as SHA-256 hashes). See ["Two ways to run"](mcp-glpi/README.md) in the package README.

## 3. Hosted version (early access)

The hosted **NexTool MCP** lives at `https://mcp.nextoolsolutions.com/mcp`. It adds:
- sign-in through the NexTool portal (OAuth 2.1);
- one-click connectors for Claude and ChatGPT;
- GLPI credentials encrypted so that only the connector can use them;
- per-user rate limits and audit logs, without storing prompts or results.

Your GLPI must be reachable from the internet. If it only accepts known IPs, the portal shows the address to allow when you test the connection.

**Request early access:** https://nextoolsolutions.com/mcp. Once you are in:

| Client | How to connect |
|---|---|
| Claude (web, desktop, mobile) | *Settings → Connectors → Add custom connector* → URL `https://mcp.nextoolsolutions.com/mcp` → sign in with your NexTool account and authorize |
| ChatGPT | Add a connector/app with the same URL (developer mode while the app is in review) |
| Claude Code | `claude mcp add --transport http nextool https://mcp.nextoolsolutions.com/mcp`, then `/mcp` to sign in. Or use an API key from *My account → NexTool MCP*: add `--header "Authorization: Bearer nxm_…"` |
| Cursor / VS Code | Server URL `https://mcp.nextoolsolutions.com/mcp` with header `Authorization: Bearer nxm_…` |

Connect your GLPI once at *app.nextoolsolutions.com → My account → NexTool MCP* (GLPI URL plus the tokens from step 1). Then click **Test connection**.

## Safety

- Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so clients can ask before changing data.
- Deletes are refused unless `GLPI_ALLOW_DELETE=true` (always refused on the hosted free plan).
- `GLPI_READ_ONLY=true` blocks every write.
- Identical create calls within a short window are replayed, not repeated.
- Redirects are never followed. The API v2 client talks only to the configured GLPI origin.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ERROR_GLPI_LOGIN_USER_TOKEN` / 401 | wrong or regenerated user token |
| `ERROR_WRONG_APP_TOKEN_PARAMETER` | App-Token missing or wrong for that API client |
| `ERROR_NOT_ALLOWED_IP` | the API client restricts IPs: allow the address the MCP connects from |
| HTML instead of JSON | `GLPI_URL` points to a login page or proxy, not to the GLPI root |
| "redirect not followed" | `GLPI_URL` redirects (e.g. http→https or another host): use the final URL |

## Development

```bash
cd mcp-glpi-core && npm ci && npm run build && npm test
cd ../mcp-glpi && npm ci && npm run build && npm test
```

This repository is a mirror published from NexTool's internal monorepo. Issues and pull requests are welcome here.
Security reports: see [SECURITY.md](SECURITY.md).

## License

MIT © NexTool Solutions
